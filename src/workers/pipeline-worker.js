'use strict';

/**
 * Persistent pipeline worker.
 *
 * One job at a time (sequential by design), SQLite-backed state, resumable stages,
 * bounded retries with exponential backoff, rate-limit aware and cancellable.
 *
 * Job flow:
 *   select_comment → generate_idea → build_site → test_site → deploy_site →
 *   write_script → narrate → record_site → subtitles → render_video → upload_video → done
 *
 * Every stage writes its result to the job state before the next stage starts, so a
 * crash/restart resumes from the last completed stage instead of starting over.
 */

const path = require('node:path');
const fs = require('node:fs');
const { JOB_STATUS, today, uid } = require('../database');
const { evaluateComment } = require('../services/comment-filter');
const { buildSubtitles, verifySync } = require('../services/subtitles');
const { BrowserUnavailableError } = require('../services/recorder');

/** Browser failures can arrive from another module instance, so match on name too. */
function isBrowserUnavailable(error) {
  return error instanceof BrowserUnavailableError || error?.name === 'BrowserUnavailableError';
}
const { TtsUnavailableError } = require('../services/narration');
const { AiBudgetExceededError } = require('../services/openrouter');
const { QuotaExceededError } = require('../services/youtube-comments');
const { uploadLimits } = require('./limits');
const { startStaticServer } = require('../lib/static-server');

const DEFAULT_SETTINGS = {
  paused: false,
  autoEnqueue: true,
  dailyJobLimit: 3,
  dailyUploadLimit: 1,
  pollIntervalMinutes: 20,
  commentPollingEnabled: true,
  privacy: 'private',
  targetDurationSec: 42,
  maxJobsInQueue: 10,
};

const STAGE_PROGRESS = {
  select_comment: 5,
  generate_idea: 12,
  build_site: 24,
  test_site: 36,
  deploy_site: 48,
  write_script: 56,
  narrate: 64,
  record_site: 76,
  subtitles: 80,
  render_video: 90,
  upload_video: 97,
  done: 100,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StageError extends Error {
  constructor(message, { stage, retryable = true, code = 'stage_error' } = {}) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    this.retryable = retryable;
    this.code = code;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new StageError(`${label} timed out after ${Math.round(ms / 1000)}s`, { retryable: true })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class PipelineWorker {
  constructor(config, services) {
    this.config = config;
    this.services = services;
    this.scheduler = services.scheduler || null;
    this.db = services.db;
    this.logger = services.logger;
    this.ideaGenerator = services.ideaGenerator;
    this.websiteBuilder = services.websiteBuilder;
    this.websiteTester = services.websiteTester;
    this.deployer = services.deployer;
    this.recorder = services.recorder;
    this.narration = services.narration;
    this.scriptWriter = services.scriptWriter;
    this.renderer = services.videoRenderer;
    this.uploader = services.uploader;
    this.comments = services.comments;

    this.running = false;
    this.paused = false;
    this.currentJobId = null;
    this.stopRequested = false;
    this.loopPromise = null;
    this.abort = new AbortController();
    this.lastTickAt = null;
  }

  /* -------------------------------------------------------------- settings */

  getSettings() {
    const stored = this.db.getSetting('automation', {}) || {};
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    if (stored.dailyJobLimit === undefined) merged.dailyJobLimit = this.config.worker.dailyJobLimit;
    if (stored.dailyUploadLimit === undefined) merged.dailyUploadLimit = this.config.worker.dailyUploadLimit;
    if (stored.pollIntervalMinutes === undefined) merged.pollIntervalMinutes = this.config.youtube.pollIntervalMinutes;
    if (stored.maxJobsInQueue === undefined) merged.maxJobsInQueue = this.config.worker.maxQueueDepth;
    if (stored.targetDurationSec === undefined) merged.targetDurationSec = 42;
    return merged;
  }

  updateSettings(patch) {
    const current = this.getSettings();
    const next = { ...current };
    const numeric = ['dailyJobLimit', 'dailyUploadLimit', 'pollIntervalMinutes', 'targetDurationSec', 'maxJobsInQueue'];
    const booleans = ['paused', 'autoEnqueue', 'commentPollingEnabled'];
    for (const [key, value] of Object.entries(patch || {})) {
      if (numeric.includes(key)) {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) continue;
        next[key] = Math.round(num);
      } else if (booleans.includes(key)) {
        next[key] = Boolean(value);
      } else if (key === 'privacy' && ['private', 'unlisted', 'public'].includes(String(value))) {
        next[key] = String(value);
      }
    }
    this.db.setSetting('automation', next);
    if (next.paused) this.paused = true;
    else if (this.paused && this.running) this.paused = false;
    return next;
  }

  status() {
    const state = this.db.getWorkerState();
    const settings = this.getSettings();
    const active = this.db.activeJob();
    return {
      running: this.running,
      paused: this.paused || settings.paused,
      currentJobId: this.currentJobId,
      currentStage: active?.stage || null,
      activeJob: active,
      lastHeartbeat: state.last_heartbeat,
      lastPollAt: state.last_poll_at,
      lastError: state.last_error,
      jobsToday: state.jobs_today,
      uploadsToday: state.uploads_today,
      settings,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }

  /* ------------------------------------------------------------ lifecycle */

  async start({ runScheduler = true } = {}) {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.stopRequested = false;
    this.abort = new AbortController();
    this.db.getWorkerState();
    const recovered = this.db.recoverInterruptedJobs();
    if (recovered) this.logger.warn(`Recovered ${recovered} interrupted job(s) after restart`);
    this.db.setWorkerStatus('running');
    this.logger.info('Pipeline worker started', { recovered });

    this.loopPromise = this.loop();
    if (runScheduler && this.scheduler) this.scheduler.start();
  }

  async stop({ timeoutMs = 30000 } = {}) {
    this.stopRequested = true;
    this.abort.abort();
    this.scheduler?.stop();
    this.db.setWorkerStatus('stopped');
    const finished = await Promise.race([
      this.loopPromise?.catch(() => {}) || Promise.resolve(),
      sleep(timeoutMs),
    ]);
    this.running = false;
    this.currentJobId = null;
    this.logger.info('Pipeline worker stopped');
    return finished;
  }

  pause() {
    this.paused = true;
    this.updateSettings({ paused: true });
    this.db.setWorkerStatus('paused');
    this.logger.warn('Automation paused');
  }

  resume() {
    this.paused = false;
    this.updateSettings({ paused: false });
    this.db.setWorkerStatus('running');
    this.logger.info('Automation resumed');
  }

  async loop() {
    while (!this.stopRequested) {
      try {
        this.db.heartbeat();
        if (this.getSettings().paused) {
          this.paused = true;
        } else {
          this.paused = false;
          if (!this.currentJobId) {
            const job = this.db.claimNextJob();
            if (job) {
              await this.runJob(job);
              continue;
            }
          }
        }
      } catch (error) {
        this.logger.error(`Worker loop error: ${error.message}`);
        this.db.setWorkerError(error.message);
      }
      this.lastTickAt = new Date().toISOString();
      await sleep(this.config.worker.pollIntervalMs);
    }
  }

  /* -------------------------------------------------------------- jobs */

  async enqueue({ commentId = null, maxAttempts = null, simulated = false } = {}) {
    const settings = this.getSettings();
    const queue = this.db.jobCounts();
    const queued = queue.queued + queue.retrying + queue.running;
    if (queued >= settings.maxJobsInQueue) {
      throw new Error(`Queue is full (${queued}/${settings.maxJobsInQueue}); wait for the worker to catch up.`);
    }
    if (commentId) {
      const active = this.db.db
        .prepare(`SELECT id FROM jobs WHERE comment_id = ? AND status IN ('queued','running','retrying') LIMIT 1`)
        .get(commentId);
      if (active) {
        this.logger.info(`Comment ${commentId} already has an active job (${active.id}); reusing it`);
        const existing = this.db.getJob(active.id);
        if (existing) return existing;
      }
    }
    const job = this.db.createJob({
      commentId,
      maxAttempts: maxAttempts || this.config.worker.maxAttempts,
      stage: 'select_comment',
      simulated: simulated ? 1 : 0,
    });
    if (commentId) this.db.markCommentQueued(commentId, job.id);
    this.logger.info(`Job queued ${job.id}`, { commentId });
    return job;
  }

  /** Enqueue a job for the best eligible comment (used by the scheduler). */
  async enqueueFromComments() {
    const settings = this.getSettings();
    if (!settings.autoEnqueue) return null;
    const comment = this.db.pickEligibleComment();
    if (!comment) return null;
    const counts = this.db.jobCountsSince(`${today()}T00:00:00.000Z`);
    if (settings.dailyJobLimit && counts.jobs >= settings.dailyJobLimit) {
      this.logger.warn(`Daily job limit reached (${counts.jobs}/${settings.dailyJobLimit}); not enqueuing`);
      return null;
    }
    return this.enqueue({ commentId: comment.id });
  }

  /**
   * Run one job to completion (or a retryable failure).
   * Used by the loop and by `run-once` in the CLI.
   */
  async runJob(job) {
    this.currentJobId = job.id;
    const log = this.logger.child('pipeline', job.id);
    const state = { ...job.state, completedStages: job.state?.completedStages || [], warnings: job.state?.warnings || [] };
    const attempt = (job.attempt || 0) + 1;
    this.db.updateJob(job.id, { status: JOB_STATUS.RUNNING, attempt, started_at: job.started_at || new Date().toISOString() });
    log.info(`Job started (attempt ${attempt}/${job.max_attempts})`, { stage: job.stage });

    const budget = {
      remaining: Math.max(0, this.config.openrouter.maxCallsPerJob - (state.aiCalls || 0)),
      consume: () => {
        budget.remaining -= 1;
        state.aiCalls = (state.aiCalls || 0) + 1;
      },
    };

    try {
      for (const stage of Object.keys(STAGE_PROGRESS)) {
        if (stage === 'done') break;
        if (this.stopRequested) throw new StageError('Worker is shutting down', { retryable: true, code: 'shutdown' });
        const current = this.db.getJob(job.id);
        if (current?.cancel_requested) throw new StageError('Job cancelled by user', { retryable: false, code: 'canceled' });
        if (state.completedStages.includes(stage)) continue;

        const result = await withTimeout(
          this.executeStage(stage, { job, state, log, budget }),
          this.config.worker.stageTimeoutMs,
          stage,
        );
        state.completedStages.push(stage);
        Object.assign(state, result?.state || {});
        this.persist(job.id, state, stage, STAGE_PROGRESS[stage]);
        log.info(`Stage ${stage} complete`, result?.meta || undefined);
      }

      this.db.updateJob(job.id, { state_json: JSON.stringify(state) });
      this.db.markJobSucceeded(job.id);
      this.db.bumpWorkerCounter('jobs_today');
      if (job.comment_id) {
        this.db.markCommentUsed(job.comment_id, job.id);
      }
      if (state.videoSkipped) {
        log.warn('Job finished without a video (browser unavailable)', {
          site: state.deployUrl || state.previewUrl,
          reason: state.videoUnavailableReason,
        });
      } else {
        log.info('Job finished successfully', {
          site: state.deployUrl || state.previewUrl,
          video: state.videoPath,
          youtube: state.youtubeUrl,
        });
      }
      return this.db.getJob(job.id);
    } catch (error) {
      const cancelled = error.code === 'canceled' || this.db.getJob(job.id)?.cancel_requested;
      const retryable = error.retryable !== false && !cancelled && attempt < (job.max_attempts || this.config.worker.maxAttempts);
      const stage = this.db.getJob(job.id)?.stage || 'unknown';
      this.persist(job.id, state, stage, STAGE_PROGRESS[stage] || 0);

      if (cancelled) {
        this.db.updateJob(job.id, {
          status: JOB_STATUS.CANCELED,
          error: 'Cancelled by user',
          error_stage: stage,
          finished_at: new Date().toISOString(),
        });
        if (job.comment_id) this.db.resetCommentToEligible(job.comment_id);
        log.warn('Job cancelled');
        return this.db.getJob(job.id);
      }

      const delay = retryable
        ? Math.min(this.config.worker.backoffMaxMs, this.config.worker.backoffBaseMs * 2 ** (attempt - 1))
        : 0;

      if (retryable) {
        const retryAt = new Date(Date.now() + delay).toISOString();
        this.db.markJobFailed(job.id, {
          error: `${stage}: ${error.message}`.slice(0, 2000),
          stage,
          attempt,
          retryAt,
        });
        log.warn(`Job failed at ${stage}; retry in ${Math.round(delay / 1000)}s: ${error.message}`);
      } else {
        this.db.markJobFailed(job.id, {
          error: `${stage}: ${error.message}`.slice(0, 2000),
          stage,
          attempt,
          retryAt: null,
        });
        if (job.comment_id) this.db.resetCommentToEligible(job.comment_id);
        log.error(`Job failed permanently at ${stage}: ${error.message}`);
      }
      this.db.setWorkerError(`${stage}: ${error.message}`.slice(0, 500));
      return this.db.getJob(job.id);
    } finally {
      this.currentJobId = null;
      this.db.heartbeat();
    }
  }

  persist(jobId, state, stage, progress) {
    this.db.updateJob(jobId, {
      stage,
      progress: Math.max(0, Math.min(100, progress)),
      state_json: JSON.stringify(state),
    });
  }

  /* ------------------------------------------------------------- stages */

  async executeStage(stage, ctx) {
    const handlers = {
      select_comment: this.stageSelectComment.bind(this),
      generate_idea: this.stageGenerateIdea.bind(this),
      build_site: this.stageBuildSite.bind(this),
      test_site: this.stageTestSite.bind(this),
      deploy_site: this.stageDeploySite.bind(this),
      write_script: this.stageWriteScript.bind(this),
      narrate: this.stageNarrate.bind(this),
      record_site: this.stageRecordSite.bind(this),
      subtitles: this.stageSubtitles.bind(this),
      render_video: this.stageRenderVideo.bind(this),
      upload_video: this.stageUploadVideo.bind(this),
    };
    const handler = handlers[stage];
    if (!handler) throw new StageError(`Unknown stage ${stage}`, { retryable: false });
    this.db.updateJob(ctx.job.id, { stage, status: JOB_STATUS.RUNNING });
    return handler(ctx);
  }

  async stageSelectComment({ job, state, log }) {
    let comment = job.comment_id ? this.db.getComment(job.comment_id) : null;
    if (!comment) {
      comment = this.db.pickEligibleComment();
      if (!comment) {
        throw new StageError('No eligible comments available. Collect comments or supply one manually.', {
          retryable: false,
          code: 'no_comment',
        });
      }
      this.db.updateJob(job.id, { comment_id: comment.id });
      this.db.markCommentQueued(comment.id, job.id);
    }
    const evaluation = evaluateComment(comment.text, {
      minLength: this.config.youtube.minCommentLength,
      maxLength: this.config.youtube.maxCommentLength,
      allowSuspicious: true,
    });
    const text = evaluation.text || comment.text;
    log.info(`Selected comment ${comment.id}`, { author: comment.author, likes: comment.like_count });
    return {
      state: {
        commentId: comment.id,
        commentText: text,
        commentAuthor: comment.author || 'a viewer',
        commentVideoId: comment.video_id || null,
        commentVideoTitle: comment.video_title || null,
        commentLikes: comment.like_count || 0,
        commentHash: evaluation.hash,
        commentFlags: evaluation.flags,
      },
      meta: { commentId: comment.id },
    };
  }

  async stageGenerateIdea({ job, state, log, budget }) {
    const result = await this.ideaGenerator.generate({
      comment: state.commentText,
      author: state.commentAuthor,
      jobId: job.id,
      budget,
    });
    log.info(`Idea generated: ${result.brief.title}`, { source: result.source, simulated: result.simulated });
    return {
      state: {
        brief: result.brief,
        briefSimulated: result.simulated,
        briefSource: result.source,
        briefModel: result.model || null,
        fallbackReason: result.fallbackReason || null,
        warnings: result.simulated
          ? [...(state.warnings || []), `Idea generated offline (${result.fallbackReason || 'AI unavailable'})`]
          : state.warnings,
      },
      meta: { title: result.brief.title, simulated: result.simulated },
    };
  }

  async stageBuildSite({ job, state, log, budget }) {
    const siteId = `site_${job.id.replace(/^job_/, '').slice(0, 14)}_${uid('x').slice(-6)}`;
    const generation = await this.websiteBuilder.generate({
      brief: state.brief,
      comment: state.commentText,
      author: state.commentAuthor,
      jobId: job.id,
      budget,
    });

    if (!generation.ok) {
      throw new StageError(`Generated website failed validation: ${generation.errors.slice(0, 3).join(' | ')}`, {
        retryable: false,
        code: 'site_invalid',
      });
    }

    const written = this.websiteBuilder.writeSite({
      siteId,
      files: generation.files,
      brief: state.brief,
      comment: state.commentText,
      meta: {
        jobId: job.id,
        simulated: generation.simulated,
        source: generation.source,
        model: generation.model,
        attempts: generation.attempts,
      },
    });

    const website = this.db.saveWebsite({
      job_id: job.id,
      title: state.brief.title,
      slug: written.manifest.slug,
      brief: state.brief,
      dir: written.dir,
      entry_file: 'index.html',
      status: 'generated',
      simulated: generation.simulated,
    });

    log.info(`Website written to ${path.relative(this.config.root, written.dir)}`, {
      files: written.files.length,
      simulated: generation.simulated,
      attempts: generation.attempts,
    });

    return {
      state: {
        siteId,
        siteDir: written.dir,
        websiteId: website.id,
        siteSimulated: generation.simulated,
        siteSource: generation.source,
        siteModel: generation.model,
        siteAttempts: generation.attempts,
        siteWarnings: generation.warnings,
        warnings: generation.simulated
          ? [...(state.warnings || []), `Website generated offline: ${generation.fallbackReason || 'AI unavailable'}`]
          : state.warnings,
      },
      meta: { siteId, files: written.files.length },
    };
  }

  async stageTestSite({ job, state, log }) {
    const website = this.db.getWebsite(state.websiteId);
    const result = await this.websiteTester.test({
      siteId: state.siteId,
      siteDir: website?.dir || state.siteDir,
      files: this.websiteBuilder.readSiteFiles(state.siteId).map((f) => ({ path: f.path, size: f.size })),
    });

    this.db.saveWebsite({
      ...website,
      job_id: job.id,
      title: state.brief?.title,
      slug: website?.slug,
      brief: state.brief,
      dir: website?.dir || state.siteDir,
      screenshot_path: result.screenshotPath || null,
      status: result.ok ? 'tested' : 'failed',
      simulated: state.siteSimulated,
    });

    if (!result.ok) {
      throw new StageError(`Website tests failed: ${result.errors.slice(0, 3).join(' | ')}`, {
        retryable: false,
        code: 'site_test_failed',
      });
    }

    log.info(`Website tested in ${result.mode} mode`, { checks: result.checks.length, warnings: result.warnings.length });
    return {
      state: {
        screenshotPath: result.screenshotPath || null,
        verticalScreenshotPath: result.verticalScreenshotPath || null,
        testMode: result.mode,
        testChecks: result.checks,
        warnings: [...(state.warnings || []), ...result.warnings].slice(0, 40),
      },
      meta: { mode: result.mode },
    };
  }

  async stageDeploySite({ job, state, log }) {
    const website = this.db.getWebsite(state.websiteId);
    const deployment = await this.deployer.deployAndVerify({
      siteId: state.siteId,
      siteDir: website?.dir || state.siteDir,
      brief: state.brief,
      title: state.brief?.title,
    });

    const verifiedAt = deployment.verified ? new Date().toISOString() : null;
    this.db.saveWebsite({
      ...website,
      job_id: job.id,
      title: state.brief?.title,
      slug: website?.slug,
      brief: state.brief,
      dir: website?.dir || state.siteDir,
      screenshot_path: state.screenshotPath || website?.screenshot_path || null,
      preview_url: `/sites/${state.siteId}/`,
      deploy_provider: deployment.provider,
      deploy_url: deployment.provider === 'local' ? null : deployment.url,
      deploy_meta: { ...deployment.meta, verification: deployment.verification || null, note: deployment.note },
      status: deployment.verified ? 'verified' : deployment.provider === 'local' ? 'local-preview' : 'deployed',
      verified_at: verifiedAt,
      simulated: deployment.simulated || deployment.provider === 'local',
    });

    log.info(`Deployment ready via ${deployment.provider}`, { url: deployment.url, verified: deployment.verified });
    return {
      state: {
        deployUrl: deployment.provider === 'local' ? null : deployment.url,
        previewUrl: `/sites/${state.siteId}/`,
        deployProvider: deployment.provider,
        deployVerified: deployment.verified,
        deploySimulated: deployment.provider === 'local',
        deployMeta: deployment.meta,
        recordUrl: deployment.url,
        warnings: deployment.provider === 'local'
          ? [...(state.warnings || []), 'Site is only served locally by this app (no public static host configured).']
          : state.warnings,
      },
      meta: { provider: deployment.provider, verified: deployment.verified },
    };
  }

  async stageWriteScript({ job, state, log, budget }) {
    const settings = this.getSettings();
    const script = await this.scriptWriter.write({
      brief: state.brief,
      comment: state.commentText,
      author: state.commentAuthor,
      url: state.deployUrl || state.previewUrl || '',
      jobId: job.id,
      budget,
      targetSeconds: settings.targetDurationSec,
    });

    this.db.saveVideo({
      job_id: job.id,
      website_id: state.websiteId,
      script,
      status: 'scripted',
      simulated: script.simulated ? 1 : 0,
    });

    log.info(`Script ready (${script.wordCount} words)`, { simulated: script.simulated, source: script.source });
    return {
      state: {
        script,
        scriptSimulated: Boolean(script.simulated),
        warnings: script.simulated
          ? [...(state.warnings || []), `Video script generated offline: ${script.fallbackReason || 'AI unavailable'}`]
          : state.warnings,
      },
      meta: { words: script.wordCount },
    };
  }

  async stageNarrate({ job, state, log }) {
    let narration;
    try {
      narration = await this.narration.synthesize({
        segments: state.script.segments,
        jobId: job.id,
        targetSeconds: state.script.targetSeconds,
      });
    } catch (error) {
      if (error instanceof TtsUnavailableError) {
        throw new StageError(`Narration unavailable: ${error.message}`, { retryable: false, code: 'tts_unavailable' });
      }
      throw error;
    }

    const videoRow = this.db.getVideoByJob(job.id);
    this.db.saveVideo({
      ...(videoRow || {}),
      id: videoRow?.id,
      job_id: job.id,
      website_id: state.websiteId,
      script: state.script,
      narration_path: narration.path,
      narration_duration: narration.durationSec,
      status: 'narrated',
      simulated: narration.simulated || state.scriptSimulated ? 1 : 0,
    });

    log.info(`Narration synthesised (${narration.durationSec.toFixed(1)}s via ${narration.engine})`, {
      simulated: narration.simulated,
    });
    return {
      state: {
        narrationPath: narration.path,
        narrationDuration: narration.durationSec,
        narrationSegments: narration.segments,
        narrationEngine: narration.engine,
        narrationSimulated: narration.simulated,
        warnings: [...(state.warnings || []), ...narration.warnings].slice(0, 40),
      },
      meta: { duration: narration.durationSec, engine: narration.engine },
    };
  }

  async stageRecordSite({ job, state, log }) {
    let url = state.recordUrl || state.deployUrl;
    let tempServer = null;

    // A local deployment is only reachable while this process runs. Serve the site on
    // an ephemeral port so recording works identically from the server and the CLI.
    if (!url || state.deployProvider === 'local') {
      const website = this.db.getWebsite(state.websiteId);
      const siteDir = website?.dir || state.siteDir;
      if (!siteDir) throw new StageError('No site directory available to record', { retryable: false, code: 'no_url' });
      try {
        tempServer = await startStaticServer(siteDir, { port: 0, host: '127.0.0.1' });
        url = `${tempServer.url}/`;
      } catch (error) {
        throw new StageError(`Could not serve the generated site for recording: ${error.message}`, { retryable: false });
      }
    }

    const duration = Math.max(8, Math.min(this.config.video.maxDurationSec, (state.narrationDuration || 30) + 1));
    let recording;
    try {
      try {
        recording = await this.recorder.record({ url, jobId: job.id, targetDurationSec: duration });
      } catch (error) {
        const unavailable = isBrowserUnavailable(error) || /Chromium|chromium|browser/i.test(error.message);
        const screenshot = state.verticalScreenshotPath || state.screenshotPath;
        if (!unavailable || !screenshot || !this.config.recording.allowScreenshotFallback) {
          throw error;
        }
        log.warn(`Browser recording unavailable (${error.message.split('\n')[0]}); using screenshot fallback`);
        recording = await this.recorder.recordScreenshotFallback({
          screenshotPath: screenshot,
          jobId: job.id,
          targetDurationSec: duration,
        });
        state.warnings = [...(state.warnings || []), 'Recording fell back to a screenshot animation because Chromium could not launch.'];
      }
    } catch (error) {
      if (isBrowserUnavailable(error)) {
        const reason =
          `${error.message.split('\n')[0]} Install Chromium ` +
          '(`npx playwright install --with-deps chromium`) and re-run the job.';
        if (this.config.recording.allowSkipVideo) {
          log.warn(`Video skipped (browser unavailable): ${reason}`);
          return {
            state: {
              videoSkipped: true,
              videoUnavailableReason: reason,
              warnings: [
                ...(state.warnings || []),
                'No video was produced: Chromium is unavailable on this host. The website, script and narration are complete.',
              ],
            },
            meta: { skipped: true, reason: 'browser_unavailable' },
          };
        }
        throw new StageError(`Cannot record the website: ${reason}`, {
          retryable: false,
          code: 'browser_unavailable',
        });
      }
      throw error;
    } finally {
      if (tempServer) await tempServer.close().catch(() => {});
    }

    const videoRow = this.db.getVideoByJob(job.id);
    this.db.saveVideo({
      ...(videoRow || {}),
      id: videoRow?.id,
      job_id: job.id,
      website_id: state.websiteId,
      script: state.script,
      narration_path: state.narrationPath,
      narration_duration: state.narrationDuration,
      raw_recording_path: recording.path,
      status: 'recorded',
      simulated: recording.simulated || state.scriptSimulated ? 1 : 0,
    });

    log.info(`Site recorded (${recording.mode}, ${recording.durationSec.toFixed(1)}s)`, {
      simulated: recording.simulated,
      chapters: recording.chapters?.length || 0,
    });
    return {
      state: {
        recordingPath: recording.path,
        recordingMode: recording.mode,
        recordingSimulated: recording.simulated,
        recordingDuration: recording.durationSec,
        recordingChapters: recording.chapters || [],
        sourceUrl: url,
      },
      meta: { mode: recording.mode },
    };
  }

  async stageSubtitles({ job, state, log }) {
    if (state.videoSkipped) {
      log.warn('Subtitles skipped: no recording was produced');
      return { state: { subtitleSkipped: true }, meta: { skipped: true } };
    }
    const dir = path.join(this.config.paths.videos, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const subtitles = buildSubtitles({
      segments: state.narrationSegments,
      audioDurationSec: state.narrationDuration,
      video: this.config.video,
      dir,
      brand: this.config.video.brandName,
    });
    const sync = verifySync(subtitles.cues, state.narrationDuration);
    if (!sync.ok) {
      throw new StageError(`Subtitle synchronisation failed: ${sync.problems.join('; ')}`, {
        retryable: false,
        code: 'subtitle_sync',
      });
    }

    const videoRow = this.db.getVideoByJob(job.id);
    this.db.saveVideo({
      ...(videoRow || {}),
      id: videoRow?.id,
      job_id: job.id,
      website_id: state.websiteId,
      script: state.script,
      narration_path: state.narrationPath,
      narration_duration: state.narrationDuration,
      subtitles_srt: subtitles.srtPath,
      subtitles_ass: subtitles.assPath,
      raw_recording_path: state.recordingPath,
      status: 'subtitled',
      simulated: state.recordingSimulated || state.scriptSimulated ? 1 : 0,
    });

    log.info(`${subtitles.cues.length} subtitle cues generated from measured audio`);
    return {
      state: { subtitleCues: subtitles.cues, subtitleSrt: subtitles.srtPath, subtitleAss: subtitles.assPath },
      meta: { cues: subtitles.cues.length },
    };
  }

  async stageRenderVideo({ job, state, log }) {
    if (state.videoSkipped) {
      log.warn('Render skipped: no recording was produced');
      return { state: { renderSkipped: true }, meta: { skipped: true } };
    }
    const result = await this.renderer.render({
      jobId: job.id,
      recordingPath: state.recordingPath,
      narrationPath: state.narrationPath,
      narrationDurationSec: state.narrationDuration,
      segments: state.narrationSegments,
      script: state.script,
    });

    const simulated = state.recordingSimulated || state.scriptSimulated || state.narrationSimulated;
    const videoRow = this.db.getVideoByJob(job.id);
    this.db.saveVideo({
      ...(videoRow || {}),
      id: videoRow?.id,
      job_id: job.id,
      website_id: state.websiteId,
      script: state.script,
      narration_path: state.narrationPath,
      narration_duration: state.narrationDuration,
      subtitles_srt: result.subtitlePaths.srt,
      subtitles_ass: result.subtitlePaths.ass,
      raw_recording_path: state.recordingPath,
      output_path: result.path,
      duration_sec: result.durationSec,
      width: result.width,
      height: result.height,
      fps: result.fps,
      status: 'rendered',
      simulated: simulated ? 1 : 0,
      metadata: {
        subtitlesBurned: result.subtitlesBurned,
        recordingMode: state.recordingMode,
        sourceUrl: state.sourceUrl,
        checks: result.checks,
        sizeBytes: result.sizeBytes,
      },
    });

    log.info(`Video rendered (${result.durationSec.toFixed(1)}s, ${result.width}x${result.height})`, {
      burnedSubtitles: result.subtitlesBurned,
      simulated,
    });
    return {
      state: {
        videoPath: result.path,
        videoDuration: result.durationSec,
        videoWidth: result.width,
        videoHeight: result.height,
        subtitlesBurned: result.subtitlesBurned,
        videoSimulated: simulated,
      },
      meta: { duration: result.durationSec },
    };
  }

  async stageUploadVideo({ job, state, log }) {
    if (state.videoSkipped) {
      log.warn('Upload skipped: no video was produced');
      return { state: { uploadSkipped: true, uploadSkipReason: 'video_skipped_no_browser' }, meta: { skipped: true } };
    }
    const videoRow = this.db.getVideoByJob(job.id);
    if (!videoRow?.output_path) throw new StageError('No rendered video available for upload', { retryable: false });

    const limits = uploadLimits(this, job);
    if (!limits.allowed) {
      log.warn(`Upload skipped: ${limits.reason}`);
      this.db.saveUpload({
        video_id: videoRow.id,
        job_id: job.id,
        title: state.script?.title,
        privacy: this.getSettings().privacy,
        status: 'skipped',
        simulated: 1,
        response: { reason: limits.reason },
      });
      return { state: { uploadSkipped: true, uploadSkipReason: limits.reason }, meta: { skipped: true } };
    }

    const simulated = Boolean(state.videoSimulated) || !this.uploader.oauth?.isConnected();
    const result = await this.uploader.upload({
      videoRow,
      script: state.script,
      websiteUrl: state.deployUrl || (state.previewUrl ? `${this.config.baseUrl}${state.previewUrl}` : ''),
      author: state.commentAuthor,
      comment: state.commentText,
      simulated,
      jobId: job.id,
    });

    if (result.skipped) {
      log.warn(`Upload skipped: ${result.reason}`);
      return { state: { uploadSkipped: true, uploadSkipReason: result.reason }, meta: { skipped: true } };
    }

    return {
      state: {
        uploadId: result.upload?.id || null,
        youtubeVideoId: result.youtubeId || null,
        youtubeUrl: result.url || null,
        uploadSimulated: result.simulated,
        warnings: result.simulated
          ? [...(state.warnings || []), 'Upload was simulated: the video was not sent to YouTube.']
          : state.warnings,
      },
      meta: { simulated: result.simulated, url: result.url || null },
    };
  }

  /**
   * Comment collection step, called by the scheduler or manually from the dashboard.
   */
  async pollComments() {
    try {
      const summary = await this.comments.collectAndStore();
      this.db.setLastPoll();
      if (summary.eligible > 0 && !this.getSettings().paused) {
        await this.enqueueFromComments().catch((error) => this.logger.warn(`Auto-enqueue skipped: ${error.message}`));
      }
      return summary;
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        this.logger.warn(`Comment polling paused: ${error.message}`);
        this.db.setWorkerError(error.message);
        return { error: error.message, quotaExceeded: true };
      }
      this.logger.error(`Comment polling failed: ${error.message}`);
      this.db.setWorkerError(error.message);
      return { error: error.message };
    }
  }
}

module.exports = { PipelineWorker, STAGE_PROGRESS, DEFAULT_SETTINGS, StageError };

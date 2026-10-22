'use strict';

/**
 * Dashboard JSON API. Every route here is behind dashboard authentication.
 */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { publicConfig } = require('../config');
const { STAGE_PROGRESS } = require('../workers/pipeline-worker');
const { resolveBinaries, probeMedia } = require('../lib/media');
const { browserAvailability } = require('../lib/browser');
const { NarrationService } = require('../services/narration');
const { evaluateComment } = require('../services/comment-filter');

function createApiRouter({ config, db, logger, worker, scheduler, oauth, comments, openrouter }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const requireWorker = (res) => {
    if (!worker) {
      res.status(503).json({ error: 'Pipeline worker is not running in this process. Start it with `npm run worker`.' });
      return false;
    }
    return true;
  };

  router.get('/overview', async (req, res) => {
    const stats = db.stats();
    const usage = db.usageForDay();
    const recent = db.listJobs({ limit: 8 });
    const settings = worker ? worker.getSettings() : {};
    const quota = comments?.quotaStatus?.() || null;
    const tts = new NarrationService(config, {}).detect();
    const bins = resolveBinaries(config);
    const ffmpeg = bins.ffmpeg
      ? { available: true, ffprobe: Boolean(bins.ffprobe), path: bins.ffmpeg }
      : { available: false, ffprobe: false };
    const browser = await browserAvailability(config, { probe: true });
    res.json({
      stats,
      worker: worker ? worker.status() : { running: false, paused: true },
      settings,
      quota,
      usage,
      recentJobs: recent.jobs,
      warnings: config.warnings,
      capabilities: {
        ffmpeg,
        browser,
        tts: { engine: tts.engine, usable: tts.usable, piper: tts.piper.available, espeak: tts.espeak.available },
        openrouter: { configured: openrouter?.configured || false, models: config.openrouter.models },
        deploy: { provider: config.deploy.provider, configured: publicConfig(config).deploy.github.configured || Boolean(config.deploy.netlify.token) },
        youtube: {
          oauthConfigured: Boolean(config.youtube.clientId && config.youtube.clientSecret),
          connected: Boolean(oauth?.isConnected?.()),
          channel: db.getTokens('google-youtube')?.channel_title || null,
        },
      },
      dryRun: config.dryRun,
      serverTime: new Date().toISOString(),
    });
  });

  router.get('/jobs', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = db.listJobs({
      status: req.query.status ? String(req.query.status) : undefined,
      search: req.query.search ? String(req.query.search).slice(0, 120) : undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  router.get('/jobs/:id', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const website = db.getWebsiteByJob(job.id);
    const video = db.getVideoByJob(job.id);
    const upload = video ? db.getUploadByVideo(video.id) : null;
    res.json({
      job,
      website,
      video,
      upload,
      logs: db.listLogs({ jobId: job.id, limit: 200 }),
      stages: Object.keys(STAGE_PROGRESS),
    });
  });

  router.post('/jobs', async (req, res) => {
    if (!requireWorker(res)) return;
    const text = String(req.body?.comment || '').trim();
    const author = String(req.body?.author || 'manual').slice(0, 60);
    if (!text) return res.status(400).json({ error: 'comment text is required' });
    if (Buffer.byteLength(text) > config.security.allowedCommentMaxBytes) {
      return res.status(413).json({ error: 'comment is too large' });
    }
    const evaluation = evaluateComment(text, {
      minLength: 1,
      maxLength: config.youtube.maxCommentLength,
      allowSuspicious: true,
    });
    const { comment } = comments.addManualComment({ text, author, force: true });
    try {
      const job = await worker.enqueue({ commentId: comment.id });
      logger.info(`Manual job queued from dashboard: ${job.id}`, { flags: evaluation.flags });
      res.status(201).json({ job, comment, flags: evaluation.flags });
    } catch (error) {
      res.status(429).json({ error: error.message });
    }
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
      return res.status(409).json({ error: `Job is already ${job.status}` });
    }
    db.requestCancel(job.id);
    logger.warn(`Cancellation requested for job ${job.id}`);
    res.json({ ok: true, job: db.getJob(job.id) });
  });

  router.post('/jobs/:id/retry', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['failed', 'canceled'].includes(job.status)) {
      return res.status(409).json({ error: `Only failed or canceled jobs can be retried (status: ${job.status})` });
    }
    const state = { ...job.state };
    // Keep completed (verified) artifacts; re-run from the failed stage.
    const updated = db.updateJob(job.id, {
      status: 'queued',
      attempt: 0,
      error: null,
      error_stage: null,
      finished_at: null,
      cancel_requested: 0,
      next_run_at: null,
      state_json: JSON.stringify(state),
    });
    if (job.comment_id) db.markCommentQueued(job.comment_id, job.id);
    logger.info(`Job ${job.id} re-queued from stage ${job.stage}`);
    res.json({ ok: true, job: updated });
  });

  router.get('/comments', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({
      counts: db.countComments(),
      comments: db.recentComments(limit),
      quota: comments?.quotaStatus?.() || null,
    });
  });

  router.post('/comments/poll', async (req, res) => {
    if (!scheduler) return res.status(503).json({ error: 'Scheduler is not running in this process.' });
    const summary = await scheduler.pollNow('dashboard');
    res.json(summary);
  });

  router.get('/logs', (req, res) => {
    const logs = db.listLogs({
      level: req.query.level ? String(req.query.level) : undefined,
      jobId: req.query.job ? String(req.query.job) : undefined,
      search: req.query.q ? String(req.query.q).slice(0, 120) : undefined,
      limit: Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
    });
    res.json({ logs });
  });

  router.get('/settings', (req, res) => {
    res.json({
      config: publicConfig(config),
      automation: worker ? worker.getSettings() : null,
      editable: ['paused', 'autoEnqueue', 'commentPollingEnabled', 'dailyJobLimit', 'dailyUploadLimit', 'pollIntervalMinutes', 'targetDurationSec', 'maxJobsInQueue', 'privacy', 'model'],
      envOnly: [
        'OPENROUTER_API_KEY',
        'OPENROUTER_MODELS',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GITHUB_TOKEN',
        'GITHUB_OWNER',
        'DEPLOY_PROVIDER',
        'TTS_ENGINE',
        'PIPER_MODEL',
        'ALLOW_PUBLIC_UPLOAD',
        'UPLOAD_PRIVACY',
        'DRY_RUN',
      ],
      ai: {
        model: db.getSetting('ai', {})?.model || '',
        models: config.openrouter.models,
        callsToday: openrouter?.aiCallsToday?.() || 0,
        dailyCallLimit: config.limits.maxOpenRouterCallsPerDay,
      },
      youtube: {
        connected: Boolean(oauth?.isConnected?.()),
        channel: db.getTokens('google-youtube')?.channel_title || null,
        channelId: db.getTokens('google-youtube')?.channel_id || null,
      },
      oauth: {
        configured: Boolean(config.youtube.clientId && config.youtube.clientSecret),
        redirectUri: config.youtube.redirectUri,
        scopes: config.youtube.scopes,
      },
    });
  });

  router.put('/settings', (req, res) => {
    if (!requireWorker(res)) return;
    const before = worker.getSettings();
    const next = worker.updateSettings(req.body || {});
    if (typeof req.body?.model === 'string') {
      const model = req.body.model.trim();
      if (model && !/^[\w./:-]{3,120}$/.test(model)) {
        return res.status(400).json({ error: 'Model id contains unsupported characters' });
      }
      db.setSetting('ai', { ...(db.getSetting('ai', {}) || {}), model });
      logger.info(`AI model override ${model ? `set to ${model}` : 'cleared'}`);
    }
    logger.info('Automation settings updated', { before, after: next });
    res.json({ ok: true, automation: next });
  });

  router.post('/automation/:action', async (req, res) => {
    if (!requireWorker(res)) return;
    const action = req.params.action;
    if (action === 'pause') {
      worker.pause();
      return res.json({ ok: true, status: worker.status() });
    }
    if (action === 'resume') {
      worker.resume();
      return res.json({ ok: true, status: worker.status() });
    }
    if (action === 'start') {
      if (!worker.running) await worker.start();
      else worker.resume();
      return res.json({ ok: true, status: worker.status() });
    }
    if (action === 'run-once') {
      try {
        const job = await worker.enqueue({});
        return res.json({ ok: true, job });
      } catch (error) {
        return res.status(429).json({ error: error.message });
      }
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  });

  router.get('/videos/:id/validate', async (req, res) => {
    const video = db.getVideo(req.params.id);
    if (!video?.output_path || !fs.existsSync(video.output_path)) {
      return res.status(404).json({ error: 'Rendered video not found on disk' });
    }
    try {
      const probe = await probeMedia(video.output_path, resolveBinaries(config));
      res.json({ file: path.basename(video.output_path), probe });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/usage', (req, res) => {
    res.json({
      today: db.usageForDay(),
      series: db.usageSeries(14),
      quota: comments?.quotaStatus?.() || null,
      aiCallsToday: openrouter?.aiCallsToday?.() || 0,
      aiCallLimit: config.limits.maxOpenRouterCallsPerDay,
    });
  });

  router.use((error, req, res, next) => {
    logger.error(`API error on ${req.method} ${req.path}: ${error.message}`);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}

module.exports = { createApiRouter };

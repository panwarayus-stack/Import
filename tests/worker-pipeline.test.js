'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PipelineWorker, STAGE_PROGRESS } = require('../src/workers/pipeline-worker');
const { JOB_STATUS } = require('../src/database');
const { testConfig, testDb, silentLogger, DEMO_COMMENT } = require('./helpers');

const brief = {
  title: 'Budget Family',
  slug: 'budget-family',
  tagline: 'Plan meals without an app',
  hero: { headline: 'Make meals simple again', subheadline: 'A one-page planner.', primaryCta: 'Start', secondaryCta: 'Learn' },
  sections: [
    { id: 'features', heading: 'What you get', body: 'Tools', items: [{ title: 'Planner', description: 'Plan a week' }, { title: 'Filter', description: 'Sort ideas' }] },
    { id: 'process', heading: 'How it works', body: 'Steps', items: [{ title: 'Read', description: 'Start' }, { title: 'Share', description: 'Done' }] },
  ],
  faq: [{ q: 'Free?', a: 'Yes.' }],
  palette: { background: '#070b18', surface: '#0f1730', primary: '#7c5cff', accent: '#22d3ee', text: '#eef2ff', muted: '#a3aecb' },
  keywords: ['meal', 'budget'],
};

function makeWorker({ overrides = {}, deployFailure = null } = {}) {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const logger = silentLogger(db);
  let deployCalls = 0;
  let uploaded = 0;
  let recorded = 0;

  const services = {
    db,
    logger,
    ideaGenerator: { generate: async () => ({ brief, simulated: true, source: 'offline-template', model: null, fallbackReason: 'test' }) },
    websiteBuilder: {
      generate: async () => ({ ok: true, files: [{ path: 'index.html', content: '<html></html>' }], errors: [], warnings: [], simulated: true, source: 'offline-template', model: null, attempts: 0 }),
      writeSite: () => {
        const dir = path.join(ctx.config.paths.sites, 'site_worker_test', 'site');
        require('node:fs').mkdirSync(dir, { recursive: true });
        require('node:fs').writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>Demo</title></head><body><h1>Demo site</h1></body></html>');
        return { siteId: 'site_worker_test', dir, siteDir: ctx.config.paths.sites, files: [{ rel: 'index.html', size: 10 }], totalBytes: 10, manifest: { slug: 'demo' } };
      },
      readSiteFiles: () => [{ path: 'index.html', size: 10 }],
    },
    websiteTester: {
      test: async () => ({ ok: true, mode: 'static-only', checks: [], errors: [], warnings: ['browser skipped'], screenshotPath: path.join(ctx.config.paths.sites, 'shot.png') }),
    },
    deployer: {
      deployAndVerify: async () => {
        deployCalls += 1;
        if (deployFailure && deployCalls <= deployFailure) {
          const error = new Error('hosting temporarily unavailable');
          error.retryable = true;
          throw error;
        }
        return { provider: 'local', url: 'http://127.0.0.1/sites/site_worker_test/', simulated: true, verified: false, meta: {}, note: 'local', verification: { ok: false } };
      },
    },
    recorder: {
      record: async () => {
        recorded += 1;
        return { path: '/tmp/raw.mp4', mode: 'frames', simulated: false, durationSec: 12, chapters: [{ label: 'Hero', startSec: 0 }] };
      },
      recordScreenshotFallback: async () => ({ path: '/tmp/raw.mp4', mode: 'screenshot-fallback', simulated: true, durationSec: 12, chapters: [] }),
    },
    narration: {
      synthesize: async () => ({
        path: '/tmp/narration.wav',
        engine: 'silent',
        simulated: true,
        durationSec: 12,
        gapSec: 0.25,
        segments: [
          { index: 0, text: 'One comment became a website.', startSec: 0, endSec: 4, durationSec: 4, section: 'hook' },
          { index: 1, text: 'The planner updates live.', startSec: 4.25, endSec: 8, durationSec: 3.75, section: 'feature' },
          { index: 2, text: 'Link in the description.', startSec: 8.25, endSec: 12, durationSec: 3.75, section: 'outro' },
        ],
        warnings: ['silent'],
      }),
    },
    scriptWriter: {
      write: async () => ({
        title: 'A comment became a website #Shorts',
        description: 'Demo description',
        tags: ['demo'],
        hook: 'One comment became a website.',
        segments: [{ section: 'hook', text: 'One comment became a website.' }],
        wordCount: 40,
        targetSeconds: 40,
        simulated: true,
        source: 'offline-template',
      }),
    },
    videoRenderer: {
      render: async () => ({
        path: '/tmp/short.mp4',
        durationSec: 12,
        width: 1080,
        height: 1920,
        fps: 30,
        sizeBytes: 900000,
        subtitlesBurned: true,
        subtitlePaths: { srt: '/tmp/subtitles.srt', ass: '/tmp/subtitles.ass' },
        cues: [],
        checks: [],
        errors: [],
      }),
    },
    uploader: {
      oauth: { isConnected: () => true },
      upload: async () => {
        uploaded += 1;
        return { skipped: false, simulated: true, upload: { id: 'up_1' }, metadata: {}, url: null, youtubeId: null };
      },
    },
    comments: { quotaStatus: () => ({ used: 10, limit: 10000, remaining: 9990, exhausted: false }) },
    ...overrides,
  };
  const worker = new PipelineWorker(ctx.config, services);
  const counters = { get deployCalls() { return deployCalls; }, get uploaded() { return uploaded; }, get recorded() { return recorded; } };
  return { ctx, db, worker, services, counters };
}

function createJob(db, commentId) {
  const comment = db.upsertComment({
    id: commentId,
    text: DEMO_COMMENT,
    author: '@demo',
    content_hash: `hash-${commentId}`,
    status: 'queued',
  }).comment;
  return db.createJob({ commentId: comment.id, maxAttempts: 3 });
}

test('runs the full pipeline, persists state after each stage and skips upload when gated', async () => {
  const { db, worker, counters } = makeWorker();
  const job = createJob(db, 'c-full');
  const result = await worker.runJob(db.getJob(job.id));

  assert.equal(result.status, JOB_STATUS.SUCCEEDED);
  assert.equal(result.progress, 100);
  assert.equal(result.stage, 'done');
  assert.equal(counters.recorded, 1);
  assert.equal(counters.deployCalls, 1);
  assert.equal(counters.uploaded, 0, 'simulated video must not be uploaded');

  const completed = result.state.completedStages;
  assert.deepEqual(completed, Object.keys(STAGE_PROGRESS).filter((stage) => stage !== 'done'));
  assert.equal(result.state.youtubeUrl ?? null, null);
  assert.equal(result.state.uploadSkipped, true);
  assert.ok(result.state.warnings.some((warning) => /dry-run|offline|simulated/i.test(warning)));

  const website = db.getWebsiteByJob(job.id);
  assert.equal(website.status, 'local-preview');
  const video = db.getVideoByJob(job.id);
  assert.equal(video.status, 'rendered');
  const upload = db.getUploadByVideo(video.id);
  assert.equal(upload.status, 'skipped');

  // The comment is burned exactly once.
  assert.equal(db.getComment('c-full').status, 'used');
  db.close();
});

test('retries a retryable stage with backoff and resumes from completed stages', async () => {
  const { db, worker, counters } = makeWorker({ deployFailure: 1 });
  const job = createJob(db, 'c-retry');
  const first = await worker.runJob(db.getJob(job.id));
  assert.equal(first.status, JOB_STATUS.RETRYING);
  assert.ok(first.next_run_at);
  assert.match(first.error, /deploy_site|hosting temporarily unavailable/);
  assert.equal(counters.recorded, 0, 'later stages must not run after a failure');

  // Make the retry immediately due and run again.
  db.updateJob(job.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });
  const claimed = db.claimNextJob();
  assert.equal(claimed.id, job.id);
  const second = await worker.runJob(claimed);
  assert.equal(second.status, JOB_STATUS.SUCCEEDED);
  assert.equal(counters.deployCalls, 2);
  assert.equal(counters.recorded, 1);
  db.close();
});

test('a non-retryable failure fails the job and releases the comment', async () => {
  const { db, worker } = makeWorker({
    overrides: {
      websiteBuilder: {
        generate: async () => ({ ok: false, files: [], errors: ['blocked pattern'], warnings: [], simulated: false, source: 'openrouter', model: 'm', attempts: 3 }),
      },
    },
  });
  const job = createJob(db, 'c-fail');
  const result = await worker.runJob(db.getJob(job.id));
  assert.equal(result.status, JOB_STATUS.FAILED);
  assert.equal(result.error_stage, 'build_site');
  assert.match(result.error, /validation/);
  assert.equal(db.getComment('c-fail').status, 'eligible');
  db.close();
});

test('cancellation stops the job before the next stage', async () => {
  const { db, worker } = makeWorker();
  const job = createJob(db, 'c-cancel');
  db.requestCancel(job.id);
  const result = await worker.runJob(db.getJob(job.id));
  assert.equal(result.status, JOB_STATUS.CANCELED);
  assert.equal(db.getComment('c-cancel').status, 'eligible');
  db.close();
});

test('enqueue enforces the queue depth limit', async () => {
  const { db, worker } = makeWorker();
  worker.updateSettings({ maxJobsInQueue: 1 });
  await worker.enqueue({});
  await assert.rejects(() => worker.enqueue({}), /Queue is full/);
  db.close();
});

test('settings changes persist and normalise values', async () => {
  const { db, worker } = makeWorker();
  const next = worker.updateSettings({ dailyJobLimit: '4', dailyUploadLimit: -2, privacy: 'unlisted', paused: true, bogus: 'x' });
  assert.equal(next.dailyJobLimit, 4);
  assert.equal(next.dailyUploadLimit, 1); // negative rejected, keeps previous default
  assert.equal(next.privacy, 'unlisted');
  assert.equal(next.paused, true);
  assert.equal(worker.getSettings().dailyJobLimit, 4);
  db.close();
});

test('without a browser the job fails loudly by default', async () => {
  const { BrowserUnavailableError } = require('../src/services/recorder');
  const { db, worker } = makeWorker({
    overrides: {
      recorder: {
        record: async () => {
          throw new BrowserUnavailableError('Unable to launch Chromium (test)');
        },
        recordScreenshotFallback: async () => ({ path: '/tmp/raw.mp4', mode: 'screenshot-fallback', simulated: true, durationSec: 12, chapters: [] }),
      },
    },
  });
  const job = createJob(db, 'c-nobrowser');
  const result = await worker.runJob(db.getJob(job.id));
  assert.equal(result.status, JOB_STATUS.FAILED);
  assert.equal(result.error_stage, 'record_site');
  assert.match(result.error, /browser_unavailable|Chromium/);
  assert.equal(db.getVideoByJob(job.id)?.output_path ?? null, null, 'no video file may be recorded');
  db.close();
});

test('with ALLOW_SKIP_VIDEO_WITHOUT_BROWSER the job finishes and records that no video exists', async () => {
  const { BrowserUnavailableError } = require('../src/services/recorder');
  const ctx = testConfig();
  ctx.config.recording.allowSkipVideo = true;
  const db = testDb(ctx.config);
  const logger = silentLogger(db);
  let renderCalls = 0;

  const services = {
    db,
    logger,
    ideaGenerator: { generate: async () => ({ brief, simulated: true, source: 'offline-template', model: null, fallbackReason: 'test' }) },
    websiteBuilder: {
      generate: async () => ({ ok: true, files: [{ path: 'index.html', content: '<html></html>' }], errors: [], warnings: [], simulated: true, source: 'offline-template', model: null, attempts: 0 }),
      writeSite: () => {
        const dir = path.join(ctx.config.paths.sites, 'site_skip_test', 'site');
        require('node:fs').mkdirSync(dir, { recursive: true });
        require('node:fs').writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>Demo</title></head><body><h1>Demo site</h1></body></html>');
        return { siteId: 'site_skip_test', dir, siteDir: ctx.config.paths.sites, files: [{ rel: 'index.html', size: 10 }], totalBytes: 10, manifest: { slug: 'demo' } };
      },
      readSiteFiles: () => [{ path: 'index.html', size: 10 }],
    },
    websiteTester: { test: async () => ({ ok: true, mode: 'static-only', checks: [], errors: [], warnings: ['browser skipped'] }) },
    deployer: { deployAndVerify: async () => ({ provider: 'local', url: null, previewUrl: '/sites/site_skip_test/', simulated: true, verified: false, meta: {}, verification: { ok: false } }) },
    recorder: {
      record: async () => {
        throw new BrowserUnavailableError('Unable to launch Chromium (test)');
      },
      recordScreenshotFallback: async () => ({ path: '/tmp/x.mp4' }),
    },
    narration: {
      synthesize: async () => ({
        path: '/tmp/narration.wav',
        engine: 'silent',
        simulated: true,
        durationSec: 11,
        gapSec: 0.25,
        segments: [
          { index: 0, text: 'One comment became a website.', startSec: 0, endSec: 5, durationSec: 5, section: 'hook' },
          { index: 1, text: 'Link in the description.', startSec: 5.25, endSec: 11, durationSec: 5.75, section: 'outro' },
        ],
        warnings: ['silent'],
      }),
    },
    scriptWriter: {
      write: async () => ({ title: 'T #Shorts', description: 'D', tags: [], hook: 'h', segments: [{ section: 'hook', text: 'h' }], wordCount: 20, targetSeconds: 20, simulated: true, source: 'offline-template' }),
    },
    videoRenderer: {
      render: async () => {
        renderCalls += 1;
        throw new Error('renderer must not run when the video is skipped');
      },
    },
    uploader: {
      oauth: { isConnected: () => true },
      upload: async () => {
        throw new Error('uploader must not run when the video is skipped');
      },
    },
    comments: { quotaStatus: () => ({ used: 0, limit: 10000, remaining: 10000, exhausted: false }) },
  };
  const worker = new PipelineWorker(ctx.config, services);
  const job = createJob(db, 'c-skip');
  const result = await worker.runJob(db.getJob(job.id));

  assert.equal(result.status, JOB_STATUS.SUCCEEDED);
  assert.equal(result.stage, 'done');
  assert.equal(result.state.videoSkipped, true);
  assert.equal(result.state.renderSkipped, true);
  assert.equal(result.state.uploadSkipped, true);
  assert.equal(renderCalls, 0);
  assert.ok(result.state.warnings.some((w) => /No video was produced/.test(w)));
  assert.equal(db.getVideoByJob(job.id)?.output_path ?? null, null, 'no video file may be recorded');
  assert.notEqual(db.getVideoByJob(job.id)?.status, 'rendered');
  db.close();
  ctx.cleanup();
});
test('enqueue reuses an active job for the same comment instead of duplicating it', async () => {
  const { db, worker } = makeWorker();
  const job = createJob(db, 'c-dedupe');
  const again = await worker.enqueue({ commentId: 'c-dedupe' });
  assert.equal(again.id, job.id);
  const count = db.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE comment_id = ?').get('c-dedupe').n;
  assert.equal(count, 1);
  db.close();
});

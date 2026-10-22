'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');
const { PipelineWorker } = require('../src/workers/pipeline-worker');
const { GoogleOAuthService } = require('../src/services/google-oauth');
const { YouTubeCommentsService } = require('../src/services/youtube-comments');
const { testConfig, testDb, silentLogger, DEMO_COMMENT } = require('./helpers');

async function boot() {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const logger = silentLogger(db);
  const oauth = new GoogleOAuthService(ctx.config, { db, logger });
  const comments = new YouTubeCommentsService(ctx.config, { db, logger, oauth });
  const stub = (name) => ({ [name]: async () => ({}) });
  const worker = new PipelineWorker(ctx.config, {
    db,
    logger,
    oauth,
    comments,
    ideaGenerator: stub('generate'),
    websiteBuilder: stub('generate'),
    websiteTester: stub('test'),
    deployer: stub('deployAndVerify'),
    recorder: stub('record'),
    narration: stub('synthesize'),
    scriptWriter: stub('write'),
    videoRenderer: stub('render'),
    uploader: { oauth: { isConnected: () => false }, upload: async () => ({ skipped: true }) },
  });
  const scheduler = { pollNow: async () => ({ fetched: 0, inserted: 0, eligible: 0, trigger: 'dashboard' }) };
  const app = createApp({ config: ctx.config, db, logger, worker, scheduler, oauth, comments, openrouter: null });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    ctx,
    db,
    server,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      ctx.cleanup();
    },
  };
}

async function login(base) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'dashboard' },
    body: new URLSearchParams({ password: 'test-password' }).toString(),
    redirect: 'manual',
  });
  const cookie = response.headers.get('set-cookie') || '';
  return { response, cookie: cookie.split(';')[0] };
}

test('health endpoint is public and secret-free', async () => {
  const app = await boot();
  try {
    const response = await fetch(`${app.base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(!JSON.stringify(body).includes('test-password'));
  } finally {
    await app.close();
  }
});

test('dashboard API requires authentication', async () => {
  const app = await boot();
  try {
    const overview = await fetch(`${app.base}/api/overview`);
    assert.equal(overview.status, 401);
    const page = await fetch(`${app.base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
  } finally {
    await app.close();
  }
});

test('login rejects bad passwords and accepts the configured one', async () => {
  const app = await boot();
  try {
    const bad = await fetch(`${app.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'nope' }).toString(),
    });
    assert.equal(bad.status, 401);

    const { response, cookie } = await login(app.base);
    assert.equal(response.status, 200);
    assert.match(cookie, /awf_session=/);

    const overview = await fetch(`${app.base}/api/overview`, { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);
    const body = await overview.json();
    assert.ok(body.stats);
    assert.ok(body.capabilities);
    assert.ok(body.config === undefined || body.config?.openrouter === undefined || body.config.openrouter.configured !== undefined);
    assert.ok(!JSON.stringify(body).includes('clientSecret'));
  } finally {
    await app.close();
  }
});

test('state-changing API calls require the CSRF header', async () => {
  const app = await boot();
  try {
    const { cookie } = await login(app.base);
    const blocked = await fetch(`${app.base}/api/automation/pause`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(blocked.status, 403);

    const allowed = await fetch(`${app.base}/api/automation/pause`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' },
      body: '{}',
    });
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});

test('manual comment creates a queued job and is stored as untrusted input', async () => {
  const app = await boot();
  try {
    const { cookie } = await login(app.base);
    const response = await fetch(`${app.base}/api/jobs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' },
      body: JSON.stringify({ comment: DEMO_COMMENT, author: '@tester' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.ok(body.job.id.startsWith('job_'));
    const stored = app.db.getComment(body.comment.id);
    assert.equal(stored.status, 'queued');
    assert.equal(stored.author, '@tester');

    const tooBig = await fetch(`${app.base}/api/jobs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' },
      body: JSON.stringify({ comment: 'x'.repeat(9000) }),
    });
    assert.equal(tooBig.status, 413);
  } finally {
    await app.close();
  }
});

test('job endpoints return 404 for unknown ids', async () => {
  const app = await boot();
  try {
    const { cookie } = await login(app.base);
    const detail = await fetch(`${app.base}/api/jobs/job_missing`, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 404);
    const retry = await fetch(`${app.base}/api/jobs/job_missing/retry`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Requested-With': 'dashboard', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(retry.status, 404);
  } finally {
    await app.close();
  }
});

test('generated site previews are served with a restrictive CSP', async () => {
  const app = await boot();
  try {
    const { cookie } = await login(app.base);
    const siteId = 'site_api_test';
    const siteDir = path.join(app.ctx.config.paths.sites, siteId, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<!DOCTYPE html><html><head><title>Preview</title></head><body><h1>Preview works</h1></body></html>');

    const response = await fetch(`${app.base}/sites/${siteId}/`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Preview works/);
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);

    const traversal = await fetch(`${app.base}/sites/..%2f..%2fdata/`, { headers: { Cookie: cookie } });
    assert.ok([400, 404].includes(traversal.status));
    const badId = await fetch(`${app.base}/sites/bad.id/`, { headers: { Cookie: cookie } });
    assert.ok([400, 404].includes(badId.status));
  } finally {
    await app.close();
  }
});

test('media endpoints reject unsafe ids', async () => {
  const app = await boot();
  try {
    const { cookie } = await login(app.base);
    const response = await fetch(`${app.base}/media/videos/..%2F..%2Fetc/short.mp4`, { headers: { Cookie: cookie } });
    assert.ok([400, 404].includes(response.status));
  } finally {
    await app.close();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, publicConfig } = require('../src/config');

test('loads sane defaults', () => {
  const config = loadConfig();
  assert.equal(config.port, 3000);
  assert.equal(config.video.width, 1080);
  assert.equal(config.video.height, 1920);
  assert.ok(config.openrouter.models.length >= 1);
  assert.equal(config.upload.allowPublicUpload, false);
  assert.equal(config.deploy.provider, 'local');
  assert.ok(Array.isArray(config.youtube.scopes));
});

test('dry-run flags are derived from missing credentials', () => {
  const config = loadConfig({ openrouter: { apiKey: '' }, youtube: { clientId: '', clientSecret: '' } });
  assert.equal(config.dryRun.ai || loadConfig().dryRun.ai, true);
  assert.equal(loadConfig({ youtube: { clientId: '', clientSecret: '' } }).dryRun.upload, true);
});

test('production without a password warns instead of silently allowing access', () => {
  const config = loadConfig({ env: 'production', isProduction: true, dashboard: { password: '', sessionSecret: '' } });
  assert.ok(config.warnings.some((warning) => warning.includes('DASHBOARD_PASSWORD')));
});

test('publicConfig never exposes secrets', () => {
  const config = loadConfig({
    openrouter: { apiKey: 'sk-or-v1-secretsecretsecretsecret' },
    youtube: { clientId: 'client-id', clientSecret: 'client-secret', channelId: 'UC123' },
    deploy: {
      provider: 'github-pages',
      github: { token: 'ghp_secret', owner: 'someone', repoPrefix: 'demo' },
    },
  });
  const publicView = JSON.stringify(publicConfig(config));
  assert.ok(!publicView.includes('sk-or-v1'));
  assert.ok(!publicView.includes('client-secret'));
  assert.ok(!publicView.includes('ghp_secret'));
  assert.equal(publicConfig(config).deploy.github.configured, true);
});

test('numeric env overrides are clamped', () => {
  process.env.VIDEO_FPS = '500';
  process.env.VIDEO_WIDTH = '99999';
  const config = loadConfig();
  assert.equal(config.video.fps, 60);
  assert.equal(config.video.width, 2160);
  delete process.env.VIDEO_FPS;
  delete process.env.VIDEO_WIDTH;
});

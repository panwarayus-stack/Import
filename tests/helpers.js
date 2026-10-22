'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { FactoryDatabase } = require('../src/database');
const { Logger } = require('../src/lib/logger');

function tempDir(prefix = 'awf-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function testConfig(overrides = {}) {
  const { dir } = tempDir();
  const config = loadConfig({
    env: 'test',
    isProduction: false,
    baseUrl: 'http://127.0.0.1:3999',
    paths: {
      root: path.resolve(__dirname, '..'),
      data: path.join(dir, 'data'),
      sites: path.join(dir, 'sites'),
      videos: path.join(dir, 'videos'),
      recordings: path.join(dir, 'recordings'),
      logs: path.join(dir, 'logs'),
      credentials: path.join(dir, 'credentials'),
      templates: path.resolve(__dirname, '..', 'templates'),
      public: path.resolve(__dirname, '..', 'public'),
      db: path.join(dir, 'test.sqlite'),
    },
    dashboard: { password: 'test-password', sessionSecret: 'test-secret', sessionTtlHours: 1, cookieName: 'awf_session', allowInsecureCookie: true },
    dryRun: { global: true, ai: true, deploy: true, upload: true, tts: true },
    openrouter: { apiKey: '' },
    youtube: { clientId: '', clientSecret: '', channelId: '' },
    deploy: { provider: 'local', local: { publicBaseUrl: 'http://127.0.0.1:3999/sites' } },
    recording: { allowScreenshotFallback: false, useSparticuz: false, executablePath: '', browserChannel: '' },
    worker: { pollIntervalMs: 50, backoffBaseMs: 20, backoffMaxMs: 200, maxAttempts: 3, stageTimeoutMs: 60000 },
    ...overrides,
  });
  for (const key of ['data', 'sites', 'videos', 'recordings', 'logs', 'credentials']) {
    fs.mkdirSync(config.paths[key], { recursive: true });
  }
  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  return { config, cleanup: () => fs.rmSync(path.dirname(config.paths.db), { recursive: true, force: true }) };
}

function testDb(config) {
  const db = new FactoryDatabase(config.paths.db);
  return db;
}

function silentLogger(db = null) {
  const logger = new Logger({ db, level: 'silent', scope: 'test' });
  return logger;
}

const DEMO_COMMENT = 'I wish someone made a simple meal planner that works offline for a family of four on a tight budget.';

module.exports = { tempDir, testConfig, testDb, silentLogger, DEMO_COMMENT };

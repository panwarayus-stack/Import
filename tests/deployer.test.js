'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Deployer } = require('../src/services/deployer');
const { createZip } = require('../src/lib/zip');
const { startStaticServer } = require('../src/lib/static-server');
const { generateBrief, buildSiteFiles } = require('../src/services/offline-ai');
const { WebsiteBuilder } = require('../src/services/website-builder');
const { testConfig, silentLogger, DEMO_COMMENT } = require('./helpers');

function writeSampleSite(ctx) {
  const brief = generateBrief(DEMO_COMMENT, { author: '@demo' });
  const site = buildSiteFiles(brief, { author: '@demo', comment: DEMO_COMMENT });
  const builder = new WebsiteBuilder(ctx.config, { logger: silentLogger() });
  return builder.writeSite({ siteId: 'site_deploy_test', files: site.files, brief, comment: DEMO_COMMENT });
}

test('local provider returns a labelled preview deployment', async () => {
  const ctx = testConfig();
  const written = writeSampleSite(ctx);
  const deployer = new Deployer(ctx.config, { logger: silentLogger() });
  const result = await deployer.deploy({ siteId: 'site_deploy_test', siteDir: written.dir, brief: { title: 'Demo' } });
  assert.equal(result.provider, 'local');
  assert.equal(result.simulated, true);
  assert.equal(result.verified, false);
  assert.ok(result.url.includes('/sites/site_deploy_test/'));
  assert.match(result.note, /local/i);
  ctx.cleanup();
});

test('github-pages without credentials degrades to a local preview instead of failing', async () => {
  const ctx = testConfig({ deploy: { provider: 'github-pages', github: { token: '', owner: '' } } });
  const written = writeSampleSite(ctx);
  const deployer = new Deployer(ctx.config, { logger: silentLogger() });
  const result = await deployer.deploy({ siteId: 'site_deploy_test', siteDir: written.dir, brief: { title: 'Demo' } });
  assert.equal(result.provider, 'local');
  assert.equal(result.simulated, true);
  ctx.cleanup();
});

test('verification requires a live 200 response', async () => {
  const ctx = testConfig();
  const written = writeSampleSite(ctx);
  const server = await startStaticServer(written.dir, { port: 0, host: '127.0.0.1' });
  const deployer = new Deployer(ctx.config, { logger: silentLogger() });
  try {
    const ok = await deployer.verify(`${server.url}/`, { expectedText: 'Budget', attempts: 2 });
    assert.equal(ok.ok, true);
    const missing = await deployer.verify(`${server.url}/nope.html`, { attempts: 2, timeoutMs: 1500 });
    assert.equal(missing.ok, false);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('zip archives are valid and contain the site files', { skip: !hasPython() }, async () => {
  const ctx = testConfig();
  const written = writeSampleSite(ctx);
  const files = fs.readdirSync(written.dir);
  const zip = createZip(files.map((file) => ({ name: file, data: fs.readFileSync(path.join(written.dir, file)) })));
  const zipPath = path.join(ctx.config.paths.data, 'site.zip');
  fs.writeFileSync(zipPath, zip);
  const listed = execFileSync('python3', ['-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(','.join(sorted(z.namelist())));print(z.testzip() or 'ok')`, zipPath], { encoding: 'utf8' });
  const [names, integrity] = listed.trim().split('\n');
  assert.equal(integrity, 'ok');
  assert.ok(names.split(',').includes('index.html'));
  ctx.cleanup();
});

function hasPython() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

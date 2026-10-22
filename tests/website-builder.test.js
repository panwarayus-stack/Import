'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateSiteFiles, WebsiteBuilder, checkHtml, checkCss, checkJs } = require('../src/services/website-builder');
const { generateBrief, buildSiteFiles } = require('../src/services/offline-ai');
const { testConfig, silentLogger, DEMO_COMMENT } = require('./helpers');

function offlineFiles() {
  const brief = generateBrief(DEMO_COMMENT, { author: '@demo' });
  return { brief, site: buildSiteFiles(brief, { author: '@demo', comment: DEMO_COMMENT }) };
}

const minimal = (indexHtml = '<!DOCTYPE html><html><head><title>T</title><meta name="viewport" content="width=device-width"></head><body><h1>Hello</h1><script src="app.js"></script></body></html>', css = '.a{color:red;}'.repeat(20), js = 'console.log("hi");') => [
  { path: 'index.html', content: indexHtml },
  { path: 'styles.css', content: css },
  { path: 'app.js', content: js },
];

test('offline template produces a valid site', () => {
  const { site } = offlineFiles();
  const result = validateSiteFiles(site.files, testConfig().config);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.files.map((f) => f.path).sort(), ['app.js', 'index.html', 'styles.css']);
  assert.ok(result.files[0].content.includes('<!DOCTYPE html>'));
});

test('rejects path traversal and absolute paths', () => {
  const ctx = testConfig();
  const files = minimal().concat([{ path: '../evil.html', content: '<html></html>' }, { path: '/etc/passwd', content: 'x' }]);
  const result = validateSiteFiles(files, ctx.config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('unsafe path')));
  ctx.cleanup();
});

test('rejects external assets, inline handlers and dangerous JS', () => {
  const cases = [
    ['<script src="https://cdn.example.com/x.js"></script>', 'external script tag'],
    ['<img src="https://example.com/a.png">', 'remote image'],
    ['<button onclick="alert(1)">x</button>', 'inline event handler'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript: URL'],
    ['<iframe src="x"></iframe>', 'iframe'],
  ];
  for (const [snippet, expected] of cases) {
    const html = `<!DOCTYPE html><html><head><title>T</title></head><body><h1>x</h1>${snippet}</body></html>`;
    const result = validateSiteFiles(minimal(html), testConfig().config);
    assert.equal(result.ok, false, `expected rejection for ${expected}`);
    assert.ok(result.errors.some((error) => error.includes(expected)), `missing reason ${expected}: ${result.errors}`);
  }

  const evilJs = validateSiteFiles(minimal(undefined, undefined, 'eval("2+2");'), testConfig().config);
  assert.equal(evilJs.ok, false);
  assert.ok(evilJs.errors.some((e) => e.includes('eval()')));
});

test('detects unbalanced HTML/CSS and invalid JavaScript', () => {
  const errors = [];
  const warnings = [];
  checkHtml('<html><head><title>t</title></head><body><div></body></html>', errors, warnings);
  assert.ok(errors.some((error) => error.includes('mismatched closing tag')));

  const cssErrors = [];
  checkCss('.a { color: red;', cssErrors, []);
  assert.ok(cssErrors.some((error) => error.includes('unclosed')));

  const jsErrors = [];
  checkJs('function ( {', jsErrors);
  assert.ok(jsErrors.some((error) => error.includes('syntax error')));
});

test('detects broken local references and missing required files', () => {
  const html = '<!DOCTYPE html><html><head><title>T</title></head><body><h1>x</h1><a href="about.html">a</a></body></html>';
  const result = validateSiteFiles(minimal(html), testConfig().config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('broken local reference')));

  const missing = validateSiteFiles([{ path: 'index.html', content: '<html><head><title>x</title></head><body><h1>x</h1></body></html>' }], testConfig().config);
  assert.ok(missing.errors.some((error) => error.includes('missing styles.css')));
});

test('enforces per-file and total size limits', () => {
  const ctx = testConfig();
  const huge = minimal(undefined, '.a{color:red;}'.repeat(1) + '/*' + 'x'.repeat(600 * 1024) + '*/');
  const result = validateSiteFiles(huge, ctx.config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('limit')));
  ctx.cleanup();
});

test('writes files inside the site sandbox and reads them back', () => {
  const ctx = testConfig();
  const builder = new WebsiteBuilder(ctx.config, { logger: silentLogger() });
  const { brief, site } = offlineFiles();
  const written = builder.writeSite({ siteId: 'site_test_1', files: site.files, brief, comment: DEMO_COMMENT, meta: { source: 'test' } });
  assert.ok(fs.existsSync(path.join(written.dir, 'index.html')));
  assert.ok(fs.existsSync(path.join(written.siteDir, 'manifest.json')));
  const read = builder.readSiteFiles('site_test_1');
  assert.equal(read.length, 3);
  assert.throws(() => builder.readSiteFiles('../etc'), /invalid site id|escapes/i);

  // Path traversal on write is rejected.
  assert.throws(
    () => builder.writeSite({ siteId: 'site_test_2', files: [{ path: '../../escape.html', content: 'x' }], brief }),
    /path traversal|escapes/i,
  );
  ctx.cleanup();
});

test('offline template has no external requests and real interactions', () => {
  const { site } = offlineFiles();
  const html = site.files.find((f) => f.path === 'index.html').content;
  const js = site.files.find((f) => f.path === 'app.js').content;
  // Only the SVG namespace URI may appear; no fetchable external resources.
  assert.ok(!/<(script|img|link)[^>]+(src|href)=["']https?:/i.test(html));
  const stripped = html.replace(/xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/g, '');
  assert.ok(!/https?:\/\//.test(stripped));
  assert.ok(js.includes("addEventListener('click'"));
  assert.ok(html.includes('aria-expanded'));
  assert.ok(html.includes('prefers-reduced-motion') === false); // that lives in CSS
  const css = site.files.find((f) => f.path === 'styles.css').content;
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('clamp('));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createSessionToken,
  verifySessionToken,
  parseCookies,
  safeEqual,
  RateLimiter,
} = require('../src/lib/auth');
const { resolveWithin, assertSafeRelative, writeFileWithin, listFiles } = require('../src/lib/fs-safe');
const { safeJoin } = require('../src/lib/static-server');
const { extractJson } = require('../src/services/openrouter');
const { scrub } = require('../src/lib/logger');

test('session tokens are signed, expiring and tamper-evident', () => {
  const secret = 'unit-test-secret';
  const token = createSessionToken(secret, 1);
  assert.equal(verifySessionToken(token, secret), true);
  assert.equal(verifySessionToken(token, 'other-secret'), false);
  assert.equal(verifySessionToken(token.slice(0, -2) + 'aa', secret), false);
  assert.equal(verifySessionToken('garbage', secret), false);

  const expired = createSessionToken(secret, -1);
  assert.equal(verifySessionToken(expired, secret), false);
});

test('password comparison is length-safe', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual('', ''), true);
});

test('cookie parsing ignores malformed pairs', () => {
  const cookies = parseCookies('a=1; b=two; broken; c=' + encodeURIComponent('x y'));
  assert.equal(cookies.a, '1');
  assert.equal(cookies.b, 'two');
  assert.equal(cookies.broken, undefined);
  assert.equal(cookies.c, 'x y');
});

test('login rate limiter blocks after the configured number of attempts', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 60000 });
  assert.equal(limiter.check('ip').allowed, true);
  assert.equal(limiter.check('ip').allowed, true);
  assert.equal(limiter.check('ip').allowed, true);
  const blocked = limiter.check('ip');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.check('other-ip').allowed, true);
});

test('filesystem helpers reject traversal, absolute paths and symlink escapes', () => {
  assert.throws(() => assertSafeRelative('../etc/passwd'), /traversal/i);
  assert.throws(() => assertSafeRelative('/etc/passwd'), /absolute/i);
  assert.throws(() => assertSafeRelative('a/../../b'), /traversal/i);
  assert.throws(() => assertSafeRelative('C:\\Windows\\system32'), /drive|traversal|absolute/i);
  assert.throws(() => resolveWithin('/tmp/base', '../../x'), /traversal/i);
  assert.equal(resolveWithin('/tmp/base', 'nested/file.css'), '/tmp/base/nested/file.css');
});

test('writeFileWithin enforces size limits and never writes outside the base', () => {
  const base = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'awf-fs-'));
  try {
    const written = writeFileWithin(base, 'ok/file.txt', 'hello', { maxBytes: 100 });
    assert.ok(written.path.startsWith(base));
    assert.throws(() => writeFileWithin(base, 'big.txt', 'x'.repeat(200), { maxBytes: 100 }), /limit/);
    assert.throws(() => writeFileWithin(base, '../escape.txt', 'x'), /traversal/);
    const listing = listFiles(base, { maxFiles: 10, maxBytes: 1000 });
    assert.equal(listing.files.length, 1);
  } finally {
    require('node:fs').rmSync(base, { recursive: true, force: true });
  }
});

test('static server path resolution refuses traversal and null bytes', () => {
  const root = path.resolve('/tmp/root');
  assert.equal(safeJoin(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(safeJoin(root, '/../../etc/passwd'), null);
  assert.equal(safeJoin(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(safeJoin(root, '/a%00b'), null);
});

test('AI JSON extraction tolerates fences, prose and trailing commas', () => {
  const fenced = extractJson('Here you go:\n```json\n{"a": 1, "b": [1,2,]}\n```\nThanks');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.a, 1);
  assert.equal(extractJson('not json at all').ok, false);
  assert.equal(extractJson('{"a": ').ok, false);
});

test('logger scrubs API keys and tokens', () => {
  const scrubbed = scrub('key=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and ghp_abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz');
  assert.ok(!scrubbed.includes('sk-or-v1-aaaa'));
  assert.ok(!scrubbed.includes('ghp_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(scrubbed.includes('***'));
});

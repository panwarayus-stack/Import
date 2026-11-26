'use strict';

/**
 * Tests for the Telegram corpus API layer.
 *
 * These are deterministic and do not require network access: `buildManifest`
 * falls back to the bundled seed manifest when Hugging Face is unreachable
 * (which it is from this sandbox).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  buildManifest,
  searchableSources,
  normalizeEntry,
  BUCKETS,
  DUPLICATE_BUCKETS,
} = require('../src/lib/telegram/sources');
const { pickTextColumns } = require('../src/lib/telegram/search');
const { createTelegramRouter } = require('../src/routes/telegram');

test('buildManifest (seed fallback) returns the de-duplicated inventory', async () => {
  const manifest = await buildManifest({ preferLive: false });
  assert.strictEqual(manifest.source, 'seed');
  assert.ok(manifest.totalUniqueFiles > 0);
  assert.ok(manifest.totalSizeBytes > 0);
  // Tgdata-bucket-fulltelegram must not appear as its own bucket (it's a duplicate).
  assert.ok(!manifest.buckets.includes('Tgdata-bucket-fulltelegram'));
  assert.ok(manifest.duplicateBuckets.some((d) => d.bucket === 'Tgdata-bucket-fulltelegram'));
  // No duplicate xetHash across returned file sources.
  const hashes = manifest.sources
    .filter((s) => s.xetHash)
    .map((s) => s.xetHash);
  assert.strictEqual(hashes.length, new Set(hashes).size);
  // Every file has bucket + path.
  for (const s of manifest.sources) {
    assert.ok(s.bucket && s.path);
    assert.ok(['parquet', 'db', 'directory', 'file'].includes(s.type));
  }
});

test('buildManifest deduplicates across buckets by xetHash', async () => {
  const manifest = await buildManifest({ preferLive: false });
  // The same xetHash must not appear in two listed sources.
  const hashes = manifest.sources.filter((s) => s.xetHash).map((s) => s.xetHash);
  assert.strictEqual(hashes.length, new Set(hashes).size);
  // MergedTgfulldatabase's TELEGRAM_MASTER_DB.parquet duplicates Tgdata-bucket's:
  // it is skipped from sources and recorded in duplicatesSkipped.
  assert.ok(
    manifest.sources.every(
      (s) => !(s.bucket === 'MergedTgfulldatabase' && s.path === 'TELEGRAM_MASTER_DB.parquet'),
    ),
    'duplicate file should not be listed as a separate source',
  );
  assert.ok(
    manifest.duplicatesSkipped.some(
      (d) => d.bucket === 'MergedTgfulldatabase' && d.path === 'TELEGRAM_MASTER_DB.parquet',
    ),
    'duplicate should be recorded in duplicatesSkipped',
  );
});

test('searchableSources excludes directories and non-searchable entries', () => {
  const manifest = { sources: [
    { bucket: 'A', path: 'a.parquet', type: 'parquet', searchable: true, needsExpansion: false },
    { bucket: 'A', path: 'b.db', type: 'db', searchable: true, needsExpansion: false },
    { bucket: 'A', path: 'dir', type: 'directory', searchable: false, needsExpansion: true },
  ] };
  const s = searchableSources(manifest);
  assert.strictEqual(s.length, 2);
  assert.ok(s.every((x) => x.searchable && !x.needsExpansion));
});

test('normalizeEntry marks parquet and db correctly', () => {
  const pq = normalizeEntry({ path: 'data.parquet', size: 100, xetHash: 'abc' }, { bucket: 'Tg-num' });
  assert.strictEqual(pq.type, 'parquet');
  assert.strictEqual(pq.bucket, 'Tg-num');
  assert.ok(pq.downloadUrl.includes('/resolve/data.parquet'));
  const db = normalizeEntry({ path: 'x.db', size: 200, xetHash: 'def' }, { bucket: 'Telegram-bucket' });
  assert.strictEqual(db.type, 'db');
});

test('configured buckets omit the full-duplicate bucket', () => {
  const names = BUCKETS.map((b) => b.name);
  assert.ok(!names.includes('Tgdata-bucket-fulltelegram'));
  assert.ok(names.includes('Tgdata-bucket'));
  assert.ok(names.includes('media-monitoring-telegram-bucket'));
});

test('DUPLICATE_BUCKETS marks Tgdata-bucket-fulltelegram as duplicate', () => {
  assert.strictEqual(DUPLICATE_BUCKETS['Tgdata-bucket-fulltelegram'], 'Tgdata-bucket');
});

test('pickTextColumns selects text-like columns', () => {
  assert.deepStrictEqual(
    pickTextColumns(['message_id', 'text', 'channel_id', 'published_at', 'username']),
    ['message_id', 'text', 'channel_id', 'username'],
  );
  assert.deepStrictEqual(pickTextColumns(['id', 'ts', 'n']), []);
});

test('createTelegramRouter mounts health, sources, stats, search', async () => {
  const app = express();
  app.use(express.json());
  // Stub auth so we can hit the routes directly in a test.
  app.use((_req, _res, next) => next());
  app.use('/api/telegram', createTelegramRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const get = (path) =>
    fetch(`${base}${path}`, { redirect: 'manual' }).then((r) => r.json());

  const health = await get('/api/telegram/health');
  assert.strictEqual(health.ok, true);
  assert.ok(typeof health.hfReachable === 'boolean');
  assert.ok(typeof health.drivers.duckdb === 'boolean');

  const sources = await get('/api/telegram/sources');
  assert.strictEqual(sources.ok, true);
  assert.ok(sources.totalUniqueFiles > 0);

  const stats = await get('/api/telegram/stats');
  assert.strictEqual(stats.ok, true);
  assert.ok(stats.byType.parquet >= 1);
  assert.ok(stats.byType.db >= 1);

  const search = await get('/api/telegram/search?q=test&limit=3');
  assert.strictEqual(search.ok, true);
  assert.strictEqual(search.query, 'test');
  assert.ok(Array.isArray(search.results));
  assert.ok(Array.isArray(search.sources));

  await new Promise((resolve) => server.close(resolve));
});

test('search requires a q parameter', async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => next());
  app.use('/api/telegram', createTelegramRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/telegram/search`, { redirect: 'manual' });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
  await new Promise((resolve) => server.close(resolve));
});

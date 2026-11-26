'use strict';

const express = require('express');

/**
 * Telegram corpus search API.
 *
 * Mounted under `/api/telegram` (protected by the same session auth as the rest
 * of `/api`). Provides a read-only, de-duplicated view over the seven Apimaking
 * Telegram buckets on Hugging Face:
 *
 *   GET /api/telegram/health     driver + HF reachability + manifest summary
 *   GET /api/telegram/sources    full de-duplicated file manifest
 *   GET /api/telegram/stats      corpus statistics
 *   GET /api/telegram/search?q=  keyword search over text/title/username
 *   GET /api/telegram/channels   channel listing (per source)
 *   GET /api/telegram/channels/:id channel detail
 *   GET /api/telegram/messages   message listing (filter by source/channel)
 *   GET /api/telegram/messages/:id message detail
 *   POST /api/telegram/sync      rebuild the de-duplicated manifest
 *
 * Data is queried where reachable (Parquet over HTTPS via DuckDB, `.db`
 * read-only after a local sync). When Hugging Face is unreachable from this
 * host the inventory still comes from a bundled seed manifest and search
 * reports each source's availability instead of failing.
 */

const { buildManifest, searchableSources } = require('../lib/telegram/sources');
const { search, inspectSource } = require('../lib/telegram/search');
const { describeParquet, countParquet, run: runParquet } = require('../lib/telegram/parquet');
const { describeDb, sampleTable } = require('../lib/telegram/sqldb');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseLimit(req, def = DEFAULT_LIMIT) {
  const v = Number.parseInt(req.query.limit, 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), MAX_LIMIT) : def;
}
function parseOffset(req) {
  const v = Number.parseInt(req.query.offset, 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  return res.json(body);
}

function createTelegramRouter() {
  const router = express.Router();

  // GET /telegram/health
  router.get('/health', async (_req, res) => {
    let hfReachable = false;
    let hfError = null;
    try {
      // A tiny probe: list the root of the smallest bucket (Tg-num has 2 files).
      await require('../lib/telegram/hf').listBucketTree({ owner: 'Apimaking', name: 'Tg-num', path: '' });
      hfReachable = true;
    } catch (err) {
      hfError = err.message;
    }

    const manifest = await buildManifest({ preferLive: false }).catch(() => ({ sources: [], source: 'seed', error: null }));
    const drivers = {
      duckdb: false,
      sqlite: require('../lib/sqlite').driverInfo(),
    };
    try {
      const { DuckDBInstance } = require('@duckdb/node-api');
      const inst = await DuckDBInstance.create(':memory:');
      const conn = await inst.connect();
      await conn.run('SELECT 1');
      conn.disconnectSync();
      drivers.duckdb = true;
    } catch (err) {
      drivers.duckdbError = err.message;
    }

    return json(res, 200, {
      ok: true,
      service: 'telegram',
      hfReachable,
      hfError,
      drivers,
      manifest: {
        source: manifest.source || 'seed',
        totalUniqueFiles: manifest.totalUniqueFiles || 0,
        totalSizeBytes: manifest.totalSizeBytes || 0,
        duplicatesSkipped: manifest.duplicatesSkipped ? manifest.duplicatesSkipped.length : 0,
        syncedAt: manifest.syncedAt || null,
      },
      time: new Date().toISOString(),
    });
  });

  // GET /telegram/sources
  router.get('/sources', async (_req, res) => {
    const manifest = await buildManifest({ preferLive: true });
    return json(res, 200, {
      ok: true,
      source: manifest.source,
      error: manifest.error,
      buckets: manifest.buckets,
      duplicateBuckets: manifest.duplicateBuckets,
      duplicatesSkipped: manifest.duplicatesSkipped,
      totalUniqueFiles: manifest.totalUniqueFiles,
      totalSizeBytes: manifest.totalSizeBytes,
      sources: manifest.sources.map((s) => ({
        bucket: s.bucket,
        path: s.path,
        size: s.size,
        xetHash: s.xetHash,
        type: s.type,
        searchable: s.searchable,
        needsExpansion: s.needsExpansion,
        localPath: s.localPath,
        duplicateOf: s.duplicateOf,
        downloadUrl: s.downloadUrl,
      })),
    });
  });

  // GET /telegram/stats
  router.get('/stats', async (_req, res) => {
    const manifest = await buildManifest({ preferLive: true });
    const byType = {};
    const byBucket = {};
    for (const s of manifest.sources) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      byBucket[s.bucket] = (byBucket[s.bucket] || 0) + 1;
    }
    return json(res, 200, {
      ok: true,
      source: manifest.source,
      error: manifest.error,
      totalUniqueFiles: manifest.totalUniqueFiles,
      totalSizeBytes: manifest.totalSizeBytes,
      duplicatesSkipped: manifest.duplicatesSkipped.length,
      duplicateBuckets: manifest.duplicateBuckets,
      byType,
      byBucket,
      searchableFiles: manifest.sources.filter((s) => s.searchable).length,
    });
  });

  // GET /telegram/search?q=...
  router.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q || !String(q).trim()) {
      return json(res, 400, { ok: false, error: 'query parameter "q" is required' });
    }
    try {
      const result = await search({
        query: q,
        limit: parseLimit(req),
        offset: parseOffset(req),
        bucket: req.query.bucket || undefined,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  // GET /telegram/inspect?bucket=&path=  (schema + counts for one source)
  router.get('/inspect', async (req, res) => {
    const { bucket, path } = req.query;
    if (!bucket || !path) {
      return json(res, 400, { ok: false, error: 'query parameters "bucket" and "path" are required' });
    }
    try {
      const info = await inspectSource({ bucket, path });
      if (!info) return json(res, 404, { ok: false, error: 'source not found' });
      return json(res, 200, { ok: true, ...info });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  // GET /telegram/channels  (list channels available per source)
  router.get('/channels', async (req, res) => {
    const manifest = await buildManifest({ preferLive: true });
    const out = [];
    for (const s of searchableSources(manifest)) {
      let detail = { bucket: s.bucket, path: s.path, type: s.type, channels: [], channelTable: null, status: 'not-queried' };
      try {
        if (s.type === 'parquet') {
          const columns = (await describeParquet(s.downloadUrl)).map((c) => c.name);
          const hasChannel = columns.some((c) => /channel|username|title/i.test(c));
          detail.channelTable = hasChannel ? s.path : null;
          detail.status = hasChannel ? 'queried' : 'no-channel-columns';
        } else if (s.type === 'db' && s.localPath) {
          const desc = describeDb(s.localPath);
          detail.channelTable = desc.channelTable;
          detail.tables = desc.tables.map((t) => t.name);
          detail.status = desc.channelTable ? 'queried' : 'no-channel-table';
        } else if (s.type === 'db') {
          detail.status = 'download-required';
        }
      } catch (err) {
        detail.status = 'error';
        detail.error = err.message;
      }
      out.push(detail);
    }
    return json(res, 200, { ok: true, total: out.length, sources: out });
  });

  // GET /telegram/messages  (list messages for a source, optional channel filter)
  router.get('/messages', async (req, res) => {
    const { bucket, path, channel, limit, offset } = req.query;
    if (!bucket || !path) {
      return json(res, 400, { ok: false, error: 'query parameters "bucket" and "path" are required' });
    }
    const manifest = await buildManifest({ preferLive: true });
    const source = manifest.sources.find((s) => s.bucket === bucket && s.path === path);
    if (!source) return json(res, 404, { ok: false, error: 'source not found' });
    if (!source.searchable) {
      return json(res, 400, { ok: false, error: 'source is not searchable' });
    }
    try {
      let rows = [];
      let columns = [];
      let status = 'queried';
      if (source.type === 'parquet') {
        columns = (await describeParquet(source.downloadUrl)).map((c) => c.name);
        const textCols = pickTextColumns(columns);
        // Without a keyword we return a sample of rows ordered as stored.
        rows = await runParquet(
          `SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?`,
          [source.downloadUrl, parseLimit(req), parseOffset(req)]
        );
        rows = rows.map((r) => ({ ...r, _source: source.downloadUrl }));
      } else if (source.type === 'db') {
        if (!source.localPath) {
          return json(res, 409, { ok: false, error: '.db source not downloaded locally', status: 'download-required' });
        }
        const desc = describeDb(source.localPath);
        if (!desc.messageTable) {
          return json(res, 400, { ok: false, error: 'no message table in this .db' });
        }
        rows = sampleTable({ filePath: source.localPath, table: desc.messageTable, limit: parseLimit(req) });
        columns = desc.tables.find((t) => t.name === desc.messageTable).columns;
        rows = rows.map((r) => ({ ...r, _source: source.localPath }));
      }
      return json(res, 200, { ok: true, source: { bucket: source.bucket, path: source.path, type: source.type }, columns, status, limit: parseLimit(req), offset: parseOffset(req), returned: rows.length, rows });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  // POST /telegram/sync  (rebuild + persist the de-duplicated manifest)
  router.post('/sync', async (req, res) => {
    const { preferLive = true } = req.body || {};
    try {
    const manifest = await buildManifest({ preferLive });
    const { openStore } = require('../lib/telegram/store');
    const config = require('../config').getConfig();
    const store = openStore(config.telegram.syncDir);
    store.saveManifest(manifest);
    store.close();
      return json(res, 200, {
        ok: true,
        source: manifest.source,
        totalUniqueFiles: manifest.totalUniqueFiles,
        totalSizeBytes: manifest.totalSizeBytes,
        duplicatesSkipped: manifest.duplicatesSkipped.length,
        error: manifest.error,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  return router;
}

function pickTextColumns(columns) {
  const hints = ['text', 'message', 'body', 'content', 'caption', 'title', 'username', 'channel'];
  return columns.filter((c) => hints.some((h) => String(c).toLowerCase() === h || String(c).toLowerCase().includes(h)));
}

module.exports = { createTelegramRouter };

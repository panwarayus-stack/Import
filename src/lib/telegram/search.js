'use strict';

/**
 * Cross-source search over the de-duplicated Telegram corpus.
 *
 * Iterates the searchable sources (parquet + .db) and runs a keyword match
 * against text-like columns. Each source is queried independently so a single
 * unreachable or unreadable source never kills the whole search.
 *
 * Data locality:
 *   - Parquet: queried via DuckDB `read_parquet(url)` — works over HTTPS on a
 *     host that reaches Hugging Face, or from a local file after sync.
 *   - `.db`: opened read-only with node:sqlite/better-sqlite3 — requires a
 *     local file path (remote `.db` cannot be opened over HTTP).
 *
 * Sources that cannot be queried are reported per-source with a `status`
 * so the caller knows exactly what was searched and what was skipped.
 */

const { buildManifest, searchableSources } = require('./sources');
const { describeParquet, searchParquet, countParquet } = require('./parquet');
const { describeDb, searchDb } = require('./sqldb');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Column-name hints that indicate a text column worth searching. */
const TEXT_HINTS = ['text', 'message', 'body', 'content', 'caption', 'title', 'username', 'channel'];

/**
 * Pick text-like columns from a schema descriptor.
 */
function pickTextColumns(columns) {
  const hits = [];
  for (const col of columns) {
    const name = String(col).toLowerCase();
    if (TEXT_HINTS.some((h) => name === h || name.includes(h))) hits.push(col);
  }
  return hits;
}

/**
 * Search one Parquet source. Returns { status, rows, columns, error }.
 */
async function searchParquetSource({ source, query, limit, offset }) {
  const result = { status: 'queried', rows: [], columns: [], error: null };
  try {
    let columns = [];
    try {
      columns = (await describeParquet(source.downloadUrl)).map((c) => c.name);
    } catch (err) {
      result.status = 'unreachable';
      result.error = `schema inspection failed: ${err.message}`;
      return result;
    }
    const textCols = pickTextColumns(columns);
    if (!textCols.length) {
      result.status = 'nosearchable';
      result.error = 'no text-like columns found';
      return result;
    }
    result.columns = textCols;
    result.rows = await searchParquet({
      source: source.downloadUrl,
      query,
      textColumns: textCols,
      limit,
      offset,
    });
    return result;
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
    return result;
  }
}

/**
 * Search one `.db` source. Requires a localPath.
 */
function searchDbSource({ source, query, limit, offset }) {
  const result = { status: 'queried', rows: [], columns: [], error: null };
  if (!source.localPath) {
    result.status = 'download-required';
    result.error = '.db file not downloaded locally; run sync on a host with HF access';
    return result;
  }
  try {
    let desc;
    try { desc = describeDb(source.localPath); } catch (err) {
      result.status = 'error';
      result.error = `inspection failed: ${err.message}`;
      return result;
    }
    const messageTable = desc.messageTable;
    if (!messageTable) {
      result.status = 'notable';
      result.error = 'no message-like table found';
      return result;
    }
    const table = desc.tables.find((t) => t.name === messageTable);
    const textCols = (table && table.textColumn ? [table.textColumn] : [])
      .filter(Boolean);
    if (!textCols.length) {
      result.status = 'nosearchable';
      result.error = 'no text-like column in message table';
      return result;
    }
    result.columns = textCols;
    result.rows = searchDb({
      filePath: source.localPath,
      table: messageTable,
      textColumns: textCols,
      query,
      limit,
      offset,
    });
    return result;
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
    return result;
  }
}

/**
 * Run a keyword search across the de-duplicated corpus.
 *
 * Returns { query, total, limit, offset, sources: [...], results: [...] }
 * where `results` are merged (capped at limit) and each row is annotated with
 * _bucket, _path, _type.
 */
async function search({ query, limit = DEFAULT_LIMIT, offset = 0, bucket } = {}) {
  if (!query || !String(query).trim()) {
    throw new Error('query parameter "q" is required');
  }
  const q = String(query).trim();
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const off = Math.max(Number.parseInt(offset, 10) || 0, 0);

  const manifest = await buildManifest({ preferLive: true });
  const sources = searchableSources(manifest).filter((s) =>
    !bucket || s.bucket === bucket
  );

  const perSource = [];
  const merged = [];

  for (const source of sources) {
    let sourceResult;
    if (source.type === 'parquet') {
      sourceResult = await searchParquetSource({ source, query: q, limit: lim, offset: off });
    } else if (source.type === 'db') {
      sourceResult = searchDbSource({ source, query: q, limit: lim, offset: off });
    } else {
      sourceResult = { status: 'skipped', rows: [], columns: [], error: `unsupported type ${source.type}` };
    }
    perSource.push({
      bucket: source.bucket,
      path: source.path,
      type: source.type,
      status: sourceResult.status,
      error: sourceResult.error || null,
      columns: sourceResult.columns,
      rowCount: sourceResult.rows.length,
    });
    for (const row of sourceResult.rows) {
      merged.push({
        ...row,
        _bucket: source.bucket,
        _path: source.path,
        _type: source.type,
        _source: source.downloadUrl || source.localPath,
      });
      if (merged.length >= lim + off) break; // enough to slice
    }
    if (merged.length >= lim + off) break;
  }

  // Apply offset across the merged stream.
  const page = merged.slice(off, off + lim);

  return {
    query,
    total: merged.length,
    limit: lim,
    offset: off,
    returned: page.length,
    sources: perSource,
    results: page,
    manifestSource: manifest.source,
    manifestError: manifest.error,
  };
}

/**
 * Get a summary of a single source (schema + counts) for inspection.
 */
async function inspectSource({ bucket, path }) {
  const manifest = await buildManifest({ preferLive: true });
  const source = manifest.sources.find((s) => s.bucket === bucket && s.path === path);
  if (!source) return null;
  const out = { bucket: source.bucket, path: source.path, type: source.type, size: source.size, xetHash: source.xetHash };
  try {
    if (source.type === 'parquet') {
      out.columns = await describeParquet(source.downloadUrl);
      out.rowCount = await countParquet(source.downloadUrl);
    } else if (source.type === 'db' && source.localPath) {
      const desc = describeDb(source.localPath);
      out.driver = desc.driver;
      out.tables = desc.tables;
      out.messageTable = desc.messageTable;
      out.channelTable = desc.channelTable;
    } else if (source.type === 'db') {
      out.status = 'download-required';
    }
  } catch (err) {
    out.error = err.message;
    out.status = 'error';
  }
  return out;
}

module.exports = { search, inspectSource, pickTextColumns, searchParquetSource, searchDbSource, DEFAULT_LIMIT, MAX_LIMIT };

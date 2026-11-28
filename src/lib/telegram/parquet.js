'use strict';

/**
 * Parquet reader for Telegram corpus files.
 *
 * Uses `@duckdb/node-api`. Parquet is built into DuckDB, so local files are
 * queried without any network access. Remote `https://` URLs require the
 * httpfs extension, which is only attempted (and lazily) for remote sources;
 * on a host without network (like this sandbox) remote sources degrade to an
 * "unreachable" status instead of crashing the whole search.
 */

const { DuckDBInstance } = require('@duckdb/node-api');

let instance = null;
let httpfsLoaded = false;

/**
 * Lazily create a single in-memory DuckDB instance. No extensions are forced
 * here (that would require network access to the extension repository).
 */
async function getInstance() {
  if (!instance) {
    instance = await DuckDBInstance.create(':memory:');
  }
  return instance;
}

/**
 * Ensure the httpfs extension is available (only meaningful for remote URLs).
 * Returns true if loaded, false if network/extension unavailable.
 */
async function ensureHttpfs() {
  if (httpfsLoaded) return true;
  const inst = await getInstance();
  const conn = await inst.connect();
  try {
    await conn.run('LOAD httpfs;');
    httpfsLoaded = true;
    return true;
  } catch {
    httpfsLoaded = false;
    return false;
  } finally {
    conn.disconnectSync();
  }
}

/**
 * Run SQL against an in-memory DuckDB and return rows as plain objects.
 * `params` are bound positionally ($1, $2, ...).
 */
async function run(sql, params = []) {
  const inst = await getInstance();
  const conn = await inst.connect();
  try {
    let result;
    if (params.length) {
      const prepared = await conn.prepare(sql);
      for (let i = 0; i < params.length; i += 1) {
        const value = params[i];
        if (value === null || value === undefined) prepared.bindNull(i + 1);
        else if (typeof value === 'string') prepared.bindVarchar(i + 1, value);
        else if (typeof value === 'number') prepared.bindInteger(i + 1, value);
        else if (typeof value === 'bigint') prepared.bindBigInt(i + 1, value);
        else if (Buffer.isBuffer(value)) prepared.bindBlob(i + 1, value);
        else prepared.bindVarchar(i + 1, String(value));
      }
      result = await prepared.runAndReadAll();
    } else {
      result = await conn.runAndReadAll(sql);
    }
    return result.getRowObjects();
  } finally {
    conn.disconnectSync();
  }
}

/**
 * Describe the schema of a Parquet file (local path or https URL).
 * Returns [{ name, type }].
 */
async function describeParquet(source) {
  if (/^https?:\/\//i.test(source)) {
    if (!(await ensureHttpfs())) {
      throw new Error('httpfs extension unavailable (no network to extension repository)');
    }
  }
  const rows = await run(`DESCRIBE SELECT * FROM read_parquet(?)`, [source]);
  return rows.map((r) => ({ name: r.column_name, type: r.data_type }));
}

/**
 * Count rows in a Parquet file.
 */
async function countParquet(source) {
  if (/^https?:\/\//i.test(source)) {
    if (!(await ensureHttpfs())) {
      throw new Error('httpfs extension unavailable (no network to extension repository)');
    }
  }
  const rows = await run(`SELECT COUNT(*) AS n FROM read_parquet(?)`, [source]);
  return Number(rows[0]?.n || 0);
}

/**
 * Search a Parquet file for a keyword across text-like columns.
 * Returns rows with an added `_source` field.
 */
async function searchParquet({ source, query, textColumns = [], limit = 50, offset = 0 } = {}) {
  if (/^https?:\/\//i.test(source)) {
    if (!(await ensureHttpfs())) {
      throw new Error('httpfs extension unavailable (no network to extension repository)');
    }
  }
  const like = `%${String(query)}%`;
  let sql;
  const params = [];
  if (textColumns.length) {
    const conditions = textColumns.map((c) => {
      params.push(like);
      return `LOWER(CAST("${c}" AS VARCHAR)) LIKE LOWER(?)`;
    }).join(' OR ');
    params.unshift(like, source); // _source param + source param
    sql = `SELECT *, ? AS _source FROM read_parquet(?) WHERE ${conditions} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  } else {
    sql = `SELECT *, ? AS _source FROM read_parquet(?) LIMIT ? OFFSET ?`;
    params.push(like, source, limit, offset);
  }
  return run(sql, params);
}

/**
 * Fetch a sample of rows from a Parquet file (for schema preview / inspection).
 */
async function sampleParquet(source, { limit = 5 } = {}) {
  return run(`SELECT * FROM read_parquet(?) LIMIT ?`, [source, limit]);
}

async function close() {
  if (instance) {
    try { instance.closeSync(); } catch { /* ignore */ }
    instance = null;
  }
  httpfsLoaded = false;
}

module.exports = { getInstance, run, describeParquet, countParquet, searchParquet, sampleParquet, close, ensureHttpfs };

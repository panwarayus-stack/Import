'use strict';

/**
 * Read-only SQLite reader for Telegram `.db` corpus files.
 *
 * Opens each `.db` read-only (never writes, never creates sidecar files) so
 * multi-gigabyte databases can be inspected in place after a sync. Uses the
 * repo's driver preference (better-sqlite3, falling back to node:sqlite) but
 * forces `readonly: true`.
 *
 * Schemas are unknown until inspected, so this layer auto-discovers tables
 * and columns and normalizes them to a common channel/message shape.
 */

const { openSqlite } = require('../sqlite');

/** Columns we try to map, in priority order, when normalizing a table. */
const CHANNEL_ID_CANDIDATES = ['channel_id', 'channelid', 'channel', 'chat_id', 'chatid'];
const MESSAGE_ID_CANDIDATES = ['message_id', 'messageid', 'id', 'msg_id'];
const TEXT_CANDIDATES = ['text', 'message', 'body', 'content', 'caption'];
const TIMESTAMP_CANDIDATES = ['published_at', 'posted_at', 'date', 'timestamp', 'created_at', 'time'];
const USERNAME_CANDIDATES = ['username', 'channel_username', 'handle'];
const TITLE_CANDIDATES = ['title', 'channel_title', 'name'];

function firstMatch(columns, candidates) {
  const lower = new Set(columns.map((c) => String(c).toLowerCase()));
  for (const cand of candidates) if (lower.has(cand.toLowerCase())) return cand;
  return null;
}

function openReadOnly(filePath) {
  let nativeDriver;
  try {
    // eslint-disable-next-line global-require
    nativeDriver = require('better-sqlite3');
  } catch {
    /* fall through to node:sqlite */
  }
  if (nativeDriver) {
    const raw = new nativeDriver(filePath, { readonly: true });
    return {
      driver: 'better-sqlite3',
      raw,
      exec(sql) { raw.exec(sql); return this; },
      prepare(sql) { return raw.prepare(sql); },
      transaction(fn) { return raw.transaction(fn); },
      close() { raw.close(); },
      get open() { return raw.open; },
    };
  }
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(filePath, { readonly: true });
  return {
    driver: 'node:sqlite',
    raw,
    exec(sql) { raw.exec(sql); return this; },
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        raw: statement,
      };
    },
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          try { raw.exec('ROLLBACK'); } catch { /* ignore */ }
          throw error;
        }
      };
    },
    close() { raw.close(); },
    get open() { return true; },
  };
}

/**
 * List tables in a `.db` file: [{ name, sql }].
 */
function listTables(db) {
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all();
  return rows;
}

/**
 * Get column info for a table via PRAGMA table_info.
 * Returns [{ name, type, notnull, default_value, pk }].
 */
function tableInfo(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  return rows;
}

/**
 * Estimate row count for a table.
 */
function countTable(db, tableName) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}"`).get();
  return Number(row?.n || 0);
}

/**
 * Inspect a `.db` file: tables, columns, row counts, and detected channel/message
 * mapping. Returns a descriptor the API can use to build queries.
 */
function describeDb(filePath) {
  const db = openReadOnly(filePath);
  try {
    const tables = listTables(db);
    const result = {
      driver: db.driver,
      path: filePath,
      tables: [],
      channelTable: null,
      messageTable: null,
      mapping: {},
    };
    for (const table of tables) {
      const columns = tableInfo(db, table.name).map((c) => c.name);
      const colNames = columns;
      const info = {
        name: table.name,
        columns: colNames,
        rowCount: countTable(db, table.name),
        sql: table.sql || null,
        channelIdColumn: firstMatch(colNames, CHANNEL_ID_CANDIDATES),
        messageIdColumn: firstMatch(colNames, MESSAGE_ID_CANDIDATES),
        textColumn: firstMatch(colNames, TEXT_CANDIDATES),
        timestampColumn: firstMatch(colNames, TIMESTAMP_CANDIDATES),
        usernameColumn: firstMatch(colNames, USERNAME_CANDIDATES),
        titleColumn: firstMatch(colNames, TITLE_CANDIDATES),
      };
      result.tables.push(info);
      // Heuristic: a table with both channel_id and message_id + text is a message table.
      if (info.messageIdColumn && info.textColumn) {
        if (!result.messageTable) result.messageTable = info.name;
      } else if (info.titleColumn && !info.messageIdColumn) {
        if (!result.channelTable) result.channelTable = info.name;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * Search a `.db` message table for a keyword across text-like columns.
 * Returns rows (plain objects) limited by `limit`.
 */
function searchDb({ filePath, table, textColumns, query, limit = 50, offset = 0 } = {}) {
  const db = openReadOnly(filePath);
  try {
    const like = `%${String(query)}%`;
    const conditions = textColumns.map((c) => `LOWER(CAST("${c}" AS TEXT)) LIKE LOWER(?)`).join(' OR ');
    const params = textColumns.map(() => like);
    const sql = `SELECT * FROM "${table}" WHERE ${conditions} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit, offset);
    return rows.map((r) => ({ ...r, _source: filePath }));
  } finally {
    db.close();
  }
}

/**
 * Fetch a sample of rows from a table.
 */
function sampleTable({ filePath, table, limit = 5 } = {}) {
  const db = openReadOnly(filePath);
  try {
    return db.prepare(`SELECT * FROM "${table}" LIMIT ?`).all(limit);
  } finally {
    db.close();
  }
}

module.exports = { openReadOnly, listTables, tableInfo, countTable, describeDb, searchDb, sampleTable, firstMatch };

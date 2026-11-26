'use strict';

/**
 * Local persistence for the Telegram corpus manifest.
 *
 * Kept in a separate SQLite file (`data/telegram/manifest.sqlite`) so the
 * factory database is never touched. Stores:
 *   - telegram_sources: the de-duplicated file inventory (by xetHash)
 *   - telegram_sync_log: when sync ran, source (live|seed), counts, errors
 */

const fs = require('node:fs');
const path = require('node:path');
const { openSqlite } = require('../sqlite');

const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS telegram_sources (
    bucket TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    xetHash TEXT,
    type TEXT NOT NULL,
    downloadUrl TEXT,
    needsExpansion INTEGER NOT NULL DEFAULT 0,
    searchable INTEGER NOT NULL DEFAULT 0,
    localPath TEXT,
    duplicateOf TEXT,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (bucket, path)
  );
  CREATE TABLE IF NOT EXISTS telegram_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ranAt TEXT NOT NULL,
    source TEXT NOT NULL,          -- 'live' | 'seed'
    totalUniqueFiles INTEGER NOT NULL,
    totalSizeBytes INTEGER NOT NULL,
    duplicatesSkipped INTEGER NOT NULL,
    buckets TEXT NOT NULL,         -- JSON array
    error TEXT
  );
`;

class TelegramStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openSqlite(this.filePath);
    this.db.exec(MIGRATIONS);
    return this;
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  /** Replace the manifest with a fresh build result. */
  saveManifest({ sources, buckets, duplicatesSkipped, source, error, totalUniqueFiles, totalSizeBytes }) {
    const db = this.db;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM telegram_sources').run();
      const insert = db.prepare(
        `INSERT INTO telegram_sources
          (bucket, path, size, xetHash, type, downloadUrl, needsExpansion, searchable, localPath, duplicateOf, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of sources) {
        insert.run(
          s.bucket, s.path, s.size || null, s.xetHash || null, s.type,
          s.downloadUrl || null, s.needsExpansion ? 1 : 0, s.searchable ? 1 : 0,
          s.localPath || null, s.duplicateOf || null, now,
        );
      }
      db.prepare(
        `INSERT INTO telegram_sync_log
          (ranAt, source, totalUniqueFiles, totalSizeBytes, duplicatesSkipped, buckets, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        now, source, totalUniqueFiles, totalSizeBytes, duplicatesSkipped.length,
        JSON.stringify(buckets), error ? JSON.stringify(error) : null,
      );
    });
    tx();
    return this.getManifest();
  }

  /** Load the last saved manifest. */
  getManifest() {
    const db = this.db;
    const sources = db.prepare('SELECT * FROM telegram_sources ORDER BY bucket, path').all();
    const log = db.prepare('SELECT * FROM telegram_sync_log ORDER BY ranAt DESC LIMIT 1').get();
    return {
      sources: sources.map((s) => ({
        bucket: s.bucket,
        path: s.path,
        size: s.size,
        xetHash: s.xetHash,
        type: s.type,
        downloadUrl: s.downloadUrl,
        needsExpansion: Boolean(s.needsExpansion),
        searchable: Boolean(s.searchable),
        localPath: s.localPath,
        duplicateOf: s.duplicateOf,
      })),
      buckets: log ? JSON.parse(log.buckets || '[]') : [],
      duplicatesSkipped: [], // not stored per-entry; only count
      source: log ? log.source : null,
      error: log ? (log.error ? JSON.parse(log.error) : null) : null,
      totalUniqueFiles: log ? log.totalUniqueFiles : sources.length,
      totalSizeBytes: log ? log.totalSizeBytes : 0,
      syncedAt: log ? log.ranAt : null,
    };
  }

  /** Record that a file has been downloaded locally. */
  markLocal({ bucket, path, localPath }) {
    this.db.prepare(
      'UPDATE telegram_sources SET localPath = ?, searchable = 1 WHERE bucket = ? AND path = ?'
    ).run(localPath, bucket, path);
  }
}

function openStore(filePath) {
  return new TelegramStore(filePath).open();
}

module.exports = { TelegramStore, openStore, MIGRATIONS };

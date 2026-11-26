'use strict';

/**
 * Telegram corpus inventory + cross-bucket deduplication.
 *
 * The seven Apimaking Telegram buckets overlap: `Tgdata-bucket-fulltelegram` is a
 * byte-for-byte duplicate of `Tgdata-bucket` (identical xetHashes), and
 * `MergedTgfulldatabase` is a superset of both plus four DEADLOX files. Syncing
 * everything would re-download ~135 GB of duplicates, so we deduplicate by
 * `xetHash` and skip the duplicate bucket entirely.
 *
 * Because this sandbox cannot reach huggingface.co from Node, a bundled seed
 * manifest (from the manual inventory) is used when live listing fails.
 */

const fs = require('node:fs');
const path = require('node:path');
const { HFUnreachableError, listAllFiles, listBucketTree, resolveUrl } = require('./hf');
const { getConfig } = require('../../config');

/**
 * Resolve the bucket list from config (TELEGRAM_BUCKETS env, "owner/name" per
 * entry), falling back to the built-in default. Tgdata-bucket-fulltelegram is
 * intentionally omitted (byte-for-byte duplicate of Tgdata-bucket).
 */
function resolveBuckets() {
  const defaultBuckets = [
    { owner: 'Apimaking', name: 'Telegram-bucket' },
    { owner: 'Apimaking', name: 'Tg-num' },
    { owner: 'Apimaking', name: 'Tgdata-bucket' },
    { owner: 'Apimaking', name: 'telegram-databases-bucket' },
    { owner: 'Apimaking', name: 'MergedTgfulldatabase' },
    { owner: 'Apimaking', name: 'media-monitoring-telegram-bucket' },
  ];
  try {
    const configured = (getConfig().telegram || {}).buckets || [];
    if (configured.length) {
      return configured
        .map((entry) => {
          const m = String(entry).match(/^([^\/]+)\/(.+)$/);
          return m ? { owner: m[1], name: m[2] } : null;
        })
        .filter(Boolean);
    }
  } catch {
    /* config not ready yet; use defaults */
  }
  return defaultBuckets;
}

// Buckets to sync. Order matters: first-seen xetHash wins; later buckets with
// the same xetHash are treated as duplicates of the earlier file.
const BUCKETS = resolveBuckets();

// Buckets whose entire file set is a duplicate of another bucket (by name).
const DUPLICATE_BUCKETS = { 'Tgdata-bucket-fulltelegram': 'Tgdata-bucket' };

/** Directories that need recursive expansion during a real (HF-reachable) sync. */
const PREFIX_HINTS = [
  { owner: 'Apimaking', name: 'Tgdata-bucket', prefix: 'TG_DATA_PARTS' },
  { owner: 'Apimaking', name: 'MergedTgfulldatabase', prefix: 'TG_DATA_PARTS' },
  { owner: 'Apimaking', name: 'media-monitoring-telegram-bucket', prefix: 'channels' },
  { owner: 'Apimaking', name: 'media-monitoring-telegram-bucket', prefix: 'messages' },
];

/**
 * Bundled seed inventory (manual fetch_page inventory, 2026-11).
 * Files with known xetHash/size; directories marked needsExpansion so a live
 * sync can expand them via the tree API.
 */
const SEED_FILES = [
  // Telegram-bucket
  { bucket: 'Telegram-bucket', path: 'Midnight_Master_v2.db', size: 64533344256, xetHash: '87df3712', type: 'db', note: '60.1 GB' },
  { bucket: 'Telegram-bucket', path: 'Telegram_part_1_DB.db', size: 5874212864, xetHash: '0ab54fcf', type: 'db', note: '5.47 GB' },
  { bucket: 'Telegram-bucket', path: 'Telegram_10Digit_Chunk_part1.parquet', size: 41724928, xetHash: '7197f448', type: 'parquet', note: '39.8 MB' },
  // Tg-num
  { bucket: 'Tg-num', path: 'data.parquet', size: 1203624310, xetHash: '6bc0b311', type: 'parquet', note: '1.2 GB' },
  // Tgdata-bucket
  { bucket: 'Tgdata-bucket', path: 'TELEGRAM_MASTER_DB.parquet', size: 3254487040, xetHash: 'e22b1a58', type: 'parquet', note: '3.03 GB' },
  { bucket: 'Tgdata-bucket', path: 'TG_DATA_PARTS', size: null, xetHash: null, type: 'directory', needsExpansion: true, note: '1,014 partitioned parquet files (part_id=N/data_M.parquet)' },
  // telegram-databases-bucket
  { bucket: 'telegram-databases-bucket', path: 'telegram_tdata.db', size: 4833570816, xetHash: '4c2be4d4', type: 'db', note: '4.83 GB' },
  { bucket: 'telegram-databases-bucket', path: 'telegram_new.db', size: 1429499904, xetHash: '83a69678', type: 'db', note: '1.43 GB' },
  { bucket: 'telegram-databases-bucket', path: 'telegram_parts.db', size: 975044608, xetHash: 'a1331dca', type: 'db', note: '975 MB' },
  // MergedTgfulldatabase (superset; the master DB + parts duplicate Tgdata-bucket)
  { bucket: 'MergedTgfulldatabase', path: 'TELEGRAM_MASTER_DB.parquet', size: 3254487040, xetHash: 'e22b1a58', type: 'parquet', note: 'duplicate of Tgdata-bucket (same xetHash)' },
  { bucket: 'MergedTgfulldatabase', path: 'TG_DATA_PARTS', size: null, xetHash: null, type: 'directory', needsExpansion: true, note: 'duplicates Tgdata-bucket parts' },
  { bucket: 'MergedTgfulldatabase', path: 'TG_DATA_PARTS/TGDATA BY DEADLOX P1.parquet', size: 2181038080, xetHash: 'f3788ba2', type: 'parquet', note: '2.03 GB' },
  { bucket: 'MergedTgfulldatabase', path: 'TG_DATA_PARTS/TGDATA BY DEADLOX P2.parquet', size: 466555904, xetHash: null, type: 'parquet', note: '434 MB' },
  { bucket: 'MergedTgfulldatabase', path: 'TG_DATA_PARTS/TGDATA BY DEADLOX P3.parquet', size: 2193496064, xetHash: null, type: 'parquet', note: '2.04 GB' },
  { bucket: 'MergedTgfulldatabase', path: 'TG_DATA_PARTS/TGDATA BY DEADLOX P4.parquet', size: 153948160, xetHash: null, type: 'parquet', note: '143 MB' },
  // media-monitoring-telegram-bucket
  { bucket: 'media-monitoring-telegram-bucket', path: 'channels/channels-00000.parquet', size: 109051904, xetHash: null, type: 'parquet', note: '104 MB, 294,408 channels' },
  { bucket: 'media-monitoring-telegram-bucket', path: 'messages', size: null, xetHash: null, type: 'directory', needsExpansion: true, note: '128 message parquet files (~340-640 MB each), 469,305,126 messages' },
];

function isDirectory(entry) { return entry.type === 'directory' || entry.type === 'folder'; }
function isParquet(entry) { return /\.parquet$/i.test(entry.path); }
function isDb(entry) { return /\.db$/i.test(entry.path); }

/**
 * Normalize a raw HF tree entry (or seed entry) into a canonical source record.
 */
function normalizeEntry(entry, { bucket } = {}) {
  const filePath = entry.path || '';
  const record = {
    bucket: bucket || entry.bucket,
    path: filePath,
    size: entry.size == null ? null : Number(entry.size),
    xetHash: entry.xetHash || null,
    type: entry.type || (isParquet(entry) ? 'parquet' : isDb(entry) ? 'db' : 'file'),
    downloadUrl: entry.path ? resolveUrl({ owner: 'Apimaking', name: bucket || entry.bucket, filePath: entry.path }) : null,
    needsExpansion: Boolean(entry.needsExpansion || entry.type === 'directory'),
  };
  return record;
}

/**
 * Build the de-duplicated corpus manifest.
 *
 * - Lists every file in each configured bucket via the HF tree API.
 * - Skips buckets that are full duplicates of an earlier bucket.
 * - Deduplicates files by xetHash (first bucket wins).
 * - On HF failure, falls back to the bundled seed manifest.
 *
 * Returns { sources: [...], duplicatesSkipped: n, buckets: [...], source: 'live'|'seed', error }.
 */
async function buildManifest({ preferLive = true, signal } = {}) {
  const bucketsSeen = [];
  const duplicatesSkipped = [];
  const hashToSource = new Map();
  const sources = [];
  let error = null;
  let source = 'seed';
  let liveAttempted = false;
  let liveYieldedAny = false;

  if (preferLive) {
    liveAttempted = true;
    try {
      for (const bucket of BUCKETS) {
        const dupOf = DUPLICATE_BUCKETS[bucket.name];
        if (dupOf) {
          duplicatesSkipped.push({ bucket: bucket.name, duplicateOf: dupOf, reason: 'entire bucket is a duplicate' });
          continue;
        }
        bucketsSeen.push(bucket.name);
        let entries;
        try {
          entries = await listAllFiles({ owner: bucket.owner, name: bucket.name, path: '' });
          liveYieldedAny = true;
        } catch (err) {
          // A single bucket failing shouldn't abort the whole inventory.
          duplicatesSkipped.push({ bucket: bucket.name, reason: `listing failed: ${err.message}` });
          continue;
        }
        for (const entry of entries) {
          if (isDirectory(entry)) {
            // Directory placeholder; record it but mark for expansion.
            const record = normalizeEntry(entry, { bucket: bucket.name });
            record.duplicateOf = null;
            sources.push(record);
            continue;
          }
          const hash = entry.xetHash;
          if (!hash) {
            // No hash: cannot deduplicate reliably; keep as its own record.
            sources.push({ ...normalizeEntry(entry, { bucket: bucket.name }), duplicateOf: null });
            continue;
          }
          if (hashToSource.has(hash)) {
            duplicatesSkipped.push({
              bucket: bucket.name,
              path: entry.path,
              duplicateOf: `${hashToSource.get(hash).bucket}/${hashToSource.get(hash).path}`,
              reason: 'same xetHash as an earlier file',
            });
            continue;
          }
          hashToSource.set(hash, { bucket: bucket.name, path: entry.path });
          sources.push({ ...normalizeEntry(entry, { bucket: bucket.name }), duplicateOf: null });
        }
      }
      if (sources.length > 0) source = 'live';
    } catch (err) {
      error = err;
      // fall through to seed
    }
  }

  // If live was requested but produced nothing usable (e.g. HF unreachable from
  // this host), fall back to the bundled seed manifest so the API still works.
  if (source !== 'live' || (liveAttempted && sources.length === 0)) {
    source = 'seed';
    // Bundled seed manifest, deduplicated by xetHash.
    const seedHash = new Map();
    for (const entry of SEED_FILES) {
      const dupOf = DUPLICATE_BUCKETS[entry.bucket];
      if (dupOf) {
        duplicatesSkipped.push({ bucket: entry.bucket, duplicateOf: dupOf, reason: 'entire bucket is a duplicate' });
        continue;
      }
      if (!bucketsSeen.includes(entry.bucket)) bucketsSeen.push(entry.bucket);
      const record = normalizeEntry(entry, { bucket: entry.bucket });
      if (record.xetHash) {
        if (seedHash.has(record.xetHash)) {
          duplicatesSkipped.push({ bucket: entry.bucket, path: entry.path, duplicateOf: seedHash.get(record.xetHash), reason: 'same xetHash as an earlier file' });
          continue;
        }
        seedHash.set(record.xetHash, `${entry.bucket}/${entry.path}`);
      }
      sources.push(record);
    }
    source = 'seed';
  }

  // Annotate downloadability and format hints for the API.
  for (const record of sources) {
    record.searchable = record.type === 'parquet' || record.type === 'db';
    record.localPath = null; // populated after a successful download/sync
  }

  return {
    sources,
    buckets: bucketsSeen,
    duplicatesSkipped,
    duplicateBuckets: Object.entries(DUPLICATE_BUCKETS).map(([bucket, duplicateOf]) => ({ bucket, duplicateOf })),
    source,
    error: error ? { message: error.message, name: error.name } : null,
    totalUniqueFiles: sources.length,
    totalSizeBytes: sources.reduce((sum, s) => sum + (s.size || 0), 0),
  };
}

/**
 * Filter the manifest to files that are actually usable for searching right now:
 * parquet or .db files that are not directory placeholders.
 */
function searchableSources(manifest) {
  return manifest.sources.filter((s) => s.searchable && !s.needsExpansion);
}

module.exports = {
  BUCKETS,
  DUPLICATE_BUCKETS,
  PREFIX_HINTS,
  buildManifest,
  searchableSources,
  normalizeEntry,
  isParquet,
  isDb,
  SEED_FILES,
};

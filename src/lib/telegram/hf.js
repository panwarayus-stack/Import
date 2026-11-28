'use strict';

/**
 * Hugging Face API client for the Telegram buckets.
 *
 * NOTE: this sandbox cannot reach huggingface.co directly from Node
 * (TLS handshake is reset), so every function here degrades gracefully:
 * on network failure it throws a `HFUnreachableError` and callers fall back
 * to a previously saved / bundled manifest. Run `telegram sync` on a host
 * that can reach Hugging Face to refresh the live inventory.
 */

const https = require('node:https');
const http = require('node:http');

class HFUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HFUnreachableError';
    this.cause = cause;
  }
}

/** Base URL for the Hugging Face Hub. Configurable for tests / mirrors. */
const DEFAULT_BASE = 'https://huggingface.co';

/**
 * Fetch JSON from the Hugging Face Hub API.
 * `path` should be a path starting with '/', e.g. '/api/buckets/Apimaking/Tg-num/tree?path='.
 * Returns the parsed JSON body, or throws HFUnreachableError.
 */
function hfJson({ baseUrl = DEFAULT_BASE, path, signal, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'import-telegram-api/1.0' },
      timeout: timeoutMs,
      signal,
    };

    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new HFUnreachableError(
            `HF API ${url.pathname} returned ${res.statusCode}`,
            new Error(body.slice(0, 500)),
          ));
          return;
        }
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (error) {
          reject(new HFUnreachableError(`HF API ${url.pathname} returned invalid JSON`, error));
          return;
        }
        resolve(parsed);
      });
    });

    req.on('error', (error) => reject(new HFUnreachableError(`HF API ${url.pathname} unreachable`, error)));
    req.on('timeout', () => { req.destroy(new Error('HF API request timed out')); });
    req.end();
  });
}

/**
 * List the files (and sub-directories) at `path` inside a bucket.
 * Returns an array of { type, path, size, xetHash, uploadedAt }.
 * `path=''` lists the bucket root.
 */
async function listBucketTree({ owner, name, path = '' } = {}) {
  const data = await hfJson({
    path: `/api/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree?path=${encodeURIComponent(path)}`,
  });
  if (!Array.isArray(data)) throw new HFUnreachableError(`HF API for ${owner}/${name} did not return an array`);
  return data;
}

/**
 * Recursively list every file under `prefix` in a bucket.
 * Directories are expanded by re-querying the tree API.
 */
async function listAllFiles({ owner, name, prefix = '' } = {}) {
  const files = [];
  const queue = [prefix];
  const seenPrefixes = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seenPrefixes.has(current)) continue;
    seenPrefixes.add(current);
    const entries = await listBucketTree({ owner, name, path: current });
    for (const entry of entries) {
      if (entry.type === 'file') files.push(entry);
      else if (entry.type === 'folder') queue.push(entry.path);
    }
  }
  return files;
}

/**
 * Resolve a direct (Xet) download URL for a file inside a bucket.
 */
function resolveUrl({ owner, name, filePath } = {}) {
  const base = DEFAULT_BASE.replace(/\/$/, '');
  return `${base}/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/resolve/${encodeURIComponent(filePath)}?download=true`;
}

module.exports = { hfJson, listBucketTree, listAllFiles, resolveUrl, HFUnreachableError, DEFAULT_BASE };

'use strict';

/**
 * Filesystem helpers that refuse to escape a base directory.
 * Generated sites are written with these helpers only, so a malicious AI output
 * containing `../../.env` can never write outside its own sandbox folder.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSafeRelative(rel, { allowEmpty = false } = {}) {
  if (typeof rel !== 'string' || rel.length === 0) {
    if (allowEmpty) return '';
    throw new Error('path must be a non-empty string');
  }
  if (rel.includes('\0')) throw new Error('path contains a null byte');
  if (path.isAbsolute(rel)) throw new Error(`absolute paths are not allowed: ${rel}`);
  if (/^[a-zA-Z]:[\\/]/.test(rel)) throw new Error(`drive paths are not allowed: ${rel}`);
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`path traversal detected: ${rel}`);
  }
  if (normalized.startsWith('/')) throw new Error(`absolute paths are not allowed: ${rel}`);
  return normalized;
}

function resolveWithin(baseDir, rel, opts) {
  const safe = assertSafeRelative(rel, opts);
  const base = path.resolve(baseDir);
  const target = path.resolve(base, safe);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`resolved path escapes base directory: ${rel}`);
  }
  return target;
}

function writeFileWithin(baseDir, rel, content, { maxBytes = 1024 * 1024 } = {}) {
  const target = resolveWithin(baseDir, rel);
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (data.length > maxBytes) {
    throw new Error(`file ${rel} exceeds the ${maxBytes} byte limit`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return { path: target, bytes: data.length };
}

function readFileWithin(baseDir, rel, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const target = resolveWithin(baseDir, rel);
  const stat = fs.statSync(target);
  if (stat.size > maxBytes) throw new Error(`file ${rel} exceeds the read limit`);
  return fs.readFileSync(target);
}

/** Recursively list files with sizes; enforces limits so a runaway generator cannot fill disk. */
function listFiles(dir, { maxFiles = 500, maxBytes = 50 * 1024 * 1024 } = {}) {
  const files = [];
  let totalBytes = 0;

  const walk = (current, prefix = '') => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the sandbox
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.vite'].includes(entry.name)) continue;
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      totalBytes += stat.size;
      files.push({ rel, size: stat.size });
      if (files.length > maxFiles) throw new Error(`site exceeds ${maxFiles} files`);
      if (totalBytes > maxBytes) throw new Error(`site exceeds ${maxBytes} bytes`);
    }
  };

  walk(dir);
  return { files, totalBytes };
}

async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function slugify(text, { max = 44, fallback = 'project' } = {}) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || fallback;
}

module.exports = {
  ensureDir,
  assertSafeRelative,
  resolveWithin,
  writeFileWithin,
  readFileWithin,
  listFiles,
  removeDir,
  copyDir,
  sha256,
  sha256File,
  exists,
  slugify,
};

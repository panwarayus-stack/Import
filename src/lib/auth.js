'use strict';

/**
 * Dashboard authentication.
 *
 * A single shared password (DASHBOARD_PASSWORD) is exchanged for a stateless,
 * HMAC-signed session cookie. There is no user table by design — this is a
 * single-operator tool. Cookies are HttpOnly + SameSite=Strict.
 */

const crypto = require('node:crypto');

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSessionToken(secret, ttlHours = 12) {
  if (!secret) throw new Error('session secret is required');
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const payload = `v1.${exp}`;
  return `${payload}.${hmac(secret, payload)}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [version, expRaw, signature] = parts;
  if (version !== 'v1') return false;
  const expected = hmac(secret, `${version}.${expRaw}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(expRaw);
  return Number.isFinite(exp) && exp > Date.now();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    // Still compare to keep timing roughly constant.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Simple in-memory sliding-window rate limiter (per process). */
class RateLimiter {
  constructor({ limit = 8, windowMs = 300000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const entries = (this.hits.get(key) || []).filter((ts) => now - ts < this.windowMs);
    if (entries.length >= this.limit) {
      const retryAfterMs = this.windowMs - (now - entries[0]);
      this.hits.set(key, entries);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }
    entries.push(now);
    this.hits.set(key, entries);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
    }
    return { allowed: true, remaining: this.limit - entries.length, retryAfterMs: 0 };
  }

  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = { createSessionToken, verifySessionToken, safeEqual, parseCookies, RateLimiter, hmac };

'use strict';

/**
 * Small fetch wrapper with timeouts, bounded retries, Retry-After support and
 * consistent errors. Used by every external integration (OpenRouter, Google,
 * GitHub, Netlify) so rate-limit handling lives in one place.
 */

class ApiError extends Error {
  constructor(message, { status = 0, code = 'api_error', details = null, retryAfterMs = null, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function backoffDelay(attempt, { baseMs = 500, maxMs = 30000 } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/**
 * request() — perform an HTTP request with a hard timeout.
 * Returns { status, headers, body (string), json } or throws ApiError.
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    redirect = 'follow',
    signal: externalSignal,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
  }

  try {
    const response = await fetch(url, { method, headers, body, redirect, signal: controller.signal });
    const text = await response.text();
    let json = null;
    if (text) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('json') || /^[\[{]/.test(text.trim())) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
    }
    return { status: response.status, headers: response.headers, body: text, json, url: response.url };
  } catch (error) {
    throw new ApiError(`Network error calling ${new URL(url).host}: ${error.message}`, {
      code: 'network_error',
      retryable: true,
      details: { url },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * requestJson() — request + bounded retries for transient failures.
 * Respects `Retry-After`. Throws ApiError with a `retryable` flag set.
 */
async function requestJson(url, options = {}) {
  const {
    retries = 2,
    retryBaseMs = 800,
    retryMaxMs = 20000,
    parseError = true,
    expectedStatus = null,
    ...rest
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request(url, rest);
      const okStatuses = expectedStatus ? [].concat(expectedStatus) : null;
      const isOk = okStatuses ? okStatuses.includes(response.status) : response.status >= 200 && response.status < 300;

      if (isOk) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      const message = extractErrorMessage(response) || `HTTP ${response.status}`;
      lastError = new ApiError(message, {
        status: response.status,
        code: response.status === 429 ? 'rate_limited' : 'http_error',
        details: response.json || response.body?.slice(0, 2000),
        retryAfterMs,
        retryable,
      });
      if (!retryable || attempt === retries) throw lastError;
      await sleep(retryAfterMs ?? backoffDelay(attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs }));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      lastError = error;
      if (!error.retryable || attempt === retries) throw error;
      await sleep(error.retryAfterMs ?? backoffDelay(attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs }));
    }
  }
  throw lastError;
}

function extractErrorMessage(response) {
  const data = response.json;
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.error?.message) return data.error.message;
  if (typeof data.error === 'string') return data.error;
  if (data.message) return data.message;
  if (data.errors?.[0]?.message) return data.errors[0].message;
  return '';
}

module.exports = { ApiError, request, requestJson, sleep, backoffDelay, parseRetryAfter };

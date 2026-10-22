'use strict';

/**
 * OpenRouter client with model fallback, bounded retries, response caching and
 * per-job call budgets.
 *
 * Free models are rate limited and occasionally unavailable. When every model
 * fails the caller receives a typed error and the pipeline falls back to the
 * deterministic offline generator — never to a fake "AI" success.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ApiError, requestJson, sleep } = require('../lib/http');

class OpenRouterNotConfiguredError extends Error {
  constructor(message = 'OPENROUTER_API_KEY is not configured') {
    super(message);
    this.name = 'OpenRouterNotConfiguredError';
    this.code = 'not_configured';
  }
}

class AiBudgetExceededError extends Error {
  constructor(message = 'AI call budget for this job has been exhausted') {
    super(message);
    this.name = 'AiBudgetExceededError';
    this.code = 'budget_exceeded';
  }
}

class OpenRouterService {
  constructor(config, { db = null, logger = null } = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.cacheDir = path.join(config.paths.data, 'ai-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.cacheTtlMs = Number(process.env.AI_CACHE_TTL_HOURS || 168) * 3600 * 1000;
    this.cacheEnabled = String(process.env.AI_CACHE || 'true').toLowerCase() !== 'false';
  }

  get configured() {
    return Boolean(this.config.openrouter.apiKey);
  }

  /** Configured model list, with an optional dashboard override stored in SQLite. */
  get models() {
    const base = this.config.openrouter.models.length
      ? this.config.openrouter.models
      : ['meta-llama/llama-3.3-70b-instruct:free'];
    let override = '';
    try {
      override = String(this.db?.getSetting('ai', {})?.model || '').trim();
    } catch {
      override = '';
    }
    if (override && /^[\w./:-]{3,120}$/.test(override)) {
      return [override, ...base.filter((model) => model !== override)];
    }
    return base;
  }

  cacheKey(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40);
  }

  readCache(key) {
    if (!this.cacheEnabled) return null;
    const file = path.join(this.cacheDir, `${key}.json`);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > this.cacheTtlMs) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  writeCache(key, value) {
    if (!this.cacheEnabled) return;
    try {
      fs.writeFileSync(path.join(this.cacheDir, `${key}.json`), JSON.stringify({ cachedAt: new Date().toISOString(), value }));
    } catch (error) {
      this.logger?.warn?.(`Unable to write AI cache: ${error.message}`);
    }
  }

  /**
   * Chat completion with model fallback.
   * @param {object} params
   * @param {object} params.budget  { remaining: number, consume(): void } provided by the pipeline
   * @returns {Promise<{ text: string, model: string, usage: object, cached: boolean }>}
   */
  async chat({
    messages,
    model = null,
    temperature = this.config.openrouter.temperature,
    maxTokens = this.config.openrouter.maxTokens,
    responseFormat = null,
    purpose = 'generic',
    jobId = null,
    budget = null,
    retries = 1,
    cacheable = false,
  }) {
    if (!this.configured) throw new OpenRouterNotConfiguredError();
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages are required');

    const candidates = model ? [model, ...this.models.filter((m) => m !== model)] : this.models;
    const cachePayload = { messages, temperature, maxTokens, responseFormat, purpose, models: candidates };
    const key = this.cacheKey(cachePayload);
    if (cacheable) {
      const hit = this.readCache(key);
      if (hit) {
        this.logger?.info?.(`AI cache hit for ${purpose}`, { jobId, model: hit.value.model });
        return { ...hit.value, cached: true };
      }
    }

    if (budget && budget.remaining <= 0) throw new AiBudgetExceededError();
    budget?.consume?.();

    const errors = [];
    for (const candidate of candidates) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const payload = {
            model: candidate,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          };
          const response = await requestJson(`${this.config.openrouter.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.openrouter.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': this.config.openrouter.referer,
              'X-Title': this.config.openrouter.title,
            },
            body: JSON.stringify(payload),
            timeoutMs: this.config.openrouter.timeoutMs,
            retries: 0,
          });

          this.recordUsage(1);
          const choice = response.json?.choices?.[0];
          const text = choice?.message?.content;
          if (!text || !String(text).trim()) {
            throw new ApiError('OpenRouter returned an empty completion', {
              code: 'empty_completion',
              retryable: true,
            });
          }
          const result = {
            text: String(text),
            model: response.json?.model || candidate,
            usage: response.json?.usage || {},
            cached: false,
            simulated: false,
          };
          this.logger?.info?.(`AI ${purpose} completed`, {
            model: result.model,
            tokens: result.usage.total_tokens || null,
            jobId,
          });
          if (cacheable) this.writeCache(key, result);
          return result;
        } catch (error) {
          const msg = error instanceof ApiError ? `${error.status || ''} ${error.message}`.trim() : error.message;
          errors.push(`${candidate}: ${msg}`);
          this.logger?.warn?.(`OpenRouter model ${candidate} failed: ${msg}`, { jobId, purpose });
          const retryable = error instanceof ApiError ? error.retryable : false;
          if (!retryable) break; // try the next model instead
          if (attempt < retries) await sleep(error.retryAfterMs ?? 1500 * (attempt + 1));
        }
      }
    }

    throw new ApiError(`All OpenRouter models failed for ${purpose}: ${errors.join(' | ')}`, {
      code: 'models_exhausted',
      retryable: false,
      details: errors,
    });
  }

  /** Chat plus JSON parsing with fence stripping and a single "repair" retry. */
  async json(options) {
    const first = await this.chat(options);
    const parsed = extractJson(first.text);
    if (parsed.ok) return { ...first, data: parsed.value };
    this.logger?.warn?.(`Model returned invalid JSON for ${options.purpose}; asking for a JSON-only retry`, {
      jobId: options.jobId,
    });
    const retry = await this.chat({
      ...options,
      temperature: 0.2,
      cacheable: false,
      messages: [
        ...options.messages,
        { role: 'assistant', content: first.text.slice(0, 4000) },
        {
          role: 'user',
          content:
            'That response was not valid JSON. Reply with the same information as a single, strictly valid JSON object. ' +
            'No markdown fences, no commentary, no trailing commas.',
        },
      ],
    });
    const second = extractJson(retry.text);
    if (!second.ok) {
      throw new ApiError(`Model did not return valid JSON for ${options.purpose}: ${second.error}`, {
        code: 'invalid_json',
        details: retry.text.slice(0, 1000),
      });
    }
    return { ...retry, data: second.value };
  }

  recordUsage(calls = 1) {
    try {
      this.db?.recordUsage({ service: 'openrouter', operation: 'chat', units: calls, calls });
    } catch {
      /* usage accounting must never break the job */
    }
  }

  aiCallsToday() {
    try {
      return this.db?.usageForDay()?.openrouter?.calls || 0;
    } catch {
      return 0;
    }
  }
}

/** Robust JSON extraction from LLM output (fences, prose, trailing commas). */
function extractJson(text) {
  if (!text) return { ok: false, error: 'empty response' };
  let value = String(text).trim();
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) value = fence[1].trim();
  const start = value.search(/[[{]/);
  if (start === -1) return { ok: false, error: 'no JSON object found' };
  const opener = value[start];
  const closer = opener === '{' ? '}' : ']';
  const end = value.lastIndexOf(closer);
  if (end <= start) return { ok: false, error: 'unterminated JSON' };
  const candidate = value.slice(start, end + 1);
  const attempts = [candidate, candidate.replace(/,\s*([}\]])/g, '$1'), candidate.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')];
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch (error) {
      /* try the next sanitised variant */
    }
  }
  return { ok: false, error: 'invalid JSON syntax' };
}

module.exports = { OpenRouterService, OpenRouterNotConfiguredError, AiBudgetExceededError, extractJson };

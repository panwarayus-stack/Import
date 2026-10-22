'use strict';

/**
 * Structured logger: writes to stdout and to the `logs` table so the dashboard can
 * show a searchable history per job. Secrets are scrubbed before they are stored.
 */

// Each entry is [pattern, replacement]. Replacements keep the surrounding context so
// logs stay readable while the secret itself is removed.
const SECRET_PATTERNS = [
  [/(AIza[0-9A-Za-z_-]{20,})/g, 'AIza***'],
  [/(sk-or-v1-[0-9a-f]{20,})/g, 'sk-or-v1-***'],
  [/(gh[pousr]_[A-Za-z0-9]{20,})/g, 'gh***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, 'Bearer ***'],
  [/("?(?:access_token|refresh_token|client_secret|api_key|password)"?\s*[:=]\s*"?)[^",\s}]+/g, '$1***'],
  [/(\?|&)(code|token|client_secret)=[^&\s]+/g, '$1$2=***'],
];

function scrub(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') text = String(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

class Logger {
  constructor({ db = null, level = 'info', scope = 'app', jobId = null } = {}) {
    this.db = db;
    this.level = LEVELS[level] !== undefined ? level : 'info';
    this.scope = scope;
    this.jobId = jobId;
  }

  child(scope, jobId = this.jobId) {
    return new Logger({ db: this.db, level: this.level, scope, jobId });
  }

  write(level, message, meta) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const text = scrub(message);
    const metaObj = meta && typeof meta === 'object' ? JSON.parse(scrub(meta)) : undefined;
    const ts = new Date().toISOString();
    const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${this.scope}]${this.jobId ? ` (${this.jobId})` : ''}`;
    const line = metaObj ? `${prefix} ${text} ${scrub(metaObj)}` : `${prefix} ${text}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.db) {
      try {
        this.db.log({ level, scope: this.scope, jobId: this.jobId, message: text.slice(0, 4000), meta: metaObj || null });
      } catch {
        /* logging must never crash the pipeline */
      }
    }
  }

  debug(msg, meta) {
    this.write('debug', msg, meta);
  }

  info(msg, meta) {
    this.write('info', msg, meta);
  }

  warn(msg, meta) {
    this.write('warn', msg, meta);
  }

  error(msg, meta) {
    this.write('error', msg, meta);
  }
}

module.exports = { Logger, scrub };

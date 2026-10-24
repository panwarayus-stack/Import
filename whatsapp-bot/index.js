/**
 * index.js — WhatsApp Business Outreach Bot (unofficial, Baileys).
 *
 * One process does everything:
 *   * connects to WhatsApp as your own number (pairing code, session in Postgres)
 *   * routes messages: owner commands vs. customer chats vs. ignored traffic
 *   * asks ai.js for a validated suggestion, then decides *deterministically*
 *     whether anything may be sent
 *   * sends the owner-written pitch / demo link only to approved contacts
 *   * schedules the 21:00 Asia/Kolkata report and survives restarts/reconnects
 *
 * Run:      npm start            (reads .env)
 * Doctor:   npm run doctor       (config + database + provider checks, no WhatsApp)
 * Reset:    npm run reset-session (deletes the stored WhatsApp session)
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  WAMessageStatus,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import { Database, truncate } from './database.js';
import { AiRouter, KNOWN_FREE_GEMINI_MODELS } from './ai.js';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const __filename = fileURLToPath(import.meta.url);

/* ========================================================================== *
 * 1. Configuration
 * ========================================================================== */

const DIGITS = /^[0-9]{8,15}$/;

/** Parse "21:00" into minutes since midnight. Returns null when invalid. */
export function parseReportTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Digits-only phone number. Accepts "+91 98765 43210", "09876543210", "919876543210". */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  return DIGITS.test(digits) ? digits : null;
}

export const phoneToJid = (phone) => `${normalizePhone(phone) || ''}@s.whatsapp.net`;

/** Extract digits from a WhatsApp jid (returns null for lids/groups). */
export function jidToPhone(jid) {
  if (typeof jid !== 'string') return null;
  const [user, server] = jid.split('@');
  if (server !== 's.whatsapp.net') return null;
  const digits = String(user).split(':')[0].replace(/[^\d]/g, '');
  return DIGITS.test(digits) ? digits : null;
}

export function loadConfig(env = process.env) {
  const str = (key, fallback = '') => {
    const value = env[key];
    return value === undefined || value === null ? fallback : String(value).trim();
  };
  const int = (key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = str(key);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  };
  const bool = (key, fallback = false) => {
    const raw = str(key);
    if (!raw) return fallback;
    return /^(1|true|yes|on)$/i.test(raw);
  };

  const parseNumbers = (raw) =>
    String(raw || '')
      // Only commas/semicolons/newlines separate numbers: a phone number may
      // contain spaces ("+91 98765 43210") and must not be split apart.
      .split(/[,;\n]+/)
      .map((item) => normalizePhone(item))
      .filter(Boolean);

  const ownerNumbers = [...new Set(parseNumbers(str('OWNER_NUMBER')))];
  const adminNumbers = [...new Set(parseNumbers(str('ADMIN_NUMBERS')))];
  const timezone = str('REPORT_TIMEZONE', 'Asia/Kolkata');
  const reportTime = str('REPORT_TIME', '21:00');
  const geminiModel = str('GEMINI_MODEL', 'gemini-3.8-flash');
  const authStateMode = str('AUTH_STATE', 'database').toLowerCase();

  const config = {
    version: pkg.version,
    dryRun: bool('DRY_RUN', true),
    logLevel: str('LOG_LEVEL', 'info'),
    commandPrefix: str('COMMAND_PREFIX', '!').slice(0, 3),
    ownerNumbers,
    adminNumbers,
    ownerJid: ownerNumbers[0] ? phoneToJid(ownerNumbers[0]) : null,
    pairingNumber: normalizePhone(str('PAIRING_NUMBER') || ownerNumbers[0] || ''),
    healthPort: int('HEALTH_PORT', 0, { min: 0, max: 65535 }),
    database: {
      url: str('DATABASE_URL'),
      sslMode: str('DATABASE_SSL', 'require').toLowerCase(),
    },
    auth: {
      mode: authStateMode === 'file' ? 'file' : 'database',
      dir: str('AUTH_DIR', './auth'),
      sessionId: str('AUTH_SESSION_ID', 'default'),
      // Baileys' own log level. Keep quiet: it can include message metadata.
      baileysLogLevel: str('BAILEYS_LOG_LEVEL', 'error'),
    },
    business: {
      name: str('BUSINESS_NAME'),
      description: str('BUSINESS_DESCRIPTION'),
      pitch: str('FIXED_PITCH'),
      demoUrl: str('DEMO_URL'),
      allowAiRewritePitch: bool('ALLOW_AI_REWRITE_PITCH', false),
    },
    openrouter: {
      apiKey: str('OPENROUTER_API_KEY'),
      model: str('OPENROUTER_MODEL', 'openrouter/free'),
      timeoutMs: int('OPENROUTER_TIMEOUT_MS', 20_000, { min: 2_000, max: 120_000 }),
      maxRetries: int('OPENROUTER_MAX_RETRIES', 1, { min: 0, max: 3 }),
      jsonMode: bool('OPENROUTER_JSON_MODE', false),
      appUrl: str('OPENROUTER_APP_URL', 'https://getvoroa.com'),
      appName: str('OPENROUTER_APP_NAME', 'WhatsApp Outreach Bot'),
    },
    gemini: {
      apiKey: str('GEMINI_API_KEY'),
      model: geminiModel,
      timeoutMs: int('GEMINI_TIMEOUT_MS', 20_000, { min: 2_000, max: 120_000 }),
      maxRetries: int('GEMINI_MAX_RETRIES', 1, { min: 0, max: 3 }),
      forceUnlistedModel: bool('GEMINI_FORCE_MODEL', false),
      autoSelect: bool('GEMINI_AUTO_SELECT', false),
    },
    ai: {
      maxReplyLength: int('MAX_MESSAGE_LENGTH', 900, { min: 80, max: 4000 }),
      allowPriceTalk: bool('ALLOW_PRICE_TALK', false),
      allowClaims: bool('ALLOW_PROMISES', false),
      allowActionClaims: bool('ALLOW_UNVERIFIED_ACTION_CLAIMS', false),
      allowCommitments: bool('ALLOW_DELIVERY_COMMITMENTS', false),
    },
    limits: {
      maxOutboundPerDay: int('MAX_OUTBOUND_PER_DAY', 20, { min: 0, max: 200 }),
      minSecondsBetweenMessages: int('MIN_SECONDS_BETWEEN_MESSAGES', 20, { min: 0, max: 600 }),
      maxOwnerAlertsPerHour: int('MAX_OWNER_ALERTS_PER_HOUR', 6, { min: 0, max: 60 }),
    },
    report: {
      time: reportTime,
      timezone,
      minuteOfDay: parseReportTime(reportTime),
      tickMs: int('SCHEDULER_TICK_MS', 30_000, { min: 5_000, max: 300_000 }),
      retryEveryMs: int('REPORT_RETRY_INTERVAL_MS', 300_000, { min: 30_000, max: 3_600_000 }),
    },
    behaviour: {
      sendOptOutAck: bool('SEND_OPTOUT_ACKNOWLEDGEMENT', false),
      autoClassifyNewContacts: bool('AUTO_CLASSIFY_NEW_CONTACTS', false),
      notifyOwnerOnAiFailure: bool('NOTIFY_OWNER_ON_AI_FAILURE', true),
    },
  };

  const errors = [];
  const warnings = [];

  if (!config.database.url) {
    errors.push('DATABASE_URL is required (Supabase → Project Settings → Database → Connection string → URI).');
  } else if (!/^postgres(ql)?:\/\//i.test(config.database.url)) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }

  if (!config.ownerNumbers.length) {
    errors.push('OWNER_NUMBER is required (your WhatsApp number with country code, digits only).');
  }

  if (config.dryRun) {
    warnings.push('DRY_RUN=true — every outgoing message is logged and stored, nothing is sent. Set DRY_RUN=false when you are ready to go live.');
  }
  if (!config.openrouter.apiKey) {
    warnings.push('OPENROUTER_API_KEY is not set — OpenRouter will be skipped and Gemini used directly.');
  }
  if (!config.gemini.apiKey) {
    warnings.push('GEMINI_API_KEY is not set — no fallback provider; failed AI calls will queue for manual handling.');
  }
  if (config.gemini.apiKey && !KNOWN_FREE_GEMINI_MODELS.includes(config.gemini.model)) {
    warnings.push(
      `GEMINI_MODEL="${config.gemini.model}" is not on the documented free-tier list (${KNOWN_FREE_GEMINI_MODELS.join(', ')}). ` +
        'Run `npm run doctor` to see the Flash models your key can use, and set GEMINI_FORCE_MODEL=true only if you accept paid usage.',
    );
  }
  if (!config.business.name) warnings.push('BUSINESS_NAME is empty — the AI will not know your business name.');
  if (!config.business.description) warnings.push('BUSINESS_DESCRIPTION is empty — replies will be generic.');
  if (!config.business.pitch) warnings.push('FIXED_PITCH is empty — the !pitch command will refuse to send.');
  if (!config.business.demoUrl) warnings.push('DEMO_URL is empty — demo links cannot be sent.');
  if (config.report.minuteOfDay === null) {
    errors.push(`REPORT_TIME="${config.report.time}" is not a valid HH:MM value.`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.report.timezone });
  } catch {
    errors.push(`REPORT_TIMEZONE="${config.report.timezone}" is not a valid IANA timezone.`);
  }
  if (config.auth.mode === 'file' && !config.auth.dir) {
    errors.push('AUTH_STATE=file requires AUTH_DIR.');
  }
  if (!config.ownerJid) warnings.push('OWNER_NUMBER is invalid; daily reports have nowhere to go.');

  config.errors = errors;
  config.warnings = warnings;
  return config;
}

/* ========================================================================== *
 * 2. Time helpers (Asia/Kolkata by default, DST-safe via Intl)
 * ========================================================================== */

export function tzParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function todayInTz(timeZone, now = new Date()) {
  const p = tzParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function minuteOfDayInTz(timeZone, now = new Date()) {
  const p = tzParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instants for local midnight → next local midnight of a YYYY-MM-DD date. */
export function zonedDayRange(dateString, timeZone) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const startGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const endGuess = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  return {
    start: new Date(startGuess - tzOffsetMs(new Date(startGuess), timeZone)),
    end: new Date(endGuess - tzOffsetMs(new Date(endGuess), timeZone)),
  };
}

export function shiftDate(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ========================================================================== *
 * 3. Small utilities
 * ========================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serialises sends and enforces a minimum gap between them. */
export class Pacer {
  constructor(minMs = 0) {
    this.minMs = minMs;
    this.lastAt = 0;
  }

  async wait() {
    const elapsed = Date.now() - this.lastAt;
    if (elapsed < this.minMs) await sleep(this.minMs - elapsed);
    this.lastAt = Date.now();
  }
}

export function extractText(message) {
  const content = message?.message;
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

const STATUS_MAP = new Map([
  [WAMessageStatus?.ERROR ?? 0, 'failed'],
  [WAMessageStatus?.PENDING ?? 1, 'sent'],
  [WAMessageStatus?.SERVER_ACK ?? 2, 'sent'],
  [WAMessageStatus?.DELIVERY_ACK ?? 3, 'delivered'],
  [WAMessageStatus?.READ ?? 4, 'read'],
  [WAMessageStatus?.PLAYED ?? 5, 'read'],
]);

/** Build the daily report text. Pure function so it can be tested. */
export function buildReportText({ reportDate, timezone, metrics, previous = null, runtime = {}, attention = [], businessName = 'Business' }) {
  const number = (key) => Number(metrics?.[key] ?? 0);
  const delta = (key) => {
    if (!previous) return '';
    const change = number(key) - Number(previous[key] ?? 0);
    if (!change) return '';
    return change > 0 ? ` (+${change})` : ` (${change})`;
  };

  const lines = [];
  lines.push(`*${businessName} — daily report*`);
  lines.push(`${reportDate} · ${timezone}`);

  const quiet =
    number('sent') === 0 &&
    number('replies') === 0 &&
    number('new_eligible') === 0 &&
    number('opt_outs') === 0 &&
    number('pending_reviews') === 0;

  if (quiet) {
    lines.push('');
    lines.push('No significant activity today: no outreach sent, no replies, no new contacts, nothing waiting for you.');
  } else {
    lines.push('');
    lines.push(`Approved business contacts: ${number('approved_total')}${delta('approved_total')}`);
    lines.push(`New eligible contacts: ${number('new_eligible')}${delta('new_eligible')}`);
    lines.push(`Outreach messages sent: ${number('sent')}${delta('sent')}`);
    lines.push(`Delivery failures: ${number('send_failures')}${delta('send_failures')}`);
    lines.push(`Incoming replies: ${number('replies')}${delta('replies')}`);
    lines.push(`Interested prospects: ${number('interested')}${delta('interested')}`);
    lines.push(`Demo requests: ${number('demo_requests')} · demo links sent: ${number('demos_sent')}`);
    lines.push(`Not interested: ${number('not_interested')}${delta('not_interested')}`);
    lines.push(`Opt-outs: ${number('opt_outs')}${delta('opt_outs')}`);
    lines.push(`Pending owner review: ${number('pending_reviews')} conversations, ${number('flagged_messages')} messages`);
    lines.push(`AI provider failures: ${number('ai_failures')}${delta('ai_failures')}`);
    lines.push(`WhatsApp errors: ${Number(runtime.waErrors || 0)} · database errors: ${Number(runtime.dbErrors || 0)}`);
  }

  if (previous) {
    const changed = ['sent', 'replies', 'interested', 'demo_requests', 'opt_outs', 'new_eligible']
      .filter((key) => number(key) !== Number(previous[key] ?? 0))
      .map((key) => `${key.replace('_', ' ')} ${Number(previous[key] ?? 0)} → ${number(key)}`);
    lines.push('');
    lines.push(changed.length ? `Change since last report: ${changed.join(', ')}.` : 'No change since the last report.');
  }

  if (attention.length) {
    lines.push('');
    lines.push('*Needs your attention*');
    for (const item of attention.slice(0, 6)) lines.push(`• ${item}`);
  }

  if (runtime.paused) {
    lines.push('');
    lines.push('⚠️ Automation is PAUSED. Send !resume to continue.');
  }
  if (runtime.dryRun) {
    lines.push('');
    lines.push('🧪 DRY_RUN is on: reports describe intended actions only, nothing was sent to contacts.');
  }

  return lines.join('\n').slice(0, 3500);
}

/* ========================================================================== *
 * 4. The bot
 * ========================================================================== */

export class OutreachBot {
  constructor(config, { logger = null, database = null, ai = null, fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.startedAt = Date.now();
    this.logger =
      logger ||
      pino({
        level: config.logLevel,
        redact: {
          paths: ['apiKey', '*.apiKey', 'headers.authorization', 'authorization', '*.authorization', 'key'],
          censor: '[redacted]',
        },
        base: { service: 'whatsapp-bot' },
      });
    this.db = database || new Database({ connectionString: config.database.url, sslMode: config.database.sslMode, logger: this.logger });
    this.ai = ai || new AiRouter(config, { fetchImpl, logger: this.logger });
    this.sock = null;
    this.connected = false;
    this.connectStartedAt = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.schedulerTimer = null;
    this.healthServer = null;
    this.shuttingDown = false;
    this.pacer = new Pacer(config.limits.minSecondsBetweenMessages * 1000);
    this.processedIds = new Set();
    this.ownerAlerts = new Map();
    this.lastReportAttempt = new Map();
    this.lastTick = { date: null, sent: false };
  }

  /* ------------------------------------------------------------- lifecycle */

  async start() {
    if (this.config.errors.length) {
      for (const error of this.config.errors) this.logger.error(`config: ${error}`);
      throw new Error('Invalid configuration. Fix the errors above and restart.');
    }
    for (const warning of this.config.warnings) this.logger.warn(`config: ${warning}`);

    await this.db.init();
    this.logger.info('Database ready');

    const reportIn = this.config.report.minuteOfDay;
    this.logger.info(
      `Daily report scheduled for ${this.config.report.time} ${this.config.report.timezone} (local minute ${reportIn}) → ${this.config.ownerNumbers[0]}`,
    );

    await this.startHealthServer();
    this.startScheduler();
    await this.connect();
  }

  async startHealthServer() {
    if (!this.config.healthPort) return;
    this.healthServer = http.createServer(async (req, res) => {
      if (req.url?.split('?')[0] !== '/healthz') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }
      const db = await this.db.healthCheck({ retries: 0 });
      const body = {
        ok: db.ok && this.connected,
        whatsapp: this.connected ? 'connected' : 'disconnected',
        database: db.ok ? 'ok' : db.error,
        paused: await this.db.isPaused().catch(() => null),
        dryRun: this.config.dryRun,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        version: this.config.version,
      };
      res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => this.healthServer.listen(this.config.healthPort, '0.0.0.0', resolve));
    this.logger.info(`Health endpoint on :${this.config.healthPort}/healthz`);
  }

  startScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = setInterval(() => {
      this.tick().catch((error) => this.logger.error(`scheduler: ${error.message}`));
    }, this.config.report.tickMs);
    this.schedulerTimer.unref?.();
  }

  /* ---------------------------------------------------------------- socket */

  async buildAuthState() {
    if (this.config.auth.mode === 'file') {
      await fs.mkdir(this.config.auth.dir, { recursive: true });
      this.logger.warn(
        `AUTH_STATE=file — the session lives in ${this.config.auth.dir}. On Voroa (no persistent disks) it is lost on every deploy; use AUTH_STATE=database.`,
      );
      const { state, saveCreds } = await useMultiFileAuthState(this.config.auth.dir);
      return { state, saveCreds };
    }
    return this.db.useDatabaseAuthState(this.config.auth.sessionId);
  }

  async connect() {
    if (this.shuttingDown) return;
    this.connectStartedAt = Date.now();

    let version = null;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      this.logger.debug(`Baileys WA version ${version?.join('.')}`);
    } catch {
      this.logger.warn('Could not fetch the latest WhatsApp Web version; using the bundled default');
    }

    const { state, saveCreds } = await this.buildAuthState();
    const logger = pino({ level: this.config.auth.baileysLogLevel });

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      version: version || undefined,
      browser: Browsers.ubuntu('Business Outreach Bot'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) =>
        !jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast',
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update).catch((error) => this.logger.error(`connection: ${error.message}`));
    });

    this.sock.ev.on('messages.upsert', (payload) => {
      this.handleMessagesUpsert(payload).catch((error) => this.logger.error(`routing: ${error.message}`));
    });

    this.sock.ev.on('messages.update', (updates) => {
      this.handleMessageUpdates(updates).catch((error) => this.logger.debug?.(`receipts: ${error.message}`));
    });

    // Pairing code login (preferred over QR: no image parsing in a headless log).
    if (!state.creds.registered) {
      const number = this.config.pairingNumber;
      if (!number) {
        this.logger.error('No pairing number available. Set OWNER_NUMBER (or PAIRING_NUMBER) to the WhatsApp number this bot runs on.');
        return;
      }
      try {
        // Wait for the socket to be ready before requesting the code.
        await sleep(3000);
        const code = await this.sock.requestPairingCode(number);
        this.logger.warn(
          `PAIRING CODE for ${number.slice(0, 4)}****${number.slice(-2)}: ${code} — open WhatsApp → Linked devices → Link with phone number, enter it within a few minutes. It is single-use.`,
        );
      } catch (error) {
        this.logger.error(`Could not request a pairing code: ${error.message}`);
      }
    }
  }

  async handleConnectionUpdate({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.logger.warn('A QR code was issued. This build uses pairing codes; if pairing fails, rerun and enter the code promptly.');
    }

    if (connection === 'open') {
      this.connected = true;
      this.reconnectAttempts = 0;
      const user = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : 'unknown';
      this.logger.info(`WhatsApp connected as ${user}`);
      await this.db.setState('wa.connected_at', new Date().toISOString());
      await this.db.setState('wa.last_error', null);
      await this.flushPendingReports();
      return;
    }

    if (connection === 'close') {
      this.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, code]) => code === statusCode)?.[0] || 'unknown';
      const message = lastDisconnect?.error?.message || 'connection closed';
      this.logger.warn(`WhatsApp disconnected (${reason}, status ${statusCode ?? 'n/a'}): ${message}`);
      await this.db.setState('wa.last_error', truncate(`${reason}: ${message}`, 300)).catch(() => {});
      await this.db
        .recordRuntimeError('wa', `${reason}: ${message}`, todayInTz(this.config.report.timezone))
        .catch(() => {});

      if (statusCode === DisconnectReason.loggedOut) {
        this.logger.error(
          'This session was logged out from the phone. It cannot reconnect. Clear the stored session (npm run reset-session) and pair again.',
        );
        if (this.config.auth.mode === 'database') await this.db.clearAuthState(this.config.auth.sessionId).catch(() => {});
        await this.shutdown('logged out', 1);
        return;
      }

      this.scheduleReconnect(reason);
    }
  }

  scheduleReconnect(reason) {
    if (this.shuttingDown) return;
    this.reconnectAttempts += 1;
    const base = Math.min(60_000, 2_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.logger.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}, reason ${reason})`);

    if (this.reconnectAttempts > 12) {
      this.logger.error('12 consecutive reconnect attempts failed. Exiting so the platform restarts the worker.');
      this.shutdown('reconnect limit reached', 1);
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.logger.error(`Reconnect failed: ${error.message}`);
        this.scheduleReconnect('connect-error');
      });
    }, delay);
  }

  /* ------------------------------------------------------------ receipts */

  async handleMessageUpdates(updates) {
    for (const { key, update } of updates || []) {
      if (!key?.id || update?.status === undefined) continue;
      const mapped = STATUS_MAP.get(update.status);
      if (mapped) await this.db.updateDeliveryStatus(key.id, mapped);
    }
  }

  /* ------------------------------------------------------------- routing */

  isOwnerSender(msg) {
    const jid = msg.key.remoteJid;
    if (!jid) return false;
    const senderPhone = jidToPhone(jid);
    const ownPhone = this.config.ownerNumbers[0];
    // Self-chat: the owner typed in the "Message yourself" thread.
    if (msg.key.fromMe && senderPhone && senderPhone === ownPhone) return true;
    // Separate admin phone writing to the bot.
    const allowed = new Set([...this.config.ownerNumbers, ...this.config.adminNumbers]);
    return !msg.key.fromMe && senderPhone && allowed.has(senderPhone);
  }

  async handleMessagesUpsert({ messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      try {
        await this.routeMessage(msg);
      } catch (error) {
        this.logger.error(`failed to handle a message: ${error.message}`);
        await this.db.recordRuntimeError('handler', error.message, todayInTz(this.config.report.timezone)).catch(() => {});
      }
    }
  }

  async routeMessage(msg) {
    const jid = msg.key?.remoteJid;
    if (!jid) return;
    if (!msg.message) return; // receipts, deletions, protocol messages
    if (msg.messageStubType) return;

    if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast') return;

    const text = extractText(msg).trim();
    const isCommand = text.startsWith(this.config.commandPrefix);

    // Owner commands (never treated as customer traffic).
    if (isCommand && this.isOwnerSender(msg)) {
      await this.handleOwnerCommand(msg, text);
      return;
    }

    // Never react to our own outgoing messages, including the pitch we just sent.
    if (msg.key.fromMe) return;

    if (!text) {
      this.logger.debug?.('ignored a message without text (media/sticker/location)');
      return;
    }
    await this.handleInbound(msg, text);
  }

  /* ------------------------------------------------------- inbound handling */

  async handleInbound(msg, text) {
    const key = msg.key;
    const waMessageId = key.id;
    if (!waMessageId) return;
    if (this.processedIds.has(waMessageId)) return;

    const phone = jidToPhone(key.remoteJid) || jidToPhone(key.remoteJidAlt);
    if (!phone) {
      this.logger.warn('Ignoring a message whose phone number could not be resolved (lid-only chat)');
      return;
    }

    const contact = await this.db.ensureContact({
      jid: phoneToJid(phone),
      phone,
      displayName: msg.pushName || null,
    });
    const conversation = await this.db.ensureConversation(contact.id);

    const { inserted, message } = await this.db.recordInbound({
      waMessageId,
      contactId: contact.id,
      conversationId: conversation.id,
      body: text,
    });

    if (!inserted) {
      this.logger.debug?.(`duplicate message ${waMessageId} ignored`);
      return;
    }
    this.rememberProcessed(waMessageId);

    await this.db.touchConversation(conversation.id, { direction: 'inbound', needsOwner: false });

    // 1) Opt-out wins over everything else.
    if (contact.approval_status === 'opted_out' || conversation.state === 'opted_out') {
      await this.db.updateMessage(message.id, { processingStatus: 'skipped', category: 'opt_out' });
      this.logger.info(`Message from an opted-out contact ${maskPhone(phone)} ignored`);
      return;
    }

    // 2) Global pause.
    if (await this.db.isPaused()) {
      await this.db.updateMessage(message.id, { processingStatus: 'skipped', category: 'paused' });
      return;
    }

    // 3) Personal chats and un-approved conversations are never auto-answered.
    if (['personal', 'pending_review', 'paused'].includes(conversation.state)) {
      await this.db.updateMessage(message.id, { processingStatus: 'skipped', category: conversation.state });
      if (conversation.state === 'pending_review') {
        await this.db.touchConversation(conversation.id, { direction: 'inbound', needsOwner: true });
      }
      return;
    }

    // 4) Everything else must be explicitly approved for automated replies.
    if (conversation.state !== 'approved_business' && conversation.state !== 'bot_initiated') {
      await this.db.updateMessage(message.id, { processingStatus: 'skipped', category: conversation.state });
      return;
    }
    if (contact.approval_status !== 'approved') {
      await this.db.updateMessage(message.id, { processingStatus: 'needs_owner', category: 'unapproved' });
      await this.db.setConversationState(conversation.id, 'pending_review', { needsOwner: true, ownerNote: 'contact is not approved' });
      return;
    }

    await this.answerWithAi({ msg, contact, conversation, message, text });
  }

  rememberProcessed(waMessageId) {
    this.processedIds.add(waMessageId);
    if (this.processedIds.size > 500) {
      const first = this.processedIds.values().next().value;
      this.processedIds.delete(first);
    }
  }

  async answerWithAi({ contact, conversation, message, text }) {
    const gate = await this.canSendNow(contact);
    if (!gate.ok) {
      await this.db.updateMessage(message.id, { processingStatus: 'skipped', category: gate.reason });
      this.logger.info(`Reply skipped (${gate.reason})`);
      return;
    }

    const transcript = await this.db.recentTranscript(conversation.id, 8);
    const result = await this.ai.askAi(
      {
        business: this.config.business,
        conversation: transcript.filter((entry) => entry.body),
        latestMessage: text,
        demoAlreadySent: Boolean(conversation.demo_sent_at),
        allowPriceTalk: this.config.ai.allowPriceTalk,
      },
      { approvedForBusiness: true },
    );

    await this.db.logAiEvent({
      provider: result.provider === 'gemini' ? 'gemini' : 'openrouter',
      model: result.model || null,
      outcome: result.ok ? 'ok' : 'error',
      errorCategory: result.ok ? null : result.errorCategory || 'unknown',
      messageId: message.id,
    });

    if (!result.ok) {
      // Save for manual handling; never improvise a reply.
      await this.db.updateMessage(message.id, {
        processingStatus: 'ai_failed',
        provider: result.provider,
        errorCategory: result.errorCategory || 'unknown',
      });
      await this.db.touchConversation(conversation.id, { direction: 'inbound', needsOwner: true });
      if (this.config.behaviour.notifyOwnerOnAiFailure) {
        await this.notifyOwner(
          'ai-failure',
          `⚠️ AI unavailable for a message from ${maskPhone(contact.phone)} (${result.errorCategory}). It is saved as pending; nothing was sent.`,
        );
      }
      this.logger.warn(`Both AI providers failed (${result.errorCategory}); message queued for review`);
      return;
    }

    await this.db.updateMessage(message.id, {
      processingStatus: 'processed',
      category: result.category,
      provider: result.provider,
      model: result.model,
    });

    await this.applySuggestion({ contact, conversation, message, suggestion: result });
  }

  /** Deterministic reaction to a validated AI suggestion. */
  async applySuggestion({ contact, conversation, message, suggestion }) {
    const category = suggestion.category;

    if (category === 'opt_out') {
      await this.db.optOutContact(contact.id, 'contact asked to stop');
      await this.db.setConversationState(conversation.id, 'opted_out', { category, needsOwner: false, ownerNote: 'opt-out handled automatically' });
      this.logger.info(`Contact ${maskPhone(contact.phone)} opted out; outreach blocked`);
      if (this.config.behaviour.sendOptOutAck) {
        await this.sendOutbound({
          toJid: contact.jid,
          text: 'Understood — you will not receive further messages from us.',
          kind: 'acknowledgement',
          contact,
          conversation,
          category,
        });
      }
      await this.notifyOwner('optout', `🚫 ${maskPhone(contact.phone)} opted out. Further outreach is blocked.`);
      return;
    }

    if (category === 'personal') {
      await this.db.setClassification(contact.id, { classification: 'personal', reason: 'AI detected a personal conversation', source: 'ai' });
      await this.db.setConversationState(conversation.id, 'personal', { category, needsOwner: false, ownerNote: 'marked personal by AI' });
      this.logger.info('Conversation marked personal — no automated reply sent');
      return;
    }

    if (category === 'not_interested') {
      if (suggestion.reply) {
        await this.sendOutbound({ toJid: contact.jid, text: suggestion.reply, kind: 'reply', contact, conversation, category });
      }
      await this.db.setConversationState(conversation.id, 'paused', {
        category,
        needsOwner: false,
        ownerNote: 'prospect declined — follow-ups stopped',
      });
      return;
    }

    if (category === 'unclear' || category === 'needs_owner' || suggestion.needsOwner) {
      await this.db.setConversationState(conversation.id, conversation.state, {
        category,
        needsOwner: true,
        ownerNote: `AI requested review (${category})`,
      });
      await this.db.updateMessage(message.id, { processingStatus: 'needs_owner', category });
      await this.notifyOwner('review', `👀 Review needed for ${maskPhone(contact.phone)} (${category}). Nothing was sent.`);
      return;
    }

    // interested / demo_requested / business_question
    let body = suggestion.reply || '';
    const wantsDemo = category === 'demo_requested' || suggestion.sendDemo === true;
    if (wantsDemo && this.config.business.demoUrl && !conversation.demo_sent_at) {
      body = body ? `${body}\n\n${this.config.business.demoUrl}` : `Here is a sample of our work: ${this.config.business.demoUrl}`;
    }

    if (!body) {
      await this.db.setConversationState(conversation.id, conversation.state, { category, needsOwner: true, ownerNote: 'AI produced no usable reply' });
      return;
    }

    const sent = await this.sendOutbound({
      toJid: contact.jid,
      text: body,
      kind: 'reply',
      contact,
      conversation,
      category,
    });

    if (sent.dryRun || sent.sent) {
      await this.db.setConversationState(conversation.id, 'approved_business', { category, needsOwner: false });
    }

    if (wantsDemo && this.config.business.demoUrl && !conversation.demo_sent_at) {
      await this.db.query('UPDATE conversations SET demo_sent_at = NOW() WHERE id = $1', [conversation.id]);
      await this.db.logOutreach({
        contactId: contact.id,
        conversationId: conversation.id,
        kind: 'demo',
        status: sent.dryRun ? 'dry_run' : sent.sent ? 'sent' : 'failed',
        reason: sent.reason || null,
        bodyPreview: this.config.business.demoUrl,
      });
    }
  }

  /* ------------------------------------------------------------- sending */

  async canSendNow(contact) {
    if (!this.config.dryRun && !this.connected) return { ok: false, reason: 'whatsapp_offline' };
    if (await this.db.isPaused()) return { ok: false, reason: 'paused' };
    if (contact) {
      if (contact.approval_status === 'opted_out') return { ok: false, reason: 'opted_out' };
      if (contact.approval_status !== 'approved') return { ok: false, reason: 'not_approved' };
    }
    const today = todayInTz(this.config.report.timezone);
    const { start } = zonedDayRange(today, this.config.report.timezone);
    const sentToday = await this.db.countOutboundSince(start);
    if (this.config.limits.maxOutboundPerDay > 0 && sentToday >= this.config.limits.maxOutboundPerDay) {
      return { ok: false, reason: 'daily_limit_reached' };
    }
    return { ok: true, sentToday };
  }

  /**
   * Send one message through the single guarded path.
   * Honours DRY_RUN, pacing, daily limits and records everything.
   */
  async sendOutbound({ toJid, text, kind, contact = null, conversation = null, category = null }) {
    const body = String(text || '').slice(0, this.config.ai.maxReplyLength).trim();
    if (!body) return { sent: false, reason: 'empty' };

    const gate = await this.canSendNow(contact);
    if (!gate.ok) {
      this.logger.info(`Outbound blocked (${gate.reason})`);
      await this.db.logOutreach({
        contactId: contact?.id || null,
        conversationId: conversation?.id || null,
        kind,
        status: 'skipped',
        reason: gate.reason,
        bodyPreview: body,
      }).catch(() => {});
      return { sent: false, reason: gate.reason };
    }

    if (this.config.dryRun) {
      this.logger.info(`[DRY RUN] would send ${kind} to ${maskPhone(contact?.phone || jidToPhone(toJid))}: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`);
      await this.db.logOutreach({
        contactId: contact?.id || null,
        conversationId: conversation?.id || null,
        kind,
        status: 'dry_run',
        reason: 'DRY_RUN=true',
        bodyPreview: body,
      });
      await this.db.recordOutbound({
        contactId: contact?.id || null,
        conversationId: conversation?.id || null,
        body,
        status: 'dry_run',
        category,
      });
      if (conversation) await this.db.touchConversation(conversation.id, { direction: 'outbound' });
      return { sent: false, dryRun: true };
    }

    const event = await this.db.logOutreach({
      contactId: contact?.id || null,
      conversationId: conversation?.id || null,
      kind,
      status: 'queued',
      bodyPreview: body,
    });

    try {
      await this.pacer.wait();
      const result = await this.sock.sendMessage(toJid, { text: body });
      const waMessageId = result?.key?.id || null;
      await this.db.markOutreachSent(event.id, waMessageId);
      await this.db.recordOutbound({
        waMessageId,
        contactId: contact?.id || null,
        conversationId: conversation?.id || null,
        body,
        status: 'sent',
        category,
      });
      if (conversation) await this.db.touchConversation(conversation.id, { direction: 'outbound' });
      this.logger.info(`Sent ${kind} to ${maskPhone(contact?.phone || jidToPhone(toJid))}`);
      return { sent: true, waMessageId };
    } catch (error) {
      await this.db.query(`UPDATE outreach_events SET status = 'failed', reason = $2 WHERE id = $1`, [event.id, truncate(error.message, 300)]);
      this.logger.error(`Send failed: ${error.message}`);
      await this.db.recordRuntimeError('wa-send', error.message, todayInTz(this.config.report.timezone)).catch(() => {});
      return { sent: false, reason: 'send_error' };
    }
  }

  /** Owner-facing notices (never to customers), throttled per key. */
  async notifyOwner(key, text) {
    const limit = this.config.limits.maxOwnerAlertsPerHour;
    if (limit <= 0 || !this.config.ownerJid) return;
    const now = Date.now();
    const windowStart = this.ownerAlerts.get(key) || 0;
    if (now - windowStart < 3_600_000 / limit) return;
    this.ownerAlerts.set(key, now);
    if (this.config.dryRun) {
      this.logger.info(`[DRY RUN] owner notice: ${text}`);
      return;
    }
    try {
      await this.pacer.wait();
      await this.sock.sendMessage(this.config.ownerJid, { text });
    } catch (error) {
      this.logger.warn(`Could not notify the owner: ${error.message}`);
    }
  }

  /* -------------------------------------------------------- owner commands */

  async handleOwnerCommand(msg, rawText) {
    // Defence in depth: routeMessage() already checks this, but the command
    // handler must never act for a stranger even if it is called directly.
    if (!this.isOwnerSender(msg)) {
      this.logger.warn('Ignored a command from a non-owner number');
      return;
    }
    const replyJid = msg.key.remoteJid;
    const ownerJid = jidToPhone(replyJid) || 'unknown';
    const body = rawText.slice(this.config.commandPrefix.length).trim();
    const [commandRaw, ...rest] = body.split(/\s+/);
    const command = (commandRaw || '').toLowerCase();
    const argsText = rest.join(' ');
    const args = argsText.match(/^(\S+)\s*([\s\S]*)$/) || [];
    const firstArg = args[1] || '';
    const restText = (args[2] || '').trim();

    let response = '';
    try {
      switch (command) {
        case 'help':
          response = this.helpText();
          break;
        case 'status':
          response = await this.statusText();
          break;
        case 'pending':
          response = await this.pendingText();
          break;
        case 'approve':
          response = await this.commandApprove(firstArg, restText, ownerJid);
          break;
        case 'permission':
          response = await this.commandPermission(firstArg, restText, ownerJid);
          break;
        case 'approvechat':
          response = await this.commandApproveChat(firstArg, restText, ownerJid);
          break;
        case 'classify':
          response = await this.commandClassify(firstArg, restText, ownerJid);
          break;
        case 'pitch':
          response = await this.commandPitch(firstArg, ownerJid);
          break;
        case 'pause':
          response = await this.commandPause(restText);
          break;
        case 'resume':
          response = await this.commandResume();
          break;
        case 'report':
          await this.deliverManualReport();
          response = 'Report sent above. The scheduled 21:00 report still runs.';
          break;
        case 'optout':
          response = await this.commandOptOut(firstArg, restText, ownerJid);
          break;
        case 'optin':
          response = await this.commandOptIn(firstArg, restText, ownerJid);
          break;
        case 'logs':
          response = await this.logsText();
          break;
        case 'whoami':
          response = `Owner chat: ${replyJid}\nCommand source: ${msg.key.fromMe ? 'self-chat (from your phone)' : 'admin number'}\nDry run: ${this.config.dryRun ? 'on' : 'off'}`;
          break;
        default:
          response = `Unknown command "${command}". Send ${this.config.commandPrefix}help.`;
      }
    } catch (error) {
      this.logger.error(`command ${command} failed: ${error.message}`);
      response = `Command failed: ${error.message}`;
    }

    await this.db
      .logOwnerAction({ ownerJid, command, args: { first: firstArg, rest: restText.slice(0, 200) }, result: response })
      .catch(() => {});
    if (response) await this.sendOwnerReply(replyJid, response);
  }

  async sendOwnerReply(jid, text) {
    if (this.config.dryRun) {
      this.logger.info(`[DRY RUN] owner reply: ${String(text).slice(0, 200)}`);
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: String(text).slice(0, 3500) });
    } catch (error) {
      this.logger.error(`Could not reply to the owner: ${error.message}`);
    }
  }

  helpText() {
    const p = this.config.commandPrefix;
    return [
      `${this.config.business.name || 'Business'} bot — owner commands`,
      '',
      `${p}help — this list`,
      `${p}status — connection, limits, counters`,
      `${p}pending — conversations waiting for you`,
      `${p}approve <number> [note] — approve a contact (no message is sent)`,
      `${p}permission <number> <how consent was obtained> — required before ${p}pitch`,
      `${p}pitch <number> — send your fixed pitch to an approved contact`,
      `${p}approvechat <number> — allow automated replies in that chat`,
      `${p}classify <number> business|personal [reason] — set the classification`,
      `${p}pause [reason] / ${p}resume — stop or allow all automation`,
      `${p}report — send the daily report now`,
      `${p}optout <number> [reason] — block all future outreach`,
      `${p}optin <number> <evidence> — undo an opt-out after explicit re-consent`,
      `${p}logs — short operational summary`,
      '',
      `Safety: unapproved and personal chats never get automated replies; the pitch is sent only by ${p}pitch; every message is logged.`,
    ].join('\n');
  }

  async statusText() {
    const today = todayInTz(this.config.report.timezone);
    const { start, end } = zonedDayRange(today, this.config.report.timezone);
    const metrics = await this.db.statsBetween(start, end);
    const pending = await this.db.listPending(5);
    const paused = await this.db.isPaused();
    const db = await this.db.healthCheck({ retries: 0 });
    const uptime = Math.round((Date.now() - this.startedAt) / 1000);
    const report = await this.db.getDailyReport(today);
    return [
      `*Status*`,
      `WhatsApp: ${this.connected ? 'connected' : 'disconnected'} (${this.config.dryRun ? 'DRY RUN' : 'live'})`,
      `Automation: ${paused ? 'PAUSED' : 'active'}`,
      `Database: ${db.ok ? 'ok' : `error — ${db.error}`}`,
      `Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      `AI: ${this.config.openrouter.apiKey ? `OpenRouter (${this.config.openrouter.model})` : 'OpenRouter not configured'} → ${this.config.gemini.apiKey ? `Gemini (${this.config.gemini.model})` : 'Gemini not configured'}`,
      `Today: sent ${metrics.sent}/${this.config.limits.maxOutboundPerDay} · replies ${metrics.replies} · opt-outs ${metrics.opt_outs}`,
      `Pending review: ${pending.length} shown, ${metrics.pending_reviews} total`,
      `Report: ${this.config.report.time} ${this.config.report.timezone} · today ${report ? report.status : 'not generated'}`,
      `Limits: ${this.config.limits.minSecondsBetweenMessages}s between messages`,
    ].join('\n');
  }

  async pendingText() {
    const rows = await this.db.listPending(10);
    if (!rows.length) return 'Nothing is waiting for you.';
    const lines = ['*Waiting for your review*'];
    for (const row of rows) {
      const when = row.last_inbound_at ? new Date(row.last_inbound_at).toISOString().slice(0, 16).replace('T', ' ') : 'no inbound';
      lines.push(`• ${row.phone}${row.display_name ? ` (${row.display_name})` : ''} — ${row.state}, ${row.category || 'no category'}, ${row.flagged_messages} flagged, ${when} UTC`);
    }
    lines.push('', `Use ${this.config.commandPrefix}approvechat <number> to allow replies, or ${this.config.commandPrefix}classify <number> personal to silence it.`);
    return lines.join('\n');
  }

  async logsText() {
    const today = todayInTz(this.config.report.timezone);
    const errors = await this.db.runtimeErrorCount('wa', today);
    const dbErrors = await this.db.runtimeErrorCount('db', today);
    const sendErrors = await this.db.runtimeErrorCount('wa-send', today);
    const lastError = await this.db.getState('wa.last_error', null);
    return [
      '*Operational summary (no message content, no secrets)*',
      `WhatsApp: ${this.connected ? 'connected' : 'disconnected'} · reconnect attempts ${this.reconnectAttempts}`,
      `Errors today — connection: ${errors}, send: ${sendErrors}, database: ${dbErrors}`,
      `Last connection error: ${lastError || 'none'}`,
      `DRY_RUN: ${this.config.dryRun ? 'on' : 'off'} · Paused: ${(await this.db.isPaused()) ? 'yes' : 'no'}`,
      `AI: OpenRouter ${this.config.openrouter.apiKey ? 'configured' : 'missing'} / Gemini ${this.config.gemini.apiKey ? 'configured' : 'missing'}`,
      `Report: ${this.config.report.time} ${this.config.report.timezone}`,
    ].join('\n');
  }

  async findOrCreateContact(numberInput) {
    const phone = normalizePhone(numberInput);
    if (!phone) return { error: 'That is not a valid phone number. Use digits with country code, e.g. 919876543210.' };
    let contact = await this.db.getContactByPhone(phone);
    if (!contact) {
      contact = await this.db.ensureContact({ jid: phoneToJid(phone), phone, displayName: null });
    }
    const conversation = await this.db.ensureConversation(contact.id);
    return { contact, conversation };
  }

  async commandApprove(numberInput, note, ownerJid) {
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    const contact = await this.db.approveContact(found.contact.id, {
      ownerJid,
      note: note || null,
      permissionNote: note ? note : null,
    });
    const conversation = await this.db.getConversationByContact(contact.id);
    if (conversation && conversation.state === 'pending_review' && contact.classification !== 'personal') {
      await this.db.setConversationState(conversation.id, 'approved_business', { needsOwner: false, ownerNote: 'approved by owner' });
    }
    const lines = [`Approved ${contact.phone}. No message was sent.`];
    if (!contact.permission_note) {
      lines.push(
        `Outreach is still blocked: record how they consented with ${this.config.commandPrefix}permission ${contact.phone} <how they agreed>.`,
      );
    } else {
      lines.push(`Permission recorded: "${contact.permission_note}". Send ${this.config.commandPrefix}pitch ${contact.phone} when you are ready.`);
    }
    return lines.join('\n');
  }

  async commandPermission(numberInput, evidence, ownerJid) {
    if (!evidence || evidence.length < 5) {
      return `Usage: ${this.config.commandPrefix}permission <number> <how they consented, e.g. "asked me on Instagram to share a quote">`;
    }
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    await this.db.query(
      `UPDATE contacts SET permission_note = $2, permission_at = NOW(), approved_by = COALESCE(approved_by, $3), updated_at = NOW() WHERE id = $1`,
      [found.contact.id, truncate(evidence, 300), ownerJid],
    );
    return `Permission recorded for ${found.contact.phone}. Outreach is allowed once the contact is approved (${this.config.commandPrefix}approve).`;
  }

  async commandApproveChat(numberInput, note, ownerJid) {
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    if (found.contact.approval_status === 'opted_out') {
      return `${found.contact.phone} opted out. Automated replies stay blocked unless they explicitly consent again (${this.config.commandPrefix}optin).`;
    }
    if (found.contact.classification === 'personal') {
      return `${found.contact.phone} is classified personal. Use ${this.config.commandPrefix}classify ${found.contact.phone} business first.`;
    }
    await this.db.approveContact(found.contact.id, { ownerJid, note: note || 'conversation approved for automated replies' });
    await this.db.setConversationState(found.conversation.id, 'approved_business', {
      needsOwner: false,
      ownerNote: note || 'approved by owner',
    });
    return `Automated replies enabled for ${found.contact.phone}. Re-checks still apply: opt-outs, pause, daily limits and AI validation.`;
  }

  async commandClassify(numberInput, restText, ownerJid) {
    const [kindRaw, ...reasonParts] = restText.split(/\s+/);
    const kind = (kindRaw || '').toLowerCase();
    if (!['business', 'personal'].includes(kind)) {
      return `Usage: ${this.config.commandPrefix}classify <number> business|personal [reason]`;
    }
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    await this.db.setClassification(found.contact.id, {
      classification: kind,
      reason: reasonParts.join(' ') || `set by owner ${ownerJid}`,
      source: 'owner',
    });
    if (kind === 'personal') {
      await this.db.setConversationState(found.conversation.id, 'personal', { needsOwner: false, ownerNote: 'classified personal by owner' });
      await this.db.setApprovalStatus(found.contact.id, 'rejected');
      return `${found.contact.phone} marked personal. It will never receive automated business messages.`;
    }
    return `${found.contact.phone} marked business. Approve the chat with ${this.config.commandPrefix}approvechat ${found.contact.phone} to allow replies.`;
  }

  async commandPitch(numberInput, ownerJid) {
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    const { contact, conversation } = found;

    if (contact.approval_status === 'opted_out') return `${contact.phone} opted out; no outreach is possible.`;
    if (contact.approval_status !== 'approved') {
      return `${contact.phone} is not approved yet. Use ${this.config.commandPrefix}approve ${contact.phone}.`;
    }
    if (!contact.permission_note) {
      return `No documented consent for ${contact.phone}. Record it first: ${this.config.commandPrefix}permission ${contact.phone} <how they consented>.`;
    }
    if (!this.config.business.pitch) return 'FIXED_PITCH is not configured, so there is nothing to send.';
    if (conversation.outreach_sent_at) {
      return `A pitch was already sent to ${contact.phone} on ${new Date(conversation.outreach_sent_at).toISOString().slice(0, 10)}. Repeated outreach is disabled.`;
    }

    const gate = await this.canSendNow(contact);
    if (!gate.ok) return `Cannot send right now: ${gate.reason}.`;

    const result = await this.sendOutbound({
      toJid: contact.jid,
      text: this.config.business.pitch,
      kind: 'pitch',
      contact,
      conversation,
      category: 'pitch',
    });

    if (result.sent || result.dryRun) {
      await this.db.query(
        `UPDATE conversations SET outreach_sent_at = NOW(), state = CASE WHEN state = 'approved_business' THEN 'bot_initiated' ELSE state END WHERE id = $1`,
        [conversation.id],
      );
      await this.db.logOwnerAction({ ownerJid, command: 'pitch', args: { phone: contact.phone }, result: result.dryRun ? 'dry_run' : 'sent' });
      return result.dryRun
        ? `DRY RUN: the pitch to ${contact.phone} was logged, not sent.`
        : `Pitch sent to ${contact.phone}. Follow-ups are limited to replies they start.`;
    }
    return `Pitch not sent (${result.reason || 'unknown reason'}).`;
  }

  async commandPause(reason) {
    await this.db.setPaused(true, reason || 'paused by owner');
    return `Automation paused${reason ? ` (${reason})` : ''}. No replies, no outreach. Incoming messages are still recorded.`;
  }

  async commandResume() {
    await this.db.setPaused(false, null);
    return 'Automation resumed. Only approved chats with valid AI output will receive replies.';
  }

  async commandOptOut(numberInput, reason, ownerJid) {
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    await this.db.optOutContact(found.contact.id, reason || 'marked by owner');
    await this.db.setConversationState(found.conversation.id, 'opted_out', { needsOwner: false, ownerNote: reason || 'opted out by owner' });
    await this.db.logOwnerAction({ ownerJid, command: 'optout', args: { phone: found.contact.phone }, result: 'opted out' });
    return `${found.contact.phone} is opted out. All outreach and automated replies are blocked.`;
  }

  async commandOptIn(numberInput, evidence, ownerJid) {
    if (!evidence || evidence.length < 5) {
      return `An opt-out is only reversed when the contact explicitly consents again. Usage: ${this.config.commandPrefix}optin <number> <what they said / where>`;
    }
    const found = await this.findOrCreateContact(numberInput);
    if (found.error) return found.error;
    if (found.contact.approval_status !== 'opted_out') return `${found.contact.phone} is not opted out; nothing to reverse.`;
    await this.db.optInContact(found.contact.id, { evidence, ownerJid });
    await this.db.setConversationState(found.conversation.id, 'pending_review', { needsOwner: true, ownerNote: 're-consent recorded, awaiting review' });
    await this.db.logOwnerAction({ ownerJid, command: 'optin', args: { phone: found.contact.phone, evidence }, result: 'pending review' });
    return `Opt-out reversed for ${found.contact.phone} (evidence stored). The conversation is back in review — approve it deliberately with ${this.config.commandPrefix}approvechat.`;
  }

  /* ---------------------------------------------------------------- report */

  async collectMetrics(reportDate) {
    const { start, end } = zonedDayRange(reportDate, this.config.report.timezone);
    const metrics = await this.db.statsBetween(start, end);
    const waErrors = await this.db.runtimeErrorCount('wa', reportDate);
    const dbErrors = (await this.db.runtimeErrorCount('db', reportDate)) + (await this.db.runtimeErrorCount('handler', reportDate));
    const pending = await this.db.listPending(5);
    return {
      metrics,
      runtime: { waErrors, dbErrors, paused: await this.db.isPaused(), dryRun: this.config.dryRun },
      attention: pending.map((row) => `${row.phone}: ${row.state}${row.category ? ` / ${row.category}` : ''}`),
    };
  }

  async buildAndStoreReport(reportDate) {
    const { metrics, runtime, attention } = await this.collectMetrics(reportDate);
    const previousReport = await this.db.lastSentReport();
    const previous = previousReport?.payload?.metrics || null;
    const content = buildReportText({
      reportDate,
      timezone: this.config.report.timezone,
      metrics,
      previous,
      runtime,
      attention,
      businessName: this.config.business.name || 'Business',
    });
    const { report, created } = await this.db.ensureDailyReport(reportDate, this.config.report.timezone, content, {
      metrics,
      runtime,
      generatedAt: new Date().toISOString(),
    });
    return { report, created };
  }

  async deliverReport(report) {
    if (!report || report.status === 'sent') return { sent: false, reason: 'already_sent' };
    if (!this.config.ownerJid) return { sent: false, reason: 'no_owner' };
    if (!this.connected && !this.config.dryRun) return { sent: false, reason: 'offline' };

    const lastAttempt = this.lastReportAttempt.get(report.report_date) || 0;
    if (Date.now() - lastAttempt < this.config.report.retryEveryMs) return { sent: false, reason: 'backoff' };
    this.lastReportAttempt.set(report.report_date, Date.now());

    if (this.config.dryRun) {
      this.logger.info(`[DRY RUN] daily report for ${report.report_date}:\n${report.content}`);
      await this.db.markReportSent(report.report_date);
      await this.db.logOutreach({ contactId: null, kind: 'report', status: 'dry_run', bodyPreview: `daily report ${report.report_date}` });
      return { sent: false, dryRun: true };
    }

    try {
      await this.pacer.wait();
      const result = await this.sock.sendMessage(this.config.ownerJid, { text: report.content });
      const marked = await this.db.markReportSent(report.report_date);
      await this.db.logOutreach({
        contactId: null,
        kind: 'report',
        status: 'sent',
        waMessageId: result?.key?.id || null,
        bodyPreview: `daily report ${report.report_date}`,
      });
      this.logger.info(`Daily report for ${report.report_date} sent`);
      return { sent: true, report: marked };
    } catch (error) {
      await this.db.markReportFailed(report.report_date, error.message);
      this.logger.error(`Daily report delivery failed: ${error.message}`);
      return { sent: false, reason: 'send_error' };
    }
  }

  async deliverManualReport() {
    const reportDate = todayInTz(this.config.report.timezone);
    const { metrics, runtime, attention } = await this.collectMetrics(reportDate);
    const previousReport = await this.db.lastSentReport();
    const content = buildReportText({
      reportDate,
      timezone: this.config.report.timezone,
      metrics,
      previous: previousReport?.payload?.metrics || null,
      runtime,
      attention,
      businessName: this.config.business.name || 'Business',
    });
    // A manual report intentionally does NOT touch daily_reports: the 21:00
    // scheduled report must still be generated and delivered afterwards.
    if (this.config.dryRun) {
      this.logger.info(`[DRY RUN] manual report:\n${content}`);
      await this.sendOwnerReply(this.config.ownerJid, `[DRY RUN] report:\n${content}`);
      return;
    }
    await this.sendOwnerReply(this.config.ownerJid, content);
  }

  /** Deliver anything left pending — called after reconnect and on every tick. */
  async flushPendingReports() {
    const pending = await this.db.pendingReports(5);
    for (const report of pending) {
      const date = report.report_date instanceof Date ? report.report_date.toISOString().slice(0, 10) : String(report.report_date);
      const result = await this.deliverReport({ ...report, report_date: date });
      if (!result.sent && !result.dryRun) break;
    }
  }

  /** Called every SCHEDULER_TICK_MS. Also flushes reports missed while offline. */
  async tick() {
    if (this.shuttingDown) return;
    const today = todayInTz(this.config.report.timezone);
    const minute = minuteOfDayInTz(this.config.report.timezone);

    if (minute >= this.config.report.minuteOfDay) {
      const existing = await this.db.getDailyReport(today);
      if (!existing) {
        const { report } = await this.buildAndStoreReport(today);
        this.logger.info(`Daily report for ${today} generated`);
        if (report) await this.deliverReport(report);
        return;
      }
      if (existing.status !== 'sent') await this.deliverReport(existing);
      return;
    }

    // Before the scheduled time: only retry older pending reports.
    await this.flushPendingReports();
  }

  /* ------------------------------------------------------------ shutdown */

  async shutdown(reason = 'signal', exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info(`Shutting down (${reason})`);
    clearInterval(this.schedulerTimer);
    clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.end?.(undefined);
    } catch {
      /* socket already gone */
    }
    try {
      this.healthServer?.close?.();
    } catch {
      /* ignore */
    }
    await this.db.close().catch(() => {});
    this.logger.info('Shutdown complete');
    if (exitCode !== null) process.exit(exitCode);
  }
}

/* ========================================================================== *
 * 5. Privacy helpers + entrypoint
 * ========================================================================== */

export function maskPhone(phone) {
  const digits = String(phone || '');
  if (digits.length < 5) return '***';
  return `${digits.slice(0, 3)}*****${digits.slice(-2)}`;
}

async function doctor(config, logger) {
  logger.info(`WhatsApp bot v${config.version} — doctor`);
  logger.info(`Dry run: ${config.dryRun ? 'ON (nothing will be sent)' : 'OFF'}`);
  logger.info(`Owner numbers: ${config.ownerNumbers.map(maskPhone).join(', ') || 'none'}`);
  logger.info(`Report: ${config.report.time} ${config.report.timezone} → ${config.ownerJid ? maskPhone(config.ownerNumbers[0]) : 'nobody'}`);
  logger.info(`Business: ${config.business.name || '(empty)'} · demo ${config.business.demoUrl || '(empty)'}`);

  const db = new Database({ connectionString: config.database.url, sslMode: config.database.sslMode, logger });
  const health = await db.healthCheck({ retries: 1 });
  logger.info(`Database: ${health.ok ? 'reachable' : `ERROR — ${health.error}`}`);
  if (health.ok) {
    try {
      await db.init();
      const session = await db.hasAuthState(config.auth.sessionId).catch(() => false);
      logger.info(`Schema: ok · stored WhatsApp session: ${session ? 'yes' : 'no (pairing will be requested)'}`);
    } catch (error) {
      logger.error(`Schema: ${error.message}`);
    }
  }
  await db.close();

  const ai = new AiRouter(config, { logger });
  const providers = await ai.checkProviders();
  logger.info(`OpenRouter: ${providers.openrouter.note}`);
  logger.info(`Gemini: ${providers.gemini.note}`);
  if (providers.gemini.availableFlash?.length) {
    logger.info(`Gemini Flash models available to this key: ${providers.gemini.availableFlash.join(', ')}`);
  }
  logger.info(`Node ${process.version} · ${config.auth.mode === 'file' ? `file session in ${config.auth.dir}` : 'database session'}`);
  for (const warning of config.warnings) logger.warn(warning);
  if (config.errors.length) {
    for (const error of config.errors) logger.error(error);
    process.exitCode = 1;
  }
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    redact: { paths: ['apiKey', '*.apiKey', 'authorization', '*.authorization'], censor: '[redacted]' },
    base: { service: 'whatsapp-bot' },
  });

  if (argv.has('--help') || argv.has('-h')) {
    console.log('Usage: node index.js [--doctor|--reset-session|--help]');
    return;
  }

  if (argv.has('--doctor')) {
    await doctor(config, logger);
    return;
  }

  if (argv.has('--reset-session')) {
    if (config.auth.mode === 'file') {
      await fs.rm(path.resolve(config.auth.dir), { recursive: true, force: true });
      logger.warn(`Deleted ${config.auth.dir}. The next start will ask for a pairing code.`);
    } else {
      const db = new Database({ connectionString: config.database.url, sslMode: config.database.sslMode, logger });
      await db.clearAuthState(config.auth.sessionId);
      await db.close();
      logger.warn('Deleted the stored WhatsApp session. The next start will ask for a pairing code.');
    }
    return;
  }

  const bot = new OutreachBot(config, { logger });
  const shutdown = (signal) => bot.shutdown(signal, 0);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    bot.db.recordRuntimeError('unhandled', String(reason), todayInTz(config.report.timezone)).catch(() => {});
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    bot.db.recordRuntimeError('uncaught', error.message, todayInTz(config.report.timezone)).catch(() => {});
  });

  await bot.start();
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename) && !process.env.WHATSAPP_BOT_NO_AUTOSTART;

if (isDirectRun) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

export { main, doctor };
export default OutreachBot;

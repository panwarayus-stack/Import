/**
 * database.js — Supabase (PostgreSQL) persistence + WhatsApp auth-state storage.
 *
 * Everything that must survive a restart lives here:
 *   contacts, conversations, messages, outreach_events, owner_actions,
 *   daily_reports, app_state, ai_events, and the Baileys session.
 *
 * Design decisions
 *   * Plain `pg` with a small connection pool — no ORM, no code generation.
 *   * Every value is passed as a query parameter ($1, $2, …). Nothing is
 *     string-concatenated into SQL.
 *   * Idempotent schema bootstrap from schema.sql, so a fresh Supabase project
 *     fixes itself on first boot.
 *   * The WhatsApp session is stored in Postgres (wa_auth_creds / wa_auth_keys).
 *     Voroa has no persistent disk, so a filesystem session would be wiped on
 *     every deploy and you would have to re-pair every time. Storing it in the
 *     database is what actually keeps the bot connected across redeploys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initAuthCreds } from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========================================================================== *
 * Serialisation helpers
 *
 * Baileys credentials contain Buffer/Uint8Array values (key pairs, chain keys).
 * JSON.stringify would turn those into `{ type: 'Buffer', data: [...] }` and
 * the library would receive broken keys after a restore. We therefore encode
 * them explicitly and decode them back into real Buffers.
 * ========================================================================== */

export function encodeValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { __b64: value.toString('base64') };
  if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item);
    return out;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

export function decodeValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (typeof value === 'object') {
    if (typeof value.__b64 === 'string') return Buffer.from(value.__b64, 'base64');
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeValue(item);
    return out;
  }
  return value;
}

/** Keep the DB small and free of control characters. */
export function truncate(value, max = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const nowIso = () => new Date().toISOString();

/**
 * Split a SQL script into individual statements.
 *
 * Sending a whole script in one `query()` call works with node-postgres' simple
 * protocol, but not through prepared statements — and Supabase's transaction
 * pooler (port 6543) rejects multi-statement queries. Running statements one by
 * one works everywhere.
 *
 * Handles single/double quotes, dollar-quoted blocks ($$ ... $$), line comments
 * and block comments, so a ';' inside any of those does not split a statement.
 */
export function splitSqlStatements(script) {
  const statements = [];
  let current = '';
  let i = 0;
  const text = String(script ?? '');

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    // line comment
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end + 1;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }

    // block comment
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }

    // single-quoted string (with '' escaping)
    if (char === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }

    // double-quoted identifier
    if (char === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end === -1 ? text.length : end + 1;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }

    // dollar-quoted block: $tag$ ... $tag$
    if (char === '$') {
      const match = text.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (match) {
        const tag = match[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        current += text.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (char === ';') {
      statements.push(`${current};`);
      current = '';
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  if (current.trim()) statements.push(current);

  return statements
    .map((statement) => statement.trim())
    .filter((statement) => {
      const withoutComments = statement
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '')
        .trim();
      return withoutComments.length > 1;
    });
}

/* ========================================================================== *
 * Database
 * ========================================================================== */

export class Database {
  /**
   * @param {object} options
   * @param {string} options.connectionString  DATABASE_URL
   * @param {'require'|'verify-full'|'disable'} [options.sslMode]
   * @param {object} [options.pool]            injected pool (tests)
   */
  constructor({ connectionString, sslMode = 'require', pool = null, logger = console } = {}) {
    this.connectionString = connectionString;
    this.sslMode = sslMode;
    this.logger = logger;
    this.closed = false;
    this.pool =
      pool ||
      new pg.Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' },
      });
    if (!pool) {
      // A pool-level error would otherwise crash the process on network blips.
      this.pool.on('error', (error) => {
        this.logger.error?.('[db] idle client error:', error.message);
      });
    }
  }

  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  /** Connection check with one retry — used at boot and by the health server. */
  async healthCheck({ retries = 1, delayMs = 1500 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.query('SELECT 1 AS ok');
        return { ok: result.rows?.[0]?.ok === 1 || true, error: null };
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { ok: false, error: lastError?.message || 'unknown database error' };
  }

  /** Apply schema.sql (idempotent) and verify connectivity. */
  async init() {
    const health = await this.healthCheck({ retries: 2 });
    if (!health.ok) {
      throw new Error(
        `Cannot reach the database: ${health.error}. Check DATABASE_URL (Supabase → Project Settings → Database → Connection string) and that SSL is allowed.`,
      );
    }
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const statements = splitSqlStatements(fs.readFileSync(schemaPath, 'utf8'));
      await this.query('BEGIN');
      try {
        for (const statement of statements) await this.query(statement);
        await this.query('COMMIT');
        if (statements.length) this.logger.info?.(`[db] schema ready (${statements.length} statements applied)`);
      } catch (error) {
        await this.query('ROLLBACK').catch(() => {});
        throw new Error(`schema.sql failed: ${error.message}`);
      }
    }
    return health;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => {});
  }

  /* ------------------------------------------------------------ app_state */

  async getState(key, fallback = null) {
    const { rows } = await this.query('SELECT value FROM app_state WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  async setState(key, value) {
    await this.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async isPaused() {
    return (await this.getState('paused', false)) === true;
  }

  async setPaused(paused, reason = null) {
    await this.setState('paused', paused === true);
    await this.setState('paused_reason', reason);
    await this.setState('paused_at', paused ? nowIso() : null);
  }

  /** Counts connection/database errors for the daily report (date = local day key). */
  async recordRuntimeError(scope, message, dateKey = null) {
    const day = dateKey || new Date().toISOString().slice(0, 10);
    const key = `runtime_errors:${scope}:${day}`;
    const current = (await this.getState(key, { count: 0, last: null })) || { count: 0, last: null };
    await this.setState(key, { count: Number(current.count || 0) + 1, last: truncate(message, 300) });
  }

  async runtimeErrorCount(scope, dateKey) {
    const value = await this.getState(`runtime_errors:${scope}:${dateKey}`, null);
    return Number(value?.count || 0);
  }

  /* -------------------------------------------------------------- contacts */

  async ensureContact({ jid, phone, displayName = null }) {
    const { rows } = await this.query(
      `INSERT INTO contacts (jid, phone, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (jid) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
             updated_at = NOW()
       RETURNING *`,
      [jid, phone, truncate(displayName, 120)],
    );
    return rows[0];
  }

  async getContactByJid(jid) {
    const { rows } = await this.query('SELECT * FROM contacts WHERE jid = $1', [jid]);
    return rows[0] || null;
  }

  async getContactByPhone(phone) {
    const { rows } = await this.query('SELECT * FROM contacts WHERE phone = $1', [phone]);
    return rows[0] || null;
  }

  async setClassification(contactId, { classification, reason = null, source = 'ai' }) {
    const { rows } = await this.query(
      `UPDATE contacts
          SET classification = $2, classification_reason = $3, classification_source = $4, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [contactId, classification, truncate(reason, 300), source],
    );
    return rows[0] || null;
  }

  async setApprovalStatus(contactId, status) {
    await this.query('UPDATE contacts SET approval_status = $2, updated_at = NOW() WHERE id = $1', [contactId, status]);
  }

  /** Owner approval of a business contact. Records who approved and why. */
  async approveContact(contactId, { ownerJid, note = null, permissionNote = null }) {
    const { rows } = await this.query(
      `UPDATE contacts
          SET approval_status = 'approved',
              classification = CASE WHEN classification = 'personal' THEN classification ELSE 'business' END,
              classification_source = 'owner',
              classification_reason = COALESCE($3, classification_reason),
              approved_by = $2,
              approved_at = NOW(),
              permission_note = COALESCE($4, permission_note),
              permission_at = COALESCE(permission_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [contactId, ownerJid, truncate(note, 300), truncate(permissionNote, 300)],
    );
    return rows[0] || null;
  }

  async optOutContact(contactId, reason = 'requested by contact') {
    const { rows } = await this.query(
      `UPDATE contacts
          SET approval_status = 'opted_out', opt_out_at = NOW(), opt_out_reason = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [contactId, truncate(reason, 300)],
    );
    return rows[0] || null;
  }

  /**
   * Reverse an opt-out. The caller must pass evidence (owner confirmed the
   * contact explicitly asked to be contacted again); it is stored for audit.
   */
  async optInContact(contactId, { evidence, ownerJid }) {
    const { rows } = await this.query(
      `UPDATE contacts
          SET approval_status = 'pending',
              opt_out_at = NULL,
              opt_out_reason = NULL,
              permission_note = $2,
              permission_at = NOW(),
              approved_by = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [contactId, truncate(`re-consent: ${evidence}`, 300), ownerJid],
    );
    return rows[0] || null;
  }

  /* --------------------------------------------------------- conversations */

  async ensureConversation(contactId) {
    const { rows } = await this.query(
      `INSERT INTO conversations (contact_id) VALUES ($1)
       ON CONFLICT (contact_id) DO UPDATE SET updated_at = conversations.updated_at
       RETURNING *`,
      [contactId],
    );
    return rows[0];
  }

  async getConversation(conversationId) {
    const { rows } = await this.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    return rows[0] || null;
  }

  async getConversationByContact(contactId) {
    const { rows } = await this.query('SELECT * FROM conversations WHERE contact_id = $1', [contactId]);
    return rows[0] || null;
  }

  async setConversationState(conversationId, state, { category = null, needsOwner = null, ownerNote = null } = {}) {
    const { rows } = await this.query(
      `UPDATE conversations
          SET state = $2,
              category = COALESCE($3, category),
              needs_owner = COALESCE($4, needs_owner),
              owner_note = COALESCE($5, owner_note),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [conversationId, state, category, needsOwner, truncate(ownerNote, 500)],
    );
    return rows[0] || null;
  }

  async touchConversation(conversationId, { direction, category = null, needsOwner = null, followup = false }) {
    const column = direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at';
    const { rows } = await this.query(
      `UPDATE conversations
          SET ${column} = NOW(),
              message_count = message_count + 1,
              followups_sent = followups_sent + $2,
              category = COALESCE($3, category),
              needs_owner = COALESCE($4, needs_owner),
              last_processed_at = CASE WHEN $5 THEN NOW() ELSE last_processed_at END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [conversationId, followup ? 1 : 0, category, needsOwner, direction === 'inbound'],
    );
    return rows[0] || null;
  }

  /* -------------------------------------------------------------- messages */

  /**
   * Store an inbound message exactly once.
   * Returns { inserted: false } when the WhatsApp id was already processed
   * (Baileys replays messages after reconnects) — that is the duplicate guard.
   */
  async recordInbound({ waMessageId, contactId, conversationId, body }) {
    const { rows } = await this.query(
      `INSERT INTO messages (wa_message_id, contact_id, conversation_id, direction, body, processing_status)
       VALUES ($1, $2, $3, 'inbound', $4, 'received')
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING *`,
      [waMessageId, contactId, conversationId, truncate(body, 1000)],
    );
    return { inserted: rows.length === 1, message: rows[0] || null };
  }

  async recordOutbound({ waMessageId = null, contactId, conversationId, body, status = 'sent', category = null, provider = null, model = null }) {
    const { rows } = await this.query(
      `INSERT INTO messages
         (wa_message_id, contact_id, conversation_id, direction, body, category, ai_provider, ai_model, processing_status, processed_at)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [waMessageId, contactId, conversationId, truncate(body, 1000), category, provider, model, status],
    );
    return rows[0];
  }

  async updateMessage(messageId, { processingStatus, category = null, provider = null, model = null, errorCategory = null }) {
    await this.query(
      `UPDATE messages
          SET processing_status = COALESCE($2, processing_status),
              category = COALESCE($3, category),
              ai_provider = COALESCE($4, ai_provider),
              ai_model = COALESCE($5, ai_model),
              error_category = COALESCE($6, error_category),
              processed_at = NOW()
        WHERE id = $1`,
      [messageId, processingStatus, category, provider, model, errorCategory],
    );
  }

  async markMessageSent(messageId, waMessageId) {
    await this.query(
      `UPDATE messages SET processing_status = 'sent', wa_message_id = $2, processed_at = NOW() WHERE id = $1`,
      [messageId, waMessageId],
    );
  }

  /** Last N messages for the AI prompt (inbound + outbound, oldest first). */
  async recentTranscript(conversationId, limit = 8) {
    const { rows } = await this.query(
      `SELECT direction, body, created_at FROM messages
        WHERE conversation_id = $1 AND body IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $2`,
      [conversationId, limit],
    );
    return rows.reverse();
  }

  /** Conversations that need the owner: explicit flags plus failed AI runs. */
  async listPending(limit = 15) {
    const { rows } = await this.query(
      `SELECT c.id AS conversation_id, ct.phone, ct.jid, ct.display_name, c.state, c.category,
              c.needs_owner, c.owner_note, c.last_inbound_at,
              (SELECT COUNT(*)::int FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.processing_status IN ('ai_failed', 'needs_owner')) AS flagged_messages
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.needs_owner = TRUE
           OR EXISTS (SELECT 1 FROM messages m
                       WHERE m.conversation_id = c.id
                         AND m.processing_status IN ('ai_failed', 'needs_owner'))
        ORDER BY c.last_inbound_at DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Retry queue: messages saved because both AI providers failed. */
  async listFailedMessages(limit = 10) {
    const { rows } = await this.query(
      `SELECT m.*, ct.phone, ct.approval_status
         FROM messages m
         JOIN contacts ct ON ct.id = m.contact_id
        WHERE m.direction = 'inbound' AND m.processing_status = 'ai_failed'
        ORDER BY m.created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /* --------------------------------------------------------- outreach log */

  async logOutreach({ contactId, conversationId = null, kind, status, reason = null, waMessageId = null, bodyPreview = null }) {
    const { rows } = await this.query(
      `INSERT INTO outreach_events (contact_id, conversation_id, kind, status, reason, wa_message_id, body_preview, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [contactId, conversationId, kind, status, truncate(reason, 300), waMessageId, truncate(bodyPreview, 120), status === 'sent' ? 'sent' : null],
    );
    return rows[0];
  }

  async markOutreachSent(eventId, waMessageId) {
    await this.query(
      `UPDATE outreach_events SET status = 'sent', wa_message_id = $2, delivery_status = 'sent' WHERE id = $1`,
      [eventId, waMessageId],
    );
  }

  /** Delivery/read receipts land here (Baileys messages.update). */
  async updateDeliveryStatus(waMessageId, deliveryStatus) {
    const rank = { sent: 1, delivered: 2, read: 3, failed: 0, unknown: 0 };
    const { rows } = await this.query(
      `UPDATE outreach_events
          SET delivery_status = $2,
              delivered_at = CASE WHEN $2 IN ('delivered', 'read') THEN NOW() ELSE delivered_at END
        WHERE wa_message_id = $1
        RETURNING delivery_status`,
      [waMessageId, deliveryStatus],
    );
    if (rows.length && rank[deliveryStatus] >= 2) {
      await this.query(`UPDATE messages SET processed_at = COALESCE(processed_at, NOW()) WHERE wa_message_id = $1`, [waMessageId]);
    }
    return rows.length > 0;
  }

  async countOutboundSince(since) {
    const { rows } = await this.query(
      `SELECT COUNT(*)::int AS count FROM outreach_events
        WHERE created_at >= $1 AND status IN ('sent', 'dry_run')
          AND kind IN ('pitch', 'demo', 'followup', 'reply', 'acknowledgement')`,
      [since],
    );
    return rows[0]?.count || 0;
  }

  async lastOutboundAt() {
    const { rows } = await this.query(
      `SELECT created_at FROM outreach_events
        WHERE status = 'sent' AND kind IN ('pitch', 'demo', 'followup', 'reply', 'acknowledgement')
        ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.created_at || null;
  }

  /* -------------------------------------------------------------- reports */

  /** Insert-once daily report row. Returns { report, created }. */
  async ensureDailyReport(reportDate, timezone, content, payload) {
    const { rows } = await this.query(
      `INSERT INTO daily_reports (report_date, timezone, content, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (report_date) DO NOTHING
       RETURNING *`,
      [reportDate, timezone, content, JSON.stringify(payload ?? {})],
    );
    if (rows.length) return { report: rows[0], created: true };
    const existing = await this.query('SELECT * FROM daily_reports WHERE report_date = $1', [reportDate]);
    return { report: existing.rows[0] || null, created: false };
  }

  async getDailyReport(reportDate) {
    const { rows } = await this.query('SELECT * FROM daily_reports WHERE report_date = $1', [reportDate]);
    return rows[0] || null;
  }

  async markReportSent(reportDate) {
    const { rows } = await this.query(
      `UPDATE daily_reports
          SET status = 'sent', sent_at = NOW(), attempts = attempts + 1, error = NULL
        WHERE report_date = $1 AND status <> 'sent'
        RETURNING *`,
      [reportDate],
    );
    return rows[0] || null;
  }

  async markReportFailed(reportDate, error) {
    await this.query(
      `UPDATE daily_reports SET status = 'failed', attempts = attempts + 1, error = $2 WHERE report_date = $1 AND status <> 'sent'`,
      [reportDate, truncate(error, 300)],
    );
  }

  async pendingReports(limit = 5) {
    const { rows } = await this.query(
      `SELECT * FROM daily_reports WHERE status <> 'sent' ORDER BY report_date ASC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async lastSentReport() {
    const { rows } = await this.query(
      `SELECT * FROM daily_reports WHERE status = 'sent' ORDER BY report_date DESC LIMIT 1`,
    );
    return rows[0] || null;
  }

  /* ------------------------------------------------------------- analytics */

  /** Counters used by the daily report. All boundaries are UTC timestamps. */
  async statsBetween(start, end) {
    const { rows } = await this.query(
      `SELECT
         (SELECT COUNT(*)::int FROM contacts WHERE approval_status = 'approved')                                        AS approved_total,
         (SELECT COUNT(*)::int FROM contacts
           WHERE created_at >= $1 AND created_at < $2 AND classification = 'business'
             AND approval_status IN ('pending', 'approved'))                                                          AS new_eligible,
         (SELECT COUNT(*)::int FROM outreach_events
           WHERE created_at >= $1 AND created_at < $2 AND status = 'sent'
             AND kind IN ('pitch', 'demo', 'followup', 'reply', 'acknowledgement'))                                   AS sent,
         (SELECT COUNT(*)::int FROM outreach_events
           WHERE created_at >= $1 AND created_at < $2 AND (status = 'failed' OR delivery_status = 'failed'))          AS send_failures,
         (SELECT COUNT(*)::int FROM messages m
           WHERE m.created_at >= $1 AND m.created_at < $2 AND m.direction = 'inbound'
             AND m.conversation_id IN (SELECT id FROM conversations WHERE state <> 'personal'))                      AS replies,
         (SELECT COUNT(*)::int FROM messages m
           WHERE m.created_at >= $1 AND m.created_at < $2 AND m.direction = 'inbound' AND m.category = 'interested'
             AND m.conversation_id IN (SELECT id FROM conversations WHERE state <> 'personal'))                      AS interested,
         (SELECT COUNT(*)::int FROM messages m
           WHERE m.created_at >= $1 AND m.created_at < $2 AND m.direction = 'inbound' AND m.category = 'demo_requested'
             AND m.conversation_id IN (SELECT id FROM conversations WHERE state <> 'personal'))                      AS demo_requests,
         (SELECT COUNT(*)::int FROM outreach_events
           WHERE created_at >= $1 AND created_at < $2 AND kind = 'demo' AND status = 'sent')                          AS demos_sent,
         (SELECT COUNT(*)::int FROM messages m
           WHERE m.created_at >= $1 AND m.created_at < $2 AND m.direction = 'inbound' AND m.category = 'not_interested'
             AND m.conversation_id IN (SELECT id FROM conversations WHERE state <> 'personal'))                      AS not_interested,
         (SELECT COUNT(*)::int FROM contacts
           WHERE opt_out_at >= $1 AND opt_out_at < $2)                                                                AS opt_outs,
         (SELECT COUNT(*)::int FROM conversations WHERE needs_owner = TRUE)                                            AS pending_reviews,
         (SELECT COUNT(*)::int FROM messages m
           WHERE m.processing_status IN ('ai_failed', 'needs_owner')
             AND m.conversation_id IN (SELECT id FROM conversations WHERE state <> 'personal'))                      AS flagged_messages,
         (SELECT COUNT(*)::int FROM ai_events
           WHERE created_at >= $1 AND created_at < $2 AND outcome = 'error')                                           AS ai_failures
      `,
      [start, end],
    );
    return rows[0];
  }

  async logAiEvent({ provider, model = null, outcome, errorCategory = null, httpStatus = null, messageId = null }) {
    try {
      await this.query(
        `INSERT INTO ai_events (provider, model, outcome, error_category, http_status, message_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [provider, model, outcome, errorCategory, httpStatus, messageId],
      );
    } catch (error) {
      // Never let telemetry break message handling.
      this.logger.warn?.('[db] could not record AI event:', error.message);
    }
  }

  async logOwnerAction({ ownerJid, command, args = {}, result = null }) {
    await this.query(
      `INSERT INTO owner_actions (owner_jid, command, args, result) VALUES ($1, $2, $3::jsonb, $4)`,
      [ownerJid, command, JSON.stringify(args), truncate(result, 2000)],
    );
  }

  /* ========================================================================== *
   * Baileys auth state backed by Postgres
   *
   * Implements the { state: { creds, keys }, saveCreds } contract that
   * makeWASocket expects. Writes are coalesced: `keys.set` receives a whole
   * batch and we upsert it in one statement.
   * ========================================================================== */

  async useDatabaseAuthState(sessionId = 'default') {
    const readCreds = async () => {
      const { rows } = await this.query('SELECT value FROM wa_auth_creds WHERE session_id = $1', [sessionId]);
      return rows.length ? decodeValue(rows[0].value) : null;
    };

    const stored = await readCreds();
    const creds = stored || initAuthCreds();

    const saveCreds = async () => {
      await this.query(
        `INSERT INTO wa_auth_creds (session_id, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (session_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [sessionId, JSON.stringify(encodeValue(creds))],
      );
    };

    const keys = {
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const { rows } = await this.query(
          `SELECT key_id, value FROM wa_auth_keys WHERE session_id = $1 AND type = $2 AND key_id = ANY($3::text[])`,
          [sessionId, type, ids],
        );
        const out = {};
        for (const row of rows) {
          if (row.value !== null) out[row.key_id] = decodeValue(row.value);
        }
        return out;
      },

      set: async (data) => {
        const rows = [];
        for (const [type, entries] of Object.entries(data || {})) {
          for (const [keyId, value] of Object.entries(entries || {})) {
            rows.push([type, keyId, value === null || value === undefined ? null : JSON.stringify(encodeValue(value))]);
          }
        }
        if (!rows.length) return;
        // One round-trip: unnest three parallel arrays.
        await this.query(
          `INSERT INTO wa_auth_keys (session_id, type, key_id, value, updated_at)
           SELECT $1, t.type, t.key_id, t.value::jsonb, NOW()
             FROM unnest($2::text[], $3::text[], $4::text[]) AS t(type, key_id, value)
           ON CONFLICT (session_id, type, key_id)
           DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [sessionId, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])],
        );
      },
    };

    return { state: { creds, keys }, saveCreds };
  }

  /** Wipe the stored WhatsApp session (after logout or to force re-pairing). */
  async clearAuthState(sessionId = 'default') {
    await this.query('DELETE FROM wa_auth_keys WHERE session_id = $1', [sessionId]);
    await this.query('DELETE FROM wa_auth_creds WHERE session_id = $1', [sessionId]);
  }

  async hasAuthState(sessionId = 'default') {
    const { rows } = await this.query('SELECT 1 AS present FROM wa_auth_creds WHERE session_id = $1', [sessionId]);
    return rows.length > 0;
  }
}

export default Database;

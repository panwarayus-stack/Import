-- ============================================================================
-- WhatsApp Business Outreach Bot — Supabase / PostgreSQL schema
--
-- How to run it in Supabase
--   1. Open your project → SQL Editor → New query.
--   2. Paste this whole file and press "Run".
--   3. It is idempotent: running it twice is safe (CREATE ... IF NOT EXISTS).
--
-- The application also executes this file at boot (database.js → initDatabase),
-- so a fresh database fixes itself on first start. Keep the two in sync.
--
-- Security notes
--   * No API keys, tokens or WhatsApp credentials are stored here except the
--     Baileys auth state (wa_auth_creds / wa_auth_keys). That data is a live
--     WhatsApp session: treat the database as a credential store. Enable RLS or
--     keep the DATABASE_URL server-side only, and never expose these tables to
--     a browser. Use the direct/pooler connection string only in the bot's env.
--   * Enable "SSL required" (Supabase does this by default).
-- ============================================================================

-- ----------------------------------------------------------------- contacts --
CREATE TABLE IF NOT EXISTS contacts (
  id                  BIGSERIAL PRIMARY KEY,
  jid                 TEXT        NOT NULL UNIQUE,          -- e.g. 919876543210@s.whatsapp.net
  phone               TEXT        NOT NULL,                 -- digits only, E.164 without '+'
  display_name        TEXT,
  -- business | personal | unknown   (AI may only suggest; the owner decides)
  classification      TEXT        NOT NULL DEFAULT 'unknown',
  classification_reason TEXT,
  classification_source TEXT      NOT NULL DEFAULT 'unknown', -- ai | owner | unknown
  -- pending | approved | rejected | opted_out
  approval_status     TEXT        NOT NULL DEFAULT 'pending',
  permission_note     TEXT,                                 -- how consent was obtained
  permission_at       TIMESTAMPTZ,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  opt_out_at          TIMESTAMPTZ,
  opt_out_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contacts_classification_chk CHECK (classification IN ('business', 'personal', 'unknown')),
  CONSTRAINT contacts_approval_chk       CHECK (approval_status IN ('pending', 'approved', 'rejected', 'opted_out')),
  CONSTRAINT contacts_phone_chk          CHECK (phone ~ '^[0-9]{8,15}$')
);

CREATE INDEX IF NOT EXISTS contacts_approval_idx     ON contacts (approval_status);
CREATE INDEX IF NOT EXISTS contacts_classification_idx ON contacts (classification);
CREATE INDEX IF NOT EXISTS contacts_phone_idx        ON contacts (phone);

-- ------------------------------------------------------------ conversations --
CREATE TABLE IF NOT EXISTS conversations (
  id                 BIGSERIAL PRIMARY KEY,
  contact_id         BIGINT      NOT NULL UNIQUE REFERENCES contacts (id) ON DELETE CASCADE,
  -- pending_review | approved_business | bot_initiated | personal | opted_out | paused
  state              TEXT        NOT NULL DEFAULT 'pending_review',
  category           TEXT,                                  -- last AI category
  needs_owner        BOOLEAN     NOT NULL DEFAULT FALSE,
  owner_note         TEXT,
  message_count      INTEGER     NOT NULL DEFAULT 0,
  followups_sent     INTEGER     NOT NULL DEFAULT 0,
  outreach_sent_at   TIMESTAMPTZ,                           -- first pitch sent
  demo_sent_at       TIMESTAMPTZ,
  last_inbound_at    TIMESTAMPTZ,
  last_outbound_at   TIMESTAMPTZ,
  last_processed_at  TIMESTAMPTZ,                           -- last successful processing
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversations_state_chk CHECK (state IN (
    'pending_review', 'approved_business', 'bot_initiated', 'personal', 'opted_out', 'paused'
  ))
);

CREATE INDEX IF NOT EXISTS conversations_state_idx      ON conversations (state);
CREATE INDEX IF NOT EXISTS conversations_needs_owner_idx ON conversations (needs_owner) WHERE needs_owner;
CREATE INDEX IF NOT EXISTS conversations_processed_idx  ON conversations (last_processed_at DESC);

-- ----------------------------------------------------------------- messages --
CREATE TABLE IF NOT EXISTS messages (
  id                BIGSERIAL PRIMARY KEY,
  wa_message_id     TEXT        UNIQUE,                      -- Baileys key.id → duplicate protection
  contact_id        BIGINT      REFERENCES contacts (id) ON DELETE CASCADE,
  conversation_id   BIGINT      REFERENCES conversations (id) ON DELETE CASCADE,
  direction         TEXT        NOT NULL,                    -- inbound | outbound
  body              TEXT,                                    -- truncated copy, no media
  category          TEXT,
  ai_provider       TEXT,                                    -- openrouter | gemini | none
  ai_model          TEXT,
  -- received | processed | skipped | ai_failed | needs_owner | sent | dry_run | send_failed
  processing_status TEXT        NOT NULL DEFAULT 'received',
  error_category    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  CONSTRAINT messages_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT messages_status_chk    CHECK (processing_status IN (
    'received', 'processed', 'skipped', 'ai_failed', 'needs_owner', 'sent', 'dry_run', 'send_failed'
  ))
);

CREATE INDEX IF NOT EXISTS messages_contact_idx  ON messages (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recent_idx   ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_status_idx   ON messages (processing_status);
CREATE INDEX IF NOT EXISTS messages_pending_idx  ON messages (processing_status)
  WHERE processing_status IN ('received', 'ai_failed', 'needs_owner');

-- ---------------------------------------------------------- outreach events --
CREATE TABLE IF NOT EXISTS outreach_events (
  id               BIGSERIAL PRIMARY KEY,
  -- nullable: daily reports and owner notices are not tied to a contact
  contact_id       BIGINT      REFERENCES contacts (id) ON DELETE CASCADE,
  conversation_id  BIGINT      REFERENCES conversations (id) ON DELETE CASCADE,
  -- pitch | demo | reply | followup | acknowledgement | report | owner_command
  kind             TEXT        NOT NULL,
  -- queued | sent | dry_run | skipped | failed
  status           TEXT        NOT NULL DEFAULT 'queued',
  reason           TEXT,
  wa_message_id    TEXT,
  body_preview     TEXT,                                     -- first 120 chars, no secrets
  delivery_status  TEXT,                                     -- sent | delivered | read | failed | unknown
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ,
  CONSTRAINT outreach_kind_chk   CHECK (kind IN ('pitch', 'demo', 'reply', 'followup', 'acknowledgement', 'report', 'owner_command')),
  CONSTRAINT outreach_status_chk CHECK (status IN ('queued', 'sent', 'dry_run', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS outreach_created_idx ON outreach_events (created_at DESC);
CREATE INDEX IF NOT EXISTS outreach_kind_idx    ON outreach_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS outreach_contact_idx ON outreach_events (contact_id, created_at DESC);

-- ------------------------------------------------------------ owner actions --
CREATE TABLE IF NOT EXISTS owner_actions (
  id          BIGSERIAL PRIMARY KEY,
  owner_jid   TEXT        NOT NULL,
  command     TEXT        NOT NULL,
  args        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS owner_actions_created_idx ON owner_actions (created_at DESC);

-- ------------------------------------------------------------- daily reports --
-- One row per scheduled day. The UNIQUE date is what makes the 21:00 report
-- impossible to send twice, even across restarts or multiple processes.
CREATE TABLE IF NOT EXISTS daily_reports (
  id            BIGSERIAL PRIMARY KEY,
  report_date   DATE        NOT NULL UNIQUE,
  timezone      TEXT        NOT NULL DEFAULT 'Asia/Kolkata',
  content       TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'pending',      -- pending | sent | failed
  attempts      INTEGER     NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  CONSTRAINT daily_reports_status_chk CHECK (status IN ('pending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS daily_reports_pending_idx ON daily_reports (status) WHERE status = 'pending';

-- ----------------------------------------------------------------- app state --
CREATE TABLE IF NOT EXISTS app_state (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- ai events --
CREATE TABLE IF NOT EXISTS ai_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT        NOT NULL,                        -- openrouter | gemini
  model         TEXT,
  outcome       TEXT        NOT NULL,                        -- ok | error
  error_category TEXT,                                       -- timeout | rate_limit | quota | auth | http | invalid_response | network | unknown
  http_status   INTEGER,
  message_id    BIGINT      REFERENCES messages (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_events_provider_chk CHECK (provider IN ('openrouter', 'gemini')),
  CONSTRAINT ai_events_outcome_chk  CHECK (outcome IN ('ok', 'error'))
);

CREATE INDEX IF NOT EXISTS ai_events_created_idx ON ai_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_events_error_idx   ON ai_events (outcome, created_at DESC) WHERE outcome = 'error';

-- --------------------------------------------------- Baileys auth state (DB) --
-- Voroa has no persistent disk, so the WhatsApp session lives here instead of
-- on the filesystem. These two tables ARE credentials: restrict access.
CREATE TABLE IF NOT EXISTS wa_auth_creds (
  session_id  TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_auth_keys (
  session_id  TEXT        NOT NULL,
  type        TEXT        NOT NULL,                          -- pre-key, session, app-state-sync-key, ...
  key_id      TEXT        NOT NULL,
  value       JSONB,                                         -- NULL means "delete this key"
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, type, key_id)
);

CREATE INDEX IF NOT EXISTS wa_auth_keys_session_idx ON wa_auth_keys (session_id);

-- -----------------------------------------------------------------------------
-- Optional: tight permissions. Supabase's anon/authenticated roles should never
-- read the session tables. Uncomment after replacing the role name if you use
-- a dedicated DB user for the bot.
-- -----------------------------------------------------------------------------
-- ALTER TABLE wa_auth_creds ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE wa_auth_keys  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE contacts      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE outreach_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE owner_actions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE app_state     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ai_events     ENABLE ROW LEVEL SECURITY;

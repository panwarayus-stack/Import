# WhatsApp Business Outreach Bot

An **unofficial** WhatsApp bot for a small business. It answers people who already
wrote to you, sends *your* fixed pitch only to contacts you explicitly approved,
and sends you (the owner) a daily report at 21:00 Asia/Kolkata.

It is deliberately boring and restrictive: it does not scrape numbers, it does not
message strangers, it does not rotate proxies, and it does not try to look like a
phone that it is not. The safe default is **do not send**.

| | |
|---|---|
| Runtime | Node.js **22 LTS** or newer, ES modules |
| WhatsApp | [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) `7.0.0-rc14`, **pairing code** login |
| Database | **Supabase PostgreSQL** (`pg`), schema created automatically from `schema.sql` |
| AI | **OpenRouter** free router (`openrouter/free`) first → **Google Gemini Flash** free tier as fallback |
| Scheduling | one lightweight in-process tick (no cron daemon), timezone-safe for `Asia/Kolkata` |
| Tests | `npm test` → **54 passing** offline + database tests |

---

## 1. Read this before you run it

**This is not the official WhatsApp Business API.** It drives a normal WhatsApp
account through a reverse-engineered client. Consequences, stated plainly:

- WhatsApp can restrict, suspend or disconnect the number you pair. That risk is
  yours, and it grows with volume and with messaging people who did not ask to
  hear from you.
- There is **no uptime guarantee**. If the process dies, is redeployed, or is
  throttled by the host, messages wait (they are never lost — they are in Postgres).
- **Pairing and live connectivity have not been tested by the author of this
  repository.** Everything below that can be verified without a phone — schema,
  safety rules, AI routing, report scheduling, deduplication, dry-run behaviour —
  is covered by `npm test`. The actual pairing handshake with WhatsApp is the one
  step you must verify yourself on your own number.
- Only message people who asked you to. In many places unsolicited marketing is
  illegal (GDPR/ePrivacy in the EU, TRAI/DND rules in India, TCPA in the US), and
  the bot refusing to contact people you did not approve is a feature, not a bug.

### What this build will never do

No proxy rotation, no anti-ban evasion, no fingerprint spoofing, no bulk sending,
no scraping, no bypassing platform limits, no inventing prices/dates/features.
There is no code path that adds those.

---

## 2. Files

```
whatsapp-bot/
├── index.js         runtime: WhatsApp connection, routing, owner commands,
│                    scheduler, daily report, health endpoint, CLI entrypoint
├── ai.js            AI router: OpenRouter → Gemini fallback, strict JSON
│                    validation, category allowlist, prompt-injection guards
├── database.js      all SQL: contacts, conversations, messages, outreach,
│                    owner actions, reports, app state, Baileys session storage
├── schema.sql       the whole schema (tables, indexes, constraints)
├── package.json     scripts: start / doctor / reset-session / test / check
├── .env.example     every configuration key, with comments
├── .gitignore       .env, auth/, logs, node_modules
├── test.js          test suite (offline + real Postgres engine via PGlite)
└── README.md        this file
```

`node_modules/` and `package-lock.json` are created by `npm install`.

---

## 3. How a message flows

```
WhatsApp message
   │
   ├─ from a group / broadcast / status?        → dropped, never read
   ├─ from the owner's number, starts with "!"? → owner command (validated)
   ├─ sent by us?                               → ignored (no self-loops)
   └─ a person
        │
        ├─ contact already opted out?           → stored, never answered
        ├─ automation paused?                   → stored, never answered
        ├─ state = personal / pending_review?   → stored, never answered
        ├─ state not approved_business or
        │  bot_initiated?                       → stored, owner alerted
        └─ approved chat
             ├─ pacing + daily cap check        → skipped if over a limit
             ├─ AI: OpenRouter (bounded retries)
             │     └─ genuine failure/timeout/quota/bad JSON → Gemini
             │          └─ both failed → store as ai_failed, notify owner,
             │                           send nothing
             └─ validated JSON → deterministic action
                  interested / demo_requested / business_question → reply
                  demo_requested + DEMO_URL not sent yet          → link appended once
                  not_interested   → short acknowledgement, then stop
                  opt_out          → blocked immediately, owner notified
                  personal         → chat marked personal, silenced
                  unclear / needs_owner → nothing sent, queued for you
```

The AI **never decides whether to send**. It only proposes
`{"category": "...", "reply": "...", "send_demo": bool, "needs_owner": bool}`;
`index.js` validates it against the allowlist and then applies fixed rules.

Conversation states: `pending_review` → `approved_business` / `bot_initiated` →
`personal` / `opted_out` / `paused`.

---

## 4. Setup, step by step

You need: Node 22+, a Supabase account, one free OpenRouter key, optionally one
free Gemini key, and the WhatsApp number the bot will run on.

> **Never paste your database password or any API key into a chat, an issue, or a
> commit.** Everything goes into `.env` locally, or into the host's environment
> variable editor. This repository never asks for them.

### 4.1 Install

```bash
cd whatsapp-bot
npm ci            # or: npm install
cp .env.example .env
```

### 4.2 Create the database (Supabase)

1. <https://supabase.com> → **New project**. Save the database password in your
   password manager (you will not need to show it to anyone).
2. **Project Settings → Database → Connection string → URI**. Use the
   **Session pooler** URI when deploying to a free host; port `5432`, not the
   transaction pooler (`6543`).
3. Put it in `.env` as `DATABASE_URL`. Keep `DATABASE_SSL=require`.

You do not need to run any SQL by hand: on first start `database.js` reads
`schema.sql` and applies it statement by statement inside a transaction. Running
it twice is harmless (everything is `IF NOT EXISTS`).

Tables created: `contacts`, `conversations`, `messages`, `outreach_events`,
`owner_actions`, `daily_reports`, `app_state`, `ai_events`, `wa_auth_creds`,
`wa_auth_keys`.

Nothing secret is stored in these tables — the WhatsApp session (which *is*
sensitive) lives in `wa_auth_creds` / `wa_auth_keys`, because Voroa has no
persistent disk.

### 4.3 Get the AI keys

- **OpenRouter** — <https://openrouter.ai/keys> → create key. Leave
  `OPENROUTER_MODEL=openrouter/free`: it is a router that picks a random *free*
  model. Free tier is rate-limited (roughly 20 requests/minute; 50 requests/day
  until the account has bought $10 of credits, then 1,000/day). Never point it at
  a paid model id — a silent fallback to a paid model is exactly what this build
  avoids.
- **Gemini** (optional fallback) — <https://aistudio.google.com/apikey>. Keep
  `GEMINI_MODEL=gemini-3.8-flash` (free tier). `npm run doctor` lists the free
  Flash models your key can actually use. If the model is not on the documented
  free list, `loadConfig()` warns and `GEMINI_FORCE_MODEL=false` refuses it.

If both providers fail, the message is stored with `processing_status='ai_failed'`
and you are notified. **No invented answer is ever sent** in that case.

### 4.4 Fill in `.env`

Only these are mandatory:

| Key | Meaning |
|---|---|
| `OWNER_NUMBER` | digits only, country code, no `+`/spaces, e.g. `919876543210` — this is the number the bot runs on and the one that receives the report |
| `DATABASE_URL` | Supabase URI |
| `OPENROUTER_API_KEY` | free key |
| `GEMINI_API_KEY` | optional fallback key |
| `BUSINESS_NAME`, `BUSINESS_DESCRIPTION` | the only facts the AI may state |
| `FIXED_PITCH` | the exact first message `!pitch` sends. Write it yourself |
| `DEMO_URL` | link sent once when someone asks for a sample |

Worth understanding:

| Key | Default | Why |
|---|---|---|
| `DRY_RUN` | `true` | nothing is sent; every intended message is logged and stored |
| `MAX_OUTBOUND_PER_DAY` | `20` (clamped ≤ 200) | hard cap per local day; `0` means send nothing |
| `MIN_SECONDS_BETWEEN_MESSAGES` | `20` | pacing between any two outgoing messages |
| `MAX_MESSAGE_LENGTH` | `900` | replies are truncated to this |
| `MAX_OWNER_ALERTS_PER_HOUR` | `6` | stops alert storms |
| `REPORT_TIME` / `REPORT_TIMEZONE` | `21:00` / `Asia/Kolkata` | daily report |
| `REPORT_RETRY_INTERVAL_MS` | `300000` | retry a report that could not be delivered |
| `AUTH_STATE` | `database` | `file` only if you have a real disk |
| `ADMIN_NUMBERS` | empty | extra phones allowed to send commands |
| `PAIRING_NUMBER` | = `OWNER_NUMBER` | number that receives the pairing code |
| `COMMAND_PREFIX` | `!` | for `!help`, `!status`, … |
| `ALLOW_PRICE_TALK`, `ALLOW_PROMISES`, `ALLOW_DELIVERY_COMMITMENTS`, `ALLOW_UNVERIFIED_ACTION_CLAIMS` | `false` | keep them false; they gate AI content |
| `ALLOW_AI_REWRITE_PITCH` | `false` | the pitch stays exactly as you wrote it |
| `SEND_OPTOUT_ACKNOWLEDGEMENT` | `false` | off = a person who opts out gets complete silence |
| `HEALTH_PORT` | `0` (off) | set e.g. `8080` if you deploy as a web service |

### 4.5 Check the configuration

```bash
npm run doctor
```

It prints (never the secrets themselves): dry-run state, masked owner numbers,
report time, whether the database is reachable, whether `schema.sql` applies,
whether a WhatsApp session is already stored, and what each AI provider says.
Fix every `error` line before going further. `warning` lines are advisory.

---

## 5. Pairing the WhatsApp number

> **Not verified in this repository.** Follow the steps; if WhatsApp rejects the
> code, the most common causes are listed at the end of this section.

1. `DRY_RUN=true` for now. Start the bot:
   ```bash
   npm start
   ```
2. Within a few seconds the log shows:
   ```
   PAIRING CODE for 9198****10: ABCD-EFGH — open WhatsApp → Linked devices → Link with phone number
   ```
3. On the phone that owns `OWNER_NUMBER`: **WhatsApp → Settings → Linked devices
   → Link a device → Link with phone number instead**, then type the code.
4. The log should show `WhatsApp connected as 9198…`. The session is written to
   Postgres (`wa_auth_creds` / `wa_auth_keys`), so a restart does not need a new code.
5. If the code expires, restart the bot to get a fresh one. If the session is
   corrupt, run `npm run reset-session` (deletes the stored session only — never
   your contacts or messages) and pair again.

Reconnect behaviour: non-fatal disconnects retry with exponential backoff
(capped), `loggedOut` (401) stops and asks for a new pairing, `restartRequired`
(515) restarts immediately. Duplicate messages after a reconnect are ignored —
`messages.wa_message_id` is `UNIQUE` and inserts use `ON CONFLICT DO NOTHING`.

---

## 6. Dry-run testing (do this first, for at least a day)

With `DRY_RUN=true` nothing leaves the phone. Every would-be message is logged
(`[DRY RUN] would send …`) and stored in `outreach_events` with status `dry_run`.

```bash
# 1. start
npm start

# 2. in WhatsApp, message the bot number from another phone
#    → the contact appears with approval_status = pending and no reply is sent

# 3. in the owner chat, send:
!status
!pending
!approve 91XXXXXXXXXX asked on Instagram for a quote
!permission 91XXXXXXXXXX asked me on Instagram for a quote on 20 Oct
!pitch 91XXXXXXXXXX
!approvechat 91XXXXXXXXXX
!report
```

Again from the other phone, ask a question. In dry-run you should see a
`[DRY RUN] would send reply` log line and a new `messages` row — and the other
phone should receive **nothing**.

Things worth trying, because these are the failures that matter:
- Send `please stop messaging me` → contact becomes `opted_out`, all later
  messages are stored and ignored.
- Ask something personal ("are we still meeting for lunch") → the chat is marked
  `personal`, no business reply.
- Temporarily break `OPENROUTER_API_KEY` and `GEMINI_API_KEY` → the message is
  stored as `ai_failed`, the owner is warned, nothing is sent.
- Send `!pause` then a customer message → nothing is sent. `!resume` re-enables it.

When dry-run behaves the way you expect, flip `DRY_RUN=false` and restart.

---

## 7. Owner commands

Sent from the owner's own number (self-chat) or from a number in
`ADMIN_NUMBERS`. Commands from anyone else are ignored and logged — they never
touch the database and never get a reply. There is no shell access, no `eval`,
and every argument is validated.

| Command | What it does |
|---|---|
| `!help` | the command list |
| `!status` | connection, dry-run state, pause state, today's counters, report status |
| `!pending` | conversations waiting for you (approval / classification / review) |
| `!approve <number> [note]` | mark a contact approved. Sends nothing |
| `!permission <number> <how consent was obtained>` | record where the permission came from — required before `!pitch` |
| `!pitch <number>` | send your `FIXED_PITCH` once. Refused without permission, once per contact |
| `!approvechat <number>` | allow automated replies in that chat |
| `!classify <number> business\|personal [reason]` | set the classification yourself |
| `!pause [reason]` / `!resume` | stop / allow all automation (the pause survives restarts) |
| `!report` | send the daily report now |
| `!optout <number> [reason]` | block all future outreach immediately |
| `!optin <number> <evidence>` | undo an opt-out — requires written evidence of re-consent |
| `!logs` | operational summary: last errors, counters, whether paused |
| `!whoami` | shows which chat the commands are coming from |

Two rules are enforced in code, not by convention:

1. **No outreach without recorded permission.** `!approve` alone is not enough;
   `!pitch` refuses until `!permission` has stored a reason.
2. **Opt-out is absolute.** It outranks every AI category, blocks sends even in an
   approved chat, and can only be reversed by `!optin` with evidence.

---

## 8. The daily report

At `21:00 Asia/Kolkata` the bot builds a report and stores it in
`daily_reports` (`report_date` is `UNIQUE`, so there can only ever be one per day).

- Counts only business conversations; personal chats are excluded from every metric.
- Contains: messages in/out, replies, interested, demo requests, not-interested,
  opt-outs, pending reviews, AI failures, send errors, connection errors, and the
  change versus the last report.
- **Never duplicated:** delivery marks the row `sent`; a second attempt sees
  `sent` and stops. If a crash happens between sending and marking, the row is
  still `sent`-checked on the next run — the report is stored before it is sent.
- **Survives restarts and offline periods:** a pending report is retried every
  `REPORT_RETRY_INTERVAL_MS` and delivered as soon as WhatsApp is connected again.
- `!report` sends the current one immediately without disturbing the 21:00 job.

Timezone handling is explicit (`Asia/Kolkata`, no UTC guessing): "today" starts at
00:00 IST = 18:30 UTC the previous day, and the scheduler compares the local
minute-of-day, so a restart at 21:05 still produces that day's report.

---

## 9. Deploying to Voroa

Voroa (getvoroa.com) can run a continuous Node process. Two shapes work; the
**Background worker** is the better fit because this bot has no web UI.

> Free-tier figures below were read from Voroa's site on **2026-10-24** and can
> change — check the current pricing page before relying on them.

| | |
|---|---|
| Free plan | 15 services, 500 build minutes/month, **750 instance-hours/month**, 1 team member, 2 custom domains |
| Free instance | ~0.1 CPU / 512 MB RAM (Nano) |
| Always-on | free services do not cold-start; WebSockets are supported |
| Persistent disk | **not available** — the filesystem is temporary |
| Hour budget | 750 h/month ≈ 31 days × 24 h, i.e. *one* always-on service |

That last point is the one that matters: **do not use `AUTH_STATE=file`**. On the
first deploy the session would be written to a filesystem that disappears, and
every restart would need a new pairing code. Use the default
`AUTH_STATE=database`, which keeps the WhatsApp session in Supabase. (The bot
warns loudly at startup if you choose `file`.)

### 9.1 Deploy

1. Push this folder to a Git repository (`.env` is git-ignored — never commit it).
2. Voroa → **New service** → import the repo.
3. Settings:
   - **Root directory**: `whatsapp-bot` (if the bot lives in a subfolder)
   - **Build command**: `npm ci`
   - **Start command**: `npm start`
   - **Service type**: Background worker (portless). If you must use the web
     service type instead, set `HEALTH_PORT=8080` and point the health check at
     `/healthz`.
   - **Node version**: 22
4. Add every variable from your `.env` in the environment editor — starting with
   `DRY_RUN=true` so the first deploy cannot send anything.
5. Deploy, then open the runtime logs. A healthy boot looks like:
   ```
   Database ready
   Daily report scheduled for 21:00 Asia/Kolkata …
   Health endpoint on :8080/healthz        (only if HEALTH_PORT is set)
   PAIRING CODE for 9198****10: XXXX-XXXX  (first boot only)
   WhatsApp connected as 9198…
   ```
6. Pair with the code (section 5). Check `!status` from the owner chat.

**Logs / restarts:** Voroa keeps runtime logs per service and restarts the process
if it exits. Restarting is safe: the session is in Postgres and unprocessed
messages are in the database, so nothing is lost. A deploy that crashes at boot
is reported as "failed to start" and can be rolled back in one click.

**Health check (web-service mode only):** `GET /healthz` returns `200` with
`{"ok":true,...}` when the database is reachable **and** WhatsApp is connected;
otherwise `503` with the reason.

### 9.2 If Voroa is not a good fit

Anything that runs a Node process 24/7 works: a small VPS (₹300–500/month),
a Raspberry Pi at home, Railway/Fly/Render (paid continuous workers), or Docker:

```bash
# no Dockerfile ships with this bot; a two-line one is enough:
#   FROM node:22-slim
#   WORKDIR /app
#   COPY package*.json ./
#   RUN npm ci --omit=dev
#   COPY . .
#   CMD ["npm", "start"]
docker build -t wa-outreach .
docker run --env-file .env --restart unless-stopped wa-outreach
```

Free hosts that sleep on inactivity, or that only run functions, are the wrong
shape for a WhatsApp connection: when the process stops, WhatsApp disconnects and
your report window can be missed. The bot handles restarts gracefully, but it
cannot receive messages while it is not running.

---

## 10. Going live: the checklist

Do these in order. Each line is something you can verify, not a hope.

- [ ] `npm run doctor` shows **no error lines**, database reachable, schema OK.
- [ ] `npm test` passes (54 tests).
- [ ] You have watched at least one full dry-run day, including one `!report`.
- [ ] Every contact in `contacts` is someone who agreed to hear from you; each has
      a `permission_note` recorded with `!permission`.
- [ ] `FIXED_PITCH` reads well as a first contact message and does not promise
      anything you cannot deliver.
- [ ] `MAX_OUTBOUND_PER_DAY` is set to a number you can personally answer (10–20 is
      plenty for a small studio).
- [ ] `ALLOW_PRICE_TALK`, `ALLOW_PROMISES`, `ALLOW_DELIVERY_COMMITMENTS`,
      `ALLOW_UNVERIFIED_ACTION_CLAIMS` and `ALLOW_AI_REWRITE_PITCH` are all `false`.
- [ ] `SEND_OPTOUT_ACKNOWLEDGEMENT` is `false` unless your local rules require a
      confirmation message.
- [ ] You know how to stop everything: `!pause` (survives restarts) or stop the service.
- [ ] `DRY_RUN=false`, restart, and send one message from a phone you control.
- [ ] The reply arrives, appears in `messages` with `direction='outbound'`, and the
      AI provider used is visible in `ai_events`.
- [ ] `!report` behaves, and the 21:00 report arrives on the first evening.
- [ ] Opt-out test on a test contact: the chat goes silent immediately.
- [ ] You have a plan for what happens when the number is disconnected (this is a
      real possibility with an unofficial client).

---

## 11. The 18-point test checklist

These are the behaviours the code is built around. The first 12 are automated
(`npm test`); the last 6 need a phone, so check them by hand in dry-run.

1. `schema.sql` applies cleanly, twice (idempotent).
2. Contacts are unique per WhatsApp id; a contact is created as
   `approval_status='pending'`.
3. Opt-out is recorded, and re-consent requires explicit evidence.
4. An inbound message is stored exactly once per WhatsApp message id.
5. Outreach counters, pacing data and delivery receipts are recorded.
6. The daily report row is unique per date and can only be marked sent once.
7. Personal conversations are excluded from every report/per-command metric.
8. The WhatsApp session round-trips through Postgres with Buffers intact.
9. Pause state, owner actions and the pending queue persist.
10. An unapproved contact is stored and reviewed but never answered, and the AI is
    not even called.
11. An approved chat gets one validated reply; a replayed message id does not
    trigger a second one.
12. AI provider failure stores the message as `ai_failed`, notifies the owner, and
    sends nothing.
13. Group / broadcast / status messages never reach the handler.
14. Messages from non-owner numbers that look like commands are ignored without a
    reply and without a database write.
15. `!pitch` refuses without `!permission`, and sends exactly once per contact.
16. `!pause` blocks sends in an approved chat; `!resume` re-enables them.
17. The per-day send cap blocks the extra message.
18. The 21:00 report is generated once per day and delivered once, including after
    an offline period.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Invalid configuration` at boot | `doctor` prints the exact keys; usually `OWNER_NUMBER` has `+` or spaces |
| `PAIRING CODE` never appears | WhatsApp already linked, or `OWNER_NUMBER` malformed; `npm run reset-session` then restart |
| `Connection closed (loggedOut, 401)` | the device was removed on the phone; pair again |
| `Connection closed (restartRequired, 515)` | normal after pairing — the bot reconnects by itself |
| `password authentication failed` | wrong Supabase password, or the transaction pooler (6543) instead of the session pooler (5432) |
| `self-signed certificate` / SSL errors | keep `DATABASE_SSL=require` (or `verify-full` if your CA is configured) |
| AI always failing | key/quota. `ai_events` has the provider, error category and time for every attempt |
| Replies stopped | `!status` — paused? daily cap reached? contact not approved? |
| No 21:00 report | check `daily_reports.status`; `!report` forces one for today |
| Nothing works after a redeploy | `AUTH_STATE` was `file`; switch to `database` and pair again |

---

## 13. Privacy and logging

- Logs never contain message bodies (only masked numbers such as `919*****10`),
  never API keys, never the database URL. `pino` redacts `apiKey`/`authorization`.
- Message bodies live only in your Postgres database, in `messages.body`.
- `.env` is git-ignored; `auth/` (file-session mode) is git-ignored too.
- `owner_actions` records which command you ran, with the argument — that is your
  audit trail, and `!logs` summarises it.
- To delete someone completely, remove their rows from `contacts` (conversations,
  messages and outreach events cascade).

---

## 14. License

MIT. Use it on your own number, with your own database, and only for people who
asked to hear from you.

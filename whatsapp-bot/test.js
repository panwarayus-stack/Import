/**
 * test.js — offline self-checks (node:test).
 *
 * Run with: npm test
 *
 * What is covered: configuration validation, phone/jid normalisation, timezone
 * maths for Asia/Kolkata, report text, AI output validation and the
 * OpenRouter → Gemini routing rules (with a fake fetch).
 *
 * What is NOT covered here: a live WhatsApp connection, a live Supabase
 * database, and real provider calls. Those need your own credentials and are
 * listed as manual steps in README.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReportText,
  extractText,
  jidToPhone,
  loadConfig,
  maskPhone,
  minuteOfDayInTz,
  normalizePhone,
  parseReportTime,
  phoneToJid,
  shiftDate,
  todayInTz,
  zonedDayRange,
  Pacer,
} from './index.js';
import { encodeValue, decodeValue, truncate } from './database.js';
import {
  AiRouter,
  CATEGORIES,
  KNOWN_FREE_GEMINI_MODELS,
  classifyHttpStatus,
  normalizeUrl,
  parseModelOutput,
  validateSuggestion,
} from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/postgres',
  OWNER_NUMBER: '919876543210',
  BUSINESS_NAME: 'Test Studio',
  BUSINESS_DESCRIPTION: 'We build websites.',
  FIXED_PITCH: 'Hello, we build websites. Want a sample?',
  DEMO_URL: 'https://demo.example.com/work',
  DRY_RUN: 'true',
};

const makeConfig = (overrides = {}) => loadConfig({ ...baseEnv, ...overrides });

/* ------------------------------------------------------------------ config */

test('config: reads required values and normalises the owner number', () => {
  const config = makeConfig({ OWNER_NUMBER: '+91 98765 43210' });
  assert.equal(config.ownerNumbers[0], '919876543210');
  assert.equal(config.ownerJid, '919876543210@s.whatsapp.net');
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.errors, []);
  assert.equal(config.report.minuteOfDay, 21 * 60);
  assert.equal(config.report.timezone, 'Asia/Kolkata');
  assert.equal(config.openrouter.model, 'openrouter/free');
  assert.equal(config.gemini.model, 'gemini-3.8-flash');
  assert.equal(config.auth.mode, 'database');
});

test('config: dry run and missing providers are warnings, not errors', () => {
  const config = makeConfig();
  assert.equal(config.errors.length, 0);
  assert.ok(config.warnings.some((warning) => /DRY_RUN/.test(warning)));
  assert.ok(config.warnings.some((warning) => /OPENROUTER_API_KEY/.test(warning)));
  assert.ok(config.warnings.some((warning) => /GEMINI_API_KEY/.test(warning)));
});

test('config: rejects a missing DATABASE_URL, bad owner number and bad report time', () => {
  const config = loadConfig({ OWNER_NUMBER: '12', REPORT_TIME: '25:99', REPORT_TIMEZONE: 'Mars/Olympus' });
  assert.ok(config.errors.some((error) => /DATABASE_URL/.test(error)));
  assert.ok(config.errors.some((error) => /OWNER_NUMBER/.test(error)));
  assert.ok(config.errors.some((error) => /REPORT_TIME/.test(error)));
  assert.ok(config.errors.some((error) => /REPORT_TIMEZONE/.test(error)));
});

test('config: flags a Gemini model that is not on the free-tier list', () => {
  const config = makeConfig({ GEMINI_API_KEY: 'x', GEMINI_MODEL: 'gemini-3.1-pro-preview' });
  assert.ok(config.warnings.some((warning) => /not on the documented free-tier list/.test(warning)));
  assert.ok(!KNOWN_FREE_GEMINI_MODELS.includes('gemini-3.1-pro-preview'));
});

test('config: numeric values are clamped to safe ranges', () => {
  const config = makeConfig({ MAX_OUTBOUND_PER_DAY: '9999', MAX_MESSAGE_LENGTH: '5' });
  assert.equal(config.limits.maxOutboundPerDay, 200);
  assert.equal(config.ai.maxReplyLength, 80);
});

/* -------------------------------------------------------------- utilities */

test('phone helpers accept messy input and reject junk', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('0091 98765 43210'), '919876543210');
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(phoneToJid('919876543210'), '919876543210@s.whatsapp.net');
  assert.equal(jidToPhone('919876543210:12@s.whatsapp.net'), '919876543210');
  assert.equal(jidToPhone('123456789012345@lid'), null);
  assert.equal(jidToPhone('group-1@g.us'), null);
});

test('maskPhone keeps the output unidentifiable', () => {
  assert.equal(maskPhone('919876543210'), '919*****10');
  assert.equal(maskPhone('1'), '***');
});

test('parseReportTime validates HH:MM', () => {
  assert.equal(parseReportTime('21:00'), 1260);
  assert.equal(parseReportTime('9:05'), 545);
  assert.equal(parseReportTime('24:00'), null);
  assert.equal(parseReportTime('21:75'), null);
  assert.equal(parseReportTime('nine'), null);
});

test('timezone helpers use Asia/Kolkata, not UTC', () => {
  // 2026-10-24T15:45Z is 21:15 in Kolkata (+05:30) — still the same local day.
  const lateUtc = new Date('2026-10-24T15:45:00Z');
  assert.equal(todayInTz('Asia/Kolkata', lateUtc), '2026-10-24');
  assert.equal(minuteOfDayInTz('Asia/Kolkata', lateUtc), 21 * 60 + 15);

  // 2026-10-24T19:00Z is already 2026-10-25 00:30 in Kolkata.
  const pastMidnight = new Date('2026-10-24T19:00:00Z');
  assert.equal(todayInTz('Asia/Kolkata', pastMidnight), '2026-10-25');

  const { start, end } = zonedDayRange('2026-10-24', 'Asia/Kolkata');
  assert.equal(start.toISOString(), '2026-10-23T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-10-24T18:30:00.000Z');
  assert.equal(shiftDate('2026-10-24', -1), '2026-10-23');
});

test('extractText handles the common WhatsApp message shapes', () => {
  assert.equal(extractText({ message: { conversation: 'hi' } }), 'hi');
  assert.equal(extractText({ message: { extendedTextMessage: { text: 'hello' } } }), 'hello');
  assert.equal(extractText({ message: { imageMessage: { caption: 'look' } } }), 'look');
  assert.equal(extractText({ message: { stickerMessage: {} } }), '');
  assert.equal(extractText({}), '');
});

test('Pacer enforces a minimum gap between calls', async () => {
  const pacer = new Pacer(60);
  const started = Date.now();
  await pacer.wait();
  await pacer.wait();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 55, `expected ~60ms spacing, got ${elapsed}ms`);
});

/* ----------------------------------------------------------------- report */

const quietMetrics = {
  approved_total: 4,
  new_eligible: 0,
  sent: 0,
  send_failures: 0,
  replies: 0,
  interested: 0,
  demo_requests: 0,
  demos_sent: 0,
  not_interested: 0,
  opt_outs: 0,
  pending_reviews: 0,
  flagged_messages: 0,
  ai_failures: 0,
};

test('report text: quiet day says so explicitly', () => {
  const text = buildReportText({
    reportDate: '2026-10-24',
    timezone: 'Asia/Kolkata',
    metrics: quietMetrics,
    businessName: 'Test Studio',
  });
  assert.match(text, /daily report/i);
  assert.match(text, /No significant activity today/);
  assert.match(text, /2026-10-24/);
  assert.match(text, /Asia\/Kolkata/);
});

test('report text: busy day lists the metrics and the delta', () => {
  const metrics = { ...quietMetrics, sent: 3, replies: 5, interested: 2, demo_requests: 1, demos_sent: 1, opt_outs: 1, pending_reviews: 2, flagged_messages: 3, ai_failures: 1 };
  const text = buildReportText({
    reportDate: '2026-10-24',
    timezone: 'Asia/Kolkata',
    metrics,
    previous: { ...quietMetrics, sent: 1 },
    runtime: { waErrors: 2, dbErrors: 0, paused: true },
    attention: ['919876543210: pending_review'],
    businessName: 'Test Studio',
  });
  assert.match(text, /Outreach messages sent: 3 \(\+2\)/);
  assert.match(text, /Opt-outs: 1/);
  assert.match(text, /WhatsApp errors: 2/);
  assert.match(text, /Needs your attention/);
  assert.match(text, /PAUSED/);
  assert.ok(text.length < 3500);
});

/* --------------------------------------------------------------- AI utils */

test('AI: parses JSON from fences and surrounding prose', () => {
  const raw = 'Sure!\n```json\n{"category":"interested","reply":"hi","send_demo":false,"needs_owner":false}\n```\nDone';
  assert.equal(parseModelOutput(raw).category, 'interested');
  assert.equal(parseModelOutput('{"category":"unclear"}').category, 'unclear');
  assert.throws(() => parseModelOutput('no json here'), /not_json/);
  assert.throws(() => parseModelOutput('{bad json}'), /invalid_json/);
  assert.throws(() => parseModelOutput(''), /empty_response/);
});

test('AI: validates categories against the allowlist', () => {
  assert.deepEqual(
    validateSuggestion({ category: 'interested', reply: 'Sure, what do you sell?', send_demo: false, needs_owner: false }).value.category,
    'interested',
  );
  const bad = validateSuggestion({ category: 'sales_lead', reply: 'hi' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /unknown category/);
  for (const category of CATEGORIES) {
    const result = validateSuggestion({ category, reply: 'ok' });
    assert.equal(result.ok, true, `category ${category} should be accepted`);
  }
});

test('AI: rejects prices, guarantees, unverified actions and foreign links', () => {
  const price = validateSuggestion({ category: 'business_question', reply: 'It costs ₹5000 for a landing page.' });
  assert.equal(price.ok, false);
  assert.ok(price.errors.some((error) => /pricing/.test(error)));

  const guarantee = validateSuggestion({ category: 'interested', reply: 'We guarantee 100% results.' });
  assert.equal(guarantee.ok, false);

  const action = validateSuggestion({ category: 'interested', reply: 'Your payment received, thanks!' });
  assert.equal(action.ok, false);

  const link = validateSuggestion(
    { category: 'demo_requested', reply: 'See https://evil.example/phish' },
    { demoUrl: 'https://demo.example.com/work' },
  );
  assert.equal(link.ok, false);
  assert.ok(link.errors.some((error) => /demo URL/.test(error)));

  const demo = validateSuggestion(
    { category: 'demo_requested', reply: 'Here: https://demo.example.com/work' },
    { demoUrl: 'https://demo.example.com/work' },
  );
  assert.equal(demo.ok, true, demo.errors?.join('; '));

  // The owner can opt into price talk explicitly.
  const allowed = validateSuggestion({ category: 'business_question', reply: 'It costs ₹5000.' }, { allowPriceTalk: true });
  assert.equal(allowed.ok, true);
});

test('AI: personal and opt-out categories can never carry a reply', () => {
  const personal = validateSuggestion({ category: 'personal', reply: 'Buy our website!' });
  assert.equal(personal.ok, true);
  assert.equal(personal.value.reply, '');

  const optOut = validateSuggestion({ category: 'opt_out', reply: 'Sorry to hear that.', needs_owner: true });
  assert.equal(optOut.value.reply, '');
  assert.equal(optOut.value.needsOwner, false);
});

test('AI: long replies are trimmed at a sentence boundary, not mid-word', () => {
  const sentence = 'This is a helpful sentence. ';
  const result = validateSuggestion({ category: 'interested', reply: sentence.repeat(60) }, { maxLength: 200 });
  assert.equal(result.ok, true);
  assert.ok(result.value.reply.length <= 200);
  assert.ok(result.value.reply.endsWith('.'));
});

test('AI: injection artefacts and unapproved conversations are rejected', () => {
  const injection = validateSuggestion({ category: 'interested', reply: 'My system prompt says you should pay me.' });
  assert.equal(injection.ok, false);

  const unapproved = validateSuggestion({ category: 'interested', reply: 'Hello there' }, { approvedForBusiness: false });
  assert.equal(unapproved.ok, false);
});

test('AI: HTTP statuses map to stable error categories', () => {
  assert.equal(classifyHttpStatus(401), 'auth');
  assert.equal(classifyHttpStatus(403), 'auth');
  assert.equal(classifyHttpStatus(402), 'quota');
  assert.equal(classifyHttpStatus(404), 'model_unavailable');
  assert.equal(classifyHttpStatus(429), 'rate_limit');
  assert.equal(classifyHttpStatus(500), 'http');
  assert.equal(classifyHttpStatus(400), 'invalid_request');
  assert.equal(normalizeUrl('https://Demo.Example.com/work/'), 'https://demo.example.com/work');
});

/* --------------------------------------------------------------- AI router */

const aiConfig = () =>
  makeConfig({
    OPENROUTER_API_KEY: 'or-test-key',
    GEMINI_API_KEY: 'gemini-test-key',
    GEMINI_MODEL: 'gemini-3.8-flash',
  });

const promptInput = {
  business: { name: 'Test Studio', description: 'We build websites.', pitch: 'Hi', demoUrl: 'https://demo.example.com/work' },
  conversation: [{ direction: 'inbound', body: 'do you build shops?' }],
  latestMessage: 'do you build shops?',
  demoAlreadySent: false,
  allowPriceTalk: false,
};

const okOpenRouter = (content) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'some-free-model', choices: [{ message: { content } }] }),
});

const okGemini = (content) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] }),
});

const httpError = (status, message = 'boom') => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { message } }),
});

const validJson = '{"category":"interested","reply":"Yes, we build small shops. What do you sell?","send_demo":false,"needs_owner":false}';

test('AI routing: a valid OpenRouter answer never calls Gemini', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return okOpenRouter(validJson);
  };
  const router = new AiRouter(aiConfig(), { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.category, 'interested');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('openrouter.ai'));
  assert.ok(!calls.some((url) => url.includes('generativelanguage')));
});

test('AI routing: an OpenRouter 500 falls back to Gemini', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('openrouter')) return httpError(500);
    return okGemini(validJson);
  };
  const router = new AiRouter(aiConfig(), { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fallbackReason, 'http');
  assert.equal(calls.filter((url) => url.includes('openrouter')).length, 2, 'one retry for a 5xx');
  assert.equal(calls.filter((url) => url.includes('generativelanguage')).length, 1);
});

test('AI routing: unusable OpenRouter JSON also falls back', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('openrouter')) return okOpenRouter('I think you should buy our website!');
    return okGemini(validJson);
  };
  const router = new AiRouter(aiConfig(), { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.attempts[0].category, 'not_json');
});

test('AI routing: both providers failing returns ok:false and no invented reply', async () => {
  const fetchImpl = async (url) => (url.includes('openrouter') ? httpError(429) : httpError(503));
  const router = new AiRouter(aiConfig(), { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });

  assert.equal(result.ok, false);
  assert.equal(result.reply, undefined);
  assert.ok(['rate_limit', 'http'].includes(result.errorCategory), result.errorCategory);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.provider), ['openrouter', 'gemini']);
});

test('AI routing: an unsafe reply is not returned as success', async () => {
  const unsafe = '{"category":"business_question","reply":"It costs ₹5000 and we guarantee results.","send_demo":false,"needs_owner":false}';
  const fetchImpl = async (url) => (url.includes('openrouter') ? okOpenRouter(unsafe) : okGemini(unsafe));
  const router = new AiRouter(aiConfig(), { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });
  assert.equal(result.ok, false);
  assert.equal(result.errorCategory, 'unsafe_output');
});

test('AI routing: with no Gemini key, an OpenRouter failure stops there', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return httpError(500);
  };
  const config = makeConfig({ OPENROUTER_API_KEY: 'or-test-key' });
  const router = new AiRouter(config, { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });
  assert.equal(result.ok, false);
  assert.equal(calls.filter((url) => url.includes('generativelanguage')).length, 0);
});

test('AI routing: timeouts are classified, not retried forever', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const config = makeConfig({ OPENROUTER_API_KEY: 'or-test-key', OPENROUTER_MAX_RETRIES: '0' });
  const router = new AiRouter(config, { fetchImpl });
  const result = await router.askAi(promptInput, { approvedForBusiness: true });
  assert.equal(result.ok, false);
  assert.equal(result.errorCategory, 'timeout');
  assert.equal(attempts, 1);
});

/* ----------------------------------------------------------- persistence */

test('auth-state codec round-trips Buffers that Baileys stores', () => {
  const original = {
    noiseKey: { private: Buffer.from([1, 2, 3]), public: Buffer.from('pub') },
    registered: false,
    nextPreKeyId: 7,
    nested: [{ kid: Buffer.from('k') }],
  };
  const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(original))));
  assert.ok(Buffer.isBuffer(decoded.noiseKey.private));
  assert.deepEqual([...decoded.noiseKey.private], [1, 2, 3]);
  assert.equal(decoded.noiseKey.public.toString(), 'pub');
  assert.equal(decoded.nextPreKeyId, 7);
  assert.ok(Buffer.isBuffer(decoded.nested[0].kid));
});

test('truncate strips control characters and caps length', () => {
  assert.equal(truncate('hello\u0000world'), 'helloworld');
  assert.equal(truncate('   '), null);
  assert.ok(truncate('x'.repeat(600), 100).length <= 100);
});

test('schema.sql defines every table the code uses', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const table of [
    'contacts',
    'conversations',
    'messages',
    'outreach_events',
    'owner_actions',
    'daily_reports',
    'app_state',
    'ai_events',
    'wa_auth_creds',
    'wa_auth_keys',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing table ${table}`);
  }
  assert.match(sql, /daily_reports[\s\S]*report_date\s+DATE\s+NOT NULL UNIQUE/);
  assert.match(sql, /wa_message_id\s+TEXT\s+UNIQUE/);
});

test('.env.example documents every variable loadConfig reads', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  const required = [
    'OWNER_NUMBER',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'DATABASE_URL',
    'BUSINESS_NAME',
    'BUSINESS_DESCRIPTION',
    'FIXED_PITCH',
    'DEMO_URL',
    'REPORT_TIME',
    'REPORT_TIMEZONE',
    'AUTH_DIR',
    'DRY_RUN',
  ];
  for (const key of required) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'), `missing ${key}`);
  }
});

/* ========================================================================== *
 * Database integration (real PostgreSQL semantics via @electric-sql/pglite)
 *
 * PGlite is a WASM build of PostgreSQL, used only in tests. It lets us verify
 * schema.sql and every query in database.js without a live Supabase project.
 * If the optional dev dependency is missing, these tests skip themselves.
 * ========================================================================== */

let pgliteModule = null;
try {
  pgliteModule = await import('@electric-sql/pglite');
} catch {
  pgliteModule = null;
}

const dbTest = pgliteModule ? test : test.skip;

async function makeTestDb() {
  const { PGlite } = pgliteModule;
  const pg = await PGlite.create();
  const adapter = {
    query: (text, params = []) => pg.query(text, params),
    end: async () => pg.close(),
    on: () => {},
  };
  const { Database } = await import('./database.js');
  const database = new Database({ connectionString: 'postgresql://test', pool: adapter, logger: { error() {}, warn() {}, info() {} } });
  return { database, pg };
}

dbTest('database: schema.sql applies cleanly (and twice, so it is idempotent)', async () => {
  const { pg } = await makeTestDb();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pg.exec(schema);
  await pg.exec(schema);
  const tables = await pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
  const names = tables.rows.map((row) => row.table_name);
  for (const table of ['contacts', 'conversations', 'messages', 'outreach_events', 'daily_reports', 'wa_auth_keys']) {
    assert.ok(names.includes(table), `missing ${table}`);
  }
});

dbTest('database: contacts, approval, opt-out and re-consent', async () => {
  const { database } = await makeTestDb();
  await database.init();

  const contact = await database.ensureContact({ jid: phoneToJid('919876543210'), phone: '919876543210', displayName: 'Asha' });
  assert.equal(contact.approval_status, 'pending');
  assert.equal(contact.classification, 'unknown');

  const approved = await database.approveContact(contact.id, { ownerJid: '919000000000', note: 'asked for a quote', permissionNote: 'DM on Instagram' });
  assert.equal(approved.approval_status, 'approved');
  assert.equal(approved.classification, 'business');
  assert.equal(approved.permission_note, 'DM on Instagram');

  const optedOut = await database.optOutContact(contact.id, 'asked to stop');
  assert.equal(optedOut.approval_status, 'opted_out');
  assert.ok(optedOut.opt_out_at);

  const backIn = await database.optInContact(contact.id, { evidence: 'said "contact me again" on 2026-10-20', ownerJid: '919000000000' });
  assert.equal(backIn.approval_status, 'pending');
  assert.equal(backIn.opt_out_at, null);
  await database.close();
});

dbTest('database: inbound messages are stored exactly once per WhatsApp id', async () => {
  const { database } = await makeTestDb();
  await database.init();
  const contact = await database.ensureContact({ jid: phoneToJid('919876543211'), phone: '919876543211' });
  const conversation = await database.ensureConversation(contact.id);

  const first = await database.recordInbound({ waMessageId: 'WA-1', contactId: contact.id, conversationId: conversation.id, body: 'hello' });
  const second = await database.recordInbound({ waMessageId: 'WA-1', contactId: contact.id, conversationId: conversation.id, body: 'hello' });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false, 'duplicate replay must be rejected');

  await database.recordInbound({ waMessageId: 'WA-2', contactId: contact.id, conversationId: conversation.id, body: 'still there?' });
  const transcript = await database.recentTranscript(conversation.id, 5);
  assert.deepEqual(transcript.map((row) => row.body), ['hello', 'still there?']);
  await database.close();
});

dbTest('database: outreach counters, pacing data and delivery receipts', async () => {
  const { database } = await makeTestDb();
  await database.init();
  const contact = await database.ensureContact({ jid: phoneToJid('919876543212'), phone: '919876543212' });
  const conversation = await database.ensureConversation(contact.id);

  const event = await database.logOutreach({ contactId: contact.id, conversationId: conversation.id, kind: 'pitch', status: 'queued', bodyPreview: 'hi' });
  await database.markOutreachSent(event.id, 'OUT-1');
  assert.equal(await database.countOutboundSince(new Date(Date.now() - 60_000)), 1);
  assert.ok(await database.lastOutboundAt());

  assert.equal(await database.updateDeliveryStatus('OUT-1', 'delivered'), true);
  assert.equal(await database.updateDeliveryStatus('unknown-id', 'delivered'), false);

  await database.logOutreach({ contactId: contact.id, kind: 'reply', status: 'failed', reason: 'boom' });
  const stats = await database.statsBetween(new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000));
  assert.equal(stats.sent, 1);
  assert.equal(stats.send_failures, 1);
  await database.close();
});

dbTest('database: the daily report row is unique per date and only sent once', async () => {
  const { database } = await makeTestDb();
  await database.init();

  const first = await database.ensureDailyReport('2026-10-24', 'Asia/Kolkata', 'report one', { metrics: { sent: 1 } });
  const second = await database.ensureDailyReport('2026-10-24', 'Asia/Kolkata', 'report two', { metrics: { sent: 9 } });
  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the unique report_date must prevent a second row');
  assert.equal(second.report.content, 'report one');

  const marked = await database.markReportSent('2026-10-24');
  assert.equal(marked.status, 'sent');
  const markedAgain = await database.markReportSent('2026-10-24');
  assert.equal(markedAgain, null, 'a sent report must not be marked sent twice');

  const pending = await database.pendingReports();
  assert.equal(pending.length, 0);
  await database.close();
});

dbTest('database: stats exclude personal conversations', async () => {
  const { database } = await makeTestDb();
  await database.init();

  const business = await database.ensureContact({ jid: phoneToJid('919876543213'), phone: '919876543213' });
  const businessChat = await database.ensureConversation(business.id);
  await database.setConversationState(businessChat.id, 'approved_business');
  await database.recordInbound({ waMessageId: 'BIZ-1', contactId: business.id, conversationId: businessChat.id, body: 'how much?' });
  await database.updateMessage((await database.recentTranscript(businessChat.id, 1))[0].id ?? 1, { processingStatus: 'processed', category: 'interested' }).catch(() => {});

  const personal = await database.ensureContact({ jid: phoneToJid('919876543214'), phone: '919876543214' });
  const personalChat = await database.ensureConversation(personal.id);
  await database.setConversationState(personalChat.id, 'personal');
  await database.recordInbound({ waMessageId: 'PER-1', contactId: personal.id, conversationId: personalChat.id, body: 'dinner tonight?' });

  const stats = await database.statsBetween(new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000));
  assert.equal(stats.replies, 1, 'personal chats must not appear in business analytics');
  await database.close();
});

dbTest('database: WhatsApp session round-trips through Postgres with Buffers intact', async () => {
  const { database } = await makeTestDb();
  await database.init();

  const auth = await database.useDatabaseAuthState('test-session');
  auth.state.creds.registered = true;
  auth.state.creds.noiseKey = { private: Buffer.from([9, 8, 7]), public: Buffer.from('pub') };
  await auth.saveCreds();
  await auth.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('k1') }, 2: null } });

  const reopened = await database.useDatabaseAuthState('test-session');
  assert.equal(reopened.state.creds.registered, true);
  assert.ok(Buffer.isBuffer(reopened.state.creds.noiseKey.private));
  assert.deepEqual([...reopened.state.creds.noiseKey.private], [9, 8, 7]);
  const keys = await reopened.state.keys.get('pre-key', ['1', '2']);
  assert.ok(Buffer.isBuffer(keys['1'].public));

  assert.equal(await database.hasAuthState('test-session'), true);
  await database.clearAuthState('test-session');
  assert.equal(await database.hasAuthState('test-session'), false);
  await database.close();
});

dbTest('database: pause state, owner actions and pending queue', async () => {
  const { database } = await makeTestDb();
  await database.init();

  assert.equal(await database.isPaused(), false);
  await database.setPaused(true, 'testing');
  assert.equal(await database.isPaused(), true);
  await database.setPaused(false);
  assert.equal(await database.isPaused(), false);

  await database.logOwnerAction({ ownerJid: '919000000000', command: 'status', args: { a: 1 }, result: 'ok' });
  const contact = await database.ensureContact({ jid: phoneToJid('919876543215'), phone: '919876543215' });
  const conversation = await database.ensureConversation(contact.id);
  await database.setConversationState(conversation.id, 'pending_review', { needsOwner: true, ownerNote: 'unclear' });
  const pending = await database.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phone, '919876543215');
  await database.close();
});

/* ========================================================================== *
 * Message-pipeline integration: authorization, opt-out and AI-failure rules.
 *
 * These run the real OutreachBot against a real (WASM) PostgreSQL database with
 * a fake WhatsApp transport and a stubbed AI. They are the tests that prove the
 * safety rules actually hold in code, not just in the README.
 * ========================================================================== */

const { OutreachBot } = await import('./index.js');

function fakeTransport() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, payload) => {
      sent.push({ jid, text: payload.text });
      return { key: { id: `OUT-${sent.length}` } };
    },
    end: async () => {},
  };
}

async function makeBot({ aiReply = null, env = {} } = {}) {
  const { database } = await makeTestDb();
  await database.init();
  const config = makeConfig({ DRY_RUN: 'false', ...env });
  const transport = fakeTransport();
  const calls = { ai: 0 };
  const ai = {
    askAi: async () => {
      calls.ai += 1;
      if (!aiReply) return { ok: false, errorCategory: 'rate_limit', provider: 'openrouter', model: 'm', attempts: [] };
      return { ok: true, provider: 'openrouter', model: 'test-model', attempts: [], ...aiReply };
    },
  };
  const bot = new OutreachBot(config, {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    database,
    ai,
  });
  bot.sock = transport;
  bot.connected = true;
  return { bot, database, transport, calls, config };
}

const contactSends = (transport, phone) => transport.sent.filter((entry) => entry.jid === phoneToJid(phone));
const ownerSends = (transport) => transport.sent.filter((entry) => entry.jid === phoneToJid(baseEnv.OWNER_NUMBER));

const inboundMsg = (phone, id, text) => ({
  key: { remoteJid: phoneToJid(phone), id, fromMe: false },
  pushName: 'Test Person',
  message: { conversation: text },
});

const ownerMsg = (command) => ({
  key: { remoteJid: phoneToJid(baseEnv.OWNER_NUMBER), id: `CMD-${Math.random()}`, fromMe: true },
  message: { conversation: command },
});

dbTest('pipeline: an unknown contact is stored and reviewed, never answered', async () => {
  const { bot, database, transport, calls } = await makeBot({ aiReply: { category: 'interested', reply: 'Sure!', sendDemo: false, needsOwner: false } });
  await bot.handleInbound(inboundMsg('919876500001', 'IN-1', 'do you build websites?'), 'do you build websites?');

  assert.equal(transport.sent.length, 0, 'no reply may be sent to an unapproved contact');
  assert.equal(calls.ai, 0, 'the AI must not be called for an unapproved chat');

  const contact = await database.getContactByPhone('919876500001');
  assert.equal(contact.approval_status, 'pending');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.state, 'pending_review');
  assert.equal(conversation.needs_owner, true);
  await database.close();
});

dbTest('pipeline: an approved chat receives a validated reply', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'Yes, we build small shops. What do you sell?', sendDemo: false, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500002'), '!approvechat 919876500002');
  transport.sent.length = 0; // ignore the owner confirmation

  await bot.handleInbound(inboundMsg('919876500002', 'IN-2', 'do you build shops?'), 'do you build shops?');
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /we build small shops/);

  const contact = await database.getContactByPhone('919876500002');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.state, 'approved_business');
  assert.equal(conversation.last_outbound_at !== null, true);
  await database.close();
});

dbTest('pipeline: a duplicate WhatsApp id is processed only once', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'Hello!', sendDemo: false, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500003'), '!approvechat 919876500003');
  transport.sent.length = 0;

  const message = inboundMsg('919876500003', 'IN-3', 'hello');
  await bot.handleInbound(message, 'hello');
  await bot.handleInbound(message, 'hello');
  assert.equal(transport.sent.length, 1, 'a replayed message must not trigger a second reply');
  await database.close();
});

dbTest('pipeline: an explicit opt-out blocks everything immediately', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'opt_out', reply: '', sendDemo: false, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500004'), '!approvechat 919876500004');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500004', 'IN-4', 'please stop messaging me'), 'please stop messaging me');
  assert.equal(contactSends(transport, '919876500004').length, 0, 'no acknowledgement unless explicitly enabled');

  const contact = await database.getContactByPhone('919876500004');
  assert.equal(contact.approval_status, 'opted_out');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.state, 'opted_out');

  // A later message must not restart the conversation.
  await bot.handleInbound(inboundMsg('919876500004', 'IN-5', 'actually what do you charge?'), 'actually what do you charge?');
  assert.equal(contactSends(transport, '919876500004').length, 0, 'an opted-out contact is never messaged again');
  await database.close();
});

dbTest('pipeline: a personal chat is silenced and marked personal', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'personal', reply: 'we sell websites', sendDemo: false, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500005'), '!approvechat 919876500005');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500005', 'IN-6', 'are we still meeting for lunch?'), 'are we still meeting for lunch?');
  assert.equal(transport.sent.length, 0, 'personal chats must never receive a business reply');

  const contact = await database.getContactByPhone('919876500005');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.state, 'personal');
  assert.equal(contact.classification, 'personal');
  await database.close();
});

dbTest('pipeline: both AI providers failing stores the message instead of replying', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: null });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500006'), '!approvechat 919876500006');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500006', 'IN-7', 'how long does a site take?'), 'how long does a site take?');
  assert.equal(contactSends(transport, '919876500006').length, 0, 'no invented answer may be sent');
  assert.equal(ownerSends(transport).length, 1, 'the owner is told that a message needs a human');

  const contact = await database.getContactByPhone('919876500006');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.needs_owner, true);
  const failed = await database.listFailedMessages(5);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].processing_status, 'ai_failed');
  await database.close();
});

dbTest('pipeline: needs_owner suggestions are queued and not sent', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'needs_owner', reply: '', sendDemo: false, needsOwner: true } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500007'), '!approvechat 919876500007');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500007', 'IN-8', 'can you sign an NDA and invoice my company?'), 'can you sign an NDA and invoice my company?');
  assert.equal(contactSends(transport, '919876500007').length, 0);
  assert.equal(ownerSends(transport).length, 1, 'the owner is asked to review it');
  const contact = await database.getContactByPhone('919876500007');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.needs_owner, true);
  await database.close();
});

dbTest('pipeline: a demo link is sent once, only when requested', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'demo_requested', reply: 'Sure, here is a sample:', sendDemo: true, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500008'), '!approvechat 919876500008');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500008', 'IN-9', 'can I see an example?'), 'can I see an example?');
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /https:\/\/demo\.example\.com\/work/);

  const contact = await database.getContactByPhone('919876500008');
  const conversation = await database.getConversationByContact(contact.id);
  assert.ok(conversation.demo_sent_at, 'demo_sent_at must be recorded');

  await bot.handleInbound(inboundMsg('919876500008', 'IN-10', 'show me the demo again'), 'show me the demo again');
  const demoSends = transport.sent.filter((entry) => entry.text.includes('https://demo.example.com/work'));
  assert.equal(demoSends.length, 1, 'the app must not append the link a second time');
  assert.equal(contactSends(transport, '919876500008').length, 2, 'the second reply is still sent, just without the link');
  await database.close();
});

dbTest('owner commands: non-owners are ignored and cannot approve contacts', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'hi', sendDemo: false, needsOwner: false } });
  const stranger = {
    key: { remoteJid: phoneToJid('919999999999'), id: 'EVIL-1', fromMe: false },
    message: { conversation: '!approvechat 919876500009' },
  };
  await bot.handleOwnerCommand(stranger, '!approvechat 919876500009');
  assert.equal(transport.sent.length, 0, 'a stranger must never get a reply');
  assert.equal(ownerSends(transport).length, 0, 'and must not produce owner notifications either');

  const contact = await database.getContactByPhone('919876500009');
  assert.equal(contact, null, 'a stranger must not be able to create/approve contacts');
  await database.close();
});

dbTest('owner commands: approve, permission and pitch gates', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'hi', sendDemo: false, needsOwner: false } });

  const noPermission = await bot.commandPitch('919876500010', '919876543210');
  assert.match(noPermission, /not approved/i);
  assert.equal(transport.sent.length, 0);

  const approved = await bot.commandApprove('919876500010', '', '919876543210');
  assert.match(approved, /Permission is still blocked|Outreach is still blocked/i);

  const stillBlocked = await bot.commandPitch('919876500010', '919876543210');
  assert.match(stillBlocked, /consent/i);

  const permission = await bot.commandPermission('919876500010', 'asked me on Instagram for a quote', '919876543210');
  assert.match(permission, /recorded/i);

  const sent = await bot.commandPitch('919876500010', '919876543210');
  assert.match(sent, /Pitch sent/i);
  const messages = transport.sent.filter((entry) => entry.text === baseEnv.FIXED_PITCH);
  assert.equal(messages.length, 1);

  const again = await bot.commandPitch('919876500010', '919876543210');
  assert.match(again, /already sent|Repeated outreach/i);

  const contact = await database.getContactByPhone('919876500010');
  const conversation = await database.getConversationByContact(contact.id);
  assert.equal(conversation.state, 'bot_initiated');
  assert.ok(conversation.outreach_sent_at);
  await database.close();
});

dbTest('owner commands: opt-out cannot be reversed without written evidence', async () => {
  const { bot, database } = await makeBot({ aiReply: { category: 'interested', reply: 'hi', sendDemo: false, needsOwner: false } });
  await bot.commandOptOut('919876500011', 'asked to stop', '919876543210');
  const contact = await database.getContactByPhone('919876500011');
  assert.equal(contact.approval_status, 'opted_out');

  const withoutEvidence = await bot.commandOptIn('919876500011', '', '919876543210');
  assert.match(withoutEvidence, /explicitly consents/i);
  assert.equal((await database.getContactByPhone('919876500011')).approval_status, 'opted_out');

  const withEvidence = await bot.commandOptIn('919876500011', 'he wrote "please contact me again" on 2026-10-20', '919876543210');
  assert.match(withEvidence, /reversed/i);
  assert.equal((await database.getContactByPhone('919876500011')).approval_status, 'pending');
  await database.close();
});

dbTest('pipeline: pause blocks sends even in an approved chat', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'Sure!', sendDemo: false, needsOwner: false } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500012'), '!approvechat 919876500012');
  await bot.handleOwnerCommand(ownerMsg('!pause testing'), '!pause testing');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500012', 'IN-11', 'hello there'), 'hello there');
  assert.equal(transport.sent.length, 0);
  assert.equal(await database.isPaused(), true);

  await bot.handleOwnerCommand(ownerMsg('!resume'), '!resume');
  await bot.handleInbound(inboundMsg('919876500012', 'IN-12', 'hello again'), 'hello again');
  assert.equal(transport.sent.filter((entry) => entry.jid === phoneToJid('919876500012')).length, 1);
  await database.close();
});

dbTest('pipeline: the daily send cap is enforced', async () => {
  const { bot, database, transport } = await makeBot({ aiReply: { category: 'interested', reply: 'Sure!', sendDemo: false, needsOwner: false }, env: { MAX_OUTBOUND_PER_DAY: '1' } });
  await bot.handleOwnerCommand(ownerMsg('!approvechat 919876500013'), '!approvechat 919876500013');
  transport.sent.length = 0;

  await bot.handleInbound(inboundMsg('919876500013', 'IN-13', 'first'), 'first');
  await bot.handleInbound(inboundMsg('919876500013', 'IN-14', 'second'), 'second');
  const toContact = transport.sent.filter((entry) => entry.jid === phoneToJid('919876500013'));
  assert.equal(toContact.length, 1, 'the second reply must be blocked by the daily cap');
  await database.close();
});

dbTest('pipeline: the daily report is generated once and delivered once', async () => {
  const { bot, database, transport, config } = await makeBot({ aiReply: { category: 'interested', reply: 'hi', sendDemo: false, needsOwner: false } });
  const today = todayInTz(config.report.timezone);
  const { report } = await bot.buildAndStoreReport(today);

  const first = await bot.deliverReport(report);
  assert.equal(first.sent, true);
  const second = await bot.deliverReport(await database.getDailyReport(today));
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already_sent');

  const reports = transport.sent.filter((entry) => entry.jid === config.ownerJid);
  assert.equal(reports.length, 1, 'the owner must receive exactly one 21:00 report');
  const stored = await database.getDailyReport(today);
  assert.equal(stored.status, 'sent');
  await database.close();
});

dbTest('pipeline: a report missed while offline is delivered after reconnect, once', async () => {
  const { bot, database, transport, config } = await makeBot({ aiReply: { category: 'interested', reply: 'hi', sendDemo: false, needsOwner: false } });
  const today = todayInTz(config.report.timezone);
  await bot.buildAndStoreReport(today);

  // Offline: delivery is refused and the row stays pending.
  bot.connected = false;
  const offline = await bot.deliverReport(await database.getDailyReport(today));
  assert.equal(offline.sent, false);
  assert.equal((await database.getDailyReport(today)).status, 'pending');

  // Back online: flush delivers it exactly once.
  bot.connected = true;
  bot.lastReportAttempt.clear();
  await bot.flushPendingReports();
  assert.equal((await database.getDailyReport(today)).status, 'sent');

  bot.lastReportAttempt.clear();
  await bot.flushPendingReports();
  assert.equal(transport.sent.filter((entry) => entry.jid === config.ownerJid).length, 1);
  await database.close();
});

'use strict';

/**
 * Vercel serverless entry point for the Telegram search API.
 *
 * Deploys the read-only Telegram search API as a serverless function.
 * The factory worker, scheduler, and long-running services are intentionally
 * not started here — only the /api/telegram search surface plus /healthz.
 *
 * Required environment variables on Vercel:
 *   DASHBOARD_PASSWORD   (protects /api/telegram; required)
 *   SESSION_SECRET       (signs session cookies; required in production)
 *   NODE_ENV             (development | production)
 *   TELEGRAM_*           (see .env.example)
 */

const express = require('express');
const { getConfig } = require('../src/config');
const { Logger } = require('../src/lib/logger');
const {
  authMiddleware,
  requireAuth,
  requireSameOrigin,
  createAuthRouter,
} = require('../src/routes/auth');
const { createTelegramRouter } = require('../src/routes/telegram');

const config = getConfig();

// Minimal console logger for serverless (no database dependency).
const logger = new Logger({ level: config.logLevel, scope: 'vercel' });

// Minimal OAuth stub: Google OAuth routes are not wired on Vercel deployments.
// Only /auth/login and /auth/logout are functional here.
const oauth = {
  configured: false,
  createState: () => null,
  authUrl: () => '',
  exchangeCode: async () => { throw new Error('Google OAuth not configured'); },
  fetchChannel: async () => { throw new Error('Google OAuth not configured'); },
  disconnect: async () => {},
  isConnected: () => false,
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers (mirrors src/app.js).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );
  next();
});

app.use(express.json({ limit: '128kb' }));
app.use(authMiddleware(config));
app.use('/auth', createAuthRouter({ config, logger, oauth, db: null }));

// Public, unauthenticated health endpoint (no secrets).
app.get('/healthz', async (_req, res) => {
  res.json({
    ok: true,
    service: 'telegram',
    env: config.env,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

// Telegram search API (session-authenticated).
app.use(
  '/api/telegram',
  requireAuth(config),
  requireSameOrigin,
  createTelegramRouter(),
);

app.use('/api/telegram', (_req, res) => {
  res.status(404).json({ error: 'Unknown API route' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  logger.error(`Unhandled error: ${error.message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;

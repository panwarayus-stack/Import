'use strict';

/**
 * Express application assembly.
 *
 * Middleware order matters:
 *   security headers → session resolution → auth routes → JSON API → dashboard/SPA → 404
 */

const express = require('express');
const path = require('node:path');
const { authMiddleware, requireAuth, requireSameOrigin, createAuthRouter } = require('./routes/auth');
const { createApiRouter } = require('./routes/api');
const { createDashboardRouter } = require('./routes/dashboard');

function securityHeaders(config) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // The dashboard itself only loads local assets; generated sites get their own CSP.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    next();
  };
}

function createApp({ config, db, logger, worker, scheduler, oauth, comments, openrouter }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders(config));
  app.use(express.json({ limit: '128kb' }));
  app.use(authMiddleware(config));

  // Public, unauthenticated health endpoint (no secrets).
  app.get('/healthz', async (req, res) => {
    const stats = db.stats();
    res.json({
      ok: true,
      version: require('../package.json').version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      worker: worker ? { running: worker.running, paused: worker.paused } : { running: false },
      stats: { jobs: stats.jobs, uploads: stats.uploads.uploaded },
      time: new Date().toISOString(),
    });
  });

  app.use('/auth', createAuthRouter({ config, logger, oauth, db }));

  app.use(
    '/api',
    requireAuth(config),
    requireSameOrigin,
    createApiRouter({ config, db, logger, worker, scheduler, oauth, comments, openrouter }),
  );
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

  app.use('/', createDashboardRouter({ config, db, logger, worker }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${error.message}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp, securityHeaders };

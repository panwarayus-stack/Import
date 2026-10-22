'use strict';

/**
 * Dashboard login + Google OAuth routes.
 */

const express = require('express');
const { createSessionToken, verifySessionToken, safeEqual, parseCookies, RateLimiter } = require('../lib/auth');

function cookieName(config) {
  return config.isProduction && !config.dashboard.allowInsecureCookie ? '__Host-awf_session' : 'awf_session';
}

function setSessionCookie(res, config, token) {
  const secure = config.isProduction || !config.dashboard.allowInsecureCookie;
  res.cookie(cookieName(config), token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: config.dashboard.sessionTtlHours * 3600 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res, config) {
  const name = cookieName(config);
  res.cookie(name, '', { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 0 });
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.isProduction ? '; Secure' : ''}`);
}

function createAuthRouter({ config, logger, oauth, db }) {
  const router = express.Router();
  const limiter = new RateLimiter({
    limit: config.security.loginRateLimit,
    windowMs: config.security.loginRateWindowMs,
  });

  router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const key = req.ip || 'unknown';
    const check = limiter.check(key);
    if (!check.allowed) {
      res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterMs: check.retryAfterMs });
      return;
    }
    if (!config.dashboard.password) {
      res.status(503).json({ error: 'DASHBOARD_PASSWORD is not configured on the server.' });
      return;
    }
    const password = String(req.body?.password || '');
    if (!safeEqual(password, config.dashboard.password)) {
      logger.warn(`Failed dashboard login from ${key}`);
      res.status(401).json({ error: 'Incorrect password.' });
      return;
    }
    limiter.reset(key);
    const token = createSessionToken(config.dashboard.sessionSecret, config.dashboard.sessionTtlHours);
    setSessionCookie(res, config, token);
    logger.info(`Dashboard login from ${key}`);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get('/google', async (req, res) => {
    if (!req.dashboardAuthed) {
      res.redirect('/login');
      return;
    }
    if (!oauth.configured) {
      res.status(503).send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      return;
    }
    const state = oauth.createState();
    req.sessionStore?.set?.(state, Date.now());
    res.cookie('awf_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.redirect(oauth.authUrl(state));
  });

  router.get('/google/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) throw new Error(String(error));
      const cookies = parseCookies(req.headers.cookie);
      if (!code || !state || state !== cookies.awf_oauth_state) {
        throw new Error('OAuth state mismatch — restart the authorization flow.');
      }
      await oauth.exchangeCode(String(code));
      const channel = await oauth.fetchChannel();
      logger.info(`YouTube channel connected: ${channel.title} (${channel.id})`);
      res.redirect('/?connected=1#settings');
    } catch (err) {
      logger.error(`Google OAuth callback failed: ${err.message}`);
      res.status(400).send(`Google authorization failed: ${err.message}`);
    }
  });

  router.post('/google/disconnect', async (req, res) => {
    if (!req.dashboardAuthed) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    await oauth.disconnect();
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    res.json({ authenticated: Boolean(req.dashboardAuthed) });
  });

  return router;
}

/** Express middleware: resolves the dashboard session from the signed cookie. */
function authMiddleware(config) {
  return (req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[cookieName(config)] || cookies.awf_session;
    req.dashboardAuthed = verifySessionToken(token, config.dashboard.sessionSecret);
    next();
  };
}

function requireAuth(config) {
  return (req, res, next) => {
    if (req.dashboardAuthed) return next();
    if (req.accepts(['json', 'html']) === 'json' || req.path.startsWith('/api') || req.xhr) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.redirect('/login');
  };
}

/** CSRF defence for state-changing requests: custom header required (same-origin JS only). */
function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'dashboard') {
    res.status(403).json({ error: 'Missing X-Requested-With header (CSRF protection)' });
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== req.get('host')) {
        res.status(403).json({ error: 'Cross-origin request blocked' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Origin header' });
      return;
    }
  }
  next();
}

function setCookieHelper(res, name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, `Max-Age=${Math.floor((options.maxAge || 0) / 1000)}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite === 'strict' ? 'Strict' : 'Lax'}`);
  if (options.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

module.exports = {
  createAuthRouter,
  authMiddleware,
  requireAuth,
  requireSameOrigin,
  setSessionCookie,
  clearSessionCookie,
  cookieName,
  setCookieHelper,
};

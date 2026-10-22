'use strict';

/**
 * Dashboard pages, media streaming and generated-site previews.
 *
 * All of these are behind dashboard auth. Generated sites are served read-only from
 * their sandbox directory with a restrictive CSP; nothing can reach the app's own
 * files or API from there because each site lives in its own folder.
 */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const ID_PATTERN = /^[a-zA-Z0-9_-]{3,80}$/;

function safeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

function createDashboardRouter({ config, db, logger, worker }) {
  const router = express.Router();
  const publicDir = config.paths.public;

  router.get('/login', (req, res) => {
    if (req.dashboardAuthed) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  router.get('/', (req, res) => {
    if (!req.dashboardAuthed) return res.redirect('/login');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // SPA deep links (job detail / settings tabs).
  router.get(['/jobs/:id', '/settings', '/logs'], (req, res) => {
    if (!req.dashboardAuthed) return res.redirect('/login');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  router.get('/assets/:file', (req, res) => {
    const file = /^[a-zA-Z0-9_.-]{1,60}$/.test(req.params.file) ? req.params.file : null;
    if (!file || file.includes('..')) return res.status(400).end();
    res.sendFile(path.join(publicDir, file));
  });

  /* ------------------------------------------------- generated site previews */

  router.use('/sites/:siteId', (req, res, next) => {
    const siteId = safeId(req.params.siteId);
    if (!siteId) return res.status(400).send('Invalid site id');
    const siteRoot = path.join(config.paths.sites, siteId, 'site');
    if (!fs.existsSync(path.join(siteRoot, 'index.html'))) return res.status(404).send('Site not found');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; form-action 'none'");
    express.static(siteRoot, { index: 'index.html', dotfiles: 'deny', fallthrough: true, maxAge: 0 })(req, res, next);
  });

  /* ------------------------------------------------------------------ media */

  const sendFileSafely = (res, filePath, { download = false } = {}) => {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.sendFile(path.resolve(filePath));
  };

  router.get('/media/sites/:siteId/:kind', (req, res) => {
    const siteId = safeId(req.params.siteId);
    const kind = req.params.kind;
    const allowed = { 'screenshot.png': 'screenshot.png', 'screenshot-vertical.png': 'screenshot-vertical.png', 'brief.json': 'brief.json', 'meta.json': 'manifest.json' };
    if (!siteId || !allowed[kind]) return res.status(400).json({ error: 'Invalid media path' });
    const filePath = path.join(config.paths.sites, siteId, allowed[kind]);
    if (kind === 'brief.json' && !fs.existsSync(filePath)) return res.status(404).json({ error: 'No brief' });
    return sendFileSafely(res, filePath, { download: kind.endsWith('.json') });
  });

  router.get('/media/videos/:jobId/:kind', (req, res) => {
    const jobId = safeId(req.params.jobId);
    const kind = req.params.kind;
    if (!jobId) return res.status(400).json({ error: 'Invalid job id' });
    const map = {
      'short.mp4': path.join(config.paths.videos, jobId, 'short.mp4'),
      'raw.mp4': path.join(config.paths.recordings, jobId, 'raw-recording.mp4'),
      'narration.wav': path.join(config.paths.videos, jobId, 'narration', 'narration.wav'),
      'subtitles.srt': path.join(config.paths.videos, jobId, 'subtitles.srt'),
      'subtitles.ass': path.join(config.paths.videos, jobId, 'subtitles.ass'),
    };
    const filePath = map[kind];
    if (!filePath) return res.status(400).json({ error: 'Invalid media kind' });
    if (kind.endsWith('.srt') || kind.endsWith('.ass')) {
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      res.type('text/plain');
      return res.send(fs.readFileSync(filePath, 'utf8'));
    }
    return sendFileSafely(res, filePath, { download: kind.endsWith('.wav') });
  });

  router.get('/media/videos/:jobId/metadata.json', (req, res) => {
    const jobId = safeId(req.params.jobId);
    if (!jobId) return res.status(400).json({ error: 'Invalid job id' });
    const video = db.getVideoByJob(jobId);
    if (!video) return res.status(404).json({ error: 'No video for this job' });
    res.json({ video, script: safeJson(video.script_json), metadata: safeJson(video.metadata_json) });
  });

  router.get('/favicon.ico', (req, res) => {
    const icon = path.join(publicDir, 'favicon.svg');
    if (fs.existsSync(icon)) return res.sendFile(icon);
    return res.status(204).end();
  });

  router.use((req, res) => {
    if (req.dashboardAuthed) {
      return res.status(404).sendFile(path.join(publicDir, 'index.html'));
    }
    return res.redirect('/login');
  });

  return router;
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

module.exports = { createDashboardRouter, safeId };

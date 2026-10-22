'use strict';

/**
 * SQLite persistence layer.
 *
 * - `better-sqlite3` is synchronous and fast enough for a single-process worker.
 * - WAL mode + busy_timeout keep the dashboard responsive while the worker writes.
 * - Every schema change is a numbered migration, applied transactionally.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openSqlite } = require('./lib/sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        token_type TEXT,
        scope TEXT,
        expires_at TEXT,
        channel_id TEXT,
        channel_title TEXT,
        extra_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        video_id TEXT,
        video_title TEXT,
        author TEXT,
        author_channel_id TEXT,
        text TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        reject_reason TEXT,
        content_hash TEXT NOT NULL,
        job_id TEXT,
        used_at TEXT,
        raw_json TEXT
      );
      CREATE INDEX idx_comments_status ON comments(status, discovered_at DESC);
      CREATE INDEX idx_comments_hash ON comments(content_hash);
      CREATE INDEX idx_comments_job ON comments(job_id);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        comment_id TEXT,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        error_stage TEXT,
        state_json TEXT NOT NULL DEFAULT '{}',
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        simulated INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(comment_id) REFERENCES comments(id)
      );
      CREATE INDEX idx_jobs_status ON jobs(status, created_at DESC);
      CREATE INDEX idx_jobs_created ON jobs(created_at DESC);

      CREATE TABLE websites (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        title TEXT,
        slug TEXT,
        brief_json TEXT,
        dir TEXT,
        entry_file TEXT,
        screenshot_path TEXT,
        preview_url TEXT,
        deploy_provider TEXT,
        deploy_url TEXT,
        deploy_meta_json TEXT,
        status TEXT NOT NULL DEFAULT 'generated',
        simulated INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE INDEX idx_websites_job ON websites(job_id);
      CREATE INDEX idx_websites_created ON websites(created_at DESC);

      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        website_id TEXT,
        script_json TEXT,
        narration_path TEXT,
        narration_duration REAL,
        subtitles_srt TEXT,
        subtitles_ass TEXT,
        raw_recording_path TEXT,
        output_path TEXT,
        duration_sec REAL,
        width INTEGER,
        height INTEGER,
        fps INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        simulated INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE INDEX idx_videos_job ON videos(job_id);
      CREATE INDEX idx_videos_created ON videos(created_at DESC);

      CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        job_id TEXT,
        youtube_video_id TEXT,
        url TEXT,
        title TEXT,
        privacy TEXT,
        status TEXT NOT NULL,
        checksum TEXT,
        simulated INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(video_id)
      );
      CREATE INDEX idx_uploads_job ON uploads(job_id);

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        scope TEXT,
        job_id TEXT,
        message TEXT NOT NULL,
        meta_json TEXT
      );
      CREATE INDEX idx_logs_ts ON logs(ts DESC);
      CREATE INDEX idx_logs_job ON logs(job_id, ts DESC);
      CREATE INDEX idx_logs_level ON logs(level, ts DESC);

      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_day ON api_usage(day, service);

      CREATE TABLE worker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL DEFAULT 'running',
        day TEXT,
        jobs_today INTEGER NOT NULL DEFAULT 0,
        uploads_today INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        last_heartbeat TEXT,
        last_poll_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RETRYING: 'retrying',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

const STAGES = Object.freeze([
  'select_comment',
  'generate_idea',
  'build_site',
  'test_site',
  'deploy_site',
  'write_script',
  'narrate',
  'record_site',
  'subtitles',
  'render_video',
  'upload_video',
  'done',
]);

const uid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const nowIso = () => new Date().toISOString();

class FactoryDatabase {
  constructor(filePath, { migrations = MIGRATIONS } = {}) {
    if (!filePath) throw new Error('database path is required');
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.db = openSqlite(filePath);
    this.driver = this.db.driver;
    for (const pragma of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'synchronous = NORMAL']) {
      try {
        this.db.pragma(pragma);
      } catch {
        /* pragma support varies slightly between drivers */
      }
    }
    this.migrate(migrations);
  }

  migrate(migrations = MIGRATIONS) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      const run = this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, nowIso());
      });
      run();
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /* ---------------------------------------------------------------- settings */

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
    return value;
  }

  allSettings() {
    const out = {};
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- comments */

  upsertComment(comment) {
    const hash = comment.content_hash || crypto.createHash('sha256').update(normalizeComment(comment.text)).digest('hex');
    const existing = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id);
    if (existing) return { inserted: false, comment: existing };
    this.db
      .prepare(
        `INSERT INTO comments (id, video_id, video_title, author, author_channel_id, text, like_count,
          published_at, discovered_at, status, reject_reason, content_hash, raw_json)
         VALUES (@id, @video_id, @video_title, @author, @author_channel_id, @text, @like_count,
          @published_at, @discovered_at, @status, @reject_reason, @content_hash, @raw_json)`,
      )
      .run({
        id: comment.id,
        video_id: comment.video_id || null,
        video_title: comment.video_title || null,
        author: comment.author || null,
        author_channel_id: comment.author_channel_id || null,
        text: comment.text,
        like_count: comment.like_count || 0,
        published_at: comment.published_at || null,
        discovered_at: nowIso(),
        status: comment.status || 'new',
        reject_reason: comment.reject_reason || null,
        content_hash: hash,
        raw_json: comment.raw_json ? JSON.stringify(comment.raw_json) : null,
      });
    return { inserted: true, comment: this.db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id) };
  }

  getComment(id) {
    return this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) || null;
  }

  hashSeen(hash) {
    return Boolean(this.db.prepare('SELECT 1 FROM comments WHERE content_hash = ? LIMIT 1').get(hash));
  }

  pickEligibleComment({ excludeIds = [] } = {}) {
    const placeholders = excludeIds.map(() => '?').join(',');
    const sql = `SELECT * FROM comments
      WHERE status = 'eligible' ${placeholders ? `AND id NOT IN (${placeholders})` : ''}
      ORDER BY RANDOM() LIMIT 1`;
    return this.db.prepare(sql).get(...excludeIds) || null;
  }

  markCommentQueued(commentId, jobId) {
    this.db.prepare(`UPDATE comments SET status = 'queued', job_id = ? WHERE id = ?`).run(jobId, commentId);
  }

  markCommentUsed(commentId, jobId) {
    this.db.prepare(`UPDATE comments SET status = 'used', job_id = ?, used_at = ? WHERE id = ?`).run(jobId, nowIso(), commentId);
  }

  resetCommentToEligible(commentId) {
    this.db.prepare(`UPDATE comments SET status = 'eligible', job_id = NULL WHERE id = ?`).run(commentId);
  }

  rejectComment(commentId, reason) {
    this.db.prepare(`UPDATE comments SET status = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, commentId);
  }

  countComments() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
                SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
         FROM comments`,
      )
      .get();
    return {
      total: row.total || 0,
      eligible: row.eligible || 0,
      used: row.used || 0,
      rejected: row.rejected || 0,
      queued: row.queued || 0,
    };
  }

  recentComments(limit = 20) {
    return this.db.prepare('SELECT * FROM comments ORDER BY discovered_at DESC LIMIT ?').all(limit);
  }

  /* -------------------------------------------------------------------- jobs */

  createJob({ commentId = null, maxAttempts = 3, stage = 'select_comment', simulated = 0 } = {}) {
    const id = uid('job');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, comment_id, status, stage, progress, attempt, max_attempts, state_json,
          cancel_requested, simulated, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, 0, 0, ?, '{}', 0, ?, ?, ?)`,
      )
      .run(id, commentId, stage, maxAttempts, simulated ? 1 : 0, ts, ts);
    return this.getJob(id);
  }

  getJob(id) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return null;
    return hydrateJob(job);
  }

  updateJob(id, patch = {}) {
    const fields = [];
    const values = [];
    const allowed = [
      'status',
      'stage',
      'progress',
      'attempt',
      'max_attempts',
      'error',
      'error_stage',
      'state_json',
      'cancel_requested',
      'simulated',
      'next_run_at',
      'started_at',
      'finished_at',
    ];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
    if (!fields.length) return this.getJob(id);
    fields.push('updated_at = ?');
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  updateJobState(id, updater) {
    const job = this.getJob(id);
    if (!job) throw new Error(`job ${id} not found`);
    const next = typeof updater === 'function' ? updater(job.state || {}) : { ...job.state, ...updater };
    return this.updateJob(id, { state_json: JSON.stringify(next || {}) });
  }

  claimNextJob() {
    const ts = nowIso();
    const claim = this.db.transaction(() => {
      const job = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status IN ('queued', 'retrying')
             AND cancel_requested = 0
             AND (next_run_at IS NULL OR next_run_at <= ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(ts);
      if (!job) return null;
      this.db
        .prepare(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
        .run(ts, ts, job.id);
      return job.id;
    });
    const id = claim();
    return id ? this.getJob(id) : null;
  }

  markJobFailed(id, { error, stage, retryAt = null, attempt }) {
    if (retryAt) {
      return this.updateJob(id, {
        status: JOB_STATUS.RETRYING,
        error,
        error_stage: stage,
        attempt,
        next_run_at: retryAt,
      });
    }
    return this.updateJob(id, {
      status: JOB_STATUS.FAILED,
      error,
      error_stage: stage,
      attempt,
      finished_at: nowIso(),
      next_run_at: null,
    });
  }

  markJobSucceeded(id) {
    return this.updateJob(id, {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      progress: 100,
      error: null,
      error_stage: null,
      finished_at: nowIso(),
      next_run_at: null,
    });
  }

  requestCancel(id) {
    this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
    return this.getJob(id);
  }

  /** Recover jobs left mid-flight by a crash/restart. */
  recoverInterruptedJobs() {
    const ts = nowIso();
    const rows = this.db.prepare(`SELECT id, attempt, max_attempts, cancel_requested FROM jobs WHERE status = 'running'`).all();
    for (const row of rows) {
      if (row.cancel_requested) {
        this.db
          .prepare(`UPDATE jobs SET status = 'canceled', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
          .run('Cancelled before the worker restarted', ts, ts, row.id);
      } else if (row.attempt + 1 >= row.max_attempts) {
        this.db
          .prepare(
            `UPDATE jobs SET status = 'failed', error = ?, error_stage = stage, finished_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run('Job interrupted by a restart and exhausted its retry budget', ts, ts, row.id);
      } else {
        this.db
          .prepare(
            `UPDATE jobs SET status = 'retrying', error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run('Job interrupted by a restart; queued for retry', ts, ts, row.id);
      }
    }
    return rows.length;
  }

  listJobs({ status, limit = 25, offset = 0, search } = {}) {
    const clauses = [];
    const params = [];
    if (status && status !== 'all') {
      clauses.push('j.status = ?');
      params.push(status);
    }
    if (search) {
      clauses.push('(j.id LIKE ? OR c.text LIKE ? OR w.title LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT j.*, c.text AS comment_text, c.author AS comment_author, c.video_title,
                w.title AS website_title, w.screenshot_path, w.deploy_url AS website_url,
                v.output_path AS video_path, u.youtube_video_id, u.url AS youtube_url
         FROM jobs j
         LEFT JOIN comments c ON c.id = j.comment_id
         LEFT JOIN websites w ON w.job_id = j.id
         LEFT JOIN videos v ON v.job_id = j.id
         LEFT JOIN uploads u ON u.job_id = j.id
         ${where}
         ORDER BY j.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs j
         LEFT JOIN comments c ON c.id = j.comment_id
         LEFT JOIN websites w ON w.job_id = j.id
         ${where}`,
      )
      .get(...params).n;
    return { jobs: rows.map(hydrateJob), total };
  }

  jobCounts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    const counts = Object.fromEntries(Object.values(JOB_STATUS).map((s) => [s, 0]));
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  jobCountsSince(isoDate) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS jobs,
                SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs WHERE created_at >= ?`,
      )
      .get(isoDate);
    return { jobs: row.jobs || 0, succeeded: row.succeeded || 0, failed: row.failed || 0 };
  }

  activeJob() {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('running', 'retrying', 'queued') ORDER BY
           CASE status WHEN 'running' THEN 0 WHEN 'retrying' THEN 1 ELSE 2 END, created_at ASC LIMIT 1`,
      )
      .get();
    return row ? hydrateJob(row) : null;
  }

  /* ---------------------------------------------------------------- websites */

  saveWebsite(site) {
    const id = site.id || uid('site');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO websites (id, job_id, title, slug, brief_json, dir, entry_file, screenshot_path,
           preview_url, deploy_provider, deploy_url, deploy_meta_json, status, simulated, verified_at,
           created_at, updated_at)
         VALUES (@id, @job_id, @title, @slug, @brief_json, @dir, @entry_file, @screenshot_path,
           @preview_url, @deploy_provider, @deploy_url, @deploy_meta_json, @status, @simulated, @verified_at,
           @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, screenshot_path = excluded.screenshot_path,
           preview_url = excluded.preview_url, deploy_provider = excluded.deploy_provider,
           deploy_url = excluded.deploy_url, deploy_meta_json = excluded.deploy_meta_json,
           status = excluded.status, verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
      )
      .run({
        id,
        job_id: site.job_id,
        title: site.title || null,
        slug: site.slug || null,
        brief_json: JSON.stringify(site.brief || {}),
        dir: site.dir || null,
        entry_file: site.entry_file || 'index.html',
        screenshot_path: site.screenshot_path || null,
        preview_url: site.preview_url || null,
        deploy_provider: site.deploy_provider || null,
        deploy_url: site.deploy_url || null,
        deploy_meta_json: JSON.stringify(site.deploy_meta || {}),
        status: site.status || 'generated',
        simulated: site.simulated ? 1 : 0,
        verified_at: site.verified_at || null,
        created_at: ts,
        updated_at: ts,
      });
    return this.getWebsite(id);
  }

  getWebsite(id) {
    return this.db.prepare('SELECT * FROM websites WHERE id = ?').get(id) || null;
  }

  getWebsiteByJob(jobId) {
    return this.db.prepare('SELECT * FROM websites WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(jobId) || null;
  }

  recentWebsites(limit = 12) {
    return this.db.prepare('SELECT * FROM websites ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /* ------------------------------------------------------------------ videos */

  saveVideo(video) {
    const id = video.id || uid('vid');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO videos (id, job_id, website_id, script_json, narration_path, narration_duration,
           subtitles_srt, subtitles_ass, raw_recording_path, output_path, duration_sec, width, height, fps,
           status, simulated, metadata_json, created_at, updated_at)
         VALUES (@id, @job_id, @website_id, @script_json, @narration_path, @narration_duration,
           @subtitles_srt, @subtitles_ass, @raw_recording_path, @output_path, @duration_sec, @width, @height, @fps,
           @status, @simulated, @metadata_json, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           narration_path = excluded.narration_path, narration_duration = excluded.narration_duration,
           subtitles_srt = excluded.subtitles_srt, subtitles_ass = excluded.subtitles_ass,
           raw_recording_path = excluded.raw_recording_path, output_path = excluded.output_path,
           duration_sec = excluded.duration_sec, width = excluded.width, height = excluded.height,
           fps = excluded.fps, status = excluded.status, metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        job_id: video.job_id,
        website_id: video.website_id || null,
        script_json: JSON.stringify(video.script || {}),
        narration_path: video.narration_path || null,
        narration_duration: video.narration_duration || null,
        subtitles_srt: video.subtitles_srt || null,
        subtitles_ass: video.subtitles_ass || null,
        raw_recording_path: video.raw_recording_path || null,
        output_path: video.output_path || null,
        duration_sec: video.duration_sec || null,
        width: video.width || null,
        height: video.height || null,
        fps: video.fps || null,
        status: video.status || 'pending',
        simulated: video.simulated ? 1 : 0,
        metadata_json: JSON.stringify(video.metadata || {}),
        created_at: ts,
        updated_at: ts,
      });
    return this.getVideo(id);
  }

  getVideo(id) {
    return this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) || null;
  }

  getVideoByJob(jobId) {
    return this.db.prepare('SELECT * FROM videos WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(jobId) || null;
  }

  recentVideos(limit = 12) {
    return this.db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /* ----------------------------------------------------------------- uploads */

  saveUpload(upload) {
    const id = upload.id || uid('up');
    const existing = this.db.prepare('SELECT * FROM uploads WHERE video_id = ?').get(upload.video_id);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO uploads (id, video_id, job_id, youtube_video_id, url, title, privacy, status,
           checksum, simulated, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        upload.video_id,
        upload.job_id || null,
        upload.youtube_video_id || null,
        upload.url || null,
        upload.title || null,
        upload.privacy || null,
        upload.status || 'pending',
        upload.checksum || null,
        upload.simulated ? 1 : 0,
        JSON.stringify(upload.response || {}),
        nowIso(),
      );
    return this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  }

  updateUpload(id, patch) {
    const allowed = ['youtube_video_id', 'url', 'status', 'privacy', 'response_json', 'checksum'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(key === 'response_json' ? JSON.stringify(patch[key]) : patch[key]);
    }
    if (!fields.length) return null;
    values.push(id);
    this.db.prepare(`UPDATE uploads SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  }

  getUploadByVideo(videoId) {
    return this.db.prepare('SELECT * FROM uploads WHERE video_id = ?').get(videoId) || null;
  }

  uploadCountSince(isoDate) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE created_at >= ? AND simulated = 0`).get(isoDate).n;
  }

  /* -------------------------------------------------------------------- logs */

  log({ level = 'info', scope = 'app', jobId = null, message, meta = null }) {
    this.db
      .prepare('INSERT INTO logs (ts, level, scope, job_id, message, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowIso(), level, scope, jobId, String(message).slice(0, 4000), meta ? JSON.stringify(meta).slice(0, 8000) : null);
  }

  listLogs({ level, jobId, search, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (level && level !== 'all') {
      clauses.push('level = ?');
      params.push(level);
    }
    if (jobId) {
      clauses.push('job_id = ?');
      params.push(jobId);
    }
    if (search) {
      clauses.push('(message LIKE ? OR scope LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit);
  }

  pruneLogs(keep = 5000) {
    this.db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`).run(keep);
  }

  errorSummary() {
    return this.db
      .prepare(
        `SELECT level, COUNT(*) AS n FROM logs
         WHERE ts >= datetime('now', '-1 day') AND level IN ('error', 'warn')
         GROUP BY level`,
      )
      .all();
  }

  /* --------------------------------------------------------------- api usage */

  recordUsage({ service, operation, units = 0, calls = 1, day = today() }) {
    this.db
      .prepare(
        `INSERT INTO api_usage (day, service, operation, units, calls, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(day, service, operation, units, calls, nowIso());
  }

  usageForDay({ day = today() } = {}) {
    const rows = this.db
      .prepare(
        `SELECT service, SUM(units) AS units, SUM(calls) AS calls FROM api_usage WHERE day = ? GROUP BY service`,
      )
      .all(day);
    return objectFromRows(rows);
  }

  usageSeries(days = 14) {
    return this.db
      .prepare(
        `SELECT day, service, SUM(units) AS units, SUM(calls) AS calls
         FROM api_usage GROUP BY day, service ORDER BY day DESC LIMIT ?`,
      )
      .all(days * 4);
  }

  /* ------------------------------------------------------------- oauth tokens */

  saveTokens(provider, tokens) {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_type, scope, expires_at,
           channel_id, channel_title, extra_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           access_token = COALESCE(excluded.access_token, oauth_tokens.access_token),
           refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
           token_type = excluded.token_type,
           scope = excluded.scope,
           expires_at = excluded.expires_at,
           channel_id = COALESCE(excluded.channel_id, oauth_tokens.channel_id),
           channel_title = COALESCE(excluded.channel_title, oauth_tokens.channel_title),
           extra_json = excluded.extra_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        provider,
        tokens.access_token || null,
        tokens.refresh_token || null,
        tokens.token_type || 'Bearer',
        tokens.scope || null,
        tokens.expires_at || null,
        tokens.channel_id || null,
        tokens.channel_title || null,
        JSON.stringify(tokens.extra || {}),
        nowIso(),
      );
  }

  getTokens(provider) {
    return this.db.prepare('SELECT * FROM oauth_tokens WHERE provider = ?').get(provider) || null;
  }

  deleteTokens(provider) {
    this.db.prepare('DELETE FROM oauth_tokens WHERE provider = ?').run(provider);
  }

  /* ------------------------------------------------------------- worker state */

  getWorkerState() {
    let row = this.db.prepare('SELECT * FROM worker_state WHERE id = 1').get();
    if (!row) {
      this.db
        .prepare('INSERT INTO worker_state (id, status, day, updated_at) VALUES (1, ?, ?, ?)')
        .run('running', today(), nowIso());
      row = this.db.prepare('SELECT * FROM worker_state WHERE id = 1').get();
    }
    if (row.day !== today()) {
      this.db
        .prepare('UPDATE worker_state SET day = ?, jobs_today = 0, uploads_today = 0, updated_at = ? WHERE id = 1')
        .run(today(), nowIso());
      row = this.db.prepare('SELECT * FROM worker_state WHERE id = 1').get();
    }
    return row;
  }

  setWorkerStatus(status) {
    this.db
      .prepare('UPDATE worker_state SET status = ?, last_heartbeat = ?, updated_at = ? WHERE id = 1')
      .run(status, nowIso(), nowIso());
    return this.getWorkerState();
  }

  heartbeat() {
    this.db.prepare('UPDATE worker_state SET last_heartbeat = ?, updated_at = ? WHERE id = 1').run(nowIso(), nowIso());
  }

  bumpWorkerCounter(field) {
    if (!['jobs_today', 'uploads_today'].includes(field)) throw new Error('invalid counter');
    this.db.prepare(`UPDATE worker_state SET ${field} = ${field} + 1, updated_at = ? WHERE id = 1`).run(nowIso());
    return this.getWorkerState();
  }

  setLastPoll(ts = nowIso()) {
    this.db.prepare('UPDATE worker_state SET last_poll_at = ?, updated_at = ? WHERE id = 1').run(ts, nowIso());
  }

  setWorkerError(message) {
    this.db.prepare('UPDATE worker_state SET last_error = ?, updated_at = ? WHERE id = 1').run(message, nowIso());
  }

  /** Aggregated numbers for the dashboard. */
  stats() {
    const comments = this.countComments();
    const jobCounts = this.jobCounts();
    const websites = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN deploy_url IS NOT NULL THEN 1 ELSE 0 END) AS deployed,
                SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN status IN ('failed', 'rejected') THEN 1 ELSE 0 END) AS failed
         FROM websites`,
      )
      .get();
    const videos = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'rendered' THEN 1 ELSE 0 END) AS rendered,
                SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) AS simulated
         FROM videos`,
      )
      .get();
    const uploads = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) AS uploaded,
                SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) AS simulated
         FROM uploads`,
      )
      .get();
    return {
      comments,
      jobs: jobCounts,
      websites: {
        generated: websites.n || 0,
        deployed: websites.deployed || 0,
        verified: websites.verified || 0,
        failed: websites.failed || 0,
      },
      videos: { rendered: videos.rendered || 0, total: videos.n || 0, simulated: videos.simulated || 0 },
      uploads: { uploaded: uploads.uploaded || 0, total: uploads.n || 0, simulated: uploads.simulated || 0 },
    };
  }
}

function hydrateJob(row) {
  if (!row) return null;
  let state = {};
  try {
    state = row.state_json ? JSON.parse(row.state_json) : {};
  } catch {
    state = {};
  }
  return { ...row, state };
}

function normalizeComment(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function objectFromRows(rows) {
  const out = {};
  for (const row of rows) out[row.service] = { units: row.units || 0, calls: row.calls || 0 };
  return out;
}

function openDatabase(config, opts = {}) {
  return new FactoryDatabase(config?.paths?.db || opts.filePath || ':memory:', opts);
}

module.exports = {
  FactoryDatabase,
  openDatabase,
  JOB_STATUS,
  STAGES,
  MIGRATIONS,
  uid,
  nowIso,
  normalizeComment,
  today,
};

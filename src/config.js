'use strict';

/**
 * Central configuration.
 *
 * Every value comes from the environment (optionally through `.env`) and can be
 * inspected from the dashboard. Secrets are marked `secret: true` so the API can
 * redact them; nothing secret is ever sent to the browser.
 *
 * The module also performs a light "capability" detection so the pipeline can
 * degrade gracefully (dry-run) when a credential or binary is missing instead of
 * pretending an external service succeeded.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try {
  // Loads .env if present. Missing file is fine (production uses real env vars).
  require('dotenv').config();
} catch {
  /* dotenv is optional at runtime */
}

const ROOT = path.resolve(__dirname, '..');

function str(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function float(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function list(name, fallback = []) {
  const raw = str(name);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function absPath(name, fallback) {
  const value = str(name, fallback);
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function loadConfig(overrides = {}) {
  const env = str('NODE_ENV', 'development');
  const port = int('PORT', 3000, { min: 1, max: 65535 });
  const baseUrl = str('BASE_URL', `http://localhost:${port}`).replace(/\/+$/, '');

  const dashboardPassword = str('DASHBOARD_PASSWORD') || (env === 'production' ? '' : 'changeme');
  const sessionSecret =
    str('SESSION_SECRET') || (env === 'production' ? '' : crypto.createHash('sha256').update(`dev:${dashboardPassword}`).digest('hex'));

  const githubToken = str('GITHUB_TOKEN');
  // Hosting is opt-in: local previews work everywhere, GitHub Pages/Netlify need credentials.
  const provider = str('DEPLOY_PROVIDER', 'local').toLowerCase();
  const ffmpegPath = str('FFMPEG_PATH');
  const ffprobePath = str('FFPROBE_PATH');

  const config = {
    env,
    isProduction: env === 'production',
    root: ROOT,
    host: str('HOST', '0.0.0.0'),
    port,
    baseUrl,
    logLevel: str('LOG_LEVEL', 'info').toLowerCase(),

    dashboard: {
      password: dashboardPassword,
      sessionSecret,
      sessionTtlHours: int('SESSION_TTL_HOURS', 12, { min: 1, max: 720 }),
      cookieName: '__Host-awf_session',
      allowInsecureCookie: bool('COOKIE_INSECURE', env !== 'production'),
    },

    paths: {
      root: ROOT,
      data: absPath('DATA_DIR', 'data'),
      sites: absPath('SITES_DIR', 'generated-sites'),
      videos: absPath('VIDEOS_DIR', 'generated-videos'),
      recordings: absPath('RECORDINGS_DIR', 'recordings'),
      logs: absPath('LOGS_DIR', 'logs'),
      credentials: absPath('CREDENTIALS_DIR', 'credentials'),
      templates: absPath('TEMPLATES_DIR', 'templates'),
      public: absPath('PUBLIC_DIR', 'public'),
      db: absPath('DATABASE_PATH', path.join('data', 'factory.sqlite')),
    },

    openrouter: {
      apiKey: str('OPENROUTER_API_KEY'),
      baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      models: list('OPENROUTER_MODELS', [
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemma-3-27b-it:free',
        'qwen/qwen-2.5-72b-instruct:free',
      ]),
      referer: str('OPENROUTER_REFERER', baseUrl),
      title: str('OPENROUTER_TITLE', 'AI Website & Shorts Factory'),
      timeoutMs: int('OPENROUTER_TIMEOUT_MS', 120000, { min: 5000, max: 600000 }),
      maxCallsPerJob: int('OPENROUTER_MAX_CALLS_PER_JOB', 6, { min: 1, max: 50 }),
      maxRepairAttempts: int('SITE_REPAIR_ATTEMPTS', 2, { min: 0, max: 5 }),
      temperature: float('OPENROUTER_TEMPERATURE', 0.8, { min: 0, max: 2 }),
      maxTokens: int('OPENROUTER_MAX_TOKENS', 8000, { min: 512, max: 32000 }),
    },

    youtube: {
      clientId: str('GOOGLE_CLIENT_ID'),
      clientSecret: str('GOOGLE_CLIENT_SECRET'),
      redirectUri: str('GOOGLE_REDIRECT_URI', `${baseUrl}/auth/google/callback`),
      scopes: list('GOOGLE_SCOPES', [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.upload',
      ]),
      apiBase: str('YOUTUBE_API_BASE', 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, ''),
      uploadBase: str('YOUTUBE_UPLOAD_BASE', 'https://www.googleapis.com/upload/youtube/v3').replace(/\/+$/, ''),
      oauthBase: str('GOOGLE_OAUTH_BASE', 'https://oauth2.googleapis.com'),
      channelId: str('YOUTUBE_CHANNEL_ID'),
      pollCron: str('COMMENT_POLL_CRON', '*/20 * * * *'),
      pollIntervalMinutes: int('COMMENT_POLL_INTERVAL_MINUTES', 20, { min: 1, max: 1440 }),
      maxCommentsPerPoll: int('MAX_COMMENTS_PER_POLL', 200, { min: 1, max: 2000 }),
      maxVideosPerPoll: int('MAX_VIDEOS_PER_POLL', 10, { min: 1, max: 50 }),
      dailyQuotaUnits: int('YOUTUBE_DAILY_QUOTA_UNITS', 10000, { min: 0, max: 100000000 }),
      // Uploads have had their own quota bucket since 2026-06-01 (default: 100 calls/day,
      // 1 unit each). Older projects may still be billed ~1600 units from the shared pool —
      // both numbers are configurable.
      uploadDailyLimit: int('YOUTUBE_UPLOAD_DAILY_LIMIT', 100, { min: 0, max: 10000 }),
      uploadUsesSharedQuota: bool('YOUTUBE_UPLOAD_USES_SHARED_QUOTA', false),
      quotaCosts: {
        commentThreads: int('QUOTA_COST_COMMENT_THREADS', 1, { min: 1, max: 100 }),
        commentList: int('QUOTA_COST_COMMENT_LIST', 1, { min: 1, max: 100 }),
        search: int('QUOTA_COST_SEARCH', 100, { min: 1, max: 10000 }),
        upload: int('QUOTA_COST_UPLOAD', 1, { min: 1, max: 100000 }),
      },
      dailyJobLimit: int('DAILY_JOB_LIMIT', 3, { min: 0, max: 100 }),
      dailyUploadLimit: int('DAILY_UPLOAD_LIMIT', 1, { min: 0, max: 100 }),
      commentsTokenFile: absPath('YOUTUBE_TOKEN_FILE', path.join('credentials', 'youtube-token.json')),
      minCommentLength: int('MIN_COMMENT_LENGTH', 12, { min: 1, max: 500 }),
      maxCommentLength: int('MAX_COMMENT_LENGTH', 2000, { min: 50, max: 5000 }),
      maxCommentAgeDays: int('MAX_COMMENT_AGE_DAYS', 90, { min: 1, max: 3650 }),
      includeReplies: bool('INCLUDE_COMMENT_REPLIES', false),
      minLikes: int('MIN_COMMENT_LIKES', 0, { min: 0, max: 100000 }),
    },

    deploy: {
      provider,
      verifyTimeoutMs: int('DEPLOY_VERIFY_TIMEOUT_MS', 90000, { min: 5000, max: 900000 }),
      verifyRequired: bool('DEPLOY_VERIFY_REQUIRED', true),
      maxSiteBytes: int('MAX_SITE_BYTES', 3 * 1024 * 1024, { min: 64 * 1024, max: 50 * 1024 * 1024 }),
      maxFiles: int('MAX_SITE_FILES', 40, { min: 1, max: 500 }),
      github: {
        token: githubToken,
        apiBase: str('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, ''),
        owner: str('GITHUB_OWNER'),
        repoPrefix: str('GITHUB_REPO_PREFIX', 'comment-site'),
        visibility: str('GITHUB_REPO_VISIBILITY', 'public'),
        branch: str('GITHUB_PAGES_BRANCH', 'main'),
        cname: str('GITHUB_PAGES_CNAME'),
      },
      netlify: {
        token: str('NETLIFY_AUTH_TOKEN'),
        siteId: str('NETLIFY_SITE_ID'),
        apiBase: str('NETLIFY_API_BASE', 'https://api.netlify.com/api/v1'),
      },
      local: {
        publicBaseUrl: str('LOCAL_SITE_PUBLIC_URL', `${baseUrl}/sites`).replace(/\/+$/, ''),
      },
    },

    tts: {
      engine: str('TTS_ENGINE', 'piper').toLowerCase(), // piper | espeak | silent
      allowSilentFallback: bool('TTS_ALLOW_SILENT_FALLBACK', !bool('TTS_REQUIRE_REAL_AUDIO', false)),
      voice: str('TTS_VOICE', 'en_US-amy-medium'),
      language: str('TTS_LANGUAGE', 'en'),
      speed: float('TTS_SPEED', 1.0, { min: 0.5, max: 2.0 }),
      timeoutMs: int('TTS_TIMEOUT_MS', 60000, { min: 5000, max: 300000 }),
      piper: {
        bin: str('PIPER_BIN', 'piper'),
        model: str('PIPER_MODEL'),
        config: str('PIPER_CONFIG'),
        speaker: int('PIPER_SPEAKER', 0, { min: 0, max: 1000 }),
        lengthScale: float('PIPER_LENGTH_SCALE', 1.0, { min: 0.5, max: 2 }),
        sentenceSilence: float('PIPER_SENTENCE_SILENCE', 0.25, { min: 0, max: 2 }),
      },
      espeak: {
        bin: str('ESPEAK_BIN', 'espeak-ng'),
        voice: str('ESPEAK_VOICE', 'en-us'),
        wordsPerMinute: int('ESPEAK_WPM', 165, { min: 80, max: 300 }),
      },
    },

    video: {
      ffmpegPath,
      ffprobePath,
      width: int('VIDEO_WIDTH', 1080, { min: 540, max: 2160 }),
      height: int('VIDEO_HEIGHT', 1920, { min: 960, max: 3840 }),
      fps: int('VIDEO_FPS', 30, { min: 15, max: 60 }),
      crf: int('VIDEO_CRF', 21, { min: 14, max: 32 }),
      preset: str('VIDEO_PRESET', 'medium'),
      audioBitrate: str('VIDEO_AUDIO_BITRATE', '192k'),
      maxDurationSec: int('VIDEO_MAX_DURATION_SEC', 58, { min: 10, max: 180 }),
      minDurationSec: int('VIDEO_MIN_DURATION_SEC', 8, { min: 3, max: 60 }),
      musicPath: str('BACKGROUND_MUSIC_PATH'),
      musicVolume: float('BACKGROUND_MUSIC_VOLUME', 0.08, { min: 0, max: 0.6 }),
      brandName: str('BRAND_NAME', 'Built from a comment'),
      maxRenderMs: int('VIDEO_RENDER_TIMEOUT_MS', 900000, { min: 30000, max: 3600000 }),
      ffmpegThreads: int('FFMPEG_THREADS', 2, { min: 1, max: 32 }),
    },

    recording: {
      viewportWidth: int('RECORD_VIEWPORT_WIDTH', 1080, { min: 360, max: 2160 }),
      viewportHeight: int('RECORD_VIEWPORT_HEIGHT', 1920, { min: 640, max: 3840 }),
      scrollStepPx: int('RECORD_SCROLL_STEP_PX', 700, { min: 200, max: 2000 }),
      maxScrollSections: int('RECORD_MAX_SECTIONS', 4, { min: 1, max: 20 }),
      settleMs: int('RECORD_SETTLE_MS', 900, { min: 0, max: 10000 }),
      captureFps: int('RECORD_CAPTURE_FPS', 12, { min: 5, max: 30 }),
      strategy: str('RECORD_STRATEGY', 'auto').toLowerCase(), // auto | video | frames
      executablePath: str('CHROMIUM_EXECUTABLE_PATH') || str('PLAYWRIGHT_EXECUTABLE_PATH'),
      timeoutMs: int('BROWSER_TIMEOUT_MS', 60000, { min: 5000, max: 300000 }),
      maxDurationSec: int('RECORD_MAX_DURATION_SEC', 60, { min: 5, max: 180 }),
      browserChannel: str('CHROMIUM_CHANNEL'),
      useSparticuz: bool('USE_SPARTICUZ_CHROMIUM', true),
      testOnly: bool('RECORD_TEST_ONLY', false),
      allowScreenshotFallback: bool('ALLOW_SCREENSHOT_FALLBACK', true),
      // When no browser is available at all (e.g. a headless server without Chromium), the
      // pipeline can mark the video as unavailable and finish with the website + script +
      // narration instead of failing the whole job. Off by default: a failed job is honest,
      // a silently video-less "success" is not.
      allowSkipVideo: bool('ALLOW_SKIP_VIDEO_WITHOUT_BROWSER', false),
    },

    worker: {
      enabled: bool('WORKER_ENABLED', true),
      schedulerEnabled: bool('SCHEDULER_ENABLED', true),
      pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 5000, { min: 500, max: 120000 }),
      maxAttempts: int('JOB_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
      backoffBaseMs: int('JOB_BACKOFF_BASE_MS', 60000, { min: 1000, max: 3600000 }),
      backoffMaxMs: int('JOB_BACKOFF_MAX_MS', 1800000, { min: 1000, max: 86400000 }),
      stageTimeoutMs: int('STAGE_TIMEOUT_MS', 600000, { min: 30000, max: 3600000 }),
      dailyJobLimit: int('DAILY_JOB_LIMIT', 3, { min: 0, max: 100 }),
      dailyUploadLimit: int('DAILY_UPLOAD_LIMIT', 1, { min: 0, max: 100 }),
      maxQueueDepth: int('MAX_QUEUE_DEPTH', 10, { min: 1, max: 500 }),
      startPaused: bool('START_PAUSED', false),
    },

    security: {
      maxGeneratedFileBytes: int('MAX_GENERATED_FILE_BYTES', 512 * 1024, { min: 4096, max: 5 * 1024 * 1024 }),
      buildTimeoutMs: int('BUILD_TIMEOUT_MS', 120000, { min: 5000, max: 900000 }),
      loginRateLimit: int('LOGIN_RATE_LIMIT', 8, { min: 1, max: 100 }),
      loginRateWindowMs: int('LOGIN_RATE_WINDOW_MS', 300000, { min: 10000, max: 3600000 }),
      allowedCommentMaxBytes: int('MAX_COMMENT_BYTES', 4000, { min: 100, max: 20000 }),
    },

    upload: {
      // Public publishing must be opted into explicitly; the default is private.
      allowPublicUpload: bool('ALLOW_PUBLIC_UPLOAD', false),
      privacy: str('UPLOAD_PRIVACY', 'private').toLowerCase(),
      requireRealRecording: bool('UPLOAD_REQUIRE_REAL_RECORDING', true),
      minDurationSec: int('UPLOAD_MIN_DURATION_SEC', 8, { min: 3, max: 180 }),
    },

    limits: {
      maxOpenRouterCallsPerDay: int('MAX_AI_CALLS_PER_DAY', 40, { min: 1, max: 5000 }),
    },

    // Simulation switches. These are never used to *claim* success; every job
    // artifact records whether it came from a dry run.
    dryRun: {
      global: bool('DRY_RUN', false),
      ai: false,
      deploy: false,
      upload: false,
      tts: false,
    },
  };

  config.dryRun.ai = config.dryRun.global || !config.openrouter.apiKey;
  config.dryRun.deploy = config.dryRun.global || config.deploy.provider === 'local';
  config.dryRun.upload = config.dryRun.global || !config.youtube.clientId || !config.youtube.clientSecret;
  config.dryRun.tts = config.dryRun.global || config.tts.engine === 'silent';

  // Allow programmatic overrides (used by tests), then derive warnings from the final
  // configuration so overrides behave predictably.
  const merged = deepMerge(config, overrides);
  merged.warnings = [];
  const finalPassword = merged.dashboard.password;
  if (merged.isProduction && !finalPassword) {
    merged.warnings.push('DASHBOARD_PASSWORD must be set in production; dashboard login is disabled until it is.');
  }
  if (merged.isProduction && !merged.dashboard.sessionSecret) {
    merged.warnings.push('SESSION_SECRET is not set; sessions will be invalidated on restart.');
  }
  if (!merged.openrouter.apiKey) {
    merged.warnings.push('OPENROUTER_API_KEY not set — AI stages run with the offline template generator (dry-run).');
  }
  if (merged.deploy.provider === 'github-pages' && (!merged.deploy.github.token || !merged.deploy.github.owner)) {
    merged.warnings.push('DEPLOY_PROVIDER=github-pages requires GITHUB_TOKEN and GITHUB_OWNER; deployment will fall back to local previews.');
  }
  if (merged.deploy.provider === 'netlify' && !merged.deploy.netlify.token) {
    merged.warnings.push('DEPLOY_PROVIDER=netlify requires NETLIFY_AUTH_TOKEN; deployment will fall back to local previews.');
  }
  if (!merged.youtube.clientId || !merged.youtube.clientSecret) {
    merged.warnings.push('Google OAuth credentials missing — comment collection and Shorts upload stay in dry-run mode.');
  }
  if (!fs.existsSync(merged.paths.root)) {
    merged.warnings.push('Project root not found at runtime (unexpected).');
  }
  // Hosting platforms expose a public URL; if BASE_URL still points at localhost the OAuth
  // redirect and links will be wrong even though the app itself boots fine.
  if (merged.isProduction && /localhost|127\.0\.0\.1/.test(merged.baseUrl)) {
    merged.warnings.push(
      `BASE_URL is ${merged.baseUrl} in production — set it to your public https URL so OAuth redirects and dashboard links work.`,
    );
  }
  if (merged.isProduction && merged.worker.enabled) {
    const dbDir = path.dirname(merged.paths.db);
    try {
      fs.mkdirSync(dbDir, { recursive: true });
      fs.accessSync(dbDir, fs.constants.W_OK);
    } catch {
      merged.warnings.push(
        `Database directory ${dbDir} is not writable — attach a persistent disk or change DATABASE_PATH, otherwise every restart loses the database.`,
      );
    }
  }
  return merged;
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

let cached = null;
function getConfig(overrides) {
  if (overrides) return loadConfig(overrides);
  if (!cached) cached = loadConfig();
  return cached;
}

function resetConfig() {
  cached = null;
}

/** Redacted view of configuration for the dashboard (never includes secrets). */
function publicConfig(config) {
  const githubConfigured = Boolean(config.deploy.github.token && config.deploy.github.owner);
  return {
    env: config.env,
    baseUrl: config.baseUrl,
    dryRun: config.dryRun,
    warnings: config.warnings,
    openrouter: {
      configured: Boolean(config.openrouter.apiKey),
      models: config.openrouter.models,
      maxRepairAttempts: config.openrouter.maxRepairAttempts,
      maxCallsPerJob: config.openrouter.maxCallsPerJob,
    },
    youtube: {
      configured: Boolean(config.youtube.clientId && config.youtube.clientSecret),
      redirectUri: config.youtube.redirectUri,
      scopes: config.youtube.scopes,
      channelId: config.youtube.channelId || null,
      dailyQuotaUnits: config.youtube.dailyQuotaUnits,
      uploadDailyLimit: config.youtube.uploadDailyLimit,
      dailyJobLimit: config.youtube.dailyJobLimit,
      dailyUploadLimit: config.youtube.dailyUploadLimit,
      pollCron: config.youtube.pollCron,
    },
    deploy: {
      provider: config.deploy.provider,
      github: {
        configured: githubConfigured,
        owner: config.deploy.github.owner || null,
        repoPrefix: config.deploy.github.repoPrefix,
      },
      localPublicBaseUrl: config.deploy.local.publicBaseUrl,
    },
    tts: {
      engine: config.tts.engine,
      voice: config.tts.voice,
      language: config.tts.language,
      speed: config.tts.speed,
    },
    video: {
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      maxDurationSec: config.video.maxDurationSec,
    },
    upload: {
      configured: Boolean(config.youtube.clientId && config.youtube.clientSecret),
      privacy: config.upload.privacy,
      allowPublicUpload: config.upload.allowPublicUpload,
    },
    worker: {
      enabled: config.worker.enabled,
      schedulerEnabled: config.worker.schedulerEnabled,
      maxAttempts: config.worker.maxAttempts,
      pollIntervalMs: config.worker.pollIntervalMs,
    },
    limits: config.limits,
  };
}

module.exports = { loadConfig, getConfig, resetConfig, publicConfig, ROOT };

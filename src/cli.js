#!/usr/bin/env node
'use strict';

/**
 * Operator CLI.
 *
 *   node src/cli.js init              create directories + run migrations
 *   node src/cli.js doctor            check every integration and print a report
 *   node src/cli.js worker            run the persistent worker (with scheduler)
 *   node src/cli.js generate --comment "..." --author "@name"
 *   node src/cli.js run-once          enqueue from existing comments and process one job
 *   node src/cli.js seed-demo         add a few safe demo comments for local testing
 *   node src/cli.js healthcheck       exit 1 when the worker heartbeat is stale
 *   node src/cli.js google-auth --import credentials/youtube-token.json
 *   node src/cli.js reset --yes       delete jobs/sites/videos records (keeps comments?)
 */

const fs = require('node:fs');
const path = require('node:path');
const { bootstrap } = require('./bootstrap');
const { getConfig } = require('./config');
const { resolveBinaries, ffmpegCapabilities } = require('./lib/media');
const { browserAvailability } = require('./lib/browser');
const { NarrationService } = require('./services/narration');
const { checkHtml, checkCss, checkJs, validateSiteFiles } = require('./services/website-builder');
const { evaluateComment } = require('./services/comment-filter');
const { today } = require('./database');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printHelp() {
  console.log(`AI Website & Shorts Factory CLI

Usage: node src/cli.js <command> [options]

Commands:
  init                      Create data directories and run database migrations
  doctor                    Check credentials, binaries, browser and TTS availability
  worker [--no-scheduler]   Start the persistent pipeline worker
  server                    Start the dashboard HTTP server (same as npm start)
  generate --comment "..."  Generate one website + video from a supplied comment
  run-once                  Enqueue and process one job from existing comments
  seed-demo                 Insert safe demo comments for local testing
  healthcheck               Exit non-zero when the worker is unhealthy
  google-auth --import FILE Import Google OAuth tokens exported to a JSON file
  reset --yes               Delete all jobs, websites, videos, uploads (keeps schema)

Options:
  --author "@name"          Comment author label for manual comments
  --max-attempts N          Override retry budget for this run
  --skip-upload             Do not attempt the upload stage (still records skipped status)
  --json                    Machine-readable output for doctor/healthcheck
`);
}

async function cmdInit() {
  const ctx = bootstrap();
  fs.mkdirSync(ctx.config.paths.sites, { recursive: true });
  fs.writeFileSync(path.join(ctx.config.paths.sites, '.gitkeep'), '');
  console.log(`Database ready at ${ctx.config.paths.db}`);
  console.log(`Data  : ${ctx.config.paths.data}`);
  console.log(`Sites : ${ctx.config.paths.sites}`);
  console.log(`Videos: ${ctx.config.paths.videos}`);
  console.log(`Recordings: ${ctx.config.paths.recordings}`);
  for (const warning of ctx.config.warnings) console.warn(`warning: ${warning}`);
  ctx.db.close();
}

async function cmdDoctor({ json = false } = {}) {
  const ctx = bootstrap();
  const { config, db, oauth, openrouter, comments } = ctx;
  const bins = resolveBinaries(config);
  const caps = bins.ffmpeg ? await ffmpegCapabilities(bins.ffmpeg) : { available: false };
  const browser = await browserAvailability(config, { probe: true });
  const tts = new NarrationService(config, {}).detect();
  const report = {
    config: {
      env: config.env,
      port: config.port,
      baseUrl: config.baseUrl,
      dryRun: config.dryRun,
      warnings: config.warnings,
    },
    database: { path: config.paths.db, writable: true, stats: db.stats() },
    ffmpeg: {
      available: caps.available,
      path: bins.ffmpeg,
      libx264: caps.libx264,
      aac: caps.aac,
      libass: Boolean(caps.availableFilters && /(^|\s)ass(\s|$)/m.test(caps.availableFilters)),
      ffprobe: bins.ffprobe,
      version: caps.version || null,
    },
    browser: { available: browser.available, source: browser.source, executablePath: browser.executablePath },
    tts: { engine: config.tts.engine, usable: tts.usable, piper: tts.piper, espeak: tts.espeak },
    openrouter: { configured: openrouter.configured, models: config.openrouter.models },
    youtube: {
      oauthConfigured: Boolean(config.youtube.clientId && config.youtube.clientSecret),
      connected: oauth.isConnected(),
      channel: db.getTokens('google-youtube')?.channel_title || null,
      quota: comments.quotaStatus(),
    },
    deploy: {
      provider: config.deploy.provider,
      githubConfigured: Boolean(config.deploy.github.token && config.deploy.github.owner),
      publicBaseUrl: config.deploy.local.publicBaseUrl,
    },
    upload: { privacy: config.upload.privacy, allowPublicUpload: config.upload.allowPublicUpload },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
    console.log('\nAI Website & Shorts Factory — environment report\n');
    line('Node', process.version);
    line('Environment', report.config.env);
    line('Dashboard URL', report.config.baseUrl);
    line('FFmpeg', report.ffmpeg.available ? `${report.ffmpeg.path} (x264=${report.ffmpeg.libx264}, aac=${report.ffmpeg.aac}, libass=${report.ffmpeg.libass})` : 'MISSING');
    line('FFprobe', report.ffmpeg.ffprobe || 'not found (falling back to ffmpeg parsing)');
    line('Chromium', report.browser.available ? `${report.browser.source} → ${report.browser.executablePath}` : 'MISSING (browser tests/recording will be skipped)');
    line('TTS engine', `${report.tts.engine} (usable=${report.tts.usable}; piper=${report.tts.piper.available}, espeak=${report.tts.espeak.available})`);
    line('OpenRouter', report.openrouter.configured ? `configured (${report.openrouter.models[0]}…)` : 'not configured (offline template fallback)');
    line('YouTube OAuth', report.youtube.connected ? `connected: ${report.youtube.channel}` : report.youtube.oauthConfigured ? 'configured, not connected' : 'not configured');
    line('YouTube quota', `${report.youtube.quota.used}/${report.youtube.quota.limit} units today`);
    line('Deploy provider', `${report.deploy.provider}${report.deploy.githubConfigured ? ' (credentials present)' : ''}`);
    line('Upload privacy', `${report.upload.privacy}${report.upload.allowPublicUpload ? '' : ' (public uploads blocked)'}`);
    console.log('');
    if (report.config.warnings.length) {
      console.log('Warnings:');
      for (const warning of report.config.warnings) console.log(`  - ${warning}`);
      console.log('');
    }
  }
  db.close();
  return report;
}

async function cmdWorker(args) {
  const ctx = bootstrap();
  const { logger, worker, scheduler, config } = ctx;
  logger.info('Starting worker from CLI', { scheduler: !args['no-scheduler'] });
  await worker.start({ runScheduler: !args['no-scheduler'] });
  if (args['no-scheduler']) scheduler.stop();

  const shutdown = async (signal) => {
    logger.warn(`Received ${signal}; stopping worker`);
    await worker.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error(`Unhandled rejection: ${reason}`));

  // Keep the process alive; the worker loop runs in the background.
  if (config.worker.schedulerEnabled !== false) ctx.scheduler.start();
  setInterval(() => {
    worker.db.heartbeat();
  }, 15000).unref();
}

async function cmdGenerate(args) {
  const comment = args.comment;
  if (!comment || typeof comment !== 'string') {
    console.error('Missing --comment "text"');
    process.exit(2);
  }
  const ctx = bootstrap();
  const { db, comments, worker, logger, config } = ctx;
  const author = String(args.author || 'manual').slice(0, 60);
  const { comment: stored } = comments.addManualComment({ text: comment, author, force: true });

  const job = db.createJob({
    commentId: stored.id,
    maxAttempts: Number(args['max-attempts']) || 1,
    stage: 'select_comment',
  });
  if (args['skip-upload']) {
    db.updateJobState(job.id, { skipUpload: true });
  }
  logger.info(`Running pipeline for manual comment ${stored.id} (job ${job.id})`);
  const result = await worker.runJob(db.getJob(job.id));
  const video = db.getVideoByJob(job.id);
  const website = db.getWebsiteByJob(job.id);
  const upload = video ? db.getUploadByVideo(video.id) : null;
  console.log(
    JSON.stringify(
      {
        jobId: result.id,
        status: result.status,
        stage: result.stage,
        error: result.error,
        website: website
          ? { title: website.title, preview: website.preview_url, deployed: website.deploy_url, provider: website.deploy_provider }
          : null,
        video: video ? { path: video.output_path, duration: video.duration_sec, simulated: Boolean(video.simulated) } : null,
        upload: upload ? { status: upload.status, url: upload.url, youtubeId: upload.youtube_video_id } : null,
        warnings: result.state?.warnings || [],
      },
      null,
      2,
    ),
  );
  db.close();
  process.exit(result.status === 'succeeded' ? 0 : 1);
}

async function cmdRunOnce(args) {
  const ctx = bootstrap();
  const { db, worker, logger } = ctx;
  const job = await worker.enqueue({ maxAttempts: Number(args['max-attempts']) || 1 });
  logger.info(`Queued ${job.id}; processing synchronously`);
  const result = await worker.runJob(db.getJob(job.id));
  console.log(JSON.stringify({ jobId: result.id, status: result.status, stage: result.stage, error: result.error }, null, 2));
  db.close();
  process.exit(result.status === 'succeeded' ? 0 : 1);
}

async function cmdSeedDemo() {
  const ctx = bootstrap();
  const demo = [
    'I wish someone made a simple meal planner that works offline for a family of four with a tight budget.',
    'Could you build a tiny tool that turns my saved hiking routes into a printable one-page map?',
    'Honestly a site that tracks which local coffee shops have quiet corners for studying would change my week.',
    'Would love a garden planner that tells me what to plant each month without an account.',
  ];
  for (const text of demo) {
    const { comment, evaluation } = ctx.comments.addManualComment({
      text,
      author: '@demo_viewer',
      videoTitle: 'Seeded demo video',
    });
    console.log(`seeded ${comment.id} (${evaluation.eligible ? 'eligible' : evaluation.reason})`);
  }
  console.log('Demo comments inserted. Run `npm run run-once` to process one.');
  ctx.db.close();
}

async function cmdHealthcheck({ json = false } = {}) {
  const config = getConfig();
  let db;
  try {
    const { openDatabase } = require('./database');
    db = openDatabase(config);
    const state = db.getWorkerState();
    const heartbeat = state.last_heartbeat ? Date.parse(state.last_heartbeat) : 0;
    const staleMs = Date.now() - heartbeat;
    const active = db.activeJob();
    const healthy = staleMs < 10 * 60 * 1000 || (!heartbeat && !active);
    const report = {
      healthy,
      status: state.status,
      heartbeatAgeSec: heartbeat ? Math.round(staleMs / 1000) : null,
      activeJob: active ? { id: active.id, stage: active.stage, status: active.status } : null,
      jobs: db.jobCounts(),
      quota: db.usageForDay(),
      day: today(),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`${healthy ? 'OK' : 'STALE'} — worker ${state.status}, heartbeat ${report.heartbeatAgeSec ?? 'never'}s ago`);
    process.exitCode = healthy ? 0 : 1;
  } catch (error) {
    if (!json) console.error(`healthcheck failed: ${error.message}`);
    else console.log(JSON.stringify({ healthy: false, error: error.message }));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

async function cmdGoogleAuth(args) {
  const ctx = bootstrap();
  if (!ctx.config.youtube.clientId || !ctx.config.youtube.clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
    process.exit(2);
  }
  if (typeof args.import === 'string') {
    const tokens = ctx.oauth.importTokenFile(path.resolve(args.import));
    console.log(`Imported tokens (refresh_token: ${tokens.refresh_token ? 'yes' : 'no'})`);
    try {
      const channel = await ctx.oauth.fetchChannel();
      console.log(`Connected channel: ${channel.title} (${channel.id})`);
    } catch (error) {
      console.warn(`Token stored but channel lookup failed: ${error.message}`);
    }
  } else {
    console.log('Open this URL in a browser signed in to the channel, then paste the code back via the dashboard flow:');
    console.log(`  ${ctx.oauth.authUrl(ctx.oauth.createState())}`);
    console.log('\nThe redirect URI must be registered in Google Cloud Console:');
    console.log(`  ${ctx.config.youtube.redirectUri}`);
    console.log('\nOr import an exported token JSON: node src/cli.js google-auth --import credentials/youtube-token.json');
  }
  ctx.db.close();
}

async function cmdReset(args) {
  if (!args.yes) {
    console.error('Refusing to delete data without --yes');
    process.exit(2);
  }
  const ctx = bootstrap();
  const tables = ['uploads', 'videos', 'websites', 'logs', 'api_usage', 'jobs', 'comments'];
  const tx = ctx.db.db.transaction(() => {
    for (const table of tables) ctx.db.db.prepare(`DELETE FROM ${table}`).run();
    ctx.db.db.prepare("UPDATE worker_state SET jobs_today = 0, uploads_today = 0, last_error = NULL").run();
  });
  tx();
  console.log(`Cleared ${tables.join(', ')}. Files on disk were left intact.`);
  ctx.db.close();
}

/** `selftest` runs the validator against the offline template without any services. */
async function cmdSelftest() {
  const { generateBrief, buildSiteFiles } = require('./services/offline-ai');
  const brief = generateBrief('I want a simple meal planner for a family on a budget', { author: 'demo' });
  const site = buildSiteFiles(brief, { author: 'demo', comment: 'demo' });
  const result = validateSiteFiles(site.files, getConfig());
  const errors = [];
  checkHtml(site.files[0].content, errors, []);
  checkCss(site.files[1].content, errors, []);
  checkJs(site.files[2].content, errors);
  console.log(JSON.stringify({ valid: result.ok && errors.length === 0, errors: [...result.errors, ...errors], warnings: result.warnings }, null, 2));
  process.exit(result.ok && errors.length === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0];
  switch (command) {
    case 'init':
      return cmdInit();
    case 'doctor':
      return cmdDoctor({ json: Boolean(args.json) });
    case 'worker':
      return cmdWorker(args);
    case 'server':
      return require('./server').main();
    case 'generate':
      return cmdGenerate(args);
    case 'run-once':
      return cmdRunOnce(args);
    case 'seed-demo':
      return cmdSeedDemo();
    case 'healthcheck':
      return cmdHealthcheck({ json: Boolean(args.json) });
    case 'google-auth':
      return cmdGoogleAuth(args);
    case 'reset':
      return cmdReset(args);
    case 'selftest':
      return cmdSelftest();
    case 'filter-test': {
      const evaluation = evaluateComment(String(args.comment || ''), { minLength: 12 });
      console.log(JSON.stringify(evaluation, null, 2));
      return undefined;
    }
    case 'help':
    case undefined:
      printHelp();
      return undefined;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(2);
  }
  return undefined;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CLI error: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };

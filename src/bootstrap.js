'use strict';

/**
 * Builds the object graph once, shared by the HTTP server, the worker CLI and tests.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('./config');
const { openDatabase } = require('./database');
const { Logger } = require('./lib/logger');
const { OpenRouterService } = require('./services/openrouter');
const { GoogleOAuthService } = require('./services/google-oauth');
const { YouTubeCommentsService } = require('./services/youtube-comments');
const { IdeaGenerator } = require('./services/idea-generator');
const { WebsiteBuilder } = require('./services/website-builder');
const { WebsiteTester } = require('./services/website-tester');
const { Deployer } = require('./services/deployer');
const { Recorder } = require('./services/recorder');
const { NarrationService } = require('./services/narration');
const { ScriptWriter } = require('./services/script-writer');
const { VideoRenderer } = require('./services/video-renderer');
const { YouTubeUploader } = require('./services/youtube-uploader');
const { Scheduler } = require('./workers/scheduler');
const { PipelineWorker } = require('./workers/pipeline-worker');

function ensureDirectories(config) {
  const dirs = [
    config.paths.data,
    config.paths.sites,
    config.paths.videos,
    config.paths.recordings,
    config.paths.logs,
    config.paths.credentials,
    path.dirname(config.paths.db),
    path.join(config.paths.data, 'ai-cache'),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

function bootstrap({ config = null, logger = null } = {}) {
  const cfg = config || getConfig();
  ensureDirectories(cfg);

  const db = openDatabase(cfg);
  const log = logger || new Logger({ db, level: cfg.logLevel, scope: 'server' });

  const openrouter = new OpenRouterService(cfg, { db, logger: log.child('openrouter') });
  const oauth = new GoogleOAuthService(cfg, { db, logger: log.child('oauth') });
  const comments = new YouTubeCommentsService(cfg, { db, logger: log.child('youtube'), oauth });

  // Import a previously exported token file on first boot (documented in the README).
  const tokenFile = cfg.youtube.commentsTokenFile;
  if (!oauth.isConnected() && tokenFile && fs.existsSync(tokenFile)) {
    try {
      oauth.importTokenFile(tokenFile);
      log.info(`Imported YouTube tokens from ${path.relative(cfg.root, tokenFile)}`);
    } catch (error) {
      log.warn(`Could not import YouTube token file: ${error.message}`);
    }
  }

  const services = {
    db,
    logger: log,
    openrouter,
    oauth,
    comments,
    ideaGenerator: new IdeaGenerator(cfg, { openrouter, logger: log.child('idea'), db }),
    websiteBuilder: new WebsiteBuilder(cfg, { openrouter, logger: log.child('builder'), db }),
    websiteTester: new WebsiteTester(cfg, { logger: log.child('tester') }),
    deployer: new Deployer(cfg, { logger: log.child('deploy'), db }),
    recorder: new Recorder(cfg, { logger: log.child('recorder') }),
    narration: new NarrationService(cfg, { logger: log.child('tts') }),
    scriptWriter: new ScriptWriter(cfg, { openrouter, logger: log.child('script') }),
    videoRenderer: new VideoRenderer(cfg, { logger: log.child('render') }),
    uploader: new YouTubeUploader(cfg, { db, logger: log.child('upload'), oauth }),
  };

  const worker = new PipelineWorker(cfg, services);
  services.worker = worker;
  const scheduler = new Scheduler(cfg, { db, logger: log.child('scheduler'), worker, comments });
  services.scheduler = scheduler;
  worker.scheduler = scheduler;

  return { config: cfg, db, logger: log, worker, scheduler, ...services };
}

module.exports = { bootstrap, ensureDirectories };

'use strict';

/**
 * Scheduled maintenance + comment polling (node-cron).
 *
 * Polling is interval-driven so the "Comment poll interval" setting takes effect
 * without a restart. A `COMMENT_POLL_CRON` expression can still be used as an advanced
 * override by setting `POLL_SCHEDULE=cron`.
 *
 * The pipeline itself is *not* driven by cron: the persistent worker owns queueing, so
 * a missed tick never loses work.
 */

const cron = require('node-cron');

class Scheduler {
  constructor(config, { db, logger, worker, comments }) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.worker = worker;
    this.comments = comments;
    this.tasks = [];
    this.polling = false;
    this.lastPollResult = null;
    this.lastTickAt = null;
    this.started = false;
    this.mode = (process.env.POLL_SCHEDULE || 'interval').toLowerCase();
  }

  start() {
    if (this.started) return;
    this.started = true;

    if (this.mode === 'cron') {
      const pollExpr = this.validCron(this.config.youtube.pollCron, '*/20 * * * *');
      this.tasks.push(
        cron.schedule(pollExpr, () => {
          this.pollNow('cron').catch((error) => this.logger.error(`Scheduled comment poll failed: ${error.message}`));
        }),
      );
      this.logger.info(`Scheduler started in cron mode (${pollExpr})`);
    } else {
      // Tick every minute; poll only when the configured interval has elapsed.
      this.tasks.push(
        cron.schedule('* * * * *', () => {
          this.tick().catch((error) => this.logger.error(`Scheduler tick failed: ${error.message}`));
        }),
      );
      this.logger.info(`Scheduler started in interval mode (every ${this.intervalMinutes()} minutes)`);
    }

    this.tasks.push(
      cron.schedule('15 3 * * *', () => {
        try {
          this.db.pruneLogs(5000);
          this.logger.info('Daily maintenance: pruned old logs');
        } catch (error) {
          this.logger.warn(`Maintenance failed: ${error.message}`);
        }
      }),
    );
  }

  stop() {
    for (const task of this.tasks) {
      try {
        task.stop();
      } catch {
        /* ignore */
      }
    }
    this.tasks = [];
    this.started = false;
    this.logger.info('Scheduler stopped');
  }

  intervalMinutes() {
    const settings = this.worker?.getSettings?.() || {};
    const minutes = Number(settings.pollIntervalMinutes ?? this.config.youtube.pollIntervalMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 20;
  }

  async tick() {
    this.lastTickAt = new Date().toISOString();
    const settings = this.worker?.getSettings?.() || {};
    if (!settings.commentPollingEnabled) return { skipped: true, reason: 'polling disabled' };
    if (settings.paused) return { skipped: true, reason: 'automation paused' };

    const state = this.db.getWorkerState();
    const last = state.last_poll_at ? Date.parse(state.last_poll_at) : 0;
    const dueMs = this.intervalMinutes() * 60 * 1000;
    if (last && Date.now() - last < dueMs) return { skipped: true, reason: 'not due yet' };

    return this.pollNow('interval');
  }

  validCron(expression, fallback) {
    try {
      return cron.validate(expression) ? expression : fallback;
    } catch {
      return fallback;
    }
  }

  /** Manual or scheduled comment polling, with overlap protection. */
  async pollNow(trigger = 'manual') {
    if (this.polling) return { skipped: true, reason: 'a poll is already running' };
    const settings = this.worker.getSettings();
    if (trigger !== 'manual' && !settings.commentPollingEnabled) {
      return { skipped: true, reason: 'comment polling disabled in settings' };
    }
    this.polling = true;
    try {
      this.logger.info(`Comment poll started (${trigger})`);
      const summary = await this.worker.pollComments();
      this.lastPollResult = { ...summary, at: new Date().toISOString(), trigger };
      return summary;
    } catch (error) {
      this.logger.error(`Comment poll failed: ${error.message}`);
      this.lastPollResult = { error: error.message, at: new Date().toISOString(), trigger };
      return this.lastPollResult;
    } finally {
      this.polling = false;
    }
  }
}

module.exports = { Scheduler };

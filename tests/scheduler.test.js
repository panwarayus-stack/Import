'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler } = require('../src/workers/scheduler');
const { testConfig, testDb, silentLogger } = require('./helpers');

function makeScheduler({ settings = {}, pollImpl = null } = {}) {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const logger = silentLogger(db);
  let polls = 0;
  const worker = {
    getSettings: () => ({ paused: false, commentPollingEnabled: true, pollIntervalMinutes: 20, ...settings }),
    pollComments: async () => {
      polls += 1;
      if (pollImpl) return pollImpl();
      db.setLastPoll();
      return { fetched: 3, inserted: 2, eligible: 1 };
    },
  };
  const scheduler = new Scheduler(ctx.config, { db, logger, worker, comments: {} });
  return { ctx, db, scheduler, counts: () => polls };
}

test('interval mode polls only when the configured interval has elapsed', async () => {
  const { db, scheduler, counts, ctx } = makeScheduler({ settings: { pollIntervalMinutes: 30 } });

  const first = await scheduler.tick();
  assert.equal(first.fetched, 3);
  assert.equal(counts(), 1);

  const second = await scheduler.tick();
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'not due yet');
  assert.equal(counts(), 1);

  // Pretend the last poll happened two hours ago.
  db.setLastPoll(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  const third = await scheduler.tick();
  assert.equal(third.fetched, 3);
  assert.equal(counts(), 2);
  db.close();
  ctx.cleanup();
});

test('tick respects paused and disabled polling settings', async () => {
  const paused = makeScheduler({ settings: { paused: true } });
  assert.equal((await paused.scheduler.tick()).skipped, true);
  assert.equal(paused.counts(), 0);
  paused.db.close();
  paused.ctx.cleanup();

  const disabled = makeScheduler({ settings: { commentPollingEnabled: false } });
  assert.equal((await disabled.scheduler.tick()).skipped, true);
  assert.equal(disabled.counts(), 0);
  disabled.db.close();
  disabled.ctx.cleanup();
});

test('overlapping polls are prevented', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { scheduler, ctx, db } = makeScheduler({
    pollImpl: async () => {
      await gate;
      return { fetched: 1 };
    },
  });
  const first = scheduler.pollNow('manual');
  const second = await scheduler.pollNow('manual');
  assert.equal(second.skipped, true);
  assert.match(second.reason, /already running/);
  release();
  const result = await first;
  assert.equal(result.fetched, 1);
  db.close();
  ctx.cleanup();
});

test('poll failures are recorded instead of thrown', async () => {
  const { scheduler, ctx, db } = makeScheduler({
    pollImpl: async () => {
      throw new Error('quota exceeded');
    },
  });
  const result = await scheduler.pollNow('manual');
  assert.match(result.error, /quota exceeded/);
  assert.equal(scheduler.polling, false);
  db.close();
  ctx.cleanup();
});

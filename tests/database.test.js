'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FactoryDatabase, JOB_STATUS } = require('../src/database');
const { testConfig } = require('./helpers');

function freshDb() {
  const ctx = testConfig();
  const db = new FactoryDatabase(ctx.config.paths.db);
  return { db, ...ctx };
}

test('migrations are idempotent', () => {
  const { db, cleanup } = freshDb();
  const version = db.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  assert.equal(version.v, 1);
  db.close();
  const reopened = new FactoryDatabase(db.filePath);
  assert.equal(reopened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 1);
  reopened.close();
  cleanup();
});

test('comments are deduplicated by id and content hash', () => {
  const { db, cleanup } = freshDb();
  const comment = {
    id: 'c1',
    text: 'A simple offline meal planner for busy families',
    content_hash: 'hash-1',
    status: 'eligible',
  };
  const first = db.upsertComment(comment);
  assert.equal(first.inserted, true);
  const second = db.upsertComment(comment);
  assert.equal(second.inserted, false);
  assert.equal(db.hashSeen('hash-1'), true);
  assert.equal(db.hashSeen('hash-2'), false);
  const counts = db.countComments();
  assert.equal(counts.total, 1);
  assert.equal(counts.eligible, 1);
  db.close();
  cleanup();
});

test('job lifecycle: claim, progress, cancel, recover', () => {
  const { db, cleanup } = freshDb();
  const job = db.createJob({ maxAttempts: 3 });
  assert.equal(job.status, JOB_STATUS.QUEUED);

  const claimed = db.claimNextJob();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, JOB_STATUS.RUNNING);

  db.updateJob(job.id, { stage: 'build_site', progress: 30 });
  db.updateJobState(job.id, { brief: { title: 'Demo' } });
  const updated = db.getJob(job.id);
  assert.equal(updated.stage, 'build_site');
  assert.equal(updated.progress, 30);
  assert.equal(updated.state.brief.title, 'Demo');

  db.requestCancel(job.id);
  assert.equal(db.getJob(job.id).cancel_requested, 1);

  const second = db.createJob({});
  db.claimNextJob();
  const recovered = db.recoverInterruptedJobs();
  assert.ok(recovered >= 1);
  assert.equal(db.getJob(second.id).status, JOB_STATUS.RETRYING);
  assert.equal(db.getJob(job.id).status, JOB_STATUS.CANCELED);
  db.close();
  cleanup();
});

test('failed jobs retry with a scheduled time, then fail permanently', () => {
  const { db, cleanup } = freshDb();
  const job = db.createJob({ maxAttempts: 2 });
  db.claimNextJob();
  const retryAt = new Date(Date.now() - 1000).toISOString();
  db.markJobFailed(job.id, { error: 'boom', stage: 'build_site', attempt: 1, retryAt });
  const retrying = db.getJob(job.id);
  assert.equal(retrying.status, JOB_STATUS.RETRYING);
  assert.equal(retrying.error, 'boom');
  assert.ok(db.claimNextJob(), 'retrying job should be claimable after next_run_at');

  db.markJobFailed(job.id, { error: 'boom again', stage: 'build_site', attempt: 2, retryAt: null });
  const failed = db.getJob(job.id);
  assert.equal(failed.status, JOB_STATUS.FAILED);
  assert.equal(failed.next_run_at, null);
  db.close();
  cleanup();
});

test('stats aggregate comments, jobs, websites, videos and uploads', () => {
  const { db, cleanup } = freshDb();
  const comment = db.upsertComment({ id: 'c1', text: 'Build me a garden planner please', content_hash: 'h', status: 'used' }).comment;
  const job = db.createJob({ commentId: comment.id });
  db.updateJob(job.id, { status: 'succeeded', progress: 100 });
  const site = db.saveWebsite({ job_id: job.id, title: 'Garden', dir: '/tmp/x', status: 'verified', deploy_url: 'https://example.com' });
  const video = db.saveVideo({ job_id: job.id, website_id: site.id, output_path: '/tmp/v.mp4', status: 'rendered', duration_sec: 30 });
  db.saveUpload({ video_id: video.id, job_id: job.id, status: 'uploaded', youtube_video_id: 'abc' });

  const stats = db.stats();
  assert.equal(stats.comments.total, 1);
  assert.equal(stats.jobs.succeeded, 1);
  assert.equal(stats.websites.deployed, 1);
  assert.equal(stats.videos.rendered, 1);
  assert.equal(stats.uploads.uploaded, 1);

  // Duplicate upload records are rejected by the unique video_id constraint.
  const duplicate = db.saveUpload({ video_id: video.id, job_id: job.id, status: 'uploaded' });
  assert.equal(duplicate.id, db.getUploadByVideo(video.id).id);
  db.close();
  cleanup();
});

test('settings round-trip JSON values', () => {
  const { db, cleanup } = freshDb();
  db.setSetting('automation', { paused: true, dailyJobLimit: 2 });
  assert.deepEqual(db.getSetting('automation'), { paused: true, dailyJobLimit: 2 });
  assert.deepEqual(db.allSettings().automation, { paused: true, dailyJobLimit: 2 });
  db.close();
  cleanup();
});

test('api usage is aggregated per service and day', () => {
  const { db, cleanup } = freshDb();
  db.recordUsage({ service: 'youtube', operation: 'commentThreads.list', units: 1 });
  db.recordUsage({ service: 'youtube', operation: 'commentThreads.list', units: 1 });
  db.recordUsage({ service: 'openrouter', operation: 'chat', units: 1, calls: 1 });
  const usage = db.usageForDay();
  assert.equal(usage.youtube.units, 2);
  assert.equal(usage.openrouter.calls, 1);
  db.close();
  cleanup();
});

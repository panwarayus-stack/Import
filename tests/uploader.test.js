'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('../src/lib/process');
const { resolveBinaries } = require('../src/lib/media');
const { YouTubeUploader, sanitizeTitle, normalizeTags } = require('../src/services/youtube-uploader');
const { testConfig, testDb, silentLogger } = require('./helpers');

const bins = resolveBinaries(testConfig().config);
const hasFfmpeg = Boolean(bins.ffmpeg);

async function makeVideo(dir, { size = '1080x1920', seconds = 4, withAudio = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `video-${size}-${withAudio ? 'a' : 'v'}.mp4`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await runCommand(bins.ffmpeg, args, { timeoutMs: 120000 });
  return file;
}

test('titles are sanitised to YouTube rules', () => {
  assert.equal(sanitizeTitle('  Hello <script> world  '), 'Hello script world');
  const long = sanitizeTitle('x'.repeat(200));
  assert.ok(long.length <= 100);
  assert.ok(long.endsWith('...'));
});

test('tags are normalised and deduplicated', () => {
  const tags = normalizeTags(['#Demo', 'demo', 'a', 'Website Build', 'website build', '<tag>']);
  assert.deepEqual(tags, ['demo', 'website build', 'tag']);
  assert.ok(normalizeTags(Array.from({ length: 40 }, (_, i) => `tag-number-${i}`)).length <= 15);
});

test('metadata includes the live URL, the credit line and defaults to private', () => {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const uploader = new YouTubeUploader(ctx.config, { db, logger: silentLogger(db), oauth: { isConnected: () => true } });
  const metadata = uploader.buildMetadata({
    script: { title: 'A comment became a site', description: 'Short description.', tags: ['demo'] },
    websiteUrl: 'https://example.github.io/comment-site-abc/',
    author: '@viewer',
    comment: 'I wanted a meal planner',
  });
  assert.match(metadata.title, /#Shorts$/);
  assert.ok(metadata.title.length <= 100);
  assert.match(metadata.description, /https:\/\/example\.github\.io\/comment-site-abc\//);
  assert.match(metadata.description, /@viewer/);
  assert.equal(metadata.privacyStatus, 'private');
  const publicConfig = testConfig({ upload: { allowPublicUpload: true, privacy: 'public' } });
  const publicUploader = new YouTubeUploader(publicConfig.config, { db, logger: silentLogger(db) });
  assert.equal(publicUploader.privacy, 'public');
  db.close();
  ctx.cleanup();
  publicConfig.cleanup();
});

test('video validation enforces vertical H.264/AAC Shorts requirements', { skip: !hasFfmpeg }, async () => {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const uploader = new YouTubeUploader(ctx.config, { db, logger: silentLogger(db) });
  const dir = path.join(ctx.config.paths.videos, 'upload-test');

  const good = await makeVideo(dir, { size: '1080x1920' });
  const goodResult = await uploader.validateVideo(good);
  assert.equal(goodResult.ok, true, goodResult.problems.join('; '));

  const landscape = await makeVideo(dir, { size: '1920x1080' });
  const landscapeResult = await uploader.validateVideo(landscape);
  assert.equal(landscapeResult.ok, false);
  assert.ok(landscapeResult.problems.some((problem) => /vertical/i.test(problem)));

  const silent = await makeVideo(dir, { size: '1080x1920', withAudio: false });
  const silentResult = await uploader.validateVideo(silent);
  assert.equal(silentResult.ok, false);
  assert.ok(silentResult.problems.some((problem) => /audio/i.test(problem)));

  db.close();
  ctx.cleanup();
});

test('simulated uploads are recorded but never sent to YouTube', { skip: !hasFfmpeg }, async () => {
  const ctx = testConfig();
  const db = testDb(ctx.config);
  const uploader = new YouTubeUploader(ctx.config, { db, logger: silentLogger(db), oauth: { isConnected: () => true } });
  const file = await makeVideo(path.join(ctx.config.paths.videos, 'sim'), {});
  const job = db.createJob({});
  const videoRow = db.saveVideo({ job_id: job.id, output_path: file, status: 'rendered', duration_sec: 4 });
  const result = await uploader.upload({
    videoRow,
    script: { title: 'Demo', description: 'Demo', tags: [] },
    websiteUrl: 'https://example.com',
    simulated: true,
    jobId: job.id,
  });
  assert.equal(result.simulated, true);
  assert.equal(result.upload.status, 'simulated');
  assert.equal(result.upload.youtube_video_id, null);

  // A second attempt on the same video row must be skipped (no duplicate uploads).
  const second = await uploader.upload({ videoRow, script: {}, simulated: true });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_uploaded');

  db.close();
  ctx.cleanup();
});

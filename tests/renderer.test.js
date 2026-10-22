'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('../src/lib/process');
const { resolveBinaries } = require('../src/lib/media');
const { VideoRenderer, escapeFilterPath } = require('../src/services/video-renderer');
const { testConfig, silentLogger } = require('./helpers');

const bins = resolveBinaries(testConfig().config);
const hasFfmpeg = Boolean(bins.ffmpeg);

async function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const recording = path.join(dir, 'recording.mp4');
  const narration = path.join(dir, 'narration.wav');
  await runCommand(
    bins.ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', recording,
    ],
    { timeoutMs: 120000 },
  );
  await runCommand(
    bins.ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-ac', '1', '-c:a', 'pcm_s16le', narration],
    { timeoutMs: 60000 },
  );
  return { recording, narration };
}

const segments = [
  { section: 'hook', text: 'One comment turned into a real website.', startSec: 0, endSec: 2.2 },
  { section: 'context', text: 'A viewer asked for a simple offline meal planner for a family on a budget.', startSec: 2.45, endSec: 6 },
];

test('escapeFilterPath protects FFmpeg filter arguments', () => {
  assert.equal(escapeFilterPath('/tmp/a b/c.ass'), '/tmp/a b/c.ass');
  assert.equal(escapeFilterPath('C:\\x\\y.ass'), 'C\\:/x/y.ass');
  assert.equal(escapeFilterPath("/tmp/it's.ass"), "/tmp/it\\'s.ass");
});

test('renders a valid vertical Short with burned subtitles and audio', { skip: !hasFfmpeg }, async () => {
  const ctx = testConfig();
  const dir = path.join(ctx.config.paths.videos, 'job_render_test');
  const { recording, narration } = await makeFixtures(dir);
  const renderer = new VideoRenderer(ctx.config, { logger: silentLogger() });

  const result = await renderer.render({
    jobId: 'job_render_test',
    recordingPath: recording,
    narrationPath: narration,
    narrationDurationSec: 6,
    segments,
    script: { title: 'Demo' },
  });

  assert.ok(fs.existsSync(result.path));
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.ok(Math.abs(result.fps - 30) < 0.6);
  assert.ok(result.durationSec > 5.5 && result.durationSec < 9, `duration ${result.durationSec}`);
  assert.equal(result.subtitlesBurned, true);
  assert.ok(fs.existsSync(result.subtitlePaths.srt));
  assert.ok(fs.existsSync(result.subtitlePaths.ass));
  assert.ok(result.sizeBytes > 120 * 1024);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
  ctx.cleanup();
});

test('rejects a render whose audio track is silent', { skip: !hasFfmpeg }, async () => {
  const ctx = testConfig();
  const dir = path.join(ctx.config.paths.videos, 'job_silent_test');
  const { recording } = await makeFixtures(dir);
  const silent = path.join(dir, 'silent.wav');
  await runCommand(
    bins.ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '5', '-c:a', 'pcm_s16le', silent],
    { timeoutMs: 30000 },
  );
  const renderer = new VideoRenderer(ctx.config, { logger: silentLogger() });
  await assert.rejects(
    () =>
      renderer.render({
        jobId: 'job_silent_test',
        recordingPath: recording,
        narrationPath: silent,
        narrationDurationSec: 5,
        segments,
      }),
    /failed validation|audio/i,
  );
  ctx.cleanup();
});

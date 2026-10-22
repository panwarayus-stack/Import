'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCues, buildSubtitles, toSrt, toAss, formatSrtTime, formatAssTime, wrapLines, verifySync, splitIntoCues } = require('../src/services/subtitles');
const { testConfig } = require('./helpers');

const segments = [
  { text: 'One comment turned into a real website.', startSec: 0, endSec: 2.4, section: 'hook' },
  { text: 'So we built a single page about meal planning for busy families on a budget.', startSec: 2.65, endSec: 6.9, section: 'context' },
  { text: 'The planner updates instantly while you move the sliders, and the idea filter sorts everything by effort.', startSec: 7.15, endSec: 12.4, section: 'feature' },
  { text: 'The link is in the description.', startSec: 12.65, endSec: 14.2, section: 'outro' },
];

test('formats timestamps correctly', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(3725.456), '01:02:05,456');
  assert.equal(formatAssTime(3725.46), '1:02:05.46');
});

test('cues follow measured segment boundaries exactly', () => {
  const cues = buildCues(segments);
  assert.ok(cues.length >= segments.length);
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[0].end - 2.4) < 0.01);
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].start >= cues[i - 1].start, 'cues are ordered');
    assert.ok(cues[i].start >= cues[i - 1].end - 0.001, 'cues never overlap');
  }
  const last = cues[cues.length - 1];
  assert.ok(Math.abs(last.end - 14.2) < 0.01);
});

test('long segments are split inside their measured window', () => {
  const long = [
    {
      text:
        'This is a deliberately long narration segment that should be broken into several readable subtitle cues, each one short enough for a phone screen, while every cue remains inside the measured audio window for that segment.',
      startSec: 1,
      endSec: 9,
      section: 'feature',
    },
  ];
  const cues = buildCues(long);
  assert.ok(cues.length > 1);
  assert.equal(cues[0].start, 1);
  assert.ok(cues[cues.length - 1].end <= 9.01);
  for (const cue of cues) assert.ok(cue.text.length <= 90, `cue too long: ${cue.text.length}`);
});

test('SRT and ASS outputs are well formed', () => {
  const cues = buildCues(segments);
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.equal(srt.trim().split('\n\n').length, cues.length);
  assert.ok(srt.endsWith('\n'));

  const ass = toAss(cues, { brandText: 'Built from a comment', durationSec: 14.2 });
  assert.ok(ass.includes('[Script Info]'));
  assert.ok(ass.includes('PlayResX: 1080'));
  assert.ok(ass.includes('PlayResY: 1920'));
  assert.ok(ass.includes('Style: Brand'));
  assert.ok(ass.includes('Dialogue: 1,0:00:00.00'));
  assert.equal((ass.match(/^Dialogue: 0,/gm) || []).length, cues.length);
  assert.ok(ass.includes('\\N') || !cues.some((cue) => wrapLines(cue.text).includes('\n')));
});

test('buildSubtitles writes artifacts and verifies sync', () => {
  const ctx = testConfig();
  const result = buildSubtitles({ segments, audioDurationSec: 14.2, video: ctx.config.video, dir: path.join(ctx.config.paths.videos, 'job_test'), brand: 'Built from a comment' });
  assert.ok(fs.existsSync(result.srtPath));
  assert.ok(fs.existsSync(result.assPath));
  const sync = verifySync(result.cues, 14.2);
  assert.equal(sync.ok, true, sync.problems.join('; '));
  ctx.cleanup();
});

test('verifySync flags out-of-sync cues', () => {
  const broken = [
    { start: 0, end: 5, text: 'a' },
    { start: 4, end: 9, text: 'b' },
    { start: 40, end: 41, text: 'c' },
  ];
  const result = verifySync(broken, 10);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length >= 2);
});

test('splitting prefers sentence boundaries', () => {
  const pieces = splitIntoCues({ text: 'First sentence here. Second sentence follows now. Third one arrives later.' }, { maxChars: 30 });
  assert.ok(pieces.every((piece) => piece.length <= 30 || !piece.includes(' ')));
  assert.ok(pieces.join(' ').includes('Second sentence'));
});

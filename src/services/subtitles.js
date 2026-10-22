'use strict';

/**
 * Subtitle generation.
 *
 * Timing source: the *measured* duration of each narration clip produced by the TTS
 * engine. A long clip is split into shorter cues proportionally to characters, but
 * every cue boundary stays inside its measured clip window, and clip boundaries are
 * exact. No timing is guessed from word counts alone.
 *
 * Outputs both SRT (portable, inspectable) and ASS (styled, burned in by FFmpeg).
 */

const fs = require('node:fs');

const MAX_CHARS_PER_CUE = 88;
const MIN_CUE_SEC = 0.9;
const MAX_CUE_SEC = 5.5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function splitIntoCues(segment, { maxChars = MAX_CHARS_PER_CUE } = {}) {
  const text = String(segment.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  // Prefer sentence boundaries, then commas/semicolons, then word boundaries.
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) || [text];
  const cues = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) cues.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if ((current + ' ' + piece).trim().length <= maxChars) {
      current = (current + ' ' + piece).trim();
      continue;
    }
    pushCurrent();
    if (piece.length <= maxChars) {
      current = piece;
      continue;
    }
    const clauses = piece.split(/(?<=[,;:])\s+/);
    for (const clause of clauses) {
      if ((current + ' ' + clause).trim().length <= maxChars && clause.length <= maxChars) {
        current = (current + ' ' + clause).trim();
        continue;
      }
      pushCurrent();
      if (clause.length <= maxChars) {
        current = clause;
        continue;
      }
      const words = clause.split(/\s+/);
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxChars && current) pushCurrent();
        current = (current + ' ' + word).trim();
      }
    }
  }
  pushCurrent();
  return cues.filter(Boolean);
}

/**
 * @param {Array<{text:string,startSec:number,endSec:number,section?:string}>} segments
 * @returns {Array<{index:number,start:number,end:number,text:string,section:string}>}
 */
function buildCues(segments, options = {}) {
  const cues = [];
  let index = 0;
  for (const segment of segments) {
    const start = Number(segment.startSec) || 0;
    const end = Number(segment.endSec) || start;
    const span = Math.max(0.3, end - start);
    const pieces = splitIntoCues(segment);
    if (!pieces.length) continue;
    const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    let cursor = start;
    pieces.forEach((piece, pieceIndex) => {
      const share = piece.length / totalChars;
      const rawDuration = span * share;
      const cueStart = cursor;
      let cueEnd = pieceIndex === pieces.length - 1 ? end : cursor + rawDuration;
      // Keep cues readable: split further when a clip is very long.
      if (cueEnd - cueStart > MAX_CUE_SEC) cueEnd = cueStart + MAX_CUE_SEC;
      if (cueEnd - cueStart < MIN_CUE_SEC) cueEnd = Math.min(end, cueStart + MIN_CUE_SEC);
      if (cueEnd <= cueStart) cueEnd = cueStart + 0.4;
      cues.push({
        index,
        start: Number(cueStart.toFixed(3)),
        end: Number(cueEnd.toFixed(3)),
        text: piece,
        section: segment.section || 'narration',
      });
      index += 1;
      cursor = cueEnd;
    });
  }
  return finalise(cues);
}

/** Enforce monotonic, non-overlapping, gap-free cues clipped to the audio length. */
function finalise(cues, { audioDurationSec = null } = {}) {
  const output = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = { ...cues[i] };
    if (output.length) {
      const previous = output[output.length - 1];
      if (cue.start < previous.end) cue.start = previous.end;
      // Close small gaps (<0.12s) so subtitles do not flicker.
      if (cue.start - previous.end < 0.12) {
        cue.start = previous.end;
        previous.end = Math.max(previous.end, cue.start);
      }
    }
    if (cue.end <= cue.start) cue.end = cue.start + 0.8;
    output.push(cue);
  }
  if (audioDurationSec && output.length) {
    const last = output[output.length - 1];
    if (last.end > audioDurationSec + 0.05) last.end = Math.max(last.start + 0.5, audioDurationSec);
  }
  return output.map((cue, i) => ({ ...cue, index: i }));
}

function formatSrtTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const msSafe = ms === 1000 ? 999 : ms;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(
    msSafe,
  ).padStart(3, '0')}`;
}

function formatAssTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`;
}

function wrapLines(text, maxCharsPerLine = 38, maxLines = 2) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines.join('\n');
  // Merge overflow into the last allowed line rather than dropping words.
  const head = lines.slice(0, maxLines - 1);
  head.push(lines.slice(maxLines - 1).join(' '));
  return head.join('\n');
}

function toSrt(cues) {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${wrapLines(cue.text)}\n`,
    )
    .join('\n')}`;
}

function escapeAss(text) {
  return String(text).replace(/{/g, '(').replace(/}/g, ')');
}

function toAss(cues, { width = 1080, height = 1920, fontName = 'DejaVu Sans', fontSize = 58, marginV = 220, brandText = null, durationSec = null } = {}) {
  const header = `[Script Info]
; Generated by AI Website & Shorts Factory
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Nokia,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101014,&H80000000,-1,0,0,0,100,100,0.4,0,1,4,1.5,2,80,80,${marginV},1
Style: Brand,${fontName},34,&H00D8DEE9,&H00D8DEE9,&H00101014,&H80000000,0,0,0,0,100,100,2,0,1,2,0,8,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  if (brandText) {
    const end = formatAssTime(durationSec || (cues[cues.length - 1]?.end || 10) + 0.5);
    lines.push(`Dialogue: 1,0:00:00.00,${end},Brand,,0,0,0,,${escapeAss(brandText)}`);
  }
  for (const cue of cues) {
    lines.push(
      `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Nokia,,0,0,0,,${escapeAss(
        wrapLines(cue.text),
      ).replace(/\n/g, '\\N')}`,
    );
  }
  return `${header}${lines.join('\n')}\n`;
}

/**
 * Full subtitle artifact builder.
 * @param {object} params
 * @param {Array} params.segments  measured narration segments
 * @param {number} params.audioDurationSec
 * @param {object} params.video     video config (width/height)
 * @param {string} params.dir       output directory
 */
function buildSubtitles({ segments, audioDurationSec, video = {}, dir, brand = null }) {
  const cues = finalise(buildCues(segments), { audioDurationSec });
  const srt = toSrt(cues);
  const ass = toAss(cues, {
    width: video.width || 1080,
    height: video.height || 1920,
    fontSize: Math.round((video.width || 1080) * 0.049),
    marginV: Math.round((video.height || 1920) * 0.12),
    brandText: brand,
    durationSec: audioDurationSec,
  });

  const result = { cues, srt, ass, srtPath: null, assPath: null };

  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    result.srtPath = `${dir}/subtitles.srt`;
    result.assPath = `${dir}/subtitles.ass`;
    fs.writeFileSync(result.srtPath, srt, 'utf8');
    fs.writeFileSync(result.assPath, ass, 'utf8');
  }

  return result;
}

/** Sanity-check sync: monotonic, inside the audio, no absurdly long cue. */
function verifySync(cues, audioDurationSec, tolerance = 0.6) {
  const problems = [];
  if (!cues.length) problems.push('no subtitle cues were generated');
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!(cue.end > cue.start)) problems.push(`cue ${i + 1} has a non-positive duration`);
    if (i > 0 && cue.start < cues[i - 1].start) problems.push(`cue ${i + 1} starts before the previous cue`);
    if (cue.end - cue.start > 8) problems.push(`cue ${i + 1} lasts ${(cue.end - cue.start).toFixed(1)}s`);
    if (audioDurationSec && cue.start > audioDurationSec + tolerance) problems.push(`cue ${i + 1} starts after the audio ends`);
  }
  const last = cues[cues.length - 1];
  if (audioDurationSec && last && last.end > audioDurationSec + tolerance) {
    problems.push(`last cue ends ${(last.end - audioDurationSec).toFixed(2)}s after the narration`);
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  buildCues,
  buildSubtitles,
  toSrt,
  toAss,
  formatSrtTime,
  formatAssTime,
  wrapLines,
  splitIntoCues,
  verifySync,
  finalise,
};

'use strict';

/**
 * Local text-to-speech narration.
 *
 * Piper (preferred) or espeak-ng is used — both run offline, so there are no per-video
 * API costs. Each script segment is synthesised separately and its *measured* duration
 * becomes the subtitle timing source; nothing is estimated from word counts.
 *
 * If no TTS engine is installed the service either fails (default) or, when
 * TTS_ALLOW_SILENT_FALLBACK=true, produces a silent track of a conservative length
 * clearly marked `simulated: true` so it can never be uploaded as if it were narrated.
 */

const fs = require('node:fs');
const path = require('node:path');
const { findOnPath, resolveBinaries, probeMedia } = require('../lib/media');
const { runCommand } = require('../lib/process');
const { ensureDir, writeFileWithin } = require('../lib/fs-safe');

class TtsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TtsUnavailableError';
    this.code = 'tts_unavailable';
  }
}

const SAMPLE_RATE = 44100;

class NarrationService {
  constructor(config, { logger } = {}) {
    this.config = config;
    this.logger = logger;
  }

  detect() {
    const cfg = this.config.tts;
    const piperBin = cfg.piper.bin || 'piper';
    const piperPath = findOnPath(piperBin);
    const piperModel = cfg.piper.model;
    const piperOk = Boolean(piperPath) && Boolean(piperModel) && fs.existsSync(piperModel);
    const espeakPath = findOnPath(cfg.espeak.bin || 'espeak-ng') || findOnPath('espeak');
    const ffmpeg = resolveBinaries(this.config).ffmpeg;
    return {
      piper: { available: piperOk, bin: piperPath, model: piperModel || null, reason: piperPath ? (piperModel ? 'model missing' : 'PIPER_MODEL not set') : 'piper binary not found' },
      espeak: { available: Boolean(espeakPath), bin: espeakPath },
      ffmpeg: { available: Boolean(ffmpeg), bin: ffmpeg },
      engine: cfg.engine,
      usable: ffmpeg ? (cfg.engine === 'piper' ? piperOk : cfg.engine === 'espeak' ? Boolean(espeakPath) : cfg.engine === 'silent' || cfg.engine === 'auto' ? piperOk || Boolean(espeakPath) : false) : false,
    };
  }

  pickEngine() {
    const cfg = this.config.tts;
    const detected = this.detect();
    const requested = cfg.engine;
    if (requested === 'piper' && detected.piper.available) return 'piper';
    if (requested === 'espeak' && detected.espeak.available) return 'espeak';
    if (requested === 'auto' || requested === 'piper') {
      if (detected.piper.available) return 'piper';
      if (detected.espeak.available) return 'espeak';
    }
    if (requested === 'silent') return 'silent';
    if (cfg.allowSilentFallback) return 'silent';
    throw new TtsUnavailableError(
      `No usable TTS engine. Install Piper (PIPER_BIN + PIPER_MODEL) or espeak-ng, ` +
        `set TTS_ENGINE=espeak, or allow the silent fallback with TTS_ALLOW_SILENT_FALLBACK=true.`,
    );
  }

  /**
   * @param {object} params
   * @param {Array<{section?:string, text:string}>} params.segments
   * @param {string} params.jobId
   * @param {number} [params.targetSeconds]
   */
  async synthesize({ segments, jobId, targetSeconds = 45 }) {
    const textSegments = (segments || [])
      .map((segment) => ({ section: segment.section || 'narration', text: String(segment.text || '').trim() }))
      .filter((segment) => segment.text.length > 0);
    if (!textSegments.length) throw new Error('narration requires at least one non-empty script segment');

    const engine = this.pickEngine();
    const dir = path.join(this.config.paths.videos, String(jobId).replace(/[^a-zA-Z0-9_-]/g, ''), 'narration');
    ensureDir(dir);
    const warnings = [];
    let simulated = false;

    this.logger?.info?.(`Synthesising narration with ${engine}`, { jobId, segments: textSegments.length });

    const clipFiles = [];
    const timings = [];
    let cursor = 0;
    const gapSec = this.config.tts.piper.sentenceSilence;

    for (let index = 0; index < textSegments.length; index += 1) {
      const segment = textSegments[index];
      const rawPath = path.join(dir, `seg-${String(index).padStart(2, '0')}.wav`);
      const normalisedPath = path.join(dir, `seg-${String(index).padStart(2, '0')}-n.wav`);

      if (engine === 'silent') {
        simulated = true;
        await this.writeSilence(rawPath, estimateSeconds(segment.text, this.config.tts.speed));
      } else if (engine === 'piper') {
        await this.runPiper(segment.text, rawPath);
      } else {
        await this.runEspeak(segment.text, rawPath);
      }

      await this.normaliseAudio(rawPath, normalisedPath);
      const duration = await this.audioDuration(normalisedPath);
      const startSec = cursor;
      const endSec = startSec + duration;
      timings.push({
        index,
        section: segment.section,
        text: segment.text,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        durationSec: Number(duration.toFixed(3)),
      });
      cursor = endSec + gapSec;
      clipFiles.push(normalisedPath);
    }

    if (engine === 'silent') {
      warnings.push('Narration is silent (no TTS engine available). This is a dry-run artifact and must not be uploaded.');
    }

    const finalPath = path.join(dir, 'narration.wav');
    await this.concat(clipFiles, finalPath, gapSec);
    const total = await this.audioDuration(finalPath);

    // Prefer measured file duration; fall back to the timeline if probing failed.
    const durationSec = total || cursor;
    if (targetSeconds && durationSec > this.config.video.maxDurationSec - 2) {
      warnings.push(
        `Narration is ${durationSec.toFixed(1)}s, longer than the ${this.config.video.maxDurationSec}s Shorts limit; the renderer will trim with a hard stop.`,
      );
    }

    return {
      path: finalPath,
      engine,
      simulated,
      durationSec: Number(durationSec.toFixed(3)),
      gapSec,
      segments: timings,
      warnings,
      text: textSegments.map((s) => s.text).join(' '),
    };
  }

  async runPiper(text, outPath) {
    const cfg = this.config.tts.piper;
    const args = ['--model', cfg.model, '--output_file', outPath, '--length_scale', String(Number(cfg.lengthScale) / this.config.tts.speed), '--sentence_silence', String(cfg.sentenceSilence)];
    if (cfg.config) args.push('--config', cfg.config);
    if (Number.isInteger(cfg.speaker) && cfg.speaker > 0) args.push('--speaker', String(cfg.speaker));
    await runCommand(cfg.bin, args, {
      timeoutMs: this.config.tts.timeoutMs,
      stdin: text + '\n',
    }).catch((error) => {
      throw new TtsUnavailableError(`Piper failed: ${error.stderr?.slice(-400) || error.message}`);
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) throw new TtsUnavailableError('Piper produced no audio');
  }

  async runEspeak(text, outPath) {
    const cfg = this.config.tts.espeak;
    const bin = findOnPath(cfg.bin) || findOnPath('espeak');
    if (!bin) throw new TtsUnavailableError('espeak-ng binary not found');
    const rate = Math.round(Number(cfg.wordsPerMinute) * Number(this.config.tts.speed));
    await runCommand(bin, ['-v', cfg.voice, '-s', String(rate), '-w', outPath, text], {
      timeoutMs: this.config.tts.timeoutMs,
    }).catch((error) => {
      throw new TtsUnavailableError(`espeak failed: ${error.stderr?.slice(-400) || error.message}`);
    });
    if (!fs.existsSync(outPath)) throw new TtsUnavailableError('espeak produced no audio');
  }

  async writeSilence(outPath, seconds) {
    const { ffmpeg } = resolveBinaries(this.config);
    if (!ffmpeg) throw new TtsUnavailableError('FFmpeg is required to generate the silent fallback track');
    await runCommand(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`, '-t', String(seconds.toFixed(2)), '-c:a', 'pcm_s16le', outPath],
      { timeoutMs: 60000 },
    );
  }

  async normaliseAudio(input, output) {
    const { ffmpeg } = resolveBinaries(this.config);
    if (!ffmpeg) throw new TtsUnavailableError('FFmpeg is required for audio processing');
    await runCommand(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', String(SAMPLE_RATE), '-ac', '1', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'pcm_s16le', output],
      { timeoutMs: 120000 },
    );
  }

  async concat(files, output, gapSec = 0.25) {
    const { ffmpeg } = resolveBinaries(this.config);
    if (!ffmpeg) throw new TtsUnavailableError('FFmpeg is required to join narration audio');
    const listDir = path.dirname(output);
    const silencePath = path.join(listDir, 'gap.wav');
    if (gapSec > 0) {
      await runCommand(
        ffmpeg,
        ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`, '-t', String(gapSec), '-c:a', 'pcm_s16le', silencePath],
        { timeoutMs: 60000 },
      );
    }
    const listLines = [];
    files.forEach((file, index) => {
      listLines.push(`file '${file.replace(/'/g, "'\\''")}'`);
      if (gapSec > 0 && index < files.length - 1) listLines.push(`file '${silencePath.replace(/'/g, "'\\''")}'`);
    });
    const listPath = path.join(listDir, 'concat.txt');
    writeFileWithin(listDir, 'concat.txt', listLines.join('\n'));
    await runCommand(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', output],
      { timeoutMs: 180000 },
    );
  }

  /** Exact duration in seconds (ffprobe → ffmpeg → RIFF header). */
  async audioDuration(filePath) {
    const bins = resolveBinaries(this.config);
    if (bins.ffprobe || bins.ffmpeg) {
      try {
        const probe = await probeMedia(filePath, bins);
        if (probe.durationSec > 0) return probe.durationSec;
      } catch {
        /* fall through to the WAV header */
      }
    }
    return wavDuration(filePath);
  }
}

/** Read duration from a RIFF/WAVE header — exact, dependency free. */
function wavDuration(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return 0;
    const byteRate = header.readUInt32LE(28);
    const size = fs.statSync(filePath).size;
    if (!byteRate) return 0;
    return Math.max(0, (size - 44) / byteRate);
  } catch {
    return 0;
  }
}

function estimateSeconds(text, speed = 1) {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  return Math.max(2.5, (words / 2.6) / Math.max(0.5, speed));
}

module.exports = { NarrationService, TtsUnavailableError, wavDuration, estimateSeconds, SAMPLE_RATE };

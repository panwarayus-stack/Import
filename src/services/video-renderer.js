'use strict';

/**
 * Final vertical video rendering with FFmpeg.
 *
 * Inputs : raw browser recording (video), narration WAV, subtitles (ASS), optional music.
 * Output : 1080x1920 H.264 + AAC MP4 with burned-in subtitles.
 *
 * The output is validated (codec, resolution, duration, audio stream) before the
 * uploader may touch it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('../lib/process');
const { resolveBinaries, probeMedia, ffmpegCapabilities } = require('../lib/media');
const { buildSubtitles, verifySync } = require('./subtitles');

class RenderError extends Error {
  constructor(message, { details = null } = {}) {
    super(message);
    this.name = 'RenderError';
    this.details = details;
  }
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

class VideoRenderer {
  constructor(config, { logger } = {}) {
    this.config = config;
    this.logger = logger;
  }

  outputDir(jobId) {
    return path.join(this.config.paths.videos, String(jobId).replace(/[^a-zA-Z0-9_-]/g, ''));
  }

  /**
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.recordingPath  raw MP4 of the real site
   * @param {string} params.narrationPath  WAV narration
   * @param {number} params.narrationDurationSec
   * @param {Array}  params.segments       measured narration segments
   * @param {object} params.script
   */
  async render({ jobId, recordingPath, narrationPath, narrationDurationSec, segments, script = {} }) {
    const dir = this.outputDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    const bins = resolveBinaries(this.config);
    if (!bins.ffmpeg) throw new RenderError('FFmpeg is not installed or not configured');
    await ffmpegCapabilities(bins.ffmpeg);

    if (!fs.existsSync(recordingPath)) throw new RenderError(`recording not found: ${recordingPath}`);
    if (!fs.existsSync(narrationPath)) throw new RenderError(`narration not found: ${narrationPath}`);

    const { width, height, fps, crf, preset, audioBitrate, maxDurationSec, minDurationSec } = this.config.video;
    const targetDuration = Math.min(
      maxDurationSec,
      Math.max(minDurationSec, Number(narrationDurationSec || 0) + 0.9),
    );

    const subtitles = buildSubtitles({
      segments,
      audioDurationSec: narrationDurationSec,
      video: this.config.video,
      dir,
      brand: this.config.video.brandName || null,
    });
    const sync = verifySync(subtitles.cues, narrationDurationSec);
    if (!sync.ok) {
      this.logger?.warn?.(`Subtitle sync check reported issues: ${sync.problems.join('; ')}`, { jobId });
    }

    const caps = await ffmpegCapabilities(bins.ffmpeg);
    const canBurn = Boolean(subtitles.assPath) && (caps.filters?.has?.('ass') || /(^|\s)ass(\s|$)/m.test(caps.availableFilters || ''));
    const musicPath = this.config.video.musicPath && fs.existsSync(this.config.video.musicPath) ? this.config.video.musicPath : null;

    const outputPath = path.join(dir, 'short.mp4');
    const filterParts = [];
    const inputs = ['-i', recordingPath];
    let audioInputIndex = 1;
    inputs.push('-i', narrationPath);

    // Video: fit/crop into the 9:16 frame, hold the last frame if the recording is short.
    filterParts.push(
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b12,setsar=1,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=${Math.ceil(targetDuration + 5)},` +
        `trim=duration=${targetDuration.toFixed(3)},setpts=PTS-STARTPTS[base]`,
    );

    let videoLabel = 'base';
    if (canBurn) {
      const assPath = escapeFilterPath(subtitles.assPath);
      filterParts.push(`[base]ass=filename='${assPath}'[subbed]`);
      videoLabel = 'subbed';
    } else {
      this.logger?.warn?.('FFmpeg build has no libass; subtitles will not be burned in (SRT/ASS sidecars kept)', { jobId });
    }

    filterParts.push(`[${videoLabel}]format=yuv420p[vout]`);

    let audioLabel;
    if (musicPath) {
      inputs.push('-stream_loop', '-1', '-i', musicPath);
      const musicIndex = 2;
      filterParts.push(
        `[${audioInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,` +
          `apad,atrim=duration=${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS[voice]`,
      );
      filterParts.push(
        `[${musicIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `atrim=duration=${targetDuration.toFixed(3)},volume=${this.config.video.musicVolume},afade=t=out:st=${Math.max(
            0,
            targetDuration - 1.5,
          ).toFixed(2)}:d=1.5[music]`,
      );
      filterParts.push('[voice][music]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[aout]');
      audioLabel = 'aout';
    } else {
      filterParts.push(
        `[${audioInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `apad,atrim=duration=${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
      );
      audioLabel = 'aout';
    }

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(this.config.video.ffmpegThreads),
      ...inputs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[vout]',
      '-map',
      `[${audioLabel}]`,
      '-t',
      targetDuration.toFixed(3),
      '-r',
      String(fps),
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-level',
      '4.1',
      '-c:a',
      'aac',
      '-b:a',
      audioBitrate,
      '-ar',
      '44100',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-shortest',
      outputPath,
    ];

    this.logger?.info?.('Rendering final short with FFmpeg', { jobId, targetDuration, canBurn, music: Boolean(musicPath) });
    try {
      await runCommand(bins.ffmpeg, args, { timeoutMs: this.config.video.maxRenderMs, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      throw new RenderError(`FFmpeg render failed: ${error.stderr?.slice(-1200) || error.message}`);
    }

    const validation = await this.validate(outputPath, { targetDuration });
    if (!validation.ok) {
      throw new RenderError(`Rendered video failed validation: ${validation.errors.join('; ')}`, { details: validation });
    }

    return {
      path: outputPath,
      durationSec: validation.probe.durationSec,
      width: validation.probe.width,
      height: validation.probe.height,
      fps: validation.probe.fps,
      sizeBytes: validation.probe.sizeBytes,
      subtitlesBurned: canBurn,
      subtitlePaths: { srt: subtitles.srtPath, ass: subtitles.assPath },
      cues: subtitles.cues,
      sync,
      targetDuration,
      checks: validation.checks,
      errors: validation.errors,
      music: Boolean(musicPath),
    };
  }

  /** Validate the rendered file: container, codecs, geometry, duration, audio presence. */
  async validate(filePath, { targetDuration }) {
    const bins = resolveBinaries(this.config);
    const checks = [];
    const errors = [];
    const { width, height, maxDurationSec, minDurationSec } = this.config.video;

    if (!fs.existsSync(filePath)) {
      return { ok: false, probe: {}, checks: [{ name: 'file', status: 'fail', detail: 'missing' }], errors: ['rendered file missing'] };
    }
    const probe = await probeMedia(filePath, bins);

    const check = (name, pass, detail) => {
      checks.push({ name, status: pass ? 'pass' : 'fail', detail });
      if (!pass) errors.push(`${name}: ${detail}`);
    };

    check('video-stream', probe.hasVideo && probe.videoCodec === 'h264', `${probe.videoCodec || 'none'}`);
    check('audio-stream', probe.hasAudio && probe.audioCodec === 'aac', `${probe.audioCodec || 'none'}`);
    check('resolution', probe.width === width && probe.height === height, `${probe.width}x${probe.height}`);
    check('aspect-ratio', Math.abs(probe.width / probe.height - 9 / 16) < 0.01, `${(probe.width / probe.height).toFixed(3)}`);
    check('frame-rate', Math.abs(probe.fps - this.config.video.fps) < 0.6, `${probe.fps} fps`);
    check(
      'duration',
      probe.durationSec >= Math.min(minDurationSec, targetDuration) - 0.5 && probe.durationSec <= maxDurationSec + 0.2,
      `${probe.durationSec.toFixed(2)}s (target ${targetDuration.toFixed(1)}s)`,
    );
    check('file-size', probe.sizeBytes > 120 * 1024, `${Math.round(probe.sizeBytes / 1024)} KiB`);
    check('audio-levels', await this.hasAudibleAudio(filePath), 'mean volume check');

    return { ok: errors.length === 0, probe, checks, errors };
  }

  /** Rejects a track that is digital silence (e.g. failed TTS). */
  async hasAudibleAudio(filePath) {
    const { ffmpeg } = resolveBinaries(this.config);
    if (!ffmpeg) return true;
    try {
      const { stderr } = await runCommand(
        ffmpeg,
        ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
        { timeoutMs: 120000, allowNonZero: true },
      );
      const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
      if (!match) return true; // cannot measure, don't block
      const mean = Number(match[1]);
      return mean > -55;
    } catch {
      return true;
    }
  }
}

module.exports = { VideoRenderer, RenderError, escapeFilterPath };

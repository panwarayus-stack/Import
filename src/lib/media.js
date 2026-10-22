'use strict';

/**
 * Binary discovery + media probing.
 *
 * FFmpeg/FFprobe are resolved in this order:
 *   1. explicit env/yml path (FFMPEG_PATH / FFPROBE_PATH)
 *   2. ffmpeg-static / ffprobe-static npm packages (if installed)
 *   3. python imageio-ffmpeg bundled binary (handy on restricted sandboxes)
 *   4. whatever is on PATH
 *
 * Nothing here downloads binaries at runtime; the README documents installation.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCommand } = require('./process');

function findOnPath(bin, env = process.env) {
  if (!bin) return null;
  if (bin.includes(path.sep) || bin.includes('/')) {
    return fileIsExecutable(bin) ? bin : null;
  }
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (fileIsExecutable(candidate)) return candidate;
  }
  return null;
}

function fileIsExecutable(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function tryImageioFfmpeg(logger) {
  try {
    const out = execFileSync('python3', ['-c', 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    if (out && fileIsExecutable(out)) return out;
  } catch (error) {
    logger?.debug?.(`imageio-ffmpeg not available: ${error.message}`);
  }
  return null;
}

const cache = { ffmpeg: null, ffprobe: null, resolved: false };

function resolveBinaries(config = {}, { refresh = false, logger = null } = {}) {
  if (cache.resolved && !refresh) return { ffmpeg: cache.ffmpeg, ffprobe: cache.ffprobe };

  const configuredFfmpeg = config?.video?.ffmpegPath;
  const configuredFfprobe = config?.video?.ffprobePath;

  let ffmpeg = configuredFfmpeg ? (fileIsExecutable(configuredFfmpeg) ? configuredFfmpeg : null) : null;
  if (!ffmpeg) {
    const staticPkg = tryRequire('ffmpeg-static');
    if (staticPkg && fileIsExecutable(staticPkg)) ffmpeg = staticPkg;
  }
  if (!ffmpeg) ffmpeg = tryImageioFfmpeg(logger);
  if (!ffmpeg) ffmpeg = findOnPath('ffmpeg');

  let ffprobe = configuredFfprobe ? (fileIsExecutable(configuredFfprobe) ? configuredFfprobe : null) : null;
  if (!ffprobe) {
    const staticPkg = tryRequire('ffprobe-static');
    if (staticPkg?.path && fileIsExecutable(staticPkg.path)) ffprobe = staticPkg.path;
  }
  if (!ffprobe) ffprobe = findOnPath('ffprobe');
  if (!ffprobe && ffmpeg) {
    // imageio ships only ffmpeg; a sibling ffprobe may exist
    const sibling = path.join(path.dirname(ffmpeg), 'ffprobe');
    if (fileIsExecutable(sibling)) ffprobe = sibling;
  }

  cache.ffmpeg = ffmpeg;
  cache.ffprobe = ffprobe;
  cache.resolved = true;
  return { ffmpeg, ffprobe };
}

const FORMAT_CAPABILITIES = new Map();

async function ffmpegCapabilities(ffmpegPath) {
  if (!ffmpegPath) return { available: false, libx264: false, aac: false, filters: new Set(), version: null };
  if (FORMAT_CAPABILITIES.has(ffmpegPath)) return FORMAT_CAPABILITIES.get(ffmpegPath);
  try {
    const { stdout, stderr } = await runCommand(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    const version = (stdout || stderr).split('\n')[0];
    const encoders = await runCommand(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15000 }).catch(() => ({ stdout: '', stderr: '' }));
    const filters = await runCommand(ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: 15000 }).catch(() => ({ stdout: '', stderr: '' }));
    const encoderText = `${encoders.stdout}${encoders.stderr}`;
    const filterText = `${filters.stdout}${filters.stderr}`;
    const caps = {
      available: true,
      version,
      libx264: /\blibx264\b/.test(encoderText),
      aac: /\baac\b/.test(encoderText),
      drawtext: /\bdrawtext\b/.test(filterText),
      availableFilters: filterText,
      availableEncoders: encoderText,
    };
    caps.filters = new Set((filterText.match(/^\s*[TSC.]{3}\s+(\w+)/gm) || []).map((line) => line.trim().split(/\s+/)[1]));
    FORMAT_CAPABILITIES.set(ffmpegPath, caps);
    return caps;
  } catch (error) {
    const caps = { available: false, libx264: false, aac: false, filters: new Set(), version: null, error: error.message };
    FORMAT_CAPABILITIES.set(ffmpegPath, caps);
    return caps;
  }
}

/**
 * Probe a media file. Returns duration/size/codecs and `hasAudio`.
 * Falls back to parsing `ffmpeg -i` when ffprobe is unavailable.
 */
async function probeMedia(filePath, options = {}) {
  const { timeoutMs = 30000 } = options;
  // Accept either explicit paths or the { ffmpeg, ffprobe } shape from resolveBinaries().
  const ffprobePath = options.ffprobePath || options.ffprobe || null;
  const ffmpegPath = options.ffmpegPath || options.ffmpeg || null;
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (ffprobePath) {
    try {
      const { stdout } = await runCommand(
        ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeoutMs },
      );
      const data = JSON.parse(stdout);
      const video = (data.streams || []).find((s) => s.codec_type === 'video');
      const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
      return {
        sizeBytes: stat.size,
        durationSec: Number(data.format?.duration) || 0,
        formatName: data.format?.format_name || null,
        bitrate: Number(data.format?.bit_rate) || 0,
        width: video?.width || 0,
        height: video?.height || 0,
        fps: parseFps(video?.r_frame_rate || video?.avg_frame_rate),
        videoCodec: video?.codec_name || null,
        audioCodec: audio?.codec_name || null,
        hasAudio: Boolean(audio),
        hasVideo: Boolean(video),
        raw: data,
      };
    } catch {
      /* fall through to ffmpeg parsing */
    }
  }
  if (!ffmpegPath) throw new Error('neither ffprobe nor ffmpeg is available to inspect media');
  const { stderr } = await runCommand(ffmpegPath, ['-hide_banner', '-i', filePath], {
    timeoutMs,
    allowNonZero: true,
  });
  const durationMatch = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.?\d*)/);
  const streamMatch = stderr.match(/Stream #\d+:\d+.*?: Video: (\w+).*?(\d{2,5})x(\d{2,5})/);
  const audioMatch = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(stderr);
  const fpsMatch = stderr.match(/(\d+(?:\.\d+)?) fps/);
  const durationSec = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  return {
    sizeBytes: stat.size,
    durationSec,
    width: streamMatch ? Number(streamMatch[2]) : 0,
    height: streamMatch ? Number(streamMatch[3]) : 0,
    fps: fpsMatch ? Number(fpsMatch[1]) : 0,
    videoCodec: streamMatch ? streamMatch[1] : null,
    audioCodec: audioMatch ? audioMatch[1] : null,
    hasAudio: Boolean(audioMatch),
    hasVideo: Boolean(streamMatch),
    raw: { stderr },
  };
}

function parseFps(value) {
  if (!value || typeof value !== 'string') return 0;
  const [num, den] = value.split('/').map(Number);
  if (!num) return 0;
  if (!den) return num;
  return Number((num / den).toFixed(3));
}

function resetMediaCache() {
  cache.ffmpeg = null;
  cache.ffprobe = null;
  cache.resolved = false;
  FORMAT_CAPABILITIES.clear();
}

module.exports = {
  resolveBinaries,
  ffmpegCapabilities,
  probeMedia,
  findOnPath,
  fileIsExecutable,
  resetMediaCache,
  parseFps,
};

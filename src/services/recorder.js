'use strict';

/**
 * Records the *real* deployed website with Playwright.
 *
 * Strategy "frames" (default, deterministic):
 *   - 1080x1920 viewport, headless Chromium
 *   - eased scroll through the meaningful sections
 *   - one interaction (tab/filter/accordion) where available
 *   - screenshots captured at a fixed cadence, encoded by FFmpeg into a CFR MP4
 * This avoids depending on Playwright's bundled video codec while still recording
 * actual browser frames of the live page.
 *
 * Strategy "screenshot-fallback" is used only when no browser can be launched; it is
 * labelled simulated and never allowed to upload unless explicitly enabled.
 */

const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser } = require('../lib/browser');
const { resolveBinaries, probeMedia } = require('../lib/media');
const { runCommand } = require('../lib/process');
const { ensureDir, removeDir } = require('../lib/fs-safe');

class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.code = 'browser_unavailable';
  }
}

class Recorder {
  constructor(config, { logger } = {}) {
    this.config = config;
    this.logger = logger;
  }

  outputDir(jobId) {
    return path.join(this.config.paths.recordings, String(jobId).replace(/[^a-zA-Z0-9_-]/g, ''));
  }

  /**
   * Record a live URL.
   * @param {object} params
   * @param {string} params.url           verified live URL
   * @param {string} params.jobId
   * @param {number} params.targetDurationSec narration length (recording is paced to it)
   * @param {Array<{label:string, weight:number}>} params.chapters optional section labels
   */
  async record({ url, jobId, targetDurationSec = 30, chapters = null, timeoutMs = null }) {
    const started = Date.now();
    const { width, height } = {
      width: this.config.recording.viewportWidth,
      height: this.config.recording.viewportHeight,
    };
    const dir = this.outputDir(jobId);
    const framesDir = path.join(dir, 'frames');
    ensureDir(framesDir);

    this.logger?.info?.(`Recording ${url}`, { jobId, viewport: `${width}x${height}` });

    let browserHandle;
    try {
      browserHandle = await launchBrowser(this.config, { viewport: { width, height } });
    } catch (error) {
      throw new BrowserUnavailableError(error.message);
    }

    const { browser, context } = browserHandle;
    const duration = Math.min(this.config.recording.maxDurationSec, Math.max(6, targetDurationSec));
    const frameRate = this.config.recording.captureFps;
    const totalFrames = Math.min(1200, Math.round(duration * frameRate));
    const frameFiles = [];

    try {
      const targetOrigin = new URL(url).origin;
      await context.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (
          requestUrl.startsWith(targetOrigin) ||
          requestUrl.startsWith('data:') ||
          requestUrl.startsWith('blob:') ||
          requestUrl.startsWith('about:')
        ) {
          return route.continue();
        }
        // Generated sites must be self-contained; block private networks + third parties.
        return route.abort();
      });
      // Never let the recorded page reach localhost / metadata services through the browser.
      await context.route(/(^|\/\/)(127\.0\.0\.1|localhost|169\.254\.169\.254|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:|\/)/, (route) =>
        route.abort(),
      );

      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs || this.config.recording.timeoutMs);

      let status = 0;
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout: this.config.recording.timeoutMs });
        status = response?.status() || 0;
      } catch (error) {
        throw new Error(`Could not open ${url}: ${error.message}`);
      }
      if (status >= 400) throw new Error(`Live URL returned HTTP ${status}; refusing to record an error page.`);

      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      // Wait for fonts/animations to settle; verify there is actually content.
      await page.waitForTimeout(this.config.recording.settleMs);
      const metrics = await page.evaluate(() => ({
        text: (document.body?.innerText || '').trim().length,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        sections: Array.from(document.querySelectorAll('section')).length,
        fontsReady: document.fonts ? document.fonts.status : 'unknown',
      }));
      if (metrics.text < 80) throw new Error('Page has almost no visible text; refusing to record a blank page.');

      const maxScroll = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
      const sections = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('section, [data-section], header.hero, main > div'));
        return items.slice(0, 8).map((el, index) => {
          const rect = el.getBoundingClientRect();
          return {
            index,
            label: (el.querySelector('h1, h2, h3')?.textContent || `Section ${index + 1}`).trim().slice(0, 60),
            top: Math.max(0, Math.round(rect.top + window.scrollY)),
          };
        });
      });

      const plan = buildScrollPlan({
        maxScroll,
        viewportHeight: metrics.viewportHeight,
        sections: chapters?.length ? chapters.map((c, i) => ({ label: c.label, top: (maxScroll * i) / Math.max(1, chapters.length) })) : sections,
        maxSections: this.config.recording.maxScrollSections,
        durationSec: duration,
        frameRate,
        totalFrames,
        scrollStepPx: this.config.recording.scrollStepPx,
      });

      this.logger?.info?.(`Recording plan: ${plan.chapters.length} chapters, ${totalFrames} frames`, { jobId });

      const interactionFrame = Math.floor(totalFrames * 0.55);
      let interactionDone = false;

      for (let i = 0; i < totalFrames; i += 1) {
        const point = plan.points[i];
        if (point.interaction && !interactionDone) {
          interactionDone = true;
          await this.performInteraction(page);
        }
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), point.y).catch(() => {});
        // Let lazy content/observers run, then grab a real frame.
        await page.waitForTimeout(Math.max(35, Math.round(1000 / frameRate / 2)));
        const frameFile = path.join(framesDir, `f_${String(i).padStart(5, '0')}.jpg`);
        await page.screenshot({ path: frameFile, type: 'jpeg', quality: 88, animations: 'allow' });
        frameFiles.push(frameFile);
      }

      // Return to the hero so the last frame is not an arbitrary mid-page position.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
      await page.waitForTimeout(500);
      const closingFrame = path.join(framesDir, `f_${String(totalFrames).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: closingFrame, type: 'jpeg', quality: 88 });
      frameFiles.push(closingFrame);

      const rawPath = path.join(dir, 'raw-recording.mp4');
      await this.encodeFrames(framesDir, rawPath, frameRate);
      await removeDir(framesDir);

      const probe = await probeMedia(rawPath, {
        ...resolveBinaries(this.config, { logger: this.logger }),
      });

      const chapters = plan.chapters.map((chapter) => ({
        label: chapter.label,
        startSec: Number((chapter.frameIndex / frameRate).toFixed(2)),
      }));

      this.logger?.info?.(`Recording complete in ${Date.now() - started}ms`, {
        jobId,
        duration: probe.durationSec,
        size: probe.sizeBytes,
      });

      return {
        path: rawPath,
        mode: 'frames',
        simulated: false,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        chapters,
        capturedFrames: frameFiles.length,
        sourceUrl: url,
        pageMetrics: metrics,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async performInteraction(page) {
    try {
      const target = await page.$('[data-filter], [role="tab"], .chip, .tab, .accordion-trigger');
      if (!target) return;
      const box = await target.boundingBox();
      if (!box || box.width < 4 || box.height < 4) return;
      await target.click({ timeout: 2500 });
      await page.waitForTimeout(700);
      // Scroll the clicked control into view so the interaction is visible.
      await page.evaluate((el) => el?.scrollIntoView?.({ block: 'center', behavior: 'instant' }), null).catch(() => {});
    } catch (error) {
      this.logger?.debug?.(`Interaction during recording skipped: ${error.message}`);
    }
  }

  async encodeFrames(framesDir, outPath, frameRate) {
    const { ffmpeg } = resolveBinaries(this.config, { logger: this.logger });
    if (!ffmpeg) throw new Error('FFmpeg is required to encode the recording');
    const { width, height, fps } = this.config.video;
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-framerate',
      String(frameRate),
      '-i',
      path.join(framesDir, 'f_%05d.jpg'),
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b12,fps=${fps}`,
      '-c:v',
      'libx264',
      '-preset',
      this.config.video.preset,
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath,
    ];
    await runCommand(ffmpeg, args, { timeoutMs: this.config.video.maxRenderMs });
    if (!fs.existsSync(outPath)) throw new Error('FFmpeg did not produce a recording file');
  }

  /**
   * Fallback used when Chromium cannot launch: build a slow Ken-Burns video from the
   * deployed-site screenshot. Clearly simulated.
   */
  async recordScreenshotFallback({ screenshotPath, jobId, targetDurationSec = 30 }) {
    const { ffmpeg } = resolveBinaries(this.config, { logger: this.logger });
    if (!ffmpeg) throw new Error('FFmpeg is required to build the screenshot fallback video');
    if (!fs.existsSync(screenshotPath)) throw new Error('screenshot missing for fallback recording');
    const dir = this.outputDir(jobId);
    ensureDir(dir);
    const outPath = path.join(dir, 'raw-recording.mp4');
    const { width, height, fps } = this.config.video;
    const duration = Math.max(6, Math.min(this.config.recording.maxDurationSec, targetDurationSec));
    const frames = Math.round(duration * fps);
    const zoom = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='min(zoom+0.0006,1.18)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
    await runCommand(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-t', String(duration), '-i', screenshotPath, '-vf', zoom, '-c:v', 'libx264', '-preset', this.config.video.preset, '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath],
      { timeoutMs: this.config.video.maxRenderMs },
    );
    const probe = await probeMedia(outPath, resolveBinaries(this.config, { logger: this.logger }));
    this.logger?.warn?.('Recorded a screenshot-based fallback video (no browser available)', { jobId });
    return {
      path: outPath,
      mode: 'screenshot-fallback',
      simulated: true,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      chapters: [],
      capturedFrames: 0,
      sourceUrl: null,
    };
  }
}

/**
 * Build a frame-by-frame scroll path across sections, with holds so the viewer can
 * actually read each section. Frames are distributed to fill the narration length.
 */
function buildScrollPlan({ maxScroll, viewportHeight, sections, maxSections = 4, durationSec, frameRate, totalFrames, scrollStepPx = 700 }) {
  const usable = (sections || [])
    .filter((s) => Number.isFinite(s.top))
    .sort((a, b) => a.top - b.top)
    .filter((s, index, arr) => index === 0 || s.top - arr[index - 1].top > 180)
    .slice(0, Math.max(1, maxSections));

  const targets = usable.length ? usable : [{ label: 'Page', top: 0 }];
  const maxFramesForTravel = Math.floor(totalFrames * 0.25);
  const travelFrames = Math.max(2, Math.min(maxFramesForTravel, Math.ceil(maxScroll / scrollStepPx) * Math.max(2, Math.round(frameRate * 0.25))));
  const holdFrames = Math.max(2, Math.floor((totalFrames - travelFrames * Math.max(1, targets.length - 1)) / targets.length));

  const points = [];
  const chapters = [];
  let y = 0;
  let frameIndex = 0;

  const holdFramesFor = (target) => {
    // More text-heavy/longer sections get a little longer on screen.
    return holdFrames;
  };

  // Opening hold on the hero.
  const first = targets[0];
  const heroHold = Math.max(4, Math.floor(totalFrames * 0.14));
  chapters.push({ label: first.label, frameIndex: 0 });
  for (let i = 0; i < heroHold && points.length < totalFrames; i += 1) {
    points.push({ y: 0, interaction: i === Math.floor(heroHold / 2) });
  }
  frameIndex = points.length;

  for (let index = 1; index < targets.length && points.length < totalFrames; index += 1) {
    const from = y;
    const to = Math.min(maxScroll, targets[index].top);
    const steps = Math.max(3, Math.min(travelFrames, totalFrames - points.length - 2));
    chapters.push({ label: targets[index].label, frameIndex: points.length });
    for (let step = 1; step <= steps && points.length < totalFrames; step += 1) {
      const progress = step / steps;
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      points.push({ y: Math.round(from + (to - from) * eased), interaction: false });
    }
    y = to;
    const hold = Math.min(holdFramesFor(targets[index]), Math.max(0, totalFrames - points.length));
    for (let i = 0; i < hold && points.length < totalFrames; i += 1) points.push({ y, interaction: false });
    frameIndex = points.length;
  }

  // Fill any remaining frames with a gentle drift so we never pad with a static image.
  const driftTarget = Math.min(maxScroll, Math.max(y, Math.round(maxScroll * 0.92)));
  while (points.length < totalFrames) {
    const progress = points.length / totalFrames;
    points.push({ y: Math.round(y + (driftTarget - y) * progress), interaction: false });
  }

  return { points: points.slice(0, totalFrames), chapters };
}

module.exports = { Recorder, BrowserUnavailableError, buildScrollPlan };

'use strict';

/**
 * Automated website testing.
 *
 * Two layers:
 *  1. Static validation (always runs): file structure, HTML/CSS/JS syntax,
 *     blocked patterns, local reference integrity.
 *  2. Browser validation (when Chromium is available): real load in a restricted
 *     Playwright context, console/page error capture, blank-page and overflow checks,
 *     desktop + vertical screenshots.
 *
 * A site only passes browser validation when the browser actually ran. When Chromium
 * is unavailable the result is `static-only` and clearly labelled — never "passed".
 */

const fs = require('node:fs');
const path = require('node:path');
const { startStaticServer } = require('../lib/static-server');
const { validateSiteFiles } = require('./website-builder');
const { launchBrowser, browserAvailability } = require('../lib/browser');
const { ensureDir } = require('../lib/fs-safe');

const IGNORED_CONSOLE = [/favicon/i, /Failed to load resource: the server responded with a status of 404/i];

class WebsiteTester {
  constructor(config, { logger } = {}) {
    this.config = config;
    this.logger = logger;
  }

  staticChecks(siteDir, files) {
    const read = files.map((f) => ({
      path: f.path,
      content: fs.readFileSync(path.join(siteDir, f.path), 'utf8'),
    }));
    const validation = validateSiteFiles(read, this.config);
    const checks = [
      {
        name: 'static-validation',
        status: validation.ok ? 'pass' : 'fail',
        detail: validation.ok ? `${read.length} files, ${validation.totalBytes} bytes` : validation.errors.join(' | '),
      },
    ];
    if (validation.warnings.length) {
      checks.push({ name: 'static-warnings', status: 'warn', detail: validation.warnings.join(' | ') });
    }
    return { checks, errors: validation.errors, warnings: validation.warnings };
  }

  async httpCheck(baseUrl) {
    try {
      const response = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const body = await response.text();
      const ok = response.ok && /<html/i.test(body);
      return { ok, status: response.status, bytes: body.length };
    } catch (error) {
      return { ok: false, status: 0, error: error.message };
    }
  }

  /**
   * @param {object} params
   * @param {string} params.siteId
   * @param {string} params.siteDir  directory containing index.html etc.
   * @param {Array<{path:string,size:number}>} params.files
   */
  async test({ siteId, siteDir, files, allowBrowser = true }) {
    const started = Date.now();
    const checks = [];
    const errors = [];
    const warnings = [];

    const stat = this.staticChecks(siteDir, files);
    checks.push(...stat.checks);
    errors.push(...stat.errors);
    warnings.push(...stat.warnings);

    let mode = 'static-only';
    let screenshotPath = null;
    let verticalScreenshotPath = null;
    let browserInfo = { available: false, source: null };

    let serverHandle = null;
    try {
      serverHandle = await startStaticServer(siteDir, { port: 0, host: '127.0.0.1' });
      const http = await this.httpCheck(serverHandle.url);
      checks.push({
        name: 'http-load',
        status: http.ok ? 'pass' : 'fail',
        detail: http.ok ? `HTTP ${http.status}, ${http.bytes} bytes` : `HTTP ${http.status} ${http.error || ''}`.trim(),
      });
      if (!http.ok) errors.push(`local server did not serve the site (${http.status})`);

      browserInfo = await browserAvailability(this.config, { probe: true });
      if (browserInfo.error) {
        checks.push({
          name: 'browser-runtime',
          status: 'warn',
          detail: `Chromium could not be launched: ${browserInfo.error}`,
        });
      }
      if (!allowBrowser || !browserInfo.available) {
        checks.push({
          name: 'browser-validation',
          status: 'warn',
          detail: browserInfo.available
            ? 'browser validation disabled for this run'
            : 'Chromium not available — browser validation skipped (static checks only)',
        });
        if (!browserInfo.available) {
          warnings.push(
            `Browser validation was skipped (${browserInfo.error || 'Chromium is not installed'}). Static checks only.`,
          );
        }
      } else {
        let browserResult;
        try {
          browserResult = await this.runBrowserChecks(serverHandle.url, siteId);
        } catch (error) {
          // Infrastructure failure (missing shared libraries) is not a site defect.
          const launchProblem = /Unable to launch Chromium|shared libraries|install-deps/i.test(error.message);
          browserResult = {
            checks: [
              {
                name: 'browser-validation',
                status: launchProblem ? 'warn' : 'fail',
                detail: launchProblem ? `Chromium unavailable: ${error.message.split('\n')[0]}` : error.message,
              },
            ],
            errors: launchProblem ? [] : [`browser validation error: ${error.message.split('\n')[0]}`],
            warnings: launchProblem ? ['Browser validation was skipped because Chromium could not start.'] : [],
            screenshotPath: null,
            verticalScreenshotPath: null,
          };
        }
        checks.push(...browserResult.checks);
        errors.push(...browserResult.errors);
        warnings.push(...browserResult.warnings);
        screenshotPath = browserResult.screenshotPath;
        verticalScreenshotPath = browserResult.verticalScreenshotPath;
        mode = browserResult.errors.length || browserResult.screenshotPath ? 'browser' : 'static-only';
      }
    } catch (error) {
      checks.push({ name: 'local-server', status: 'fail', detail: error.message });
      errors.push(`test harness error: ${error.message}`);
    } finally {
      if (serverHandle) await serverHandle.close().catch(() => {});
    }

    const ok = errors.length === 0;
    this.logger?.info?.(`Website test ${ok ? 'passed' : 'failed'} (${mode})`, {
      siteId,
      checks: checks.length,
      errors: errors.slice(0, 3),
    });

    return {
      ok,
      mode,
      checks,
      errors,
      warnings,
      screenshotPath,
      verticalScreenshotPath,
      browser: browserInfo,
      durationMs: Date.now() - started,
    };
  }

  async runBrowserChecks(url, siteId) {
    const checks = [];
    const errors = [];
    const warnings = [];
    const shotsDir = path.join(this.config.paths.sites, siteId);
    ensureDir(shotsDir);
    const screenshotPath = path.join(shotsDir, 'screenshot.png');
    const verticalScreenshotPath = path.join(shotsDir, 'screenshot-vertical.png');

    const { browser, context } = await launchBrowser(this.config, { viewport: { width: 1200, height: 900 } });
    try {
      // Block every request that is not the local test server: the generated site must be self-contained.
      const allowedOrigin = new URL(url).origin;
      await context.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (requestUrl.startsWith(allowedOrigin) || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
          return route.continue();
        }
        return route.abort();
      });

      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !IGNORED_CONSOLE.some((re) => re.test(msg.text()))) consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('requestfailed', (req) => {
        if (req.url().startsWith(allowedOrigin)) failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
      });
      page.on('response', (res) => {
        if (res.url().startsWith(allowedOrigin) && res.status() >= 400 && !res.url().endsWith('favicon.ico')) {
          failedRequests.push(`${res.url()} → HTTP ${res.status()}`);
        }
      });

      const response = await page.goto(url, { waitUntil: 'load', timeout: this.config.recording.timeoutMs });
      const status = response?.status() || 0;
      checks.push({
        name: 'page-load',
        status: status === 200 ? 'pass' : 'fail',
        detail: `HTTP ${status}`,
      });
      if (status !== 200) errors.push(`page returned HTTP ${status}`);

      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);

      const title = await page.title();
      checks.push({
        name: 'document-title',
        status: title && title.trim().length > 3 ? 'pass' : 'warn',
        detail: title || '(empty)',
      });
      if (!title || title.trim().length <= 3) warnings.push('Page title is empty or very short.');

      const metrics = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const visibleElements = Array.from(document.body?.querySelectorAll('*') || []).filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }).length;
        return {
          textLength: bodyText.length,
          visibleElements,
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          images: Array.from(document.querySelectorAll('img')).map((img) => ({
            src: img.getAttribute('src'),
            complete: img.complete,
            naturalWidth: img.naturalWidth,
          })),
          unlabelledInputs: Array.from(document.querySelectorAll('input, select, textarea')).filter((input) => {
            if (input.type === 'hidden') return false;
            const id = input.getAttribute('id');
            const hasLabel = id ? document.querySelector(`label[for="${id}"]`) : false;
            return !hasLabel && !input.getAttribute('aria-label') && !input.getAttribute('aria-labelledby');
          }).length,
          h1: document.querySelectorAll('h1').length,
          emptyLinks: Array.from(document.querySelectorAll('a')).filter((a) => !a.textContent.trim() && !a.getAttribute('aria-label')).length,
        };
      });

      const blank = metrics.textLength < 80 || metrics.visibleElements < 5;
      checks.push({
        name: 'blank-page',
        status: blank ? 'fail' : 'pass',
        detail: `${metrics.textLength} chars, ${metrics.visibleElements} visible elements`,
      });
      if (blank) errors.push('Page appears blank or nearly empty.');

      const brokenImages = metrics.images.filter((img) => !img.complete || img.naturalWidth === 0);
      checks.push({
        name: 'images',
        status: brokenImages.length ? 'fail' : 'pass',
        detail: metrics.images.length ? `${metrics.images.length - brokenImages.length}/${metrics.images.length} loaded` : 'no raster images',
      });
      if (brokenImages.length) errors.push(`${brokenImages.length} image(s) failed to load`);

      checks.push({
        name: 'console-errors',
        status: consoleErrors.length ? 'fail' : 'pass',
        detail: consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'none',
      });
      if (consoleErrors.length) errors.push(...consoleErrors.slice(0, 3).map((m) => `console: ${m}`));

      checks.push({
        name: 'page-errors',
        status: pageErrors.length ? 'fail' : 'pass',
        detail: pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : 'none',
      });
      if (pageErrors.length) errors.push(...pageErrors.slice(0, 2).map((m) => `pageerror: ${m}`));

      checks.push({
        name: 'failed-requests',
        status: failedRequests.length ? 'fail' : 'pass',
        detail: failedRequests.length ? failedRequests.slice(0, 3).join(' | ') : 'none',
      });
      if (failedRequests.length) errors.push(...failedRequests.slice(0, 3));

      checks.push({
        name: 'accessibility-smoke',
        status: metrics.unlabelledInputs > 0 || metrics.h1 !== 1 ? 'warn' : 'pass',
        detail: `h1=${metrics.h1}, unlabelled inputs=${metrics.unlabelledInputs}, nameless links=${metrics.emptyLinks}`,
      });
      if (metrics.unlabelledInputs > 0) warnings.push(`${metrics.unlabelledInputs} form control(s) have no label.`);

      // Interaction smoke test: activate the first tab-like button and confirm the DOM changes.
      const interaction = await this.tryInteraction(page);
      checks.push({
        name: 'interaction-smoke',
        status: interaction.changed ? 'pass' : 'warn',
        detail: interaction.detail,
      });

      await page.screenshot({ path: screenshotPath, fullPage: false });

      // Vertical capture used by the dashboard and as a recording fallback.
      const vertical = await context.newPage();
      await vertical.setViewportSize({
        width: this.config.recording.viewportWidth,
        height: this.config.recording.viewportHeight,
      });
      await vertical.goto(url, { waitUntil: 'load', timeout: this.config.recording.timeoutMs }).catch(() => {});
      await vertical.waitForTimeout(700);
      const overflow = await vertical.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (overflow.scrollWidth > overflow.clientWidth + 2) {
        warnings.push(`Horizontal overflow on a ${this.config.recording.viewportWidth}px viewport (${overflow.scrollWidth}px wide).`);
      }
      await vertical.screenshot({ path: verticalScreenshotPath, fullPage: false });
      await vertical.close();
    } catch (error) {
      checks.push({ name: 'browser-run', status: 'fail', detail: error.message });
      errors.push(`browser validation error: ${error.message}`);
    } finally {
      await browser.close().catch(() => {});
    }

    return {
      checks,
      errors,
      warnings,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      verticalScreenshotPath: fs.existsSync(verticalScreenshotPath) ? verticalScreenshotPath : null,
    };
  }

  async tryInteraction(page) {
    try {
      const before = await page.evaluate(() => document.body.innerHTML.length);
      const candidate = await page.$('[role="tab"], [data-tab], .tab, [data-filter], .accordion-trigger, .chip, button');
      if (!candidate) return { changed: false, detail: 'no interactive control found' };
      await candidate.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(350);
      const after = await page.evaluate(() => document.body.innerHTML.length);
      return {
        changed: after !== before,
        detail: after !== before ? 'DOM changed after clicking a control' : 'click produced no DOM change',
      };
    } catch (error) {
      return { changed: false, detail: `interaction check skipped: ${error.message}` };
    }
  }
}

module.exports = { WebsiteTester };

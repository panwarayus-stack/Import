'use strict';

/**
 * Chromium discovery + launch for Playwright.
 *
 * Candidates, in order:
 *   1. CHROMIUM_EXECUTABLE_PATH / PLAYWRIGHT_EXECUTABLE_PATH
 *   2. Playwright's own downloaded browser (`npx playwright install chromium`)
 *   3. System Chrome/Chromium (CHROMIUM_CHANNEL or well-known paths)
 *   4. @sparticuz/chromium (bundled serverless build, optional dependency)
 *
 * If none launch, callers must degrade gracefully (tests/recording are reported as
 * skipped, never as passed).
 */

const fs = require('node:fs');
const path = require('node:path');

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : null,
].filter(Boolean);

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function playwrightCore() {
  try {
    return require('playwright-core');
  } catch {
    return null;
  }
}

async function sparticuzChromium() {
  try {
    const mod = await import('@sparticuz/chromium');
    const chromium = mod.default || mod;
    const exePath = await chromium.executablePath();
    return { executablePath: exePath, args: chromium.args || [] };
  } catch {
    return null;
  }
}

/** Resolve a Chromium candidate without launching it. */
async function resolveChromium(config = {}) {
  const explicit = config.recording?.executablePath;
  if (explicit && exists(explicit)) {
    return { executablePath: explicit, args: [], source: 'configured', channel: null };
  }

  const pw = playwrightCore();
  if (pw) {
    try {
      const p = pw.chromium.executablePath();
      if (exists(p)) return { executablePath: p, args: [], source: 'playwright', channel: null };
    } catch {
      /* playwright browsers not installed */
    }
  }

  const channel = config.recording?.browserChannel;
  if (channel && pw) {
    return { executablePath: null, args: [], source: 'channel', channel };
  }

  for (const candidate of SYSTEM_PATHS) {
    if (exists(candidate)) return { executablePath: candidate, args: [], source: 'system', channel: null };
  }

  if (config.recording?.useSparticuz !== false) {
    const sp = await sparticuzChromium();
    if (sp?.executablePath && exists(sp.executablePath)) {
      return { executablePath: sp.executablePath, args: sp.args, source: 'sparticuz', channel: null };
    }
  }

  return null;
}

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-color-profile=srgb',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * Launch a browser. `Network` isolation is applied by the recorder via route blocking.
 * Returns { browser, context? , executablePath, source } — caller closes it.
 */
async function launchBrowser(config = {}, { viewport = null, recordVideo = null } = {}) {
  const pw = playwrightCore();
  if (!pw) {
    throw new Error('playwright-core is not installed. Run `npm install` and `npx playwright install chromium`.');
  }
  const resolved = await resolveChromium(config);
  if (!resolved) {
    throw new Error(
      'No Chromium/Chrome executable found. Install one with `npx playwright install --with-deps chromium` ' +
        'or set CHROMIUM_EXECUTABLE_PATH.',
    );
  }

  const launchOptions = {
    headless: true,
    executablePath: resolved.executablePath || undefined,
    channel: resolved.channel || undefined,
    args: [...BASE_ARGS, ...(resolved.args || [])],
  };

  let browser;
  try {
    browser = await pw.chromium.launch(launchOptions);
  } catch (error) {
    // Retry with only the essentials: some bundled builds reject certain flags.
    const minimal = ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio'];
    try {
      browser = await pw.chromium.launch({ ...launchOptions, args: minimal });
    } catch (secondError) {
      const firstLine = String(error.message).split('\n')[0].slice(0, 240);
      throw new Error(
        `Unable to launch Chromium (${resolved.source}): ${firstLine}. ` +
          'On Debian/Ubuntu install the runtime libs with `npx playwright install-deps chromium` ' +
          '(libnss3, libnspr4, libasound2, libgbm1, libxkbcommon...).',
      );
    }
  }

  const context = await browser.newContext({
    viewport: viewport || { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: false,
    ...(recordVideo ? { recordVideo } : {}),
  });

  return { browser, context, executablePath: resolved.executablePath, source: resolved.source };
}

let probeCache = { at: 0, value: null };

/**
 * Availability check used by /api/health and the doctor command.
 * With `probe: true` it actually launches and closes a browser, so "available"
 * means "can really render a page", not merely "an executable exists".
 */
async function browserAvailability(config = {}, { probe = false, ttlMs = 60000 } = {}) {
  const resolved = await resolveChromium(config);
  const base = {
    available: Boolean(resolved),
    source: resolved?.source || null,
    executablePath: resolved?.executablePath || null,
    launched: null,
    error: null,
  };
  if (!resolved) {
    base.error = 'No Chromium/Chrome executable found';
    return base;
  }
  if (!probe) return base;
  if (probeCache.value && Date.now() - probeCache.at < ttlMs) return probeCache.value;

  const pw = playwrightCore();
  if (!pw) {
    return { ...base, available: false, error: 'playwright-core is not installed' };
  }
  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      executablePath: resolved.executablePath || undefined,
      channel: resolved.channel || undefined,
      args: [...BASE_ARGS, ...(resolved.args || [])],
      timeout: 30000,
    });
    const page = await browser.newPage();
    await page.setContent('<h1>probe</h1>', { timeout: 15000 });
    const text = await page.textContent('h1');
    const value = { ...base, launched: text === 'probe', available: text === 'probe' };
    probeCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = {
      ...base,
      launched: false,
      available: false,
      error: error.message.split('\n')[0].slice(0, 300),
    };
    probeCache = { at: Date.now(), value };
    return value;
  } finally {
    await browser?.close().catch(() => {});
  }
}

module.exports = { resolveChromium, launchBrowser, browserAvailability, playwrightCore, SYSTEM_PATHS };

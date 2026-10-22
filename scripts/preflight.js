#!/usr/bin/env node
'use strict';

/**
 * Preflight guard.
 *
 * Runs automatically before `npm start` (see package.json → prestart) and can be run on its own
 * with `npm run preflight`, or in a build step with `node scripts/preflight.js --strict`.
 *
 * Purpose: turn the two most common "wrong deploy" failures into one clear sentence instead of a
 * stack trace from a completely different language:
 *
 *   1. The platform built a Python image (a stray main.py / requirements.txt made detection pick
 *      Python, then the process died with ModuleNotFoundError).
 *   2. The platform picked Node < 22.5, where neither better-sqlite3 nor node:sqlite is available.
 *
 * Exit codes: 0 = fine, 1 = blocking problem, 2 = warnings only (with --strict: warnings block too).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const argv = new Set(process.argv.slice(2));
const quiet = argv.has('--quiet');
const asJson = argv.has('--json');
const strict = argv.has('--strict');

const MIN_NODE = [22, 5, 0];
const PYTHON_MARKERS = ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py', 'poetry.lock'];
const PYTHON_ENTRYPOINTS = ['main.py', 'app.py', 'wsgi.py', 'manage.py', 'run.py'];

const problems = [];
const warnings = [];
const notes = [];

/* ---------------------------------------------------------------- runtime */

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const older = major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
  if (older) {
    problems.push(
      `Node ${process.version} is too old — this app needs Node >= ${MIN_NODE.join('.')} ` +
        "because it relies on the built-in node:sqlite. Pin it with .node-version, package.json " +
        "engines, or the platform's NODE_VERSION variable.",
    );
  } else {
    notes.push(`Node ${process.version}`);
  }

  const { driverInfo } = require('../src/lib/sqlite');
  const drivers = driverInfo();
  notes.push(`SQLite driver: ${drivers.betterSqlite3 ? 'better-sqlite3' : drivers.nodeSqlite ? 'node:sqlite' : 'none'}`);
  if (!drivers.betterSqlite3 && !drivers.nodeSqlite) {
    problems.push(
      'No SQLite driver available. Install Node >= 22.5 or rebuild the native module ' +
        '(`npm rebuild better-sqlite3`).',
    );
  }
}

function checkDependencies() {
  const missing = ['express', 'dotenv', 'node-cron', 'playwright-core'].filter((dep) => {
    try {
      require.resolve(`${dep}/package.json`, { paths: [ROOT] });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    problems.push(`Missing dependencies: ${missing.join(', ')}. Run \`npm ci --include=optional\`.`);
  }
}

/* ---------------------------------------------------- wrong-runtime indicators */

function listPythonMarkers(dir, depth = 0, found = [], base = ROOT) {
  if (depth > 2) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'legacy') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listPythonMarkers(full, depth + 1, found, base);
      continue;
    }
    if (entry.name.endsWith('.py') || PYTHON_MARKERS.includes(entry.name)) found.push(path.relative(base, full));
  }
  return found;
}

function checkPythonMarkers() {
  const strays = listPythonMarkers(ROOT);
  if (!strays.length) return;

  const inRoot = strays.filter((file) => !file.includes(path.sep));
  if (inRoot.length) {
    problems.push(
      `Python project files found in the repository root: ${inRoot.join(', ')}. ` +
        'Buildpack auto-detection will build a Python image and the app will never start. ' +
        'Move them out of the repo (or rename them with a .example suffix).',
    );
  } else {
    warnings.push(
      `Python files found outside the root: ${strays.join(', ')}. Most builders ignore these, but a ` +
        'recursive detector may still pick Python — keep them out of deployed branches if unsure.',
    );
  }
}

function checkEntrypoints() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.scripts?.start) problems.push('package.json has no "start" script; the platform has nothing to run.');
  if (pkg.main && !fs.existsSync(path.join(ROOT, pkg.main))) {
    problems.push(`package.json main points at ${pkg.main}, which does not exist.`);
  }
  if (!fs.existsSync(path.join(ROOT, 'src', 'server.js'))) {
    problems.push('src/server.js is missing — the repository is incomplete.');
  }
  if (!fs.existsSync(path.join(ROOT, 'Dockerfile'))) warnings.push('No Dockerfile found; container builds will use buildpack detection.');
  if (!fs.existsSync(path.join(ROOT, '.node-version'))) warnings.push('No .node-version file; the platform may default to an older Node.');
}

/* ------------------------------------------------------------------- runtime dirs */

function checkDirectories() {
  const candidates = ['data', 'generated-sites', 'generated-videos', 'recordings', 'logs', 'credentials'];
  for (const dir of candidates) {
    const full = path.join(ROOT, dir);
    try {
      fs.mkdirSync(full, { recursive: true });
      fs.accessSync(full, fs.constants.W_OK);
    } catch {
      warnings.push(`${dir}/ is not writable — attach a persistent volume or set the matching *_DIR variable.`);
    }
  }
}

/* ------------------------------------------------------------------------ report */

function run() {
  checkNode();
  checkDependencies();
  checkPythonMarkers();
  checkEntrypoints();
  checkDirectories();

  const exitCode = problems.length ? 1 : strict && warnings.length ? 2 : 0;

  if (asJson) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems, warnings, notes, exitCode }, null, 2));
    return exitCode;
  }

  if (problems.length) {
    console.error('\nPREFLIGHT FAILED — this deployment cannot start the application:\n');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    if (warnings.length) {
      console.error('');
      for (const warning of warnings) console.error(`  ! ${warning}`);
    }
    console.error(
      '\nCheck the start command ("npm start"), the build command ' +
        '("npm ci --include=optional --no-audit --no-fund"), and the Node version (>= 22.5).\n' +
        'See docs/deployment.md for platform-specific instructions.\n',
    );
    return exitCode;
  }

  if (!quiet) {
    console.log('Preflight OK');
    for (const note of notes) console.log(`  · ${note}`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
    if (warnings.length && strict) console.log('\nWarnings are treated as failures because --strict is set.');
  }
  return exitCode;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { run, listPythonMarkers };

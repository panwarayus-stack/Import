'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listPythonMarkers } = require('../scripts/preflight');

const ROOT = path.resolve(__dirname, '..');

function runPreflight(...args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'preflight.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('the repository root is free of files that make a builder pick Python', () => {
  // Regression guard for the deploy that built a Flask image and then crashed with
  // "ModuleNotFoundError: No module named 'keep_alive'".
  const strays = listPythonMarkers(ROOT);
  assert.deepEqual(strays, [], `unexpected Python project files: ${strays.join(', ')}`);
  for (const name of ['requirements.txt', 'Pipfile', 'pyproject.toml', 'main.py', 'app.py', 'Keep_alive.pt']) {
    assert.equal(fs.existsSync(path.join(ROOT, name)), false, `${name} must not exist in the repo root`);
  }
});

test('preflight passes for this repository', () => {
  const result = runPreflight();
  assert.equal(result.status, 0, `preflight failed:\n${result.stderr}`);
  assert.match(result.stdout, /Preflight OK/);
});

test('preflight reports problems as JSON and a non-zero exit code', () => {
  const result = runPreflight('--json');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.ok(report.notes.some((note) => /Node v/.test(note)));
  assert.ok(report.notes.some((note) => /SQLite driver/.test(note)));
});

test('python markers are detected in a scratch tree (root vs nested)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'main.py'), 'print(1)\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.py'), '');
  fs.mkdirSync(path.join(dir, 'legacy'));
  fs.writeFileSync(path.join(dir, 'legacy', 'old.py'), '');

  const found = listPythonMarkers(dir, 0, [], dir).sort();
  assert.deepEqual(found, ['nested/main.py', 'requirements.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

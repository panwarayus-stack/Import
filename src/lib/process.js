'use strict';

/**
 * Safe child-process runner.
 *
 * - Never uses a shell: arguments are passed as an array, so generated content can
 *   never be interpreted as a command.
 * - Hard timeout with SIGTERM then SIGKILL.
 * - Output is captured (bounded) for logs and error messages.
 */

const { spawn } = require('node:child_process');

class CommandError extends Error {
  constructor(message, { command, args, code, signal, stdout, stderr, timedOut } = {}) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
    this.args = args;
    this.code = code;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

function runCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 60000,
    maxBuffer = 8 * 1024 * 1024,
    stdin = null,
    allowNonZero = false,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new CommandError(`failed to spawn ${command}: ${error.message}`, { command, args }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 3000).unref?.();
    }, timeoutMs);

    const capture = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < maxBuffer) stdout += text;
      } else if (stderr.length < maxBuffer) stderr += text;
    };

    child.stdout.on('data', (c) => capture(c, 'out'));
    child.stderr.on('data', (c) => capture(c, 'err'));

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`failed to run ${command}: ${error.message}`, { command, args }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { command, args, code, signal, stdout, stderr, timedOut };
      if (timedOut) {
        reject(new CommandError(`${command} timed out after ${timeoutMs}ms`, { ...result }));
        return;
      }
      if (code !== 0 && !allowNonZero) {
        const detail = stderr.trim().split('\n').slice(-6).join('\n') || stdout.trim().slice(-800);
        reject(new CommandError(`${command} exited with code ${code}: ${detail}`, { ...result }));
        return;
      }
      resolve(result);
    });
  });
}

module.exports = { runCommand, CommandError };

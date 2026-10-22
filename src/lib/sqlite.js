'use strict';

/**
 * SQLite driver adapter.
 *
 * Prefers `better-sqlite3` (fast, battle-tested). If the native module is not
 * available (restricted containers, missing build toolchain, unsupported platform)
 * it falls back to Node's built-in `node:sqlite` (Node >= 22.5, experimental), so the
 * application still runs. Both drivers expose the same tiny surface used by
 * `src/database.js`: exec / prepare(...).run|get|all / transaction / pragma / close.
 */

let nativeDriver = null;
let nativeError = null;
try {
  // eslint-disable-next-line global-require
  nativeDriver = require('better-sqlite3');
} catch (error) {
  nativeError = error;
}

const hasNodeSqlite = (() => {
  try {
    // eslint-disable-next-line global-require
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

class NodeSqliteAdapter {
  constructor(filePath) {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    this.driver = 'node:sqlite';
    this.raw = new DatabaseSync(filePath);
    this.statements = new Map();
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  pragma(statement) {
    // node:sqlite has no pragma() helper; PRAGMA statements run fine through exec().
    try {
      this.raw.exec(`PRAGMA ${statement}`);
    } catch {
      /* some pragmas return rows and are not supported by exec in older builds */
    }
    return this;
  }

  prepare(sql) {
    if (this.statements.has(sql)) return this.statements.get(sql);
    const statement = this.raw.prepare(sql);
    const wrapper = {
      run: (...params) => statement.run(...normalizeParams(params)),
      get: (...params) => statement.get(...normalizeParams(params)),
      all: (...params) => statement.all(...normalizeParams(params)),
      raw: statement,
    };
    this.statements.set(sql, wrapper);
    return wrapper;
  }

  transaction(fn) {
    return (...args) => {
      this.raw.exec('BEGIN');
      try {
        const result = fn(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    };
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }

  get open() {
    return true;
  }
}

class BetterSqliteAdapter {
  constructor(filePath) {
    this.driver = 'better-sqlite3';
    this.raw = new nativeDriver(filePath);
    this.statements = new Map();
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  pragma(statement) {
    this.raw.pragma(statement);
    return this;
  }

  prepare(sql) {
    if (this.statements.has(sql)) return this.statements.get(sql);
    const statement = this.raw.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  transaction(fn) {
    return this.raw.transaction(fn);
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }

  get open() {
    return this.raw.open;
  }
}

/** node:sqlite wants named params either bare or prefixed; flatten arrays too. */
function normalizeParams(params) {
  return params.map((param) => {
    if (param === undefined) return null;
    if (param === true) return 1;
    if (param === false) return 0;
    return param;
  });
}

function openSqlite(filePath, { preferNative = true, logger = null } = {}) {
  if (preferNative && nativeDriver) return new BetterSqliteAdapter(filePath);
  if (hasNodeSqlite) {
    if (nativeError && logger) {
      logger.warn(`better-sqlite3 unavailable (${nativeError.message.split('\n')[0]}); using Node's built-in node:sqlite`);
    }
    return new NodeSqliteAdapter(filePath);
  }
  throw new Error(
    `No SQLite driver available. Install better-sqlite3 (\`npm install better-sqlite3\`) or run Node >= 22.5 which ships node:sqlite.`,
  );
}

module.exports = {
  openSqlite,
  NodeSqliteAdapter,
  BetterSqliteAdapter,
  driverInfo: () => ({ betterSqlite3: Boolean(nativeDriver), nodeSqlite: hasNodeSqlite, nativeError: nativeError?.message || null }),
};

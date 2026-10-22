'use strict';

/**
 * Minimal static file server used to (a) test generated sites locally and
 * (b) serve `local` deployments through the dashboard.
 *
 * Hardened: path traversal protection, no directory listing, no symlink following,
 * explicit content types, security headers, and a CSP that matches our generated
 * sites (self only, no inline scripts except the app.js file we ship).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (decoded.includes('\0')) return null;
  // Reject traversal outright rather than silently normalising it into the root.
  if (decoded.split(/[\\/]+/).some((segment) => segment === '..')) return null;
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.(\/|$))+/, '');
  const target = path.join(root, normalized);
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

function createStaticServer(rootDir, { csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } = {}) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) throw new Error(`static root does not exist: ${root}`);

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    let filePath = safeJoin(root, req.url || '/');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    try {
      let stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const indexPath = path.join(filePath, 'index.html');
        if (!fs.existsSync(indexPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        filePath = indexPath;
        stat = fs.statSync(filePath);
      }
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const real = fs.realpathSync(filePath);
      if (!real.startsWith(fs.realpathSync(root))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': csp,
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  return server;
}

function startStaticServer(rootDir, { port = 0, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = createStaticServer(rootDir);
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`;
      resolve({
        server,
        port: address.port,
        url,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { createStaticServer, startStaticServer, MIME, safeJoin };

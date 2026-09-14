/**
 * Tiny static file server for the demo application.
 *
 * Node built-ins only, so the sample framework needs no extra dependency. Playwright
 * starts and stops it via `webServer` in playwright.config.ts.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

http
  .createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');

    // Refuse anything that would escape the app directory.
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(target, (error, body) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream' });
      response.end(body);
    });
  })
  .listen(PORT, () => {
    console.log(`demo app listening on http://127.0.0.1:${PORT}`);
  });

/**
 * A static file server with no dependencies.
 *
 * The portal is plain HTML on purpose right now, and it still cannot be opened
 * with file:// — the API is a credentialed CORS endpoint, and a file:// page has
 * the opaque "null" origin, which CORS can never allow. So it needs an origin,
 * and this is the smallest thing that provides one.
 *
 * The port matters: it must appear in the API's CORS_ORIGINS.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;

  // Resolve, then confirm the result is still inside ROOT: without this check a
  // path of ../../etc/passwd would be served happily.
  const filePath = path.join(ROOT, path.normalize(requested));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      // A dev server: never let a stale page hide a change that was just made.
      'Cache-Control': 'no-store',
    });
    response.end(contents);
  });
});

// The commonest failure here is a previous run still holding the port. Left
// unhandled it becomes an 'error' event and fifteen lines of Node internals.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — something else is listening on it.\n` +
        `Find it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
        `Or use another port with:  PORT=5174 node server.js\n` +
        `(if you change it, add that origin to the API's CORS_ORIGINS too)\n`,
    );
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Wouchh portal on http://localhost:${PORT}`);
});

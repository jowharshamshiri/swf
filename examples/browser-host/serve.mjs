import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

/**
 * Serves the repository's root over HTTP on the loopback address, for the browser host example:
 * `node examples/browser-host/serve.mjs [port]` (default 8317), then open
 * http://127.0.0.1:<port>/examples/browser-host/. Only files under the root are served.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
/** @type {Readonly<Record<string, string>>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/**
 * Starts the server on `port` (0 for any free one).
 *
 * @param {number} [port]
 * @returns {Promise<{ url: string, close: () => Promise<unknown> }>} its address, and what stops it
 */
export function serve(port = 8317) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    void stat(file)
      .then(async (found) => {
        if (found.isDirectory()) {
          file = path.join(file, 'index.html');
          await stat(file);
        }
        response.writeHead(200, {
          'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(response);
      })
      .catch(() => {
        response.writeHead(404).end();
      });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : port)}`,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}

if (import.meta.main) {
  const { url } = await serve(Number(process.argv[2] ?? 8317));
  process.stdout.write(`Serving the repository at ${url}/examples/browser-host/\n`);
}

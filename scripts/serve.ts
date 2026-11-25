/** Serve dist/ statically under a sub-path (default /p/orderbook-replay/) to mirror production. */
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

export function serve(root: string, base = '/p/orderbook-replay/', port = 4173): Promise<Server> {
  const srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (!url.pathname.startsWith(base)) {
        res.writeHead(404).end();
        return;
      }
      let rel = normalize(decodeURIComponent(url.pathname.slice(base.length)));
      if (rel.startsWith('..')) {
        res.writeHead(400).end();
        return;
      }
      if (rel === '' || rel === '.' || rel.endsWith('/')) rel = join(rel, 'index.html');
      const file = join(root, rel);
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    })();
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await serve('dist');
  const a = s.address();
  console.log(`serving dist/ at http://127.0.0.1:${typeof a === 'object' && a ? a.port : '?'}/p/orderbook-replay/`);
}

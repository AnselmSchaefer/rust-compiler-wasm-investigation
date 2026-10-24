// Static dev server with the cross-origin isolation headers needed for SharedArrayBuffer (Wasm threads).
// Serves <file>.br with Content-Encoding: br when it exists.
// Usage: node scripts/serve.mjs <root> [/prefix=dir ...]   (extra mounts, e.g. /vendor=build/vendor)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const mounts = process.argv.slice(3).map(m => {
  const [prefix, dir] = m.split('=');
  return [prefix.replace(/\/$/, '') + '/', resolve(dir)];
});
const port = Number(process.env.PORT ?? 8787);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const [prefix, base] = mounts.find(([p]) => path.startsWith(p)) ?? ['/', root];
  let file = join(base, path.slice(prefix.length - 1));
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file).catch(() => null);
    if (st?.isDirectory()) file = join(file, 'index.html');
    // Serve a precompressed sibling (file.br) like a CDN would, so transfer sizes are realistic.
    // A release (toolchain/release.sh) has only the .br files: then file.br is the only copy.
    const accepts = /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
    const br = accepts && await stat(file + '.br').then(() => true, () => false);
    if (!st && !br) throw new Error('not found');
    const body = await readFile(br ? file + '.br' : file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      ...(br ? { 'Content-Encoding': 'br' } : {}),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));

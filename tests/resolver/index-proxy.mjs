// Sparse-index proxy for the resolver's golden tests (WP-15). It pins the crates.io index:
//   node tests/resolver/index-proxy.mjs record <snapshot-dir> [port]   fetch from index.crates.io, store, serve
//   node tests/resolver/index-proxy.mjs replay <snapshot-dir> [port]   serve only what was stored (offline)
// Native cargo uses it through a source replacement (see make-golden.sh), and our resolver reads
// the same snapshot directory, so both see exactly the same index.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const [mode, dir, port = '8799'] = process.argv.slice(2);
if (!['record', 'replay'].includes(mode) || !dir) throw new Error('usage: index-proxy.mjs record|replay <dir> [port]');
const UPSTREAM = 'https://index.crates.io';

createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname);
  if (path.includes('..')) return res.writeHead(400).end();
  if (path === '/config.json') {
    // Downloads go to crates.io itself; lockfile generation never downloads.
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ dl: 'https://static.crates.io/crates', api: 'https://crates.io' }));
  }
  const file = join(dir, path.toLowerCase());
  const stored = await readFile(file).catch(() => null);
  if (stored) return res.writeHead(200).end(stored);
  if (mode === 'replay') return res.writeHead(404).end();
  const up = await fetch(UPSTREAM + path);
  if (up.status === 404) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.404', '');
    return res.writeHead(404).end();
  }
  if (!up.ok) return res.writeHead(502).end(`upstream ${up.status}`);
  const body = Buffer.from(await up.arrayBuffer());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  res.writeHead(200).end(body);
}).listen(Number(port), () => console.log(`index proxy (${mode}) on http://localhost:${port}/ → ${dir}`));

// Package rustup's 1.99.1 std for a user target as a static sysroot asset (WP-08):
//   node toolchain/package-sysroot.mjs <out-dir> [target=wasm32-wasip1]
// <out-dir>/lib/rustlib/<target>/lib/** holds each file (hard-linked) and a brotli copy (.br, what a
// CDN serves); <out-dir>/manifest.json lists them with sizes and sha256. Files are grouped: "meta"
// (.rmeta: all that type checking and codegen read) and "link" (.rlib object code, crt1, libc: only
// the linker reads these), so a host can fetch the link group the first time it links.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const [out, target = 'wasm32-wasip1'] = process.argv.slice(2);
if (!out) throw new Error('usage: package-sysroot.mjs <out-dir> [target]');
const VERSION = '1.99.1';
const sysroot = execFileSync('rustc', [`+${VERSION}`, '--print', 'sysroot'], { encoding: 'utf8' }).trim();
const src = join(sysroot, 'lib/rustlib', target, 'lib');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const br = promisify(brotliCompress);

rmSync(join(out, 'lib'), { recursive: true, force: true });
const files = await Promise.all(walk(src).sort().map(async (f) => {
  const path = join('lib/rustlib', target, 'lib', relative(src, f));
  const dst = join(out, path);
  mkdirSync(dirname(dst), { recursive: true });
  linkSync(f, dst);
  const data = readFileSync(f);
  // Quality 9: within ~2% of 11 on these files, and much faster.
  const z = await br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  writeFileSync(dst + '.br', z);
  return {
    path, group: f.endsWith('.rmeta') ? 'meta' : 'link',
    size: data.length, brSize: z.length, sha256: createHash('sha256').update(data).digest('hex'),
  };
}));
const sum = (g, k) => files.filter((f) => !g || f.group === g).reduce((a, f) => a + f[k], 0);
const manifest = {
  rustc: VERSION, target, files,
  totals: Object.fromEntries(['meta', 'link'].map((g) => [g, { files: files.filter((f) => f.group === g).length, size: sum(g, 'size'), brSize: sum(g, 'brSize') }])),
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
const mib = (b) => (b / 2 ** 20).toFixed(1);
for (const [g, t] of Object.entries(manifest.totals)) console.log(`${g}: ${t.files} files, ${mib(t.size)} MiB, brotli ${mib(t.brSize)} MiB`);

// Bundle browser test pages into build/www/<name>/ (WP-11 VFS test; more pages as WPs add them).
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const pages = {
  'vfs-test': { src: 'tests/e2e/vfs', entries: { main: 'main', worker: 'worker' }, assets: { 'vfs.wasm': 'build/www/vfs/vfs.wasm' } },
  'wasi-rustc': {
    src: 'tests/e2e/wasi-rustc', entries: { main: 'main', 'process-worker': '../../../web/wasi/process-worker' }, assets: { 'vfs.wasm': 'build/www/vfs/vfs.wasm' },
  },
  // WP-12/13: the toolchain comes from a release (toolchain/release.sh), served at /release/.
  orchestrator: {
    src: 'tests/e2e/orchestrator',
    entries: { main: 'main', 'orchestrator-worker': '../../../web/orchestrator/orchestrator-worker', 'process-worker': '../../../web/wasi/process-worker', 'sandbox-worker': '../../../web/sandbox/sandbox-worker' },
    assets: { 'vfs.wasm': 'build/www/vfs/vfs.wasm' },
  },
  // WP-07; the big assets come from scripts/prep-rustc-host-page.sh.
  'rustc-host': {
    src: 'tests/e2e/rustc-host', entries: { main: 'main', 'process-worker': '../../../web/wasi/process-worker' }, assets: { 'vfs.wasm': 'build/www/vfs/vfs.wasm' },
  },
};

for (const [name, { src, entries, assets }] of Object.entries(pages)) {
  const out = `build/www/${name}`;
  await mkdir(out, { recursive: true });
  await build({
    // Output name → source (relative to the page dir), so outputs land flat in `out`.
    entryPoints: Object.fromEntries(Object.entries(entries).map(([o, i]) => [o, `${src}/${i}.ts`])),
    outdir: out, bundle: true, format: 'esm', target: 'es2024', sourcemap: true, logLevel: 'warning',
  });
  await copyFile(`${src}/index.html`, `${out}/index.html`);
  for (const [to, from] of Object.entries(assets)) await copyFile(from, `${out}/${to}`);
  console.log(`built ${out}`);
}

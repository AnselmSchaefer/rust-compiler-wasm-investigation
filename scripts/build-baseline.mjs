// Bundle the WP-01 baseline harness (tests/e2e/baseline) into build/www/baseline.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const src = 'tests/e2e/baseline', out = 'build/www/baseline';
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['main', 'rustc-worker', 'thread-spawn'].map(n => `${src}/${n}.ts`),
  outdir: out, bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'warning',
});
await copyFile(`${src}/index.html`, `${out}/index.html`);
console.log(`built ${out}`);

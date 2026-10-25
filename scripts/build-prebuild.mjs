// Bundle tools/prebuild (WP-18) for Node: build/prebuild/prebuild.mjs.
import { build } from 'esbuild';

await build({
  entryPoints: ['tools/prebuild/main.ts'], outfile: 'build/prebuild/prebuild.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, logLevel: 'warning',
  loader: { '.rs': 'text' },
});
console.log('built build/prebuild/prebuild.mjs');

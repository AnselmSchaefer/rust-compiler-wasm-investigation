// Bundle the IDE (app/, WP-14) into build/www/app/: the page and the agent page (WP-38), the three workers (orchestrator,
// WASI process threads, run sandbox), CSS and vfs.wasm. The toolchain is the newest release in
// build/release/ (toolchain/release.sh), served at /release/ (`pnpm demo`, or Playwright's server).
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';

const out = 'build/www/app';
const releases = await readdir('build/release').catch(() => []);
const dated = await Promise.all(releases.map(async r => [(await stat(`build/release/${r}`)).mtimeMs, r]));
const release = dated.sort((a, b) => b[0] - a[0])[0]?.[1];
if (!release) throw new Error('no release in build/release (run toolchain/release.sh)');

await mkdir(out, { recursive: true });
await build({
  entryPoints: {
    main: 'app/main.ts',
    // WP-38: the page an agent drives through tools/relay (agent.html).
    agent: 'app/agent.ts',
    'orchestrator-worker': 'web/orchestrator/orchestrator-worker.ts',
    'process-worker': 'web/wasi/process-worker.ts',
    'sandbox-worker': 'web/sandbox/sandbox-worker.ts',
  },
  outdir: out, bundle: true, format: 'esm', target: 'es2024', minify: true, sourcemap: true, logLevel: 'warning',
  loader: { '.rs': 'text' },
  define: { __RELEASE__: JSON.stringify(release) },
});
await build({ entryPoints: { main: 'app/style.css', agent: 'app/agent.css' }, outdir: out, bundle: true, minify: true, logLevel: 'warning' });
await copyFile('app/index.html', `${out}/index.html`);
await copyFile('app/agent.html', `${out}/agent.html`);
await copyFile('build/www/vfs/vfs.wasm', `${out}/vfs.wasm`);
// The agent page resolves and plans builds (resolver.wasm, scripts/build-resolver.sh).
await copyFile('build/www/resolver/resolver.wasm', `${out}/resolver.wasm`);
console.log(`built ${out} (release ${release})`);

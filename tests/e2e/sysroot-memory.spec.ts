import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// WP-08: the packaged rustup 1.99.1 wasm32-wasip1 sysroot (toolchain/package-sysroot.mjs) on our rustc
// host in Chromium. Type checking and codegen work with only the "meta" group loaded; peak Wasm
// memory per step is recorded in bench/results/<date>-<commit>-sysroot-memory.json.
// Assets: scripts/prep-rustc-host-page.sh and scripts/build-web-tests.mjs (scripts/verify/wp-08.sh).
const LIMIT_MIB = 300; // PLAN WP-08: compiling hello peaks below 300 MB

test('packaged sysroot, peak memory', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/rustc-host/index.html');
  await page.waitForFunction(() => (window as any).rustcHostReady);
  const programs = { hello: readFileSync('tests/smoke/hello.rs', 'utf8'), medium: readFileSync('bench/programs/medium.rs', 'utf8') };
  const r = await page.evaluate(async programs => {
    const h = (window as any).rustcHost;
    const load = await h.load(['rustc.wasm'], ['meta']);
    const vfsAfterMeta = h.vfsBytes();
    h.writeFile('/work/hello.rs', programs.hello);
    h.writeFile('/work/medium.rs', programs.medium);
    const c = ['--target', 'wasm32-wasip1', '--edition', '2021'];
    const steps: Record<string, string[]> = {
      'check-hello': ['/work/hello.rs', ...c, '--emit=metadata', '-o', '/work/h.rmeta'],
      'obj-hello': ['/work/hello.rs', ...c, '--emit=obj', '-o', '/work/h.o'],
      'check-medium': ['/work/medium.rs', ...c, '--crate-type', 'lib', '--emit=metadata', '-o', '/work/m.rmeta'],
      'obj-medium': ['/work/medium.rs', ...c, '--emit=obj', '-o', '/work/m.o'],
      'obj-medium-O': ['/work/medium.rs', ...c, '-O', '--emit=obj', '-o', '/work/mO.o'],
    };
    const out: Record<string, any> = {};
    for (const [k, a] of Object.entries(steps)) {
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const x = await h.rustc('rustc.wasm', a);
        if (x.code !== 0) return { error: k, stderr: x.stderr.slice(-2000) };
        runs.push({ ms: Math.round(x.ms), peakMiB: Math.round(x.memBytes / 2 ** 20) });
      }
      out[k] = { ms: runs.map(r => r.ms), peakMiB: Math.max(...runs.map(r => r.peakMiB)) };
    }
    const link = await h.loadSysroot('link');
    return { load, link, vfsMiB: { afterMeta: Math.round(vfsAfterMeta / 2 ** 20), afterLink: Math.round(h.vfsBytes() / 2 ** 20) }, steps: out };
  }, programs);
  console.log(JSON.stringify(r, null, 1));
  expect((r as any).error, (r as any).stderr).toBeUndefined();
  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${date}-${commit}-sysroot-memory.json`, JSON.stringify({ date, commit, browser: 'chromium', rustc: '1.99.1 wasm32-wasip1-threads host, panic=unwind', ...r }, null, 1) + '\n');
  expect(r.steps['check-hello'].peakMiB).toBeLessThan(LIMIT_MIB);
  expect(r.steps['obj-hello'].peakMiB).toBeLessThan(LIMIT_MIB);
});

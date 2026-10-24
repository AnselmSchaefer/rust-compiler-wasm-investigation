import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// WP-07: our panic=unwind rustc host in Chromium. A compile error exits with code 1 instead of
// trapping, and in one instance (rustc-multi) an ICE and a failed compile are followed by successful ones.
// Assets: scripts/prep-rustc-host-page.sh and scripts/build-web-tests.mjs (scripts/verify/wp-07.sh).
test('unwind rustc host: errors return, instance stays usable', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/rustc-host/index.html');
  await page.waitForFunction(() => (window as any).rustcHostReady);
  const hello = readFileSync('tests/smoke/hello.rs', 'utf8');
  const r = await page.evaluate(async hello => {
    const h = (window as any).rustcHost;
    const load = await h.load(['rustc.wasm', 'rustc-multi.wasm']);
    h.writeFile('/work/hello.rs', hello);
    h.writeFile('/work/bad.rs', 'fn main() { let x: u32 = "no"; }\n');
    const c = ['--target', 'wasm32-wasip1', '--edition', '2021'];
    const version = await h.rustc('rustc.wasm', ['-V']);
    const bad = await h.rustc('rustc.wasm', ['/work/bad.rs', ...c, '--emit=metadata', '-o', '/work/bad.rmeta']);
    // -Ztreat-err-as-bug turns the type error into an ICE (needs RUSTC_BOOTSTRAP). RUSTC_ICE=0: no
    // ICE file, whose name needs std::process::id(), which panics on WASI.
    const multi = await h.rustc('rustc-multi.wasm', [
      '/work/bad.rs', ...c, '--emit=metadata', '-o', '/work/bad.rmeta', '-Ztreat-err-as-bug=1', '--next',
      '/work/bad.rs', ...c, '--emit=metadata', '-o', '/work/bad.rmeta', '--next',
      '/work/hello.rs', ...c, '--emit=metadata', '-o', '/work/hello.rmeta', '--next',
      '/work/hello.rs', ...c, '--emit=obj', '-o', '/work/hello.o',
    ], ['RUSTC_BOOTSTRAP=1', 'RUSTC_ICE=0', 'RUST_BACKTRACE=0']);
    const pick = (x: any) => ({ code: x.code, error: x.error, ms: Math.round(x.ms), stdout: x.stdout, stderr: x.stderr.slice(-1500) });
    return { load, version: pick(version), bad: pick(bad), multi: pick(multi), work: h.ls('/work') };
  }, hello);
  console.log(JSON.stringify(r, null, 1));
  expect(r.version.stdout).toContain('rustc 1.99.1');
  expect(r.bad.stderr).toContain('mismatched types');
  expect(r.bad.code).toBe(1); // the abort build trapped here (WP-01 finding #1)
  expect(r.multi.stderr.match(/rustc-multi: exit \d+/g)).toEqual(['rustc-multi: exit 101', 'rustc-multi: exit 1', 'rustc-multi: exit 0', 'rustc-multi: exit 0']);
  expect(r.multi.stderr).toContain('the compiler unexpectedly panicked');
  expect(r.multi.code).toBe(0);
  expect(r.work).toEqual(expect.arrayContaining(['hello.rmeta', 'hello.o']));
  expect(r.work).not.toContain('bad.rmeta');
});

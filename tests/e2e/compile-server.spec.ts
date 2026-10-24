import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// WP-09: rustc-multi --server in Chromium. 10 sequential requests (checks, an error, codegen) in one
// instance, all with correct results; warm check-hello at least 2.5x faster than cold (a new instance
// per compile, as without the server; the module is already compiled and warmed up, so this is
// instance start + rustc start-up, not JIT). PLAN's 3x was re-scoped to 2.5x by the user (2026-10-24):
// the rest is rustc reloading std's metadata per session, which needs a rustc change to cache.
// Numbers: bench/results/<date>-<commit>-compile-server.json.
// Assets: scripts/prep-rustc-host-page.sh, scripts/build-web-tests.mjs (scripts/verify/wp-09.sh).
test('compile server: warm vs cold', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/rustc-host/index.html');
  await page.waitForFunction(() => (window as any).rustcHostReady);
  const programs = { hello: readFileSync('tests/smoke/hello.rs', 'utf8'), medium: readFileSync('bench/programs/medium.rs', 'utf8') };
  const r = await page.evaluate(async programs => {
    const h = (window as any).rustcHost;
    await h.load(['rustc-multi.wasm'], ['meta']);
    h.writeFile('/work/hello.rs', programs.hello);
    h.writeFile('/work/medium.rs', programs.medium);
    h.writeFile('/work/bad.rs', 'fn main() { let x: u32 = "no"; }\n');
    const c = ['--target', 'wasm32-wasip1', '--edition', '2021'];
    const check = ['/work/hello.rs', ...c, '--emit=metadata', '-o', '/work/h.rmeta'];
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

    // Cold: one instance per compile (the warm-up run lets the JIT tier up first).
    await h.rustc('rustc-multi.wasm', check);
    const cold: number[] = [];
    for (let i = 0; i < 5; i++) {
      const x = await h.rustc('rustc-multi.wasm', check);
      if (x.code !== 0) return { error: 'cold', stderr: x.stderr };
      cold.push(Math.round(x.ms));
    }

    const srv = h.startServer('rustc-multi.wasm');
    const requests: [string, string[], number][] = [
      ['check-hello', check, 0],
      ['check-hello', check, 0],
      ['bad', ['/work/bad.rs', ...c, '--emit=metadata', '-o', '/work/bad.rmeta'], 1],
      ['check-hello', check, 0],
      ['check-medium', ['/work/medium.rs', ...c, '--crate-type', 'lib', '--emit=metadata', '-o', '/work/m.rmeta'], 0],
      ['obj-hello', ['/work/hello.rs', ...c, '--emit=obj', '-o', '/work/h.o'], 0],
      ['check-hello', check, 0],
      ['check-hello', check, 0],
      ['version', ['-V'], 0],
      ['check-hello', check, 0],
    ];
    const answers = [];
    for (const [name, args, want] of requests) {
      const a = await srv.request(args);
      answers.push({ name, want, exit: a.exit, ms: a.ms, hostMs: a.hostMs, memMiB: Math.round(a.memBytes / 2 ** 20), stderr: a.stderr.slice(0, 300) });
    }
    const end = await srv.quit();
    const warm = answers.filter((a, i) => a.name === 'check-hello' && i > 1).map(a => a.hostMs);
    return { cold, coldMedian: median(cold), warm, warmMedian: median(warm), answers, quitCode: end.code, peakMiB: Math.round(end.memBytes / 2 ** 20), work: h.ls('/work') };
  }, programs);
  console.log(JSON.stringify(r, null, 1));
  expect((r as any).error, (r as any).stderr).toBeUndefined();
  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${date}-${commit}-compile-server.json`, JSON.stringify({ date, commit, browser: 'chromium', ...r }, null, 1) + '\n');
  expect(r.answers).toHaveLength(10);
  for (const a of r.answers) expect(a.exit, a.name).toBe(a.want);
  expect(r.answers.find(a => a.name === 'bad')!.stderr).toContain('mismatched types');
  expect(r.quitCode).toBe(0);
  expect(r.work).toEqual(expect.arrayContaining(['h.rmeta', 'm.rmeta', 'h.o']));
  expect(r.warmMedian * 2.5).toBeLessThanOrEqual(r.coldMedian);
});

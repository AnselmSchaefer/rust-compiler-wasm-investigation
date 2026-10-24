import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-12: hello (and medium) compiled *and linked* through the orchestrator worker, with only our
// toolchain release (toolchain/release.sh, served at /release/): the compile server for rustc,
// wasm-ld.wasm for linking, the release's sysroot. Then a reload loads the toolchain from Cache
// Storage. Numbers: bench/results/<date>-<commit>-orchestrator.json. scripts/verify/wp-12.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];

test('orchestrator: compile, link and run with our toolchain', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  const programs = { hello: readFileSync('tests/smoke/hello.rs', 'utf8'), medium: readFileSync('bench/programs/medium.rs', 'utf8') };
  const session = async () => {
    await page.goto('/www/orchestrator/index.html');
    await page.waitForFunction(() => (window as any).orchReady);
    return page.evaluate(async ({ programs, release }) => {
      const o = (window as any).orch;
      const init = await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: new URL('vfs.wasm', location.href).href, workerUrl: new URL('process-worker.js', location.href).href });
      await o.call('writeFile', { path: '/work/hello.rs', data: programs.hello });
      await o.call('writeFile', { path: '/work/medium.rs', data: programs.medium });
      await o.call('writeFile', { path: '/work/bad.rs', data: 'fn main() { let x: u32 = "no"; }\n' });
      const c = ['--target', 'wasm32-wasip1', '--edition', '2021'];
      const pick = (r: any) => ({ code: r.code, linked: r.linked, outputs: r.outputs, ms: r.ms, stderr: r.stderr.slice(0, 400) });
      const t0 = performance.now();
      const buildHello = pick(await o.call('rustc', { args: ['/work/hello.rs', ...c, '-o', '/work/hello.wasm'] }));
      const firstBuildMs = Math.round(performance.now() - t0);
      if (buildHello.code !== 0 || !buildHello.outputs.length) return { failed: { ...buildHello, stderr: (await o.call('rustc', { args: ['/work/hello.rs', ...c, '-o', '/work/hello.wasm'] })).stderr } };
      const runHello = await o.call('run', { path: '/work/hello.wasm' });
      const rebuild = pick(await o.call('rustc', { args: ['/work/hello.rs', ...c, '-o', '/work/hello.wasm'] }));
      const check = pick(await o.call('rustc', { args: ['/work/hello.rs', ...c, '--emit=metadata', '-o', '/work/hello.rmeta'] }));
      const bad = pick(await o.call('rustc', { args: ['/work/bad.rs', ...c, '-o', '/work/bad.wasm'] }));
      const buildMedium = pick(await o.call('rustc', { args: ['/work/medium.rs', ...c, '-o', '/work/medium.wasm'] }));
      const runMedium = await o.call('run', { path: '/work/medium.wasm' });
      return {
        init, firstBuildMs, buildHello, runHello, rebuild, check, bad, buildMedium, runMedium: { code: runMedium.code, ok: runMedium.stdout.endsWith('medium ok\n') },
        work: await o.call('ls', { path: '/work' }), tmp: await o.call('ls', { path: '/tmp' }), close: await o.call('close', {}),
      };
    }, { programs, release });
  };
  const first: any = await session();
  expect(first.failed, JSON.stringify(first.failed, null, 1)).toBeUndefined();
  const second: any = await session(); // reload: the toolchain now comes from Cache Storage
  console.log(JSON.stringify({ first, secondInit: second.init }, null, 1));

  expect(first.init.rustcId).toBe(release);
  expect(first.buildHello).toMatchObject({ code: 0, linked: true, outputs: ['/work/hello.wasm'] });
  expect(first.runHello.code).toBe(0);
  expect(first.runHello.stdout).toContain('Hello from Wasm');
  expect(first.rebuild).toMatchObject({ code: 0, linked: true });
  expect(first.check).toMatchObject({ code: 0, linked: false, outputs: ['/work/hello.rmeta'] });
  expect(first.bad.code).toBe(1);
  expect(first.bad.stderr).toContain('mismatched types');
  expect(first.bad.linked).toBe(false);
  expect(first.buildMedium).toMatchObject({ code: 0, linked: true });
  expect(first.runMedium).toEqual({ code: 0, ok: true });
  expect(first.work.sort()).toEqual(['bad.rs', 'hello.rmeta', 'hello.rs', 'hello.wasm', 'medium.rs', 'medium.wasm']);
  expect(first.tmp).toEqual([]); // no scratch dirs, objects or temp dirs left behind
  expect(first.close.code).toBe(0);
  expect(first.init.loads.every((l: any) => !l.fromCache)).toBe(true);
  expect(second.init.loads.length).toBeGreaterThan(0);
  expect(second.init.loads.every((l: any) => l.fromCache)).toBe(true);
  expect(second.runHello.stdout).toContain('Hello from Wasm');

  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('bench/results', { recursive: true });
  const strip = (s: any) => ({ init: s.init, firstBuildMs: s.firstBuildMs, buildHello: s.buildHello.ms, rebuild: s.rebuild.ms, check: s.check.ms, buildMedium: s.buildMedium.ms, runHello: s.runHello.ms });
  writeFileSync(`bench/results/${date}-${commit}-orchestrator.json`, JSON.stringify({ date, commit, browser: 'chromium', release, first: strip(first), second: strip(second) }, null, 1) + '\n');
});

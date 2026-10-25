import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-20: proc macros inside rustc.wasm. `cargo build` of tests/planner/cases/derive in Chromium:
// serde with `derive` and thiserror. serde_derive and thiserror-impl are compiled by rustc.wasm
// as wasm32-wasip1 proc-macro modules; when rustc.wasm expands #[derive(..)], rustc-multi's loader
// (toolchain/rustc-multi/pm.rs) hands each expansion to web/wasi/proc-macro.ts, which runs the
// module in the same worker. The program must print what the native build prints. Then, in a
// fresh page with main.rs edited, the macro modules come from the build cache (L1) and still load.
// Numbers: bench/results/<date>-<commit>-proc-macro-browser.json. scripts/verify/wp-20.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const CASE = 'tests/planner/cases/derive';
const expected = '{"xPos":1,"yPos":2}\nPoint { x_pos: 3, y_pos: 4, label: Some("z") }\nbad point Point { x_pos: -1, y_pos: 0, label: None }\njson: EOF while parsing an object at line 1 column 1\n';

test('proc macros: serde derive and thiserror build and run in the browser', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  // `clearL1`: start from an empty build cache. The build keeps its units in L1 (WP-18).
  const session = (main: string, clearL1: boolean) => page.evaluate(async ({ release, manifest, main, clearL1 }) => {
    if (clearL1) { try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ } }
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4 });
    await o.call('writeFile', { path: '/derive/Cargo.toml', data: manifest });
    await o.call('writeFile', { path: '/derive/src/main.rs', data: main });
    const build = await o.call('build', { project: '/derive', resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href });
    const run = build.ok ? await o.call('run', { path: build.bins.derive }) : null;
    await o.call('close', {});
    return { build, run };
  }, { release, manifest: readFileSync(`${CASE}/Cargo.toml`, 'utf8'), main, clearL1 });
  const main = readFileSync(`${CASE}/src/main.rs`, 'utf8');
  const r = await session(main, true);
  if (!r.build.ok) console.log(r.build.errors);
  expect(r.build.ok).toBe(true);
  const pm = r.build.units.filter((u: any) => u.name === 'serde_derive' || u.name === 'thiserror-impl');
  console.log(`[proc-macro] ${JSON.stringify({ units: r.build.units.length, ms: r.build.ms, procMacros: pm.map((u: any) => `${u.name} ${u.end - u.start} ms`), slowest: [...r.build.units].sort((a: any, b: any) => (b.end - b.start) - (a.end - a.start)).slice(0, 4).map((u: any) => `${u.name} ${u.kind} ${u.end - u.start} ms`) })}`);
  expect(r.run.stdout).toBe(expected);

  // A fresh page, main.rs edited: the macro modules come back from L1 (proc-macro units are
  // ordinary units) and still load; only the bin is built.
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const e = await session(main.replace('fn main() {', 'fn main() {\n    println!("edited");'), false);
  if (!e.build.ok) console.log(e.build.errors);
  expect(e.build.ok).toBe(true);
  expect(e.build.units.filter((u: any) => u.cached === undefined).map((u: any) => u.kind)).toEqual(['bin']);
  expect(e.build.units.filter((u: any) => ['serde_derive', 'thiserror-impl'].includes(u.name)).map((u: any) => u.cached)).toEqual(['l1', 'l1']);
  expect(e.run.stdout).toBe(`edited\n${expected}`);
  console.log(`[proc-macro-edit] ${JSON.stringify({ ms: e.build.ms, built: 1, l1: e.build.units.filter((u: any) => u.cached === 'l1').length })}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-proc-macro-browser.json`, JSON.stringify({ release, units: r.build.units, ms: r.build.ms, run: r.run }, null, 2));
});

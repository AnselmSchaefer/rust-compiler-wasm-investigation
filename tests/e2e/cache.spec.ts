import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-18: the build cache. Three projects (serde_json, mix, more: 30 registry crates) are built in
// Chromium with an empty L1 (OPFS); every unit's key and output hashes are written to
// bench/results/<date>-<commit>-cache.json, which scripts/verify/wp-18.sh compares with
// tools/prebuild's wasmtime build. Then: after a reload, a second build is all L1 hits; edit → run
// is timed (in the same session, and after a reload); with an empty L1, the prebuilt L2
// (/l2/<RUSTC_ID>/) and main.rs edited, every unit but the bin comes from L2.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const WORKERS = Number(process.env.BUILD_WORKERS ?? 4);
const names = ['serde_json', 'mix', 'more'];
const cases = names.map(name => ({
  name,
  manifest: readFileSync(`tests/planner/cases/${name}/Cargo.toml`, 'utf8'),
  main: readFileSync(`tests/planner/cases/${name}/src/main.rs`, 'utf8'),
}));
const expected: Record<string, RegExp> = {
  serde_json: /^\{"n":\[1,2\.5,-3\],"name":"demo","ok":true\}\nroundtrip ok, n\[1\] = 2\.5\n$/,
  mix: /^user=ferris host=rust\n\{"user":"ferris"\}\ndice ok\n$/,
  more: /^1,4,9,16,25\n\["b", "a"\]\nZmVycmlz\n01ab\ntrue\naf63f54c86021707\n\[52\] 42 hihi\n$/,
};

type Case = typeof cases[number];
interface Step { name: string; build: any; run: any; ms: number }

/** In the page: init the orchestrator, then build and run each case (`main` replaces main.rs). */
async function session(page: Page, cs: (Case & { main?: string })[], opts: { clearL1?: boolean; l2?: string } = {}): Promise<Step[]> {
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  return page.evaluate(async ({ cs, release, workers, clearL1, l2 }) => {
    if (clearL1) { try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ } }
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers });
    const out: Step[] = [];
    for (const c of cs) {
      const project = `/${c.name}`;
      const t0 = performance.now();
      await o.call('writeFile', { path: `${project}/Cargo.toml`, data: c.manifest });
      await o.call('writeFile', { path: `${project}/src/main.rs`, data: c.main });
      const build = await o.call('build', { project, resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href, cache: { l2 } });
      const bin = Object.values(build.bins)[0] as string | undefined;
      const run = bin ? await o.call('run', { path: bin }) : null;
      out.push({ name: c.name, build, run, ms: Math.round(performance.now() - t0) });
    }
    await o.call('close', {});
    return out;
  }, { cs, release, workers: WORKERS, clearL1: opts.clearL1, l2: opts.l2 });
}

const count = (b: any, k: string | undefined) => b.units.filter((u: any) => u.cached === k).length;
const summary = (s: Step) => ({
  units: s.build.units.length, skipped: s.build.skipped, built: count(s.build, undefined), l1: count(s.build, 'l1'), l2: count(s.build, 'l2'),
  fresh: count(s.build, 'fresh'), ms: { ...s.build.ms, buildAndRun: s.ms }, cache: s.build.cache,
});
function check(s: Step, expect_: RegExp) {
  if (!s.build.ok) console.log(`[${s.name}] build failed:\n${s.build.errors}`);
  expect(s.build.ok, `${s.name} builds`).toBe(true);
  expect(s.run.code, `${s.name} runs`).toBe(0);
  expect(s.run.stdout).toMatch(expect_);
}

test('build cache: cold, second build, edit → run, L2', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(1_200_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  const result: any = { release, workers: WORKERS, steps: {} };

  // 1. Cold: empty L1, no L2. Every unit is built in the browser (or shared with an earlier case).
  const cold = await session(page, cases, { clearL1: true });
  result.units = {};
  for (const s of cold) {
    check(s, expected[s.name]);
    result.steps[`cold/${s.name}`] = summary(s);
    result.units[s.name] = s.build.units.map((u: any) => ({ name: u.name, version: u.version, kind: u.kind, key: u.key, cached: u.cached, files: u.files }));
  }

  // 2. Reload, build again: everything comes from L1 (only what the bins need is restored).
  const second = await session(page, cases);
  for (const s of second) {
    check(s, expected[s.name]);
    result.steps[`second/${s.name}`] = summary(s);
    expect(s.build.units.every((u: any) => u.cached === 'l1'), `${s.name}: second build all L1 hits`).toBe(true);
  }

  // 3. Edit → run after a reload (the dependencies' closure comes from L1), then another edit in
  //    the same session (the dependencies are in the VFS already).
  const serde = cases[0];
  const edited = (n: number) => ({ ...serde, main: serde.main.replace('roundtrip ok', `roundtrip OK ${n}`) });
  const [e1, e2] = await session(page, [edited(1), edited(2)]);
  check(e1, /roundtrip OK 1,/);
  check(e2, /roundtrip OK 2,/);
  result.steps['edit-after-reload/serde_json'] = summary(e1);
  result.steps['edit-in-session/serde_json'] = summary(e2);
  for (const e of [e1, e2]) expect(e.build.units.filter((u: any) => u.cached === undefined).map((u: any) => u.kind), 'an edit rebuilds only the bin').toEqual(['bin']);

  // 4. Empty L1, prebuilt L2, every main.rs edited: the bins are built here, everything they
  //    need comes from L2.
  const l2dir = `build/l2/${release}`;
  expect(existsSync(l2dir), `${l2dir} (tools/prebuild)`).toBe(true);
  const l2 = await session(page, cases.map(c => ({ ...c, main: `${c.main}\n// edited\n` })), { clearL1: true, l2: `/l2/${release}/` });
  for (const s of l2) {
    check(s, expected[s.name]);
    result.steps[`l2-edited/${s.name}`] = summary(s);
    // 'fresh': shared with an earlier case, which got it from L2 in this session.
    expect(s.build.units.filter((u: any) => u.cached !== 'l2' && u.cached !== 'fresh').map((u: any) => u.kind), `${s.name}: all but the bin from L2`).toEqual(['bin']);
  }

  for (const [k, v] of Object.entries(result.steps)) console.log(`[${k}] ${JSON.stringify(v)}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-cache.json`, JSON.stringify(result, null, 2));
});

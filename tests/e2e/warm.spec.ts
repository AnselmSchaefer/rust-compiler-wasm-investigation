import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-27: warm latency against PROPOSAL §6: `cargo check` of the user crate < 1 s and edit → run
// < 2 s, with the compile servers warm and the dependencies in place. Two projects: the 500-line
// benchmark (bench/programs/medium.rs as src/main.rs) and tests/planner/cases/check (serde derive,
// serde_json, thiserror: build scripts and proc macros among its dependencies). After a cold build
// each gets ROUNDS edits, each followed by `check`, then ROUNDS edits each followed by build + run.
// INCREMENTAL=1: the planner's `-C incremental` for path packages (needs file locks in rustc on
// WASI). Numbers: bench/results/<date>-<commit>-warm.json; bench/warm.md.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const ROUNDS = 5;
const INCREMENTAL = !!process.env.INCREMENTAL;
// DEBUGINFO=0|1|2: the dev profile's debuginfo (cargo's default is 2).
const DEBUGINFO = process.env.DEBUGINFO === undefined ? undefined : Number(process.env.DEBUGINFO);
const MANIFEST = (name: string) => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;
const PROJECTS = [
  { name: 'medium', manifest: MANIFEST('medium'), main: readFileSync('bench/programs/medium.rs', 'utf8'), expect: 'medium ok' },
  { name: 'check', manifest: readFileSync('tests/planner/cases/check/Cargo.toml', 'utf8'), main: readFileSync('tests/planner/cases/check/src/main.rs', 'utf8'), expect: 'bad point' },
];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('warm check and edit → run (PROPOSAL §6 budgets)', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const r = await page.evaluate(async ({ release, PROJECTS, ROUNDS, INCREMENTAL, DEBUGINFO }) => {
    try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ }
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4 });
    const out: Record<string, unknown> = {};
    for (const p of PROJECTS) {
      const dir = `/${p.name}`;
      const args = { project: dir, resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href, profile: { incremental: INCREMENTAL, ...(DEBUGINFO !== undefined && { debuginfo: DEBUGINFO }) } };
      await o.call('writeFile', { path: `${dir}/Cargo.toml`, data: p.manifest });
      const edited = (i: number) => p.main.replace('fn main() {', `fn main() {\n    let _edit = ${i};`);
      await o.call('writeFile', { path: `${dir}/src/main.rs`, data: p.main });
      let t = performance.now();
      const cold = await o.call('build', args);
      const coldMs = performance.now() - t;
      if (!cold.ok) return { error: `${p.name}: ${cold.errors}` };
      // The first check after a build is cold for check mode's metadata-only units: untimed.
      await o.call('check', args);
      const check: number[] = [], run: number[] = [];
      const detail: unknown[] = [];
      for (let i = 1; i <= ROUNDS; i++) {
        await o.call('writeFile', { path: `${dir}/src/main.rs`, data: edited(i) });
        t = performance.now();
        const c = await o.call('check', args);
        check.push(performance.now() - t);
        if (!c.ok) return { error: `${p.name} check: ${c.errors}` };
        detail.push({ check: c.ms, built: c.units.filter((u: any) => !u.cached).map((u: any) => `${u.name} ${u.kind} ${u.rustcMs ?? ''}`) });
      }
      for (let i = 1; i <= ROUNDS; i++) {
        await o.call('writeFile', { path: `${dir}/src/main.rs`, data: edited(100 + i) });
        t = performance.now();
        const b = await o.call('build', args);
        if (!b.ok) return { error: `${p.name} build: ${b.errors}` };
        const x = await o.call('run', { path: b.bins[p.name] });
        run.push(performance.now() - t);
        if (!x.stdout.includes(p.expect)) return { error: `${p.name} run: ${x.stdout} ${x.stderr}` };
        detail.push({ build: b.ms, run: x.ms, built: b.units.filter((u: any) => !u.cached).map((u: any) => `${u.name} ${u.kind} ${u.rustcMs ?? ''}`) });
      }
      out[p.name] = { coldMs: Math.round(coldMs), units: cold.units.length, check: check.map(Math.round), run: run.map(Math.round), detail };
    }
    await o.call('close', {});
    return out;
  }, { release, PROJECTS, ROUNDS, INCREMENTAL, DEBUGINFO });
  if ((r as any).error) console.log((r as any).error);
  expect((r as any).error).toBeUndefined();
  const summary: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(r as Record<string, any>)) {
    summary[name] = { cold: p.coldMs, units: p.units, checkMedian: median(p.check), runMedian: median(p.run), check: p.check, run: p.run };
  }
  const tag = `${INCREMENTAL ? '-incremental' : ''}${DEBUGINFO !== undefined ? `-debuginfo${DEBUGINFO}` : ''}`;
  console.log(`[warm${tag}] ${JSON.stringify(summary)}`);
  for (const [name, p] of Object.entries(r as Record<string, any>)) console.log(`  ${name}: ${JSON.stringify(p.detail.slice(0, 1))} … ${JSON.stringify(p.detail.slice(-1))}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-warm${tag}.json`, JSON.stringify({ release, incremental: INCREMENTAL, debuginfo: DEBUGINFO ?? 2, summary, detail: r }, null, 2));
  // The budgets: on the 500-line benchmark.
  const m = (r as any).medium;
  expect(median(m.check), 'warm check < 1 s').toBeLessThan(1000);
  expect(median(m.run), 'warm edit → run < 2 s').toBeLessThan(2000);
});

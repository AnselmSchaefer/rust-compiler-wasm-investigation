import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-17: `cargo build` in the browser. A project using serde_json (itoa, memchr, serde_core,
// zmij; three of them with build scripts) is resolved against the pinned index (/index/),
// downloaded, planned by the planner in resolver.wasm, compiled on N compile servers with build
// scripts run in the sandbox, linked, and the program runs. Then the `mix` case (rand, regex,
// renamed serde_json). Numbers: bench/results/<date>-<commit>-build.json. scripts/verify/wp-17.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const WORKERS = Number(process.env.BUILD_WORKERS ?? 4);
// BUILD_DEBUGINFO=0: a lighter profile than cargo's dev (debuginfo=2), for comparison.
const PROFILE = process.env.BUILD_DEBUGINFO ? { debuginfo: Number(process.env.BUILD_DEBUGINFO) } : undefined;
const cases = ['serde_json', 'mix'].map(name => ({
  name,
  manifest: readFileSync(`tests/planner/cases/${name}/Cargo.toml`, 'utf8'),
  main: readFileSync(`tests/planner/cases/${name}/src/main.rs`, 'utf8'),
}));
const expected: Record<string, RegExp> = {
  serde_json: /^\{"n":\[1,2\.5,-3\],"name":"demo","ok":true\}\nroundtrip ok, n\[1\] = 2\.5\n$/,
  mix: /^user=ferris host=rust\n\{"user":"ferris"\}\ndice ok\n$/,
};

test('cargo build in the browser: serde_json and mix build, run', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const results = await page.evaluate(async ({ cases, release, workers, profile }) => {
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    const init = await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers });
    const out: any[] = [];
    for (const c of cases) {
      const project = `/${c.name}`;
      await o.call('writeFile', { path: `${project}/Cargo.toml`, data: c.manifest });
      await o.call('writeFile', { path: `${project}/src/main.rs`, data: c.main });
      const build = await o.call('build', { project, resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href, profile });
      const bin = Object.values(build.bins)[0] as string | undefined;
      const run = bin ? await o.call('run', { path: bin }) : null;
      out.push({ name: c.name, build, run });
    }
    return { init, out, stats: await o.call('stats', {}), close: await o.call('close', {}) };
  }, { cases, release, workers: WORKERS, profile: PROFILE });

  const summary: any = { release: results.init.rustcId, workers: WORKERS, profile: PROFILE ?? 'dev', stats: results.stats, cases: {} };
  for (const { name, build, run } of results.out) {
    if (!build.ok) console.log(`[${name}] build failed:\n${build.errors}`);
    expect(build.ok, `${name} builds`).toBe(true);
    // Time spent in rustc and build scripts, over the build's wall time: how much ran in parallel.
    const busy = build.units.reduce((a: number, u: any) => a + (u.rustcMs ?? u.end - u.start), 0);
    const byKind = (k: string) => build.units.filter((u: any) => u.kind === k).length;
    const s = {
      packages: build.packages, units: build.units.length, libs: byKind('lib'), buildScripts: byKind('run-custom-build'),
      ms: build.ms, parallelism: +(busy / build.ms.build).toFixed(2),
      slowest: [...build.units].sort((a: any, b: any) => (b.end - b.start) - (a.end - a.start)).slice(0, 3).map((u: any) => `${u.name} ${u.kind} ${u.end - u.start} ms`),
      run: { code: run.code, stdout: run.stdout },
    };
    console.log(`[${name}] ${JSON.stringify(s)}`);
    expect(run.code, `${name} runs`).toBe(0);
    expect(run.stdout).toMatch(expected[name]);
    summary.cases[name] = { ...s, units: build.units };
  }
  expect(results.close.code).toBe(0);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-build-w${WORKERS}${PROFILE ? `-g${PROFILE.debuginfo}` : ''}.json`, JSON.stringify(summary, null, 2));
});

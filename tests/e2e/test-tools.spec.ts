import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-26: cargo test, Clippy and rustfmt in Chromium. `cargo test` of tests/planner/cases/tests
// (unit tests with a dev-dependency, a bin's test, an integration test, an ignored and a failing
// test), each test in a sandbox process of its own (web/build/test.ts); then the failing test
// again, alone, by name. Clippy (linked into rustc-multi) lints a file with two lints; rustfmt
// formats one. Numbers: bench/results/<date>-<commit>-test-tools.json. scripts/verify/wp-26.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const CASE = 'tests/planner/cases/tests';

function caseFiles(dir = CASE, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && ['crates', 'build-output', 'cargo-vv.jsonl', 'record.cmd', 'Cargo.lock'].includes(e.name)) continue;
    if (e.isDirectory()) Object.assign(out, caseFiles(dir, r));
    else out[r] = readFileSync(`${dir}/${r}`, 'utf8');
  }
  return out;
}

const LINT = `pub fn f(v: &Vec<u32>) -> u32 {\n    let n = v.len() as u32;\n    return n;\n}\n`;
const UNFORMATTED = `fn  main( ){let x=1;\nif x==1 {println!("{}",x)}}\n`;
const FORMATTED = `fn main() {\n    let x = 1;\n    if x == 1 {\n        println!("{}", x)\n    }\n}\n`;

test('cargo test, a single test by name, Clippy and rustfmt in the browser', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const r = await page.evaluate(async ({ release, files, LINT, UNFORMATTED }) => {
    try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ }
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4 });
    for (const [p, d] of Object.entries(files)) await o.call('writeFile', { path: `/tests/${p}`, data: d });
    const common = { project: '/tests', resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href };
    const all = await o.call('test', common);
    const one = await o.call('test', { ...common, filter: 'unit::failing', exact: true });
    await o.call('writeFile', { path: '/lint/Cargo.toml', data: '[package]\nname = "lint"\nversion = "0.1.0"\nedition = "2021"\n' });
    await o.call('writeFile', { path: '/lint/src/lib.rs', data: LINT });
    const clippy = await o.call('clippy', { ...common, project: '/lint' });
    await o.call('writeFile', { path: '/lint/src/main.rs', data: UNFORMATTED });
    const check1 = await o.call('fmt', { path: '/lint/src/main.rs', edition: '2021', check: true });
    const fmt = await o.call('fmt', { path: '/lint/src/main.rs', edition: '2021' });
    const after = new TextDecoder().decode(await o.call('readFile', { path: '/lint/src/main.rs' }));
    const check2 = await o.call('fmt', { path: '/lint/src/main.rs', edition: '2021', check: true });
    await o.call('close', {});
    const strip = (t: any) => ({ ...t, build: { ok: t.build.ok, errors: t.build.errors, ms: t.build.ms, units: t.build.units.length } });
    return { all: strip(all), one: strip(one), clippy: { ok: clippy.ok, diagnostics: clippy.diagnostics, ms: clippy.ms, errors: clippy.build.errors }, check1, fmt, after, check2 };
  }, { release, files: caseFiles(), LINT, UNFORMATTED });

  // cargo test: every test, with its own status, time and output.
  if (!r.all.build.ok) console.log(r.all.build.errors);
  expect(r.all.build.ok).toBe(true);
  const by = (name: string) => r.all.tests.find((t: any) => t.name === name);
  const summary = r.all.tests.map((t: any) => `${t.suite} ${t.name} ${t.status}`);
  console.log(summary.join('\n'));
  expect(summary.sort()).toEqual([
    'tests/integration.rs integration ok',
    'unittests src/lib.rs unit::adds ok',
    'unittests src/lib.rs unit::failing failed',
    'unittests src/lib.rs unit::finds ok',
    'unittests src/lib.rs unit::formats_with_a_dev_dependency ok',
    'unittests src/lib.rs unit::ignored ignored',
    'unittests src/main.rs bin_test ok',
  ]);
  expect(by('unit::failing').message).toContain('one plus one');
  expect(by('unit::failing').message).toContain('left: 2');
  expect(by('unit::failing').stdout).toContain('output of the failing test');
  expect(r.all.counts).toEqual({ passed: 5, failed: 1, ignored: 1, filteredOut: 0 });
  expect(r.all.ok).toBe(false);

  // The failing test again, by name: only it runs, with the same structured result.
  expect(r.one.tests.map((t: any) => `${t.name} ${t.status}`)).toEqual(['unit::failing failed']);
  expect(r.one.tests[0].message).toContain('one plus one');
  expect(r.one.counts.filteredOut).toBe(6);
  expect(r.one.build.units).toBeGreaterThan(0);

  // Clippy: both lints, as JSON diagnostics with their primary spans.
  if (!r.clippy.ok) console.log(r.clippy.errors);
  const codes = r.clippy.diagnostics.map((d: any) => `${d.code} ${d.file}:${d.line}`);
  console.log(codes.join('\n'));
  expect(codes).toEqual(expect.arrayContaining(['clippy::needless_return /lint/src/lib.rs:3', 'clippy::ptr_arg /lint/src/lib.rs:1']));

  // rustfmt: --check reports the unformatted file, formatting fixes it, --check is clean after.
  expect(r.check1.exit).toBe(1);
  expect(r.check1.changed).toBe(false);
  expect(r.fmt).toMatchObject({ exit: 0, changed: true });
  expect(r.after).toBe(FORMATTED);
  expect(r.check2.exit).toBe(0);

  const timing = { test: r.all.ms, one: r.one.ms, perTest: r.all.tests.map((t: any) => `${t.name} ${t.ms}`), clippy: r.clippy.ms, fmt: r.fmt.ms };
  console.log(`[test-tools] ${JSON.stringify(timing)}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-test-tools.json`, JSON.stringify({ release, ...timing, tests: r.all.tests }, null, 2));
});

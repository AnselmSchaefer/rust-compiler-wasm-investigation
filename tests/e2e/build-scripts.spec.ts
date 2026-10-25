import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-21: build scripts. `cargo build` of tests/planner/cases/scripts in Chromium: num-traits
// (autocfg: `rustc -vV`, then probes piped to `rustc -`), rustversion (host side, `rustc --version`),
// libc and anyhow (`rustc --version`, a probe file), proc-macro2 (probe files), and a `links` pair
// (DEP_LINKA_*, -L from a dependency's script, a relative read from the package dir). The scripts
// are compiled against the build-script std (web/build/bs-std/lib.rs), whose Command sends rustc
// runs to a compile server. Every script must print what it printed in the native build
// (tests/planner/record.sh), and the program must print what the native build's prints.
// Numbers: bench/results/<date>-<commit>-build-scripts.json. scripts/verify/wp-21.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const CASE = 'tests/planner/cases/scripts';
const NATIVE = 'build/wp-17/record/scripts/root/target/wasm32-wasip1/debug/scripts.wasm';

/** The case's own files (not what record.sh keeps next to them), relative. */
function caseFiles(dir = CASE, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && ['crates', 'build-output', 'cargo-vv.jsonl', 'target', 'Cargo.lock'].includes(e.name)) continue;
    if (e.isDirectory()) Object.assign(out, caseFiles(dir, r));
    else out[r] = readFileSync(`${dir}/${r}`, 'utf8');
  }
  return out;
}

/** Build-script output with paths and hashes made comparable between the two builds. */
const norm = (s: string) => s.replace(/\$TARGET|\/target/g, 'T').replace(/-[0-9a-f]{16}\b/g, '-H');

test('build scripts: autocfg, rustc probes and links metadata build in the browser', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  const files = caseFiles();
  const session = (main: string, clearL1: boolean) => page.evaluate(async ({ release, files, main, clearL1 }) => {
    if (clearL1) { try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ } }
    const o = (window as any).orch;
    const here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4 });
    for (const [p, d] of Object.entries(files)) await o.call('writeFile', { path: `/scripts/${p}`, data: p === 'src/main.rs' ? main : d });
    const build = await o.call('build', { project: '/scripts', resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href });
    // Every build script's stdout, by build dir: target side, then host side.
    const outputs: Record<string, string> = {};
    for (const side of ['/target/wasm32-wasip1/debug/build', '/target/debug/build']) {
      let dirs: string[] = [];
      try { dirs = await o.call('ls', { path: side }); } catch { /* none */ }
      for (const d of dirs) {
        try { outputs[`${side}/${d}`] = new TextDecoder().decode(await o.call('readFile', { path: `${side}/${d}/output` })); } catch { /* a script's compile dir */ }
      }
    }
    const run = build.ok ? await o.call('run', { path: build.bins.scripts }) : null;
    await o.call('close', {});
    return { build, run, outputs };
  }, { release, files, main, clearL1 });

  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const main = files['src/main.rs'];
  const r = await session(main, true);
  if (!r.build.ok) console.log(r.build.errors);
  expect(r.build.ok).toBe(true);

  // Each script's output = the native build's (build-output/<pkg>-<ver>[.host].txt).
  const compared: string[] = [];
  for (const [dir, out] of Object.entries(r.outputs)) {
    const host = dir.startsWith('/target/debug/');
    const pkg = dir.split('/').pop()!.replace(/-[0-9a-f]{16}$/, '');
    const name = new RegExp(`^${pkg.replace(/[-]/g, '\\-')}-\\d[^/]*?${host ? '\\.host' : '(?<!\\.host)'}\\.txt$`);
    const golden = readdirSync(`${CASE}/build-output`).find(f => name.test(f));
    expect(golden, `golden output for ${dir}`).toBeTruthy();
    expect(norm(out), `${pkg}${host ? ' (host)' : ''}`).toBe(norm(readFileSync(`${CASE}/build-output/${golden}`, 'utf8')));
    compared.push(`${pkg}${host ? ' (host)' : ''}`);
  }
  expect(compared.length).toBe(readdirSync(`${CASE}/build-output`).length);

  const expected = existsSync(NATIVE) ? execFileSync('wasmtime', ['run', NATIVE]).toString() : null;
  console.log(r.run.stdout);
  if (expected !== null) expect(r.run.stdout).toBe(expected);
  else expect(r.run.stdout).toContain('num-traits: 1.4142135 7.0');
  const scripts = r.build.units.filter((u: any) => u.kind === 'run-custom-build');
  console.log(`[build-scripts] ${JSON.stringify({ units: r.build.units.length, ms: r.build.ms, compared, scripts: scripts.map((u: any) => `${u.name} ${u.end - u.start} ms`) })}`);

  // A fresh page, main.rs edited: every script's run comes from L1 with its output, and only the
  // bin is built.
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const e = await session(main.replace('fn main() -> anyhow::Result<()> {', 'fn main() -> anyhow::Result<()> {\n    println!("edited");'), false);
  if (!e.build.ok) console.log(e.build.errors);
  expect(e.build.ok).toBe(true);
  expect(e.build.units.filter((u: any) => u.cached === undefined).map((u: any) => u.kind)).toEqual(['bin']);
  expect(e.run.stdout).toBe(`edited\n${r.run.stdout}`);
  console.log(`[build-scripts-edit] ${JSON.stringify({ ms: e.build.ms, l1: e.build.units.filter((u: any) => u.cached === 'l1').length })}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-build-scripts.json`, JSON.stringify({ release, units: r.build.units, ms: r.build.ms, edit: e.build.ms, run: r.run }, null, 2));
});

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

// WP-25: projects and workspaces. The `ws` planner case (a virtual workspace: app → ws-core,
// util; an excluded path dependency; inheritance) is zipped by Python's zipfile, imported into
// /projects/ws, persisted to OPFS, and after a reload it is still there and builds and runs.
// Then: Cargo.toml edits with lockfile changes (and a failing one that changes nothing), zip
// export round trip, and a GitHub import (git trees API + raw files).
// Numbers: bench/results/<date>-<commit>-projects.json. scripts/verify/wp-25.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const CASE = 'tests/planner/cases/ws';
const zip = execFileSync('python3', ['-I', '-c', `
import os, sys, zipfile, io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, fs in sorted(os.walk(sys.argv[1])):
        for f in sorted(fs):
            p = os.path.join(d, f); r = os.path.relpath(p, sys.argv[1])
            if r.split(os.sep)[0] in ('crates', 'build-output') or r in ('cargo-vv.jsonl', 'Cargo.lock'): continue
            z.write(p, 'ws-main/' + r)
sys.stdout.buffer.write(buf.getvalue())`, CASE]);

async function open(page: Page, clear = false) {
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  return page.evaluate(async ({ release, clear }) => {
    if (clear) for (const d of ['vfs', 'build-cache']) { try { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); } catch { /* none */ } }
    const here = (f: string) => new URL(f, location.href).href;
    return (window as any).orch.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4, persist: true });
  }, { release, clear });
}

const call = (page: Page, op: string, args: any) => page.evaluate(({ op, args }) => {
  const here = (f: string) => new URL(f, location.href).href;
  const extra = op === 'build' || op === 'manifestEdit' ? { resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href } : {};
  return (window as any).orch.call(op, { ...extra, ...args });
}, { op, args });

test('projects: import a workspace, persist, reload, build, edit, export, GitHub', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(600_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  const r: any = { release };

  // 1. Import the zip (one top directory, stripped) and persist it.
  const init1 = await open(page, true);
  expect(init1.projects.names).toEqual([]);
  r.import = await page.evaluate(async (zip) => (window as any).orch.call('projectImport', { name: 'ws', source: { zip: new Uint8Array(zip) } }), [...zip]);
  r.flush = await call(page, 'projectFlush', {});
  console.log(`[import] ${JSON.stringify(r.import)} ${JSON.stringify(r.flush)}`);

  // 2. Reload: the project comes back from OPFS and builds (all four packages, two members built
  //    from the workspace plus the excluded path dependency).
  const t0 = Date.now();
  const init2 = await open(page);
  r.reload = { restored: init2.projects.restored, names: init2.projects.names, initMs: Date.now() - t0 };
  expect(init2.projects.names).toEqual(['ws']);
  expect(init2.projects.restored).toBe(r.import.files);
  const build = await call(page, 'build', { project: '/projects/ws' });
  if (!build.ok) console.log(build.errors);
  expect(build.ok).toBe(true);
  const local = build.units.filter((u: any) => ['app', 'ws-core', 'util', 'helper'].includes(u.name)).map((u: any) => `${u.name} ${u.kind}`).sort();
  expect(local).toEqual(['app bin', 'helper lib', 'util lib', 'ws-core lib']);
  const run = await call(page, 'run', { path: build.bins.app });
  expect(run.stdout).toBe('{"h":"helper","n":4} 42 7\n');
  r.build = { units: build.units.length, packages: build.packages, ms: build.ms, local };
  const lock = new TextDecoder().decode(new Uint8Array(Object.values(await call(page, 'readFile', { path: '/projects/ws/Cargo.lock' })) as number[]));
  expect(lock).toBe(readFileSync(`${CASE}/Cargo.lock`, 'utf8'));

  // 3. Cargo.toml edits: one that adds a package, one that can't resolve (nothing changes).
  const add = await call(page, 'manifestEdit', { project: 'ws', dir: 'libs/util', edits: [{ op: 'add', name: 'smallvec', version: '1', features: ['const_generics'] }] });
  expect(add.ok).toBe(true);
  expect(add.changes).toEqual([{ name: 'smallvec', to: '1.16.4' }]);
  expect(add.manifest).toContain('smallvec = { version = "1", features = ["const_generics"] }');
  const bad = await call(page, 'manifestEdit', { project: 'ws', dir: 'app', edits: [{ op: 'add', name: 'itoa', version: '=0.0.1' }] });
  expect(bad.ok).toBe(false);
  expect(bad.stage).toBe('resolve');
  const appToml = new TextDecoder().decode(new Uint8Array(Object.values(await call(page, 'readFile', { path: '/projects/ws/app/Cargo.toml' })) as number[]));
  expect(appToml).toBe(readFileSync(`${CASE}/app/Cargo.toml`, 'utf8'));
  const rm = await call(page, 'manifestEdit', { project: 'ws', dir: 'libs/util', edits: [{ op: 'remove', name: 'smallvec' }] });
  expect(rm.changes).toEqual([{ name: 'smallvec', from: '1.16.4' }]);
  r.edits = { add: add.changes, bad: bad.error.split('\n')[0], remove: rm.changes };

  // 4. Export, re-import under another name: the same files.
  const exported = await page.evaluate(async () => {
    const o = (window as any).orch;
    const z = await o.call('projectExport', { name: 'ws' });
    await o.call('projectImport', { name: 'ws2', source: { zip: z } });
    return { bytes: z.length, ws: await o.call('ls', { path: '/projects/ws/libs' }), ws2: await o.call('ls', { path: '/projects/ws2/libs' }), list: await o.call('projectList', {}) };
  });
  expect(exported.ws2).toEqual(exported.ws);
  expect(exported.list).toEqual(['ws', 'ws2']);
  r.export = { bytes: exported.bytes };

  // 5. GitHub: dtolnay/itoa at a tag, through the trees API and raw files (no build: its
  //    optional dependency isn't in the pinned index snapshot).
  const gh = await call(page, 'projectImport', { name: 'itoa', source: { github: 'dtolnay/itoa@1.0.18' } });
  const ghToml = new TextDecoder().decode(new Uint8Array(Object.values(await call(page, 'readFile', { path: '/projects/itoa/Cargo.toml' })) as number[]));
  expect(ghToml).toContain('name = "itoa"');
  expect(ghToml).toContain('version = "1.0.18"');
  r.github = gh;
  console.log(`[results] ${JSON.stringify(r)}`);
  await call(page, 'close', {});

  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-projects.json`, JSON.stringify(r, null, 2));
});

import { test } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

// WP-22: the ecosystem matrix in Chromium. Each crate of the list (ECO_LIST, default
// tests/ecosystem/top100.json) is built as a dependency of a wrapper lib (tests/ecosystem/
// wrappers.mjs), with default features, against the ecosystem index snapshot (/eco-index/, the
// same one tests/ecosystem/native.sh used). One page per crate, so that a hung build only costs
// its own timeout; the build cache (L1) carries over, as for a user. ECO_ONLY=a,b: just these.
// Writes build/wp-22/browser.json; tests/ecosystem/report.mjs makes the table. Long: only with ECO=1.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];
const LIST = process.env.ECO_LIST ?? 'tests/ecosystem/top100.json';
const PER_CRATE_MS = Number(process.env.ECO_TIMEOUT_MS ?? 600_000);

test('ecosystem matrix', async ({ page }, info) => {
  test.skip(!process.env.ECO || info.project.name !== 'chromium', 'long; run with ECO=1 on Chromium');
  test.setTimeout(0);
  const only = process.env.ECO_ONLY?.split(',');
  const crates: { name: string; version: string }[] = JSON.parse(readFileSync(LIST, 'utf8')).crates.filter((c: any) => !only || only.includes(c.name));
  const out = 'build/wp-22/browser.json';
  const results: Record<string, unknown> = process.env.ECO_KEEP ? JSON.parse(readFileSync(out, 'utf8')) : {};
  let first = !process.env.ECO_KEEP;
  for (const c of crates) {
    await page.goto('/www/orchestrator/index.html');
    await page.waitForFunction(() => (window as any).orchReady);
    const manifest = `[package]\nname = "eco-${c.name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${c.name} = "=${c.version}"\n`;
    const t0 = Date.now();
    const build = page.evaluate(async ({ release, manifest, name, clearL1 }) => {
      if (clearL1) { try { await (await navigator.storage.getDirectory()).removeEntry('build-cache', { recursive: true }); } catch { /* none */ } }
      const o = (window as any).orch;
      const here = (f: string) => new URL(f, location.href).href;
      await o.call('init', { releaseUrl: new URL(`/release/${release}/`, location.href).href, vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4 });
      await o.call('writeFile', { path: `/eco/${name}/Cargo.toml`, data: manifest });
      await o.call('writeFile', { path: `/eco/${name}/src/lib.rs`, data: '' });
      try {
        const b = await o.call('build', { project: `/eco/${name}`, resolverUrl: here('resolver.wasm'), index: new URL('/eco-index/', location.href).href });
        const est = await navigator.storage.estimate();
        return { ok: b.ok, errors: b.errors, ms: b.ms, packages: b.packages, units: b.units.length, built: b.units.filter((u: any) => !u.cached).length,
          storageMiB: Math.round((est.usage ?? 0) / 2 ** 20), quotaMiB: Math.round((est.quota ?? 0) / 2 ** 20), cache: b.cache,
          slowest: [...b.units].sort((x: any, y: any) => (y.end - y.start) - (x.end - x.start)).slice(0, 3).map((u: any) => `${u.name} ${u.kind} ${u.end - u.start}`) };
      } catch (e) {
        return { ok: false, errors: `exception: ${String((e as Error)?.message ?? e)}` };
      } finally {
        try { await o.call('close', {}); } catch { /* dead */ }
      }
    }, { release, manifest, name: c.name, clearL1: first });
    first = false;
    const r = await Promise.race([build, new Promise<{ ok: false; errors: string }>(ok => setTimeout(() => ok({ ok: false, errors: `timeout after ${PER_CRATE_MS} ms` }), PER_CRATE_MS))])
      .catch(e => ({ ok: false, errors: `page: ${String(e?.message ?? e)}` }));
    results[c.name] = { version: c.version, wallMs: Date.now() - t0, ...r };
    console.log(`[eco] ${c.name} ${c.version}: ${r.ok ? 'ok' : 'FAIL'} ${Date.now() - t0} ms ${(r as any).storageMiB ?? '?'}/${(r as any).quotaMiB ?? '?'} MiB${r.ok ? '' : ` ${String(r.errors).split('\n').find(l => l.startsWith('error')) ?? String(r.errors).slice(0, 200)}`}`);
    mkdirSync('build/wp-22', { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 1));
  }
});

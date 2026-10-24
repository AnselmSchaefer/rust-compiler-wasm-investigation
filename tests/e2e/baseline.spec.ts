import { test, expect } from '@playwright/test';

// WP-01: the oligamiq rust_wasm v3 rustc.wasm compiles and runs hello world in the browser.
// Needs `bash scripts/fetch-baseline.sh && node scripts/build-baseline.mjs` first (scripts/verify/wp-01.sh does both).
test('baseline rustc.wasm compiles and runs hello world', async ({ page }, info) => {
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[${info.project.name} console] ${m.text()}`); });
  await page.goto('/www/baseline/index.html');
  const r = await page.waitForFunction(() => (window as any).result, null, { timeout: 280_000 }).then(h => h.jsonValue());
  console.log(info.project.name, JSON.stringify({ ok: r.ok, stage: r.stage, error: r.error, ms: r.ms, out: r.programStdout }));
  if (!r.ok) console.log(r.rustcStderr);
  expect(r.ok).toBe(true);
  expect(r.programStdout).toContain('Hello');
});

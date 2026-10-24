import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// WP-16: in the browser, serde and serde_json resolve (index from the pinned snapshot at /index/,
// since index.crates.io has no CORS) and download from static.crates.io into the VFS; after a
// reload, the same works offline from the OPFS cache. The lockfile must equal the native
// resolver's for the same manifest (expected.lock, written by scripts/verify/wp-16.sh).
const MANIFEST = `[package]
name = "demo"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;

test('resolve, download and unpack serde + serde_json; offline from OPFS', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  // Offline, every index fetch fails first (network-first) before the cache answers: expected noise.
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) console.log(`[console] ${m.text()}`); });
  const expected = readFileSync('build/www/deps-test/expected.lock', 'utf8');

  await page.goto('/www/deps-test/index.html');
  await page.waitForFunction(() => (window as any).depsReady);
  const cold = await page.evaluate(m => (window as any).depsTest.run(m, true), MANIFEST);
  const { lock, serdeToml, ...coldStats } = cold;
  console.log('cold', JSON.stringify(coldStats));
  expect(lock).toBe(expected);
  expect(cold.serdeFeatures).toContain('derive');
  expect(serdeToml).toContain('name = "serde"');
  expect(cold.crates).toBe(cold.packages - 1); // every registry package, not the root
  expect(cold.fromCache).toBe(0);
  expect(cold.filesInVfs).toBe(cold.filesUnpacked);

  await page.reload();
  await page.waitForFunction(() => (window as any).depsReady);
  await context.setOffline(true);
  try {
    const warm = await page.evaluate(m => (window as any).depsTest.run(m, false), MANIFEST);
    const { lock: warmLock, serdeToml: _, ...warmStats } = warm;
    console.log('offline', JSON.stringify(warmStats));
    expect(warmLock).toBe(expected);
    expect(warm.index.fetched).toBe(0);
    expect(warm.index.fromCache).toBe(cold.index.fetched);
    expect(warm.fromCache).toBe(warm.crates);
    expect(warm.filesInVfs).toBe(cold.filesInVfs);
  } finally {
    await context.setOffline(false);
  }
});

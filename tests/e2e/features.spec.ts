import { test, expect } from '@playwright/test';

// The browser IDE depends on these engine features (PROPOSAL.md §7).
test('engine supports required Wasm features', async ({ page }, info) => {
  await page.goto('/features.html');
  const f = await page.waitForFunction(() => (window as any).features).then(h => h.jsonValue());
  console.log(info.project.name, JSON.stringify(f));
  expect(f.crossOriginIsolated).toBe(true);
  expect(f.sharedArrayBuffer).toBe(true);
  expect(f.sharedMemory).toBe(true);
  expect(f.exceptions).toBe(true);
  expect(f.opfs).toBe(true);
  // JSPI and memory64 are recorded but not required (Firefox <153 / Safari gaps).
});

import { test, expect } from '@playwright/test';

// WP-11: two workers see each other's writes through the shared VFS, and files survive a reload.
// Needs `bash scripts/build-vfs.sh && node scripts/build-web-tests.mjs` (scripts/verify/wp-11.sh does both).
test('shared VFS across workers, persisted in OPFS', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/vfs-test/index.html');
  await page.waitForFunction(() => (window as any).vfsReady);
  const w = await page.evaluate(() => (window as any).vfsTest.write());
  console.log('write', JSON.stringify(w));
  expect(w.restoredBefore).toBe(0);
  expect(w.bSeesA).toBe('fn main() {}\n');
  expect(w.aSeesB).toBe('from B');
  expect(w.pageSees).toBe('from B');
  expect(w.mismatches).toBe(0);
  expect(w.bSeesRename).toEqual([false, 'fn main() {}\n']);
  expect(w.bigRead.size).toBe(64 << 20);
  expect(w.bigRead.sum).toBe(7 * 16384);
  expect(w.flush.written).toBeGreaterThanOrEqual(602);
  expect(w.autoFlushed).toBe(1);

  await page.reload();
  await page.waitForFunction(() => (window as any).vfsReady);
  const v = await page.evaluate(() => (window as any).vfsTest.verify());
  console.log('verify', JSON.stringify(v));
  expect(v.restored).toBe(603); // lib.rs, notes.txt, late.txt, 2 × 300
  expect(v.late).toBe('auto-flushed');
  expect(v.lib).toBe('fn main() {}\n');
  expect(v.mainGone).toBe(true);
  expect(v.goneGone).toBe(true);
  expect(v.notes).toBe('from B');
  expect(v.mismatches).toBe(0);
  expect(v.bigNotPersisted).toBe(true);
});

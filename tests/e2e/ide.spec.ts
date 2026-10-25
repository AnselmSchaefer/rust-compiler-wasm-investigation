import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// WP-40: the IDE (app/ide.html) driven through its UI, the way a person uses it, on the guided
// sample project (app/sample.ts): Sample → Run with typed input → Test (one failure) → fix the
// test in the editor → Rerun just that test → Clippy (needless_return; click the problem) → fix →
// Format → Check clean → + Dependency → Export. Edits go through the editor (CodeMirror), the
// rest through buttons, prompts and the terminal. scripts/verify/wp-40.sh.

/** Answers the next prompts/confirms in order. */
function answers(page: Page, ...replies: (string | true)[]) {
  page.on('dialog', async d => {
    const r = replies.shift();
    if (r === undefined) return d.dismiss();
    await (r === true ? d.accept() : d.accept(r));
  });
}

/** Replace `from` with `to` in the open file, as typing would. */
async function edit(page: Page, from: string, to: string) {
  await page.evaluate(({ from, to }) => {
    const v = (window as any).ide.view;
    const at = v.state.doc.toString().indexOf(from);
    if (at < 0) throw new Error(`not in the editor: ${from}`);
    v.dispatch({ changes: { from: at, to: at + from.length, insert: to } });
  }, { from, to });
}

/** Click, then wait until the call it starts has finished (a new Activity row with its time). */
async function act(page: Page, selector: string | (() => Promise<void>)) {
  const rows = page.locator('#activity .row');
  const before = await rows.count();
  await (typeof selector === 'string' ? page.click(selector) : selector());
  await expect(rows).toHaveCount(before + 1, { timeout: 300_000 });
  await expect(rows.first().locator('.ms')).not.toHaveText('…', { timeout: 300_000 });
}

test('the IDE, by hand: sample project from build to clean Clippy and fmt', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(900_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/app/ide.html');
  await page.evaluate(async () => {
    // A fresh start: no projects, no build cache from earlier runs.
    const root = await navigator.storage.getDirectory();
    for (const d of ['build-cache', 'vfs']) { try { await root.removeEntry(d, { recursive: true }); } catch { /* none */ } }
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).ide?.ready && document.querySelector('#status')?.textContent?.startsWith('Ready'), null, { timeout: 120_000 });
  const timings: Record<string, number> = {};
  const time = async (name: string, f: () => Promise<void>) => { const t0 = Date.now(); await f(); timings[name] = Date.now() - t0; };

  // Sample: the project appears with its README open.
  await page.click('#sample');
  await expect(page.locator('#file-title')).toHaveText('sample/README.md');
  await expect(page.locator('#tree .file')).toHaveCount(5);

  // Run: the first build (serde, serde_derive as a Wasm proc macro, a build script), then the
  // program reads the terminal.
  await time('first run (cold build)', async () => {
    await page.click('#run');
    // Visible at once that it's working: the bar, a spinning Run, disabled buttons, the phase.
    await expect(page.locator('#busybar')).toBeVisible();
    await expect(page.locator('#run')).toHaveClass(/busy/);
    await expect(page.locator('#test')).toBeDisabled();
    await expect(page.locator('#progress')).toContainText(/resolving|fetching|planning|compiling/);
    await expect(page.locator('#progress')).toContainText('compiling', { timeout: 120_000 });
    mkdirSync('build/wp-40', { recursive: true });
    await page.screenshot({ path: 'build/wp-40/busy.png' });
    await expect(page.locator('#terminal')).toContainText('Points, one per line', { timeout: 300_000 });
    await expect(page.locator('#busybar')).toBeHidden();
    await expect(page.locator('#test')).toBeEnabled();
  });
  await expect(page.locator('#terminal')).toContainText('built by build.rs');
  await page.click('#terminal');
  await page.keyboard.type('3, 4');
  await page.keyboard.press('Enter');
  await expect(page.locator('#terminal')).toContainText('dist2 = 25');
  await page.keyboard.press('Control+D');
  await expect(page.locator('#terminal')).toContainText('bye');
  await expect(page.locator('#terminal')).toContainText('exited after');
  await expect(page.locator('#stats')).toContainText('own rustc');

  // Test: one failure, with its panic message in the panel.
  await time('test', () => act(page, '#test'));
  await expect(page.locator('#tests-count')).toHaveText('(1/2)');
  const failed = page.locator('#tests .row.failed');
  await expect(failed).toContainText('tests::distance');
  await expect(failed.locator('pre')).toContainText('left: 25');

  // Fix the test in the editor, then rerun only that test.
  await page.click('#tree .file[data-path="src/lib.rs"]');
  await expect(page.locator('#file-title')).toHaveText('sample/src/lib.rs');
  await edit(page, '}), 5);', '}), 25);');
  await time('rerun one test', () => act(page, () => failed.locator('button').click()));
  await expect(page.locator('#tests-count')).toHaveText('(2/2)');
  const reruns = await page.locator('#activity .row').first().locator('.args').textContent();
  expect(reruns).toContain('"exact":true');

  // Clippy: the needless return, as a problem and an editor marker; clicking it moves the cursor.
  await time('clippy', () => act(page, '#clippy'));
  const problem = page.locator('#problems .row', { hasText: 'clippy::needless_return' });
  await expect(problem).toHaveCount(1);
  await page.click('.tabs button[data-tab="problems"]');
  await problem.click();
  const line = await page.evaluate(() => { const v = (window as any).ide.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
  expect(line).toBe(19); // `pub fn dist2` in the sample's src/lib.rs
  await expect(page.locator('.cm-lintRange-warning')).toHaveCount(1);
  await edit(page, '{ return p.x * p.x + p.y * p.y; }', '{ p.x * p.x + p.y * p.y }');
  await act(page, '#clippy');
  await expect(page.locator('#problems-count')).toHaveText('');

  // Format, then Check: the one-line fn is spread over three lines, and nothing is left.
  await time('format', () => act(page, '#fmt'));
  await expect.poll(() => page.evaluate(() => (window as any).ide.view.state.doc.toString())).toContain('pub fn dist2(p: &Point) -> i32 {\n    p.x * p.x + p.y * p.y\n}');
  await time('check', () => act(page, '#check'));
  await expect(page.locator('#problems .empty')).toHaveText('No problems.');
  await act(page, '#test');
  await expect(page.locator('#tests-count')).toHaveText('(2/2)');

  // + Dependency: itoa, as cargo add does; Cargo.toml shows it.
  answers(page, 'itoa');
  await time('add dependency', () => act(page, '#dep'));
  await expect(page.locator('#activity .row').first()).toContainText('dependency_add');
  await expect(page.locator('#activity .row').first().locator('.res')).toContainText('lockfile change');
  await page.click('#tree .file[data-path="Cargo.toml"]');
  await expect.poll(() => page.evaluate(() => (window as any).ide.view.state.doc.toString())).toMatch(/^itoa = "\d/m);

  // Export: a zip download named after the project.
  const download = page.waitForEvent('download');
  await page.click('#export');
  expect((await download).suggestedFilename()).toBe('sample.zip');

  console.log(`[ide] ${JSON.stringify(timings)}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${commit}-ide.json`, JSON.stringify({ timings }, null, 2));
});

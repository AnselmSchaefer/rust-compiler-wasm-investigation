import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// WP-14 (M1a): the IDE (app/, built by scripts/build-app.mjs) in Chromium, cold. The editor is
// interactive before the toolchain is loaded (target < 2 s); Check shows rustc's errors inline and
// in the terminal; Run builds, links and runs a program that reads a line typed into the terminal;
// Stop kills a program that never ends; the source survives a reload. Numbers:
// bench/results/<date>-<commit>-app.json. scripts/verify/wp-14.sh.
const EDITOR_BUDGET_MS = 2000;

const terminalText = (page: Page) => page.evaluate(() => {
  const b = (window as any).ide.term.xterm.buffer.active, lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  return lines.join('\n');
});
const setSource = (page: Page, text: string) => page.evaluate(t => {
  const v = (window as any).ide.view;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
}, text);

test('IDE: check, run with stdin, stop', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(180_000);
  const context = await browser.newContext(); // cold: no cache, no storage
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));

  await page.goto('/www/app/');
  await expect(page.locator('.cm-editor')).toBeVisible();
  const editorMs = await page.evaluate(() => Math.round(performance.getEntriesByName('editor-ready')[0].startTime));
  // The editor takes input while the toolchain is still loading.
  await expect(page.locator('#run')).toBeDisabled();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// typed while loading\n');
  await expect(page.locator('.cm-content')).toContainText('typed while loading');
  await page.evaluate(() => (window as any).ide.ready);
  const readyMs = await page.evaluate(() => Math.round(performance.now()));
  await expect(page.locator('#run')).toBeEnabled();

  // Check: an error, inline and in the terminal.
  await setSource(page, 'fn main() {\n    let x: u32 = "no";\n}\n');
  const t0 = Date.now();
  await page.locator('#check').click();
  await expect(page.locator('#status')).toHaveText('1 error(s)');
  const checkMs = Date.now() - t0;
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1);
  await expect(page.locator('.cm-lintRange-error')).toHaveText('"no"');
  expect(await terminalText(page)).toContain('mismatched types');

  // Run: build + link + run; the program asks for a name on stdin.
  const program = `use std::io::{self, BufRead, Write};
fn main() {
    print!("What's your name? ");
    io::stdout().flush().unwrap();
    let mut name = String::new();
    io::stdin().lock().read_line(&mut name).unwrap();
    println!("Nice to meet you, {}!", name.trim());
}
`;
  await setSource(page, program);
  const t1 = Date.now();
  await page.locator('#run').click();
  await expect.poll(() => terminalText(page)).toContain("What's your name?");
  const runMs = Date.now() - t1;
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  await page.locator('#terminal .xterm').click();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page)).toContain('Nice to meet you, Ada!');
  await expect(page.locator('#status')).toHaveText('Program exited');

  // Stop: a program that never ends.
  await setSource(page, 'fn main() {\n    let mut n: u64 = 0;\n    loop { n = n.wrapping_add(1); }\n}\n');
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Program stopped');
  await expect(page.locator('#stop')).toBeDisabled();

  // The source survives a reload.
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('wrapping_add');

  const r = { editorMs, readyMs, checkMs, runToPromptMs: runMs };
  console.log(JSON.stringify(r));
  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${date}-${commit}-app.json`, JSON.stringify({ date, commit, browser: 'chromium', cold: true, ...r }, null, 1) + '\n');
  expect(editorMs).toBeLessThan(EDITOR_BUDGET_MS);
  await context.close();
});

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

// Bench (not a done-check): memory of the IDE (app/) while working in it, in Chromium. Per step:
// PSS of all browser processes (shared pages counted once), the VFS and the compile server's rustc
// instance (orchestrator `stats`), and Chromium's own measureUserAgentSpecificMemory where it
// answers. Writes bench/results/<date>-<commit>-app-memory.json; summary in bench/app-memory.md.

// PSS of every process below this test worker: the browser and its renderers, GPU and utility processes.
function treePss(): number {
  const parent = new Map<number, number>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      parent.set(Number(d), Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* gone */ }
  }
  let total = 0;
  for (const pid of parent.keys()) {
    let p = parent.get(pid);
    while (p && p !== process.pid) p = parent.get(p);
    if (p !== process.pid) continue;
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) total += Number(m[1]) * 1024;
    } catch { /* gone */ }
  }
  return total;
}

async function sampled<T>(f: () => Promise<T>): Promise<[T, number]> {
  let peak = treePss();
  const t = setInterval(() => { peak = Math.max(peak, treePss()); }, 100);
  try { return [await f(), peak]; } finally { clearInterval(t); }
}

const MiB = (b: number) => Math.round(b / 2 ** 20);
const terminalText = (page: Page) => page.evaluate(() => {
  const b = (window as any).ide.term.xterm.buffer.active, lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  return lines.join('\n');
});
const setSource = (page: Page, text: string) => page.evaluate(t => {
  const v = (window as any).ide.view;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
}, text);

test('IDE memory while working', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium only');
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const steps: Record<string, unknown>[] = [];
  const record = async (name: string, peak?: number) => {
    await page.waitForTimeout(500); // let transient workers (lld, sandbox) go away
    const wasm = await page.evaluate(async () => {
      const ide = (window as any).ide;
      const s = await ide.orch?.call('stats', {}).catch(() => null);
      let ua: number | null = null;
      try { ua = (await (performance as any).measureUserAgentSpecificMemory()).bytes; } catch { /* not available */ }
      return { s, ua };
    });
    const row = {
      step: name, browserPssMiB: MiB(treePss()), peakPssMiB: peak ? MiB(peak) : undefined,
      vfsMiB: wasm.s ? MiB(wasm.s.vfsBytes) : undefined, rustcMiB: wasm.s ? MiB(wasm.s.rustcBytes) : undefined,
      uaMemoryMiB: wasm.ua !== null ? MiB(wasm.ua) : undefined,
    };
    steps.push(row);
    console.log(JSON.stringify(row));
  };

  await page.goto('/www/app/');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await record('editor only (toolchain loading)');
  const [, pLoad] = await sampled(() => page.evaluate(() => (window as any).ide.ready));
  await record('toolchain ready', pLoad);

  const hello = readFileSync('tests/smoke/hello.rs', 'utf8');
  await setSource(page, hello);
  let [, p] = await sampled(async () => { await page.locator('#check').click(); await expect(page.locator('#status')).toHaveText(/No errors/); });
  await record('check hello', p);
  [, p] = await sampled(async () => { await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Program exited', { timeout: 60_000 }); });
  await record('run hello (first link: lld + link sysroot)', p);

  // A program that waits for input: the sandbox stays alive.
  await setSource(page, 'fn main() { let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); println!("{s}"); }\n');
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled({ timeout: 60_000 });
  await record('program running (waiting for input)');
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Program stopped');

  const medium = readFileSync('bench/programs/medium.rs', 'utf8');
  await setSource(page, medium);
  [, p] = await sampled(async () => { await page.locator('#check').click(); await expect(page.locator('#status')).toHaveText(/No errors/, { timeout: 60_000 }); });
  await record('check medium (560 lines)', p);
  [, p] = await sampled(async () => { await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Program exited', { timeout: 60_000 }); });
  await record('run medium', p);

  // Working: 20 edit + check cycles, then 5 edit + run cycles.
  [, p] = await sampled(async () => {
    for (let i = 0; i < 20; i++) {
      await setSource(page, medium + `\n// edit ${i}\nfn extra_${i}() -> u32 { ${i} }\n`);
      await page.locator('#check').click();
      await expect(page.locator('#status')).toHaveText(/No errors/, { timeout: 60_000 });
    }
  });
  await record('after 20 edit + check cycles', p);
  [, p] = await sampled(async () => {
    for (let i = 0; i < 5; i++) {
      await setSource(page, medium + `\n// run ${i}\n`);
      await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText('Program exited', { timeout: 60_000 });
    }
  });
  await record('after 5 edit + run cycles', p);
  expect(await terminalText(page)).toContain('medium ok');

  const date = new Date().toISOString().slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${date}-${commit}-app-memory.json`, JSON.stringify({ date, commit, browser: 'chromium', steps }, null, 1) + '\n');
  await context.close();
});

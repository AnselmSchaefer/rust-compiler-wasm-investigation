// Started by tools/relay/relay.py (WP-38): Chromium on the IDE page, through Playwright, with a
// profile of its own so projects (OPFS), the build cache and the toolchain (Cache Storage)
// survive between runs. Headed to watch, or --headless. Background-tab throttling is off: the
// page does the work while nobody looks at it. Exits when the browser closes, on SIGTERM, or
// when its stdin (a pipe from the relay) closes.
//   node tools/relay/browser.mjs <url> [--profile DIR] [--headless]
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const url = argv[0];
const opt = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const headless = argv.includes('--headless');
const ctx = await chromium.launchPersistentContext(opt('--profile') ?? 'build/relay/profile', {
  headless, viewport: headless ? { width: 1400, height: 900 } : null,
  // Our own handlers below close the browser (after a screenshot, if asked).
  handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.error(`[page] ${m.text()}`); });
page.on('pageerror', e => console.error(`[page] ${e.message}`));
await page.goto(url);
console.error(`browser: ${headless ? 'headless' : 'headed'} Chromium on ${new URL(url).origin}`);
// RELAY_SCREENSHOT=<file.png>: how the page looked at the end (tests/relay/scenario.py --screenshot).
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (process.env.RELAY_SCREENSHOT) await page.screenshot({ path: process.env.RELAY_SCREENSHOT }).catch(e => console.error(`screenshot: ${e.message}`));
  await ctx.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// The relay holds our stdin: when it closes, the relay is gone, so we go too.
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
ctx.on('close', () => process.exit(0));

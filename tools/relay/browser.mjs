// Started by tools/relay/relay.py (WP-38): Chromium on the IDE page, through Playwright, with a
// profile of its own so projects (OPFS), the build cache and the toolchain (Cache Storage)
// survive between runs. Headed to watch, or --headless. Background-tab throttling is off: the
// page does the work while nobody looks at it. Exits when the browser closes, or on SIGTERM.
//   node tools/relay/browser.mjs <url> [--profile DIR] [--headless]
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const url = argv[0];
const opt = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const headless = argv.includes('--headless');
const ctx = await chromium.launchPersistentContext(opt('--profile') ?? 'build/relay/profile', {
  headless, viewport: headless ? { width: 1400, height: 900 } : null,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.error(`[page] ${m.text()}`); });
page.on('pageerror', e => console.error(`[page] ${e.message}`));
await page.goto(url);
console.error(`browser: ${headless ? 'headless' : 'headed'} Chromium on ${new URL(url).origin}`);
const stop = async () => { await ctx.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
ctx.on('close', () => process.exit(0));

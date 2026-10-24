import { test, expect } from '@playwright/test';

// WP-01: the oligamiq rust_wasm v3 rustc.wasm compiles and runs hello world in the browser.
// Needs `bash scripts/fetch-baseline.sh && node scripts/build-baseline.mjs` first (scripts/verify/wp-01.sh does both).
for (const rustc of ['rustc_opt.wasm', 'rustc_unwind_opt.wasm']) {
  test(`baseline ${rustc} compiles and runs hello world`, async ({ page }, info) => {
    test.setTimeout(300_000);
    page.on('console', m => { if (m.type() === 'error') console.log(`[${info.project.name} console] ${m.text()}`); });
    await page.goto('/www/baseline/index.html');
    await page.waitForFunction(() => (window as any).harnessReady);
    const r = await page.evaluate(async rustc => {
      const h = (window as any).harness;
      const load = await h.load(rustc);
      h.writeFile('/hello.rs', 'fn main() { println!("Hello from the browser"); }\n');
      const build = await h.rustc(['/hello.rs', '--sysroot', '/sysroot', '--target', 'wasm32-wasip1', '-o', '/hello.wasm']);
      const run = build.code === 0 ? await h.run('/hello.wasm') : undefined;
      return { load, build, run };
    }, rustc);
    console.log(info.project.name, rustc, JSON.stringify({ load: r.load, rustcMs: r.build.ms, code: r.build.code, error: r.build.error, run: r.run }));
    if (r.build.code !== 0) console.log(r.build.stderr);
    expect(r.build.code).toBe(0);
    expect(r.run?.stdout).toContain('Hello');
  });
}

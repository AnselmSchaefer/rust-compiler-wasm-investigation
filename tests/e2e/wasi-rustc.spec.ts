import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// WP-11: the baseline rustc.wasm compiles and links on our VFS + WASI adapter (no browser_wasi_shim):
// a type check, a build with in-process linking, a library (metadata rename), and a compile error.
// Needs the baseline toolchain (scripts/fetch-baseline.sh) and the web test build (scripts/verify/wp-11.sh).
test('rustc.wasm on the shared VFS', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/wasi-rustc/index.html');
  await page.waitForFunction(() => (window as any).rustcVfsReady);
  const programs = {
    hello: readFileSync('bench/programs/hello.rs', 'utf8'),
    medium: readFileSync('bench/programs/medium.rs', 'utf8'),
  };
  const r = await page.evaluate(async programs => {
    const h = (window as any).rustcVfs;
    const load = await h.load();
    for (const [k, v] of Object.entries(programs)) h.writeFile(`/work/${k}.rs`, v);
    h.writeFile('/work/bad.rs', 'fn main() { let x: u32 = "a"; }\n');
    const c = ['--sysroot', '/sysroot', '--target', 'wasm32-wasip1', '--edition', '2021'];
    const steps: Record<string, any> = {};
    const time = async (name: string, args: string[], n = 3) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = await h.rustc(args);
        if (r.code !== 0) return (steps[name] = { code: r.code, error: r.error, stderr: r.stderr.slice(0, 2000) });
        ms.push(r.ms);
        steps[name] = { code: 0, ms, threads: r.threads, memMiB: Math.round(r.memBytes / 2 ** 20) };
      }
    };
    await time('version', ['-V']);
    await time('check-hello', ['/work/hello.rs', ...c, '--emit=metadata', '-o', '/work/hello.rmeta']);
    await time('build-hello', ['/work/hello.rs', ...c, '-o', '/work/hello.wasm']);
    await time('lib-hello', ['/work/hello.rs', ...c, '--crate-type', 'lib', '-o', '/work/libhello.rlib'], 1);
    await time('build-medium', ['/work/medium.rs', ...c, '-o', '/work/medium.wasm']);
    const bad = await h.rustc(['/work/bad.rs', ...c, '-o', '/work/bad.wasm']);
    const runHello = await h.run('/work/hello.wasm');
    const runMedium = await h.run('/work/medium.wasm');
    // Symlinks through WASI: what rustc's sysroot detection from argv[0] relies on (findings doc B1).
    h.symlink('/work/hello.rs', '/sysroot/bin/rustc');
    h.writeFile('/work/links.rs', [
      'fn main() {',
      '    let p = "/sysroot/bin/rustc";',
      '    println!("target={}", std::fs::read_link(p).unwrap().display());',
      '    println!("is_symlink={}", std::fs::symlink_metadata(p).unwrap().file_type().is_symlink());',
      '    println!("follows={}", std::fs::metadata(p).unwrap().is_file());',
      '    println!("rustlib={}", std::path::Path::new("/sysroot/bin/../lib/rustlib").exists());',
      '}',
    ].join('\n'));
    const linksBuild = await h.rustc(['/work/links.rs', ...c, '-o', '/work/links.wasm']);
    const links = linksBuild.code === 0 ? (await h.run('/work/links.wasm')).stdout : linksBuild.stderr;
    return { load, steps, bad: { code: bad.code, stderr: bad.stderr.slice(0, 300) }, runHello, runMedium: runMedium.stdout.slice(-11), links, work: h.ls('/work') };
  }, programs);
  console.log(JSON.stringify(r, null, 1));
  for (const s of ['version', 'check-hello', 'build-hello', 'lib-hello', 'build-medium']) expect(r.steps[s]?.code, s).toBe(0);
  expect(r.runHello.stdout).toContain('Hello from Wasm');
  expect(r.runMedium.endsWith('medium ok\n')).toBe(true);
  expect(r.links).toBe('target=/work/hello.rs\nis_symlink=true\nfollows=true\nrustlib=true\n');
  expect(r.bad.stderr).toContain('mismatched types');
  expect(r.bad.code).not.toBe(0); // the abort build traps after the diagnostics (WP-01 finding #1)
});

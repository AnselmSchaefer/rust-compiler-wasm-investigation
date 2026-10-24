import { test, expect } from '@playwright/test';
import { readdirSync, statSync } from 'node:fs';

// WP-13: programs compiled by the orchestrator (our toolchain release) run in the sandbox
// (web/sandbox): one reads stdin, args, env and a file and writes a file back; one panics; one
// loops until the timeout kills it; one is driven interactively, line by line. scripts/verify/wp-13.sh.
const release = readdirSync('build/release').filter(d => statSync(`build/release/${d}`).isDirectory())
  .sort((a, b) => statSync(`build/release/${b}`).mtimeMs - statSync(`build/release/${a}`).mtimeMs)[0];

const programs = {
  io: `use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let greeting = std::env::var("GREETING").unwrap_or_default();
    let data = std::fs::read_to_string("/data/in.txt").unwrap();
    println!("{greeting} args={args:?} lines={} file={}", input.lines().count(), data.trim());
    for l in input.lines() { println!("> {}", l.to_uppercase()); }
    std::fs::write("/data/out.txt", format!("{} bytes of stdin\\n", input.len())).unwrap();
    std::process::exit(3);
}`,
  panic: `fn main() {
    let v: Vec<u32> = Vec::new();
    eprintln!("about to panic");
    let _ = v[7];
}`,
  spin: `fn main() {
    let mut x: u64 = 0;
    loop { x = x.wrapping_mul(6364136223846793005).wrapping_add(1); if x == 42 { println!("{x}"); } }
}`,
  repl: `use std::io::BufRead;
fn main() {
    let mut sum = 0i64;
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "quit" { break; }
        sum += line.trim().parse::<i64>().unwrap_or(0);
        println!("sum={sum}");
    }
    println!("bye");
}`,
};

test('run sandbox: stdin, files, panic, timeout, interactive', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium is the target (Firefox best-effort)');
  test.setTimeout(300_000);
  page.on('console', m => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  await page.goto('/www/orchestrator/index.html');
  await page.waitForFunction(() => (window as any).orchReady);
  const r = await page.evaluate(async ({ programs, release }) => {
    const w = window as any, o = w.orch, here = (f: string) => new URL(f, location.href).href;
    await o.call('init', { releaseUrl: here(`/release/${release}/`), vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js') });
    const bins: Record<string, Uint8Array> = {};
    for (const [name, src] of Object.entries(programs)) {
      await o.call('writeFile', { path: `/work/${name}.rs`, data: src as string });
      const b = await o.call('rustc', { args: [`/work/${name}.rs`, '--target', 'wasm32-wasip1', '--edition', '2021', '-o', `/work/${name}.wasm`] });
      if (b.code !== 0) return { error: name, stderr: b.stderr };
      bins[name] = await o.call('readFile', { path: `/work/${name}.wasm` });
    }
    const dec = new TextDecoder();
    const io = await w.sandbox({
      program: bins.io, args: ['io', 'a', 'b c'], env: ['GREETING=hi'], stdin: 'one\ntwo\nthree\n',
      files: { '/data/in.txt': 'payload\n' }, collect: ['/data/out.txt'],
    }).result;
    const panic = await w.sandbox({ program: bins.panic }).result;
    const t0 = performance.now();
    const spin = await w.sandbox({ program: bins.spin, timeoutMs: 1000 }).result;
    const spinMs = Math.round(performance.now() - t0);
    // Interactive: type a line, wait for its answer, then the next.
    const chunks: string[] = [];
    let seen = 0;
    const repl = w.sandbox({ program: bins.repl, interactive: true, onStdout: (c: Uint8Array) => chunks.push(dec.decode(c)) });
    const waitFor = async (n: number) => { while ((chunks.join('').match(/\n/g) ?? []).length < n) await new Promise(r => setTimeout(r, 5)); };
    for (const line of ['5', '10', '-3']) { repl.write(line + '\n'); await waitFor(++seen); }
    repl.write('quit\n');
    const replDone = await repl.result;
    // Killing a program that waits for input.
    const waiting = w.sandbox({ program: bins.repl, interactive: true });
    setTimeout(() => waiting.kill(), 200);
    const killed = await waiting.result;
    return {
      io: { ...io, files: Object.fromEntries(Object.entries(io.files).map(([k, v]) => [k, dec.decode(v as Uint8Array)])) },
      panic, spin, spinMs, repl: { code: replDone.code, stdout: replDone.stdout, chunks: chunks.length }, killed,
    };
  }, { programs, release });
  console.log(JSON.stringify(r, null, 1));
  expect((r as any).error, (r as any).stderr).toBeUndefined();

  expect(r.io.code).toBe(3);
  expect(r.io.stdout).toBe('hi args=["a", "b c"] lines=3 file=payload\n> ONE\n> TWO\n> THREE\n');
  expect(r.io.files['/data/out.txt']).toBe('14 bytes of stdin\n');

  expect(r.panic.code).toBe(134);
  expect(r.panic.killed).toBe(false);
  expect(r.panic.stderr).toContain('about to panic');
  expect(r.panic.stderr).toContain('index out of bounds');
  expect(r.panic.trap).toContain('unreachable');

  expect(r.spin).toMatchObject({ code: null, killed: true, timedOut: true });
  expect(r.spinMs).toBeGreaterThanOrEqual(1000);
  expect(r.spinMs).toBeLessThan(5000);

  expect(r.repl.code).toBe(0);
  expect(r.repl.stdout).toBe('sum=5\nsum=15\nsum=12\nbye\n');
  expect(r.repl.chunks).toBeGreaterThanOrEqual(3); // streamed, not all at the end

  expect(r.killed).toMatchObject({ code: null, killed: true, timedOut: false });
});

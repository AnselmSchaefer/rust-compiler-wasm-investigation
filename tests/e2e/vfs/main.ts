// WP-11 e2e page: two workers share one VFS, a third persists it to OPFS.
// `window.vfsTest.write()` populates it; after a reload, `window.vfsTest.verify()` checks the restore.
import { createVfs, Vfs } from '../../../web/vfs/vfs';
import { clearOpfs } from '../../../web/vfs/persist';

type W = { call: (op: string, ...args: unknown[]) => Promise<any> };

function spawn(): W {
  const w = new Worker('worker.js', { type: 'module' });
  let next = 0;
  const pending = new Map<number, [(v: any) => void, (e: Error) => void]>();
  w.onmessage = e => {
    const [res, rej] = pending.get(e.data.id)!;
    pending.delete(e.data.id);
    e.data.error ? rej(new Error(e.data.error)) : res(e.data.result);
  };
  return { call: (op, ...args) => new Promise((res, rej) => { pending.set(++next, [res, rej]); w.postMessage({ id: next, op, args }); }) };
}

async function setup() {
  const handle = await createVfs('vfs.wasm');
  const [a, b, p] = [spawn(), spawn(), spawn()];
  await Promise.all([a, b, p].map(w => w.call('attach', handle)));
  const page = await Vfs.attach(handle); // the page thread too (it spins instead of blocking)
  return { a, b, p, page };
}

const N = 300;

async function write() {
  await clearOpfs();
  const { a, b, p, page } = await setup();
  const r: Record<string, unknown> = {};
  r.restoredBefore = await p.call('persist', '/project');

  // Each worker sees the other's writes immediately.
  await a.call('writeFile', '/project/src/main.rs', 'fn main() {}\n');
  r.bSeesA = await b.call('readText', '/project/src/main.rs');
  await b.call('writeFile', '/project/notes.txt', 'from B');
  r.aSeesB = await a.call('readText', '/project/notes.txt');
  r.pageSees = page.readText('/project/notes.txt');

  // Concurrent writers.
  const t = performance.now();
  await Promise.all([a.call('writeMany', '/project/a', N), b.call('writeMany', '/project/b', N)]);
  r.concurrentWriteMs = Math.round(performance.now() - t);
  r.mismatches = (await a.call('readMany', '/project/b', N)) + (await b.call('readMany', '/project/a', N));

  // Rename and delete, seen across workers.
  await a.call('rename', '/project/src/main.rs', '/project/src/lib.rs');
  r.bSeesRename = [await b.call('exists', '/project/src/main.rs'), await b.call('readText', '/project/src/lib.rs')];
  await b.call('writeFile', '/project/gone.txt', 'x');
  await a.call('unlink', '/project/gone.txt');

  // Large file outside the persisted tree: write in A, read in B (one copy into B's memory).
  r.bigWriteMs = Math.round(await a.call('bigWrite', '/tmp-big.bin', 64));
  const [readMs, sum, size] = await b.call('bigRead', '/tmp-big.bin');
  r.bigRead = { ms: Math.round(readMs), sum, size };

  r.flush = await p.call('flush');

  // Without an explicit flush, the persister picks up changes by itself (waits on the change counter).
  await b.call('writeFile', '/project/late.txt', 'auto-flushed');
  await new Promise(res => setTimeout(res, 500));
  r.autoFlushed = (await p.call('stats')).written - (r.flush as any).written;
  r.inodes = await a.call('inodeCount');
  return r;
}

async function verify() {
  const { a, b, p } = await setup();
  const r: Record<string, unknown> = {};
  r.restored = await p.call('persist', '/project');
  r.lib = await a.call('readText', '/project/src/lib.rs');
  r.mainGone = !(await a.call('exists', '/project/src/main.rs'));
  r.goneGone = !(await b.call('exists', '/project/gone.txt'));
  r.notes = await b.call('readText', '/project/notes.txt');
  r.late = await a.call('readText', '/project/late.txt');
  r.mismatches = (await a.call('readMany', '/project/b', N)) + (await b.call('readMany', '/project/a', N));
  r.bigNotPersisted = !(await a.call('exists', '/tmp-big.bin'));
  return r;
}

(window as any).vfsTest = { write, verify };
(window as any).vfsReady = true;

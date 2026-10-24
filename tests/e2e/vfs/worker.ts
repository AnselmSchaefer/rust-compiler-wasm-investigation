// Test worker for the shared VFS (WP-11): attaches to the shared memory and runs named operations.
import { Vfs, type VfsHandle } from '../../../web/vfs/vfs';
import { Persister } from '../../../web/vfs/persist';

let vfs: Vfs;
let persister: Persister | undefined;

const ops: Record<string, (...a: any[]) => unknown> = {
  async attach(h: VfsHandle) { vfs = await Vfs.attach(h); },
  writeFile: (p: string, text: string) => vfs.writeFile(p, text),
  readText: (p: string) => vfs.readText(p),
  exists: (p: string) => vfs.exists(p),
  rename: (a: string, b: string) => vfs.rename(a, b),
  unlink: (p: string) => vfs.unlink(p),
  readdir: (p: string) => vfs.readdir(p).map(e => e.name),
  /** Write n small files whose content is their own path. */
  writeMany(dir: string, n: number) {
    for (let i = 0; i < n; i++) vfs.writeFile(`${dir}/f${i}`, `${dir}/f${i}`);
  },
  /** Check n files written by writeMany (possibly by another worker); returns mismatches. */
  readMany(dir: string, n: number) {
    let bad = 0;
    for (let i = 0; i < n; i++) if (vfs.readText(`${dir}/f${i}`) !== `${dir}/f${i}`) bad++;
    return bad;
  },
  /** Write `mb` MiB in 1 MiB chunks; returns ms. */
  bigWrite(p: string, mb: number) {
    const chunk = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
    const t = performance.now();
    vfs.locked(() => {
      const ino = vfs.rawCreate(0, p, false, true);
      for (let i = 0; i < mb; i++) vfs.rawWrite(ino, i << 20, chunk);
    });
    return performance.now() - t;
  },
  /** Read the whole file into this worker's own memory with one copy; returns [ms, checksum]. */
  bigRead(p: string) {
    const t = performance.now();
    const size = vfs.stat(p).size, dst = new Uint8Array(size);
    vfs.locked(() => vfs.rawRead(vfs.rawLookup(0, p), 0, dst));
    let sum = 0;
    for (let i = 7; i < dst.length; i += 4096) sum = (sum + dst[i]) | 0;
    return [performance.now() - t, sum, size];
  },
  async persist(path: string) {
    const r = await Persister.start(vfs, path);
    persister = r.persister;
    return r.restored;
  },
  async flush() {
    await persister!.flush();
    return persister!.stats;
  },
  stats: () => ({ ...persister!.stats }),
  inodeCount: () => vfs.inodeCount(),
};

onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data;
  try {
    postMessage({ id, result: await ops[op](...args) });
  } catch (err: any) {
    postMessage({ id, error: String(err?.stack ?? err) });
  }
};

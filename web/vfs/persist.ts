// OPFS persistence for the shared VFS (WP-11). Runs in one dedicated worker (sync access handles
// are worker-only). On start it restores a persisted subtree from OPFS into the VFS. After that it
// mirrors every change the VFS reports (see Fs::take_changes) back to OPFS, shortly after it happens.
//
// Layout: VFS path /project/src/main.rs  ↔  OPFS <root>/project/src/main.rs  (root: "vfs").

import { Kind, type Vfs } from './vfs';

type Dir = FileSystemDirectoryHandle;

async function opfsRoot(name: string): Promise<Dir> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

/** Walk to the directory holding `path`'s last component, optionally creating directories. */
async function parentDir(root: Dir, path: string, create: boolean): Promise<[Dir, string] | null> {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const p of parts.slice(0, -1)) {
    try {
      dir = await dir.getDirectoryHandle(p, { create });
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return null;
      throw e;
    }
  }
  return [dir, parts.at(-1)!];
}

async function writeOpfsFile(dir: Dir, name: string, bytes: Uint8Array) {
  const file = await dir.getFileHandle(name, { create: true });
  const h = await (file as any).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

export class Persister {
  private seen = 0;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Stats for tests and benchmarks. */
  readonly stats = { flushes: 0, written: 0, removed: 0, bytes: 0 };

  private constructor(private readonly vfs: Vfs, private readonly root: Dir) {}

  /**
   * Restore `vfsPath` (e.g. "/project") from OPFS into the VFS, mark it persisted and start
   * mirroring changes. Returns the number of files restored.
   */
  static async start(vfs: Vfs, vfsPath: string, opfsName = 'vfs'): Promise<{ persister: Persister; restored: number }> {
    const root = await opfsRoot(opfsName);
    const p = new Persister(vfs, root);
    vfs.mkdirAll(vfsPath);
    const restored = await p.restore(vfsPath);
    vfs.setPersist(vfsPath);
    vfs.takeChanges(); // everything just restored is already in OPFS
    p.seen = Atomics.load(vfs.sharedI32, vfs.changeSeqIndex);
    p.loop();
    return { persister: p, restored };
  }

  private async restore(vfsPath: string): Promise<number> {
    const start = await parentDir(this.root, vfsPath + '/x', false);
    if (!start) return 0;
    let count = 0;
    const walk = async (dir: Dir, path: string) => {
      for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        const child = `${path}/${name}`;
        if (handle.kind === 'directory') {
          this.vfs.mkdirAll(child);
          await walk(handle as Dir, child);
        } else {
          const h = await (handle as FileSystemFileHandle as any).createSyncAccessHandle();
          try {
            const buf = new Uint8Array(h.getSize());
            h.read(buf, { at: 0 });
            this.vfs.writeFile(child, buf);
          } finally {
            h.close();
          }
          count++;
        }
      }
    };
    await walk(start[0], vfsPath);
    return count;
  }

  /** Wait for VFS changes, debounce briefly, write them out; forever. */
  private async loop() {
    const i32 = this.vfs.sharedI32, idx = this.vfs.changeSeqIndex;
    while (!this.stopped) {
      const w = Atomics.waitAsync(i32, idx, this.seen);
      if (w.async) await w.value;
      await new Promise(r => setTimeout(r, 20)); // let a burst of writes settle
      this.seen = Atomics.load(this.vfs.sharedI32, idx);
      await this.flush();
    }
  }

  /** Write out pending changes now. Concurrent calls are serialized. */
  flush(): Promise<void> {
    this.running = this.running.then(() => this.apply());
    return this.running;
  }

  private async apply() {
    const { removed, dirty } = this.vfs.takeChanges();
    if (!removed.length && !dirty.length) return;
    this.stats.flushes++;
    // Removals first, so "remove then recreate" within one batch ends with the new file.
    for (const path of removed) {
      const pd = await parentDir(this.root, path, false);
      if (!pd) continue;
      try {
        await pd[0].removeEntry(pd[1], { recursive: true });
        this.stats.removed++;
      } catch (e) {
        if ((e as DOMException).name !== 'NotFoundError') throw e;
      }
    }
    // Parents come before children (sorted by path).
    for (const { path, kind } of dirty) {
      const pd = await parentDir(this.root, path, true);
      if (!pd) continue;
      if (kind === Kind.Dir) {
        await pd[0].getDirectoryHandle(pd[1], { create: true });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = this.vfs.readFile(path);
      } catch {
        continue; // removed again since take_changes; its removal is in the next batch
      }
      await writeOpfsFile(pd[0], pd[1], bytes);
      this.stats.written++;
      this.stats.bytes += bytes.length;
    }
  }

  stop() {
    this.stopped = true;
  }
}

/** Delete everything persisted under `opfsName` (tests, "reset project"). */
export async function clearOpfs(opfsName = 'vfs') {
  const top = await navigator.storage.getDirectory();
  try {
    await top.removeEntry(opfsName, { recursive: true });
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}

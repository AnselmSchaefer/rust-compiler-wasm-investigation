// A small file cache in OPFS (WP-16): index files and .crate files, so a second load works
// offline. Keys are slash-separated paths below one OPFS directory. WP-18's build cache uses it too.

/** What the caches need of a store; tools/prebuild has one on disk. */
export interface ByteStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
}

// WP-22: a store has a byte budget (default: half the origin's quota, at most 2 GiB) and evicts
// the least recently used files to stay under it. Writes never throw: a cache that can't store
// (quota exceeded even after evicting) just misses later. Sizes and access times are kept in
// `.lru.json` at the store's root, rebuilt from the files if it's missing.

const INDEX = '.lru.json';
const MAX_BUDGET = 2 ** 31;

export class FileCache implements ByteStore {
  readonly stats = { evicted: 0, evictedBytes: 0, dropped: 0 };
  private lru = new Map<string, { size: number; atime: number }>();
  private bytes = 0;
  private dirty = false;
  private saving: Promise<void> | null = null;

  private constructor(private readonly root: FileSystemDirectoryHandle | null, readonly budget: number) {}

  /** `name`: the OPFS directory. Without OPFS (e.g. a private window) everything misses. */
  static async open(name = 'deps-cache', opts: { budget?: number } = {}): Promise<FileCache> {
    try {
      const opfs = await navigator.storage.getDirectory();
      const quota = (await navigator.storage.estimate().catch(() => ({ quota: undefined }))).quota;
      const budget = opts.budget ?? Math.min(MAX_BUDGET, quota ? Math.floor(quota / 2) : MAX_BUDGET);
      const c = new FileCache(await opfs.getDirectoryHandle(name, { create: true }), budget);
      await c.load();
      return c;
    } catch {
      return new FileCache(null, 0);
    }
  }

  /** Bytes stored now. */
  get size() { return this.bytes; }

  private async load() {
    const raw = await this.readRaw(INDEX);
    if (raw) {
      try {
        for (const [p, e] of Object.entries(JSON.parse(new TextDecoder().decode(raw)) as Record<string, { size: number; atime: number }>)) this.lru.set(p, e);
      } catch { this.lru.clear(); }
    }
    if (!raw || !this.lru.size) await this.scan(this.root!, '');
    for (const e of this.lru.values()) this.bytes += e.size;
  }

  /** The index from the files themselves (first use, or a lost index). */
  private async scan(d: FileSystemDirectoryHandle, rel: string) {
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const p = rel ? `${rel}/${name}` : name;
      if (h.kind === 'directory') await this.scan(h as FileSystemDirectoryHandle, p);
      else if (p !== INDEX) {
        const f = await (h as FileSystemFileHandle).getFile();
        this.lru.set(p, { size: f.size, atime: f.lastModified });
      }
    }
    this.dirty = true;
  }

  private async dir(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string] | null> {
    if (!this.root) return null;
    const parts = path.split('/');
    let d = this.root;
    try {
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
    } catch {
      return null;
    }
    return [d, parts.at(-1)!];
  }

  private async readRaw(path: string): Promise<Uint8Array | null> {
    const at = await this.dir(path, false);
    if (!at) return null;
    try {
      const f = await (await at[0].getFileHandle(at[1])).getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<Uint8Array | null> {
    const d = await this.readRaw(path);
    const e = this.lru.get(path);
    if (d && e) { e.atime = Date.now(); this.dirty = true; }
    return d;
  }

  private async writeRaw(path: string, data: Uint8Array) {
    const at = await this.dir(path, true);
    if (!at) return;
    const w = await (await at[0].getFileHandle(at[1], { create: true })).createWritable();
    try {
      await w.write(data as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (!this.root || data.length > this.budget) return;
    const old = this.lru.get(path)?.size ?? 0;
    await this.evict(this.bytes - old + data.length - this.budget, path);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.writeRaw(path, data);
        break;
      } catch (e) {
        // The origin's quota is shared (toolchain, other caches): make room once, then give up.
        if (attempt === 0 && (e as DOMException)?.name === 'QuotaExceededError') {
          await this.evict(Math.max(data.length, Math.floor(this.bytes / 4)), path);
          continue;
        }
        this.stats.dropped++;
        return;
      }
    }
    this.bytes += data.length - (this.lru.get(path)?.size ?? 0);
    this.lru.set(path, { size: data.length, atime: Date.now() });
    this.dirty = true;
    this.saveSoon();
  }

  /** Removes least recently used files until `need` bytes are free (`keep` stays). */
  private async evict(need: number, keep: string) {
    if (need <= 0) return;
    const order = [...this.lru].filter(([p]) => p !== keep).sort((a, b) => a[1].atime - b[1].atime);
    let freed = 0;
    for (const [p, e] of order) {
      if (freed >= need) break;
      const at = await this.dir(p, false);
      try { if (at) await at[0].removeEntry(at[1]); } catch { /* already gone */ }
      this.lru.delete(p);
      this.bytes -= e.size;
      freed += e.size;
      this.stats.evicted++;
      this.stats.evictedBytes += e.size;
    }
    this.dirty = true;
  }

  private saveSoon() {
    this.saving ??= new Promise<void>(r => setTimeout(r, 500)).then(() => this.flush()).finally(() => { this.saving = null; });
  }

  /** Writes the LRU index (also done shortly after each write). */
  async flush() {
    if (!this.root || !this.dirty) return;
    this.dirty = false;
    try { await this.writeRaw(INDEX, new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.lru)))); } catch { this.dirty = true; }
  }

  static async clear(name = 'deps-cache') {
    try { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }); } catch { /* not there */ }
  }
}

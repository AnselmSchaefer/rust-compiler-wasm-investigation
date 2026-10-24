// A small file cache in OPFS (WP-16): index files and .crate files, so a second load works
// offline. Keys are slash-separated paths below one OPFS directory.

export class FileCache {
  private constructor(private readonly root: FileSystemDirectoryHandle | null) {}

  /** `name`: the OPFS directory. Without OPFS (e.g. a private window) everything misses. */
  static async open(name = 'deps-cache'): Promise<FileCache> {
    try {
      const opfs = await navigator.storage.getDirectory();
      return new FileCache(await opfs.getDirectoryHandle(name, { create: true }));
    } catch {
      return new FileCache(null);
    }
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

  async read(path: string): Promise<Uint8Array | null> {
    const at = await this.dir(path, false);
    if (!at) return null;
    try {
      const f = await (await at[0].getFileHandle(at[1])).getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const at = await this.dir(path, true);
    if (!at) return;
    const w = await (await at[0].getFileHandle(at[1], { create: true })).createWritable();
    await w.write(data as Uint8Array<ArrayBuffer>);
    await w.close();
  }

  static async clear(name = 'deps-cache') {
    try { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }); } catch { /* not there */ }
  }
}

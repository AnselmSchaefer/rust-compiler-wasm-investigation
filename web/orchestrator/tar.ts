// Tar reader: the ustar archives toolchain/release.sh writes (sysroot groups) and the GNU/pax
// archives `cargo package` writes (.crate files, WP-16). Regular files only; directories and
// links are skipped (cargo packages what symlinks point to, not the links).

export interface TarEntry { path: string; data: Uint8Array }

const dec = new TextDecoder();
const field = (b: Uint8Array, at: number, len: number) => {
  const s = b.subarray(at, at + len), z = s.indexOf(0);
  return dec.decode(z < 0 ? s : s.subarray(0, z));
};

/** The `path` record of a pax extended header ("<len> path=<value>\n" records). */
function paxPath(data: Uint8Array): string | null {
  const text = dec.decode(data);
  for (let o = 0; o < text.length;) {
    const sp = text.indexOf(' ', o), len = parseInt(text.slice(o, sp), 10);
    if (!(len > 0)) break;
    const rec = text.slice(sp + 1, o + len - 1);
    if (rec.startsWith('path=')) return rec.slice(5);
    o += len;
  }
  return null;
}

/** The files in `tar`, as views into it (no copies). */
export function* readTar(tar: Uint8Array): Generator<TarEntry> {
  let longName: string | null = null;
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every(b => b === 0)) return; // end-of-archive blocks
    const name = field(h, 0, 100);
    // ustar keeps a path prefix at 345; GNU headers use those bytes for other things.
    const ustar = field(h, 257, 6) === 'ustar' && h[262] === 0;
    const prefix = ustar ? field(h, 345, 155) : '';
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    o += 512;
    const data = tar.subarray(o, o + size);
    o += Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = field(data, 0, data.length); continue; } // GNU long name of the next entry
    if (type === 'x') { longName = paxPath(data) ?? longName; continue; }
    if (type === 'g' || type === 'K') continue; // pax global header, GNU long link name
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === '0' || type === '7') yield { path, data };
    else if (!'125'.includes(type)) throw new Error(`tar: unsupported entry type '${type}' for ${path}`);
  }
}

// Reader for the ustar archives toolchain/release.sh writes (sysroot groups): regular files only.

export interface TarEntry { path: string; data: Uint8Array }

const dec = new TextDecoder();
const field = (b: Uint8Array, at: number, len: number) => {
  const s = b.subarray(at, at + len), z = s.indexOf(0);
  return dec.decode(z < 0 ? s : s.subarray(0, z));
};

/** The files in `tar`, as views into it (no copies). */
export function* readTar(tar: Uint8Array): Generator<TarEntry> {
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every(b => b === 0)) return; // end-of-archive blocks
    const name = field(h, 0, 100), prefix = field(h, 345, 155);
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    o += 512;
    if (type === '0') yield { path: prefix ? `${prefix}/${name}` : name, data: tar.subarray(o, o + size) };
    else if (type !== '5') throw new Error(`tar: unsupported entry type '${type}' for ${name}`);
    o += Math.ceil(size / 512) * 512;
  }
}

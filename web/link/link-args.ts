// Linking outside rustc (WP-06). rustc.wasm cannot spawn a linker, so it is run with
// `--print link-args=FILE`: it writes the linker command it would have run, then fails to spawn
// it. The host turns that command into an argv for wasm-ld.wasm and runs it on the same
// filesystem. No browser or Node APIs here, so the orchestrator (WP-12) can use it as is.

export interface LinkCommand {
  env: Record<string, string>;
  program: string;
  args: string[];
}

// Reads one Rust `{:?}` string literal starting at s[i] == '"'. Returns the value and the index
// after the closing quote. Handles the escapes std's Debug for str/OsStr emits.
function readQuoted(s: string, i: number): [string, number] {
  let out = '';
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return [out, i + 1];
    if (c !== '\\') { out += c; continue; }
    const e = s[++i];
    switch (e) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case '0': out += '\0'; break;
      case '\\': case '"': case "'": out += e; break;
      case 'u': {
        const end = s.indexOf('}', i);
        out += String.fromCodePoint(parseInt(s.slice(i + 2, end), 16));
        i = end;
        break;
      }
      // Invalid UTF-8 in an OsStr. Paths in our VFS are UTF-8, so this would be a bug elsewhere.
      case 'x': throw new Error(`link command has a non-UTF-8 byte: \\x${s.slice(i + 1, i + 3)}`);
      default: throw new Error(`unknown escape \\${e} in link command`);
    }
  }
  throw new Error('unterminated string in link command');
}

// Parses std's Debug output for a Command, as written by `--print link-args`:
//   KEY="value" ... "program" "arg" ...
export function parseLinkCommand(text: string): LinkCommand {
  const s = text.trim();
  const env: Record<string, string> = {};
  const words: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    if (s[i] === '"') {
      const [w, j] = readQuoted(s, i);
      words.push(w);
      i = j;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="/.exec(s.slice(i));
    if (!m || words.length) throw new Error(`unexpected text in link command at ${i}: ${s.slice(i, i + 40)}`);
    const [v, j] = readQuoted(s, i + m[1].length + 1);
    env[m[1]] = v;
    i = j;
  }
  if (!words.length) throw new Error('empty link command');
  return { env, program: words[0], args: words.slice(1) };
}

// The argv (without argv[0]) for wasm-ld.wasm. rustc's wasm targets call `rust-lld -flavor wasm`
// (or, with -Clinker-flavor=wasm-lld, `wasm-ld` directly); wasm-ld.wasm is lld run as wasm-ld.
export function wasmLdArgs(cmd: LinkCommand): string[] {
  const base = cmd.program.split('/').pop()!;
  if (base !== 'rust-lld' && base !== 'wasm-ld' && base !== 'lld')
    throw new Error(`linker '${cmd.program}' is not lld; only the wasm-lld flavor is supported`);
  const a = cmd.args;
  if (a[0] === '-flavor') {
    if (a[1] !== 'wasm') throw new Error(`lld flavor '${a[1]}' is not wasm`);
    return a.slice(2);
  }
  return a.slice();
}

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

/** Where a host's rustc invocation writes, and where the results then go (see rewriteOutputs). */
export interface OutputPlan {
  /** rustc's arguments, with -o/--out-dir pointing into the scratch dir and link-args printed. */
  args: string[];
  /** The user's -o, if any (relative to the user's working directory). */
  oPath?: string;
  /** Where outputs go without -o: the user's --out-dir, or ".". */
  outDir: string;
  /** -C save-temps: keep rustc's intermediate objects too. */
  saveTemps: boolean;
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Point rustc's outputs at `scratch` (a directory only this invocation uses) and have it print
 * its link command to `linkArgsFile`. rustc's temp dirs and objects then never reach the user's
 * output dir, even when rustc stops at the link step. Handles -o and --out-dir; `--emit kind=path`
 * is not rewritten.
 */
export function rewriteOutputs(user: string[], scratch: string, linkArgsFile: string): OutputPlan {
  const args: string[] = [];
  let oPath: string | undefined, outDir = '.';
  for (let i = 0; i < user.length; i++) {
    const a = user[i];
    if (a === '-o') { oPath = user[++i]; args.push('-o', `${scratch}/${base(oPath)}`); }
    else if (a.startsWith('-o') && a.length > 2) { oPath = a.slice(2); args.push('-o', `${scratch}/${base(oPath)}`); }
    else if (a === '--out-dir') outDir = user[++i];
    else if (a.startsWith('--out-dir=')) outDir = a.slice(10);
    else args.push(a);
  }
  if (!oPath) args.push('--out-dir', scratch);
  args.push('--print', `link-args=${linkArgsFile}`);
  const saveTemps = user.some((a, i) => a.startsWith('-Csave-temps') || (a === '-C' && user[i + 1]?.startsWith('save-temps')));
  return { args, oPath, outDir, saveTemps };
}

/**
 * Where a file that rustc (and the linker) left in the scratch dir goes, or null to drop it:
 * rustc's intermediate objects, unless -C save-temps.
 */
export function outputDestination(plan: OutputPlan, name: string): string | null {
  if (!plan.saveTemps && name.endsWith('.rcgu.o')) return null;
  if (plan.oPath && name === base(plan.oPath)) return plan.oPath;
  const dir = plan.oPath ? (plan.oPath.includes('/') ? plan.oPath.slice(0, plan.oPath.lastIndexOf('/')) : '.') : plan.outDir;
  return `${dir}/${name}`;
}

/** A path as rustc saw it, made absolute against its working directory. */
export function absolute(p: string, cwd = '/'): string {
  if (p.startsWith('/')) return p;
  const parts = (cwd === '/' ? '' : cwd).split('/');
  for (const s of p.split('/')) {
    if (s === '..') parts.pop();
    else if (s && s !== '.') parts.push(s);
  }
  return parts.join('/') || '/';
}

const SPAWN_FAILED = /^(linker `[^`]*` not found|could not exec the linker)/;

/**
 * rustc reached the link step and failed to start the linker (WASI has no processes): the index
 * in `stderr` where that error starts, or -1. Everything before it are the real diagnostics.
 * Handles both human-readable output and --error-format=json (one diagnostic per line).
 */
export function linkerSpawnError(stderr: string): number {
  const text = stderr.search(/^error: (linker `[^`]*` not found|could not exec the linker)/m);
  if (text >= 0) return text;
  let at = 0;
  for (const line of stderr.split('\n')) {
    if (line.startsWith('{')) {
      try {
        const d = JSON.parse(line);
        if (d.$message_type === 'diagnostic' && d.level === 'error' && SPAWN_FAILED.test(d.message)) return at;
      } catch { /* not JSON */ }
    }
    at += line.length + 1;
  }
  return -1;
}

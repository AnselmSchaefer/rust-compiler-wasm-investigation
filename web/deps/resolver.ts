// The Cargo resolver (crates/resolver, built by scripts/build-resolver.sh) in the browser (WP-16).
// It's a wasm32-wasip1 module that never touches files, so a handful of WASI stubs does. JS
// supplies index files; each `resolve` reports either the files it still needs or the result.
// The same module plans builds (WP-17): `plan` turns the resolve and the packages' manifests into
// units with rustc arguments, `finish` adds a build script's output to a unit.

export interface ResolvedPackage {
  name: string; version: string; source: 'path' | 'registry';
  checksum: string | null; features: string[];
  /** Indices into `packages`. */
  deps: number[];
  /** A path package's directory. */
  dir: string | null;
}
/** A project for the resolver (WP-25): every Cargo.toml in it, by directory. */
export interface WorkspaceInput { root: string; manifests: Record<string, string> }
/** crates/resolver/src/workspace.rs; indices into `packages`. */
export interface WorkspaceInfo { root: string; members: number[]; default_members: number[]; resolver: number }
export type ResolveResult =
  | { need: string[] }
  | { lock: string; packages: ResolvedPackage[]; workspace?: WorkspaceInfo; manifests?: Record<string, string> }
  | { error: string };

/** crates/resolver/src/plan/mod.rs: PlanInput, Unit, Plan, Finished. */
export interface PlanInput {
  packages: { name: string; version: string; manifest: string | null; dir: string; source: 'path' | 'registry'; files: string[]; deps: number[] }[];
  /** The packages to build (or `root`, one package). `resolver`: the workspace's setting. */
  roots?: number[]; root?: number; resolver?: number;
  target: string; host: string; target_dir: string; rustc_id: string;
  features?: string[]; default_features?: boolean; target_flag_for_host?: boolean;
  profile?: { name?: string; opt_level?: string; debuginfo?: number; debug_assertions?: boolean; overflow_checks?: boolean; incremental?: boolean };
  tools?: { cargo?: string; rustc?: string; rustdoc?: string; jobs?: number };
  /** Extra rustc arguments for proc-macro units (WP-20). */
  proc_macro_args?: string[];
  /** Extra rustc arguments for every host-side compile, and for build-script compiles (WP-21). */
  host_args?: string[]; build_script_args?: string[];
  /** Plan `cargo test` (WP-26): dev-dependencies, examples, test harnesses. */
  test?: boolean;
  /** Plan `cargo check` (WP-27). */
  check?: boolean;
}
export type UnitKind = 'lib' | 'bin' | 'custom-build' | 'run-custom-build' | 'test' | 'example';
export interface PlanUnit {
  id: number; pkg: number; name: string; version: string; kind: UnitKind; crate_name: string; host: boolean;
  features: string[]; hash: string; deps: number[]; args: string[]; env: Record<string, string>;
  build_output: number | null; outputs: string[]; program: string | null; out_dir: string | null; cwd: string | null;
  /** Run units: the package's `links`. */
  links: string | null;
}
/** A test harness to run: `name` as cargo prints it (`unittests src/lib.rs`, `tests/x.rs`). */
export interface TestExe { package: string; name: string; unit: number; target: 'lib' | 'bin' | 'test'; cwd: string }
export interface Plan { units: PlanUnit[]; bins: [string, number][]; tests: TestExe[] }
export interface Finished { args: string[]; env: Record<string, string>; warnings: string[] }

type Exports = {
  memory: WebAssembly.Memory;
  resolver_alloc(len: number): number;
  resolver_free(ptr: number, len: number): void;
  resolver_add_index(name: number, nameLen: number, data: number, dataLen: number, present: number): void;
  resolver_resolve(manifest: number, len: number): bigint;
  planner_plan(input: number, len: number): bigint;
  planner_finish(input: number, len: number): bigint;
  manifest_edit(input: number, len: number): bigint;
};

/** crates/resolver/src/edit.rs */
export type ManifestEdit =
  | { op: 'add'; name: string; version?: string; features?: string[]; optional?: boolean; default_features?: boolean; package?: string; path?: string; kind?: DepKind; target?: string }
  | { op: 'remove'; name: string; kind?: DepKind; target?: string }
  | { op: 'set'; key: string[]; value: unknown };
export type DepKind = 'normal' | 'dev' | 'build';

const enc = new TextEncoder(), dec = new TextDecoder();
const ERRNO_BADF = 8, ERRNO_NOSYS = 52;

export class Resolver {
  private constructor(private readonly x: Exports, readonly stderr: string[]) {}

  static async load(url: string | URL): Promise<Resolver> {
    const module = await WebAssembly.compileStreaming(fetch(url));
    return Resolver.instantiate(module);
  }

  static async instantiate(module: WebAssembly.Module): Promise<Resolver> {
    const stderr: string[] = [];
    let x: Exports;
    const view = () => new DataView(x.memory.buffer);
    const wasi = {
      random_get: (p: number, n: number) => { crypto.getRandomValues(new Uint8Array(x.memory.buffer, p, n)); return 0; },
      environ_sizes_get: (c: number, s: number) => { view().setUint32(c, 0, true); view().setUint32(s, 0, true); return 0; },
      environ_get: () => 0,
      fd_prestat_get: () => ERRNO_BADF, // no preopened directories
      fd_prestat_dir_name: () => ERRNO_BADF,
      path_filestat_get: () => ERRNO_NOSYS,
      // Only panics write (to stderr); keep the text for error reports.
      fd_write: (_fd: number, iovs: number, n: number, written: number) => {
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = view().getUint32(iovs + 8 * i, true), l = view().getUint32(iovs + 8 * i + 4, true);
          stderr.push(dec.decode(new Uint8Array(x.memory.buffer, p, l)));
          total += l;
        }
        view().setUint32(written, total, true);
        return 0;
      },
      proc_exit: (code: number) => { throw new Error(`resolver exited (${code}): ${stderr.join('')}`); },
    };
    const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    x = inst.exports as unknown as Exports;
    return new Resolver(x, stderr);
  }

  private put(bytes: Uint8Array): [number, number] {
    const p = this.x.resolver_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    return [p, bytes.length];
  }

  /** The index file of `name`, or null if the package doesn't exist. */
  addIndex(name: string, data: Uint8Array | null) {
    const [np, nl] = this.put(enc.encode(name));
    const [dp, dl] = this.put(data ?? new Uint8Array());
    this.x.resolver_add_index(np, nl, dp, dl, data ? 1 : 0);
  }

  /** One package's Cargo.toml, or a whole project. */
  resolve(manifest: string | WorkspaceInput): ResolveResult {
    return this.call('resolver_resolve', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }

  /** Plan a build; the plan stays in the module for `finish`. */
  plan(input: PlanInput): Plan {
    const r = this.call<{ plan: Plan } | { error: string }>('planner_plan', JSON.stringify(input));
    if ('error' in r) throw new Error(r.error);
    return r.plan;
  }

  /** A unit's final rustc args and env; `outputs`: run unit id → its build script's stdout. */
  finish(unit: number, outputs: Record<number, string>): Finished {
    const r = this.call<Finished | { error: string }>('planner_finish', JSON.stringify({ unit, outputs }));
    if ('error' in r) throw new Error(r.error);
    return r;
  }

  /** Cargo.toml text after `edits` (formatting kept), or an error. */
  editManifest(manifest: string, edits: ManifestEdit[]): { manifest: string } | { error: string } {
    return this.call('manifest_edit', JSON.stringify({ manifest, edits }));
  }

  private call<T>(f: 'resolver_resolve' | 'planner_plan' | 'planner_finish' | 'manifest_edit', input: string): T {
    const [p, l] = this.put(enc.encode(input));
    let r: bigint;
    try {
      r = this.x[f](p, l);
    } catch (e) {
      throw new Error(`resolver trapped: ${(e as Error).message}\n${this.stderr.join('')}`);
    }
    const ptr = Number(r >> 32n), len = Number(r & 0xffffffffn);
    const text = dec.decode(new Uint8Array(this.x.memory.buffer, ptr, len));
    this.x.resolver_free(ptr, len);
    return JSON.parse(text);
  }
}

// The agent's tools (WP-38), run in the IDE page over the orchestrator worker's operations. The
// relay (tools/relay/relay.py) lists them from tools/relay/tools.json for MCP and forwards each
// call here. Results are JSON for a model to read: paths relative to the project, rustc's
// diagnostics as data with their rendered text (ANSI colours stripped), long outputs cut.
// Calls on one project run one at a time, in order; different projects can overlap.

import type { OrchestratorClient } from '../orchestrator/client';
import type { Ops } from '../orchestrator/protocol';
import type { Diagnostic } from '../build/diagnostics';
import TOOLS from '../../tools/relay/tools.json';

export const TOOL_NAMES: string[] = TOOLS.tools.map(t => t.name);

export interface ToolsOptions {
  resolverUrl: string;
  /** The sparse index: the relay's same-origin proxy of index.crates.io. */
  index: string;
  /** Watch what happens: a file the tool read or wrote, program or test output. */
  onFile?: (project: string, path: string, content: string) => void;
  onOutput?: (title: string, text: string) => void;
}

const PROJECTS = '/projects';
const MAX_TEXT = 64 * 1024;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class ToolError extends Error {}

export class AgentTools {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly orch: OrchestratorClient, private readonly o: ToolsOptions) {}

  /** Runs tool `name`; a ToolError's message is for the agent (bad arguments, missing files). */
  call(name: string, args: Record<string, any>): Promise<unknown> {
    const f = (this as unknown as Record<string, (a: Record<string, any>) => Promise<unknown>>)[`t_${name}`];
    if (!TOOL_NAMES.includes(name) || !f) return Promise.reject(new ToolError(`unknown tool ${name}`));
    const project = typeof args.project === 'string' ? args.project : '';
    if (name !== 'project_list' && !NAME.test(project)) return Promise.reject(new ToolError('`project` must be 1–64 letters, digits, - or _'));
    // One call at a time per project, in arrival order.
    const prev = this.queues.get(project) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => f.call(this, args));
    this.queues.set(project, run);
    return run;
  }

  private dir(project: string) { return `${PROJECTS}/${project}`; }

  private path(project: string, rel: unknown): string {
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').some(s => s === '..' || s === '')) {
      throw new ToolError('`path` must be a relative path inside the project, without `..`');
    }
    return `${this.dir(project)}/${rel}`;
  }

  private async exists(project: string) {
    return (await this.orch.call('projectList', {})).includes(project);
  }

  private async need(project: string) {
    if (!await this.exists(project)) throw new ToolError(`no project \`${project}\` (project_create makes one)`);
  }

  private buildArgs(project: string): Ops['build']['args'] {
    return { project: this.dir(project), resolverUrl: this.o.resolverUrl, index: this.o.index };
  }

  // --- projects and files

  async t_project_create(a: { project: string; files?: Record<string, string>; overwrite?: boolean }) {
    if (await this.exists(a.project)) {
      if (!a.overwrite) throw new ToolError(`project \`${a.project}\` exists (overwrite: true replaces it)`);
      await this.orch.call('projectDelete', { name: a.project });
    }
    const files = a.files && Object.keys(a.files).length ? a.files : {
      'Cargo.toml': `[package]\nname = "${a.project}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
      'src/main.rs': 'fn main() {\n    println!("Hello, world!");\n}\n',
    };
    for (const rel of Object.keys(files)) this.path(a.project, rel);
    const r = await this.orch.call('projectImport', { name: a.project, source: { files } });
    return { project: a.project, files: Object.keys(files).sort(), written: r.files };
  }

  async t_project_list() {
    return { projects: await this.orch.call('projectList', {}) };
  }

  async t_project_delete(a: { project: string }) {
    await this.need(a.project);
    await this.orch.call('projectDelete', { name: a.project });
    return { deleted: a.project };
  }

  async t_file_list(a: { project: string }) {
    await this.need(a.project);
    return { files: await this.orch.call('listFiles', { dir: this.dir(a.project) }) };
  }

  async t_file_read(a: { project: string; path: string }) {
    await this.need(a.project);
    const p = this.path(a.project, a.path);
    let bytes: Uint8Array;
    try { bytes = await this.orch.call('readFile', { path: p }); } catch { throw new ToolError(`no file \`${a.path}\` in \`${a.project}\``); }
    const content = new TextDecoder().decode(bytes);
    this.o.onFile?.(a.project, a.path, content);
    return { path: a.path, content };
  }

  async t_file_write(a: { project: string; path: string; content: string }) {
    await this.need(a.project);
    if (typeof a.content !== 'string') throw new ToolError('`content` must be a string');
    await this.orch.call('writeFile', { path: this.path(a.project, a.path), data: a.content });
    this.o.onFile?.(a.project, a.path, a.content);
    return { path: a.path, bytes: new TextEncoder().encode(a.content).length };
  }

  async t_file_delete(a: { project: string; path: string }) {
    await this.need(a.project);
    const p = this.path(a.project, a.path);
    const files = await this.orch.call('listFiles', { dir: this.dir(a.project) });
    if (!files.includes(a.path)) throw new ToolError(`no file \`${a.path}\` in \`${a.project}\``);
    await this.orch.call('remove', { path: p });
    return { deleted: a.path };
  }

  // --- dependencies

  async t_dependency_add(a: { project: string; name: string; version?: string; features?: string[]; dev?: boolean; dir?: string }) {
    await this.need(a.project);
    return this.edit(a.project, a.dir, [{ op: 'add', name: a.name, version: a.version, features: a.features, kind: a.dev ? 'dev' : undefined }]);
  }

  async t_dependency_remove(a: { project: string; name: string; dev?: boolean; dir?: string }) {
    await this.need(a.project);
    return this.edit(a.project, a.dir, [{ op: 'remove', name: a.name, kind: a.dev ? 'dev' : undefined }]);
  }

  private async edit(project: string, dir: string | undefined, edits: Ops['manifestEdit']['args']['edits']) {
    if (dir !== undefined) this.path(project, `${dir}/Cargo.toml`);
    const r = await this.orch.call('manifestEdit', { project, dir, edits, resolverUrl: this.o.resolverUrl, index: this.o.index });
    const manifest = `${dir ? `${dir}/` : ''}Cargo.toml`;
    if (r.ok) {
      const content = new TextDecoder().decode(await this.orch.call('readFile', { path: `${this.dir(project)}/${manifest}` }));
      this.o.onFile?.(project, manifest, content);
    }
    // The new lockfile itself is long and on disk; the changes say what happened.
    return r.ok ? { ok: true, manifest, changes: r.changes } : r;
  }

  // --- cargo

  async t_cargo_check(a: { project: string }) {
    await this.need(a.project);
    const r = await this.orch.call('check', this.buildArgs(a.project));
    return { ok: r.ok, ...this.diagnostics(a.project, r.diagnostics, r.ok ? '' : r.errors), ms: r.ms.total };
  }

  async t_cargo_build(a: { project: string }) {
    await this.need(a.project);
    const r = await this.orch.call('build', this.buildArgs(a.project));
    return {
      ok: r.ok, ...this.diagnostics(a.project, r.diagnostics, r.ok ? '' : r.errors), bins: Object.keys(r.bins),
      units: r.units.length, built: r.units.filter(u => !u.cached).length, ms: r.ms.total,
    };
  }

  async t_cargo_run(a: { project: string; bin?: string; args?: string[]; stdin?: string; timeout_ms?: number }) {
    await this.need(a.project);
    const b = await this.orch.call('build', this.buildArgs(a.project));
    const diags = this.diagnostics(a.project, b.diagnostics, b.ok ? '' : b.errors);
    if (!b.ok) return { ok: false, stage: 'build', ...diags };
    const names = Object.keys(b.bins);
    const bin = a.bin ?? (names.length === 1 ? names[0] : names.find(n => n === a.project));
    if (!bin || !b.bins[bin]) throw new ToolError(names.length ? `which bin? \`bin\` is one of: ${names.join(', ')}` : 'the project has no executable (src/main.rs or [[bin]])');
    const r = await this.orch.call('run', {
      path: b.bins[bin], args: a.args, stdin: a.stdin ?? '', timeoutMs: a.timeout_ms ?? 10_000, dir: this.dir(a.project),
    });
    this.o.onOutput?.(`cargo run (${bin})`, r.stdout + r.stderr);
    return {
      ok: r.code === 0, stage: 'run', bin, exit_code: r.code, timed_out: !!r.timedOut, stdout: cut(r.stdout), stderr: cut(r.stderr),
      ...(r.trap && { trap: r.trap }), warnings: diags.warnings, ms: { build: b.ms.total, run: r.ms },
    };
  }

  async t_cargo_test(a: { project: string; filter?: string; exact?: boolean; include_ignored?: boolean }) {
    await this.need(a.project);
    const r = await this.orch.call('test', { ...this.buildArgs(a.project), filter: a.filter, exact: a.exact, includeIgnored: a.include_ignored });
    if (!r.build.ok) return { ok: false, stage: 'build', ...this.diagnostics(a.project, r.build.diagnostics, r.build.errors) };
    const tests = r.tests.map(t => ({
      suite: t.suite, name: t.name, status: t.status, ms: t.ms,
      ...(t.message && { message: this.rel(a.project, t.message) }),
      ...(t.status === 'failed' && t.stdout && { stdout: cut(t.stdout) }),
      ...(t.ignored && { ignored: t.ignored }),
    }));
    this.o.onOutput?.('cargo test', tests.map(t => `${t.status === 'ok' ? '✓' : t.status === 'failed' ? '✗' : '–'} ${t.suite} ${t.name}${t.message ? `\n    ${t.message.replace(/\n/g, '\n    ')}` : ''}`).join('\n') + '\n');
    return { ok: r.ok, counts: r.counts, tests, ms: r.ms };
  }

  async t_cargo_clippy(a: { project: string }) {
    await this.need(a.project);
    const r = await this.orch.call('clippy', this.buildArgs(a.project));
    return { ok: r.ok, ...this.diagnostics(a.project, r.ok || r.build.ok ? r.diagnostics : r.build.diagnostics, r.build.ok ? '' : r.build.errors), ms: r.ms };
  }

  async t_cargo_fmt(a: { project: string; check?: boolean }) {
    await this.need(a.project);
    const dir = this.dir(a.project);
    const files = await this.orch.call('listFiles', { dir });
    const manifests = files.filter(f => f === 'Cargo.toml' || f.endsWith('/Cargo.toml'));
    const results: { path: string; changed?: boolean; formatted?: boolean; diff?: string; error?: string }[] = [];
    for (const f of files.filter(f => f.endsWith('.rs'))) {
      // The edition of the package the file belongs to: its nearest Cargo.toml.
      const owner = manifests.filter(m => m === 'Cargo.toml' || f.startsWith(m.slice(0, -'Cargo.toml'.length))).sort((x, y) => y.length - x.length)[0];
      const edition = owner ? (new TextDecoder().decode(await this.orch.call('readFile', { path: `${dir}/${owner}` })).match(/^\s*edition\s*=\s*"(\d{4})"/m)?.[1] ?? '2015') : '2021';
      const r = await this.orch.call('fmt', { path: `${dir}/${f}`, edition, check: a.check });
      if (r.exit !== 0 && !(a.check && r.out)) results.push({ path: f, error: this.rel(a.project, r.stderr || `rustfmt exit ${r.exit}`) });
      else if (a.check) results.push({ path: f, formatted: r.exit === 0, ...(r.exit !== 0 && { diff: cut(this.rel(a.project, r.out)) }) });
      else results.push({ path: f, changed: r.changed });
      if (r.changed) this.o.onFile?.(a.project, f, new TextDecoder().decode(await this.orch.call('readFile', { path: `${dir}/${f}` })));
    }
    const ok = results.every(r => !r.error && (a.check ? r.formatted : true));
    return a.check
      ? { ok, unformatted: results.filter(r => r.formatted === false).map(r => ({ path: r.path, diff: r.diff })), errors: results.filter(r => r.error) }
      : { ok, changed: results.filter(r => r.changed).map(r => r.path), errors: results.filter(r => r.error) };
  }

  // --- helpers

  /** Paths below the project made relative. */
  private rel(project: string, s: string) {
    return s.split(`${this.dir(project)}/`).join('');
  }

  private diagnostics(project: string, ds: Diagnostic[], failure: string) {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const list = ds.map(d => ({
      level: d.level, code: d.code, message: d.message,
      ...(d.file && { file: this.rel(project, d.file), line: d.line, column: d.column }),
      rendered: this.rel(project, strip(d.rendered)),
    }));
    const n = (l: string) => list.filter(d => d.level === l).length;
    return {
      errors: n('error'), warnings: n('warning'), diagnostics: list,
      // A failure without diagnostics: resolving, downloading, a build script.
      ...(failure && !list.some(d => d.level === 'error') && { error: cut(this.rel(project, strip(failure))) }),
    };
  }
}

function cut(s: string) {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more bytes)` : s;
}

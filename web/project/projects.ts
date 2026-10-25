// Projects in the VFS (WP-25): each one a directory /projects/<name>, persisted to OPFS by the
// orchestrator worker (web/vfs/persist.ts). Import from files, a zip or a GitHub repository;
// export as a zip; Cargo.toml edits checked by resolving the project again, with the lockfile
// changes as the result.

import { projectManifests } from '../build/cargo';
import { resolveManifest, type DepsOptions } from '../deps/deps';
import type { ManifestEdit, Resolver } from '../deps/resolver';
import { Kind, type Vfs } from '../vfs/vfs';
import { readZip, writeZip } from './zip';

export const PROJECTS = '/projects';
const enc = new TextEncoder();

export function projectDir(name: string): string {
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`bad project name "${name}"`);
  return `${PROJECTS}/${name}`;
}

export function listProjects(vfs: Vfs): string[] {
  if (!vfs.exists(PROJECTS)) return [];
  return vfs.readdir(PROJECTS).filter(e => e.kind === Kind.Dir).map(e => e.name).sort();
}

/** If every path is below the same directory (as in GitHub's and most zips), drop it. */
function stripCommonTop(paths: string[]): string {
  const tops = new Set(paths.map(p => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  const [top] = tops;
  return tops.size === 1 && top ? `${top}/` : '';
}

const SKIP = /(^|\/)(target|\.git)(\/|$)/;

/** Replace project `name` with `files` (relative paths). Returns the number of files written. */
export function writeProject(vfs: Vfs, name: string, files: Record<string, Uint8Array | string>): number {
  const dir = projectDir(name);
  if (vfs.exists(dir)) vfs.removeAll(dir);
  vfs.mkdirAll(dir);
  const paths = Object.keys(files);
  const strip = stripCommonTop(paths);
  let n = 0;
  for (const p of paths) {
    const rel = p.slice(strip.length).replace(/^\/+/, '');
    if (!rel || SKIP.test(rel) || rel.split('/').some(s => s === '..' || s === '.')) continue;
    const d = files[p];
    vfs.writeFile(`${dir}/${rel}`, typeof d === 'string' ? enc.encode(d) : d);
    n++;
  }
  if (!vfs.exists(`${dir}/Cargo.toml`)) throw new Error(`project "${name}" has no Cargo.toml at its root`);
  return n;
}

export async function importZip(vfs: Vfs, name: string, zip: Uint8Array): Promise<number> {
  const entries = await readZip(zip);
  return writeProject(vfs, name, Object.fromEntries(entries.map(e => [e.path, e.data])));
}

/** The project as a zip: its files (no target/, no hidden directories), paths relative to it. */
export async function exportZip(vfs: Vfs, name: string): Promise<Uint8Array> {
  const dir = projectDir(name);
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of vfs.readdir(d)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === Kind.Dir && e.name !== 'target' && !e.name.startsWith('.')) walk(`${d}/${e.name}`, r);
      else if (e.kind === Kind.File) files.push(r);
    }
  };
  walk(dir, '');
  files.sort();
  return writeZip(files.map(f => ({ path: f, data: vfs.readFile(`${dir}/${f}`) })));
}

export function deleteProject(vfs: Vfs, name: string) {
  vfs.removeAll(projectDir(name));
}

export interface LockChange { name: string; from?: string; to?: string }

/** Packages (name → versions) of a Cargo.lock. */
function lockPackages(lock: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of lock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)) {
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  return out;
}

/** What changed between two lockfiles: added (to), removed (from), changed (from → to). */
export function lockDiff(before: string, after: string): LockChange[] {
  const a = lockPackages(before), b = lockPackages(after), out: LockChange[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = (a.get(name) ?? []).filter(v => !b.get(name)?.includes(v)), y = (b.get(name) ?? []).filter(v => !a.get(name)?.includes(v));
    if (x.length === 1 && y.length === 1) out.push({ name, from: x[0], to: y[0] });
    else {
      for (const v of x) out.push({ name, from: v });
      for (const v of y) out.push({ name, to: v });
    }
  }
  return out;
}

export type EditResult =
  | { ok: true; manifest: string; changes: LockChange[]; lock: string }
  | { ok: false; error: string; stage: 'edit' | 'resolve' };

/**
 * Apply `edits` to the Cargo.toml in `pkgDir` (relative to the project; default its root), then
 * resolve the project. On success the new Cargo.toml and Cargo.lock are written and the result
 * lists the lockfile changes; on failure nothing changes and the result has the error.
 */
export async function editManifest(vfs: Vfs, resolver: Resolver, project: string, pkgDir: string, edits: ManifestEdit[], deps: Omit<DepsOptions, 'resolver'>): Promise<EditResult> {
  const root = projectDir(project), dir = pkgDir ? `${root}/${pkgDir.replace(/^\/+|\/+$/g, '')}` : root;
  const path = `${dir}/Cargo.toml`, before = vfs.readText(path);
  const e = resolver.editManifest(before, edits);
  if ('error' in e) return { ok: false, error: e.error, stage: 'edit' };
  const resolve = async (manifests: Record<string, string>) => {
    try {
      return await resolveManifest({ root, manifests }, { ...deps, resolver });
    } catch (err) {
      return { error: String((err as Error).message ?? err) };
    }
  };
  const lockPath = `${root}/Cargo.lock`;
  let oldLock = vfs.exists(lockPath) ? vfs.readText(lockPath) : null;
  if (oldLock === null) {
    const r0 = await resolve(projectManifests(vfs, root));
    oldLock = 'lock' in r0 ? r0.lock : '';
  }
  const manifests = { ...projectManifests(vfs, root), [dir]: e.manifest };
  const r = await resolve(manifests);
  if ('error' in r) return { ok: false, error: r.error, stage: 'resolve' };
  vfs.writeFile(path, e.manifest);
  vfs.writeFile(lockPath, r.lock);
  return { ok: true, manifest: e.manifest, changes: lockDiff(oldLock, r.lock), lock: r.lock };
}


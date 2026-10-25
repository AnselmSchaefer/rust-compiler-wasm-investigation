// Import a public GitHub repository (WP-25). Archive downloads (codeload.github.com) only allow
// render.githubusercontent.com cross-origin, so the browser can't fetch them. Instead: one
// git-trees API call (CORS `*`; 60 calls an hour per IP without a token), then every file from
// raw.githubusercontent.com (CORS `*`), a few at a time.

export interface GitHubImport {
  /** "owner/repo" or "owner/repo@ref" (branch, tag or commit; default HEAD). */
  repo: string;
  /** Only files below this directory of the repo, re-rooted. */
  subdir?: string;
  /** Limits: files larger than `maxFileBytes` are skipped; more than `maxFiles` is an error. */
  maxFiles?: number;
  maxFileBytes?: number;
  concurrency?: number;
}

export interface GitHubResult { files: Record<string, Uint8Array>; skipped: string[]; ref: string; requests: number }

const SKIP = /(^|\/)(target|\.git)(\/|$)/;

export async function importGitHub(o: GitHubImport): Promise<GitHubResult> {
  const m = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/.exec(o.repo);
  if (!m) throw new Error(`"${o.repo}" is not owner/repo[@ref]`);
  const [, owner, name, ref = 'HEAD'] = m;
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub: ${owner}/${name}@${ref}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const tree = await res.json() as { sha: string; truncated: boolean; tree: { path: string; type: string; size?: number }[] };
  if (tree.truncated) throw new Error(`GitHub: ${owner}/${name} has too many files for one tree listing`);
  const sub = o.subdir ? o.subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
  const maxBytes = o.maxFileBytes ?? 2 << 20, skipped: string[] = [];
  const blobs = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith(sub) && !SKIP.test(e.path)).filter(e => {
    if ((e.size ?? 0) <= maxBytes) return true;
    skipped.push(e.path);
    return false;
  });
  if (blobs.length > (o.maxFiles ?? 5000)) throw new Error(`GitHub: ${blobs.length} files, more than ${o.maxFiles ?? 5000}`);
  const files: Record<string, Uint8Array> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 16, blobs.length) }, async () => {
    while (next < blobs.length) {
      const e = blobs[next++];
      const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${e.path.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`GitHub: ${e.path}: HTTP ${r.status}`);
      files[e.path.slice(sub.length)] = new Uint8Array(await r.arrayBuffer());
    }
  }));
  return { files, skipped, ref, requests: 1 + blobs.length };
}

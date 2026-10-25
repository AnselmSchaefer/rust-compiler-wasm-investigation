# Projects and workspaces (WP-25)

*2026-10-25. Status: done. `scripts/verify/wp-25.sh` passes.*

## Workspaces in the resolver and planner

`crates/resolver/src/workspace.rs` takes **every Cargo.toml of the project** (directory → text; `web/build/cargo.ts` `projectManifests` walks the VFS and skips `target/` and hidden directories) and returns cargo's view of the workspace:

- **Members:** `[workspace] members` (globs with `*` and `?` inside a path segment, matched against the project's manifests and sorted), minus `exclude`, plus the root package if there is one, plus path dependencies inside the workspace directory (found depth-first), as cargo does. Other path dependencies (outside, or excluded) are plain path packages. They are built, but they don't inherit, aren't primary, and aren't roots of the resolve.
- **Inheritance:** `field.workspace = true` in `[package]` from `[workspace.package]` (`readme` and `license-file` re-rooted to the member). `dep.workspace = true` from `[workspace.dependencies]`: features are added, `optional` comes from the member, and a workspace `path` is made relative to the workspace root. `[lints] workspace = true` from `[workspace.lints]`. Every dependency `path` becomes absolute, so each normalized manifest can be read on its own (the planner gets those).
- **Which packages `cargo build` builds:** `default-members`, else the root package, else (virtual manifest) every member. The `resolver` setting comes from `[workspace]`, else the root package's, else its edition. A virtual manifest without one gets resolver 1, as in cargo.

**Resolver:** `Dependency.path` and `Summary.dir` are new. A path dependency has exactly one candidate, the package in that directory (name and version requirement checked). `resolve_roots` activates every member as a root (all features, dev dependencies), like `cargo generate-lockfile`. The rust-version used for the lockfile format and MSRV fallback is the lowest member's.

**Planner:** `PlanInput.roots` (several packages) and `resolver`. Features from `--features` apply only when building one package. `-C incremental` goes to every path package (cargo's "local" units), `CARGO_PRIMARY_PACKAGE` only to the packages being built, and `--cap-lints allow` only to registry packages.

**Golden** (`tests/planner/cases/`, recorded from native cargo):

| Case | What | Result |
|---|---|---|
| `ws` | virtual manifest, `members = ["app", "libs/*"]`, `exclude = ["vendor"]`, `vendor/helper` as a non-member path dependency (with a version requirement), a renamed path dependency with `[lib] name`, inheritance of package fields, dependencies (with added features) and lints | units, arguments, environments and **Cargo.lock** identical |
| `ws-root` | root package with an empty `[workspace]`; its path dependency `parts/greet` becomes a member but isn't built as a primary package | identical (found: without `default-members` only the root package is primary) |

## Projects in the browser (`web/project/`, orchestrator ops)

| Op | What |
|---|---|
| `init { persist: true }` | Restores `/projects` from OPFS (the WP-11 persister) and keeps mirroring it. Build outputs (`/target`) aren't persisted; they come back from the build cache (WP-18). |
| `projectImport { name, source }` | From `files`, a `zip` (stored or deflate entries; one common top directory is stripped, as in GitHub's zips) or `github: "owner/repo@ref"`. `target/` and `.git/` are skipped. |
| `projectExport { name }` | A zip of the project, without `target/` or hidden directories, with fixed timestamps. |
| `projectList`, `projectDelete`, `projectFlush` | `projectFlush` waits until everything is in OPFS (before a reload). |
| `manifestEdit { project, dir, edits }` | `add` / `remove` a dependency (`kind`, `target`, `features`, `optional`, `default_features`, `package`, `path`), `set` a key (`null` removes). Formatting is kept (`toml_edit`, `crates/resolver/src/edit.rs`). The project is then resolved again: on success Cargo.toml and Cargo.lock are written and the result lists the lockfile changes (`{name, from?, to?}`); on failure nothing changes and the result has the resolver's error and the stage (`edit` or `resolve`). |
| `build` | Now writes the project's Cargo.lock, like cargo. |

**GitHub without archives:** `codeload.github.com` (the archive downloads) sends `Access-Control-Allow-Origin: https://render.githubusercontent.com`, so a page can't read them. `importGitHub` instead makes one git-trees API call (`api.github.com`, CORS `*`; 60 calls an hour per IP without a token) and fetches every file from `raw.githubusercontent.com` (CORS `*`), 16 at a time. Files over 2 MiB are skipped, and more than 5000 files is an error. Through the local relay (WP-38), archives would work too.

## Measured (Chromium, `bench/results/*-projects.json`)

The `ws` workspace imports from a zip (9 files), and after a reload its 9 files are restored from OPFS (init 0.5–1.3 s including the toolchain). It builds (15 packages, 15 units, ~7.5 s cold with 4 compile servers) and runs. The GitHub import of dtolnay/itoa@1.0.18 (16 files) takes 1–3 s.

## Not covered

`[patch]`, `[replace]`, git dependencies, nested workspaces, path dependencies outside the project directory (the loader only sees the project's manifests), `-p`/`--workspace` selection (the build op builds the default members), the existing Cargo.lock as a preference (every resolve picks the newest versions; with the pinned snapshot index that's stable), and building the GitHub-imported crate in the test (its optional dependency isn't in the snapshot index; the real index needs the relay).

# Cargo resolver for the browser (WP-15)

*2026-10-24. Status: spike done, golden corpus recorded; next: implement `crates/resolver`.*

## Spike: Cargo's own resolver in Wasm? No

The `cargo` crate (0.100.0, i.e. cargo 1.99) depends **unconditionally** on `curl`/`curl-sys`, `git2`/`libgit2-sys`, `libssh2-sys` and gix. Even with `default-features = false`, a `wasm32-wasip1` build fails in the C parts: `netdb.h` (sockets) and OpenSSL headers don't exist on WASI. Removing them means editing cargo's source to gate its network, git and SSH code. Cargo is a rust-lang project, so we don't patch it (same rule as for rustc). So, as the plan foresaw, we write **`crates/resolver`** ourselves.

What we can reuse (all build for `wasm32-wasip1` and run under wasmtime, checked): `cargo-util-schemas` 0.14.3 (Cargo.toml types), `cargo-platform` 0.3.3 (`cfg(...)` and target triples), `semver` 1.0.28, `toml` 1.1.8.

## Golden tests

- **Corpus:** `tests/resolver/corpus.txt`, 50 crates from crates.io, from small (`smallvec`, 13 packages in the lockfile) to huge (`bevy` 792, `nu` 795). It mixes libraries, async and web stacks, feature-heavy crates (`sqlx`, `polars`, `wgpu`) and binaries (`ripgrep`, `bat`, `fd-find`, `tokei`, `hyperfine`, `nu`).
- **Pinned index:** `tests/resolver/index-proxy.mjs` is a sparse-index proxy. *record* fetches from index.crates.io and stores what it serves; *replay* serves only the stored files. The snapshot (1,632 index files, 88 MB) is committed compressed as `tests/resolver/index-snapshot.tar.zst` (3.1 MB), recorded 2026-10-24.
- **Expected output:** `tests/resolver/make-golden.mjs` takes each crate's newest non-yanked stable version at that snapshot, unpacks its published `.crate`, and runs native `cargo 1.99.1 generate-lockfile` with crates.io replaced by the proxy. Results: `tests/resolver/golden/<name>.lock` plus `versions.txt`. All 50 resolve. **Replay reproduces all 50 lockfiles byte for byte**, so the method is deterministic and the snapshot is complete.
- **Target:** ≥ 48/50 identical lockfiles from our resolver, with every mismatch documented.

## Cargo behaviours the resolver has to match

From the cargo 1.99 resolver and lockfile code (`cargo` 0.100.0, unpacked for reading in `build/wp-15/cargo-src/`; about 6,300 lines in `src/resolver/`), and from what the golden files show:

1. **Candidate order:** highest version first; pre-releases only if the requirement names one; yanked versions skipped (unless already locked).
2. **One version per semver-compatible range** of a package: `1.x` for ≥ 1, `0.y` for 0.y > 0, exact `0.0.z` otherwise. Different ranges may coexist (e.g. `syn 1` and `syn 2`).
3. **Backtracking** on conflicts (a range already holds an incompatible version, `links` collisions), with Cargo's search order, so we get the same answer and not just *a* valid one.
4. **Resolver v3 (edition 2024):** `incompatible-rust-versions = "fallback"`. Prefer candidates whose `rust_version` is ≤ the workspace's `rust-version`, and fall back to newer ones only if nothing compatible matches. The index carries `rust_version`.
5. **Features at resolve time:** `default`, explicit features, `dep:` names, `pkg/feat` and weak `pkg?/feat`. Optional deps enter the graph only when some feature enables them. Features are unified across the graph for the resolve (not per target, as the v2 *feature* resolver does later for builds).
6. **Which edges count:** all `[target.*]` dependencies (the lockfile is platform-independent), build dependencies, and dev dependencies **of the root package only**. Renamed dependencies (`package = "..."`) resolve by package name.
7. **Index details:** `features` and `features2` (index format v2), `deps[].package` for renames, `kind` (normal/build/dev), `target` (a `cfg(...)` or triple string), `links`.
8. **Lockfile format version** from the root's `rust-version` (cargo's `ResolveVersion::with_rust_version`): ≥ 1.83 → v4, ≥ 1.53 → v3, ≥ 1.41 → v2, older → v1, none → v4. The corpus has 25 of each of v3 and v4. Packages sorted by name, version, source; the root without `source`/`checksum`. A `dependencies` entry is `"name"`, or `"name version"` when several versions of that name are in the lockfile (plus the source when even that is ambiguous). The header comment and spacing are exactly cargo's.

## Design

`crates/resolver` (Rust, built natively for the golden tests and for `wasm32-unknown-unknown`/`wasip1` for the browser):

- `index.rs`: parse sparse-index lines into summaries (version, deps, features, links, rust_version, yanked, cksum). It sits behind a `Registry` trait (`fn versions(&self, name) -> &[Summary]`), so tests read the snapshot directory and the browser reads the VFS/HTTP cache (WP-16).
- `manifest.rs`: the root's Cargo.toml via `cargo-util-schemas` → the same summary shape (with dev deps), plus `rust-version`, edition and `resolver`.
- `resolve.rs`: cargo's algorithm (activation, candidate order, backtracking, feature activation, MSRV fallback).
- `lockfile.rs`: read and write `Cargo.lock` (v3/v4), byte-identical to cargo's output.
- `tests/golden.rs`: unpack the snapshot, resolve each corpus crate, diff against `golden/<name>.lock`, report matches and diffs.

Not in WP-15: git and path dependencies other than the root, workspaces (published crates have none; WP-17's planner will need them), `[patch]`/`[replace]`, alternative registries, and updating an existing lockfile minimally (`cargo update -p`). Fresh resolution is what the golden tests cover.

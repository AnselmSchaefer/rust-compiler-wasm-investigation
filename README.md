# Rust in the browser

A Rust IDE that compiles, tests and runs Rust entirely in a browser tab: rustc 1.99.1 compiled to WebAssembly (with LLVM, wasm-ld, Clippy and rustfmt), a reimplementation of cargo's resolver and build planner, crates.io dependencies with build scripts and proc macros, a content-addressed build cache, and a sandbox for the programs it builds (target `wasm32-wasip1`). An agent such as Claude Code can drive it through a local relay (MCP), and a person can use the same page by hand.

Only Chromium-based browsers are targets. The design and the plan: `PROPOSAL.md`, `PLAN.md`; progress: `STATUS.md`.

## Try it

Needs a toolchain release in `build/release` (`toolchain/release.sh`; the toolchain build itself is documented in `PLAN.md` and `toolchain/`), Node with pnpm, and Python 3.

```
pnpm install
pnpm ide
```

`pnpm ide` builds the app and starts the relay without an agent (`tools/relay/relay.py --no-mcp`). It opens Chromium on the IDE, `http://127.0.0.1:8790/ide.html`. Click **Sample** for a guided project that touches every feature (`app/sample.ts`):
- **Build** and **Run** (the program reads the terminal);
- **Test**, with **Rerun** for a single test;
- **Clippy**: click a problem to jump to it;
- **Format** and **Check**;
- **+ Dependency** (from crates.io);
- **Import** (a .zip or a GitHub repository) and **Export**.

Projects, the build cache and the toolchain stay in the browser profile (`build/relay/profile`). The stats row under the toolbar shows each build's phases and how many units came from the cache. Ctrl-C in the terminal stops the relay.

## With an agent

Register the relay as an MCP server and let Claude Code work in the IDE. Its calls show in the Activity tab, and its changes in the tree and the editor:

```
mkdir -p ~/Projects/rust-ide-try && cd ~/Projects/rust-ide-try
claude mcp add rust-ide -- python3 /path/to/this/repo/tools/relay/relay.py --browser headed
claude
```

Step by step, with the pitfalls: `docs/relay-manual-guide.md`. Design, tools and security: `docs/relay.md`.

## Where things are

| | |
|---|---|
| `toolchain/` | Building rustc, LLVM and the tools for a `wasm32-wasip1-threads` host; `rustc-multi` (compile server, Clippy, rustfmt, proc-macro host imports); release packaging |
| `crates/resolver` | cargo's resolver and build planner, golden-tested against cargo (`tests/planner`, `tests/resolver`) |
| `web/` | The browser runtime: VFS, WASI, orchestrator and compile servers, sandbox, build executor and cache, the tools an agent uses |
| `app/` | The IDE (`ide.html`) and the WP-14 single-file playground (`index.html`) |
| `tools/relay` | The MCP relay; `tools/prebuild` fills the shared build cache natively |
| `tests/`, `scripts/verify/` | e2e tests (Playwright) and each work package's done-check |
| `docs/` | Design notes per area; `bench/` holds measurements |

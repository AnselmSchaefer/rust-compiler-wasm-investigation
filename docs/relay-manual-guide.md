# Trying the browser IDE with your own Claude Code session

This connects a Claude Code session to the relay (`tools/relay/relay.py`, WP-38), so that the agent builds, tests and runs Rust inside the browser IDE instead of with local `cargo`. Background and design: `docs/relay.md`.

## Once: build and register

1. Build the app (it needs a toolchain release in `build/release`):
   ```
   cd ~/Projects/rust-compiler-wasm-investigation
   pnpm build:app
   ```
2. Register the relay as an MCP server for a directory of your choice. Use an empty one, so that no project's CLAUDE.md steers the session. **Type it as one line:**
   ```
   mkdir -p ~/Projects/rust-ide-try && cd ~/Projects/rust-ide-try
   claude mcp add rust-ide -- python3 /home/anselm/Projects/rust-compiler-wasm-investigation/tools/relay/relay.py --browser headed
   ```
   That registers it for this directory only. Add `-s user` to have it in every directory.
3. Check it:
   ```
   claude mcp list
   ```
   The line must read `rust-ide: python3 /home/anselm/…/tools/relay/relay.py --browser headed - ✔ Connected`. If it shows only `python3`, the command was split: `claude mcp remove rust-ide`, then step 2 again.

## Each time

1. **Don't start `relay.py` yourself.** Claude Code starts it. A relay started by hand in a terminal opens a window that no agent talks to, so the window stays empty.
2. Start Claude Code in the registered directory:
   ```
   cd ~/Projects/rust-ide-try
   claude
   ```
   A Chromium window "Rust in the browser · agent" opens. Within a few seconds the badge top left turns green ("relay: connected"), and the status shows `Ready: rustc 1.99.1-…, N project(s)`.
3. In Claude, type `/mcp`: `rust-ide` should be connected, with 15 tools. If it failed, choose Reconnect, or `/exit` and start `claude` again.
4. Give a task that names the tools, so the agent doesn't fall back to local `cargo`. For example:
   > Use only the rust-ide tools (the browser IDE), not the shell. Create a project `csv-demo` that parses CSV with the csv crate and serde, add tests, then run cargo_test, cargo_clippy and cargo_fmt, and cargo_run it.

   Or paste `tests/relay/agent-task.md` (the WP-38 task: a seeded compile error, a failing test, a Clippy lint, unformatted code). Allow the `rust-ide` tools when Claude asks, ideally "always".
5. Watch the window (top: the last build's timings, phases and cached/built units, plus totals):
   - left: the projects' files (marked: changed by the last few calls; click one to see it);
   - middle: each tool call with its time, arguments and a one-line result;
   - top right: the file the agent read or wrote;
   - bottom right: test and program output.

## Afterwards (optional)

Quit Claude (`/exit`), then check the project through the relay. Only one browser can use the profile at a time, so the session must be closed first.
```
cd ~/Projects/rust-compiler-wasm-investigation
python3 -I tests/relay/check-agent.py --project wp38-agent --browser headed
```
Use your project's name instead of `wp38-agent` for other tasks. Remove the registration with `claude mcp remove rust-ide` (in the registered directory).

## Good to know

- **Why a window opens when Claude starts:** Claude Code starts every MCP server registered for the directory when the session begins. The relay then opens Chromium as soon as Claude has connected (MCP `initialize`), so the toolchain is already loaded by the first tool call. With `--browser none` no window opens; the page's URL, with its per-run token, is then in `build/relay/url.txt`.
- The relay listens on 127.0.0.1 only. If port 8790 is busy it takes a free one; the page URL always comes from the relay.
- Projects, the build cache and the toolchain live in the browser profile `build/relay/profile`, so they survive restarts.
- Dependencies come from live crates.io through the relay. Programs run in a sandbox without network, and only the project's files are readable.

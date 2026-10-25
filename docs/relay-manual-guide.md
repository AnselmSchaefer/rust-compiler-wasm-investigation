# Using the browser IDE: by hand, and with your own Claude Code session

Two ways to use the IDE (`app/ide.html`, WP-40):
- **By hand:** `pnpm ide` starts it on its own.
- **With Claude Code:** the relay (`tools/relay/relay.py`, WP-38) as an MCP server, so that the agent builds, tests and runs Rust inside the browser IDE instead of with local `cargo`. You can watch it and work in the same window.

Background and design: `docs/relay.md`. An overview: `README.md`.

## By hand: `pnpm ide`

```
cd ~/Projects/rust-compiler-wasm-investigation
pnpm ide
```

This builds the app (`pnpm build:app`; it needs a toolchain release in `build/release`), then starts the relay without an agent (`relay.py --no-mcp --browser headed`). A Chromium window opens on the IDE at `http://127.0.0.1:8790/ide.html`. The status shows `Ready: rustc 1.99.1-…` once the toolchain has loaded; the first time takes a few seconds longer.

- **First steps:** click **Sample**. The guided project opens with its `README.md` in the editor, which walks through Build, Run (type input in the terminal), Test and Rerun, Clippy, Format, Check and + Dependency.
- **Your own projects:** **New** (`cargo new`), **Import** (a .zip, or `owner/repo` from GitHub), **Export** (a .zip). The editor saves as you type.
- **Stop it:** Ctrl-C in the terminal where `pnpm ide` runs. The window closes with it.
- **Don't run it while a Claude session uses the IDE** (below): both want the same browser profile, and only one Chromium can use it at a time. They share the projects, though: what the agent made is there when you start `pnpm ide` later, and the other way round.

## With Claude Code, once: a directory for it, with the MCP server

The relay serves the IDE from `build/www/app`. If you haven't run `pnpm ide` yet, build the app first (`pnpm build:app` in the repository).

Claude Code registers MCP servers per directory. A directory of its own for these sessions keeps things simple: the IDE is available exactly there, and no project's CLAUDE.md steers the agent. The directory stays empty; the projects live in the browser, not in it.

1. **Create the directory:**
   ```
   mkdir -p ~/Projects/rust-ide-try
   cd ~/Projects/rust-ide-try
   ```
2. **Register the relay as the MCP server `rust-ide`**, from inside that directory. Type it as **one line**, with `python3` and the full path to `relay.py` after `--`:
   ```
   claude mcp add rust-ide -- python3 /home/anselm/Projects/rust-compiler-wasm-investigation/tools/relay/relay.py --browser headed
   ```
   - This writes the server into `~/.claude.json`, under this directory's entry ("local" scope), so it applies only when `claude` runs in `~/Projects/rust-ide-try`.
   - `--browser headed` opens a visible Chromium window. `--browser headless` runs without a window; `--browser none` opens none, and the page's URL is then in `build/relay/url.txt`.
   - Everywhere instead of one directory: add `-s user` before `rust-ide`.
   - Alternative to the command: a file `~/Projects/rust-ide-try/.mcp.json` ("project" scope; Claude Code asks once whether to trust it):
     ```json
     { "mcpServers": { "rust-ide": { "command": "python3", "args": ["/home/anselm/Projects/rust-compiler-wasm-investigation/tools/relay/relay.py", "--browser", "headed"] } } }
     ```
3. **Check the registration**, still in that directory:
   ```
   claude mcp list
   ```
   The line must read `rust-ide: python3 /home/anselm/…/tools/relay/relay.py --browser headed - ✔ Connected`. The check starts the relay briefly and stops it again; it may flash a window.
   - **Only `python3`, without the path:** the command was split over two lines. Fix it with `claude mcp remove rust-ide`, then step 2 again.
   - **✘ Failed to connect:** see "If it doesn't connect" below.
4. **To undo it later:** `claude mcp remove rust-ide` (in that directory), and delete the directory if you like.

## With Claude Code, each time

1. **Don't start `relay.py` yourself, and stop `pnpm ide` first** (Ctrl-C). Claude Code starts its own relay. A relay started by hand opens a window that no agent talks to, and it keeps the browser profile, so Claude's relay can't open its window.
2. Start Claude Code in the registered directory:
   ```
   cd ~/Projects/rust-ide-try
   claude
   ```
   A Chromium window "Rust in the browser" (the IDE) opens, with an "agent" badge. Within a few seconds the "agent" badge turns green ("agent: connected"), and the status shows `Ready: rustc 1.99.1-…, N project(s)`.
3. In Claude, type `/mcp`: `rust-ide` should be connected, with 15 tools. If it failed, choose Reconnect, or `/exit` and start `claude` again.
4. Give a task that names the tools, so the agent doesn't fall back to local `cargo`. For example:
   > Use only the rust-ide tools (the browser IDE), not the shell. Create a project `csv-demo` that parses CSV with the csv crate and serde, add tests, then run cargo_test, cargo_clippy and cargo_fmt, and cargo_run it.

   Or paste `tests/relay/agent-task.md` (the WP-38 task: a seeded compile error, a failing test, a Clippy lint, unformatted code). Allow the `rust-ide` tools when Claude asks, ideally "always".
5. Watch the window, or work in it yourself: it's the IDE (`docs/relay.md`, `README.md`).
   - top: the buttons, and under them the last build's timings, its phases, cached and built units, and totals;
   - left: the project's files (marked: changed by the last few calls);
   - middle: the editor, with the file the agent read or wrote;
   - right: the Terminal, Tests, Problems and Activity tabs (every call, by you or the agent).

## Afterwards (optional)

Quit Claude (`/exit`), then check the project through the relay. Only one browser can use the profile at a time, so the session must be closed first.
```
cd ~/Projects/rust-compiler-wasm-investigation
python3 -I tests/relay/check-agent.py --project wp38-agent --browser headed --profile build/relay/profile --port 8790
```
Use your project's name instead of `wp38-agent` for other tasks. Remove the registration with `claude mcp remove rust-ide` (in the registered directory).

## If it doesn't connect

- **`claude mcp list` shows `python3` without the path, or `/mcp` times out after 30 s:** the registration lost its arguments. `claude mcp remove rust-ide`, then add it again as one line.
- **No window, an IDE without the "agent" badge, or the agent uses local `cargo`:** `pnpm ide` or a relay started by hand is in the way. Stop it (Ctrl-C in its terminal, or `pkill -f tools/relay/relay.py`), then `/mcp` → Reconnect, or `/exit` and `claude` again.
- **The badge says "agent: disconnected, retrying…" or the console shows a 403:** that window belongs to a relay that's gone (its token is no longer valid). Close the window; the current relay opens its own.
- **Claude Code's own log of the server**, with the relay's error messages: `~/.cache/claude-cli-nodejs/-home-anselm-Projects-rust-ide-try/mcp-logs-rust-ide/` (the newest file).

## Good to know

- **Why a window opens when Claude starts** (in the registered directory): Claude Code starts every MCP server registered for the directory when the session begins. The relay then opens Chromium as soon as Claude has connected (MCP `initialize`), so the toolchain is already loaded by the first tool call. With `--browser none` no window opens; the page's URL, with its per-run token, is then in `build/relay/url.txt`.
- The relay listens on 127.0.0.1 only. If port 8790 is busy it takes a free one; the page URL always comes from the relay.
- Projects, the build cache and the toolchain live in the browser profile `build/relay/profile`, so they survive restarts. Browser storage is per origin, and the port is part of the origin: on another port (`--port`, or the fallback when 8790 is busy) the page sees other projects.
- Dependencies come from live crates.io through the relay. Programs run in a sandbox without network, and only the project's files are readable.

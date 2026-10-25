# Agent tool API and local relay (WP-38)

```
agent (Claude Code) ⇄ MCP over stdio ⇄ tools/relay/relay.py ⇄ WebSocket ⇄ app/agent.html in Chromium
                                              │
                                              ├ serves build/www/app and build/release (COOP/COEP)
                                              └ /index/ → index.crates.io (same origin: no CORS problem)
```

The browser does all the work with the toolchain it already has: rustc.wasm with Clippy and rustfmt, the resolver, the build cache, the sandbox. The relay only forwards calls, serves files, and proxies the crates.io index. It's Python 3, standard library only.

## Use it from Claude Code

Step by step, with the pitfalls: `docs/relay-manual-guide.md`.

Build the app once (`pnpm build:app`, which needs a release in `build/release`), then register the relay as an MCP server, e.g. in a project's `.mcp.json`:

```json
{ "mcpServers": { "rust-ide": { "command": "python3", "args": ["/abs/path/to/repo/tools/relay/relay.py", "--browser", "headed"] } } }
```

or `claude mcp add rust-ide -- python3 /abs/path/to/repo/tools/relay/relay.py --browser headed`. The relay starts Chromium (Playwright's, from `node_modules`) on its page: headed to watch, `--browser headless` for unattended runs, `--browser none` to open the printed URL yourself. The profile is `build/relay/profile`, so projects (OPFS), the build cache and the toolchain survive restarts. Options: `--port` (default 8790, or `RELAY_PORT`).

## Tools (`tools/relay/tools.json`)

`project_create`, `project_list`, `project_delete`, `file_list`, `file_read`, `file_write`, `file_delete`, `dependency_add`, `dependency_remove`, `cargo_check`, `cargo_build`, `cargo_run` (args, stdin, timeout), `cargo_test` (filter, exact, include_ignored), `cargo_clippy`, `cargo_fmt` (check).

Results are JSON. Paths are relative to the project. Diagnostics are rustc's JSON (level, code, message, file, line, column, and rendered text without ANSI colours), from fresh compiles and replayed from the cache, as cargo does. Program and test output is cut at 64 KB. A failure without diagnostics (resolving, downloading, a build script) comes as `error`. Bad arguments (unknown project, path with `..`) are tool errors, `isError: true` in MCP.

`tools.json` is the one list: the relay answers `tools/list` from it, and the page (`web/agent/tools.ts`) bundles it and dispatches by name.

## Page side

`app/agent.html` / `app/agent.ts` connects to `ws://127.0.0.1:<port>/relay?token=…` and says hello with its tools and RUSTC_ID. It then runs each call with `AgentTools` (`web/agent/tools.ts`) over the orchestrator worker's operations, one call at a time per project and in order. It shows every call with its arguments and a one-line result, the file a tool read or wrote in a read-only editor, and program and test output in the terminal. After a reload or a lost connection it connects again; the relay fails calls that were in flight ("call the tool again").

New orchestrator operations for it: `check` (WP-27a), `listFiles`, `remove`, and `run` with stdin, a timeout and the project's files readable. `fmt` with `check` now compares rustfmt's output with the file and returns a unified diff (`web/project/diff.ts`), because rustfmt's own `--check` prints its diff to the process's stdout, which the compile server shares with its answers. Builds return `diagnostics` (`web/build/diagnostics.ts`); bundles keep a unit's diagnostics so cache hits replay them.

## Security

- The relay listens on 127.0.0.1 only.
- The page URL carries a random per-run token, and the WebSocket must present it.
- The WebSocket's `Origin` must be the relay's own, because any website could otherwise talk to a localhost WebSocket.
- User programs run only in the sandbox (WP-13): WASI, no network, the project's files readable, a timeout (default 10 s).

## Tests

- `tests/relay/scenario.py`: a scripted MCP client plays the whole scenario through the relay, then checks the WebSocket guard. The steps: project with a serde dependency, seeded compile error found and fixed, failing test found, rerun by name and fixed, Clippy and rustfmt clean, `cargo_run`.
- `tests/relay/agent-run.sh`: the same task (`tests/relay/agent-task.md`) for real Claude Code (`claude -p`), with no built-in tools and only this MCP server, then `tests/relay/check-agent.py` checks the result through the relay. It uses the user's Claude Code plan.
- `scripts/verify/wp-38.sh` runs the scenario headless and headed, plus `agent-run.sh` when `WP38_AGENT=1`.

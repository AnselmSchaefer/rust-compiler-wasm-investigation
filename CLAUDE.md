# Browser Rust IDE: instructions for Claude sessions

This project is built by Claude as the sole developer, one work package (WP) at a time, across separate sessions.

- `REPORT.md`: research background. `PROPOSAL.md`: target design. `PLAN.md`: work packages and the session protocol. `STATUS.md`: live progress.

## At the start of every session
1. Read `STATUS.md`, then the active or next `ready` WP in `PLAN.md`.
2. Follow the session protocol in `PLAN.md` §0 exactly. Work on one WP at a time.

## Rules
- A WP is `done` only when `scripts/verify/wp-XX.sh` passes. Record the measured numbers in `STATUS.md` / `bench/`.
- Long builds run in the background, ≤ 2 h per command, using resumable scripts. Logs go to `build-logs/<wp>/`. Note any running job in `STATUS.md`.
- LLVM/rustc builds: `-j10`, `LLVM_PARALLEL_LINK_JOBS=1` (the machine has 15 GB RAM).
- Stop and ask the user at every **[H]** checkpoint: sudo installs, accounts, spending, deploying, publishing, posting upstream, Safari testing.
- Never publish anything (artifacts, docs, deploys) without being asked. The user wants results as local files and terminal answers.
- If a WP outgrows 4 sessions, split it in `PLAN.md` before continuing. Check the risk triggers in `PLAN.md` §7.
- End every session with `STATUS.md` updated: status, done, exact next step, blockers, human actions.
- The user approved (2026-10-23) committing at the end of each session, per PLAN.md §0 step 5. Never push or publish without asking.

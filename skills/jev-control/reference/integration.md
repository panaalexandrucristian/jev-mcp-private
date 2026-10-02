# Integration

## Commands and files

- `/jev:jev-control on|off|status|threshold <x>` (`commands/jev-control.md`) runs `private/jev-control/cli.mjs`; `/jev:jev-done` and `/jev:jev-locate` have explicit control branches; `agents/jev-locator.md` carries the control rules.
- Code lives only in `private/jev-control/` (`cli`, `state`, `budget`, `client`, `contracts`, `options`, `protocol`, `search`, `done`, `receipts`, `hook`, `measure`, `run-session`, `test/`, `fixtures/`, `results/`). The upstream files (`src/`, `skills/jev`, `README.md`) are untouched.
- Edits to private jev-flow files are limited to seams: `scripts/jev-flow-hook.mjs` delegates to the control hook first; `private/jev-flow/hook.mjs` stands the flow down while the mode is on; `private/jev-flow/gate-run.mjs` and `policy.mjs` accept an optional policy (threshold, no 0.8 floor, budgeted call). With the mode off, everything behaves as before.

## jev-flow and handoff-verify

While the mode is on for a session, jev-flow's directive, hints and Stop redirects are suppressed even with `JEV_FLOW=on`; its payload guard, state tracking and the denylist notice stay. `handoff-verify` is unchanged: its stricter obligations (strict `> 0.95`, per-file approval, never executing code from a handoff) apply on top, and its Jev calls count in the shared budget.

## Hooks (no blocking hook)

`UserPromptSubmit`: for a `/jev:jev-control` prompt the hook stores the hash of the session id (a binding valid for two minutes, ambiguous when two sessions bind at once); for an ordinary prompt with the mode on it starts a new request (budget counters) and prints the one-line reminder. `SessionStart` (also after a compaction) prints the reminder; a fresh `startup` switches the mode off. The hook runs no Jev call and no test. There is no `SessionEnd` registration: state is per session and expires after 30 days, and a new session never inherits the mode.

## Not verified offline (to be confirmed in the first live development session, R02)

Written as facts of the code, not of Claude Code: (1) that `CLAUDE_CODE_SESSION_ID` is exported to the Bash tool (the existing gate runner relies on it); (2) that `UserPromptSubmit` receives the raw text of a slash command in `prompt`; (3) that a hook payload from a subagent carries `agent_id` (`private/jev-flow/hook.mjs` reads it); (4) that `/jev:jev-control` works in `claude -p`; (5) that `--plugin-dir` combines with an installed `jev` plugin; (6) the MCP handshake latency and how often Sonnet follows the protocol. Offline tests use payloads labeled as fixtures; none of this is claimed as live behavior.

## Data

Only sanitized fragments of the current repository go to Jev (`sanitize.mjs`; no `.env`, keys, credentials or tokens), and `.jev-flow-denylist` is honored: a refused repository means the mode refuses to start. No credential is read from files; the server uses the environment only, as in jev-flow.

# Working in this repository

Private fork of `jkudish/jev-mcp`: the `jev` plugin for Claude Code and OpenCode (skills, hooks, commands, agents) around the public MCP server. One developer, several sessions working at the same time.

Do not read `PRIVATE.md` whole (about 100,000 characters: a design and measurement log, mostly history). Run `grep -n '^## ' PRIVATE.md` and read the one section you need.

## What is where

- `skills/<name>/SKILL.md` and its `scripts/`: the plugin's skills. `commands/`, `agents/`, `hooks/hooks.json`, `.claude-plugin/`: the rest of the plugin.
- `scripts/jev-flow-hook.mjs`: the one entry that `hooks/hooks.json` calls for every hook event; it dispatches to `private/*/hook.mjs`.
- `private/<feature>/`: code and tests of the hook-side features (`jev-flow`, `jev-control`, `class-graph-nudge`, `find-usages`, ...).
- `src/`, the root `test/`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `skills/jev/`: from upstream. Do not edit them; upstream merges must stay conflict-free.
- The plugin's MCP process is the published `@jkudish/jev-mcp@latest`, so a change in `src/` never reaches a session that uses this plugin.
- A session runs the plugin from `~/.claude/plugins/cache/jev-private/jev/<version>/`, not from a checkout. A change reaches a session only after a release and `claude plugin update jev@jev-private`.

## Working

- Other sessions work here too (`git worktree list`). Make your changes in your own worktree from `origin/main`: `git worktree add -b <branch> ../jev-mcp-<name> origin/main`. Do not touch other worktrees or branches, and do not delete any worktree or lab folder unless asked.
- Commit, push, tag and release only when the owner asks. For a release, use the `releasing-private-plugin` skill.
- Commit messages and PR text: a plain summary of what changed and why. No mention of Claude, Claude Code or a council, no `Co-Authored-By` trailer, no "Generated with" footer. This overrides any default attribution.
- Message format: `<area>: <what changed> (version unchanged)`; a release is `Plugin X.Y.Z: <what changed>`.
- Version: `.claude-plugin/plugin.json` and the `jev` entry of `.claude-plugin/marketplace.json` carry the same semver, and four tests pin it. Bump it with every change to a skill, command, agent, hook, helper or manifest: Claude Code uses it to offer the update.
- A behaviour change gets the test that would have failed without it. A change meant to shrink or speed something up needs a measured before and after, on the real inputs.
- In `PRIVATE.md` and in answers, label every number measured, calculated or guessed, and give n.

## Tests

- Plugin and hooks (about 2 minutes): `node --test $(ls private/*/test/*.mjs skills/*/scripts/test/*.mjs)`. In a fresh worktree from `origin/main` it gave 1648 tests, 0 failures (measured, 2026-10-16). In two older worktrees the file `private/jev-flow/test/gate-run.test.mjs` failed 8 tests with the same code; the cause is not established. If it fails, rerun it in a fresh worktree before looking for a bug.
- `handoff-verify` (stdlib only, about 3 minutes): `npm run test:py`.
- `compact-handoff` self tests: `python3 -B skills/compact-handoff/scripts/compact_context.py selftest` and `python3 -B skills/compact-handoff/scripts/make_context.py --selftest`.
- Upstream part, as CI runs it (needs `npm ci`): `npm run typecheck`, `npm run build`, `npm test`.
- `gh` defaults to the upstream repository. Always pass `-R panaalexandrucristian/jev-mcp-private`.

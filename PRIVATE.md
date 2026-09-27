# Private Jev plugin mirror

This private repository tracks [`jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp) while adding private packaging for Claude Code and OpenCode. The MCP process still runs the public `@jkudish/jev-mcp@latest` package.

## Repository topology

- `upstream` fetches `https://github.com/jkudish/jev-mcp` and has pushing disabled.
- `origin` points to the private `panaalexandrucristian/jev-mcp-private` repository.
- `main` is the only long-lived private integration branch. Merge upstream into it; never rebase or force-push it.
- The `jev` skill comes from upstream (`skills/jev`, shipped since v0.9.0). This repository adds only the plugin packaging and sync files below, and no upstream-owned file is modified, so upstream merges stay conflict-free.

Branch protection is optional. On private repositories it may require a paid GitHub plan, and required reviews can prevent a sole developer from merging their own synchronization PR.

## Authentication

Configure non-interactive private Git access before installing either plugin:

```sh
gh auth login
gh auth setup-git
```

## Claude Code

Install at user scope:

```sh
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
claude plugin marketplace add panaalexandrucristian/jev-mcp-private
claude plugin install jev@jev-private --scope user
claude plugin list
claude plugin details jev
```

Use `--scope project` or `--scope local` instead when appropriate.

Update or remove it:

```sh
claude plugin marketplace update jev-private
claude plugin update jev@jev-private
claude plugin uninstall jev@jev-private --scope user
```

## OpenCode

Clone the private repository and load the plugin from its directory:

```sh
git clone https://github.com/panaalexandrucristian/jev-mcp-private.git ~/.local/share/jev-mcp-private
```

Add the clone's absolute path to the `plugins` array in `~/.config/opencode/opencode.json` or `opencode.jsonc`. Replace `/Users/you` with your home directory:

```json
{
  "plugins": ["/Users/you/.local/share/jev-mcp-private"]
}
```

Restart OpenCode (`opencode service restart` for the background service), then check:

```sh
opencode plugin list
opencode mcp list
```

Update with `git -C ~/.local/share/jev-mcp-private pull`, then restart OpenCode. Remove it by deleting the path from `plugins`.

Do not use `opencode plugin add 'github:panaalexandrucristian/jev-mcp-private#main'`. On OpenCode 2.0.12 it fails with `NpmInstallFailedError: git dep preparation failed`, because this repository carries the MCP server's npm dependencies. Loading from the directory needs no build, and no `package.json` changes that would conflict with upstream.

The plugin preserves an existing OpenCode MCP server or skill named `jev` instead of replacing it.

## Jev flow

The private plugin also ships `jev-flow`, an adaptive coding workflow on top of the eleven existing Jev tools. It adds no MCP tool and does not modify the upstream `jev` skill. The full contract is in [`skills/jev-flow/reference/workflow.md`](skills/jev-flow/reference/workflow.md); the design is in `docs/jev-flow-design.md`.

| Piece | Claude Code | OpenCode |
| --- | --- | --- |
| Skill | `jev-flow` (auto-selected by description) | `jev-flow` |
| Locate code in an isolated subagent | `/jev:jev-locate <question>` | `/jev-locate <question>` |
| Real checks, `jev_gate`, final report | `/jev:jev-done [criteria]` | `/jev-done [criteria]` |
| Read-only locator subagent | `jev-locator` | `jev-locator` |
| Hooks | `hooks/hooks.json` | `private/jev-flow/opencode.mjs` |

Claude Code picks up `skills/`, `commands/`, `agents/` and `hooks/hooks.json` from the plugin automatically; update the plugin as above. OpenCode loads the flow from `opencode-plugin.js`; `git pull` and restart. If any OpenCode capability is missing, only that feature is disabled and one `[jev-flow]` line is logged; the `jev` MCP server and skill are registered first and keep working unchanged.

Local helpers (Node 22 and Python 3 standard library only):

```sh
node scripts/jev-candidates.mjs --root . --query 'regex flag normalization' --limit 5
git diff HEAD | node scripts/jev-candidates.mjs --sanitize --root .
python3 scripts/jev-flow-metrics.py --session <id> --cli claude|opencode --format markdown
python3 scripts/jev-flow-metrics.py --runs runs.json --format markdown
node private/jev-flow/ab/preflight.mjs
```

The A/B manifest `private/jev-flow/ab/tasks.json` has its oracles marked `not_ready` and no seed; `preflight.mjs` refuses to start the experiment until both are ready.

### Opting a repository out: `.jev-flow-denylist`

Put an optional `.jev-flow-denylist` at the repository root. Syntax is a gitignore subset:

- `#` comments and blank lines are ignored;
- `*` matches within one path segment, `?` one character, `**` any number of directories;
- a leading `/` anchors to the repository root (a pattern with any other `/` is anchored too), otherwise the pattern matches a name at any depth;
- a trailing `/` matches a directory and everything below it;
- matching is case-sensitive, like git;
- there is no `!` negation (such lines are ignored and reported) and no character classes (`[` is literal);
- a line that is exactly `*` disables Jev for the whole repository.

```text
# Never send these to Jev
/secrets/
fixtures/**/customer-*.json
*.sql
```

With `*`, nothing from the repository is sent to Jev: the agent runs the local checks and reports `Jev disabled for this repo; gate not evaluated`. In Claude Code a PreToolUse hook denies Jev calls in that repository, and also any Jev call whose payload contains a recognizable unredacted credential. In OpenCode the same rule throws in `tool.hook("execute.before")`; whether that throw blocks the call on 2.0.12 is not verified. A refused `jev_gate` is recorded first as a failed attempt, so it supersedes an earlier accepted gate; if that record cannot be written (busy lock, permissions, full disk), the call is still refused and a notice names the error code.

These files are always excluded and cannot be re-included by any pattern: `.env`, `.env.*` (including `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*` (including `.pub`), `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `.aws/credentials`, `credentials*.json`, `service-account*.json`, `google-services.json`, `GoogleService-Info.plist`, `local.properties`, `keystore.properties`, `signing.properties`, `*.mobileprovision`.

Diffs, logs and candidate fragments are redacted with `[REDACTED:<kind>]` markers (PEM private keys, AWS, GitHub, `sk-`/`sk-ant-`/`sk-or-`, Slack, Google `AIza`, JWT, `Authorization: Bearer`, and assignments to names such as `api_key`, `secret`, `token`, `password`, `storePassword`, `keyPassword`, `private_key`). Bare assignment values are redacted too (for example `password=huntertwo`), except clear code references such as `options.token`. Diff sections that touch an excluded or denylisted file (Git-quoted paths are decoded), or whose paths cannot be parsed, are dropped entirely. Lines that still look like secrets are omitted and reported. This is best effort: a regex cannot recognize every secret.

### Strict mode: `JEV_FLOW_STRICT`

By default the Claude Code `Stop` hook only shows a notice when code changed without an accepted `jev_gate` on the final snapshot. "Accepted" means the latest gate call of the current request (unfinished, failed and locally refused calls included) returned a complete, consistent `auto` result for exactly the claims it was sent, meeting the flow minimums (confidence and `safe_to_apply` ≥ 0.8, composite ≥ 0.7), with the snapshot unchanged during the call and since. A well-formed `auto` that only misses those minimums is not retried; the agent asks the user. Set `JEV_FLOW_STRICT=1` in the environment that starts Claude Code to let it block such a stop once per snapshot and redirect to `/jev:jev-done`. It honors `stop_hook_active` and never blocks a final message that asks the user a question (last non-empty line ends with `?`), starts its last non-empty line with `Incomplete:`, or contains `Jev unavailable; gate not evaluated` or `Jev disabled for this repo; gate not evaluated`. In OpenCode, strict mode only affects `/jev-done`: the command adds the plugin's gate status for the current snapshot and request and instructs the agent not to report completion without an accepted gate. This is an instruction, not enforcement; nothing blocks a completion message, because OpenCode 2.0.12 offers no hook at that boundary (no equivalent of the Claude Code `Stop` hook).

### Local state and checks

In Claude Code the flow stores metadata only (paths, hashes, ranges, counters, request numbers, timestamps, exit codes) in `~/.cache/jev-flow/<repo-hash>/<session-hash>/`, removed after 30 days. It never stores code, diffs, prompts, logs or Jev verdicts: at `Stop`, the gate verdict is re-read from Claude Code's own transcript, and after a restart the gate is unknown. The OpenCode adapter keeps its state in memory only. Set `JEV_FLOW_CACHE_DIR` to move the cache.

Checks for changes to the flow:

```sh
node --test private/jev-flow/test/
npm test
claude plugin validate .
git diff --stat private-main -- src skills/jev README.md package.json package-lock.json test
```

Known limitations: the state lock is never broken automatically, not even when its owner process is gone; until it is removed the flow treats the session state as unknown and never approves, and the `Stop` notice names the lock file (after checking that no hook of that session is running, delete `~/.cache/jev-flow/<repo-hash>/<session-hash>/lock`, or the same path under `JEV_FLOW_CACHE_DIR`, by hand); OpenCode V2 registration, hooks and permissions are feature-detected but not verified at runtime; OpenCode commands are registered only when `command.list` lets the plugin rule out name collisions; the locator's OpenCode permissions are not set; OpenCode strict mode is an instruction only; Claude Code test results are normally unknown because the Bash tool response has no exit code; Claude Code behavior beyond `claude plugin validate` needs a live smoke test on 2.1.283.

## Provider configuration

Neither plugin stores provider credentials. The Jev MCP process inherits its environment, including supported variables such as:

- `JEV_PROVIDER`
- `JEV_MCP_MODEL`
- `OPENROUTER_API_KEY`
- `TYPESAFE_API_KEY`

Set these outside the plugin. Do not add secrets to either manifest.

## Synchronizing upstream

### Manual synchronization

From a clean `main` branch with the configured `upstream` and `origin` remotes:

```sh
scripts/sync-upstream.sh
```

The script fetches upstream commits and tags, fast-forwards from private `origin/main`, and merges `upstream/main`. It never pushes. On conflict, inspect and resolve the merge, run the printed checks, and push `main` and tags manually.

### Scheduled synchronization

The `Sync upstream` workflow runs every Monday at 06:17 UTC and can be dispatched manually. It mirrors upstream tags, merges new commits into a `sync/upstream-<sha>` branch, runs the repository checks, and opens or updates a pull request to `main`. It never pushes a merge directly to `main` and never auto-merges.

Enable the repository setting that allows GitHub Actions to create pull requests.

The workflow normally uses `GITHUB_TOKEN`. If upstream changes `.github/workflows`, add a fine-grained repository secret named `SYNC_TOKEN` with contents, pull-request, issues, and workflow-file permissions. Without it, the workflow fails rather than dropping those changes.

Merge conflicts and missing workflow permissions create or update the single issue `Upstream sync needs manual action`. Follow its recorded SHA and recovery instructions, or run:

```sh
git switch main
scripts/sync-upstream.sh
# Resolve conflicts if necessary.
npm ci
npm run typecheck
npm run build
npm test
git push origin main
git push origin --tags
```

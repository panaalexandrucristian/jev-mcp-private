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

## Handoff verification

The private plugin also ships `handoff-verify` (`skills/handoff-verify/`, `jev:handoff-verify` in Claude Code). It loads automatically when you ask Claude Code to write, update or check a handoff/handover note, and verifies the note against the session transcript with Jev: lost details (omissions) and wrong facts (decisions, numbers, dead paths, stale state). A finding counts only with a bound Jev result above 0.95; anything Jev cannot settle above that threshold is reported as UNRESOLVED, never as PASS. It never executes code from a handoff and sanitizes text before sending it to Jev. Worked examples are in `skills/handoff-verify/examples/`.

It is Claude Code only: it reads Claude Code session transcripts, and the OpenCode plugin does not register it. It needs `python3` and accepts the Jev tools under either name (`mcp__jev__*` from a direct MCP config, `mcp__plugin_jev_jev__*` from this plugin).

Measured in the sealed final evaluation (7 headless sessions on new synthetic fixtures, Claude Sonnet, 10 notes each): triggered on 7/7 handoff requests and 0/28 unrelated ones; omissions confirmed 8/12 (RO) and 3/9 (EN), the rest UNRESOLVED; fact defects 22/28; 0 false alarms on paraphrases and clean notes; 0 invalid PASS. Blocker omissions (0/7) and stale state (2/7) are the weak spots, because Jev scores them near the threshold. The small sample is synthetic and was not measured on real handoffs. The development history and the evidence are in the separate `handoff-skill-lab` repository (`results/SUMMARY.md`). The plugin-prefix support was added after that evaluation and has unit tests only.

## Jev flow

The private plugin also ships `jev-flow`, an adaptive coding workflow on top of the eleven existing Jev tools. It adds no MCP tool and does not modify the upstream `jev` skill. The full contract is in [`skills/jev-flow/reference/workflow.md`](skills/jev-flow/reference/workflow.md); the design is in `docs/jev-flow-design.md`.

| Piece | Claude Code | OpenCode |
| --- | --- | --- |
| Skill | `jev-flow` (route directive injected on every prompt) | `jev-flow` (same directive through the `context` hook) |
| Locate code in an isolated subagent | `/jev:jev-locate <question>` | `/jev-locate <question>` |
| Real checks, `jev_gate` (through the gate runner), final report | `/jev:jev-done [criteria]` | `/jev-done [criteria]` |
| Read-only locator subagent | `jev-locator` on `haiku` | `jev-locator` (inherits, or `JEV_FLOW_LOCATOR_MODEL=provider/model`) |
| Hooks | `hooks/hooks.json` | `private/jev-flow/opencode.mjs` |

Claude Code picks up `skills/`, `commands/`, `agents/` and `hooks/hooks.json` from the plugin automatically; update the plugin as above. OpenCode loads the flow from `opencode-plugin.js`; `git pull` and restart. If any OpenCode capability is missing, only that feature is disabled and one `[jev-flow]` line is logged; the `jev` MCP server and skill are registered first and keep working unchanged.

Local helpers (Node 22 and Python 3 standard library only):

```sh
node scripts/jev-candidates.mjs --root . --query 'regex flag normalization' --limit 5
git diff HEAD | node scripts/jev-candidates.mjs --sanitize --root .
node scripts/jev-gate-run.mjs --root . --list-hunks
node scripts/jev-gate-run.mjs --root . --claims /tmp/claims.json --check '["npm","test"]'
git diff HEAD | node scripts/jev-gate-payload.mjs --list-hunks --root .   # diagnostics
node scripts/jev-gate-payload.mjs --root . < /tmp/jev-gate-input.json     # diagnostics
python3 scripts/jev-flow-metrics.py --session <id> --cli claude|opencode --format markdown
python3 scripts/jev-flow-metrics.py --runs runs.json --format markdown
node private/jev-flow/ab/preflight.mjs
```

The A/B manifest `private/jev-flow/ab/tasks.json` has its oracles marked `not_ready` and no seed; `preflight.mjs` refuses to start the experiment until both are ready.

### Activation and settings

By default, in every session and repository where Jev is enabled, the Claude Code hooks add a short route directive at session start and on every prompt (load `jev-flow`, delegate broad discovery to `jev-locator`, finish code changes with `/jev:jev-done`), and repeat the delegation directive at every 4 exploration calls in a request (4, 8, 12, …). This replaced the earlier advisory default after the Android A/B runs, where the advisory plugin produced no Jev calls and no subagents (`docs/jev-flow-findings.md`, F1). OpenCode sends the same directive through its `context` hook. Blocking stays opt-in (`JEV_FLOW_STRICT`, below).

| Variable | Effect |
| --- | --- |
| `JEV_FLOW=on` | Opt-in switch (also `1`/`true`). Without it: no directive, hints or `Stop` notices/redirects, even with `JEV_FLOW_STRICT=1`. The credential and denylist guard is always active. `/jev:jev-locate`, `/jev:jev-done` and the gate runner stay available on demand. |
| `JEV_FLOW_STRICT=1` | `Stop` redirects once per snapshot to `/jev:jev-done` (below). |
| `JEV_FLOW_LOCATOR_MODEL` | Claude Code: `haiku` (the default in `agents/jev-locator.md`), `sonnet`, `opus` or `inherit` (the parent's model); applied to each `jev-locator` delegation by a `PreToolUse` hook through `updatedInput`. An invalid value is ignored with one notice. OpenCode: `provider/model[#variant]`; unset or invalid, the locator inherits the parent model and the setup notes it once. A configured model is not a cost guarantee: inheriting is fine when the parent already runs the cheapest model. |

`/jev:jev-done` runs the **gate runner** `scripts/jev-gate-run.mjs`: the model writes only claims with evidence ids; the runner collects the diff against the session baseline (new non-ignored files included), runs the `--check` commands itself, reads the cited excerpts, pairs every claim with its own evidence, splits a patch that exceeds one `jev_gate` call into a batch of parts, calls `jev_gate` itself through the jev MCP server on stdio for every part of the batch (only a contradicted claim stops it early) and prints one aggregated report (at most 8 KB): a semantic `verdict`, an operational `status`, the `outcome` that decides the exit code, per-part and per-claim verdicts and the coverage; the agent answers once from it, without re-running for a more favourable verdict (round 3, R5). Payloads never pass through the model (`docs/jev-flow-findings.md`, round 2, R1). Completion needs every part accepted on the same snapshot, and the report says when verification was partitioned. The candidate helper runs `jev_rerank`/`jev_find` the same way when the ranking rule applies (R3) and prints only up to 5 compact hits (path, lines, sha256, score, reason; at most 4 KB), in lexical order marked as not semantically ranked when Jev is unavailable; the locator has no Jev tool, and the parent keeps doing independent work while it runs, in the background when the CLI allows it (round 4, R7). `--full` prints the helper's whole diagnostic object (candidates, map, payload) for tests and debugging only. The hooks hint whenever a read or grep repeats what the locator already returned (R2).

| Runner setting | Effect |
| --- | --- |
| `JEV_FLOW_MCP_COMMAND` | The jev MCP server command as a JSON argv array (no shell), for example `["node","/path/to/dist/index.js"]`. Default: `["npx","-y","--package=@jkudish/jev-mcp@latest","jev-mcp"]`, as in `.claude-plugin/plugin.json`. |
| Credentials | Inherited from the environment only (never read from `~/.claude.json`): `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY` + `JEV_API_BASE_URL`, a Cloudflare token + `CLOUDFLARE_ACCOUNT_ID`, or `AI_GATEWAY_API_KEY`. With `OPENROUTER_API_KEY` and no `JEV_PROVIDER`, the server gets `JEV_PROVIDER=openrouter`. None: `Jev unavailable; gate not evaluated` (exit 3). |
| Limits | Handshake 120 s, each call 300 s, 8 MiB per server message (a larger message, complete or not, ends the session); checks 900 s by default (`--check-timeout`), at most 8, output kept as the first 8,000 + last 32,000 characters with a visible cut marker; excerpts at most 400 lines; summary at most 8,192 characters (per-occurrence detail dropped first; overall claim verdicts and counters always kept); after a part fails for good, one reconnection for the next part. |
| Checks | `--check` takes a JSON array of strings, run as argv without a shell (`'["npm","test"]'`). Any check that exits non-zero, times out, cannot start or has an unknown exit code prevents acceptance (`checks_failed`), whatever Jev answers; the receipt records every check and `Stop` re-checks them. |
| Retries | One retry with identical input after a transport failure, a JSON-RPC invalid response or a result the flow rejects as invalid (`interpretGate` route `retry_or_unavailable`; for rankings, an unusable `jev_rerank`/`jev_find` answer); a closed server is reconnected for it, or the retry is reported as not executed. A contradiction or a valid answer below the thresholds is never retried. |
| Exit codes | `0` accepted, `2` review/escalate/contradicted/checks failed/not accepted, `3` unavailable or disabled, `4` invalid input or not ready, `1` internal error. |

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

### Plugin version

`.claude-plugin/plugin.json` and the `jev` entry in `.claude-plugin/marketplace.json` carry the private plugin's own semver (`0.1.0` for the F1–F5 fixes, `0.2.0` for the gate runner, `0.3.0` for the aggregated gate report of round 3, R5/R6, `0.4.0` for the mechanical locator rerank of round 4, R7, `0.5.0` for the opt-in flow, `0.6.0` for the `handoff-verify` skill), independent of the upstream `package.json` version (which stays untouched). Bump both, to the same value, with every change to the private plugin (skills, commands, agents, hooks, helpers, manifests): Claude Code uses the version to offer the update.

### Local state and checks

In Claude Code the flow stores metadata only (paths, hashes, ranges, counters, request numbers, timestamps, exit codes) in `~/.cache/jev-flow/<repo-hash>/<session-hash>/`, removed after 30 days. It never stores code, diffs, prompts, logs or Jev responses: at `Stop`, a direct gate verdict is re-read from Claude Code's own transcript, and after a restart the gate is unknown. The OpenCode adapter keeps its own state in memory. Set `JEV_FLOW_CACHE_DIR` to move the cache.

The gate runner adds, in both CLIs, a per-session secret `receipt.key` (0600, created at session start, never printed), `baseline.json` (HEAD and the paths already changed at session start, with content hashes) and signed receipts `receipts/<id>.json`. A receipt covers the whole batch and holds metadata only (snapshot and diff hashes, request and attempt ids, per-part numbers, actions or states and verdict codes, coverage counters, the aggregated verdict, status and outcome, claim hashes, check command hashes and exit codes, timestamps) and an HMAC-SHA256; `Stop` and the OpenCode gate status count a runner result only when its receipt verifies for the current session, request, attempt and snapshot. **Threat model:** this stops a model from inventing, editing or replaying a gate result. A process running as the same user that can read the key or modify the runner, the cache or the server is out of scope.

Checks for changes to the flow:

```sh
node --test private/jev-flow/test/
npm test
claude plugin validate .
node -e "import('./opencode-plugin.js').then(m=>console.log(typeof m.default.setup))"
git diff --stat private-main -- src skills/jev README.md package.json package-lock.json test
```

Known limitations: the state lock is never broken automatically, not even when its owner process is gone; until it is removed the flow treats the session state as unknown and never approves, and the `Stop` notice names the lock file (after checking that no hook of that session is running, delete `~/.cache/jev-flow/<repo-hash>/<session-hash>/lock`, or the same path under `JEV_FLOW_CACHE_DIR`, by hand); OpenCode V2 registration, hooks and permissions are feature-detected but not verified at runtime; OpenCode commands are registered only when `command.list` lets the plugin rule out name collisions; the locator's OpenCode permissions are not set, so in OpenCode its lack of Jev tools and its background launch are instructions only (one setup diagnostic says so); OpenCode strict mode is an instruction only; Claude Code test results are normally unknown because the Bash tool response has no exit code; Claude Code behavior beyond `claude plugin validate` needs a live smoke test on 2.1.283.

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

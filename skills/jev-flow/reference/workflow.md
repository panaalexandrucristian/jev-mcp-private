# jev-flow reference

Step contracts, fallback rules, local helpers and the implementation decisions behind the `jev-flow` skill. Values in `<...>` are documentation placeholders: replace them with the real request, fragments and results; never send a placeholder or invent logs.

## 1. Step contracts

The order is logical, not mandatory. Skip steps the task does not need; after any code change, steps 5 and 7 are required (see §3 for the only exceptions).

### Step 0 — Triage

Only for a genuinely ambiguous route or a real batch; otherwise triage locally. The user's request outranks the classification; a `review` decision means manual triage.

```json
{"items":[{"id":"task","text":"<request>"}],"classes":[{"id":"inspect","description":"Read-only investigation; no implementation requested."},{"id":"change_known","description":"Code change with concrete affected files already identified."},{"id":"discover_then_change","description":"Code change requiring discovery of implementation locations."}],"purpose":"Choose the investigation route"}
```

Tool: `jev_classify`. Read `classification`, `decision`, `margin`.

### Step 1 — Isolated location

When files are unknown or several results are semantically ambiguous. Skip for an exact known path or symbol. The parent delegates to `jev-locator` (`/jev:jev-locate` in Claude Code, `/jev-locate` in OpenCode). The child runs the helper (§4), then:

```json
{"query":"<behavior sought>","candidates":[{"id":"c0","text":"<path:start-end + fragment>"}],"top_k":5}
```

Tool: `jev_find` (or `jev_rerank` with the same shape, always with `top_k`, when the order of several results matters). Read `exists_verdict` and `top` (`ranked` for rerank). `absent` covers only the submitted candidates.

### Step 2 — Hypotheses and evidence

When checkable claims about a cause exist. Skip when reproduction and cause are already clear.

```json
{"claims":["<concrete hypothesis>"],"evidence":[{"id":"code","text":"<real fragment>"},{"id":"repro","text":"<real reproduction output>"}]}
```

Tool: `jev_verify` → `verified` / `contradicted` / `unsupported`; `unsupported` asks for new evidence. For probabilities (prioritization, never proof):

```json
{"propositions":["<hypothesis to prioritize>"],"context":"<observations>"}
```

Tool: `jev_noul`. It may order what to investigate; it never justifies skipping tests.

### Step 3 — Bounded decision

2–6 plausible mechanisms and explicit priorities that change the choice. Skip for mechanical edits or one obvious solution. Candidate ids must match `^[a-z][a-z0-9_-]*$`.

```json
{"decision":"<the choice>","evidence":"<facts and measurements>","priorities":"<user priorities>","candidates":[{"id":"a","description":"<mechanism A>"},{"id":"b","description":"<mechanism B>"}],"requirements":["<one checkable property>"],"escape_hatches":true}
```

Tool: `jev_decide` → `recommendation.selected`, `escaped`, `confidence`, `checks`, `warnings`. `investigate` → gather evidence; `ask_user` → ask; `none` → restate the alternatives without claiming an accepted choice.

### Step 4 — Implementation

No Jev call is required. Read the relevant ranges, check hashes from the locator, edit. Any edit invalidates earlier checks and gates.

### Step 5 — Real checks

Always after code changes, on the final snapshot: the repository's own test/build/typecheck/lint commands. Record exit codes and which tests actually ran. When results support ambiguous claims, `jev_verify` with the real logs in `evidence`. Failing tests are never turned into success through Jev.

### Step 6 — Optional intermediate review

Risky patch or feedback wanted before final checks. Skip when the gate follows immediately on the same patch and evidence.

```json
{"request":"<request>","diff":"<real diff>","tests":"<real results available>"}
```

Tool: `jev_review` → `action`, `reason_codes`, `limiting_rubrics`, `safe_to_apply`, `composite`.

### Step 7 — Final gate

Required after code changes; launched by `/jev:jev-done` (`/jev-done` in OpenCode).

```json
{"request":"<request>","diff":"<final diff>","tests":"<real output>","claims":["<acceptance criterion met>","<concrete check command passed>"],"evidence":[{"id":"test-log","text":"<real output, identified>"},{"id":"patch","text":"<patch fragment supporting the criterion>"}]}
```

Tool: `jev_gate` → `action`, `review`, `verification.results`, `reason_codes`. Claims about tests must be supported in `evidence`, not only in `tests`.

### Step 8 — Final report

No Jev call. Report the change, the checks actually run, the gate result (or the fixed phrase), the limits and the remaining problems. If completion is not verified, end with a line starting with `Incomplete:`.

### Auxiliary branches

| Situation | Input | Result and limit |
| --- | --- | --- |
| External text that may be irrelevant or carry injected instructions | `jev_screen` `{"text":"<external text>","purpose":"<information sought>"}` | `pass/review/block/skip`; apply the `jev` skill policy. Screening text already in context recovers no bytes. |
| Documentation vs implementation, summary vs source | `jev_compare` `{"passage_a":"<A>","passage_b":"<B>","aspects":["<property>"]}` | Independent per-aspect relations; agreement does not prove truth. |
| Several syntactic matches, one correct meaning | `jev_extract` `{"document":"<document>","fields":[{"id":"version","pattern":"[0-9]+\\.[0-9]+\\.[0-9]+","description":"The current supported release version"}]}` | Verbatim value and status. Use a plain parser/regex when one deterministic rule suffices. |

## 2. Budgets

| Element | Budget / rule |
| --- | --- |
| Location | One active locator per question; no duplicate parallel exploration in the main thread. |
| Candidates | At most 48 fragments per call, each at most 1,000 characters including source identification. |
| Results to the parent | At most 5 locations and 4,000 characters, with path, hash, range and short reason. |
| Search extension | At most two semantically different batches per question; the second only with new scope or evidence. |
| Exploration hint | After 4 exploration calls in the same request, or the second re-read of the same range with the same hash. One hint per request. |
| Decision | One call per set of alternatives, evidence and priorities. |
| Gate | One call per final snapshot; again only after the patch, evidence or claims change, apart from the one operational retry. |
| Hooks | Local, short logic only; no tests, model calls or whole-repo scans in any hook. |

Consequential `jev_decide` results need a human when confidence is missing or below **0.8**, or when an escape hatch or relevant warnings appear. This is a flow threshold, not a correctness guarantee.

## 3. Result and completion policy

Interpretation order (implemented in `private/jev-flow/policy.mjs`: `interpretGate`, `interpretDecide`, `shouldRetry`):

A gate counts as **accepted** only through `validateGateResult`, shared by both adapters, and only for the claims actually sent in that call. Required: `tool` is `jev_gate`, `action` is `auto`, `truncated` is `false`, `reason_codes` is exactly `["accepted"]`. Review: `action` `auto`, `reason_codes` exactly `["accepted"]`, no `status`; thresholds in [0,1] with `review_at` ≤ `auto_accept`; all four rubrics (`correctness`, `spec_match`, `test_gap`, `blast_radius`) present with a score in [0,2], a probability distribution that is either `null` (not reported by the provider, valid upstream) or a valid `0/1/2` distribution whose expected value matches the score within the upstream `SCORE_MEAN_TOLERANCE` (0.02 + 1e-12), and confidence ≥ max(`auto_accept`, 0.8); `composite` in [0,1], equal (±1e-6) to the weighted rubric composite of `src/lib.ts` and ≥ max(`composite_floor`, 0.7); `safe_to_apply` ≥ max(`auto_accept`, 0.8). Verification: `action` `auto`; thresholds in [0,1] with `review_at` ≤ `auto_accept`; one result per call claim, in order, with the identical claim text (a claim longer than the tool's 2,000-character cap was truncated by the tool and is not accepted); each result `verified`, action `auto`, no `status`, a valid `verified/contradicted/unsupported` distribution whose argmax is `verified`, and confidence ≥ max(`auto_accept`, 0.8); the summary counts equal the results (all verified, zero contradicted, unsupported, needs-review and invalid). The flow minimums (0.8 / 0.8 / 0.7) apply even if the call lowered its thresholds. `validateGateResult` returns `{accepted, problems, malformed, below_flow_minimum}` and separates two kinds of non-acceptance: a **malformed** `auto` (bare, partial, out of domain, internally inconsistent, a value below the call's own threshold, or not tied to the call's claims) is treated like an invalid response (`retry_or_unavailable`); a **well-formed** `auto` that only misses the flow minimums (a value that satisfies the call's own lowered threshold but not 0.8 / 0.8 / 0.7) is not retried and routes to `ask_user`, with the misses listed in `below_flow_minimum`.

1. **Valid contradicted claim** → stop and ask the user with verdict and numbers. An invalid answer elsewhere does not cancel it.
2. **Transport or `invalid_response`** → one logical retry with identical input. If it fails: continue the real checks and report **`Jev unavailable; gate not evaluated`**. Never record `auto`. No retry after a user cancellation.
3. **Well-formed `auto` below the flow minimums** → ask the user, with the numbers; no identical re-call (`interpretGate` route `ask_user`).
4. **Semantic `review` / low confidence on a routine step** → manual inspection, then justified continuation; no identical re-call.
5. **Gate `escalate` or low confidence; inconclusive consequential decision** → stop and ask. A `review` caused only by missing evidence (`claims_unsupported` / `incomplete_context`) may be resolved with new evidence and a new call; otherwise completion is not declared.
6. **Valid `auto`** → applies only to the evaluated snapshot and claims.

The flow retry is distinct from the transport's internal HTTP retries (local transports may try up to three times); report them separately when known. A pre-existing `jev` server configuration is never changed.

**Opt-out.** `.jev-flow-denylist` with a `*` line means: no data to Jev, run local checks, report **`Jev disabled for this repo; gate not evaluated`**.

**Large patches.** Split the review into parts and state the global limits; a gate on a summary is not evidence that the whole patch was evaluated.

## 4. Local helper: `scripts/jev-candidates.mjs`

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-candidates.mjs" --root "<repo-root>" --query "<query>" --limit 48 --chunk-chars 1000
```

Flags: `--root`, `--query` (required); `--limit` 1–48 (default 48); `--chunk-chars` 200–1000 (default 1000); `--window-lines` 1–60 (default 60); `--max-file-bytes` (default 1 MiB). Exit codes: `0` success, `2` usage error or a root outside a git work tree, `3` sanitize input too large, `1` unexpected error. Errors are JSON on stderr.

Output (one JSON line on stdout):

```json
{
  "query": "<query>", "root": "<git top level>", "scope": ".", "terms": ["<stemmed terms>"],
  "limits": {"limit": 48, "chunk_chars": 1000, "window_lines": 60, "max_file_bytes": 1048576},
  "disabled": false,
  "candidates": [{"id": "c0", "text": "src/example.ts:20-48\n<redacted fragment>"}],
  "map": {"c0": {"path": "src/example.ts", "sha256": "<full-file sha256>", "start_line": 20, "end_line": 48, "kind": "window"}},
  "coverage": {"complete": false, "reasons": ["candidate_limit_reached"], "files_listed": 40, "files_considered": 40, "files_matched": 16, "windows_total": 40, "skipped": {"ignored": 0, "excluded": 0, "denylisted": 0, "symlink": 0, "outside_root": 0, "not_regular": 0, "missing": 0, "binary": 1, "too_large": 0, "invalid_utf8": 0, "unreadable": 0}, "denylist_unsupported": [], "note": "..."},
  "omitted": [{"path": "<path>", "start_line": 1, "end_line": 20, "reason": "suspicious_content"}]
}
```

Only `candidates` (`{id, text}`) goes to `jev_find` / `jev_rerank`. The `map` stays local.

Decisions (delegated to the executor, ratified in review):

- **Discovery.** `git ls-files -z --cached --others --exclude-standard [-- <scope>]` through `execFile` with separate arguments; the query is never evaluated by a shell. Tracked files that match ignore rules are listed with `git ls-files --cached --ignored --exclude-standard` and skipped (`skipped.ignored`), because `--exclude-standard` alone keeps them. Tracked, staged, modified and new non-ignored files are included; deleted files are skipped (`missing`). A `--root` below the git top level restricts the scope to that subtree; paths are relative to the top level.
- **Symlinks.** Every symlink is skipped (counted as `symlink`); an in-repo target is indexed under its own path. Files whose real path leaves the repository are skipped (`outside_root`).
- **Exclusions** (§6) are applied before any content is read.
- **Files.** Larger than `--max-file-bytes` → skipped, coverage incomplete. A NUL byte in the first 8,000 bytes → binary, skipped (does not make coverage incomplete). Invalid UTF-8 → skipped, coverage incomplete. Lines longer than 4,000 characters are not scored.
- **Tokenization.** Lowercase words; camelCase, snake_case, kebab-case and digits split; English stopwords and generic words (`code`, `file`, `find`, `implementation`, `logic`) dropped; a deterministic suffix stemmer (`normalization`, `normalized`, `normalize` → `normal`; `flags` → `flag`).
- **Ranking.** File score = 3 × distinct query terms in the path + Σ min(term hits, 10) + 5 × distinct terms matched. Hit lines closer than `--window-lines` form a cluster; the window (≤60 lines) is centred on the line with the most distinct terms. Window score = file score + 10 × distinct terms in the cluster + hits. Ties: path, then start line. Files matched only by path get a lexical outline candidate (declaration-looking lines, `L<n>: <text>`), never an AST claim.
- **Redaction and provenance.** Each file is redacted once, as a whole, before any fragment is cut (§6). Redaction keeps the line count (a multi-line PEM block becomes one marker line followed by empty lines), so `start_line`/`end_line` in the map always name the original source lines. A fragment still suspicious after redaction is dropped and listed in `omitted` (coverage reason `windows_omitted`).
- **Budget.** Every candidate, including the `path:start-end` header, outline and path-only entries, is at most `--chunk-chars` characters after redaction. Window lines are dropped from the edge farthest from the anchor until it fits; a single over-long line is cut with `[…line truncated]` (coverage reason `long_lines_truncated`). An outline or path-only entry whose path alone exceeds the budget is omitted with reason `path_exceeds_budget`.
- **Coverage.** `complete` is false when the candidate limit cut windows, files were too large/unreadable/invalid UTF-8, the 20,000-file or 10-second budget stopped the scan, fragments were omitted or lines truncated. It is a lexical preselection, never an exhaustive inventory.
- **Concurrent changes.** Each fragment and its sha256 come from the same read buffer. A file changed afterwards is detected by the parent's hash check.
- **No persistence.** The helper writes nothing to disk.

### Sanitize mode

```sh
git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-candidates.mjs" --sanitize --root . [--mode auto|text|diff]
```

Reads stdin (at most 2 MiB; larger input exits `3`, split it). Output: `{"disabled": false, "mode": "diff"|"text", "text": "<sanitized>", "redactions": [{"kind": "...", "count": n}], "omitted": [{"path": "...", "reason": "permanent_exclusion"|"denylisted"|"unparseable_provenance"}], "omitted_lines": n}`. With a `*` denylist: `{"disabled": true, "reason": "Jev disabled for this repo; gate not evaluated", "text": ""}`.

- `auto` treats input containing a `diff --git ` (or `diff --cc`/`diff --combined`) line as a diff.
- Diff mode splits the input into file sections. For each section it collects every path it names from its header area (before the first `@@`): the `diff --git` header, `---`/`+++` lines, `rename from/to`, `copy from/to` and `Binary files … differ`. Git C-style quoting is decoded, including octal escapes of UTF-8 bytes; each path is checked both as written and without its `a/`/`b/` prefix. A section is dropped entirely, replaced by `[OMITTED:<reason>]`, when any path is permanently excluded or denylisted, or when its provenance cannot be parsed (invalid quoting, ambiguous header with no other path lines). The path appears only in `omitted`, not in the sanitized text. The kept text is then redacted.
- Every mode redacts recognizable credentials and replaces lines that remain suspicious with `[OMITTED:suspicious_content]`.
- The sanitizer never reads `.env` to learn secret values.

## 5. Hooks and snapshots

### Snapshot

`computeSnapshot()` in `private/jev-flow/state.mjs` hashes content only; mtime is never used:

- `HEAD`, and the sha256 of `git diff HEAD --binary` (staged, unstaged and deleted tracked changes, renames included). In a repository without commits: the index against the empty tree (`git diff --cached`) plus the work tree against the index (`git diff`), so unstaged edits of added files count.
- Every untracked, non-ignored file, hashed by reading it incrementally (no size cutoff; symlinks by their target string). If any file cannot be read, or the total hashed exceeds 1 GiB, the snapshot is **unknown** (`hash: null`).
- Every checked-out submodule's own snapshot, computed recursively (depth ≤ 4); `git diff` itself only reports submodule commit changes. A submodule directory that is not a work tree makes the snapshot unknown; an empty (not checked out) one is recorded as such.
- The `.jev-flow-denylist` content (an unreadable denylist makes the snapshot unknown) and the permanent exclusion list.

Ignored files are out of scope. The snapshot is content-based: staging identical content does not change it. An unknown snapshot never allows a gate to count.

- The **baseline** is the snapshot at the first `SessionStart`; changes present then are pre-existing and not claimed as this session's work. "Code changed" means the current snapshot differs from the baseline (or is unknown).
- Snapshots are computed only at boundaries: session start, before and after a test command, before and after `jev_gate`, and at `Stop`. Ordinary hooks stay short.
- **Real checks** are tracked per command (a hash of the normalized command line). They count as passing on the current snapshot only when no check is still running and the latest run of every check command in this session boot exited 0 (not failed), with known, equal snapshots before and after that equal the current one. A later failed or unknown rerun of a command cancels its earlier success. Claude Code's Bash tool response carries no exit code, so a run observed through `PostToolUse` is recorded with an unknown result (never success); a run reported through `PostToolUseFailure` is recorded as failed.
- A **gate** counts as accepted only when all of this holds: its call is the latest gate *attempt* of this session boot by start time, where attempts include calls that started and never finished (still pending or cancelled), calls that failed, and calls refused by the flow's own `PreToolUse` guard (recorded as failed and `denied` before the refusal is returned, because no Post event follows a denied call); its request is the one current when the call *started* (a new user prompt, even before the call finishes, makes it another request's call); its pre-call snapshot (from `PreToolUse`, with the same input hash) and post-call snapshot are both known and equal; that snapshot equals the current one; and its result, re-read from the native transcript, passes `validateGateResult` for the claims in the transcript's `tool_use` input (§3). Any later attempt that is not accepted supersedes an earlier accepted one. As a second check that does not depend on any state write, the transcript re-read also rejects the candidate when any later `jev_gate` `tool_use` (denied, cancelled or otherwise) follows it in the main transcript (`later_gate_call_in_transcript`).

### Claude Code (`hooks/hooks.json` → `scripts/jev-flow-hook.mjs` → `private/jev-flow/hook.mjs`)

| Event | Behavior |
| --- | --- |
| `SessionStart` | Retention cleanup; baseline snapshot; on `startup`/`resume`, previous gate records are discarded and the boot counter increases, so a restart always starts with an unknown gate. Context message only when the denylist disables Jev. |
| `UserPromptSubmit` (added: needed to delimit requests) | Starts a new request: increments the request number and resets the exploration counter, re-read tracking and the one-hint flags. |
| `PreToolUse` on `mcp__(plugin_jev_)?jev__jev_.*` | Denies (`permissionDecision: "deny"`) when `.jev-flow-denylist` has `*`, or when any string in the payload holds a recognizable unredacted credential; the reason names the credential kinds, never values. A refused `jev_gate` is first recorded as a completed, failed attempt `{id, req, boot, input, before: "unknown", after: "unknown", ts, failed: true, denied: true}` (metadata only); the refusal is returned even if that write fails for any reason (busy lock, `EACCES`, `ENOSPC`, …); the output then adds a `systemMessage` naming only the error code and stating that the state was not updated (no payload, no claim of persistence), and the transcript check at `Stop` remains the fallback. For an allowed `jev_gate`, opens a pending attempt with the pre-call snapshot, input hash, request number, boot and start time. |
| `PreToolUse` on `Bash` (added: test freshness) | For commands classified as tests, opens a pending run with the pre-run snapshot, command hash, request number, boot and start time. Never blocks. |
| `PostToolUse` | Main thread only for hints (`agent_id` present = subagent → no hints, avoiding delegation loops). Counts exploration (`Read`, `Grep`, `Glob`, `LS`, exploration-classified `Bash`); after the 4th call, or the second re-read (third read) of the same path and range with the same content hash, emits one hint per request pointing to `/jev:jev-locate`. After the first edit or test in a request, one hint pointing to real checks and `/jev:jev-done`. For `jev_gate`, records correlation metadata only (§7). For tests, records snapshots and the exit code when the response states one. |
| `PostToolUseFailure` on Jev tools and `Bash` (added: failed attempts) | Closes a pending `jev_gate` attempt or test run as failed, so it supersedes earlier successes. Never blocks, never approves. |
| `Stop` | Re-reads the latest gate's result from the transcript (`transcript_path`), in memory, and validates it. Default: a non-blocking `systemMessage` to the user (once per snapshot) when code changed without an accepted gate; no `decision:block`, no `additionalContext`. With `JEV_FLOW_STRICT=1`: blocks once per snapshot with a redirect to `/jev:jev-done`, unless `stop_hook_active` is true, the snapshot is unknown, or the final message contains `Jev unavailable; gate not evaluated` / `Jev disabled for this repo; gate not evaluated`, or its last non-empty line starts with `Incomplete:` or ends with `?`. A bare mention of "incomplete" is not an exception. After the one redirect, it reports clearly and does not block again. Subagent stops are ignored. |

Outside a git work tree the hooks do nothing (no snapshot to bind evidence to, and nothing is approved). Internal errors print one stderr line and exit 0 without a decision. If the session state lock cannot be obtained (§7), the hook neither blocks nor approves (a `PreToolUse` refusal is still returned, whatever the persistence error); `Stop` tells the user that completion evidence is unknown and, for a lock left by a process that is gone, names the lock file to delete by hand.

Shell classification (`classifyShellCommand`): segments split on `&&`, `||`, `;`, `|`; `cd`/`pushd`/`popd` segments are neutral (a leading `cd` does not change the class); any mutation (in-place `sed`/`perl`, `mv`, `cp`, `rm`, `touch`, `tee`, file redirection, mutating `git`, package installs) makes the line `mutation`; recognized test/build/lint commands make it `test`; read-only commands (`rg`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `sed -n`, read-only `git`) make it `exploration` only if every segment is read-only; everything else is `unknown`.

### OpenCode (`private/jev-flow/opencode.mjs`, called from `opencode-plugin.js`)

| Capability | Use | On absence / failure |
| --- | --- | --- |
| `ctx.skill.transform` | Adds skill `jev-flow` unless one exists (existing entry preserved and reported). `${CLAUDE_PLUGIN_ROOT}` in the content is replaced with the checkout path. | Feature skipped; listed in the single diagnostic. |
| `ctx.agent.transform` + `editor.update` | Creates `jev-locator` (`mode: "subagent"`, `system` = agent body, `description`, `hidden: false`) unless one exists. Permissions are **not** set. | Same. |
| `ctx.command.transform` + `editor.add` | Adds `/jev-locate` and `/jev-done` unless `ctx.command.list()` reports them. Commands are registered only when `ctx.command.list` works and returns a list (otherwise collisions cannot be ruled out) and `ctx.session.prompt` exists. `execute` sends the command text into the invoking session with `ctx.session.prompt({sessionID, text, delivery})`, keeping `delivery`. | Commands not registered; listed in the single diagnostic. |
| `ctx.tool.hook("execute.before")` | For `jev_*` tools: throws `JevFlowPolicyError` when the denylist has `*` or the payload holds an unredacted credential. The throw is deliberate and not caught by the adapter. A refused `jev_gate` is first recorded in memory as a failed, `denied` attempt of the current request, so it supersedes an earlier accepted gate without relying on `execute.after`. For an allowed `jev_gate`, remembers the pre-call snapshot and input hash in memory. | Same. |
| `ctx.tool.hook("execute.after")` | For `jev_gate`: closes the attempt opened in `execute.before` (which recorded, in memory, the pre-call snapshot, input hash, claims, request number and start time); `status` other than `completed` is a failed attempt; otherwise keeps the post-call snapshot and whether the result passes `validateGateResult` for the call's claims. Counts exploration (`read`, `grep`, `glob`, `list`, exploration `bash`) outside `jev-locator`; queues one hint per request (exploration ≥ 4, the second re-read of the same range with the same content hash, or the first successful edit). | Same. |
| `ctx.session.hook("prompt")` | Starts a new request: increments the request number and resets per-request counters and re-read tracking. | Counters never reset. |
| `ctx.session.hook("context")` | Appends the queued hint to `system[]` once; never rewrites `messages`. Skipped for `jev-locator`. | No hints. |

Degradation: every capability is feature-detected; a missing or failing one disables only its feature. At most one diagnostic line is logged per setup; problems found later at runtime are added to the returned report and logged only if nothing was logged before. `opencode-plugin.js` loads the module after registering the `jev` MCP server and skill, inside its own `try/catch`, so a failure there never affects them.

Gate verdicts in OpenCode live only in the plugin process's memory; nothing is persisted, so a restart starts with an unknown gate. The accepted-gate rule is the same as for Claude Code: the latest attempt by start time (unfinished and failed attempts included), the request current when it started, a stable known snapshot equal to the current one, and `validateGateResult` for the call's claims.

**Strict mode in OpenCode is an instruction, not enforcement.** With `JEV_FLOW_STRICT=1`, `/jev-done` adds the plugin's gate status for the current snapshot and request to the prompt and tells the agent not to report completion without an accepted gate. Nothing technically blocks a completion message: the inspected API offers no hook at the completion boundary (no Claude-`Stop` equivalent), so that guarantee is reported as unsupported.

## 6. Data policy

### `.jev-flow-denylist`

Optional file at the repository root. Dialect: a gitignore subset.

- `#` starts a comment; blank lines are ignored; trailing spaces are ignored unless escaped.
- `*` matches within one path segment, `?` one character, `**` any number of directories (`**/x`, `x/**`, `a/**/b`).
- A leading `/` anchors to the repository root; a pattern containing any other `/` is also anchored; a pattern without `/` matches the name at any depth.
- A trailing `/` matches directories only (everything below them).
- Matching is case-sensitive, like git.
- No `!` negation: such lines are ignored and reported in `coverage.denylist_unsupported`, so nothing is ever re-included. No character classes: `[` is literal. A backslash escapes the next character.
- A line that is exactly `*` disables Jev for the whole repository.

### Permanent exclusions

Never sent, whatever the denylist says, matched case-insensitively by name at any depth: `.env`, `.env.*` (including `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*` (including `.pub`), `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `.aws/credentials`, `credentials*.json`, `service-account*.json`, `google-services.json`, `GoogleService-Info.plist`, `local.properties`, `keystore.properties`, `signing.properties`, `*.mobileprovision`.

### Redaction (best effort)

Marker `[REDACTED:<kind>]`. Kinds: `pem_private_key` (BEGIN…END PRIVATE KEY blocks; the line count is kept), `aws_access_key` (`AKIA`/`ASIA` + 16), `github_token` (`ghp_`, `gho_`, `ghs_`, `github_pat_`), `sk_api_key` (`sk-`, `sk-ant-`, `sk-or-`), `slack_token` (`xox[abposr]-`), `google_api_key` (`AIza` + 35), `jwt` (three base64url segments starting `eyJ`), `bearer_token` (`Authorization: Bearer <token>`), `credential_assignment` (names containing `api_key`, `apikey`, `secret`, `token`, `password`, `passwd`, `storePassword`, `keyPassword`, `private_key`, assigned with `=`, `:`, `:=` or `=>`, plus Gradle `storePassword '<x>'` / `keyPassword "<x>"`).

Assignment values: a quoted value is redacted unless it is empty or references the environment or a placeholder (`process.env`, `${…}`, `$VAR`, `<…>`, `***`). A bare value is redacted, whatever its length or characters (`password=huntertwo`, `storePassword=123456`, `token: x`), unless it is clearly code: a type or literal name (`string`, `null`, `true`, …), an environment reference, something containing `(`, `[` or `{`, a member access such as `options.token`, or a number assigned to a token-count name such as `max_tokens`. Plain variable names on the right-hand side (`token = myToken`) are therefore redacted too; that is the accepted cost of not exempting simple passwords.

After redaction, a line is **suspicious** when a PEM private-key header survives, or when it mentions key/secret/token/password/credential/private/auth next to a token of 24+ characters mixing letters and digits, not plain hex, with Shannon entropy ≥ 3.5 bits per character. Suspicious candidate fragments are omitted; suspicious lines in sanitized text become `[OMITTED:suspicious_content]`. A regex cannot recognize every secret.

## 7. Local state

`~/.cache/jev-flow/<repo-hash>/<session-hash>/state.json` (override the root with `JEV_FLOW_CACHE_DIR`). Hashes are truncated sha256 of the repository's real path and of the session id. OpenCode persists nothing; its state is in memory.

- **Metadata only.** Paths, sha256 hashes, ranges, counters, request numbers, timestamps and exit codes. A gate record holds only `{id, req, input, before, after, ts, boot, failed, denied}` (tool-use id, request number and boot at call start, input hash, snapshots, start time, whether the call failed, and whether the flow's own `PreToolUse` guard refused it). A test record holds `{cmd, req, boot, before, after, exit, failed, ts}` (command hash, not the command). A pending attempt holds `{kind, before, input|cmd, req, boot, ts}`. Jev verdicts, actions, validity or contradiction counts are never written; `Stop` re-reads the verdict from the CLI's native transcript in memory and otherwise treats it as unknown. Every write is validated: strings are limited to 300 characters on a single line, and unknown top-level keys or record fields are rejected. No code, diffs, prompts, logs or semantic results are written. State files from an older format are ignored.
- **Concurrency.** Writes are atomic (temporary file + rename) under an exclusive lock file (created with `O_EXCL`) holding the owner's pid and a random token. The lock is never broken, moved or taken over automatically, whatever its age and even when its owner process is gone: no primitive available here can replace it exclusively without racing another process that recovers it at the same time. Because the lock is only created exclusively and removed by its owner, no other process can take it while the owner runs its update or between the ownership check and the write. Before writing, the holder still checks that the lock carries its token (it could only have been removed or replaced by hand); if not, it abandons without writing. If the lock cannot be obtained within 1 s, the update is abandoned without calling back, reading or writing (`StateBusyError`) and the hook treats the state as unknown; when the lock names an owner pid that no longer exists, the error and the `Stop` notice name the lock file. **Manual recovery:** after making sure no Claude Code hook of that session is running, delete `~/.cache/jev-flow/<repo-hash>/<session-hash>/lock` (or the same path under `JEV_FLOW_CACHE_DIR`).
- **Retention.** 30 days, cleaned at `SessionStart`, using `lstat` only: symlinks are never followed or deleted through.
- **Restart.** Gate records do not survive `startup`/`resume`; the gate becomes unknown again.

The CLIs keep their own native transcripts, which may contain tool results; the metadata-only rule applies to this extension's state.

## 8. Metrics: `scripts/jev-flow-metrics.py`

```sh
python3 scripts/jev-flow-metrics.py --runs runs.json [--format json|markdown]
python3 scripts/jev-flow-metrics.py --session <id> --cli claude|opencode [--format markdown]
```

Options: `--claude-projects` (default `~/.claude/projects`), `--opencode-db` (default `~/.local/share/opencode/opencode.db`, opened with `mode=ro`), `--manifest` (default `private/jev-flow/ab/tasks.json`; required for a verdict).

`runs.json`: a list of `{"cli": "claude"|"opencode", "session_id": "...", "arm": "A"|"B", "task": "M1", "rep": 1, "oracle_pass": true, "false_success": false, "blocked": false}`; the last three are optional booleans, imported as-is.

Sources:

- **Claude Code.** `<projects>/*/<session>.jsonl` is the main thread (records with `isSidechain` count as descendants); `<projects>/*/<session>/subagents/*.jsonl` are descendants, with the agent type from `*.meta.json`. Tool calls are paired `tool_use` → `tool_result` by id and de-duplicated by id; `is_error` marks a failed call. Token usage is taken per API message id (the last usage seen for that id). Bytes are the UTF-8 length of the text actually returned in `tool_result` (for results the harness externalized to a file, that is the preview delivered, not the file).
- **OpenCode.** `session_v2` / `session_message` (the tables OpenCode 2.0.12 writes; checked locally), falling back to V1 `session` / `part`. The required columns are checked with `PRAGMA table_info`; a table missing a column is reported as an unsupported source (`metrics: null` with the reason), never as zero. Descendants follow `parent_id` recursively. Tool calls are `assistant` content items of type `tool` with `state.status` (`completed` / `error`); bytes are the `text` items of `state.content`; tokens from `data.tokens`.

Definitions:

- **Categories.** `exploration` (read/grep/glob/list tools, exploration shell commands, `jev_find`, `jev_rerank`), `locator_report` (a subagent call whose agent type matches `locator` or `explore`), `agent_other`, `edit` (edit tools and mutating shell), `test`, `jev`, `web`, `shell_unknown`, `other`. A leading `cd` does not change a command's class.
- **Unknown propagates.** Any sum with a missing part is `unknown` (with a separate `*_lower_bound` where useful): `main_exploration_bytes` if any exploration output is missing; `total_tool_bytes`; tokens of a thread if any of its API messages lacks usage; Jev tokens if any Jev result lacks `usage.input_tokens`/`output_tokens`; `tool_seconds` if any call lacks a start or end; `wall_seconds` with fewer than two timestamps; `user_wait_seconds` is always `unknown`; `false_success`/`blocked` if any run omits them.
- **Main exploration bytes.** Main-thread exploration plus locator reports, each call once, including error text actually returned.
- **Re-reads.** The design counts reads of the same path, same file hash and overlapping range. Transcripts carry no file hash, so `rereads` is always `unknown`. A separate, labelled heuristic `rereads_heuristic` reports `inferred_from_provenance` (a later overlapping main-thread read of the same path with no successful native edit of that path in between), `indeterminate` (a shell mutation, an unclassified shell command, an edit without a known path, other tools or a subagent ran in between) and `identical_output_repeats` (identical returned text). The heuristic is not hash evidence and is never substituted for `rereads`.
- **Before the first edit.** Calls and bytes before the first *successful* edit (native edit tool or mutating shell); failed edits do not count as modifications.
- **Tokens.** Main and descendants (input, output, cache read/write, reasoning) and Jev provider tokens (input + output) are reported separately; the A/B total is their sum. A message counts only when every usage field is present as a non-negative integer (Claude: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`; OpenCode: `input`, `output`, `reasoning`, `cache.read`, `cache.write`; Jev: `input_tokens`, `output_tokens`); a missing field makes that thread's tokens, and every total built on them, `unknown`.
- **Time.** Wall time from the first to the last main-thread message; tool time as the union of tool intervals (parallel calls are not summed).

Aggregation (per client, never mixed):

- **Validation.** The manifest must list exactly the six agreed, distinct task ids (M1, M2, A1, A2, H1, H2) with `repetitions: 3`; anything else (missing, reduced, renamed, duplicated or extra tasks, other repetition counts) is an invalid manifest and blocks the verdict; the corpus is never shrunk to the tasks present. Every run needs a valid `cli`, `session_id`, `arm`, a `task` from the manifest and an integer `rep` in 1..3. A session used by two runs, two runs for the same client/task/arm/rep, or any task/arm without exactly repetitions 1..3 blocks the verdict.
- **Primary metric.** Median of `main_exploration_bytes` over the repetitions of each task and arm; if any run's value is unknown, that median is unknown and the verdict is blocked. Relative reduction `(A − B) / A` per task (a zero baseline blocks the verdict); median over the task pairs.
- **Verdict.** `insufficient_data` when anything above blocks it or any run lacks `oracle_pass`. Otherwise `adoption_criterion` is `met` when the median reduction is ≥ 30 % and the pass rate of B is ≥ A, else `not_met`. `total_savings` compares the sums over tasks of the per-task medians of total tokens (main + descendants + Jev) and wall time: `yes` only when both are known and neither grew for B, `no` when either grew, `unknown` otherwise. The verdict is `adopt` only with the criterion met and `total_savings: yes`; with the criterion met otherwise it is `main_context_reduction_only`. Unknown totals are never presented as savings.

## 9. A/B manifest

`private/jev-flow/ab/tasks.json`: six tasks (M1, M2, A1, A2, H1, H2) with verified 40-hex base SHAs, English prompts translated from the design, acceptance criteria in `acceptance_hidden_from_agent` (never given to the agent), `oracle.status: "not_ready"` and `seed: null`. The runner guard `node private/jev-flow/ab/preflight.mjs` exits 1 and lists the reasons until the manifest holds exactly the six agreed, distinct task ids with 3 repetitions, every oracle is `ready` with a command and the seed is recorded; the experiment must not start before it exits 0.

## 10. Tests

`node --test private/jev-flow/test/` runs the offline suite. `test/fixtures/enospc-preload.mjs` is a test-only `--import` preload that makes the state's temporary-file write fail with `ENOSPC`, to check that a refusal survives persistence failures. Node 22 resolves a directory argument as a module, so `private/jev-flow/test/index.js` imports every `*.test.mjs` file. The tests use temporary git repositories, a temporary `HOME` and `JEV_FLOW_CACHE_DIR`, synthetic secrets, synthetic transcripts, and a simulated OpenCode `ctx`; they make no network connection. Gate fixtures used as accepted are complete results shaped like `src/index.ts` returns them; incomplete ones are used only as negative cases. `contracts.test.mjs` checks the documented payloads against the top-level keys parsed from `src/index.ts`, limits parsed from `src/lib.ts`, and nested shapes, types and bounds mirrored by hand from `src/index.ts`; it is a structural check, not a full zod validation.

## 11. Known limitations

- OpenCode V2 behavior is not verified at runtime: skill/agent/command registration, `editor.update` creating a missing agent, `ctx.command.list` and `ctx.session.prompt` shapes, the `prompt`/`context` session hooks, the `execute.before`/`execute.after` input fields (`id`, `status`, `result`), and whether a throw in `execute.before` actually blocks the tool call. Tests use a simulated `ctx`. Type hints come from a local `@opencode/plugin` 2.0.18, not 2.0.12.
- OpenCode agent permissions are not set because V2 permission action names could not be verified; the locator's read-only rule is an instruction there.
- OpenCode strict mode only instructs the agent at `/jev-done`; nothing blocks a completion message.
- Claude Code: `PostToolUseFailure` is documented for failed tool calls; whether cancelled calls, or calls denied by another hook or by the user, also fire it is not verified, so an attempt without an end stays pending and blocks acceptance until a newer gate completes (calls refused by this flow's own guard are recorded as failed before the refusal). The `later_gate_call_in_transcript` check assumes a refused or cancelled `tool_use` is written to the main transcript; that was not verified live, so it is a second line of defense behind the state record, not a replacement. Re-reading the gate verdict relies on the transcript record shapes observed locally (`tool_use` / `tool_result` blocks); if the transcript is missing or not yet written, the gate is unknown. Bash exit codes are not in the tool response, so test results are normally unknown. Loading of the skill, commands, agent and hooks is checked with `claude plugin validate .`; interactive behavior on 2.1.283 needs a live smoke test.
- The state lock is never recovered automatically; a lock left behind by a crashed hook process disables state updates for that session (the hooks treat the state as unknown and never approve) until it is deleted by hand (§7).
- Redaction is best effort. The hooks are guards for Jev calls, not a firewall for every tool or external call.
- The metrics are exactly as good as the transcripts: missing timestamps, usage or outputs appear as `unknown`.

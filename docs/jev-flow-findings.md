# jev-flow — findings from the Android A/B smoke tests (2026-09-27)

Baseline: commit `1ca30f2` on branch `jev-flow` (implementation of `docs/jev-flow-design.md`).
Test project: `dgapp2-android` (Kotlin, ~2.6k files), isolated clones. Same model for every run
(`claude -p`, Opus, effort medium, `--permission-mode acceptEdits`, identical allowed tools).
Hidden oracle = the real commit's unit test. Single run per arm: numbers are indicative, not proof.

## Runs

Task 1: DSE-45624 (small bugfix, 2 production files). Task 2: DSE-45119 (4 bugs, 9 production files).

| Run | Flow | Oracle | Turns | Wall | Cost | Main exploration bytes | Subagents | Jev calls |
|---|---|---|---|---|---|---|---|---|
| T1-A | none | 69/69 | 15 | 142 s | $0.52 | n/m | 0 | 0 |
| T1-B | plugin loaded, advisory | 69/69 | 11 | 120 s | $0.45 | n/m | 0 | 0 |
| T2-A | none | 64/64 | 93 | 552 s | $2.97 | 193,224 | 0 | 0 |
| T2-B | plugin loaded, advisory | 64/64 | 86 | 531 s | $3.08 | 164,991 | 0 | 0 |
| T2-B' | forced: `JEV_FLOW_STRICT=1` + prompt tells it to use the skill, jev-locator and /jev:jev-done | 64/64 | 87 | 545 s | $4.16 | 158,542 | 4 | 1 (`jev_gate`) |

T2-B' details (from `scripts/jev-flow-metrics.py --session`): total tool bytes main 181,350 + descendants
114,883 (vs 208,655 for T2-A); main tokens cache_read 4.37M (A: 5.04M), output 60.7K (A: 39.8K);
descendant tokens output 14.0K, cache_read 291K; jev tokens 17,965 in / 398 out; before first edit
17 calls / 52 KB (A: 10 calls / 59 KB).

## Findings (all must be analysed and fixed)

### F1 — Advisory activation is ignored (critical)
In T1-B and T2-B the plugin was loaded (skill `jev-flow` and `/jev:jev-locate`, `/jev:jev-done` listed;
`PostToolUse` injected "jev-flow: 4 exploration calls in this request. For broad discovery, delegate
to the jev-locator subagent (/jev:jev-locate <question>) …" once; `Stop` emitted its non-blocking
notice), yet the agent made **0 jev calls and launched 0 subagents**. The skill was never loaded.
One hint per request plus a description-selected skill does not change behaviour in headless runs.
Relevant: `hooks/hooks.json`, `scripts/jev-flow-hook.mjs`, `private/jev-flow/hook.mjs`
(hint thresholds, one-hint-per-request rule, SessionStart/UserPromptSubmit output),
`skills/jev-flow/SKILL.md` (description). The prior user decision (T1) was: auto-selected skill +
non-blocking hints by default, blocking only opt-in (`JEV_FLOW_STRICT=1`). Any change of that
default is a decision to take explicitly (the user's standing rule: open questions are decided with
`jev_decide`, confidence > 0.85).

### F2 — jev-locator runs on the parent's model (cost)
`agents/jev-locator.md` has `model: inherit`, so the 4 locators in T2-B' ran on Opus. Total cost rose
40% ($2.97 → $4.16) while main-thread exploration fell only 18% (adoption threshold is −30%).
The locator only greps/reads/ranks; a cheaper model is the obvious lever (Claude Code: `haiku` or
`sonnet` in agent frontmatter; OpenCode adapter must mirror it where supported, with graceful
degradation).

### F3 — /jev:jev-done sends claims without per-claim evidence → false escalation (critical)
In T2-B' the patch was correct (oracle 64/64, compile + 77 unit tests passing) but `jev_gate`
returned `action: escalate` with `safe_to_apply_below_review, review_escalated, claims_unsupported,
claim_confidence_low`; 4 of 8 claims `unsupported` (0.50–0.74), none contradicted. The agent sent the
diff but no evidence excerpts per claim, so code claims had nothing to rest on (design §5 and
anti-pattern 9: support must be in `evidence`, `src/index.ts:1620–1629`). Fix `commands/jev-done.md`
(and `skills/jev-flow/reference/workflow.md`, OpenCode command text) so every claim is paired with
the diff hunk(s)/code excerpt and real command output that support it, within tool limits, split
large patches, and keep the strict-mode behaviour (it correctly refused to declare done).

### F4 — Locators never use jev_find / jev_rerank
All 4 locator subagents in T2-B' ran the candidate helper then used Grep/Read only
(tool counts: 1–2 Bash, 2–4 Grep, 2–5 Read each). So Jev contributes nothing to localisation;
the only benefit is context isolation. Decide and implement when rerank is required
(e.g. helper returns more than N candidates or several files match), make the helper output
directly usable as `jev_rerank` candidates with `top_k`, or document that plain search is the
intended path. Relevant: `agents/jev-locator.md`, `scripts/jev-candidates.mjs`, `commands/jev-locate.md`.

### F5 — plugin.json has no version
`claude plugin validate .` passes with warning: `plugin.json → version: No version specified`.
`.claude-plugin/plugin.json` is a private file.

## Constraints (unchanged)
No edits to upstream files (`src/`, `skills/jev/`, `README.md`, `package.json`, `package-lock.json`,
`test/`, `dist/`); Node 22 / Python 3 stdlib only; tests offline (loopback mocks allowed);
no commit/push by council members.

## Resolution (2026-09-27, branch `jev-flow`, uncommitted on top of `1ca30f2`)

The decisions below that change a behavior or pick a value were taken with `jev_decide`, following the standing rule that open questions are decided with confidence > 0.85. The user's answers to the council recorded them: F1 1.00, F2 0.99, F3 1.00, F4 1.00, F5 1.00. Remaining implementation details (the model-override mechanism, the batch label format) were decided the same way (1.00, 0.97). The hint cadence ("every exploration threshold" = 4, 8, 12, …) follows the user's wording. No upstream file changed.

### F1 — Advisory activation is ignored

**Cause (baseline):**
- `private/jev-flow/hook.mjs:116-119`: `UserPromptSubmit` returned nothing.
- `hook.mjs:113`: `SessionStart` spoke only when the denylist disabled Jev.
- `hook.mjs:312-319` (flag `explore_hinted`): `PostToolUse` emitted one exploration hint per request.
- `policy.mjs:10`: the hint threshold was 4.
- The OpenCode adapter had the same rule: `opencode.mjs:304`, where `pendingHint ??= text` kept only one hint, and `opencode.mjs:403`.
- `skills/jev-flow/SKILL.md:3`: the skill was left to description-based selection.

In T1-B and T2-B this produced 0 Jev calls and 0 subagents.

**Decision.** The advisory default was changed on the evidence of those two runs:
- Every session gets a directive route.
- Blocking stays opt-in (`JEV_FLOW_STRICT=1`), because a false gate escalation (F3) is still possible.
- `JEV_FLOW=off` is the opt-out.

**Change:**
- `hook.mjs`: `HINTS.directive` goes out at `SessionStart` and on every `UserPromptSubmit` (`additionalContext`). The exploration directive repeats at every multiple of 4 calls. The re-read hint fires once per request, and both on one event are joined into one message. `flowOff()` turns off directives, hints and the Stop notice/redirect, and takes precedence over `JEV_FLOW_STRICT`. The PreToolUse data guard is unaffected.
- `state.mjs`: `request.reread_hinted` replaces `explore_hinted`.
- `opencode.mjs`: the same `DIRECTIVE` is queued at each `prompt` and delivered by `context`. The same cadence applies, the queue now holds several hints, and `JEV_FLOW=off` also drops the strict note in `/jev-done`.
- `SKILL.md`: the description is directive and there is a new "Activation" section.
- `reference/workflow.md` §2 and §5, `PRIVATE.md` ("Activation and settings"), `docs/jev-flow-design.md`.

**Tests:**
- `hook.test.mjs`:
  - the directive at SessionStart and on prompts that do not mention the flow;
  - directives at 4, 8 and 12, with a reset on a new prompt;
  - a combined re-read + threshold message;
  - `JEV_FLOW=off` with `JEV_FLOW_STRICT=1`: no output at all, while the guard still denies credentials.
- `opencode.test.mjs`: the directive at each request, hints at 4 and 8, off, and a disabled repo.

### F2 — jev-locator runs on the parent's model

**Cause (baseline):** `agents/jev-locator.md:5` had `model: inherit`, and `private/jev-flow/test/contracts.test.mjs:234` enforced it. The OpenCode adapter set no model (`opencode.mjs:219-225`).

**Change:**
- `agents/jev-locator.md`: `model: haiku`.
- `hooks/hooks.json`: the `PreToolUse` matcher now includes `Agent|Task`.
- `hook.mjs`:
  - `handleAgentPreToolUse` applies `JEV_FLOW_LOCATOR_MODEL` (`haiku|sonnet|opus|inherit`) to `jev-locator` / `jev:jev-locator` delegations through `hookSpecificOutput.updatedInput`, without a permission decision. Claude Code 2.1.283 applies an `updatedInput` without a `permissionDecision` as a plain input update; this was read from the installed binary.
  - `inherit` maps the parent model alias recorded at `SessionStart` (`state.parent_model`).
  - An invalid value, or an unknown parent, changes nothing and produces one `systemMessage` per session.
- `opencode.mjs`: `locatorModelRef()` parses `provider/model[#variant]` into the V2 `Model.Ref` `{providerID, id, variant?}`, following the `@opencode/schema` 2.0.18 `Agent.Info.model`. When the variable is unset or invalid, the agent inherits the parent model, and that is noted once (setup report plus the one diagnostic line). An existing `jev-locator` is never replaced.
- `commands/jev-locate.md`, `SKILL.md`, `PRIVATE.md`, the design doc.

**Tests:**
- `contracts.test.mjs`: `model: haiku`.
- `hook.test.mjs`: unset, each alias for both names and for `Task`, `inherit` from `claude-opus-5-5` → `opus`, invalid and unknown parent reported once, other agents untouched.
- `opencode.test.mjs`: parsing, set, invalid, and preserving an existing agent.

### F3 — /jev:jev-done sends claims without per-claim evidence

**Cause (baseline):**
- `commands/jev-done.md:15-26` and `skills/jev-flow/reference/workflow.md:78` showed one generic `{"id":"patch"}` item and placeholder claims, with nothing pairing each claim with its support. `jev_gate` judges claims only against `evidence` (`src/index.ts`, claim questions in `jev_gate`), so the code claims in T2-B' were `unsupported`.
- Large patches had only a sentence of guidance (`workflow.md:127`).
- The completion check accepted only the latest single gate (`state.mjs:505`, `hook.mjs:413`), so a split patch could not be checked safely.

**Change:**
- New `private/jev-flow/gate-batch.mjs`, shared by both adapters, and `scripts/jev-gate-payload.mjs` (stdin/stdout, writes nothing):
  - `--list-hunks` lists sanitized hunk ids.
  - The main mode takes `{request, diff, claims: [{text, evidence: [ids]}], commands: [{command, exit, output}], excerpts}`, sanitizes everything and puts each claim's own hunks, excerpts and identified command output (`$ cmd` / `exit: n`, or `unknown (not reported by the tool)`) into `evidence`.
  - It enforces the limits of `src/lib.ts:241-253` (16 claims, 16 items, 200,000 characters, 50,000 per document, 2,000 per claim).
  - It refuses claims without evidence, unknown ids, placeholders, excluded excerpt paths, and slices no claim covers (`ok: false`, exit 4, no calls).
  - Redaction is allowed, but content that sanitizing had to remove is not. A dropped diff section (excluded, denylisted or unparseable path) or a line replaced as a suspected secret, in the diff, a command output, an excerpt or a claim, also gives `ok: false`, with the reason per source. That content would go unevaluated, and the removed material is never emitted.
  - It splits large patches into contiguous diff slices by file and hunk. Oversized hunks and logs continue in identified pieces (`hunk-N#k`, `cmd-N#k`), so nothing is cut silently.
  - Every part carries the manifest `[jev-flow batch v2 id=… part=k/n slice=i/m claims=… diff=… snap=…]` in `request`.
  - `claims` and `diff` are hashes of the complete claim set and of the whole sanitized diff.
  - `id` binds the snapshot, the shape, both hashes and a canonical digest of every planned part's complete input (the request without its label, diff, claims, evidence, tests and any other parameter). The label is excluded, so there is no circularity.
  - A changed payload therefore makes a new batch, and parts of two preparations never combine.
- `state.mjs` / `hook.mjs` / `opencode.mjs`, through the shared `selectGateAttempts`, `verifyBatchContents` and `coversEarlierBatches`. A batch counts only when:
  - every part's latest attempt is finished, not failed or refused, from the current request, and on equal known snapshots equal to the current one;
  - every part passes `validateGateResult` in the transcript (Claude) or in memory (OpenCode);
  - the parts rebuild their manifest from their complete inputs as sent: all slices, the diff and claim-set hashes, and the id recomputed from the per-part digests. Claude Code passes the transcript's full `tool_use` input to the validator; OpenCode passes the in-memory input.
- A missing, unfinished, failed, refused, escalated or altered part leaves the batch unverified. So does a gate interleaved between the parts, or a later gate call.
- A later single gate or rebuilt batch replaces an earlier batch only if it covers both that batch's claims and its patch (`coversEarlierBatches`). That means the same claim-set and whole-diff hashes or, when every earlier part is known, a superset of its claims and a diff containing every file header and hunk of the earlier diff. A replacement that keeps the claims but drops a file is rejected, even when only the first part of the earlier batch was sent.
- State keeps only `{batch, part, of}` per record. The gate list cap was raised from 20 to 64; a trimmed part counts as missing.
- `commands/jev-done.md` was rewritten around the helper: real commands and exit codes, claims paired with evidence, one call per part, cumulative interpretation, and a final report that states partitioning. The strict policy is unchanged (contradiction first, one operational retry, escalate → ask, `Incomplete:`). The OpenCode `/jev-done` uses the same asset.
- `reference/workflow.md` §1 step 7, §3 "Large patches", §4b, §5, §7 and §11; `SKILL.md`; `PRIVATE.md`.

**Tests:**
- New `gate-batch.test.mjs` (26 tests), covering:
  - per-claim evidence, i.e. the T2-B' regression;
  - a check claim without cited output, and an unknown exit code;
  - invalid ids, placeholders, over-long claims and excluded paths;
  - sanitizing: redaction allowed; a mixed allowed/excluded diff, or omitted lines in the diff or in cited output, is not prepared;
  - exact coverage of large diffs, hunk and log continuations, and more than 16 claims;
  - evidence too large, and a slice no claim covers;
  - manifest tampering: changed evidence, tests, request or parameters; claims moved between parts; parts of two preparations;
  - replacement coverage of claims and patch;
  - attempt selection;
  - the CLI.
- `contracts.test.mjs`: `jev-done.md` has no generic `patch` item, and the helper's calls fit the `jev_gate` schema.
- `hook.test.mjs`, 12 Stop scenarios: all parts accepted; last part only; an escalated part then retried; a snapshot change; a forged claim; a single gate after an incomplete batch, checking both claims and diff; a batch or single gate for a.ts only with the same claims after part 1 of an a.ts+b.ts batch (rejected); a complete rebuilt replacement, accepted only once all its parts are in; parts of two preparations; interleaving; a later transcript call; metadata-only state.
- `opencode.test.mjs`: the same batch scenarios in memory, plus changed evidence in a sent part.
- `state.test.mjs`: batch selection, the whitelist, the 64-entry cap.

### F4 — Locators never use jev_find / jev_rerank

**Cause (baseline):** `agents/jev-locator.md:26-27` left Jev to the model's judgment ("if an exact string already answers…", "if the choice is semantic…"). The helper's output (`private/jev-flow/candidates.mjs:378`) carried no rule and no ready-made payload.

**Change:**
- `candidates.mjs`: `recommendNext()`, `exactToken()` and `exactMatcher()` add `recommend` and `jev_payload` to every result:
  - an exact path (whole path suffix), or an identifier or qualified name found as a whole, case-sensitive token (not a substring), in exactly one file → `plain` with `confirm_by_reading: true` and a `fallback` holding the threshold-rule recommendation and its payload. The locator uses the match only if reading confirms it answers the question; lexical uniqueness is not presented as proof;
  - more than 3 candidates, or candidates from 2 or more files → `jev_rerank` with `{query ≤ 2000, candidates, top_k: 5}`;
  - the same thresholds with `--single` (one definitive location) → `jev_find`;
  - 1–3 candidates in one file → `plain`;
  - no candidates, or the denylist disables Jev → `none`.
- `scripts/jev-candidates.mjs` gains `--single`.
- `agents/jev-locator.md`:
  - following `recommend.tool` is mandatory, and the payload is sent unchanged;
  - an exact match is confirmed by reading, and otherwise `recommend.fallback` is followed;
  - grep hits are not hand-built into candidates; the helper is re-run instead;
  - the report states `jev_used` and the reason.
- Also updated: `commands/jev-locate.md`, `reference/workflow.md` §1 step 1 and §4, `SKILL.md`, and the design doc.

**Tests:**
- `candidates.test.mjs` (9 new): 1 and 3 candidates versus 4; one file versus two; `--single`; the exact-symbol exception with confirmation and fallback, including a symbol present in two files; the `cache` / `cacheable` / `caching` substring regression in two files (stays `jev_rerank`); a real whole-token match whose fallback carries the Jev payload; path-suffix matching; zero candidates and a disabled repo; token rules and the query cap.
- `contracts.test.mjs`: the payload passes the `jev_rerank` and `jev_find` schemas, and the locator prompt carries the rule.

### F5 — plugin.json has no version

**Cause (baseline):** `.claude-plugin/plugin.json` had no `version`; the `jev` entry in `.claude-plugin/marketplace.json` had none either.

**Change:** `"version": "0.1.0"` in both files: an independent private semver, bumped together on every private plugin change. The policy is in `PRIVATE.md` under "Plugin version". The upstream `package.json` (0.9.0) is untouched.

**Tests:** `manifest.test.mjs` checks that the version is semver, independent of upstream, and equal in both files.

On the baseline worktree, `claude plugin validate .` passed with `plugin.json → version: No version specified`. It now passes without warnings, as does `claude plugin validate .claude-plugin/plugin.json`.

### Verification (run by the executor)

1. `node --test private/jev-flow/test/` → 242 tests, 242 pass, 0 fail (baseline: 168; 229 before the council's fixes).
2. `npm test` → 224 tests, 224 pass, 0 fail.
3. `claude plugin validate .` → "✔ Validation passed", with no version warning.
4. `node -e "import('./opencode-plugin.js').then(m=>console.log(typeof m.default.setup))"` → `function`.
5. `git diff --stat 1ca30f2 -- src skills/jev README.md package.json package-lock.json test dist` → empty.

### Limitations (not verifiable locally)

- **Effect on the model:** whether the directive (F1), the haiku locator (F2), the ranking rule (F4) and the per-claim evidence (F3) change what a model actually does in headless runs, and whether they lower cost or reach the −30% adoption threshold. The tests prove that the directive, the model parameter, the payloads and the strict aggregation are delivered and correct, not that a model obeys them. New A/B runs are needed.
- **Claude Code `updatedInput`:** the handling of an `updatedInput` on the `Agent`/`Task` tool was read from the 2.1.283 binary, not exercised in a live session.
- **OpenCode V2 runtime:** `Agent.Info.model`, the `context` and `prompt` hooks, and the tool hooks are unverified on 2.0.12. The types come from the 2.0.18 declarations. Tests use a simulated `ctx`.
- **Gate limits:** they mirror the local `src/lib.ts`; the MCP runs `@jkudish/jev-mcp@latest`.
- **Partitioned gate:** it verifies each slice and its claims, not the whole patch in one call. Structural claim-evidence pairing does not prove support.

## Round 2 — B'' run after the F1–F5 fixes (2026-09-27)

Same task (DSE-45119), original prompt with no flow instructions, strict mode off, plugin at the
F1–F5 fixes. Oracle 64/64. 116 turns, 658 s, **$4.18** (A: $2.97). Main exploration 141 KB
(−27% vs A) but 44 main exploration calls (A: 41). F1 worked (the skill loaded and a jev-locator ran
unprompted). F2 worked (the locator ran on claude-haiku-4-5). **0 jev calls, no gate.**

Root causes from the transcript (parent `bedca1a6…`, locator subagent):

- **R1 (largest) — the gate payload goes through the model.** `/jev:jev-done` took tool calls
  #86–#113 (28 of 113, about 25% of turns). The agent built payloads with
  `scripts/jev-gate-payload.mjs`, wrote helper scripts in `/tmp`, and hit shell sandbox piping
  limits. It ended with 13 claims citing all 50 hunks, split into 5 parts totalling about 280 KB,
  and **never sent them**: each part had to be copied byte-for-byte into the `jev_gate` tool
  arguments (about 65 KB of model output each). The final line was `Incomplete: … gate prepared but
  not run`. MCP tool arguments are model output tokens, so large evidence cannot go through the
  model.
- **R2 — the parent ignores locator ranges.** The async Haiku locator returned correct, precise hits
  (for example `RewardDetailsProgressRules.kt` lines 5–14, with sha256 and reason). The parent still
  read all 715 lines of `RewardCardItemPhase1.kt` (30 KB) and re-grepped the Deals tab code itself
  (#56–#65). Delegation added work instead of replacing it.
- **R3 — the locator skipped `jev_rerank`.** It ran the helper twice, then made 17 find/grep calls,
  despite the F4 rule.

Decision (jev_decide 0.99): **direct gate runner.** A Node stdlib script builds the bounded gate
payload from git diff, test logs and claims, and calls `jev_gate` itself through the jev MCP server
over stdio. No model copying; it returns only a verdict summary. `/jev:jev-done` uses it. Also
enforce range-only reads after locator hits, and make locator rerank mechanical (the helper emits a
ready-to-send rerank call, or runs it through the same stdio client).

Credentials fact: the user's jev MCP config (in `~/.claude.json`, `mcpServers.jev.env`) sets
`JEV_PROVIDER` and `OPENROUTER_API_KEY`. `OPENROUTER_API_KEY` is also in the shell environment;
`JEV_PROVIDER` is not.

## Resolution (round 2) (2026-09-27, branch `jev-flow`, uncommitted on top of `e487dc1`)

Decisions:
- The runner architecture was the user's decision, taken with `jev_decide` (0.99).
- The remaining open points were answered through the council with `jev_decide`, under the user's standing rule:
  - the CLI contract, exit codes, 4 KB summary and `JEV_FLOW_MCP_COMMAND` (0.99);
  - the runner runs the checks itself, and the diff is taken against the session baseline (1.00);
  - the threat model and the HMAC receipt (1.00);
  - the F4 exceptions are kept, the rerank is mechanical, and the R2 hint cadence (1.00).
- Before the user's answers, executor C had also checked two choices with `jev_decide`:
  - runner-run checks (0.96);
  - a transcript-bound summary (0.99). The user later replaced it with the HMAC receipt.

No upstream file changed. The private plugin version is now `0.2.0`.

### R1 — the gate payload went through the model

**Cause (baseline):**
- `commands/jev-done.md:11-30` made the model do all of these itself:
  - list the hunks;
  - write a JSON file containing the whole diff, the real command output and the excerpt texts;
  - pipe it to `scripts/jev-gate-payload.mjs`;
  - copy every `calls[i].input` into a `jev_gate` tool call "unchanged".
- MCP tool arguments are model output tokens. In B'', 5 parts of about 280 KB were never sent.
- Nothing else could call `jev_gate`: the plugin had no MCP client.

**Change:**
- New `private/jev-flow/mcp-client.mjs` (Node stdlib):
  - starts the server as `.claude-plugin/plugin.json` does (`npx -y --package=@jkudish/jev-mcp@latest jev-mcp`, cwd a temporary directory), or from `JEV_FLOW_MCP_COMMAND` (a JSON argv array, no shell);
  - speaks newline-delimited JSON-RPC: `initialize` (`2025-11-25`), `notifications/initialized`, `tools/call`. It correlates ids, reassembles fragmented output, ignores non-JSON noise and answers server requests;
  - limits: handshake 120 s, calls 300 s, 8 MiB per message;
  - returns `isError` as `tool_error`, and never exposes the server's stderr raw;
  - retries once with identical input after a transport failure or `invalid_response`.
- Credentials come from the inherited environment only, using the `src/provider.ts` rules. With `OPENROUTER_API_KEY` and no `JEV_PROVIDER`, the child gets `JEV_PROVIDER=openrouter`. With no credentials nothing is spawned, and the result is "Jev unavailable; gate not evaluated". `~/.claude.json` is never read.
- New `scripts/jev-gate-run.mjs` and `private/jev-flow/gate-run.mjs`, the gate runner:
  - The model passes only `{request, claims: [{text, evidence ids}], excerpts: [{id, path, lines}]}` and `--check "<cmd>"`.
  - The runner refuses `diff`, `commands`, `tests`, `evidence` and excerpt `text`.
  - It runs the checks itself (`sh -c`, output cut visibly at the first 8,000 and last 32,000 characters, timeout 900 s).
  - It collects the diff against the session baseline (below), including new non-ignored files, and reads the excerpt lines itself.
  - It reuses `prepareGateBatch`: sanitizing, denylist, limits, and partitioning only when needed, with a manifest `snap=` bound to snapshot S0.
  - It checks that S0 equals the snapshot after the checks and after the gate.
  - It calls `jev_gate` itself, part by part, following `interpretGate` / `validateGateResult` and the existing stop/retry policy.
  - It prints one English JSON summary of at most 4,096 characters. The summary has action, reason codes, claim verdicts by claim number, `safe_to_apply`, limits, checks and the provider/model; compression is marked with `summary_truncated`.
  - Exit codes: 0 accepted, 2 review/escalate/contradicted, 3 unavailable/disabled, 4 invalid or not ready, 1 internal error.
  - Binary files, submodules and an empty diff are reported explicitly.
- **Baseline:**
  - `state.mjs`: `captureBaseline`, `writeBaselineOnce` and `readBaseline` write `baseline.json`: HEAD and the paths already changed, with content hashes. It is written at `SessionStart`, and in OpenCode at a session's first prompt.
  - A path that was already changed and is unchanged since then is left out and listed as `unattributed`.
  - A path changed again is included and listed as `preexisting_mixed`: its earlier changes cannot be separated, because the baseline keeps hashes, not content.
  - Without a baseline, the diff is taken against HEAD and attribution is reported as unknown.
- **Receipt:**
  - New `private/jev-flow/runner-receipt.mjs`: a per-session `receipt.key` (32 random bytes, 0600, never printed), created at `SessionStart` or at OpenCode's first prompt.
  - The runner records its attempt in the session state as soon as it starts (pending, `runner` id), so it supersedes earlier gates even if it fails.
  - It writes a metadata-only receipt `receipts/<id>.json`, signed with HMAC-SHA256. The receipt carries session, request, boot, snapshot before and after, batch, claim-set and diff hashes, claim hashes, actions, verdict codes, check hashes and exit codes, status and timestamps.
  - `hook.mjs` (`runnerVerdict`) and `opencode.mjs` (gate status) accept a runner attempt only if it is the latest attempt and its receipt verifies for this session, request, boot and current snapshot, with every part `auto`.
  - A printed or pasted summary is never evidence.
  - The runner finds its Claude Code session through `CLAUDE_CODE_SESSION_ID`, which Claude Code 2.1.283 exports to Bash (read in the binary and seen in a live Bash environment). OpenCode's `/jev-done` inserts `--session-key`.
- `commands/jev-done.md` is rewritten around the runner:
  - list hunks → claims file → one runner call → verdict interpretation → report;
  - "Never build or copy a `jev_gate` payload yourself".
- Also updated: `SKILL.md`, `reference/workflow.md` (§1 step 7, §4c, §5, §7, §10, §11), `PRIVATE.md` (settings, limits, threat model), `docs/jev-flow-design.md`.
- `jev-gate-payload.mjs` is kept for diagnostics.

**Tests:**
- `mcp-client.test.mjs` (8 tests, local fake stdio server `test/fixtures/fake-mcp-server.mjs`): handshake, calls, fragmentation, noise, `isError`, unknown tool, crash/EOF, call and handshake timeouts, bad `initialize`, missing binary, one identical retry, argv configuration, credentials with openrouter inference, and no spawn without credentials.
- `gate-run.test.mjs` (18 tests):
  - scope: session baseline, `unattributed`/`preexisting_mixed`, HEAD fallback, binary, empty diff;
  - real check capture, refused declared diff/logs/exit codes/excerpt text, excerpts read from files;
  - snapshot binding: a check that writes, a change during the gate, `snap=`;
  - one part versus a partitioned batch;
  - redaction (the key never reaches the server) and refused removals; denylist `*`;
  - no credentials; openrouter; exit codes for escalate/contradicted/unsupported/tool_error/invalid; the 4 KB cap;
  - a metadata-only, verifiable receipt, including tampering.
- `receipt.test.mjs` (7 tests):
  - accepted in strict Stop;
  - rejected at Stop: a pasted summary, a later failed attempt, another request, a changed snapshot, an escalated verdict, an edited receipt, and an unfinished attempt;
  - a receipt signed with another key or without a key is refused;
  - OpenCode: `--session-key` in `/jev-done`, acceptance, and rejection by a later failed attempt, a snapshot change or a new request.
- `contracts.test.mjs`: `/jev-done` uses the runner, never copies payloads, and its claims example passes `validateRunInput`.
- The test sandbox now strips real credentials and `CLAUDE_CODE_SESSION_ID` (`helpers.mjs`), so no test can reach a provider.

### R2 — the parent ignored locator ranges

**Cause (baseline):**
- `commands/jev-locate.md:15` asked the parent to read only the returned ranges, but nothing observed the locator's report.
- The `PostToolUse` matcher (`hooks/hooks.json:40`) did not include `Agent`/`Task`.
- `hook.mjs:395` only counted exploration. So a full read or grep of a reported file drew no signal, and the async Haiku locator's result never reached a hook.

**Change:**
- New `private/jev-flow/locator-hits.mjs`: parses the report's `hits` (fenced or plain JSON, nested responses) and applies the range rule.
- `hooks.json`:
  - `SubagentStop` with matcher `jev-locator|jev:jev-locator`. Its input carries `agent_type` and `last_assistant_message` (read in the 2.1.283 binary), so background locators count;
  - `Agent|Task` added to `PostToolUse`.
- `hook.mjs`:
  - stores `locator_hits` (`{path, start, end, sha, req}`, metadata, at most 32) for the current request;
  - hints on **every** `Read` that overlaps a fresh hit and covers the whole file or goes more than 40 lines beyond it, and on every `Grep` of the hit's file or its directory;
  - a partial overlap within the margin gets no hint, a changed sha256 drops the hit silently, and the hits reset with the request;
  - hint only: no `PreToolUse` block, in strict mode either.
- `opencode.mjs` does the same from `task`/`agent` results and on `read`/`grep`.
- Also updated: `SKILL.md` (locate row, anti-pattern 14), `commands/jev-locate.md`, `workflow.md`.

**Tests:** `locator-hits.test.mjs` (7 tests):
- parsing and range rules, including the 40-line margin, no overlap, and a small file;
- request and stale-hash handling;
- `SubagentStop` → a hint on every whole-file or wide read, none on range reads;
- grep of the file or directory versus a repo-wide grep; a changed file; a new request;
- a foreground `Agent` result; other agents ignored; no hints inside a subagent;
- the OpenCode equivalent.

### R3 — the locator skipped `jev_rerank`

**Cause (baseline):** `candidates.mjs:66` (`recommendNext`) only returned a payload. `agents/jev-locator.md:27-29` left the actual `jev_rerank` call to the model, which ran find/grep instead (17 calls in B'').

**Change:**
- `candidates.mjs`: `dueJevCall` and `mapJevResult`.
- `scripts/jev-candidates.mjs`: when the F4 rule calls for `jev_rerank` (or `jev_find` with `--single`), the helper sends `jev_payload` unchanged (`top_k: 5`) through the same MCP client and returns `jev_result`:
  - `ranked`/`top` entries mapped to `path`, `start_line`, `end_line` and `sha256`, with candidate texts dropped;
  - or `unavailable` without credentials or after a second failure; no ranking is ever invented.
- `--fallback` runs the fallback ranking after an exact match that reading did not confirm. `--no-jev` is for offline use.
- The F4 exceptions are unchanged: exact match confirmed by reading; 1–3 candidates in one file read plainly.
- `agents/jev-locator.md`:
  - use `jev_result`, and do not call `jev_rerank`/`jev_find` or re-rank with grep;
  - only confirmation reads after `jev_result`;
  - its own tool is used only when the helper reports `unavailable`.

**Tests:**
- `candidates.test.mjs` (5 tests):
  - rerank sent exactly as `jev_payload` with `top_k: 5` and mapped back;
  - `--single` → `jev_find`;
  - no call for plain results or an exact match;
  - `--fallback`;
  - no credentials (no spawn), `--no-jev`, invalid twice (one retry);
  - mapping and malformed results.
- `contracts.test.mjs`: the locator's new rule.
- `manifest.test.mjs`: version `0.2.0`, the `Agent|Task` matcher and `SubagentStop`.

### Verification (run by the executor)

1. `node --test private/jev-flow/test/` → 289 tests, 289 pass, 0 fail (242 before this round).
2. `npm test` → 224 tests, 224 pass, 0 fail.
3. `claude plugin validate .` → "✔ Validation passed", with no warnings.
4. `node -e "import('./opencode-plugin.js').then(m=>console.log(typeof m.default.setup))"` → `function`.
5. `git diff --stat e487dc1 -- src skills/jev README.md package.json package-lock.json test dist` → empty.
6. **Real smoke run:**
   - Setup: `/tmp/jev-smoke` (git repo). `clamp.js` got a `RangeError` for `min > max`, and a new file `clamp-range.test.js` was added. There were 3 claims, and `--check "node clamp-range.test.js" --check "node test.js"` was used. The session came from the hook CLI (`SessionStart`, `UserPromptSubmit`) with `JEV_FLOW_CACHE_DIR=/tmp/jev-smoke-cache` and `JEV_FLOW_STRICT=1`. Credentials came from the shell: `OPENROUTER_API_KEY` set, `JEV_PROVIDER` unset.
   - The runner started the real server through `npx`.
   - Result: `{"status":"ask_user","exit":2,"jev":{"provider":"openrouter","model":"typesafe/jev-1.13"},"parts":[{"action":"review","reason_codes":["safe_to_apply_below_auto_accept","confidence_below_auto_accept","review_required"],"safe_to_apply":0.75,"claims":[{"c":1,"verdict":"verified","confidence":0.93},{"c":2,"verdict":"verified","confidence":0.99},{"c":3,"verdict":"verified","confidence":0.99}]}]}`.
   - Both checks exited 0, and receipt `40b8928a…` was written with `accepted: false`.
   - A first run, before the provider/model field was added to the summary, gave the same verdict (`safe_to_apply` 0.78). The strict `Stop` then returned `decision: block`, as it should for a non-`auto` verdict.
   - So the real verdict here is **not** `auto`: every claim was verified, but Jev's review stayed under the 0.8 `safe_to_apply` threshold.
   - A second session opened on the same work tree treats those changes as pre-existing and reports `empty diff` (exit 4), as designed.

### Limitations (not verifiable locally)

- **Model behaviour:** whether models now use `/jev:jev-done` → runner, respect the range hints and stop re-grepping needs new A/B runs. The tests prove that delivery and enforcement are correct, not that the model complies.
- **Claude Code live behaviour:** session identity relies on `CLAUDE_CODE_SESSION_ID` in Bash equalling the hook input's `session_id`. The `SubagentStop` / `Agent` response shapes were read from the 2.1.283 binary. None of these was exercised in a live plugin session.
- **Range hints are `PostToolUse`:** they arrive after the redundant read.
- **OpenCode 2.0.12 is unverified:**
  - the bash tool's `execute.before`/`after` fields;
  - the `task` tool's result shape;
  - that `/jev-done` text edits reach the model.
  In OpenCode the runner now writes session metadata (key, baseline, request number, attempts, receipts) to the jev-flow cache.
- **Threat model:** a process running as the same user that reads `receipt.key` or modifies the runner, cache or server is out of scope.
- **Coverage by hashes:** an earlier partitioned direct-gate batch is covered by a runner result only when the claim-set and whole-diff hashes are equal.
- **Gate limits** still mirror the local `src/lib.ts`; the MCP runs `@latest`.

### Corrections after the council's review (round 2)

The council did not ratify the first implementation. It asked for eight fixes; all are applied.

1. **`--check` is argv, not a shell string.**
   - Each `--check` is a JSON array of strings (`--check '["npm","test"]'`), validated by `parseCheckArgv`.
   - It runs as `spawn(argv[0], argv.slice(1))` without `/bin/sh -c`. Shell syntax inside an argument is passed literally; a shell must be named explicitly (`["sh","-c","…"]`).
   - `commandHash` hashes the canonical argv; the evidence header renders it POSIX-quoted.
   - An unstartable command has `start_failed` and `exit: null`.
   - Updated: `commands/jev-done.md`, `PRIVATE.md`, `workflow.md` §4c, `SKILL.md`, tests.
   - A contract test parses every documented `--check`.
2. **Checks gate acceptance.**
   - Any check that exits non-zero, times out, cannot start or has an unknown exit code gives `status: "checks_failed"` (exit 2) and a receipt with `accepted: false`, even when every part is `auto`. The real results stay in the summary and the evidence.
   - `verifyReceipt` also refuses any receipt whose `checks` are not all exit 0, not timed out and started (`receipt_checks_failed`), so a signed "accepted" receipt with a failing check never counts.
   - Checks are recorded in the state with `failed` set accordingly.
3. **F3 coverage across attempts.**
   - Once its batch is prepared, a runner attempt carries coverage metadata: `claims` (claim-set hash), `diff` (whole-diff hash), `rbatch` and `claim_ids` (16-hex hashes of the claim texts sent). The metadata is kept on the pending record, the final record (including failed ones) and a receipt written for every prepared attempt (also `unavailable`).
   - `selectGateAttempts` returns those runner attempts in `supersededBatch` together with earlier direct batches.
   - `coversRunnerAttempts` / `claimIdsOf` (`gate-batch.mjs`) and `runnerCoverage` (`runner-receipt.mjs`: the signed receipt, otherwise the state record of an interrupted attempt) apply the rule in both adapters (`hook.mjs` `coversSuperseded`, `opencode.mjs` gate status), in every direction:
     - runner → runner;
     - runner → direct `jev_gate` (single or batch);
     - direct batch → runner (now a claim-id superset plus the same whole diff, instead of equal claim-set hashes).
   - A later gate on the same request and snapshot must have the same whole diff and every claim of each earlier prepared attempt. A claim of an escalated or interrupted attempt therefore cannot be dropped.
4. **Retry.**
   - `callWithRetry` now takes a semantic `invalid(result)` check inside the single retry loop:
     - the runner passes `interpretGate`'s `retry_or_unavailable` route;
     - the candidate helper passes "`mapJevResult` is not ok".
   - A contradiction or a valid answer below the thresholds is never retried.
   - A transport failure that closed the server is retried on a new connection (`openJev().reopen`). If reconnecting fails, the result says `retry not_executed`.
   - `attempts` and the summary's `jev_calls` count the `tools/call` requests actually sent.
5. **The attempt is recorded first.**
   - `startAttempt` records the pending runner attempt before argument parsing, claims reading, input validation and the snapshot. `--help` and `--list-hunks` are excluded.
   - Invalid arguments, an unreadable claims file, invalid input, an unknown snapshot or a crash therefore leave a failed or pending latest attempt, never the earlier acceptance.
   - OpenCode already opened the attempt in `execute.before`; `execute.after` now also takes an interrupted (still pending) runner record, with its coverage metadata, from the session state.
6. **R2 ranges and grep scope.**
   - `allowedRanges` widens each hit by 40 lines and merges only overlapping or adjacent ranges. A read counts as exceeding when it overlaps a hit and is not contained in one merged range, so a read spanning the gap between two distant hits gets the hint.
   - `grepCovers`: a grep covers a hit's file when its path is the file or any ancestor directory, or when it has no path (the working directory, the repository root by default), and its `glob` (ripgrep style: braces, `!` negation; OpenCode `include`) and `type` filters keep that file.
   - The hint stays informational, and a changed hash still drops the hit silently.
7. **Message size.** `onStdout` checks every complete line against `maxLineBytes` before parsing, as well as the incomplete remainder. An oversized message, complete or fragmented, fails the pending calls and ends the server; nothing of it is parsed.
8. This section.

**New and updated tests** (303 in total, 289 before these corrections):
- `mcp-client.test.mjs` (11):
  - malformed→valid (2 calls), malformed→malformed (2 calls), and no retry of a valid escalate (1 call);
  - crash once → reconnect (2 calls, 2 `initialize`), crash always (2 calls), and crash then dead server (1 call, `retry not_executed`); a bare client reports `not_executed`;
  - an oversized complete message and an oversized fragmented one.
- `gate-run.test.mjs` (21):
  - argv checks: shell strings refused, shell syntax passed literally, `start_failed`;
  - an `auto` gate with a check exiting 3 or timing out gives `checks_failed`, a receipt with `accepted: false` and a strict `Stop` block;
  - runner retries with exact call counts: malformed first/always, crash once / then dead.
- `receipt.test.mjs` (13):
  - a signed "accepted" receipt with a failing, timed-out or unstartable check is refused;
  - runner→runner coverage (an escalated attempt, a subset refused, a complete replacement accepted);
  - an interrupted prepared attempt;
  - runner→direct `jev_gate` (a subset refused, a complete one accepted);
  - accepted run → unreadable claims / shell `--check` / invalid input → `Stop` blocks; `--list-hunks` and `--help` do not;
  - OpenCode: failing and timed-out checks, coverage, and an invalid invocation superseding an accepted one.
- `locator-hits.test.mjs` (9): hits 10–20 and 1000–1010 with read 1–1050 → hint; reads around each hit → none; close hits merge; grep with no path, the root, another directory, an excluding or keeping glob, an excluding type; the same in OpenCode.
- `candidates.test.mjs`: a malformed ranking retried once (ok after 2 calls; unavailable after 2 calls).
- `contracts.test.mjs`: every documented `--check` is valid argv.

**Verification after the corrections (run by the executor):**
1. `node --test private/jev-flow/test/` → 303 tests, 303 pass, 0 fail.
2. `npm test` → 224 tests, 224 pass, 0 fail.
3. `claude plugin validate .` → "✔ Validation passed", with no warnings (also `claude plugin validate .claude-plugin/plugin.json`).
4. The OpenCode import → `function`.
5. `git diff --stat e487dc1 -- src skills/jev README.md package.json package-lock.json test dist` → empty.
6. **Real smoke run:** the same `/tmp/jev-smoke` change and 3 claims, now with `--check '["node","clamp-range.test.js"]' --check '["node","test.js"]'`, in the original smoke session (`--session-key`), with the real server through `npx` and `OPENROUTER_API_KEY` from the shell.
   - Result: `status: "ask_user"`, exit 2, provider `openrouter`, model `typesafe/jev-1.13`, `action: "review"`, reason codes `safe_to_apply_below_auto_accept`, `confidence_below_auto_accept`, `review_required`, `safe_to_apply` 0.77, claims 1–3 `verified` (0.90 / 0.99 / 0.99).
   - Both checks exited 0; `jev_calls: 1`; receipt `de04776d…`.

**Exercised live:** the real `npx` jev MCP server over stdio, credentials from the environment (openrouter inferred), argv checks, receipt writing, and (in the first smoke run) strict `Stop` blocking a non-`auto` verdict.

**Not exercised live** (covered only by offline tests):
- a real `auto` verdict (the real verdicts so far were `review`);
- `checks_failed` against the real server;
- reconnection after a real server crash;
- the oversize limit against the real server;
- coverage across attempts;
- `SubagentStop` / `Agent` hit capture and the range hints in a live Claude Code session;
- `CLAUDE_CODE_SESSION_ID` matching the hook's `session_id` in a live plugin session;
- the whole OpenCode 2.0.12 runtime.

## Round 3 — B''' run after the R1–R3 fixes (2026-09-27)

Same task and conditions. Oracle 64/64. 101 turns, 469 s, $3.15 (A: $2.97). Main exploration 132 KB
(−32% vs A) with 44 exploration calls. **0 subagents.** The skill and /jev:jev-done loaded. The gate
runner ran through 3 Bash calls; R1 is fixed (no model copying).

- **R4 — the locator was correctly skipped.** The SessionStart directive and 8 PostToolUse directives
  (at 4…32 exploration calls) were delivered. The ticket prompt, however, names the exact
  classes/functions (RewardCardItemPhase1, RewardDisplayRules.isMaxedOut, earnedTileCount, …), and the
  skill exempts "an exact known path or symbol". So on this task the locator had nothing to find, and
  the −32% cannot be attributed to it (noise alone gave −15% between A and B). The locator's value can
  only be measured on a task described by behaviour, without code identifiers.
- **R5 — the gate stops at the first non-auto part.** The runner split the diff into 5 parts,
  part 1 escalated (claim at 0.61), and parts 2–5 were never evaluated, so the report covered 1/5 of
  the patch. The escalation raised a legitimate cross-cutting question: `CouponItem.isRewardEarned`
  is also used by the cart. The real upstream fix made the same change.
- **R6 — the gate is cautious on correct claims.** Smoke test on a trivial correct fix: `review`
  (0.59) even with evidence. `auto` completion is rare with default thresholds.

Decision (jev_decide 1.00): the runner evaluates **all** parts and aggregates one complete report
(it stops early only on a contradicted claim). Locator logic is unchanged. Next measurement: A vs B on
a behaviour-only task variant.

### Resolution of R5 and R6 (plugin 0.3.0)

- **R5.** `private/jev-flow/gate-run.mjs` now sends every part of a batch and stops early only at a
  contradicted claim; later parts are listed as `unevaluated` (`not_sent_after_contradiction`).
  `escalate`, `review`/`ask_user` and `needs_evidence` parts no longer stop the batch. After a part
  fails for good (after the per-call retry), the next part gets one reconnection; if it fails, the
  remaining parts are listed as `unevaluated` (`reconnect_failed`) and nothing more is sent. The
  single report (JSON on stdout, at most 8,192 characters) separates the semantic `verdict`
  (`contradicted` > `escalate` > `ask_user` > `needs_evidence` > `accepted`) from the operational
  `status` (`snapshot_changed` > `checks_failed` > `unavailable` > `ok`); `outcome` decides the exit
  code (a contradiction first, then `snapshot_changed`, `checks_failed`, `unavailable`, then the
  verdict). Each claim gets an overall verdict over its occurrences (`contradicted` > `unevaluated` >
  `unsupported` > `verified`), next to the per-occurrence `{c, part, verdict, confidence}` detail,
  which is the first thing dropped when the report would exceed 8 KB. The HMAC receipt (v2) lists
  every planned part (`part_ids`, per-part actions or states, verdict codes, coverage) and is
  accepted only for a complete batch: parts 1..n each once, all `auto`, all evaluated, `verdict`
  `accepted`, `status` `ok`. `/jev:jev-done`, the `jev-flow` skill, `workflow.md` and the OpenCode
  adapter tell the agent to read the whole report and answer once; a new run is allowed only once
  with genuinely new evidence for `needs_evidence`, or after a failed check is fixed or the snapshot
  changed.
- **R6.** Documented in `/jev:jev-done`, the skill and `workflow.md` §3: with the default upstream
  thresholds (`auto_accept` 0.8, `review_at` 0.5, `composite_floor` 0.7) `review` is frequent even
  when every claim is `verified`; it is reported as "gate: review (not auto)" with the real numbers,
  never as acceptance or contradiction, the thresholds stay unchanged and there is no re-run.

Real output of the runner against the local fake MCP server (`private/jev-flow/test/fixtures/fake-mcp-server.mjs`,
`FAKE_MCP_MODES` sets each call's answer), on a three-file patch that the runner splits into 3 parts,
after the council's fixes (a batch without credentials goes through the same aggregation; the 8 KB
compaction never drops a part, a check, a limit or a claim verdict):

```text
FAKE_MCP_MODES=escalate,accepted,accepted: exit=2 tools/call=3
{"outcome":"escalate","verdict":"escalate","status":"ok","conditions":[],"exit":2,"parts":[{"part":1,"verdict":"escalate","action":"escalate","reason_codes":["review_escalated"],"safe_to_apply":0.95},{"part":2,"verdict":"accepted","action":"auto","reason_codes":["accepted"],"safe_to_apply":0.95},{"part":3,"verdict":"accepted","action":"auto","reason_codes":["accepted"],"safe_to_apply":0.95}],"claims":[{"c":1,"verdict":"verified"},{"c":2,"verdict":"verified"},{"c":3,"verdict":"verified"}],"coverage":{"planned":3,"sent":3,"evaluated":3,"unavailable":0,"unevaluated":0},"jev_calls":3}
FAKE_MCP_MODES=accepted,contradicted,accepted: exit=2 tools/call=2
{"outcome":"contradicted","verdict":"contradicted","status":"ok","conditions":[],"exit":2,"parts":[{"part":1,"verdict":"accepted","action":"auto","reason_codes":["accepted"],"safe_to_apply":0.95},{"part":2,"verdict":"contradicted","action":"review","reason_codes":["claims_contradicted"],"safe_to_apply":0.95},{"part":3,"state":"unevaluated","reason":"not_sent_after_contradiction","action":null,"reason_codes":[]}],"claims":[{"c":1,"verdict":"verified"},{"c":2,"verdict":"contradicted"},{"c":3,"verdict":"contradicted"}],"coverage":{"planned":3,"sent":2,"evaluated":2,"unavailable":0,"unevaluated":1},"jev_calls":2}
no credentials, failing check: exit=2 tools/call=0
{"outcome":"checks_failed","verdict":null,"status":"checks_failed","conditions":["checks_failed","unavailable"],"exit":2,"parts":[{"part":1,"state":"unevaluated","reason":"jev_unavailable","action":null,"reason_codes":[]},{"part":2,"state":"unevaluated","reason":"jev_unavailable","action":null,"reason_codes":[]},{"part":3,"state":"unevaluated","reason":"jev_unavailable","action":null,"reason_codes":[]}],"claims":[{"c":1,"verdict":"unevaluated"},{"c":2,"verdict":"unevaluated"},{"c":3,"verdict":"unevaluated"}],"coverage":{"planned":3,"sent":0,"evaluated":0,"unavailable":0,"unevaluated":3},"jev_calls":0}
```

(Report fields `occurrences`, `checks`, `limits`, `batch`, `receipt`, `message` and `reason` are
omitted above for brevity.) `node --test private/jev-flow/test/`: 315 tests, 0 failures; `npm test`: 224 tests, 0 failures.

**Limits of this verification.** Everything above ran offline against the fake MCP server and
simulated OpenCode contexts; no live provider, no live Claude Code plugin session and no live
OpenCode runtime was exercised. The R6 numbers (0.59) come from the round 3 smoke test, not from a
new measurement. Whether aggregated reports change agent behaviour (one answer, no re-runs) is not
measured; the next A/B run should check it.

## Round 4 — behaviour-only task (DSE-45624 without code identifiers), jev-flow 0.3.0

| Run | Oracle | Turns | Wall | Cost | Main exploration | Subagents | Jev |
|---|---|---|---|---|---|---|---|
| A (no flow) | 69/69 | 28 | 141 s | $0.92 | 83 KB / 21 calls | 0 | 0 |
| B (flow) | **67/69** | 26 | 327 s | $1.00 | 39 KB / 11 calls | 1 (Haiku) | 1 rerank + gate runner |

This was the first end-to-end run of the flow: skill, locator, `jev_rerank`, `/jev:jev-done` and the
gate runner (3.3 s).

- **R7 — the locator stalls while composing the rerank call.** The locator took 199.5 s (61% of B's
  wall time) while the parent waited. 115.9 s of that was a single model turn: after reading the
  helper's large output (persisted to a file), Haiku wrote the `jev_rerank` arguments itself. The R3
  "mechanical rerank" did not apply: candidates were copied through the model, the same class of
  problem as R1.
- **R8 — a wrong diagnosis passed the claim checks.** B fixed a different cause: it treated a missing
  `totalRedemptions` as 0 instead of treating `NextRedemptionLimit: 0` as missing. The behaviour-only
  prompt had dropped the backend-data detail, so both hypotheses were plausible (n=1). The gate
  verified all 6 claims (0.89–0.99), because they described what the code does, yet it escalated
  overall (`safe_to_apply` 0.68). The agent ended "Incomplete" and asked the user, so no false
  approval.

Decision (jev_decide 1.00): make the locator's rerank truly mechanical (the helper calls `jev_rerank`
itself through the stdio client and returns only compact ranked hits; the locator never writes rerank
arguments), and let the parent keep doing independent work while the locator runs. Then re-run A and
B twice each, with the backend-data detail restored so the diagnosis is unambiguous.

### Resolution of R7 (plugin 0.4.0)

- **Helper output.** `scripts/jev-candidates.mjs` still runs `jev_rerank` (`jev_find` with `--single`)
  itself through `private/jev-flow/mcp-client.mjs` with `top_k: 5` when the F4 rule calls for it, but
  its stdout is now one compact JSON object of at most 4,096 bytes (newline included), for every
  locate branch (rerank, find, plain, exact match, none, disabled): up to 5 hits
  `{path, start_line, end_line, sha256, score, reason}` plus `ordering`, `jev`, `jev_calls`,
  `coverage_complete` and `omitted` (`compactReport` in `private/jev-flow/candidates.mjs`). The
  candidates, the map and the payload never reach stdout, so there is nothing large to persist or
  copy. `reason` is a deterministic label (window kind and the query terms matched lexically, at most
  80 characters). Over the cap, reasons are shortened, then hits dropped from the tail; paths and
  hashes are never cut. `--full` prints the old diagnostic object for tests only.
- **Validation and fallback.** A Jev answer with an unknown or repeated id, a missing score or one
  outside [0, 1], or fewer than min(`top_k`, candidates) entries is invalid as a whole: one retry with
  identical input, then the lexical order. A `jev_find` answer is also invalid when `exists` is not a
  number in [0, 1] or `exists_verdict` is not the upstream verdict for it (`answered` / `partial` /
  `absent`, `existsVerdict` in `src/lib.ts`); only validated values reach the report, whose every
  field is bounded, so the line stays within 4,096 bytes even when every hit and the optional
  metadata have to be dropped. A valid answer is sorted by score. Without credentials,
  with `--no-jev`, or when Jev is unavailable, the helper returns the top 5 candidates by lexical
  score with `ordering: "lexical"` and a note that they are not semantically ranked. The F4 routing
  and the exit codes are unchanged.
- **Locator.** `agents/jev-locator.md` grants only `Read, Grep, Glob, Bash`: the Jev tools are gone,
  and the "unavailable → call it yourself" path with them. It explicitly forbids composing or copying
  `jev_rerank`/`jev_find` arguments and reading a file where the CLI persisted the helper's output;
  the locator runs the helper, confirms only the top ranges by reading and reports.
- **Parent.** The `jev-flow` skill, `workflow.md`, `/jev:jev-locate` and the route directive (Claude
  Code and OpenCode) tell the parent to launch the locator in the background when the CLI allows it
  and to keep doing independent work without repeating the locator's search. OpenCode V2 has no
  verified way to deny tools to an agent or to background a subagent call, so there both stay
  instructions, stated in one setup diagnostic.

Real smoke run (`OPENROUTER_API_KEY` from the environment, real `jev_rerank`, stdout captured in
memory):

```text
node scripts/jev-candidates.mjs --root /Users/apana/Dev/jev-mcp --query "Where does the workflow prevent completion when verification evidence is missing or stale?"
exit 0, wall 1,650 ms, stdout 1,299 bytes, stderr 0 bytes
{"v":1,"mode":"rerank","ordering":"semantic","jev":"ok","jev_calls":1,"route":"candidates_in_several_files","coverage_complete":false,"coverage_reasons":["candidate_limit_reached","long_lines_truncated"],"elapsed_ms":1618,"hits":[{"path":"skills/jev-flow/SKILL.md","start_line":68,"end_line":71,"sha256":"96ace9b4…","score":0.9,"reason":"window; lexical terms: completion, verific, miss"}, … 4 more …],"omitted":43}
same command with --single (real jev_find): exit 0, wall 893 ms, stdout 1,414 bytes
{"v":1,"mode":"find","ordering":"semantic","jev":"ok","jev_calls":1,"exists_verdict":"answered","exists":0.96, … 5 hits …}
```

(Hashes shortened and hits elided above; each run printed 5 hits with full hashes.) With 48
candidates, the helper's old stdout carried every candidate text, the map and the payload.
`node --test private/jev-flow/test/`: 322 tests, 0 failures; `npm test`: 224 tests, 0 failures.

**Limits of this verification.** The tests run offline against the fake MCP server and simulated
OpenCode contexts. The smoke run exercised the helper and a live provider, not a live locator
session: whether Haiku now finishes quickly, and whether the parent actually works in parallel, is
for the separate A/B re-runs.

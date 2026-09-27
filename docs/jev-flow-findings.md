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

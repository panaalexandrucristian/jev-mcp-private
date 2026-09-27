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

When files are unknown or several results are semantically ambiguous. Skip for an exact known path or symbol. The parent delegates to `jev-locator` (`/jev:jev-locate` in Claude Code, `/jev-locate` in OpenCode). The locator runs on a cheaper model than the parent: `model: haiku` in its frontmatter, overridable with `JEV_FLOW_LOCATOR_MODEL` (§5). The child runs the helper (§4), which **applies the ranking rule itself**: when the rule calls for `jev_rerank` or `jev_find`, the helper sends its payload (`top_k: 5`) through the jev MCP server on stdio and prints only the compact hits (at most 5, at most 4 KB), mapped to paths, lines and sha256, so the model can neither skip the step nor copy candidates into a Jev call (R7). The locator has no Jev tool.

**The parent keeps working (R7).** Launch the locator in the background when the CLI allows it (Claude Code: `run_in_background` on the Agent/Task call; OpenCode: a background subagent call if the runtime supports one) and meanwhile do independent work: read the files already known, reproduce the problem, plan the checks. Do not search for the same question in the main thread while the locator runs; wait for its report before reading anywhere near its question.

| Helper route (`route`) | Helper `mode` | Next step |
| --- | --- | --- |
| The query is an exact path (whole path suffix), or an identifier/qualified name found as a whole, case-sensitive token (not a substring: `cache` ≠ `cacheable`), in exactly one file | `exact_match` (`exact_match_in_one_file`, `confirm_by_reading: true`, `exact_path`, `fallback_tool`) | Read the match. Use it only if it answers the question; lexical uniqueness is not proof. Otherwise re-run the helper with `--fallback`: it runs the fallback ranking itself. |
| More than 3 candidates, or candidates from 2 or more files | `rerank` (`more_than_3_candidates` / `candidates_in_several_files`) | The helper ran `jev_rerank` with `top_k: 5`; with `ordering: "semantic"` use `hits` in order. |
| Same thresholds, and the question asks for one definitive location (`--single`) | `find` | The helper ran `jev_find` with `top_k: 5`; check `exists_verdict` before `hits`. |
| 1–3 candidates in one file | `plain` (`few_candidates_one_file`) | Read them locally; a small set does not make the answer certain. |
| No candidates, or Jev disabled for the repo | `none` (`no_candidates`) / `disabled` (`jev_disabled`) | Rephrase or widen once, or read locally; never report absence from the repository. |

```json
{"query":"<behavior sought>","candidates":[{"id":"c0","text":"<path:start-end + fragment>"}],"top_k":5}
```

Tool: `jev_find` (the same shape goes to `jev_rerank`; the helper builds it and sends it itself; it never reaches stdout). `absent` covers only the submitted candidates. Without credentials in the helper's environment, with `--no-jev`, or after two failed or invalid answers, the helper returns the top 5 candidates by lexical score with `ordering: "lexical"` and `jev` `unavailable` / `skipped` / `invalid_response`: explicitly not semantically ranked. The locator never composes or copies `jev_rerank` / `jev_find` arguments (its frontmatter grants no Jev tool) and never reads a file where the CLI persisted the helper's output. It only confirms the top hits' ranges by reading; grep results that call for ranking are not hand-built into candidates: the locator runs the helper again with those terms (its second batch). The report states `jev_used` (`rerank`/`find`/`none`) and why.

**Range-only reading (parent).** After the report, the parent reads only the returned ranges (Read `offset`/`limit`; up to 40 lines around them). The hooks remember the hits (§5) and hint on **every** read that overlaps a hit and is not contained in one range of the merged union of the hits widened by 40 lines (a read spanning the gap between two distant hits counts), and on every grep whose scope covers a hit's file: its path is the file or any ancestor directory, or no path (the repository root), and its `glob` / `type` filters keep that file; a partial overlap within the margin gets no hint, and a hit whose file sha256 changed is dropped silently. Hints only: nothing is blocked, in strict mode either.

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

Always after code changes, on the final snapshot: the repository's own test/build/typecheck/lint commands, named as `--check` to the gate runner (§4c), which runs them itself and records their real output and exit codes. When results support ambiguous claims, `jev_verify` with the real logs in `evidence`. Failing tests are never turned into success through Jev.

### Step 6 — Optional intermediate review

Risky patch or feedback wanted before final checks. Skip when the gate follows immediately on the same patch and evidence.

```json
{"request":"<request>","diff":"<real diff>","tests":"<real results available>"}
```

Tool: `jev_review` → `action`, `reason_codes`, `limiting_rubrics`, `safe_to_apply`, `composite`.

### Step 7 — Final gate

Required after code changes; launched by `/jev:jev-done` (`/jev-done` in OpenCode) and executed by the **gate runner** `scripts/jev-gate-run.mjs` (§4c): the model writes only claims with evidence ids; the runner collects the diff, runs the checks, reads the excerpts, builds the bounded payload, calls `jev_gate` itself on every part and returns one aggregated report (§4c). Tool arguments are model output tokens, so large evidence never passes through the model (finding R1). `jev_gate` judges each claim **only** against `evidence` (`src/index.ts` claim questions: "Use only the evidence field as factual support … If a claim needs a diff or test log as support, it must be supplied in evidence"). So every claim is paired with its own support, built by the payload preparation (§4b) from real material: the diff hunks that implement it, real code excerpts it depends on, and the identified output of the checks it cites. A claim with no evidence, an unknown evidence id or a placeholder is refused before any call. A call as the runner sends it:

```json
{"request":"[jev-flow batch v2 id=<32 hex> part=1/1 slice=1/1 claims=<16 hex> diff=<16 hex> snap=<64 hex>]\n<request>","diff":"<sanitized diff slice>","tests":"<rendered real command output>","claims":["<parseFlags rejects an empty value with E_EMPTY>","<npm test passed>"],"evidence":[{"id":"hunk-2","text":"[hunk-2] <path>\n<diff hunk implementing the claim>"},{"id":"cmd-1","text":"[cmd-1] $ npm test\nexit: 0\n<real output>"}]}
```

Tool: `jev_gate` → `action`, `review`, `verification.results`, `reason_codes`. Claims about tests must be supported in `evidence`, not only in `tests`. A patch beyond one call's limits is gated as a **batch** of parts (§3, large patches); every part is evaluated (only a contradicted claim stops the batch early), and completion needs every part accepted.

### Step 8 — Final report

No Jev call. Answer **once**, from the runner's complete aggregated report: the change, the checks actually run, the outcome with its verdict and status, every part's result and every claim's overall verdict (or the fixed phrase), the coverage, the limits and all remaining problems and questions together. If completion is not verified, end with a line starting with `Incomplete:`.

### Auxiliary branches

| Situation | Input | Result and limit |
| --- | --- | --- |
| External text that may be irrelevant or carry injected instructions | `jev_screen` `{"text":"<external text>","purpose":"<information sought>"}` | `pass/review/block/skip`; apply the `jev` skill policy. Screening text already in context recovers no bytes. |
| Documentation vs implementation, summary vs source | `jev_compare` `{"passage_a":"<A>","passage_b":"<B>","aspects":["<property>"]}` | Independent per-aspect relations; agreement does not prove truth. |
| Several syntactic matches, one correct meaning | `jev_extract` `{"document":"<document>","fields":[{"id":"version","pattern":"[0-9]+\\.[0-9]+\\.[0-9]+","description":"The current supported release version"}]}` | Verbatim value and status. Use a plain parser/regex when one deterministic rule suffices. |

## 2. Budgets

| Element | Budget / rule |
| --- | --- |
| Location | One active locator per question, in the background when the CLI allows it; the parent continues independent work meanwhile but never duplicates the locator's search in the main thread. Helper stdout: at most 5 hits and 4,096 bytes. |
| Candidates | At most 48 fragments per call, each at most 1,000 characters including source identification. |
| Results to the parent | At most 5 locations and 4,000 characters, with path, hash, range and short reason. |
| Search extension | At most two semantically different batches per question; the second only with new scope or evidence. |
| Route directive | At `SessionStart` and on every prompt: load `jev-flow`, delegate broad discovery to `jev-locator`, finish code changes with `/jev:jev-done`. Only with `JEV_FLOW=on` (opt-in); none when the repo disables Jev. |
| Exploration hint | At every multiple of 4 exploration calls in the same request (4, 8, 12, …); the re-read hint (second re-read of the same range with the same hash) once per request. Both on one event give one message. |
| Decision | One call per set of alternatives, evidence and priorities. |
| Gate | One runner run per final snapshot (one `jev_gate` call per part, every part evaluated; one part unless the patch exceeds a call's limits); again only once with genuinely new evidence for `needs_evidence`, or after a failed check is fixed or the snapshot changed (a new snapshot needs a new gate); never for `review` / `ask_user` / `escalate` without such a change, and never for a more favourable verdict. The runner does the one operational retry per call and at most one reconnection after a part fails for good. Per call: at most 16 claims, 16 evidence items, 200,000 evidence characters, 50,000 characters per document, 2,000 per claim (`src/lib.ts:241-253`). |
| Range hint | Every read or grep that re-covers a fresh locator hit beyond a 40-line margin (§1, step 1). |
| Hooks | Local, short logic only; no tests, model calls or whole-repo scans in any hook. |

Consequential `jev_decide` results need a human when confidence is missing or below **0.8**, or when an escape hatch or relevant warnings appear. This is a flow threshold, not a correctness guarantee.

## 3. Result and completion policy

Interpretation order (implemented in `private/jev-flow/policy.mjs`: `interpretGate`, `interpretDecide`, `shouldRetry`):

A gate counts as **accepted** only through `validateGateResult`, shared by both adapters, and only for the claims actually sent in that call. Required: `tool` is `jev_gate`, `action` is `auto`, `truncated` is `false`, `reason_codes` is exactly `["accepted"]`. Review: `action` `auto`, `reason_codes` exactly `["accepted"]`, no `status`; thresholds in [0,1] with `review_at` ≤ `auto_accept`; all four rubrics (`correctness`, `spec_match`, `test_gap`, `blast_radius`) present with a score in [0,2], a probability distribution that is either `null` (not reported by the provider, valid upstream) or a valid `0/1/2` distribution whose expected value matches the score within the upstream `SCORE_MEAN_TOLERANCE` (0.02 + 1e-12), and confidence ≥ max(`auto_accept`, 0.8); `composite` in [0,1], equal (±1e-6) to the weighted rubric composite of `src/lib.ts` and ≥ max(`composite_floor`, 0.7); `safe_to_apply` ≥ max(`auto_accept`, 0.8). Verification: `action` `auto`; thresholds in [0,1] with `review_at` ≤ `auto_accept`; one result per call claim, in order, with the identical claim text (a claim longer than the tool's 2,000-character cap was truncated by the tool and is not accepted); each result `verified`, action `auto`, no `status`, a valid `verified/contradicted/unsupported` distribution whose argmax is `verified`, and confidence ≥ max(`auto_accept`, 0.8); the summary counts equal the results (all verified, zero contradicted, unsupported, needs-review and invalid). The flow minimums (0.8 / 0.8 / 0.7) apply even if the call lowered its thresholds. `validateGateResult` returns `{accepted, problems, malformed, below_flow_minimum}` and separates two kinds of non-acceptance: a **malformed** `auto` (bare, partial, out of domain, internally inconsistent, a value below the call's own threshold, or not tied to the call's claims) is treated like an invalid response (`retry_or_unavailable`); a **well-formed** `auto` that only misses the flow minimums (a value that satisfies the call's own lowered threshold but not 0.8 / 0.8 / 0.7) is not retried and routes to `ask_user`, with the misses listed in `below_flow_minimum`.

1. **Valid contradicted claim** → stop and ask the user with verdict and numbers. An invalid answer elsewhere does not cancel it.
2. **Transport or `invalid_response`** → one logical retry with identical input. If it fails: continue the real checks and report **`Jev unavailable; gate not evaluated`**. Never record `auto`. No retry after a user cancellation.
3. **Well-formed `auto` below the flow minimums** → ask the user, with the numbers; no identical re-call (`interpretGate` route `ask_user`).
4. **Semantic `review` / low confidence on a routine step** → manual inspection, then justified continuation; no identical re-call. For the final gate a `review` is not acceptance: completion is not verified (see *`review` on correct claims* below).
5. **Gate `escalate` or low confidence; inconclusive consequential decision** → stop and ask. A `review` caused only by missing evidence (`claims_unsupported` / `incomplete_context`) may be resolved with new evidence and a new call; otherwise completion is not declared.
6. **Valid `auto`** → applies only to the evaluated snapshot and claims.

**Aggregating a batch (R5).** The gate runner sends every part and stops early only at a contradicted claim. It reports two separate dimensions: the semantic `verdict` (the most severe evaluated part: `contradicted` > `escalate` > `ask_user` (a `review` or a well-formed `auto` below the flow minimums) > `needs_evidence` > `accepted`) and the operational `status` (`snapshot_changed` > `checks_failed` > `unavailable` > `ok`). The `outcome`, which decides the exit code, takes a contradiction first, then `snapshot_changed`, `checks_failed`, `unavailable`, then the verdict. Each claim's overall verdict is the most severe of its occurrences in the parts: `contradicted` > `unevaluated` > `unsupported` > `verified`, so a contradiction is never hidden by an occurrence that was not evaluated. The agent reads the whole report and answers once.

**`review` on correct claims (R6).** With the default upstream thresholds (`jev_gate` in `src/index.ts`: `auto_accept` 0.8, `review_at` min(0.5, `auto_accept`), `composite_floor` 0.7; `reviewAction` in `src/lib.ts`), a patch review is `auto` only when `safe_to_apply` and the lowest rubric confidence reach `auto_accept` and the composite reaches `composite_floor`; below `review_at` it escalates; in between it is `review`. `review` is therefore frequent even when every claim is `verified` with complete evidence (a smoke test on a trivial correct fix: `review`, `safe_to_apply` 0.59; `docs/jev-flow-findings.md`, round 3). Report it as it is — "gate: review (not auto)" with the real `safe_to_apply`, reason codes, claim verdicts and confidences and the limits — never as acceptance and never as a contradiction. The thresholds stay as they are (the flow does not lower them), there is no re-run for a more favourable verdict, and completion is not verified (`Incomplete:` or a question to the user).

The flow retry is distinct from the transport's internal HTTP retries (local transports may try up to three times); report them separately when known. A pre-existing `jev` server configuration is never changed.

**Opt-out.** `.jev-flow-denylist` with a `*` line means: no data to Jev, run local checks, report **`Jev disabled for this repo; gate not evaluated`**.

**Large patches.** The payload helper (§4b) splits a patch that exceeds one call into a **batch**: the diff is cut into contiguous slices (by file and hunk; an oversized hunk fills a slice up to a line end and continues in the next, and oversized evidence continues in identified pieces `hunk-N#k`, `cmd-N#k`; nothing is cut silently). Each claim goes to every part whose slice holds a hunk it cites; more than 16 claims on a slice spill into further parts over the same slice. Every part's `request` starts with the manifest line `[jev-flow batch v2 id=<id> part=k/n slice=i/m claims=<claim-set hash> diff=<whole-diff hash> snap=<snapshot>]`. `id` hashes the snapshot, the number of slices, the claim-set and whole-diff hashes, and a canonical digest of every planned part's complete input (the request without its label, diff, claims, evidence, tests and any other parameter), in part order; the label itself is excluded, so there is no circularity. Changing any part's evidence, tests, request or parameters, or moving claims between parts, therefore breaks the manifest, and parts of two preparations never combine: a rebuild is a new batch.

A batch counts as accepted only when, for every part 1..n, the latest attempt of that part is finished, not failed or refused, from the current request, on known and equal snapshots equal to the current one, passes `validateGateResult` for its claims, and the parts rebuild their manifest from their **complete inputs as sent** (the transcript's `tool_use` input in Claude Code, the in-memory input in OpenCode): same label fields, every slice present with one text, the concatenated slices matching the `diff` hash, the union of claims matching the `claims` hash, and the id recomputed from the per-part digests (`verifyBatchContents` in `private/jev-flow/gate-batch.mjs`, shared by both adapters). A missing, unfinished, failed, refused, non-accepted or altered part, a gate outside the batch between its parts, or a later gate call, leaves it unverified. A later gate that replaces an earlier batch on the same request and snapshot (a single call, or a rebuilt batch) counts only if it covers both the earlier batch's claims and its patch: the same claim set and the same whole diff (label `claims` and `diff` hashes), or, when every part of the earlier batch is known, a superset of its claims and a diff that contains every file header and hunk of its whole diff (`coversEarlierBatches`). A replacement that keeps the claims but drops a file or hunk is therefore rejected, including when only the first part of the earlier batch was sent. The final report states that verification was partitioned: each part judged its slice and its claims, and no single call evaluated the whole patch.

## 4. Local helper: `scripts/jev-candidates.mjs`

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-candidates.mjs" --root "<repo-root>" --query "<query>" --limit 48 --chunk-chars 1000
```

Flags: `--root`, `--query` (required); `--limit` 1–48 (default 48); `--chunk-chars` 200–1000 (default 1000); `--window-lines` 1–60 (default 60); `--max-file-bytes` (default 1 MiB). Exit codes: `0` success, `2` usage error or a root outside a git work tree, `3` sanitize input too large, `1` unexpected error. Errors are JSON on stderr.

Output (one JSON line on stdout, at most 4,096 bytes including the newline; R7):

```json
{
  "v": 1, "mode": "rerank", "ordering": "semantic", "jev": "ok", "jev_calls": 1, "route": "candidates_in_several_files",
  "coverage_complete": false, "coverage_reasons": ["candidate_limit_reached"], "elapsed_ms": 5200,
  "hits": [{"path": "src/example.ts", "start_line": 20, "end_line": 48, "sha256": "<full-file sha256>", "score": 0.91, "reason": "window; lexical terms: flag, parse"}],
  "omitted": 43
}
```

- `mode`: `rerank` / `find` (the rule called for Jev), `plain` (1–3 candidates in one file), `exact_match` (adds `confirm_by_reading: true`, `exact_path`, `fallback_tool`), `none` (no candidates) or `disabled` (denylist `*`). `route` is the rule's reason (`fallback:<reason>` after `--fallback`).
- `ordering`: `semantic` only for a valid Jev answer, sorted by score (relevance or probability, descending; ties keep the server's order). Otherwise `lexical`: the top candidates by the helper's lexical score, with `note: "lexical order, not semantically ranked"`.
- `jev`: `ok`, `unavailable` (no credentials or transport/tool failure; `jev_reason` says why), `invalid_response` (two invalid answers), `skipped` (`--no-jev`), `not_needed` or `disabled`. `jev_calls` counts the tools/call requests actually sent. A `find` answer adds `exists_verdict` (`answered` / `partial` / `absent`) and `exists`, and a note that `absent` covers only the candidates sent.
- An answer is invalid as a whole, retried once with identical input and then replaced by the lexical order, when an id is unknown or repeated, a score is missing or outside [0, 1], or it is partial (not min(`top_k`, candidates sent) entries); a `jev_find` answer also when `exists` is not a number in [0, 1] or `exists_verdict` is not the upstream verdict for it (`existsVerdict` in `src/lib.ts`).
- `reason` is a deterministic English label of at most 80 characters: the window kind (`window`/`outline`) and the query terms (stemmed) it matched lexically; never a semantic explanation.
- `omitted` counts candidates not listed. Over 4,096 bytes, reasons are shortened (`reasons_shortened: true`), then hits are dropped from the tail (`size_capped: true`), then optional metadata (`metadata_dropped: true`); paths and hashes are never cut, and every other field is an enum, an integer or a short bounded string.
- The candidates (`{id, text}`), the local `map` (id → path, sha256, lines, kind, lexical score, matched terms) and the payload `{query, candidates, top_k: 5}` stay inside the helper. Only `candidates` go to `jev_find` / `jev_rerank`; the query is cut to `jev_rerank`'s 2,000-character cap. The rule is in §1, step 1 (`recommendNext` in `private/jev-flow/candidates.mjs`); the call goes through the MCP client (§4c, step 8: same server, credentials and retry); `compactReport` builds the output. `--single` marks a question that asks for one definitive location; `--fallback` runs the fallback ranking after an exact match that reading did not confirm; `--no-jev` never calls Jev.

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

### Payload helper: `scripts/jev-gate-payload.mjs` (diagnostics)

The completion procedure uses the gate runner (§4c); this helper remains for diagnosing a payload by hand and for the tests. Its preparation logic (`prepareGateBatch`) is the one the runner uses.

```sh
git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-payload.mjs" --list-hunks --root .
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-payload.mjs" --root . < /tmp/jev-gate-input.json
```

`--list-hunks` sanitizes the diff and lists `{id, path, header, chars}` per hunk (`hunk-1`, `hunk-2`, … in diff order; a file section without hunks is one unit). The main mode reads `{request, diff, claims: [{text, evidence: [ids]}], commands?: [{command, exit: int|null, output}], excerpts?: [{id, path, lines?, text}]}` and prints `{ok, problems, limits, batch, hunks, calls: [{part, of, input}]}`. Evidence ids: `hunk-N`, `file:<path>` (all hunks of a file), `cmd-N` (1-based) and excerpt ids. Everything is sanitized first. Redaction (credential markers) is allowed; **removal is not**: a diff section dropped for an excluded, denylisted or unparseable path, or a line replaced because it still looks like a secret, in the diff, a command output, an excerpt or a claim, makes the input not ready (`ok: false`, exit 4, no calls, the reasons listed per source), because that content would go unevaluated. The removed material is never emitted; excerpts from excluded paths are refused. A missing exit code is rendered as `exit: unknown (not reported by the tool)`, never invented. The `tests` field repeats the rendered command output, cut visibly when it exceeds 48,000 characters (the full output stays in the `cmd-*` evidence items). `limits` lists redactions, hunks no claim cites and whether the gate is partitioned. `ok: false` (exit 4) returns no calls: content removed by sanitizing, a claim without evidence, an unknown id, a placeholder claim, a slice no claim covers, a claim whose evidence cannot fit one call, more than 16 parts, or an unknown snapshot. The helper binds the batch to the snapshot it computes, so the input file must live outside the repository. It writes nothing. Structural pairing does not prove that the evidence supports the claim; Jev judges that.

### Gate runner: `scripts/jev-gate-run.mjs`

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-run.mjs" --root . --list-hunks
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-run.mjs" --root . --claims /tmp/claims.json --check '["npm","test"]' [--check '["<cmd>","<arg>"]']... [--check-timeout <s>] [--session-key <key>]
```

Input (`--claims <file|->`, at most 1 MiB): `{"request": "<verbatim request>", "claims": [{"text": "...", "evidence": ["hunk-N", "file:<path>", "cmd-N", "<excerpt id>"]}], "excerpts": [{"id": "caller", "path": "src/a.ts", "lines": [40, 62]}]}`. `cmd-N` is the Nth `--check` (at most 8); each `--check` is a JSON array of strings (argv). The runner refuses `diff`, `commands`, `tests`, `evidence` and excerpt `text`: it reads every source itself, so logs and exit codes cannot be declared by the model.

Steps (`private/jev-flow/gate-run.mjs`):

1. Denylist `*` → `status: "disabled"`, exit 3, the fixed phrase; nothing is sent.
2. The attempt is recorded first, before any validation (`startAttempt`; not for `--help` / `--list-hunks`): an invalid invocation, unreadable claims, an unknown snapshot or an interrupted run therefore leaves a failed or pending latest attempt, never the earlier acceptance. Snapshot S0. With a jev-flow session (Claude Code: `CLAUDE_CODE_SESSION_ID` from the Bash environment; OpenCode: `--session-key`, inserted into `/jev-done` by the adapter) whose `receipt.key` exists, the attempt is recorded at once as a pending gate attempt: from here on it supersedes any earlier gate, even if it fails.
3. Each `--check` runs as argv (`spawn(argv[0], argv.slice(1))`, no shell) in the repository, stdout and stderr interleaved; a timeout (default 900 s) kills its process group and gives `exit: null`; a command that cannot start has `start_failed`. Any check that did not exit 0 prevents acceptance (`checks_failed`, exit 2), whatever Jev answers. Output beyond the first 8,000 and last 32,000 characters is cut with a visible marker (`limits.checks_output_cut`). The runs are recorded as real checks (command hash, exit code, snapshots).
4. Snapshot S1 must equal S0 (a check that writes tracked or non-ignored files makes the run `not_ready`).
5. **Scope.** With the session baseline (`baseline.json`, written once at session start: HEAD and the paths already changed, with content hashes): `git diff <baseline HEAD>` plus `git diff --no-index /dev/null <file>` for every untracked non-ignored file. A path already changed at session start whose content is unchanged is left out and listed in `limits.unattributed`; one changed again is included and listed in `limits.preexisting_mixed`, because its earlier changes cannot be separated (the baseline keeps hashes, not content). Without a usable baseline: `git diff HEAD`, everything included, `unattributed` says attribution is unknown. Binary files and submodules stay in the diff and are listed in `limits.unevaluated`; an empty diff is `not_ready`.
6. Excerpts are read from the files (`lines` 1-based, at most 400 lines, numbered). `prepareGateBatch` (§4b) sanitizes, applies the limits, partitions only when one call is not enough and labels every part with the batch manifest (`snap=` S0). Any problem → `not_ready`, exit 4, no call.
7. Credentials from the inherited environment only (never from `~/.claude.json`): `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY` + `JEV_API_BASE_URL`, a Cloudflare token + `CLOUDFLARE_ACCOUNT_ID`, or `AI_GATEWAY_API_KEY`; with `OPENROUTER_API_KEY` and no `JEV_PROVIDER`, the server gets `JEV_PROVIDER=openrouter`. None, or a server that cannot start → every part is listed as `unevaluated` (`jev_unavailable`), nothing is sent, and the run goes through the same aggregation (snapshot S2, checks, `outcome`, receipt): `unavailable`, exit 3, **"Jev unavailable; gate not evaluated"**, unless a check failed (`checks_failed`, exit 2) or the snapshot changed. An invalid `JEV_FLOW_MCP_COMMAND` stays `invalid_input`, exit 4.
8. The server starts as in the plugin manifest (`npx -y --package=@jkudish/jev-mcp@latest jev-mcp`, cwd a temporary directory) or from `JEV_FLOW_MCP_COMMAND` (a JSON argv array, no shell). MCP over stdio (`private/jev-flow/mcp-client.mjs`): `initialize` (protocol `2025-11-25`), `notifications/initialized`, `tools/call`; newline-delimited JSON-RPC with id correlation; timeouts 120 s for the handshake (npx may download) and 300 s per call; at most 8 MiB per message; the server's stderr is never printed raw (a redacted tail at most in error reasons). One retry with identical input after a transport failure or `invalid_response`; a second failure → `unavailable`, exit 3.
9. **Every part** is sent in order and interpreted with `interpretGate` / `validateGateResult` (§3); `accepted`, `needs_evidence`, `ask_user` (review) and `escalate` parts are recorded and the next part is sent. Only a contradicted claim stops the batch: the remaining parts are listed as `unevaluated` (`not_sent_after_contradiction`). A part that still fails after the per-call retry is `unavailable`; before the next part the runner reconnects **once**, and if that fails the remaining parts are listed as `unevaluated` (`reconnect_failed`) and nothing more is sent (each later definitive failure gets the same single reconnection). The report and the receipt are built from the same per-part record (§3, aggregating a batch).
10. Snapshot S2 must equal S0; otherwise `status: snapshot_changed` (exit 4 unless a claim was contradicted). The checks and the snapshot are evaluated after every run, also after a contradiction or an unavailable part, and both dimensions are reported.
11. With a session, a **receipt** is written (below) and the attempt is closed with its receipt id.

Once the batch is prepared, the attempt carries its coverage metadata (claim-set, whole-diff and batch hashes and the 16-hex ids of the claims sent), in the state and in its receipt, also when it fails later. **Coverage (F3) across attempts:** on the same request and snapshot, a later gate (runner or direct `jev_gate`) counts only if it covers every earlier prepared attempt: the same whole diff and all of its claims (earlier direct batches as before, from their transcript inputs; earlier runner attempts from their signed receipt, or from the state record when interrupted). A claim that was not accepted cannot be dropped by a new attempt.

Retries (`callWithRetry`): one retry with identical input after a transport failure, a JSON-RPC-level invalid response, or an answer `interpretGate` routes to `retry_or_unavailable`; a server that closed is reconnected for the retry, and if that fails the retry is reported as not executed; the summary's `jev_calls` counts the calls actually sent. A server message larger than 8 MiB, complete or still incomplete, ends the session without being parsed.

Output: one JSON line, at most 8,192 characters, in English, and no separate report file: `{jev_flow_gate_run: 1, outcome, verdict, status, conditions, exit, receipt, snapshot, checks: [{n, command, exit}], base, limits, batch: {id, parts, slices}, parts: [{part, verdict, action, reason_codes, safe_to_apply} | {part, state: "unavailable"|"unevaluated", reason?}], claims: [{c, verdict}], occurrences: [{c, part, verdict, confidence}], coverage: {planned, sent, evaluated, unavailable, unevaluated}, jev_calls, reconnects?, message?, reason?, problems?}` (`c` is the 1-based claim number; an unevaluated occurrence has `confidence: null`; `jev_calls` counts the `tools/call` requests actually sent, retries included). Before the gate (disabled, invalid input, not ready, no credentials) `outcome` equals `status` and `verdict` is `null`. `conditions` lists every operational condition (`snapshot_changed`, `checks_failed`, `unavailable`), also those the outcome does not name. When the line would be larger, it is compacted step by step and never loses a part, a check, a limit or a claim's overall verdict: the per-occurrence detail is dropped first (`occurrences_omitted: n`); then `uncited_hunks`, `unattributed`, `preexisting_mixed` and `unevaluated` become `{count: n}`, redactions are summed per kind (`{kind: total}`) and `checks_output_cut` becomes `{n: chars}`; problems are capped at six plus a stated omission; then `claims` becomes verdict → claim-number ranges (`{"verified": "1-12,14", "contradicted": "13"}`); then `parts` become `[part, verdict|state, action, [reason_codes], safe_to_apply]` and `checks` `[n, exit, ...flags]` (`timed_out`, `start_failed`, `cut:<chars>`). No reason code is cut, there is no separate report file, and `summary_truncated: true` marks any compaction. No diff, log, excerpt or Jev explanation is printed. Exit codes: `0` accepted (every part `auto` and valid, every check passed), `2` contradicted / checks failed / escalate / ask_user / needs_evidence, `3` unavailable or disabled, `4` invalid input, not ready or snapshot changed, `1` internal error.

**Receipts.** `private/jev-flow/runner-receipt.mjs`. At session start (Claude Code `SessionStart`; OpenCode: the first prompt of a session) a 32-byte random `receipt.key` (mode 0600) is created in the session's metadata directory. The runner writes `receipts/<id>.json` for every attempt that prepared a batch, with metadata only: `{v: 2, id, session, repo, req, boot, snap, snap_after, base, base_mode, batch, parts (planned), part_ids, actions (per planned part: the gate action, `auto` when accepted, or `unavailable` / `unevaluated`), verdicts (verdict codes per part), coverage: {planned, sent, evaluated, unavailable, unevaluated}, claims (claim-set hash), diff (whole-diff hash), claim_ids (16-hex hashes), checks: [{n, cmd hash, exit, timed_out, start_failed}], verdict, status, outcome, accepted, ts_start, ts_end}` plus an HMAC-SHA256 over its canonical JSON. `Stop` (and the OpenCode gate status) accepts a runner attempt only when it is the latest gate attempt of the request and its receipt verifies: the HMAC under this session's key, the session, the attempt's request and boot, `snap` and `snap_after` equal to the current snapshot, `verdict: "accepted"`, `status: "ok"`, `outcome: "accepted"`, the whole batch (`part_ids` exactly 1..n, one `auto` action and one verdict list per part, coverage with every part evaluated and none unavailable or unevaluated), every check with exit 0 (no timeout, started), and coverage of every earlier prepared attempt of the request. A forged, edited or replayed receipt (another request, session or snapshot) fails; a JSON summary printed or pasted anywhere is never evidence. An earlier partitioned batch of the same request is covered only by equal claim-set and whole-diff hashes. Threat model: the model inventing or reusing results. A process of the same user that reads the key or changes the runner, the cache or the server is out of scope.

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
- A **batch** of gate parts counts as accepted under the rule in §3 (large patches); the state keeps per part only its manifest metadata (`batch` id, `part`, `of`), never claims, diffs or verdicts, and the Stop hook re-reads every part from the transcript. Up to 64 gate attempts are kept; a part trimmed from the list is a missing part.
- A **gate** counts as accepted only when all of this holds: its call is the latest gate *attempt* of this session boot by start time, where attempts include calls that started and never finished (still pending or cancelled), calls that failed, and calls refused by the flow's own `PreToolUse` guard (recorded as failed and `denied` before the refusal is returned, because no Post event follows a denied call); its request is the one current when the call *started* (a new user prompt, even before the call finishes, makes it another request's call); its pre-call snapshot (from `PreToolUse`, with the same input hash) and post-call snapshot are both known and equal; that snapshot equals the current one; and its result, re-read from the native transcript, passes `validateGateResult` for the claims in the transcript's `tool_use` input (§3). Any later attempt that is not accepted supersedes an earlier accepted one. As a second check that does not depend on any state write, the transcript re-read also rejects the candidate when any later `jev_gate` `tool_use` (denied, cancelled or otherwise) follows it in the main transcript (`later_gate_call_in_transcript`).

### Claude Code (`hooks/hooks.json` → `scripts/jev-flow-hook.mjs` → `private/jev-flow/hook.mjs`)

| Event | Behavior |
| --- | --- |
| `SessionStart` | Retention cleanup; baseline snapshot; once per session, the gate runner's `receipt.key` and `baseline.json` (§4c); records the parent model's alias (`opus`/`sonnet`/`haiku`/`fable`, from the input `model`) for `JEV_FLOW_LOCATOR_MODEL=inherit`; on `startup`/`resume`, previous gate records are discarded and the boot counter increases, so a restart always starts with an unknown gate. Context: the disabled-repo message when the denylist disables Jev, otherwise the route directive (only with `JEV_FLOW=on`). |
| `UserPromptSubmit` (added: needed to delimit requests) | Starts a new request: increments the request number and resets the exploration counter, re-read tracking and the hint flags. Returns the route directive as `additionalContext` on every prompt (only with `JEV_FLOW=on`, and not when the repo disables Jev), so the flow applies without the prompt asking for it. |
| `PreToolUse` on `Agent` / `Task` (added: locator model) | For `subagent_type` `jev:jev-locator` or `jev-locator` with `JEV_FLOW_LOCATOR_MODEL` set: `haiku`/`sonnet`/`opus` → `updatedInput` with that `model`; `inherit` → the recorded parent alias. No `permissionDecision` is returned, so the normal permission flow stays (Claude Code 2.1.283 applies an `updatedInput` without a decision as a plain input update). An invalid value, or `inherit` with an unknown parent, leaves the call unchanged and adds one `systemMessage` per session. Unset: nothing, the frontmatter's `haiku` applies. |
| `PreToolUse` on `mcp__(plugin_jev_)?jev__jev_.*` | Denies (`permissionDecision: "deny"`) when `.jev-flow-denylist` has `*`, or when any string in the payload holds a recognizable unredacted credential; the reason names the credential kinds, never values. A refused `jev_gate` is first recorded as a completed, failed attempt `{id, req, boot, input, before: "unknown", after: "unknown", ts, failed: true, denied: true}` (metadata only); the refusal is returned even if that write fails for any reason (busy lock, `EACCES`, `ENOSPC`, …); the output then adds a `systemMessage` naming only the error code and stating that the state was not updated (no payload, no claim of persistence), and the transcript check at `Stop` remains the fallback. For an allowed `jev_gate`, opens a pending attempt with the pre-call snapshot, input hash, request number, boot and start time, plus the batch manifest fields when the `request` carries a label. The guard is independent of `JEV_FLOW`. |
| `PreToolUse` on `Bash` (added: test freshness) | For commands classified as tests, opens a pending run with the pre-run snapshot, command hash, request number, boot and start time. Never blocks. |
| `PostToolUse` | Main thread only for hints (`agent_id` present = subagent → no hints, avoiding delegation loops). Counts exploration (`Read`, `Grep`, `Glob`, `LS`, exploration-classified `Bash`); at every multiple of 4 calls emits the exploration directive pointing to `/jev:jev-locate`, and once per request the re-read hint (second re-read, i.e. third read, of the same path and range with the same content hash); both on one event are joined into one message. On every `Read` that overlaps a fresh locator hit and is not contained in one range of the hits widened by 40 lines and merged, and every `Grep` whose scope (path, an ancestor directory, or none = the repository root; `glob`/`type` filters applied) covers a hit's file, the range-only hint (R2); a hit whose file sha256 changed is dropped silently. After the first edit or test in a request, one hint pointing to real checks and `/jev:jev-done`. Hints only with `JEV_FLOW=on`. For `jev_gate`, records correlation metadata only (§7). For tests, records snapshots and the exit code when the response states one. |
| `PostToolUse` on `Agent` / `Task` for `jev-locator` (added: R2) | Records the hits (`path`, `lines`, `sha256`) of the locator's report in `locator_hits` for the current request. |
| `SubagentStop` for `jev-locator` (added: R2) | The same from `last_assistant_message`, so background locators count too. |
| `PostToolUseFailure` on Jev tools and `Bash` (added: failed attempts) | Closes a pending `jev_gate` attempt or test run as failed, so it supersedes earlier successes. Never blocks, never approves. |
| `Stop` | Without `JEV_FLOW=on`: nothing (no notice, no redirect, even with `JEV_FLOW_STRICT=1`; nothing is approved either). Otherwise re-reads the selected gate, or every part of the selected batch, from the transcript (`transcript_path`), in memory, and validates it; a gate-runner attempt is checked through its signed receipt instead (§4c). Default: a non-blocking `systemMessage` to the user (once per snapshot) when code changed without an accepted gate; no `decision:block`, no `additionalContext`. With `JEV_FLOW_STRICT=1`: blocks once per snapshot with a redirect to `/jev:jev-done`, unless `stop_hook_active` is true, the snapshot is unknown, or the final message contains `Jev unavailable; gate not evaluated` / `Jev disabled for this repo; gate not evaluated`, or its last non-empty line starts with `Incomplete:` or ends with `?`. A bare mention of "incomplete" is not an exception. After the one redirect, it reports clearly and does not block again. Subagent stops are ignored. |

Outside a git work tree the hooks do nothing (no snapshot to bind evidence to, and nothing is approved). Internal errors print one stderr line and exit 0 without a decision. If the session state lock cannot be obtained (§7), the hook neither blocks nor approves (a `PreToolUse` refusal is still returned, whatever the persistence error); `Stop` tells the user that completion evidence is unknown and, for a lock left by a process that is gone, names the lock file to delete by hand.

Shell classification (`classifyShellCommand`): segments split on `&&`, `||`, `;`, `|`; `cd`/`pushd`/`popd` segments are neutral (a leading `cd` does not change the class); any mutation (in-place `sed`/`perl`, `mv`, `cp`, `rm`, `touch`, `tee`, file redirection, mutating `git`, package installs) makes the line `mutation`; recognized test/build/lint commands make it `test`; read-only commands (`rg`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `sed -n`, read-only `git`) make it `exploration` only if every segment is read-only; everything else is `unknown`.

### OpenCode (`private/jev-flow/opencode.mjs`, called from `opencode-plugin.js`)

| Capability | Use | On absence / failure |
| --- | --- | --- |
| `ctx.skill.transform` | Adds skill `jev-flow` unless one exists (existing entry preserved and reported). `${CLAUDE_PLUGIN_ROOT}` in the content is replaced with the checkout path. | Feature skipped; listed in the single diagnostic. |
| `ctx.agent.transform` + `editor.update` | Creates `jev-locator` (`mode: "subagent"`, `system` = agent body, `description`, `hidden: false`) unless one exists. With `JEV_FLOW_LOCATOR_MODEL=provider/model[#variant]`, sets `model` to the V2 `Model.Ref` `{providerID, id, variant?}`; otherwise the agent inherits the parent model and the limitation is noted once (setup report and the single diagnostic line). Permissions are **not** set. | Same. |
| `ctx.command.transform` + `editor.add` | Adds `/jev-locate` and `/jev-done` unless `ctx.command.list()` reports them. Commands are registered only when `ctx.command.list` works and returns a list (otherwise collisions cannot be ruled out) and `ctx.session.prompt` exists. `execute` sends the command text into the invoking session with `ctx.session.prompt({sessionID, text, delivery})`, keeping `delivery`. | Commands not registered; listed in the single diagnostic. |
| `ctx.tool.hook("execute.before")` | For `jev_*` tools: throws `JevFlowPolicyError` when the denylist has `*` or the payload holds an unredacted credential. The throw is deliberate and not caught by the adapter. A refused `jev_gate` is first recorded in memory as a failed, `denied` attempt of the current request, so it supersedes an earlier accepted gate without relying on `execute.after`. For an allowed `jev_gate`, remembers the pre-call snapshot and input hash in memory. | Same. |
| `ctx.tool.hook("execute.after")` | For `jev_gate`: closes the attempt opened in `execute.before` (which recorded, in memory, the pre-call snapshot, input hash, claims, request number and start time); `status` other than `completed` is a failed attempt; otherwise keeps the post-call snapshot and whether the result passes `validateGateResult` for the call's claims. Keeps the call's request, claims and diff in memory for the batch check. Counts exploration (`read`, `grep`, `glob`, `list`, exploration `bash`) outside `jev-locator`; queues the exploration directive at every multiple of 4, the re-read hint once per request, and the finish hint after the first successful edit. | Same. |
| `ctx.session.hook("prompt")` | Starts a new request: increments the request number, resets per-request counters and re-read tracking, and queues the route directive (only with `JEV_FLOW=on`, and not when the repo disables Jev). For the gate runner: creates `receipt.key` and `baseline.json` once per session and writes the request number to the session's metadata `state.json`. | Counters never reset; no directive; runner results cannot count. |
| Gate runner (bash) | `execute.before` on a bash command that runs `jev-gate-run.mjs` (not `--list-hunks`) opens an in-memory runner attempt; `execute.after` takes the runner's attempt record (receipt id) from the session metadata. `/jev-done` inserts `--session-key <key>` into the runner commands. The gate status verifies the receipt as in Claude Code. `task`/`agent` results for `jev-locator` feed the R2 hits; `read`/`grep` get the same range hints. | Runner results do not count; no range hints. |
| `ctx.session.hook("context")` | Appends the queued directive and hints to `system[]` once, as one text; never rewrites `messages`. Skipped for `jev-locator`. | No directive or hints. |

Degradation: every capability is feature-detected; a missing or failing one disables only its feature. At most one diagnostic line is logged per setup; problems found later at runtime are added to the returned report and logged only if nothing was logged before. `opencode-plugin.js` loads the module after registering the `jev` MCP server and skill, inside its own `try/catch`, so a failure there never affects them.

Direct `jev_gate` verdicts in OpenCode live only in the plugin process's memory, so a restart starts with an unknown gate. The gate runner's metadata (key, baseline, request number, attempt records and receipts) is written to the jev-flow cache (§7) in OpenCode too. The accepted-gate rule is the same as for Claude Code, through the same `selectGateAttempts` / `verifyBatchContents` / `coversEarlierBatches`: the latest attempt by start time (unfinished and failed attempts included), the request current when it started, a stable known snapshot equal to the current one, and `validateGateResult` for the call's claims; for a batch, all of this for every part plus the complete manifest. Without `JEV_FLOW=on`, `/jev-done` omits the strict note.

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

`~/.cache/jev-flow/<repo-hash>/<session-hash>/state.json` (override the root with `JEV_FLOW_CACHE_DIR`). Hashes are truncated sha256 of the repository's real path and of the session id. The same directory holds the gate runner's `receipt.key` (0600, never printed), `baseline.json` (HEAD and changed paths with content hashes) and `receipts/<id>.json` (§4c), all metadata only. OpenCode keeps direct gate verdicts in memory and writes only this runner metadata.

- **Metadata only.** Paths, sha256 hashes, ranges, counters, request numbers, timestamps and exit codes. A gate record holds only `{id, req, input, before, after, ts, boot, failed, denied}` (plus `runner`, the receipt id of a gate-runner attempt) (tool-use id, request number and boot at call start, input hash, snapshots, start time, whether the call failed, and whether the flow's own `PreToolUse` guard refused it), plus `{batch, part, of}` from the manifest label of a partitioned gate (hex id and integers). The top-level `parent_model` holds only a model alias; `locator_hits` holds `{path, start, end, sha, req}` of the locator's reports (at most 32). A test record holds `{cmd, req, boot, before, after, exit, failed, ts}` (command hash, not the command). A pending attempt holds `{kind, before, input|cmd, req, boot, ts}` (plus `{batch, part, of}` for a labelled gate). Up to 64 gate records and pending attempts are kept, 20 of every other list. Jev verdicts, actions, validity or contradiction counts are never written; `Stop` re-reads the verdict from the CLI's native transcript in memory and otherwise treats it as unknown. Every write is validated: strings are limited to 300 characters on a single line, and unknown top-level keys or record fields are rejected. No code, diffs, prompts, logs or semantic results are written. State files from an older format are ignored.
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

`node --test private/jev-flow/test/` runs the offline suite. `test/fixtures/enospc-preload.mjs` is a test-only `--import` preload that makes the state's temporary-file write fail with `ENOSPC`, to check that a refusal survives persistence failures. Node 22 resolves a directory argument as a module, so `private/jev-flow/test/index.js` imports every `*.test.mjs` file. The tests use temporary git repositories, a temporary `HOME` and `JEV_FLOW_CACHE_DIR`, synthetic secrets, synthetic transcripts, and a simulated OpenCode `ctx`; they make no network connection. Gate fixtures used as accepted are complete results shaped like `src/index.ts` returns them; incomplete ones are used only as negative cases. `mcp-client.test.mjs` runs the stdio client against `test/fixtures/fake-mcp-server.mjs` (a local fake MCP server: handshake, calls, fragmented output, errors, EOF, timeouts, argv configuration, credentials). `gate-run.test.mjs` runs the gate runner on temporary repositories against the fake server (scope and baseline, real check capture, refused declared logs, snapshot binding, sanitizing, partitioning, receipts, summary size, exit codes). `receipt.test.mjs` covers signing and verification; `locator-hits.test.mjs` the R2 rules. The test environment strips real Jev credentials (`sandboxEnv`), so nothing can reach a provider. `gate-batch.test.mjs` covers payload preparation (per-claim evidence, limits, continuations, sanitizing, slices), manifest verification, attempt selection and the payload CLI. `contracts.test.mjs` checks the documented payloads against the top-level keys parsed from `src/index.ts`, limits parsed from `src/lib.ts`, and nested shapes, types and bounds mirrored by hand from `src/index.ts`; it is a structural check, not a full zod validation.

## 11. Known limitations

- OpenCode V2 behavior is not verified at runtime: skill/agent/command registration, `editor.update` creating a missing agent, `ctx.command.list` and `ctx.session.prompt` shapes, the `prompt`/`context` session hooks, the `execute.before`/`execute.after` input fields (`id`, `status`, `result`), and whether a throw in `execute.before` actually blocks the tool call. Tests use a simulated `ctx`. Type hints come from a local `@opencode/plugin` 2.0.18, not 2.0.12.
- OpenCode agent permissions are not set because V2 permission action names could not be verified; the locator's read-only rule is an instruction there.
- OpenCode strict mode only instructs the agent at `/jev-done`; nothing blocks a completion message.
- Whether the directive, the repeated hints and the cheaper locator actually change a model's behavior in real headless runs (F1, F2) is not verifiable offline; the tests prove that the directive and the model parameter are delivered, not that the model obeys. It needs new A/B runs.
- The locator model override in Claude Code relies on `PreToolUse` `updatedInput` for the `Agent`/`Task` tool; the handling was read from the Claude Code 2.1.283 binary (an `updatedInput` without a permission decision is applied as an input update) but not exercised in a live session. The OpenCode `Agent.Info.model` shape (`Model.Ref`) comes from `@opencode/schema` 2.0.18 declarations; that 2.0.12 honours it at runtime is not verified.
- The gate limits are mirrored from the local `src/lib.ts`; the plugin runs `@jkudish/jev-mcp@latest`, whose limits may differ.
- The gate runner finds its Claude Code session through `CLAUDE_CODE_SESSION_ID`, which Claude Code 2.1.283 exports to Bash (read from the binary and seen in a live Bash environment); the hook keys its state by the hook input's `session_id`. That both carry the same id is assumed, not exercised in a live plugin session. Receipt authenticity protects against a model inventing or replaying results, not against a same-user process that reads `receipt.key`.
- Range hints (R2) are `PostToolUse`: they arrive after the redundant read, not before. Locator hits come from `SubagentStop.last_assistant_message` and the `Agent`/`Task` tool response; both shapes were read from the 2.1.283 binary, not exercised live.
- A partitioned gate proves that each part was judged on its slice and claims; no single call judged the whole patch. Structural pairing of claims with evidence does not prove support; Jev judges it.
- Claude Code: `PostToolUseFailure` is documented for failed tool calls; whether cancelled calls, or calls denied by another hook or by the user, also fire it is not verified, so an attempt without an end stays pending and blocks acceptance until a newer gate completes (calls refused by this flow's own guard are recorded as failed before the refusal). The `later_gate_call_in_transcript` check assumes a refused or cancelled `tool_use` is written to the main transcript; that was not verified live, so it is a second line of defense behind the state record, not a replacement. Re-reading the gate verdict relies on the transcript record shapes observed locally (`tool_use` / `tool_result` blocks); if the transcript is missing or not yet written, the gate is unknown. Bash exit codes are not in the tool response, so test results are normally unknown. Loading of the skill, commands, agent and hooks is checked with `claude plugin validate .`; interactive behavior on 2.1.283 needs a live smoke test.
- The state lock is never recovered automatically; a lock left behind by a crashed hook process disables state updates for that session (the hooks treat the state as unknown and never approve) until it is deleted by hand (§7).
- Redaction is best effort. The hooks are guards for Jev calls, not a firewall for every tool or external call.
- The metrics are exactly as good as the transcripts: missing timestamps, usage or outputs appear as `unknown`.

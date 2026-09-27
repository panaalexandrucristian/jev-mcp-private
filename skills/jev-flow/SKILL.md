---
name: jev-flow
description: "Adaptive coding workflow and default route for every non-trivial code task in a repository (debugging, implementation, refactoring, finishing a change): delegate broad code discovery to the jev-locator subagent instead of searching in the main thread, use bounded Jev judgments only when they change the next action, run real checks after code changes, and verify completion with /jev:jev-done (the gate runner runs the checks and jev_gate with per-claim evidence itself). Load it at the start of such a task, before exploring."
---

# Jev flow

An adaptive route through a repository task. It keeps broad exploration out of the main context, spends Jev calls only where a judgment changes the next action, and ends code changes with real checks and one `jev_gate` on the final snapshot. It uses the eleven existing Jev MCP tools; the tool conventions in the `jev` skill still apply.

Step contracts, JSON examples, fallback rules and every implementation decision are in [`reference/workflow.md`](reference/workflow.md).

## Route

**triage → locate → hypotheses → decide → implement → real checks → optional review → gate → final report**

Nothing obliges you to call every tool. Known files and a clear change: skip semantic location and the decision. After **any** code change, real checks and the final gate are required, except when Jev is unavailable or disabled for the repo.

| Step | Do it when | Skip it when |
| --- | --- | --- |
| 0. Triage | A new request arrives. `jev_classify` only for a genuinely ambiguous route or a real batch. | The kind of task and the files are clear. The user's request always outranks a classification. |
| 1. Locate | Files are unknown, or several results are semantically ambiguous: delegate to the `jev-locator` subagent (`/jev:jev-locate`). It runs on a cheaper model; its helper applies the ranking rule itself: more than 3 candidates or 2+ files → the helper runs `jev_rerank` with `top_k: 5` (`jev_find` for one definitive location) and returns the ranked ranges; an exact path or whole-token symbol in one file → plain read, used only if reading confirms it answers the question (otherwise the helper's `--fallback` ranking); 1–3 candidates in one file → plain reads. **After a hit, read only the returned ranges** (Read `offset`/`limit`, up to 40 lines around them); do not read the whole file or re-grep that area. | An exact path or symbol is already known; use it directly. |
| 2. Hypotheses | Checkable claims about a cause exist: `jev_verify` with real code and repro text. `jev_noul` only to prioritize, never as proof. | Reproduction and cause are already clear. |
| 3. Decide | 2–6 plausible mechanisms and explicit priorities that change the choice: `jev_decide` once. | Mechanical edits or a single obvious solution. |
| 4. Implement | Edit with the native tools after reading the returned ranges and checking their `sha256`. | — No Jev call is required while editing. |
| 5. Real checks | Always after code changes, on the final snapshot: the repo's own test/build/typecheck/lint commands, run by the gate runner (`--check '["npm","test"]'`, argv without a shell) in step 7; a failing check prevents acceptance. | Never skipped after code changes. |
| 6. Review | Risky patch, or feedback wanted before the final checks: `jev_review`. | The gate follows immediately on the same patch and evidence. |
| 7. Gate | Always after code changes: `/jev:jev-done`. You write claims with evidence ids (hunks, excerpts, `cmd-N`); the gate runner `scripts/jev-gate-run.mjs` collects the diff, runs the checks, builds the bounded payload, calls `jev_gate` itself (one part unless the patch exceeds a call's limits) and returns a compact verdict with a signed receipt. Never copy gate payloads. | No code changed. |
| 8. Report | After the gate or an explicit fallback. No further Jev call. | — |

## Budgets

- One locator per question; no duplicate parallel exploration in the main thread.
- Candidates: at most 48 fragments per call, each at most 1,000 characters including the source identification.
- Locator report to the parent: at most 5 locations and 4,000 characters, each with path, sha256, line range and a short reason.
- At most two semantically different candidate batches per question; the second only with a new scope or new evidence.
- `jev_decide`: one call per set of alternatives, evidence and priorities.
- Gate: one runner run per final snapshot; run again only after the patch, evidence or claims change (the runner does the single operational retry itself). A partitioned batch counts only when every part is accepted on the same snapshot.

## Activation

The plugin injects a short route directive at session start and on every prompt, repeats the delegation directive at every 4 exploration calls in a request, and hints every time a read or grep re-covers a range the locator already returned. Follow them. `JEV_FLOW=off` turns the directives, hints and Stop notices off (the data guard stays); `JEV_FLOW_STRICT=1` makes Stop redirect once per snapshot to `/jev:jev-done`. `JEV_FLOW_LOCATOR_MODEL` (`haiku`|`sonnet`|`opus`|`inherit`; `provider/model` in OpenCode) overrides the locator's model; do not pass a model yourself.

## Prepare data before every Jev call

1. If `.jev-flow-denylist` at the repo root contains a line `*`, send nothing to Jev. Run the local checks and report **"Jev disabled for this repo; gate not evaluated"**. Do not switch providers or ask for a policy exception to get a gate.
2. Never send `.env` files, private keys or credential files. They are permanently excluded, together with the denylist patterns.
3. Sanitize diffs and logs first:
   `git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-candidates.mjs" --sanitize --root .`
   Use the returned `text`. If `omitted` or `omitted_lines` shows that evidence was removed, say so instead of inventing it.
4. Send only fields the tool schema accepts. Do not invent keys such as `file_path`.

A PreToolUse hook denies Jev calls that violate rules 1–2 or carry a recognizable unredacted credential. The hook is a guard, not a firewall.

## Result policy (in this order)

1. **Valid contradicted claim** (any Jev tool): stop and ask the user, quoting the verdict and the numbers. An invalid answer elsewhere does not cancel the contradiction.
2. **Transport error or `invalid_response`**: retry once with the identical input. If it fails again, continue with the real checks and report **"Jev unavailable; gate not evaluated"**. Never record it as `auto`. A user cancellation is not a reason to retry.
3. **`review` or low confidence on a routine step**: inspect manually and continue with a stated reason. Do not re-call with the same input hoping for a nicer verdict.
4. **Gate `escalate` or low confidence, or an inconclusive consequential `jev_decide`** (confidence missing or below 0.8, an escape hatch, or warnings): stop and ask the user. A gate `review` caused only by missing evidence may be resolved with new evidence and a new call; if it stays unresolved, do not declare completion.
5. **Valid `auto`**: applies only to the evaluated snapshot and claims. It does not replace the user's explicit criteria or the real tests.

`jev_gate` alone does not escalate every contradiction regardless of confidence; this flow deliberately applies the stricter rule 1.

## Completion

- A result counts only for the snapshot it was produced on. Any later edit invalidates earlier checks and gates.
- Changes present before you started are not your work; do not claim them.
- If completion cannot be verified, end the report with a line starting with `Incomplete:` and say what is missing.
- When the gate ran as a batch of parts, completion needs every part accepted on the same snapshot; the report says that verification was partitioned and that no single call evaluated the whole patch. A missing or unaccepted part means `Incomplete:`.
- Completion evidence is the runner's signed receipt for this session, request and snapshot (or a direct `jev_gate` re-read from the transcript); a verdict printed or pasted any other way does not count.
- With `JEV_FLOW_STRICT=1`, the Stop hook redirects once per snapshot to `/jev:jev-done` when code changed without an accepted gate. It never blocks a question to the user, a line starting with `Incomplete:`, or the two fixed phrases above.

## Anti-patterns

1. Jev for mechanical choices: an exact symbol, an exit code or a sufficient parser needs no semantic judgment.
2. Loading the whole repo into the main context before rerank.
3. `jev_rerank` without `top_k` when only a few results are wanted.
4. Repeating `jev_decide` until the preferred answer appears.
5. `jev_noul` as a substitute for reproduction, tests or proof.
6. `jev_review` and `jev_gate` back to back on the same input: the gate already contains the review.
7. Reading `auto` the same way everywhere: for `jev_gate` it does not approve merge or deploy.
8. Ticking the gate because a call happened: the valid result, the snapshot and the evidence matter.
9. Test or code claims supported only by the request text, the `diff` or the `tests` field, or all claims sharing one generic "patch" excerpt: in `jev_gate`, each claim's support belongs in `evidence` (its hunks, excerpts and command output).
10. Hiding the subagent's cost: main-context reduction and total savings are different metrics.
11. Caching by path or mtime, or reusing results after an edit: content hashes and evidence scope are required.
12. Hooks that run models or tests on every read, or that prevent reporting a blocker.
13. Copying diffs, logs or gate payloads through the model: tool arguments are model output tokens. The gate runner and the candidate helper build and send payloads themselves.
14. Reading the whole file or re-grepping an area after the locator returned its ranges.

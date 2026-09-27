---
name: jev-flow
description: "Adaptive coding workflow for repository tasks: delegate broad code discovery to jev-locator, use bounded Jev judgments only when they change the next action, run real checks after code changes, and verify completion with jev_gate. Use for debugging, implementation, refactoring, and finalizing code changes."
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
| 1. Locate | Files are unknown, or several results are semantically ambiguous: delegate to the `jev-locator` subagent (`/jev:jev-locate`). | An exact path or symbol is already known; use it directly. |
| 2. Hypotheses | Checkable claims about a cause exist: `jev_verify` with real code and repro text. `jev_noul` only to prioritize, never as proof. | Reproduction and cause are already clear. |
| 3. Decide | 2–6 plausible mechanisms and explicit priorities that change the choice: `jev_decide` once. | Mechanical edits or a single obvious solution. |
| 4. Implement | Edit with the native tools after reading the returned ranges and checking their `sha256`. | — No Jev call is required while editing. |
| 5. Real checks | Always after code changes, on the final snapshot: the repo's own test/build/typecheck/lint commands. | Never skipped after code changes. |
| 6. Review | Risky patch, or feedback wanted before the final checks: `jev_review`. | The gate follows immediately on the same patch and evidence. |
| 7. Gate | Always after code changes: `/jev:jev-done` runs checks, collects evidence and calls `jev_gate` once. | No code changed. |
| 8. Report | After the gate or an explicit fallback. No further Jev call. | — |

## Budgets

- One locator per question; no duplicate parallel exploration in the main thread.
- Candidates: at most 48 fragments per call, each at most 1,000 characters including the source identification.
- Locator report to the parent: at most 5 locations and 4,000 characters, each with path, sha256, line range and a short reason.
- At most two semantically different candidate batches per question; the second only with a new scope or new evidence.
- `jev_decide`: one call per set of alternatives, evidence and priorities.
- `jev_gate`: one call per final snapshot; call again only after the patch, evidence or claims change (or for the single operational retry below).

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
9. Test claims supported only by the request text or the `tests` field: in `jev_gate`, support belongs in `evidence`.
10. Hiding the subagent's cost: main-context reduction and total savings are different metrics.
11. Caching by path or mtime, or reusing results after an edit: content hashes and evidence scope are required.
12. Hooks that run models or tests on every read, or that prevent reporting a blocker.

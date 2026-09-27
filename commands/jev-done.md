---
description: Finish a code change with jev-flow - run the real checks on the final snapshot, gate the final diff with jev_gate (every claim paired with its real evidence, split into parts when needed), and write the final report.
argument-hint: [acceptance criteria or notes]
---

Finish the current code change with the jev-flow completion procedure. Extra criteria from the user: $ARGUMENTS

1. **Freeze the snapshot.** Make no further edits during this procedure. If you must edit, start again from step 2 afterwards: earlier checks and gates no longer count. Do not write helper files inside the repository: that changes the snapshot. Use a temporary directory outside it.
2. **Run the real checks** that exist in this repository (test, build, typecheck, lint) on the final snapshot. Keep, for each command, the exact command line, its real output and its exit code as the tool reported it. If the tool did not report an exit code, it is unknown: never invent one. Failing checks stay failures; do not reinterpret them.
3. **Check the opt-out.** If `.jev-flow-denylist` contains a line `*`, skip steps 4–6 and report **"Jev disabled for this repo; gate not evaluated"** with the real check results.
4. **List the hunks** of the final diff, including staged, unstaged and new files that belong to this task (for each new untracked file, append `git diff --no-index /dev/null <file>`), and not changes present before you started:
   `git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-payload.mjs" --list-hunks --root .`
   It sanitizes the diff and returns `hunks` (`id`, `path`, `header`) plus `omitted` / `omitted_lines`.
5. **Pair every claim with its evidence and build the gate calls.** Write one claim per acceptance criterion or check, concrete enough to be judged from its evidence alone (for example "`parseFlags` rejects an empty value and returns `E_EMPTY`", not "the bug is fixed"). For each claim, name the evidence that supports it:
   - `hunk-N` (or `file:<path>` for all hunks of a file): the diff fragment that implements the claimed behavior;
   - an excerpt id: real surrounding code that the claim depends on (`{"id", "path", "lines": [a, b], "text"}`, copied from the file, not paraphrased);
   - `cmd-N`: the real output of the Nth command in `commands` (for every claim about tests, builds or checks).
   Then pipe this JSON (from a temporary file outside the repository or a heredoc) to the helper:
   ```json
   {
     "request": "the user's request, verbatim",
     "diff": "the full output of the diff command from step 4",
     "claims": [{"text": "a concrete claim", "evidence": ["hunk-2", "cmd-1"]}],
     "commands": [{"command": "npm test", "exit": 0, "output": "the real output"}],
     "excerpts": [{"id": "caller", "path": "src/cli.ts", "lines": [40, 62], "text": "the real code"}]
   }
   ```
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-payload.mjs" --root . < /tmp/jev-gate-input.json`
   The helper sanitizes everything, puts each claim's evidence into `evidence` (support must be in `evidence`; the `tests` field alone does not support a claim), keeps every call within the jev_gate limits (16 claims, 16 evidence items, 200,000 evidence characters, 50,000 per document, 2,000 per claim), and splits a large patch into parts by file and hunk, continuing oversized hunks or logs in identified pieces rather than cutting them. `ok: false` (exit 4, no calls) lists `problems`: a claim without evidence, an unknown id, a diff slice that no claim covers, a claim whose evidence cannot fit one call, or content that sanitizing had to **remove** from the diff or from evidence (an excluded or denylisted file, a line that still looks like a secret). Fix them with real material, or report the gap and end with `Incomplete:`: removed content cannot be evaluated, so the work cannot be gated as complete. Credential redaction (a `[REDACTED:…]` marker in place of a value) is allowed. Never fill a gap with placeholders or invented logs. `limits` lists the redactions and the hunks no claim cites: report them.
6. **Call `jev_gate` once per part**, sending each `calls[i].input` unchanged, in order. With one part this is a single call. With several parts, each part's `request` starts with the batch manifest line `[jev-flow batch v2 id=… part=k/n …]`; the batch counts only when **every** part is accepted on the same snapshot. The id binds every part's complete input, so do not edit a call: changed evidence, tests or request means rebuilding with the helper (a new batch, all of whose parts must then be sent). A part that is missing, failed, refused or not accepted leaves the whole batch unverified; so does mixing parts of two preparations. A later gate that replaces an unfinished batch must cover all of its claims and its whole diff.
7. **Interpret the results in this order** (for a batch, apply it to every part; the first part that stops the procedure decides):
   - a valid `contradicted` claim → stop and ask the user, quoting the verdict and the numbers;
   - transport error or `invalid_response` → retry that call once with identical input; if it fails again, report **"Jev unavailable; gate not evaluated"** (never `auto`);
   - `escalate`, or low confidence → stop and ask the user;
   - `review` caused only by missing evidence (`claims_unsupported`) → add the missing real evidence to those claims, rebuild with the helper (step 5; this makes a new batch) and call again once; otherwise ask the user;
   - `auto` with a complete result (not truncated, reason codes exactly `accepted`, every claim `verified` with action `auto`) → that part counts for this snapshot and these claims only; a partial or inconsistent `auto` counts as an invalid response; a well-formed `auto` whose confidences or `safe_to_apply` are below 0.8, or whose composite is below 0.7 (possible only with lowered thresholds), is not accepted and is not retried: ask the user, quoting the numbers.
   Completion may be reported only when every part of the batch is accepted.
8. **Final report:** the change, the checks actually run with exit codes (or "exit code unknown"), the gate result per part (action, reason codes, verdicts) or the fixed phrase, the limits of the evidence (omitted content, uncited hunks, cut output), and the remaining issues. When the gate ran in several parts, say so explicitly: each part judged its slice of the diff and its claims, and no single call evaluated the whole patch. If completion is not verified, end with a line starting with `Incomplete:`.

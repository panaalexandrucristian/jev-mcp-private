---
description: Finish a code change with jev-flow - run the real checks on the final snapshot, gate the final diff with jev_gate once, and write the final report.
argument-hint: [acceptance criteria or notes]
---

Finish the current code change with the jev-flow completion procedure. Extra criteria from the user: $ARGUMENTS

1. **Freeze the snapshot.** Make no further edits during this procedure. If you must edit, start again from step 2 afterwards: earlier checks and gates no longer count.
2. **Run the real checks** that exist in this repository (test, build, typecheck, lint) on the final snapshot. Record each command, its exit code and the relevant output. Failing checks stay failures; do not reinterpret them.
3. **Check the opt-out.** If `.jev-flow-denylist` contains a line `*`, skip steps 4–5 and report **"Jev disabled for this repo; gate not evaluated"** with the real check results.
4. **Collect and sanitize evidence.** Get the final diff, including staged, unstaged and new files that belong to this task, and not changes that were present before you started:
   `git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-candidates.mjs" --sanitize --root .`
   For each new untracked file, add `git diff --no-index /dev/null <file>` to the same input (this does not touch the index).
   Sanitize check output the same way (`--mode text`). Use the returned `text`. If `omitted` or `omitted_lines` is non-zero, state which evidence is missing. If the diff exceeds the tool limits, review it in parts and state that no single call evaluated the whole patch; a gate on a summary is not a gate on the patch.
5. **Call `jev_gate` once** on the final diff:
   ```json
   {
     "request": "<the user's request>",
     "diff": "<sanitized final diff>",
     "tests": "<sanitized real check output>",
     "claims": ["<each acceptance criterion that is met>", "<each check command that passed>"],
     "evidence": [
       {"id": "test-log", "text": "<sanitized real output, identified by command>"},
       {"id": "patch", "text": "<diff fragment supporting a criterion>"}
     ]
   }
   ```
   Placeholders in `<...>` must be replaced with real content; never send them or invent logs. Claims about tests must be supported in `evidence`, not only in `tests`.
6. **Interpret the result in this order:**
   - a valid `contradicted` claim → stop and ask the user, quoting the verdict and the numbers;
   - transport error or `invalid_response` → retry once with identical input; if it fails again, report **"Jev unavailable; gate not evaluated"** (never `auto`);
   - `escalate`, or low confidence → stop and ask the user;
   - `review` caused only by missing evidence → add the real evidence and call again once; otherwise ask the user;
   - `auto` with a complete result (not truncated, reason codes exactly `accepted`, every claim `verified` with action `auto`) → completion may be reported for this snapshot and these claims only; a partial or inconsistent `auto` counts as an invalid response; a well-formed `auto` whose confidences or `safe_to_apply` are below 0.8, or whose composite is below 0.7 (possible only with lowered thresholds), is not accepted and is not retried: ask the user, quoting the numbers.
7. **Final report:** the change, the checks actually run with exit codes, the gate result (action, reason codes, verdicts) or the fixed phrase, the limits of the evidence, and the remaining issues. If completion is not verified, end with a line starting with `Incomplete:`.

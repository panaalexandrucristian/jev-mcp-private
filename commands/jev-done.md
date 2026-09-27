---
description: Finish a code change with jev-flow - the gate runner runs the real checks, pairs every claim with its real evidence and calls jev_gate itself on the final diff; you write claims and read a compact verdict, never payloads.
argument-hint: [acceptance criteria or notes]
---

Finish the current code change with the jev-flow completion procedure. Extra criteria from the user: $ARGUMENTS

The gate runner `scripts/jev-gate-run.mjs` does the heavy work: it collects the final diff (against the session baseline, new non-ignored files included), runs the checks you name, reads the excerpts you cite, sanitizes everything, keeps every call within the `jev_gate` limits (splitting into parts only when needed, each part bound to the snapshot), calls `jev_gate` itself through the jev MCP server and prints one compact JSON verdict. **Never build or copy a `jev_gate` payload yourself, and never call `jev_gate` directly for this procedure.**

1. **Freeze the snapshot.** Make no further edits during this procedure. If you must edit, start again from step 2: earlier results no longer count. Do not write helper files inside the repository (that changes the snapshot); put the claims file in a temporary directory outside it.
2. **Check the opt-out.** If `.jev-flow-denylist` contains a line `*`, do not run the runner's gate: run the repository's real checks yourself and report **"Jev disabled for this repo; gate not evaluated"** with their results.
3. **List the hunks** (identifiers only, no bodies):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-run.mjs" --root . --list-hunks`
   It returns `hunks` (`id`, `path`, `header`), the diff base (`session_baseline` or `head_fallback`), `unattributed` (changes already present when the session started, left out of the gate), `preexisting_mixed` (files that were already changed and then changed again; included, but the earlier changes cannot be separated), `unevaluated` (binary files, submodules) and `omitted` (content the sanitizer would remove).
4. **Write the claims file** (for example `/tmp/jev-claims-<something>.json`): one claim per acceptance criterion or check, concrete enough to be judged from its evidence alone (for example "`parseFlags` rejects an empty value and returns `E_EMPTY`", not "the bug is fixed"), each with the ids of its support:
   ```json
   {
     "request": "the user's request, verbatim",
     "claims": [
       {"text": "parseFlags rejects an empty value and returns E_EMPTY", "evidence": ["hunk-2", "caller"]},
       {"text": "npm test passes", "evidence": ["cmd-1"]}
     ],
     "excerpts": [{"id": "caller", "path": "src/cli.ts", "lines": [40, 62]}]
   }
   ```
   - `hunk-N` (or `file:<path>` for all hunks of a file): the diff fragment that implements the claim;
   - an excerpt id: real surrounding code the claim depends on, as `{id, path, lines: [first, last]}`; the runner reads the lines itself (do not pass `text`);
   - `cmd-N`: the output of the Nth `--check` below (every claim about tests, builds or checks cites one).
   Every hunk must be covered by some claim. Do not pass `diff`, `commands`, `tests` or `evidence`: the runner refuses them.
5. **Run the runner once**, naming the repository's real checks (test, build, typecheck, lint) that exist here; the runner runs them itself on the frozen snapshot and captures their real output and exit code. Each `--check` is a JSON array of strings, run as argv **without a shell** (no pipes, `&&` or redirections; to use a shell, say so explicitly, for example `'["sh","-c","npm run build && npm test"]'`):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-gate-run.mjs" --root . --claims /tmp/jev-claims-<something>.json --check '["npm","test"]' [--check '["npm","run","build"]']`
   For a long suite, run it in the background and wait for it (`--check-timeout <seconds>`, default 900). Do not run the same checks separately first. Starting the runner for a gate already replaces any earlier gate result, even if this run then fails.
6. **Read the verdict** (`status` and exit code) and act in this order:
   - `contradicted` (exit 2) → stop and ask the user, quoting the part, the claim numbers (`c`) and the numbers;
   - `unavailable` (exit 3) → the runner already retried once; report **"Jev unavailable; gate not evaluated"** (never `auto`), with the real check results;
   - `escalate` or `ask_user` (exit 2) → stop and ask the user, quoting the numbers;
   - `needs_evidence` (exit 2: `review` caused only by missing evidence) → add the missing real evidence ids (hunks, excerpts, checks) to those claims and run the runner once more; if it stays unresolved, ask the user;
   - `checks_failed` (exit 2) → a check exited non-zero, timed out, could not start or has an unknown exit code: the gate cannot be accepted whatever Jev said. Report the failing check; fix the code and start again from step 1, or end with `Incomplete:`;
   - `not_ready` / `invalid_input` (exit 4) → fix what `problems` lists with real material (a claim without evidence, an unknown id, an uncovered hunk, content the sanitizer had to remove, the work tree changing during the run, an empty diff), or report the gap and end with `Incomplete:`; never fill a gap with placeholders;
   - `accepted` (exit 0) → every part is `auto` and valid and every check passed, for this snapshot and these claims only. A later run on the same request and snapshot must keep every claim of the earlier runs (it may add evidence or claims, never drop one).
   A failed check stays a failure; it is not reinterpreted.
7. **Final report:** the change, the checks the runner ran with their exit codes (`exit: null` = unknown or timed out), the gate result per part (action, reason codes, claim verdicts) or the fixed phrase, the limits from `limits` (unattributed or pre-existing changes, unevaluated binaries/submodules, cut output, uncited hunks, redactions) and the remaining issues. When `limits.partitioned` is true, say so explicitly: each part judged its slice of the diff and its claims, and no single call evaluated the whole patch. If completion is not verified, end with a line starting with `Incomplete:`.

Completion counts only through the runner's signed receipt for this session, request and snapshot (`receipt` in the output); a result printed or pasted any other way is not evidence.

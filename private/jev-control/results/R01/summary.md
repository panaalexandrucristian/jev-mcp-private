# R01 — first live round: one baseline session (S1)

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin 0.7.0, Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`. The Jev MCP server is started by `npx -y --package=@jkudish/jev-mcp@latest`; **its version is unknown** (neither the stream nor the transcript records it).

**Sessions: 1 of the 2 planned.** Ledger `1/20` (`1	2026-10-03T00:05:30Z	sonnet	<fixture copy of s1-bug-several-files>`), 19 left. S2 was **not launched**: the isolation check of S1 found configuration that D28 did not anticipate (below), and the plan says to stop and report in that case. A session that is not launched costs no slot.

All figures below come from the session's stream (`session.log`, "stream:N" = line) and its transcript JSONL (45 lines, kept outside git; "transcript:N" = line), cross-checked; nothing is reused from T2. Raw transcript, stream and per-session `measure` output stay in `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R01/`. No secret appears here; the user's email address is in the transcript's `session_context` and is not copied.

## Offline work before the session

| Check | Result |
| --- | --- |
| `node --test private/jev-control/test/` (before launch) | 421 tests, 77 suites, 421 pass |
| `node --test private/jev-control/test/` (final, with the authorization fix) | 425 tests, 78 suites, 425 pass |
| `node --test private/jev-flow/test/` (before launch and final) | 324 tests, 61 suites, 324 pass, exit 0 |
| `claude plugin validate .` | passed |
| `seal.mjs verify` | ok |

`run-session.mjs` now passes the D27/D28 flags (`--setting-sources project`, `--plugin-dir /Users/apana/Dev/jev-mcp`, `--permission-mode acceptEdits`, the exact allowlist, prompt as the argument of `-p`), `launchProblems` refuses a missing flag or any permission bypass, and `sessionEnv` gives the worker and the wrapper `JEV_PROVIDER=openrouter` without `JEV_FLOW` or any `JEV_CONTROL*` key (tests: exact argv, the argv and environment the simulated wrapper received, the LIVE check in the launcher). `fixtures/lib.mjs` stages only the scenario's files (`git add -- <paths>`).

## S1 — `s1-bug-several-files`

- scenarioHash `d134fbb9d686b0cf0e2207d6b06f3fc1e68a801208ab5062ddef4c81ccae42ac`; the oracle **failed** on the pristine copy (`{"a":3,…,"f":"Page 1 of 3",…}`) and **passed** after the session (`{"a":2,"b":3,"c":1,"d":0,"e":5,"f":"Page 1 of 2","g":"function"}`); `node --test` in the final copy: exit 0, 2 tests, 2 pass. The only change is `src/pagination.mjs` (1 insertion, 1 deletion).
- Status: exit 0, no timeout, `group_gone` true, `result_seen` true, lock released, wrapper wall time 13 199 ms; the stream reports `duration_ms` 11 259, `duration_api_ms` 10 004, `terminal_reason` `completed`, `stop_reason` `end_turn`, `num_turns` 7 (the transcript has 6 unique assistant message ids; the difference is not explained here).
- Final message (stream:19): «Fixed and verified: `pageCount` in `src/pagination.mjs` used `Math.floor(items / pageSize) + 1`, which overcounts by one when the item count divides evenly. It now uses `Math.ceil(items / pageSize)`. […] `node --test` passes with 2 of 2 tests.»
- Tools (transcript tool_use): Bash 4, Read 1, Edit 1 (6 in all); repeated reads 0; edits applied 1.
- **Refusal (D27, measured, not worked around):** stream:12 `permission_denied` for Bash (`decision_reason_type` `subcommandResults`), transcript:33 error result: «This Bash command contains multiple operations. The following part requires approval: sed -i '' 's|Math.floor(items / pageSize) + 1|Math.ceil(items / pageSize)|' src/pagination.mjs && node --test 2>&1». It is also in `permission_denials` of the result. The model then used `Edit` (transcript:35) and a plain `node --test` (transcript:36–38).
- Tokens, per unique message id (6 messages, all parent; `measure.mjs` from the transcript, identical to the stream's `result.usage`, kept as reported and not added again): input 12, output 796, cache_read 113 948, cache_creation 11 597. Subagent usage: 0 messages (`subagent_stats.spawned` 0), so its tokens are `unknown` in the tool's output, not zero. Unattributed: 0 messages. Cost reported by the stream, not measured here: 0.0772 USD.
- Jev: 0 direct MCP tool uses in the transcript (main 0, subagent 0); provider-internal calls `unknown`.
- Control, threshold and gate compliance: **not applicable** (baseline, mode never activated). `measure.mjs` has no baseline mode and prints `coverage 0/6 (no_grant)` and `finalization 1 violation` for this session; they describe the absence of the control, not a failure.

n = 1: no saving, ranking or trend is claimed; this is the reference point for R02.

## D28 isolation check (from init, stream:3, and the transcript)

Confirmed: `permissionMode` `acceptEdits`; plugins `jev@inline 0.7.0` from `/Users/apana/Dev/jev-mcp` plus three `@builtin` plugins; MCP `plugin:jev:jev` `connected` with the 12 `mcp__plugin_jev_jev__*` tools; no user plugin (no `opencode-council`, `ast-grep` or installed `jev` 0.6.0 in plugins, skills or agents); the hooks that ran were the branch plugin's (`SessionStart:startup`, and a `Stop` hook `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-flow-hook.mjs" Stop`, transcript:43, 1 hook).

**Differs from what D28 describes / cannot be confirmed:**
1. Four **claude.ai connector MCP servers** (`claude.ai Claude Docs`, `Gmail`, `Google Drive`, `Google Calendar`, `source: claudeai`, all `connected`) are loaded despite `--setting-sources project`, with 58 of the 95 tools of the session (25 built-in, 12 `plugin_jev_jev`); the Claude Docs server's instructions are in the context (transcript:8) and the account's email address is in `session_context`. These come from the account, not from settings files, so `--setting-sources project` does not remove them. Evidence exists for S1 only; whether and how they change the context of other sessions is not shown. The baseline is not "only the branch plugin".
2. The absence of **personal hooks** is only partly shown: the stream reports one `SessionStart` hook and the transcript one `Stop` hook summary (both the plugin's); no record exists for `PreToolUse`/`PostToolUse`, so their absence is not demonstrated either way.
3. `JEV_PROVIDER=openrouter` is set by the launcher, but its value inside the session is not observable.

Per the plan, S2 waits for the council's decision (accept the connectors as part of the baseline, or change the isolation, which is outside the agreed plan).

**Why S2 was not run:** because of these connectors, and no live session is launched until the user answers whether they stay in the baseline. Claude Code 2.1.288 contains a switch for them: the strings `ENABLE_CLAUDEAI_MCP_SERVERS` (environment variable) and `disableClaudeAiConnectors` (setting) are present in the installed binary, together with a message that automatic loading of claude.ai connectors is disabled by either. Only the presence of the strings was checked; its semantics (accepted values, effect on `--setting-sources project`) were **not** tested, and nothing was changed in the live configuration.

## Defect found and fixed offline

The real transcript showed no defect of the runner or of the measurement that would invalidate R02–R10. Two caveats are left unfixed and documented (`evaluation.md`): the baseline counters above, and `measure.mjs` counting an attempted but permission-denied Bash command as a possible change (`bash_changes` 1, `possible_changes` 5), which is conservative.

The authorization collision is fixed: `Approve edit_a.` authorized `edit-a` and the reverse (and «edit a» both), because `idTokens` read `_` and `-` as spaces. `idPositions` in `authorization.mjs` now needs the id **exactly** (its own separators, not a piece of a longer identifier, case-insensitive), in explicit approvals, labels and short answers bound to the question; «Yes, use edit a» no longer authorizes `edit_a` (the old test is changed; the user is asked again). Regressions: `authorization.test.mjs` (both directions, spaced form, longer ids, question and label), `cli.test.mjs` (two Write options with different content; cross approvals refused and recorded nothing; exact approvals recorded with different action hashes), `measure-integration.test.mjs` (the audit binds and covers only the approved Write; a claimed approval of the other id is unbound, creates no grant and leaves both Writes uncovered). Against the old `authorization.mjs` the three new tests fail.

## Found at ratification and fixed offline (second commit)

Two members found, by import, that the first fix of the id collision was incomplete, and one that the runner guard read only the first occurrence of a flag. No live session was involved.
- **Ids.** `options.mjs` accepted `edit_a-`, `edit_a_`, `edit__a` as ids, and `idPositions` voided a match only when a separator was followed by a letter or digit, so `Approve edit_a-.`, `Approve edit_a_.` and `Approve edit_a--.` authorized `edit_a`. Now an option id is words of `a-z` and `0-9` joined by single `_` or `-` (`SLUG` = `^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$`; no trailing or doubled separator), and a match is void when a `_` or `-` stands right before or right after the id, whatever follows it (an id written with its own terminal separator, which no valid batch contains, still matches only itself). Regressions: `options.test.mjs` (rejects `edit_a-`, `edit_a_`, `edit__a`, `edit_a--`, accepts `edit_a`, `edit-a`, `o1`, `edit_a_b`), `authorization.test.mjs` (trailing, doubled, leading separators; the prefix of a longer id; questions and labels; `findAuthorizations`), `cli.test.mjs` and `measure-integration.test.mjs` (valid batch `edit_a` / `edit_a_b` with different Write payloads: refused approvals record nothing, the audit binds and covers nothing).
- **Runner flags.** `configProblems` looked at the first occurrence of each flag, so a later `--permission-mode default`, `--setting-sources user` or `--plugin-dir /other/plugin` before the allowlist went unnoticed. Now `-p`, `--model`, `--max-turns`, `--output-format`, `--verbose`, `--setting-sources`, `--plugin-dir`, `--permission-mode` and `--allowedTools` must each appear exactly once (the prompt, the argument of `-p`, is not read as a flag), and the aliases `--allowed-tools`, `--disallowedTools`, `--disallowed-tools` and the `--flag=value` spelling are refused. Regressions in `run-session.test.mjs`.
- The new tests fail on the first commit's `authorization.mjs`, `options.mjs` and `run-session.mjs` (5 tests) and pass on the fixed ones.
- Checks after the fix: control suite 429 tests / 78 suites, all pass; flow suite and the others as listed in the report of this round.

## Limits and unknowns

n = 1 and a single scenario; JEV server version, in-session `JEV_PROVIDER` and hook activity beyond the records above are unknown; S2 not run, so ordered-task behaviour is unmeasured; provider-internal Jev calls are `unknown`; `--plugin-dir` and `--setting-sources` work as flags, but the claude.ai connectors remain (see above).

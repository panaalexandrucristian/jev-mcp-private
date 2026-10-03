# R02 — two clean baselines and two dev sessions

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin 0.7.0, Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`, Jev MCP server `jev-mcp@0.13.0` (as reported by `cli.mjs on` in both dev sessions). Launched from `4bb7660` plus the D30 runner change that this round commits.

**Sessions: 4 (the maximum D32 allows).** Ledger `1/20` before, `5/20` after, 15 left; the reserve is untouched. Lines (from `ledger.tsv`, time only): `2` 00:42:42Z baseline S1 · `3` 00:43:07Z baseline S2 · `4` 00:43:39Z dev S1 · `5` 00:44:15Z dev S2. They ran strictly one after the other through `run-session.mjs` and the budget wrapper; each ended with `state done`, exit 0, no timeout, `group_gone` true, lock released before the next launch.

All figures come from each session's stream (`session.log`, "stream:N") and its transcript JSONL ("transcript:N", kept outside git, matched by `session_id` and cwd), and from `measure.mjs`; the stream's `result.usage` equals the per-message totals of `measure.mjs` for all four sessions. Raw files stay in `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R02/`. No secret, capability or e-mail address appears here.

## Before the sessions (offline)

`run-session.mjs`: `sessionEnv` now also fixes `ENABLE_CLAUDEAI_MCP_SERVERS=false` (D30) and `JEV_CONTROL_HEADLESS=1` (D14: nobody answers in `-p`; without an active control the variable has no effect, so baseline and dev keep the same environment); `configProblems` accepts only the allowed flags, so `--settings`, `--mcp-config`, `--add-dir` and the like are refused. Tests in `run-session.test.mjs` and `hook.test.mjs` (the D31 text with the S1/S2 prompts activates, the baseline prompts do not). Control suite 431/78 and flow suite 324/61 passed, `claude plugin validate .` and `seal.mjs verify` ok, before the first launch.

## Isolation (D30), all four inits (stream:3)

The only MCP server is `plugin:jev:jev` (connected, source plugin); no claude.ai connector; 37 tools in the session (95 in the R01 pilot); `permissionMode` `acceptEdits`; plugin `jev@inline 0.7.0` plus three `@builtin` plugins; the hooks seen are the plugin's: `SessionStart:startup` in the stream of all four, and in the dev sessions the `UserPromptSubmit` additional context (transcript:10). The connector switch worked. Not demonstrated: the absence of personal `PreToolUse`/`PostToolUse` hooks.

## The four sessions

| | baseline S1 | dev S1 | baseline S2 | dev S2 |
| --- | --- | --- | --- | --- |
| prompt | scenario | «Let Jev control this session.» + scenario | scenario | same phrase + scenario |
| oracle (pristine fails) | pass | pass | pass | pass |
| `node --test` in the copy | 2/2 | 2/2 | 1/1 | 2/2 |
| stream turns / unique assistant messages | 6 / 5 | 11 / 7 | 8 / 5 | 11 / 7 |
| parent tokens in / out / cache read / cache creation | 10 / 768 / 81 292 / 8 561 | 14 / 1 506 / 123 812 / 10 498 | 10 / 1 613 / 83 427 / 9 475 | 14 / 1 890 / 123 608 / 10 482 |
| tools | Bash 3, Read 1, Edit 1 | Skill 1, Bash 5, Read 2, Edit 1 | Bash 3, Edit 4 | Skill 1, Bash 4, Edit 4 |
| permission denials | 0 | 1 (stream:33, compound Bash) | 1 (stream:9, compound Bash) | 1 (stream:19, «brace with quote character») |
| cost reported by the stream (USD) | 0.0582 | 0.0818 | 0.0707 | 0.0856 |
| wrapper wall time (ms) | 10 124 | 18 586 | 16 290 | 21 070 |

Every session passed its oracle on the final copy; the model then used `Edit` after the denied compound command in three sessions (refusals are measured failures, not worked around). Subagents: 0 (their tokens are `unknown`, not zero). Direct Jev MCP calls: 0 in all four; provider-internal calls are `unknown`.

## Activation and use of the control (dev)

Activation worked in both dev sessions: the hook injected the capability (transcript:10), the model loaded the `jev:jev-control` skill (transcript:19 / :20), and `cli.mjs on` returned `status ok`, `threshold 0.95` (default), `session environment`, `audit available`, server `jev-mcp@0.13.0` (transcript:31 / :29). This confirms live: `CLAUDE_CODE_SESSION_ID` reaches the Bash tool; the natural-language prompt reaches `UserPromptSubmit` and the capability line reaches the model; `SessionEnd` fires in `-p` (both state files read mode off, capability removed after the session). The slash command in `-p` stays unmeasured (D31).

**But the control was not used.** After `on`, neither dev session ran `decide`, `search`, a receipt, a gate or any other helper call or Jev tool: coverage 0/7 (`no_grant`) in each, no decision, no plan. In dev S2 the model chose the order of the four tasks itself (the prompt says «Choose the order yourself»); in dev S1 it ran its own `git ls-files; grep -rn` before `on` and then edited without a decision. `measure.mjs` therefore reports a finalization violation (`done` never called) and an empty coverage for both. Correctness was not affected (oracles pass); the mode was on and decided nothing.

## Comparison with the clean baselines (n = 1, no saving claimed)

Dev against the baseline of the same scenario, parent tokens (dev − baseline): S1 input +4, output +738, cache read +42 520, cache creation +1 937 (11 turns against 6); S2 input +4, output +277, cache read +40 181, cache creation +1 007 (11 against 8). The dev sessions used more tokens in every field: the skill text, `on` and the extra turns cost more than they saved, and with no decision taken there was nothing to save. The R01 pilot (connectors) is excluded. Durations and costs are as in the table.

## Defect found and change

Most important defect: the mode activated but nothing was decided (above). Causes visible in the transcripts: a single `-p` prompt gives no later reminder after `on`; the skill did not say whether a phrase like «Choose the order yourself» outranks Jev (it hands the choice over); in S1 `on` came after the model had already explored on its own.
Changed (offline): `cli.mjs on` prints a `next` line right where the model reads it (act through the helper: `decide --file`, «choose the order yourself» is Jev's choice, `search`, `/jev:jev-done`); `SKILL.md` says a phrase that hands a choice over is Jev's decision, `on` comes first and files are found with `cli.mjs search`, not `grep`. Tests: `cli.test.mjs` (the `next` line, line stays compact), `manifest.test.mjs` (skill phrases); both fail on the previous code.
**The effect of the change is not measured**: no live session was left in this round; R03 is the first that can show whether the model now decides.

## Limits and unknowns

n = 1 per scenario and arm; the fix is untested live; the slash command, subagent capability propagation and Sonnet's protocol adherence beyond two sessions are unmeasured; the in-session values of `JEV_PROVIDER`, `ENABLE_CLAUDEAI_MCP_SERVERS` and `JEV_CONTROL_HEADLESS` are not observable (the init shows the effect of the connector switch only); the stream's `num_turns` exceeds the unique assistant messages (unexplained, as in R01); `measure.mjs` has no baseline mode and counts a denied Bash command as a possible change (both documented in `evaluation.md`).

## Erratum (R03)

"The model loaded the `jev:jev-control` skill (transcript:19 / :20)" above is imprecise: the `Skill` call returned the text of `commands/jev-control.md` (transcript:21 / :22), not `skills/jev-control/SKILL.md`, which was not read in either dev session. See `../R03/summary.md`.

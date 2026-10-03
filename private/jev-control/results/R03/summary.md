# R03 — two dev sessions on S3 (ambiguous search)

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin 0.7.0, Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`. Both sessions ran on `45916c6` with no change between them; plugin snapshot hashes equal R02's (`plugin.json` `302328d4…1dd3`, `hooks.json` `5cc80abaf…c15`). Scenario S3 hash `4c255416…1317`; dev prompt sha256 `f8d310c3…2f2c` (D31 phrase + S3 prompt, identical in both).

**Sessions: 2 (the plan's maximum).** Ledger `5/20` before, `7/20` after, 13 left; the reserve is untouched. Lines (from `ledger.tsv`, time only): `6` 01:08:08Z dev S3 (a) · `7` 01:08:34Z dev S3 (b). Strictly sequential through `run-session.mjs` and the budget wrapper; both ended `state done`, exit 0, no timeout, `group_gone` true, no lock before the second launch.

Figures come from each session's stream (`session.log`, "stream:N") and transcript JSONL ("transcript:N", kept outside git, matched by `session_id` and cwd) and from `measure.mjs` (run without `--baseline`: there is no clean S3 baseline). The stream's `result.usage` equals the per-message totals of `measure.mjs` in both. Raw files stay in `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R03/`. No capability or e-mail address appears here.

## Isolation (D30), both inits (stream:3)

Only MCP server `plugin:jev:jev` (connected, source plugin), no claude.ai connector, 37 tools, `permissionMode` `acceptEdits`, plugin `jev@inline 0.7.0` plus three builtins. Personal `PreToolUse`/`PostToolUse` hooks: absence not demonstrated.

## The two sessions

| | dev S3 (a), ledger 6 | dev S3 (b), ledger 7 |
| --- | --- | --- |
| `Skill` call | `jev:jev-control`, args `on` (transcript:20) | `jev:jev-control`, no args (transcript:20) |
| helper calls | `on` (transcript:28 → :29, status ok, `next` line present) | `status` (transcript:29 → :30), mode **off**; `on` never ran |
| after that | own `grep` ×2 (transcript:33 failed in the shell, :36), `Read src/upload/retry.mjs` (:39) | none: the model explained the four commands and asked whether to run `on` |
| decide / search / done / direct Jev calls | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| coverage (`measure.mjs`) | 0/3 uncovered, all `no_grant` | 0/0, `unknown` |
| frozen oracle | **pass** | **fail** (task not answered) |
| answer | `uploadRetryDelay` in `src/upload/retry.mjs`, lines 6–9 (exact); git clean | none |
| stream turns / unique assistant messages | 7 / 6 | 4 / 3 |
| parent tokens in / out / cache read / cache creation | 12 / 1 044 / 102 473 / 9 304 | 6 / 736 / 45 713 / 8 110 |
| tools | Skill 1, Bash 3, Read 1 | Skill 1, Bash 1 |
| permission denials | 0 | 0 |
| cost (stream, USD) · wrapper wall time (ms) | 0.0682 · 15 883 | 0.0490 · 12 141 |

Three separate verdicts for S3: (i) the frozen oracle accepts any range that overlaps 6–9 and a clean tree — (a) pass, (b) fail; (ii) whether the answer names the right file, function and range — (a) yes, exactly (`final message` from the stream `result`, stream:40), (b) no answer; (iii) edit attempts in the transcript — none in either, `git status` empty in both. S3 has no clean baseline, so a comparison with a session without the skill is unmeasured; (b) is smaller only because it did not do the task. Subagents: 0 (their tokens are `unknown`, not zero). Against R02 (other scenarios) the dev S1/S2 parent tokens were 14 / 1 506 / 123 812 / 10 498 and 14 / 1 890 / 123 608 / 10 482: side by side only.

## Defect found

**The skill's `SKILL.md` never reached the model.** `commands/jev-control.md` and `skills/jev-control/` have the same name; the session's skill listing has a single `jev:jev-control` entry, carrying the command's description, and `Skill jev:jev-control` returns the command text ("Run the jev-control command for this request: …", transcript:22) with the model's `args` as `$ARGUMENTS`. In all four dev sessions of R02 and R03 `SKILL.md` was never read: the model saw the command text, the hook line and the `next` line, but not "what Jev decides", the decision loop or the search rule. (R02's summary said the model "loaded the skill": it loaded the command; see the erratum there.)

Consequences seen: in (b) the natural-language request reached the command without an argument, step 3 ran `status`, the mode stayed off and, with nobody to answer in `-p`, the task was not done — the first failed correctness result of the campaign. In (a) `on` ran (the model passed `args: "on"`), and the model then searched with its own `grep` although the `next` line told it to use `search`. Whether the `next` line works when the protocol is read is therefore still unmeasured.

## Change (offline, effect not measured)

- `private/jev-control/hook.mjs`: the activation line for a natural-language request now says to run `cli.mjs on --session-cap <cap> --priorities "<one line>"` first and to `Read` `<plugin root>/skills/jev-control/SKILL.md` (the plugin root is derived from the hook's own location); the activation for a `/jev:jev-control …` prompt is unchanged so that `off` and `status` are not told to run `on`; the ON reminder now says `protocol: skills/jev-control/SKILL.md` instead of "see the jev-control skill".
- `commands/jev-control.md`: step 1 reads `SKILL.md` with `Read`; step 3 runs `on`, not `status`, for no or unknown arguments when the hook line says the user requested the mode.
- Tests: `hook.test.mjs` (the activation text, the existing path, command prompts do not demand `on`, the reminder) and `manifest.test.mjs` (the command text); both fail on the `HEAD` versions of `hook.mjs` and `commands/jev-control.md` and pass on the new ones.

No live session is left in R03: R04 is the first that can show the effect. The change touches `commands/` as well as the paths the plan named (`private/jev-control/`, `skills/jev-control/`), because the defect is in the command; this is a deviation reported to the council.

## Limits and unknowns

n = 1 per session; S3 without a clean baseline; the fix is untested live; the `claude -p` slash command is not measured (D31); provider-internal Jev calls are `unknown`; the stream's `num_turns` exceeds the unique assistant messages (7 against 6, 4 against 3; unexplained, as before); whether another Claude Code version or install path resolves the same-named skill differently is unknown.

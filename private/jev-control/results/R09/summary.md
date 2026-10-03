# R09 — three fixes before the sealed finals (offline round)

**No live session was started in R09** (ledger 15/20 before and after, no lock; 5 left: R10 2 sealed + 3 reserve, the reserve only for failed or lost sessions, and R09 authorizes no use of it). Every live metric below is `unmeasured`, not zero. Nothing here claims that the changes work in a real session.

Start commit `cb0f52e`, base `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin version 0.7.0 (unchanged), Node v22.23.1, Claude Code 2.1.288 (`claude plugin validate .`).

## Why (D42)

The user wants no forcing mechanism (no blocking hook, no refusal; D11 stays): the skill must reach the model whole and be followed willingly when the user asks for it. R02-R08 showed three obstacles: the `Skill` tool returned the command text and not `SKILL.md` because the skill and the command shared the name `jev-control` (R03); the activation text and the `on` result only pointed at `SKILL.md` and `help` (R02, R04); and the headless sessions refused a `Read` of `SKILL.md` outside the working directory, so they under-measured adherence (R04).

## What changed

1. **Name conflict (D43).** `skills/jev-control/` is now `skills/jev-control-mode/` with `name: jev-control-mode`, loaded with `Skill jev:jev-control-mode`. The command stays exactly `/jev:jev-control on|off|status|threshold` (`commands/jev-control.md` keeps its name; its step 1 loads the skill, falls back to a `Read` of the exact file, and if that is refused too says so in one line and goes on with the rules `on` printed and `help`). References updated: hook, helper, `help.mjs`, `commands/jev-locate.md`, the skill's own files, `skills/jev-flow/SKILL.md:12` and the «Jev control» section of `PRIVATE.md` (D44). The R01-R08 reports and the R03/R04 notes in `integration.md` are history and were not rewritten. New tests: no skill name equals a command name; every `skills/<x>/` path cited by the commands, agents, helper sources and the jev-flow skill exists; none cites the old directory.
2. **Compact protocol at activation (D46).** `private/jev-control/rules.mjs` exports one constant, `PROTOCOL_RULES` (792 bytes). It is the hook's activation text for both the slash command and a natural-language request (with the loading line and the capability), the text after a compaction at `SessionStart` (instead of the reminder), and the `next` field of `cli.mjs on`. The per-prompt reminder stays one line. Nothing blocks or refuses. Text (English):

   > Rules while ON (T = threshold; only a score strictly above T counts): (1) Every choice with 2+ real alternatives, incl. task order, goes through cli.mjs decide --file <batch>; run only plan items above T, in order. Exempt: explicit user instructions, exact user-named paths, permission prompts, a one-variant step, this fixed protocol itself. (2) Select files with cli.mjs search; rg/glob only list candidates. (3) No eligible option: expand at most twice with new options/evidence (same id), then ask the user, or headless end with Incomplete: and the scores. An option at or below T needs the user's explicit approval (cli.mjs approve). (4) Before declaring done use /jev:jev-done or cli.mjs done --claims jev-claims.json; only an accepted gate permits it. Formats: help decide|search|done.

   The council's wording was shortened to fit (`run only plan items`, `a one-variant step`, `(same id)`, `Before declaring done`) without removing a rule or an exception. The older `next` sentence about a user phrase such as «choose the order yourself» is no longer in the `on` output; it stays in the skill.
3. **Headless Read (D45).** `run-session.mjs` has `SKILL_DIR` and `SKILL_READ_RULE = Read(//Users/apana/Dev/jev-mcp/skills/jev-control-mode/**)` as the last element of `ALLOWED_TOOLS`, derived from `PLUGIN_DIR`, identical for every remaining session; no `--add-dir`. `configProblems` and `launchProblems` still require the exact list; they now also name any other `Read`/`Edit`/`Write` rule and `--add-dir`.
4. **Measurer (D47, and the report D42 asks for in R10).** A `Read` with a confirmed result (no error) of exactly `SKILL_DIR/SKILL.md`, `reference/<name>.md` or `examples/<name>.md` (an absolute path; the pattern allows no `..`, `.` or empty segment) is protocol, not a task action: outside the coverage denominator, counted in `coverage.exceptions.skill_protocol_read` (the key exists only when it is non-zero, so old outputs keep their shape). A refused or result-less `Read`, any other path or extension and every `Write`/`Edit` keep their old classification. The new `skill` section reports Skill calls to `jev-control-mode` by level (`no_result`, `error`, `result_without_identity`, `identity_observed`), the reads below the skill directory (granted or refused, partial or whole, exempt or not), `uncovered_skill_reads` next to coverage, and a `load` summary: `full_read_observed`, `identity_observed` (the frontmatter name only, not proof that the whole skill reached the model), `unknown`, `refused`, `not_attempted`. `Skill` stays mechanical for coverage.

## Sizes (bytes, measured by the tests)

| Text | Bytes | Limit |
| --- | --- | --- |
| `PROTOCOL_RULES` | 792 | - |
| activation, natural language (120-byte plugin root, 49-character capability) | 1489 | 1500 |
| activation, slash command (same) | 1209 | 1500 |
| `SessionStart` after a compaction (same, threshold 0.99999) | 1181 | 1500 |
| per-prompt reminder (49-character capability, threshold 0.99999) | 353 | 400 |
| `on` output, typical / the largest tested | 1094 / 1497 | 1500 |

The `on` output at its limit has the longest accepted priorities (300 characters of ASCII, accented, CJK or emoji text) and a notice; the descriptive echoes yield first, in this order: `flow`, `audit`, a shorter `notice` and `note`, then the priorities echo (cut by bytes), then the notice; the rules, the threshold and the stored priorities are never cut. The merged jev-flow text that the hook adapter appends when `JEV_FLOW=on` is not part of the control hook's text and is not bounded here (the adapter is outside this round's surface).

## Offline verification

| Check | Result |
| --- | --- |
| `node --test private/jev-control/test/` | 549 tests, 89 suites, 549 pass (511 in 85 before R09) |
| `node --test private/jev-flow/test/` | 324 pass |
| `claude plugin validate .` | passed |
| `seal.mjs verify` | ok (the scenario hashes do not cover skill paths) |
| `git diff --check`, protected-path diff against `879c2ba`, secret grep | clean, empty, none |
| Mutations of the new guards (rules text, hook sizes and parts, shrink steps, Read rule, measurer exemption) | 38 first pass: 34 killed. Survivors: the priorities-loop guard and the prefix check without the trailing slash (weak tests, strengthened and then killed), the server-echo step and the `..` segment guard (redundant with the line limit and with the exact-name pattern, removed). 2 extra mutants of the path pattern killed |
| 15 historical transcripts, previous vs new measurer | identical in every field except the new `skill` section (none loaded the skill: `not_attempted`) |

## What is not proven offline

That the Read rule is granted by Claude Code in `claude -p` with `--setting-sources project`; that `Skill jev:jev-control-mode` delivers `SKILL.md` there; what effect the compact rules have on adherence, coverage or tokens; and the live completion gate (still never exercised live). R10 observes them: two sealed sessions on the product ratified after R09, with the D45 rule, no adjustment after unsealing, n=1 per cell and no causal claim; the report states skill loaded, decide/search/done used, uncovered skill reads next to coverage, and tokens against the baselines.

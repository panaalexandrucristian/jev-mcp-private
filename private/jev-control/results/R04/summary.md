# R04 — dev S2 (task order) and the S3 regression of the R03 failure

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin 0.7.0, Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`. Both sessions ran on `e555441` with no change between them. Plugin snapshot hashes at launch: `plugin.json` `302328d4…1dd3`, `hooks.json` `5cc80abaf…c15` (equal to R02/R03), `hook.mjs` `f7b32a0c…963d`, `commands/jev-control.md` `39e4cbdc…4a62`. Scenario hashes S2 `05098291…f2b0` and S3 `4c255416…1317` equal the earlier rounds'; dev prompt sha256 S2 `2495e29f…5959` (equal to R02's dev S2) and S3 `f8d310c3…2f2c` (equal to R03's). Pristine copies fail the oracle (S2, S3) and the S3 reference answer passes.

**Sessions: 2 (the plan's maximum).** Ledger `7/20` before, `9/20` after, 11 left; the reserve is untouched. Lines (time only): `8` 01:29:37Z dev S2 · `9` 01:31:45Z dev S3 (regression). Strictly sequential through `run-session.mjs` and the budget wrapper; both `state done`, exit 0, no timeout, `group_gone` true, no lock before the second launch. Why S3 as the regression: it is the only scenario that failed on correctness (R03 b) and the `e555441` fix targets exactly that failure; S2 keeps the token comparison (clean baseline ledger 3, pre-fix dev ledger 5).

Figures come from the streams ("stream:N"), the transcripts ("transcript:N", outside git) and `measure.mjs` (S2 with `--baseline` = ledger 3). The stream `result.usage` equals the per-message totals of `measure.mjs` in both. Raw files: `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R04/`. No capability or e-mail address appears here.

## Isolation (D30), both inits (stream:3)

Only MCP server `plugin:jev:jev` (connected, source plugin), no claude.ai connector, 37 tools, `permissionMode` `acceptEdits`, plugin `jev@inline 0.7.0` plus three builtins. Personal `PreToolUse`/`PostToolUse` hooks: absence not demonstrated.

## Did the R03 fix work? Activation: yes. The protocol file: no, it was unreadable.

In both sessions the hook line at transcript:10 carried the natural-language marker, «Do first, before any search or edit: … cli.mjs on …», then «Read …/skills/jev-control/SKILL.md». The model ran `on` as its first action in both (transcript:19, result :21: status ok, mode on, threshold 0.95 default, `next` line present), called the Skill tool **0 times**, and then `Read` `SKILL.md` (transcript:20): **refused in both** («Claude requested permissions to read from …/SKILL.md, but you haven't granted it yet», transcript:22; stream:8 `permission_denied`, reason `workingDir`). In this configuration a Read outside the working directory is not granted (D27 has no Read allowance and `--add-dir` is not an allowed flag), so the protocol reached the model only through the hook line, the `on` result and the helper's own error messages.

## The two sessions

| | dev S2, ledger 8 | dev S3 regression, ledger 9 |
| --- | --- | --- |
| first action | `on` (transcript:19) | `on` (transcript:19) |
| `Read` SKILL.md | refused (:20 → :22) | refused (:20 → :22) |
| after that | `decide` attempts (see below), one `cat` of the fixture files (:63), no grep/glob | `search --help` (:28 → :29, invalid), `search --query … 2>&1 \| head -40` (:31 → :32: found, `rerank`, 1 hit `src/upload/retry.mjs` 1–9, score 0.98), `Read` of the whole file (:34 → :35) |
| decide / search / done / direct Jev calls | 10 executed (+2 refused by the permission layer) / 0 / 0 / 0 | 0 / 2 / 0 / 0 |
| frozen oracle | **fail** (no file changed) | **pass** |
| answer | none: asked the user to choose (transcript:119) | `uploadRetryDelay` in `src/upload/retry.mjs`, lines 6–9, exact (transcript:37) |
| `git status` / edit attempts on fixture files | clean / 0 (8 scratch-file Write/Edit calls) | clean / 0 |
| stream turns / unique assistant messages (measure) | 25 / 24 | 6 / 5 |
| parent tokens in / out / cache read / cache creation | 48 / 7 371 / 517 549 / 17 708 | 10 / 961 / 82 840 / 8 628 |
| tools | Bash 15, Read 1, Write 7, Edit 1 | Bash 3, Read 2 |
| permission denials | 4 (the Read, a `… \| head; ls` Bash, a heredoc Bash, a Write to `/tmp`; stream:8, :15, :21, :25) | 1 (the Read) |
| cost (stream, USD) · wrapper wall time (ms) | 0.2481 · 75 292 | 0.0607 · 15 041 |
| coverage (`measure.mjs`) | 0/14 uncovered, all `no_grant` | 0/4 uncovered, all `no_grant` |

**S2, step by step.** The `decide` attempts (transcript:29, 32, 35, 39, 52, 59, 74, 81, 89, 97, 108, 112): `--help` (invalid: unknown argument); a command with `| head -50; ls` and a heredoc batch (:32, :39), both refused by the permission layer and not run; no `--file` (exit 4); then five batches rejected by the helper one problem at a time (`decision`/`kind`/`options` missing; options must be objects with 5 options; `action` required for kind `order`; `action` must be an object; `Edit` needs `old_string`), i.e. **seven invalid results and two permission refusals before the first valid batch**, then three valid batches. Each valid batch returned `expand` with reason `none_above_threshold`, an empty plan and the top score `d:0.94`, `d:0.93`, `d:0.93` (the other options 0.04–0.19); the model never passed `--decision-id`, so these were three new decisions at round 0, not expansion rounds. It had modelled the order as "which of five single-step options goes FIRST" (rename, changelog, greeting, test, a baseline test run), not as one option per task for the plan to order. It never edited a fixture file or ran `node --test`, removed its scratch batch file (transcript:116) and ended asking the user to pick «d → b → c → a», to lower the threshold, or to choose the order. The R02 dev S2 (ledger 5, before the fix) passed the oracle without any decision; here the control did engage and the task was not done.

**S3, three verdicts.** (i) Frozen oracle (accepts any range overlapping 6–9 and a clean tree): pass. (ii) Answer exactness: file, function and range `6–9` exact; the message also says `SKILL.md` could not be read. (iii) Edit attempts: none, `git status` empty. The coverage is 0/4 because the model piped the helper into `head`; a helper piped into another command is audited as an ordinary action and grants nothing (evaluation.md), so the `Read` of the hit had no grant even though the hit was genuine.

**measure.mjs notes (S2).** One finalization violation (`completion_declared_without_accepted_done`): the measurer counts the 8 scratch-file `Write`/`Edit` calls as edits and any final text that does not start with `Incomplete:` as a declared completion. The final message did not declare completion (it asked the user), so this is a limit of the measurer on a stop that is a question, reported as measured, not as a finding about the task. Helper-reported attempts: 3 (only the valid batches reached Jev), direct calls 0, budget limit 25 not reached.

## Tokens (parent, n = 1, no saving claimed at unequal correctness)

| session | in | out | cache read | cache creation | turns | oracle |
| --- | --- | --- | --- | --- | --- | --- |
| S2 clean baseline, ledger 3 | 10 | 1 613 | 83 427 | 9 475 | 8 | pass |
| S2 dev before the fix, ledger 5 | 14 | 1 890 | 123 608 | 10 482 | 11 | pass |
| S2 dev R04, ledger 8 | 48 | 7 371 | 517 549 | 17 708 | 25 | **fail** |
| S3 dev R03 (a), ledger 6 | 12 | 1 044 | 102 473 | 9 304 | 7 | pass |
| S3 dev R03 (b), ledger 7 | 6 | 736 | 45 713 | 8 110 | 4 | fail |
| S3 dev R04, ledger 9 | 10 | 961 | 82 840 | 8 628 | 6 | pass |

`measure.mjs` against the S2 baseline: parent delta +38 input, +5 758 output, +434 122 cache read, +8 233 cache creation (subagents: none started, so their tokens are `unknown`, not zero). The S2 cost is the cost of seven rejected batches and three repeated decisions made without the format; the S3 session is in the range of R03 (a). S3 has no clean baseline: a comparison with a session without the skill is unmeasured.

## Defect found

**`SKILL.md` is unreadable in the campaign configuration and the helper had no usage text.** The only route to the protocol that the R03 fix created (a `Read`) is refused whenever the plugin directory lies outside the working directory without a grant, which is the headless case here (and an interactive user would have to approve it). Without it the model learned the `decide` batch format by trial and error (seven invalid results), formulated the task order as a first-step choice among single-step options (top score 0.93–0.94, never above 0.95) and never used `--decision-id`; the S3 model also tried `search --help` and piped `search` into `head`, which voids the grant.

## Change (offline, effect not measured)

- `private/jev-control/help.mjs` (new) and `cli.mjs`: `cli.mjs help [command]` and `<command> --help` / `-h` print compact usage and need no repository, session, capability or Jev call (the top-level `--help` keeps its first line). `help decide` (1 499 bytes, under the 1.5 KB cap): the batch shape, at least 5 options or `space_small`, `action` rules per kind, kind `order` as one option per task, what each status means, and that an `expand` round needs new material and the same `--decision-id`; `help search`: the form, the rank/hash rule, and that a pipe after the helper voids the grant; one line for each other command.
- `cli.mjs`: the `next` line after `on` points at `help decide` and `help search` and says SKILL.md may be unreadable.
- `hook.mjs`: the natural-language activation line adds «If that Read is refused, go on: `cli.mjs help decide` prints the batch format and `help search` the search form.»
- `commands/jev-control.md` step 1: a refused Read does not end the session; it names the two help topics.
- Tests: `cli.test.mjs` (help equals `--help`/`-h` outside any repository, fits the cap, names the fields, kinds and bounds of `options.mjs`; the example batch parsed from the help passes `normalizeBatch`; `search` and the other topics; `next` names both topics), `hook.test.mjs`, `manifest.test.mjs`. **Mutation:** with the new tests, the old `cli.mjs` fails 4, the old `hook.mjs` 1, the old command 1; the new code passes 75/75 on those three files.
- `SKILL.md` is unchanged: its decision loop already says everything the help says; the change is that the model no longer depends on reading it.

## What is not measured

- Whether a session that cannot read `SKILL.md` now writes a valid batch at once, uses kind `order` with one option per task, and completes S2: no session is left in R04; R05 is the first that can show it.
- Whether Jev scores a one-option-per-task `order` batch above 0.95: unmeasured (here the batches were first-step choices).
- Interactive behaviour (the user can grant the Read); the `claude -p` slash command (D31); provider-internal Jev calls; personal tool hooks; the stream `num_turns` (25 and 6) exceeding the unique assistant messages (24 and 5).

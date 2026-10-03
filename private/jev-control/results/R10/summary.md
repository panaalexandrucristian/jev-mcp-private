# R10 — the two sealed final sessions (F1, F2) on the frozen R09 product, and the campaign summary

Base commit of the campaign `879c2ba032c8b3779862e696e33653504e818265`; product under test `6b188153c8b0556d7af55be625c4795ce4d420e9` (R09 ratified, branch `jev-control-skill`, plugin 0.7.0), the working tree identical to it at both launches (`git status` showed only the user's two untracked paths); Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`, Jev MCP server `jev-mcp@0.13.0` (as printed by `cli.mjs on`). Plugin snapshot hashes at launch (`prep.json`, outside git): `plugin.json` `302328d4…1dd3`, `hooks.json` `5cc80aba…1c15`, `marketplace.json` `a4a69379…b83d`.

**Per D48 the product stayed frozen.** R10 changed no code, skill, example, test, scenario, oracle, runner or measurer; it only records results (this directory, `results/README.md`, `skills/jev-control-mode/reference/evaluation.md`, and the «Jev control» section of `PRIVATE.md`). The defect below is a recommendation for future work, not a change. The sealed scenarios were run once each, unadjusted (D14, D15, D48).

**Sessions: 2 (D49).** Ledger `15/20` before, `17/20` after, 3 left; the reserve is untouched (no session failed for infrastructure reasons: both ended `state done`, exit 0, no timeout, `result_seen`, `group_gone` true, lock released, no lock in the budget directory before the second launch). Lines (time only, as the wrapper wrote them): `16` 08:01:06Z F1 · `17` 08:01:31Z F2. Strictly sequential through `run-session.mjs` and the budget wrapper, no `--threshold` (default 0.95, strictly above), prompt = «Let Jev control this session.», a blank line, then the scenario prompt unchanged (sha256 `6c7dd5e3…77af` for F1 and `61c79063…4d50` for F2). Scenario hashes equal `sealed.json` (F1 `8c22eb66…c464`, F2 `86a9887b…7d56`); before the launch each oracle failed on the pristine copy and passed on the reference solution (checked on separate copies). Config: D27/D28/D29/D30 plus the D45 Read rule (`ALLOWED_TOOLS` unchanged).

Figures come from each session's stream (`session.log`, "stream:N"), the transcript JSONL ("transcript:N", the 1-based line; outside git) and `measure.mjs` at the frozen revision (`measure/` of each session), and from the fixture oracle on the final copy. The stream's `result.usage` equals the per-message totals of `measure.mjs` in both sessions. `measure.mjs` printed `reported_total: unknown` because the transcript carries no `result` record; the stream gives the reported figures. Raw files stay in `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R10/` (`f1/`, `f2/`, `prep.json`, `oracle.json`). No capability, secret or e-mail address appears here.

## Isolation (D28, D30), both inits (stream:3)

The only MCP server is `plugin:jev:jev` (connected), 37 tools, `permissionMode` `acceptEdits`, plugin `jev@inline 0.7.0` plus three `@builtin` plugins; no claude.ai connector. Not demonstrated, as in every round: the absence of personal `PreToolUse`/`PostToolUse` hooks.

## The two sessions

| | F1, ledger 16 (answer task) | F2, ledger 17 (edit task) |
| --- | --- | --- |
| task | where the expiry of a cached user session is computed (file and line range), change nothing | `rangeLength` off by one, fix it, public API unchanged, `node --test` passes |
| hook line (activation text with the rules) | transcript:10 | transcript:10 |
| `Skill jev:jev-control-mode` | called (transcript:19), result «Launching skill: jev:jev-control-mode» (:20), then a separate meta user message (:21) | same (:19, :20, :21) |
| `Read` of the skill files | none (the Read rule was never exercised) | none |
| `on` | :27 → :28, `threshold 0.95`, `threshold_source default`, rules in `next` | :27 → :29, same |
| `help` | not used | not used |
| `decide` calls | 0 | 0 |
| `search` | 1 (:30 → :31): `found`, `jev_used rerank`, one hit `src/session/ttl.mjs` 1–7, score 0.98 | 2: `none_eligible` (:33 → :34, `evaluations` 1), widened once (:37 → :38) `search_budget_exhausted` (`evaluations` 2), «no location scored strictly above the threshold» |
| other actions | `Read` of the hit file (:33 → :34) | the model's own `ls; git ls-files` (:28 → :30) before the search |
| `done`, `jev-done`, claims file | none (`done_calls` 0) | none (`done_calls` 0) |
| final message | answers «`sessionExpiry` in `src/session/ttl.mjs`, lines 5–7» and «I didn't change any files» (:36) | «Jev control is on at threshold 0.95, but I haven't edited anything yet because file selection failed.» then asks the user which of three options to take (:41) |
| starts with `Incomplete:` | n/a (answered) | **no** |
| frozen oracle | **pass** (`mentionsPath` true, `overlaps` true, tree clean) | **fail** (`a` 4, `b` 0, `c` 8: the pristine values; nothing was edited; tree clean) |
| permission denials (stream) | 0 | 0 |
| stream turns / unique assistant messages | 6 / 5 | 7 / 5 |
| parent tokens in / out / cache read / cache creation | 10 / 661 / 101 068 / 14 572 | 10 / 1 144 / 101 499 / 14 861 |
| subagents | 0 (tokens `unknown`, never 0) | 0 (same) |
| cost (stream, USD) · stream duration (ms) · wrapper wall time (ms) | 0.0851 · 14 877 · 16 606 | 0.0912 · 21 162 · 22 395 |
| helper attempts (budget 25 per request) · helper median latency | 1 · 1 877 ms | 2 · 995 ms |
| coverage (covered / denominator) | 1 / 1 (the `Read` bound to the search grant; `search_whole_file_reads` 1, `unverified_binding` 1) | 0 / 1 (the `ls; git ls-files` command, `no_grant`); a user-question grant created, none consumed |
| `skill` section | `load` `unknown`; 1 Skill call at level `result_without_identity`; 0 Reads; 0 uncovered skill Reads | same |
| finalization | no edit, no completion declared | `unknown` (`possible_changes_unvalidated`: the Bash listing counts as a possible change; no edit) |

The F1 oracle passed: the model's range `5–7` intersects the oracle's range 5–8 and the path is the right one. Nothing is claimed beyond «the oracle passed».

## Audit dimensions and evidence identifiers (frozen auditor, `6b18815`)

The complete `measure.mjs` output of each session is in `metrics.json` (`sessions.f1.audit`, `sessions.f2.audit`); the values and the auditor's limits are kept as printed, nothing was corrected or replaced. Summary:

| dimension | F1 | F2 |
| --- | --- | --- |
| session id (an identifier to find the transcript, not a capability) | `2b5603a6-1374-43da-8343-16b972a515a9` | `a862fe68-9f75-43fa-8d47-74d4ef38803d` |
| usage attribution · parent messages | known · 5 | known · 5 |
| parent tokens in / out / cache read / cache creation | 10 / 661 / 101 068 / 14 572 | 10 / 1 144 / 101 499 / 14 861 |
| subagent: messages and tokens | 0 messages; tokens `unknown` | 0 messages; tokens `unknown` |
| unattributed: messages and tokens | 0 messages; tokens `unknown` | 0 messages; tokens `unknown` |
| total (the auditor's own) | = parent; subagent and unattributed unknown, so a complete total is **unknown** | same |
| `reported_total` of the transcript | `unknown` (no `result` record in the transcript) | `unknown` |
| stream `result` (a separate source, `session.log`) | 10 / 661 / 101 068 / 14 572, 6 turns, 0.0851 USD | 10 / 1 144 / 101 499 / 14 861, 7 turns, 0.0912 USD |
| threshold section | threshold 0.95 (default); 0 decisions, 0 plan items, 0 violations, 0 actions while blocked | same |
| ordering | 0 plans (action order `measured`) | 0 plans |
| approvals · receipts | 0 calls · 0 verifications, 0 refusals | 0 · 0 |
| MCP / budget | direct Jev calls 0 (main 0, subagent 0); helper attempts 1 of 25; budget approvals 0 bound, 0 unbound; `state_used` `unknown`; Jev provider-internal calls `unknown` | direct 0; helper attempts 2 of 25; approvals 0; `state_used` `unknown` |
| finalization | `done_calls` 0, edits 0, no accepted gate, `incomplete_stops` 0, no unknown, no violation, `per_request` empty | `done_calls` 0, edits 0, `incomplete_stops` 0, `unknown`: `possible_changes_unvalidated` (the Bash listing), no violation |
| protocol files: batch files / batch removals / claims files / claims removals | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| coverage detail | mechanical 1, protocol 2, `search_whole_file_reads` 1, `unverified_binding` 1, grants created 1 / consumed 1 (`search`) | mechanical 1, protocol 3, uncovered `no_grant` 1, grants created 1 / consumed 0 (`ask`) |
| skill section | calls 1 (`result_without_identity`), Reads 0, exempt Reads 0, omitted 0 / 0; `load` `unknown`, `full_load` `unknown` | same |
| latency (ms) | helper median 1 877; direct Jev median `unknown` | helper median 995; `unknown` |

Evidence hashes (sha256, files outside git in `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R10/`; full values in `metrics.json`):

| file | F1 | F2 |
| --- | --- | --- |
| `transcript.jsonl` | `21dd716b11f36ed1…` | `78b1af4c3d365e0b…` |
| `session.log` | `25193e020c3de6c6…` | `8e2ac6afe2d69c09…` |
| `measure/metrics.json` | `7bb19026e4e7c155…` | `fc050d30cd448f19…` |
| prompt file | `6c7dd5e3b091a307…` | `61c790632d31b8a3…` |

`prep.json` `b993219d1401af06…` · `oracle.json` `055e2475a987e087…`. The transcripts are also kept by Claude Code under `~/.claude/projects/<encoded cwd>/<session id>.jsonl`. The `jev_decide` record of the chosen defect is under «The most important defect or gap».

## What R09 left open, answered by the transcripts

- **Does `Skill jev:jev-control-mode` deliver `SKILL.md` in `-p`? Yes, in both sessions, but not in the form the measurer expects.** The tool result is only «Launching skill: jev:jev-control-mode» (transcript:20); the skill arrives in the next record (transcript:21) as a meta user message (`isMeta` true, `sourceToolUseID` the Skill call): «Base directory for this skill: /Users/apana/Dev/jev-mcp/skills/jev-control-mode», a blank line, then the body. It is 15 989 bytes; after the first two lines it equals the body of `SKILL.md` (the text after the frontmatter, which is not included) except for one line where `${CLAUDE_PLUGIN_ROOT}` is replaced by the plugin path (derived by hand from the transcript, F1 and F2 identical). This is a manual derivation kept apart from the audit: `measure.mjs` reports `skill.load: unknown` (level `result_without_identity`) for both sessions, because it looks for the frontmatter in the tool result, and `full_load` is `unknown` by design.
- **Is the Read rule granted in `-p`?** Unmeasured: neither session tried to `Read` any skill file (the `Skill` tool was enough). The earlier refusals were of a `Read` outside the working directory (R04–R08).
- **Did the compact rules reach the model?** Yes: the activation text with the rules is the hook's additional context at transcript:10 in both sessions, and `on` printed the same rules in `next` (transcript:28 and :29). What the rules changed is not measurable at n=1.
- **Was the completion gate exercised live?** No: `done_calls` is 0 in both sessions (as in R08); the gate has never run live.

## Adherence, kept apart from correctness and tokens

Observations only; nothing here is a verdict of conformance with the protocol, and an oracle pass is not conformance.

- **F1, observed:** the `Skill` call (transcript:19) and the separate meta message (:21), `on` (:27 → :28), one `search` that returned `found` with one hit at 0.98 (:30 → :31), a `Read` of the hit file (:33 → :34) and a correct read-only answer (:36). Oracle PASS; coverage 1/1 (the `Read` bound to the search grant, `unverified_binding` 1); `decide` and `done` absent (0 calls each). **Not demonstrated:** that the whole protocol was followed. How many real alternatives existed inside the task (rule 1: «every choice with 2+ real alternatives») is not shown by the transcript: the model listed none, and choices made internally are unmeasurable (the measurer's own note). The empty finalization findings of F1 (no edit, no `done`, no violation, `per_request` empty) only say that the auditor found nothing to flag in a read-only answer; they do not by themselves prove that the protocol was respected.
- **F2, observed:** the `Skill` call and `on` (:27 → :29), then the model's own `ls; git ls-files` (:28 → :30; five tracked files: `package.json` and four under `src/` and `test/`), then `search` (:33 → :34, `none_eligible`) and one widen (:37 → :38, `search_budget_exhausted`, two evaluations); the helper printed no scores or candidates. The final message (:41) says «Neither run scored any location strictly above 0.95, and the search budget for that query is now used up. Under the mode's rules I can't pick files with my own judgment.», **names three paths** (`src/range.mjs`, `src/schedule.mjs`, `test/range.test.mjs`) and offers the user three options: approving the reading of those files, naming the files themselves, or turning the mode off. It did not start with `Incomplete:`, nothing was edited and the oracle failed honestly. Whether the model knew it was headless is not shown.
- **F2 coverage, kept as the auditor classified it:** 0/1, the listing command counted `no_grant`. A different reading is possible, namely that rule 2 («rg/glob only list candidates») makes a pure listing not a file selection, which would leave the denominator at 0; that is an **interpretation** only: it is not demonstrated as permitted by the contract, the auditor was not changed, and the figure stays 0/1.
- Whether the final message of F2 is tied to the `jev-done.md` wording is unproven: no `done` call occurred.

## Tokens, side by side as different tasks (D50)

Parent tokens (in / out / cache read / cache creation), turns and cost. **These are different tasks and prompts: no saving, no percentage and no paired comparison is claimed; the comparison on the same scenario is `unmeasured` (no baseline was run on F1 or F2).** Every row is n=1; the R01 pilot ran with the claude.ai connectors loaded and is not comparable at all.

| session | scenario / threshold | oracle | in / out / cache read / cache creation | turns | cost USD |
| --- | --- | --- | --- | --- | --- |
| R02 baseline S1 (ledger 2), no skill | S1 | pass | 10 / 768 / 81 292 / 8 561 | 6 | 0.0582 |
| R02 baseline S2 (ledger 3), no skill | S2 | pass | 10 / 1 613 / 83 427 / 9 475 | 8 | 0.0707 |
| R02 dev S1 (ledger 4) | S1, 0.95 | pass | 14 / 1 506 / 123 812 / 10 498 | 11 | 0.0818 |
| R02 dev S2 (ledger 5) | S2, 0.95 | pass | 14 / 1 890 / 123 608 / 10 482 | 11 | 0.0856 |
| R08 dev S1 (ledger 14) | S1, 0.95 | pass | 8 / 1 077 / 65 435 / 9 196 | 6 | 0.0607 |
| R08 dev S2 (ledger 15) | S2, 0.90 | fail (stopped `Incomplete:`) | 36 / 5 021 / 383 902 / 15 375 | 23 | 0.1886 |
| **R10 F1 (ledger 16)** | F1, 0.95 | pass | 10 / 661 / 101 068 / 14 572 | 6 | 0.0851 |
| **R10 F2 (ledger 17)** | F2, 0.95 | fail (nothing edited) | 10 / 1 144 / 101 499 / 14 861 | 7 | 0.0912 |

Observations only: the two R10 sessions are small (6 and 7 turns). Their cache-creation figures (14 572 and 14 861) are above those of the other five earlier rows of this table (8 561 to 10 498) and **below** the 15 375 of R08 dev S2; across all 15 earlier sessions of the campaign (see «Campaign sessions») they are above ten and below five (R04 S2 17 708, R05 S4 15 610, R05 S2 17 258, R06 S2 20 934, R08 S2 15 375). The Skill result of 15 989 bytes is part of what the sessions carry; whether the activation text and the skill body account for any difference is not tested, and no causal statement about the cost of the skill is made. The parent tokens of the failed F2 are not an economy: it stopped without doing the task.

## The most important defect or gap (recommendation only, D48)

Chosen with `jev_decide` over five candidates (confidence **0.99**, above 0.95). The record is in the executor's Claude Code session store, outside git: project `-Users-apana-Dev-jev-mcp`, file `071a2b92-2f1c-4017-b23b-1b54e2470069.jsonl`, call at line 335 and result at line 336 (2026-10-03T08:03:37Z and 08:03:38Z; `metrics.json` `defect.jev_decide_record`; the session file grows, so the line numbers and times identify the records, not a file hash). The selected gap: **a strict-threshold search stop left a repository of five tracked files without an eligible file, and the two search results print no scores and no candidates; the controlled task stayed undone** (F2). Evidence: F2's `search` returned `none_eligible` and then `search_budget_exhausted` after two evaluations in a repository that the model had just listed (`package.json`, `src/format.mjs`, `src/range.mjs`, `src/schedule.mjs`, `test/range.test.mjs`, transcript:30).

**Correction of the text given to `jev_decide`:** its evidence said that the model had no way forward except asking the user and had no candidates. The transcript does not support that as stated: the final message (:41) names three paths and asks the user to approve reading them. The selection therefore rests on partly overstated evidence and is a recommendation, weaker than its 0.99 suggests. What is verified: both search results carry no scores or candidates, no edit was made and the task stayed undone. The same family of stops is in the earlier rounds with `decide` (R06 S2 stopped at the scores 0.84 and 0.22, R08 S2 at 0.80–0.90 against T = 0.90), each leaving the task undone; F2 is the case with `search`.

Recommendation for future work (not made in R10), stated as a **hypothesis**: if a `none_eligible` search said what it evaluated (the best score and the candidates, within the output cap), the stop could name them with their scores, and the user's approval of a named file (the rules already exempt exact paths the user names) might be one short step; it could also be measured whether a tiny, fully listed repository should be treated as one candidate set. Whether either would have changed F2 is not shown. Nothing forces the model (D42, D11). The other candidates, kept as recommendations: the measurer's skill identity (the real delivery is a separate meta message, so `skill.load` is `unknown` although the body was observed), the headless final message that does not start with `Incomplete:`, the gate never exercised live, and n=1 evidence with no same-scenario baseline.

## Limits

n=1 per scenario; no causal claim; an oracle pass is not conformance. `skill.load` is `unknown` in the audit for both sessions (manual derivation above); the Read rule is unmeasured; the live gate, the slash command in `-p`, delegation (not chosen: `unmeasured (not chosen)`), provider-internal Jev calls (`unknown`) and personal hooks are unmeasured. The audit was not modified. The offline checks of this round (below) prove the tests and the manifest, not the product's behaviour in sessions.

## Offline checks (before the sessions and again before the commit)

`env -u NODE_TEST_CONTEXT node --test private/jev-control/test/`: 556 tests, 89 suites, 556 pass; `node --test private/jev-flow/test/`: 324 pass, 61 suites; `claude plugin validate .` passed; `node private/jev-control/fixtures/seal.mjs verify`: ok; `git diff --check` clean; protected diff against `879c2ba` (`src`, `skills/jev`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `test`, `skills/handoff-verify`, `opencode-plugin.js`): empty. The product files (`private/jev-control/*.mjs`, `test/`, `fixtures/`, `commands/`, `agents/`, `hooks/`, `scripts/`, `.claude-plugin/`, `private/jev-flow/`, `skills/` except the evaluation note) are identical to `6b18815`; the earlier reports R01–R09 are not rewritten.

## Campaign summary (T2, R01–R10)

20 sessions were allowed; **17 were used and 3 reserve sessions were never needed** (ledger lines 1–17). Live metrics of a round without sessions are `unmeasured`, never reused.

| Round | Sessions (ledger) | What was run | Oracle | `decide` / `search` / `done` used | Main defect found | Remedy |
| --- | --- | --- | --- | --- | --- | --- |
| T2 | 0 | offline build: helper, hook, measurer, fixtures | — | — | — | the contract «c2» and its tests |
| R01 | 1 (1) | pilot baseline S1, claude.ai connectors loaded (not comparable) | pass | — | the isolation check found ambient configuration | D28, D30 (offline) |
| R02 | 4 (2–5) | two clean baselines + dev S1, S2 | all pass | none after `on` | the control activated and then decided nothing | D31 text, runner |
| R03 | 2 (6–7) | dev S3 (ambiguous search) twice | pass / fail | — | `Skill jev:jev-control` returned the command text, one session ended with the mode off | offline fix |
| R04 | 2 (8–9) | dev S2 (order), S3 regression | fail / pass | S2: `decide` by trial and error; S3: `search` found 0.98 | `SKILL.md` unreadable headless, batch format learned by trial | `help` and `--help` |
| R05 | 2 (10–11) | dev S4 at 0.95, dev S2 at 0.90 | pass / pass | S4: `decide` then `Incomplete:`; S2: `decide`; none ran `done` | `decide` chained with `rm`, scratch writes counted as edits | offline fixes (D33 threshold) |
| R06 | 2 (12–13) | dev S1 at 0.95, dev S2 regression at 0.90 | pass / fail | S1: none; S2: 10 `decide`, stopped at 0.84 | model wrote six batch files and left them | cleanup line |
| R07 | 0 | offline: `done --claims` path for headless | — | — | the gate was unreachable headless | claims file (D37, D38) |
| R08 | 2 (14–15) | dev S1 at 0.95, dev S2 at 0.90 | pass / fail | S1: none; S2: 6 `decide`, stopped at 0.90; the live gate not exercised | measurer counted scratch batch files as edits | offline measurer fix |
| R09 | 0 | offline (D42–D47): rename the skill, compact rules, Read rule, skill section of the measurer | — | — | name conflict, rules only by reference, headless Read refused | `jev-control-mode`, `rules.mjs`, D45 |
| R10 | 2 (16–17) | sealed F1, F2 on the frozen R09 product | pass / fail | F1: `search` (0.98); F2: `search` twice, none eligible; no `decide`, no `done` | a strict-threshold search stop left a five-file repository undone (F2) | recommendation only (D48) |

### Campaign sessions: coverage, attributed tokens, provenance

One row per live session (ledger 1–17). **Provenance:** coverage and tokens are the `measure/metrics.json` that each round saved at that round (the measurer revision of that round; coverage denominators changed between revisions and are not comparable across rounds); R10 recalculated nothing. The only documented historical recalculation is R08 dev S2 (`results/R08`): live 0/11, recalculated with the R08 measurer 0/6, kept apart. Tokens are parent tokens (in / out / cache read / cache creation) with the number of unique assistant messages; attribution is `known` in every row, subagent messages 0 and unattributed messages 0 in every row (subagent and provider-internal tokens `unknown`, never 0). Control conformance: not applicable for baselines (the mode was never activated); for controlled sessions the oracle result is shown, which is not conformance (see each round's report). The offline rounds T2, R07 and R09 have no live session: coverage and tokens `unmeasured`. Different scenarios, thresholds and product revisions: no saving, no percentage and no paired comparison is made between rows (D50). The session id is an identifier for the local transcript, not a capability; the evidence hashes of every row are in `metrics.json` (`campaign_sessions`).

| ledger | round | session | scenario | threshold | oracle | coverage | tokens in / out / cache read / cache creation | messages | session id | control conformance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | R01 | pilot baseline S1 (claude.ai connectors loaded) | `s1-bug-several-files` | n/a (no mode) | pass | 0/6 | 12 / 796 / 113 948 / 11 597 | 6 | `11badc27…` | not applicable |
| 2 | R02 | clean baseline S1 | `s1-bug-several-files` | n/a (no mode) | pass | 0/5 | 10 / 768 / 81 292 / 8 561 | 5 | `d1fabd5b…` | not applicable |
| 3 | R02 | clean baseline S2 | `s2-ordered-tasks` | n/a (no mode) | pass | 0/7 | 10 / 1 613 / 83 427 / 9 475 | 5 | `c1b483bc…` | not applicable |
| 4 | R02 | dev S1 | `s1-bug-several-files` | 0.95 | pass | 0/7 | 14 / 1 506 / 123 812 / 10 498 | 7 | `898cdf2b…` | oracle only, see the round |
| 5 | R02 | dev S2 | `s2-ordered-tasks` | 0.95 | pass | 0/7 | 14 / 1 890 / 123 608 / 10 482 | 7 | `b555ca82…` | oracle only, see the round |
| 6 | R03 | dev S3 (a) | `s3-ambiguous-search` | 0.95 | pass | 0/3 | 12 / 1 044 / 102 473 / 9 304 | 6 | `b5ae832d…` | oracle only, see the round |
| 7 | R03 | dev S3 (b) | `s3-ambiguous-search` | 0.95 | fail | 0/0 | 6 / 736 / 45 713 / 8 110 | 3 | `242a5ebd…` | oracle only, see the round |
| 8 | R04 | dev S2 | `s2-ordered-tasks` | 0.95 | fail | 0/14 | 48 / 7 371 / 517 549 / 17 708 | 24 | `755d1a8f…` | oracle only, see the round |
| 9 | R04 | dev S3 regression | `s3-ambiguous-search` | 0.95 | pass | 0/4 | 10 / 961 / 82 840 / 8 628 | 5 | `f23d71a8…` | oracle only, see the round |
| 10 | R05 | dev S4 | `s4-missing-requirement` | 0.95 | pass | 0/13 | 28 / 5 991 / 288 997 / 15 610 | 14 | `71cb0499…` | oracle only, see the round |
| 11 | R05 | dev S2 | `s2-ordered-tasks` | 0.90 | pass | 3/14 | 42 / 6 430 / 466 960 / 17 258 | 21 | `b05c0049…` | oracle only, see the round |
| 12 | R06 | dev S1 | `s1-bug-several-files` | 0.95 | pass | 0/7 | 12 / 1 524 / 104 202 / 9 780 | 6 | `06736f74…` | oracle only, see the round |
| 13 | R06 | dev S2 | `s2-ordered-tasks` | 0.90 | fail | 2/18 | 58 / 9 498 / 688 414 / 20 934 | 29 | `523942a8…` | oracle only, see the round |
| 14 | R08 | dev S1 | `s1-bug-several-files` | 0.95 | pass | 0/4 | 8 / 1 077 / 65 435 / 9 196 | 4 | `30eced9b…` | oracle only, see the round |
| 15 | R08 | dev S2 | `s2-ordered-tasks` | 0.90 | fail | 0/11 (live); 0/6 recalculated | 36 / 5 021 / 383 902 / 15 375 | 18 | `b8aba0a6…` | oracle only, see the round |
| 16 | R10 | sealed F1 | `f1-ambiguous-ttl` | 0.95 | pass | 1/1 | 10 / 661 / 101 068 / 14 572 | 5 | `2b5603a6…` | oracle only, see the round |
| 17 | R10 | sealed F2 | `f2-inclusive-range` | 0.95 | fail | 0/1 | 10 / 1 144 / 101 499 / 14 861 | 5 | `a862fe68…` | oracle only, see the round |

Of the 14 live controlled sessions (R02 dev ×2, R03 ×2, R04 ×2, R05 ×2, R06 ×2, R08 ×2, R10 ×2) the oracle passed in 9 and failed in 5 (R03 b, R04 S2, R06 S2, R08 S2, R10 F2); per the round summaries every failure is a non-completion (task unanswered, no file changed, two of four tasks done, nothing done) and none a wrong edit. This count is descriptive (different scenarios, thresholds and product revisions) and not a rate.

## Weak points that remain

1. **Strict-threshold stops leave tasks undone** (F2; R06 S2 and R08 S2 with `decide` at T = 0.90): the clearest observed effect on the goal that the control delivers finished work (descriptive, n=1 per cell). A recommendation is above; not fixed in R10 (D48).
2. **Many controlled sessions made no `decide` call.** In R02 (dev S1, S2), R06 S1, R08 S1 and F1 the model ran `on` and made no `decide` call (F1 used only `search`); why is not shown by the transcripts, and whether that is the intended reading of the exemptions (D3, D9) or too little control was never settled.
3. **The completion gate was never run live** in any session (R08 and R10 measured `done_calls` 0).
4. **The measurer cannot see the real Skill delivery** (separate meta message): `skill.load` is `unknown` although the body arrived (manual derivation in this round).
5. **Headless stop wording:** F2's final message did not start with `Incomplete:`; the audit treats it as `unknown`, and the link to the `jev-done.md` wording («end with `Incomplete:`», `commands/jev-done.md:41`, `:45`, `:50`) is unproven; those lines are outside the allowed surface and still say «end with».
6. **Evidence depth:** n=1 per cell, no same-scenario baseline for the sealed finals, token effects of the skill and the rules separated from chance only by repetition that was never run; the Read rule (D45) and the slash command in `-p` are unmeasured; subagent tokens are `unknown`.
7. **Token goal:** the controlled sessions of R10 are small, but the sealed finals have no baseline, so the user's token-reduction goal is neither shown nor refuted by this campaign.

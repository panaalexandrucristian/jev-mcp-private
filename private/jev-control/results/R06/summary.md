# R06 — dev S1 at the default threshold and dev S2 regression at a configured threshold of 0.90

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin 0.7.0, Node v22.23.1, Claude Code 2.1.288, model `claude-sonnet-5-5`, Jev MCP server `jev-mcp@0.13.0` (as printed by `cli.mjs on` in both sessions). Both sessions ran on the committed snapshot `18910dd` (nothing changed before or between them, D35). Plugin snapshot hashes at launch: `plugin.json` `302328d4…1dd3` and `hooks.json` `5cc80aba…1c15` (equal to R02–R05), `hook.mjs` `bb6c5905…0315`, `cli.mjs` `f82c38f7…5f2e`, `help.mjs` `5b5430d7…ae44`, `run-session.mjs` `b0d1f6e4…cf8f`, `commands/jev-control.md` `c81dfd3d…2ab6`, `SKILL.md` `357b1a4e…89a4`. Scenario hash S1 `d134fbb9…42ac` and dev prompt sha256 S1 `9cf19555…c6bd` are equal to R02's dev S1; scenario hash S2 `05098291…f2b0` and dev prompt sha256 S2 `2495e29f…5959` are equal to R05's dev S2. Both pristine copies fail their oracle.

**Sessions: 2 (the plan's maximum).** Ledger `11/20` before, `13/20` after, 7 left (R07 2, R08 2, R10 2, reserve 1); the reserve is untouched. Lines (time only, as the wrapper wrote them): `12` 03:32:04Z dev S1 (threshold default 0.95, D34) · `13` 03:32:32Z dev S2 (threshold 0.90 through `run-session.mjs launch --threshold 0.90`, D34, the second explicit use of the D33 mechanism). Strictly sequential through `run-session.mjs` and the budget wrapper; both `state done`, exit 0, no timeout, `group_gone` true, no lock before the second launch; ledger and lock re-read before each launch.

Figures come from the streams ("stream:N"), the transcripts ("transcript:N", outside git; N is the 1-based line) and `measure.mjs`, which is unchanged since `18910dd`. The stream `result.usage` equals the per-message totals of `measure.mjs` in both. Raw files: `/Users/apana/Dev/council-runs/2026-10-02/jev-control-runs/R06/`. No capability or e-mail address appears here.

## Isolation (D30) and the threshold, both inits and `on` results

Init (stream:3): the only MCP server is `plugin:jev:jev` (connected, source plugin), no claude.ai connector, 37 tools, `permissionMode` `acceptEdits`, plugin `jev@inline 0.7.0` plus three builtins. Personal `PreToolUse`/`PostToolUse` hooks: absence not demonstrated. Threshold: the `on` result of S1 says `threshold 0.95`, `threshold_source default` (transcript:22); of S2 `threshold 0.9`, `threshold_source env` (transcript:22). `launch.json` records `threshold` null for S1 and `"0.90"` for S2. The model passed no `--threshold` in either session; every S2 `decide` result carries `"threshold":0.9` (transcript:56, :83, :95, :107, :120, :130, :141; the two invalid results and the refusal, :41, :74 and :64, carry none). So no decision was taken at another threshold.

## The two sessions

| | dev S1, ledger 12 (T = 0.95) | dev S2, ledger 13 (T = 0.90) |
| --- | --- | --- |
| hook line (marker «in natural language for this request.») | transcript:10 | transcript:10 |
| first assistant message | **`on`, a `Read` of SKILL.md and the model's own `git ls-files && grep -rniE … \| head -50` in ONE message** (transcript:19, :20, :21; the `on` result arrived at :22) | `on` and the `Read` of SKILL.md in one message (transcript:20, :21; result :22) |
| `Read` SKILL.md | refused (transcript:20 → :23; stream:9, reason `workingDir`) | refused (transcript:21 → :23; stream:11) |
| `help decide` / `help search` | not used | one command `help decide …; help search …` (transcript:29 → :30, 2 021 bytes) |
| `search` | not used (own `grep`, transcript:21) | not used |
| `decide` calls | **0** | 10: invalid, expand, refused, invalid, expand, ordered, ordered, expand, expand, incomplete |
| batch files | none | `jev-batch.json` (Write, created, :37), then four `Edit`s of it (:49, :59, :67, :76), then `jev-batch2.json` … `jev-batch6.json` (one Write each, created) |
| `decide` ended with a pipe, `;` or `&&` | no `decide` | **none: all 10 ran alone** |
| batch files removed | — | **0 of 6; no `rm` call at all; all 6 untracked files were in the tree at the end** |
| statuses and top scores | — | decision 1 (order of four tasks): expand (rename 0.82, :56), refused `no_new_material` (:64), invalid (evidence of 1–3 lines, :74), expand (rename 0.77, :83), **ordered, plan `rename:e:0.96`** (:95). Decision 2 (three left): **ordered, plan `greeting:e:0.93`** (:107). Decision 3 (two left): expand (test 0.79, :120), expand (test 0.77, :130), **incomplete: test 0.84, changelog 0.22** (:141) |
| plan items executed / not planned | — | rename (Edit :98) and greeting (Edit :109) are the two plan items; **no action outside the plan** (the test and the changelog were not touched) |
| `--decision-id` and `new_material` on expansion | — | yes on every rerun; the refusal came from `new_material` without new evidence (:64) |
| frozen oracle | **pass** (`pageCount` fixed, `Page 1 of 2`) | **fail**: renamed field and greeting done, `test` and `log` checks false (two of four tasks not done) |
| `node --test` | the model ran it, 2/2 (:45); evaluator in the copy 2/2 | the model never ran it; evaluator in the copy 1/1 (the unchanged test still passes) |
| final message | «Fixed. …» and «I didn't run `/jev:jev-done` … Jev control is on, but I didn't use `decide` because there was only one reasonable fix.» (transcript:49) | begins `Incomplete: no option exceeded T=0.9 after 2 expansion rounds; scores: test=0.84, changelog=0.22, …`, lists done and not done, offers two choices, and says «I also left the scratch files `jev-batch.json` and `jev-batch2.json` through `jev-batch6.json` in the working directory, and they need deleting.» (transcript:144) |
| `/jev:jev-done` | **not run**; the model says so | not run (it stopped with `Incomplete:`) |
| stream turns / unique assistant messages | 9 / 6 | 30 / 29 |
| parent tokens in / out / cache read / cache creation | 12 / 1 524 / 104 202 / 9 780 | 58 / 9 498 / 688 414 / 20 934 |
| tools | Bash 5, Read 1, Edit 2 | Bash 15, Read 1, Write 7 (one rejected), Edit 6 |
| permission denials (stream) | 2: the `SKILL.md` Read (:9), a `python3` heredoc with `node --test` (:16, `subcommandResults`) | 3: the `SKILL.md` Read (:11), `sed -i` (:28, reason `other`), `cat > jev-batch2.json <<'EOF'` (:56, «brace with quote character») |
| cost (stream, USD) · stream duration (ms) · wrapper wall time (ms) | 0.0752 · 12 458 · 14 024 | 0.3165 · 100 211 · 101 305 |

## Verdicts, kept apart

**Frozen oracle (correctness).** S1 pass. S2 fail, honestly: Jev would not clear an order for the last two tasks at 0.90 and the model stopped as the protocol says. A fail here is not a protocol failure.

**Protocol conformance.** S1: `on` ran in the first message but together with the model's own search, so the `next` line of the `on` result reached the model after the search; after it the model read the files with `cat`, judged «Single obvious fix; use the existing helper.» (transcript:34) and edited with no `decide`, no `search` and no `/jev:jev-done`: coverage 0/7 (`no_grant`), a genuine `completion_declared_without_accepted_done` (the model says it did not run it). The mode was on and decided nothing, as in R02 dev S1. S2: every `decide` ran alone; the plan items were the only task edits; the model decided again for the tasks left and stopped with `Incomplete:` when nothing cleared; threshold reached the helper from the environment; one valid batch took one invalid attempt (4 tasks without `space_small`). Against that, the batch was repaired with `Edit` four times instead of a new file each round, `sed -i` and a heredoc were refused, and **none of the six batch files was removed**.

**Measurement (`measure.mjs` at `18910dd`, the same as at launch; R05 S2 re-measured with it is byte-identical to `measure-revised5`).**

| | S1 | S2 |
| --- | --- | --- |
| coverage (covered / denominator) | 0/7, 0 unknown; uncovered all `no_grant` (SKILL.md Read, `git ls-files … grep`, `cat`, the denied heredoc, 2 Edits, `node --test`) | 2/18, 0 unknown, 0 user-named paths; uncovered 16 (15 `no_grant`, 1 `while_blocked`); 2 `unverified_binding`, 0 `receipt_verified` (the model never ran `receipt verify`) |
| `protocol_batch_files` / `protocol_batch_removals` | 0 / 0 | 0 / 0 (nothing was removed, so no batch version can be proven helper input) |
| threshold: decisions / plan items checked / violations | 0 / 0 / 0 | 2 / 2 / 0 (0.96 and 0.93 are strictly above 0.90) |
| actions while blocked | 0 | 1: the `Edit` of `jev-batch.json` at transcript:67, made after the `refused` result at :64 |
| below-threshold actions without approval (eliminator) | 0 | 1 — **the same scratch-file Edit, not an action of an option**; a chain of `jev-batch.json` was already ended by the refused `sed -i` (transcript:44–45) that names the file, which the audit may not read as «nothing ran» (R05), so no sound exemption exists for it. Read from the transcript: no action below the threshold was taken. |
| ordering: plans descending / order violations | 0/0 | 2/2 / 0 |
| finalization | 2 edits, 0 `done`, **1 violation** (genuine) | 13 edits (6 batch Writes, 1 rejected Write, 4 batch Edits, 2 repository files), 1 incomplete stop, 0 violations |
| Jev calls: direct / helper-reported attempts / budget | 0 / 0 / 25 per request | 0 / 7 / 25 per request, 0 budget violations |
| subagents | none started (`unknown`, never 0) | none started |

**Compact helper (bytes of output that entered the model's context; bytes are not tokens).** S1: `on` 705. S2: `on` 680, `help decide; help search` 2 021, the ten `decide` results 357, 345, 221, 157, 346, 216, 218, 314, 316 and 461 (largest 461), total 5 652 bytes of helper output. No `plan_next`, no `scores_next`, no `page` call (plans of one item). No file was read twice; the largest single result in either context is the 2 021-byte help. The R05 `help decide` is 1 499 bytes.

**Delegation: unmeasured (not chosen).** No `Agent`, no `jev-locator`, no `delegate` decision in either session (D35); no prompt, scenario, help or `SKILL.md` text was changed to provoke it. Subagent tokens `unknown`.

**What the R05 help wording did (S2 only; S1 never read it).** Decide alone: yes, 10 of 10 (R05 S4: 0 of 4). A NEW file in the working directory: yes for the first file and for each later decision; but the repairs of one decision were `Edit`s of the same file. Only the plan items executed and a new decision for the rest: yes (R05 S2 did the changelog without a plan item; here nothing was done outside the plan). The lone `rm`: **not done, 0 of 6** — the model knew («they need deleting», transcript:144) and left them to the user.

## Tokens (parent, in / out / cache read / cache creation), n = 1, no saving claimed

- S1 R06 `12 / 1 524 / 104 202 / 9 780`, 6 messages, oracle pass, against the clean baseline ledger 2 `10 / 768 / 81 292 / 8 561` (pass): delta `+2 / +756 / +22 910 / +1 219` (same session configuration, no skill) and against R02 dev S1 ledger 4 `14 / 1 506 / 123 812 / 10 498` (pass; before R03–R05, and neither decided anything): `−2 / +18 / −19 610 / −718`. The R03–R05 changes are the text of the hook line, the `help`, `SKILL.md`, the examples and the measurer; no decision ran in either, so the difference cannot be attributed to them.
- S2 R06 `58 / 9 498 / 688 414 / 20 934`, 29 messages, oracle **fail**, against R05 S2 ledger 11 `42 / 6 430 / 466 960 / 17 258` (pass; same configuration and threshold 0.90, the one skill difference is the R05 help/SKILL.md text): `+16 / +3 068 / +221 454 / +3 676`; cost 0.3165 against 0.2268 USD and 30 against 26 stream turns. A session that did not do the task earns no saving claim, and none is made; the larger figure comes with ten `decide` calls, six batch files and 13 edits, the cause is not isolated. Against the clean baseline ledger 3 `10 / 1 613 / 83 427 / 9 475` (pass): `+48 / +7 885 / +604 987 / +11 459`, **marked «configuration different: the threshold 0.90»** (and the oracle result differs). Against R04 dev S2 ledger 8 `48 / 7 371 / 517 549 / 17 708` (fail): two differences (the threshold, and the R04 and R05 help texts).

## Defect and change

**The defect: scratch batch files are left behind.** S2 wrote six batch files into the user's working directory and removed none (`git status` in the copy lists `?? jev-batch.json … jev-batch6.json`). The instruction to `rm` sat at the end of one bullet of `help decide`, read at transcript:30 and followed by 117 more lines; at the end the model (in `Incomplete:` state) knew they existed and asked the user to delete them. Consequences: stray untracked files in the user's repository; every batch write counts as an edit (13 edits, coverage 2/18), `protocol_batch_files` stays 0 so the R05 exemption has never been exercised on live data; the finalization then asks for `/jev:jev-done`. Candidates were weighed with `jev_decide` (six candidates, evidence from the transcripts): this one, 0.95 (the others: a measurer exemption for the blocked edit 0.03, `on` in its own turn 0.01, `/jev:jev-done` never run 0.01 — planned for R07 —, token cost, one task per round, all ≈ 0). Not chosen and recorded: the S1 bypass (`on`, `Read` and `grep` in one message; a «single variant» judgment) and the `/jev:jev-done` omission (4 of 4 editing dev sessions) are real and open; the blocked-edit artefact (a scratch repair counted as a below-threshold action, R05 and R06) has no sound fix while a refused `sed -i` ends the chain.

Change (offline; effect unmeasured until a later live round):
- `cli.mjs`: a `decide` result whose status ends a batch (`selected`, `ordered`, `ask_user`, `incomplete`) carries `"cleanup":"if you wrote <file> for this decision, remove it now: rm -f <file>, alone in its own command"`, naming the file as passed; no line for `expand`, `refused`, `invalid`, `unavailable`, `--file -`, or a path a lone `rm -f` cannot name (a dash first, a space, quote, `$`, `;`, `|`, glob, `~`, newline, a `..` segment or an absolute path). The line is data inside the 1 500-byte cap (a long plan is paged, the line stays). The condition in the text exists because the helper cannot tell who created the file.
- `SKILL.md` step 2 says the result repeats the removal in a `cleanup` line. `help decide` is unchanged at 1 499 bytes (no room; the reminder is where the model acts, not in the help).
- Tests: `cli.test.mjs` (a new `describe`: the line on `selected`, none on `expand` and the line on the `incomplete` that ends the batch, none on `invalid` and `refused`, `cleanupLine` for the statuses and 20 bad paths, the line kept by `compactOut` next to a paged plan) and `manifest.test.mjs` (the `SKILL.md` sentence). 2 of the new tests fail on the previous `cli.mjs` and the manifest test fails on the previous `SKILL.md`; each of 10 mutations of the new code (the call removed, `expand` added, `incomplete` or `ordered` dropped, no path regex, a leading dash, a space, the `..` check, the `$` anchor, the text «alone») makes at least one test fail; a mutation of a redundant `-` check survived and the check was removed.

## What is not measured

- Whether the `cleanup` line makes the model remove the file, and whether the R05 exemption then proves a batch on live data: no session is left in R06.
- `SKILL.md` is unreadable in these headless runs (both `Read`s refused), so the effect of the R05 `SKILL.md` wording on a live session cannot be shown here; only `help` and the `on` line reach the model. Interactive sessions, the `claude -p` slash command (D31), provider-internal Jev calls and the absence of personal hooks stay unmeasured.
- Delegation (not chosen); subagent tokens; whether one `order` decision could clear several tasks (here again one item each); why the stream `num_turns` exceeds the unique assistant messages in S1 (9 against 6; S2 30 against 29).
- n = 1 per session: no ranking, no causal claim.

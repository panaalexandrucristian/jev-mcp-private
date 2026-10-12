# Round 4: verify what was proposed, and new candidates (rules written BEFORE any run)

Written 2026-10-11T20:07:32Z. No model session, no emulator tap and no council has been run for this round. Rounds 1-3 (EVAL-RULES.md, -2, -3) stay as they were.
Source: section 4 of HANDOFF-class-graph-ctx-savers.md (user: "vreau sa faci un consiliu ori sa propui si alte solutii ... si sa le verifici pe cele propuse").
Labels: measured = produced by a run in rounds 1-3; calculated = arithmetic on measured numbers; guessed = no number behind it.

## A. Verification of what was already proposed (V)
| id | claim to check | how | gate (all must hold) | cost |
|----|----------------|-----|----------------------|------|
| V1 | a 540 px JPEG of a screen is enough to confirm a visual state (the rule "digest to navigate, shrunk screenshot to confirm") | the 13 screens of round 3 (screens.json): one Sonnet session per screen with the SHRUNK screenshot and the same 3 questions; compare with the full-size answers already stored in eval/results-r2/screens-sonnet.json | answers agree with the full-size answers on >= 2 of 3 questions on >= 75% of the screens; no screen where the full-size answer is right and the shrunk one is wrong on Q3 (visual state) | 13 sessions, calculated 0.26 USD (round 3 image sessions cost 0.0156-0.0159 USD each, measured) |
| V2 | ui-digest wrong answers come from elements that are in the layout but not visible | offline, no session: for the 2 wrong screens look for any attribute of the raw layout (bounds outside the page, state, layer, tree parent) that separates the invisible elements from the visible ones | an attribute exists that removes every invisible element of those 2 screens and no visible one; otherwise the limit stays "needs a screenshot for visual state" | 0 sessions |
| V3 | the 24+1 tests, the gate tables and the results files still reproduce the stored numbers | node --test with RESULTS_SUBDIR=results-r2, then node eval/run-all-2.mjs and run-all-3.mjs | tests all pass; every number in section 3 of the handoff is printed again (transcript-dependent numbers may only grow, see "as of") | 0 sessions |

## B. New candidates (C)
| id | candidate | replay or test | gate (all must hold to be "recommended") | cost |
|----|-----------|----------------|-------------------------------------------|------|
| C10 | ui-step: ONE command = tap a label (or swipe, or Back) + wait until the layout stops changing + print the ui-digest | offline fixtures with injected adb/android (tests in test/ui-step.test.mjs); then a read-only walk on the emulator with the whitelist of EVAL-RULES-3.md | tap decision correct on every combination of label class (allowed / forbidden / unlisted) x found (yes / no) x region (top / bottom / none): taps only when allowed and found; stops on login, verify or error text and on a screen with no app elements; settles before it prints (two equal reads in a row); fewer commands per navigation step than the 3-4 of the recorded session (tap, sleep, capture, Read) | 0 sessions for the offline part; the emulator walk is read-only |
| C11 | would the model USE ui-step? (the open risk: the model ignored the existing android-cli note about layout) | stand-in emulator: a shim for android and adb that serves the recorded layouts of round 3 (no real device), confined Sonnet sessions with the task "go to the Wallet tab and say which reward card is earned"; arm A = the existing note text, arm B = a one-line rule naming ui-step | arm B uses ui-step in >= 2 of 3 sessions and arm A in <= 1 of 3; arm B ends with the right answer; calls and cost per session reported for both arms | 6 sessions, calculated 0.15 USD (guessed range 0.1-0.3 USD) |
| C12 | instruction only, no script: independent calls in the same turn, and write + run a script in one call | 3 + 3 Sonnet sessions on a fixed read-only task with 4 independent lookups, arm B with the instruction | arm B makes at least 2 fewer model calls than arm A in >= 2 of 3 pairs, same answer | 6 sessions, calculated 0.15 USD |
| C13 | handoff phase in a small context (jev-mcp-be's delegated reading) | no new session: ask jev-mcp-be for its measured numbers (it reported a live test of 6 sessions, 0.82 USD, in its memory note) and compare with the 51.8% share and 37 calls at about 358k tokens of the replayed session | its measured saving is reported with its own labels; nothing is rerun here | 0 sessions, one message (only if you agree) |

## C. Council
A council (several models discussing the list) needs the roster, the tasks and the budget agreed with you first. Not started. Option: run it on the list above, read-only, 3 rounds.

## Budgets and stop rules
- Ledger: 1.326488 of 10 USD, 155 sessions (measured). Per-session cap 0.15 USD for Sonnet (CAP_USD), 0.10 USD for Haiku. Sessions are confined as in rounds 2-3 (copies, Read of the private folder only, dontAsk).
- Nothing is committed or pushed. Gate flaws found after seeing results are fixed for all candidates and disclosed.
- Emulator: read-only, whitelist and forbidden labels of EVAL-RULES-3.md; the only documented exception tap stays "Remind me next time" on the verification screen.
- Limits stated in advance: one app, one account, one transcript of one user; the transcript keeps growing, so replayed numbers are "as of".

## Addendum 2026-10-11 (user approved V1, C11 and C12; written BEFORE any session of round 4)
- V1 runs as written: SHRINK=540 in eval/measure-screens.mjs (JPEG quality 70 made with img-shrink.mjs), image jobs only, same three questions, same confinement, cap 0.15 USD; the full-size answers are the stored ones in eval/results-r2/screens-sonnet.json. "Right" for the second part of the gate = the full-size Q3 answer, which round 3 judged correct on all 13 screens (wrongAnswersFromImage 0); agreement is judged by the assistant, as in round 3, and every disagreement is listed.
- C11 gate flaw found before any run: arm A is told nothing about ui-step, so "arm A uses ui-step in <= 1 of 3" holds by construction. Fixed here, for the record: arm A = the text of the existing note (skills/android-cli/references/interact.md, whole file); arm B = the same note plus ONE added line naming ui-step with its path and arguments. The gate "arm B uses ui-step in >= 2 of 3 sessions" stays; "arm A <= 1 of 3" is kept but reported as trivial; added reported metrics (not gates): number of Bash calls and of model calls to the answer, cost, answer correct (the earned card of the Wallet screen in walk4-04-wallet).
- C11 stand-in: `android` and `adb` shims serve the recorded screens of the round 3 walk (layout JSON, PNG); transitions only by tapping the bottom tabs / Deals sub-tabs at the recorded coordinates; any other tap does nothing and is counted. No real device is touched in C11.
- C12 task and arms are fixed before the run in eval/c12-task.md (written next); C12 uses Bash in a sandbox over a copy of a fixed folder.
- C10 design fix before any test of ui-step was run (2026-10-11): a label that matches several elements with different centers and no unique region is now refused (exit 3, lists the centers and asks for --region) instead of tapping the first match silently; the old behaviour (first match) is the one in eval/emulator-run.mjs. It adds the combination "ambiguous" to the C10 tap matrix.
- C12 harness fix before the first measured C12 session (smoke session with Haiku, not counted): a Bash prefix allowlist denied a compound `find ... -exec` command; Bash is therefore allowed without prefixes in C12 (the sandbox still confines files: read only the session folder and the node install, write only its t/ folder). C11 had no denial in its 6 sessions with the prefix allowlist.

## Results (written 2026-10-11 after the runs; labels: measured / calculated / guessed)
Sessions: 13 (V1) + 6 (C11) + 6 (C12) = 25 measured sessions, plus 3 harness smoke sessions with Haiku (not counted in any result). Ledger 1.326488 -> 1.852476 of 10 USD (measured, 0.526 USD; calculated before: 0.56 USD).
Not run (not approved): V2, V3 (offline), C13 (message to jev-mcp-be), the council. Nothing committed, no message sent, the real emulator was not touched in this round.

### V1: a 540 px JPEG is enough to confirm a visual state: HOLDS on this set
- Agreement with the full-size answers: 13 of 13 screens agree on 3 of 3 questions (gate: >= 2 of 3 on >= 75%); 0 screens where the full-size Q3 was right and the shrunk Q3 differs. Judged by the assistant (not independent; both answers come from the same model). File: eval/results-r2/V1.json, raw answers eval/results-r2/screens-shrunk-540.json.
- Tokens (measured): context at the last call 4,220 (shrunk) vs 5,685 (full-size) over a 3,092-token baseline, so the per-screen increment is 1,128 vs 2,593 (-56.5%). Cost of the 13 sessions 0.126 vs 0.201 USD (-37%, measured, includes the fixed part).
- Limits: one app, one account, 13 screens; the Cart "bold = active" state and the "Complete" label were both read correctly at 540 px, but icon-only or very small states were not specifically sought; a misreading shared by both sizes is not caught.

### C10 ui-step (offline): 49 tests pass (46 in test/ui-step.test.mjs, 3 in test/stand-in.test.mjs)
- Tap matrix 31 cases (allowed / forbidden / unlisted x found / not found / ambiguous x region top / bottom / none): taps only when allowed and found; a refused request never reaches adb. Design fix before the first test: an ambiguous label (several elements at different centers) is refused with exit 3 instead of tapping the first match.
- Settling: prints the stable screen (two equal reads), reports "NOT settled after 12 s" on a flickering screen; stops on the three login/verify/error texts, on a screen with no app elements after one retry; layout / JSON / adb failures are STOPs. The real CLI was run against the stand-in (not a device): moves through the bottom tabs, exit 3 for forbidden, unlisted and ambiguous, exit 2 for bad arguments, --shot writes a 540 px JPEG.
- NOT tested: ui-step on the real emulator (the stand-in serves recorded layouts), so real settling times and the real `android screen capture` output are unverified.

### C11 would the model use ui-step: YES in this setup (gate met)
- Arm B (existing note + one line naming ui-step): uses ui-step in 3 of 3 sessions (gate >= 2); arm A (existing note only): 0 of 3 (trivial, it is not told about ui-step). Both arms right in 3 of 3 ("Spend $30, Earn $5").
- Measured per session, A vs B: model calls 3 vs 2, tool calls 2 vs 1 (A: `android layout`, then tap + sleep + layout piped through grep; B: one ui-step command), context at the last call about 14.2k vs 10.1k tokens, cost 0.037-0.061 vs 0.0275-0.0276 USD. File: eval/results-r2/C11.json, raw streams in eval/results-r2/raw/c11-*.jsonl.
- Limits: stand-in device; a one-step task (Home -> Wallet); the prompt gives the exact script path in the added line (in real use that line and the path would have to live in the android-cli note or a skill); 3 sessions per arm; not tested whether the model keeps using it in a long, crowded context, which was the original risk.

### C12 instruction only (parallel calls, one script per call): NOT RECOMMENDED by the gate (0 of 3 pairs)
- Model calls A = 3, 3, 3 and B = 3, 3, 3: no saving; arm A already averages 3 calls (the floor is 2), so the task leaves no room for the 2-call saving the gate asks for. All answers right in all 6 sessions. Tool calls A 2, 3, 3 vs B 2, 2, 2. Cost A 0.0465, 0.0303, 0.0291 vs B 0.0261, 0.0213, 0.0209 USD (measured; not a gate, 3 pairs, noisy).
- Limits: a 4-lookup read-only task over a 31-file folder is easy; Sonnet 5.5 already answers with 2 or 3 tool calls (1 call carrying 2 tools at most) without the instruction. It says nothing about the long sequential chains of the DSE-47609 session.

### Recommended order after round 4 (changes in bold)
1. Handoff in a fresh small context (jev-mcp-be's delegated reading, explicit request only): C13 still needs their numbers.
2. **ui-step is worth adding to the android-cli note (C11 yes, C10 offline yes); test it once on the real emulator first.**
3. **Digest to navigate, shrunk screenshot to confirm visual state: V1 supports the second half.**
4. **Drop the "same turn / one script" instruction (C12 shows no gain on this task).**
5. pdf-text only if PDFs recur.

## Round 4b (2026-10-11, the user approved all four follow-ups): V2, V3, C13, emulator try, commit

### V2: the digest's wrong answers have no separating attribute: FAIL (limit stays "needs a screenshot for visual state")
- The raw layout elements have only class, resource-id, text, content-desc, bounds, center, interactions, state: no alpha, visibility or off-screen attribute. Screen walk4-08: the invisible "Complete!" is a child of the front card with the same keys as its visible siblings, so nothing separates it. Screen walk2-01: a z-order heuristic (an element fully inside a LATER element's bounds is covered) removes exactly the 4 invisible texts and, on all 13 recorded layouts, nothing else; the unlabeled clickable View of that stale card stays. One screen is not enough to adopt it. File: eval/results-r2/V2.json.

### V3: reproduction: PASS except one test that cannot run in this session
- 73 of 74 tests pass; the failing one (replay of the two real PDF Reads) cannot read ~/Downloads from this session ("Operation not permitted", even `ls` fails). The tables print again every number of section 3 of the handoff; the transcript-dependent ones only grew (C4b later reads 24 -> 30; C6 106 -> 112 results). File: eval/results-r2/V3.json.

### C13: NOT done as designed
- The message to jev-mcp-be could not be delivered: that session is not running ("No agent named 'jev-mcp-be' is reachable"). Its memory notes record costs of its reader sessions (for example 18 chunks in one call: 12 KB, 104 s, 0.106 USD; a real 7-chunk session: 155 s) but no saving against reading in the main context, so there is nothing to compare with the 51.8% share. The data to send stays in section 3 of HANDOFF-class-graph-ctx-savers.md.

### Emulator try of ui-step: BLOCKED by the stop rule of EVAL-RULES-3 (no tap was made)
- The VPN check answers 403 (twice) and the public IP is in RO, so the US VPN is off; the app shows "No internet connection" with an OK button (OK is not on the whitelist, left untouched). One read-only call without any action worked on the real device: `ui-step.mjs --shot out.jpg` = 1 layout read, the digest of the dialog (3 elements), a 540x1212 JPEG of 56,863 bytes, 5.8 s in total. Taps, settling after a real tap and the android-cli note edit wait for the VPN.

## Addendum 2026-10-12T04:53:19Z: ui-step on the REAL emulator (written BEFORE the first tap; the user switched the US VPN on)
State at the start (read only): VPN check HTTP 200, IP country US; emulator-5554 on Deals > Rewards, no dialog (the "No internet connection" dialog is gone, nothing was tapped to remove it).
Walk (one ui-step command per step, default settle 1.5 s, timeout 12 s): 1 --tap Home --region bottom; 2 --swipe; 3 --tap "myDG Wallet" --region bottom; 4 --tap List --region bottom; 5 --tap Cart --region bottom; 6 --tap Deals --region bottom --shot <jpg>; 7 --tap Rewards --region top. Then three refusals that must not tap: --tap "Add to cart", --tap Settings, --tap "Send verification email".
Anchors expected in the printed digest: 1 "Search products"; 2 "home_items_recycler_view"; 3 "Order History"; 4 "Shopping List"; 5 "Total" or "Start shopping"; 6 "Explore Deals"; 7 "Activated Rewards" or "Available Rewards".
Gates (all must hold): (a) steps 1-7 exit 0, print "settled" (never "NOT settled") and contain their anchor; (b) the three refusals exit 3 and the screen after them is the same as before (digest of a no-action read identical); (c) the emulator ends on Deals > Rewards; (d) --shot writes a 540 px JPEG. Reported, not gated: wall time and layout reads per step, against the recorded manual steps (tap, sleep 4, layout, capture = 3-4 commands).
Safety: same whitelist and forbidden list as EVAL-RULES-3.md (ui-step enforces them itself); no typing; the password is never read or written. Stop and tell the user at the first non-zero exit, a login / verify / error screen, an intro overlay, a 403 from the VPN check, or a step outside the list. No tap on "OK", "Next", "Remind me next time" or anything not on the whitelist.

## Addendum 2026-10-12T04:53:54Z: the real walk STOPPED at step 1 (a stop rule fired; nothing else was tapped)
Step 1 (--tap Home --region bottom, one whitelisted tap at 107,2340) ended on the app's email-verification screen ("Your email needs to be verified.", buttons "Send verification email" and "Remind me next time"); ui-step stopped itself with exit 3 ("the app shows a login, verify or error screen"), which is the designed behaviour. Steps 2-7 and the refusal checks were NOT run, so gates (a)-(d) are unmet for now, not failed. The addendum above forbids tapping "Remind me next time" in this walk, so the user is asked first (the same screen was handled in round 3 with the user's recorded procedure). The emulator was left on the verification screen. File: eval/results-r2/C10-real.json (stopped: home).

## Addendum 2026-10-12T04:56:05Z: the user dismissed the verification screen themselves ("am apasat eu. esti in home acum"); the walk restarts from step 1
No exception tap is made by the assistant. Same steps, anchors and gates as the addendum above; step 1 now taps Home while the app is already on Home. The result file of the stopped run is overwritten by this run (its content is described above).

## Addendum 2026-10-12T04:57:14Z: defect found by the real walk (written before the fix and the rerun)
First real run after the user's tap: steps 1-6 passed (exit 0, settled, anchor present; wall time 4.6-8.7 s, 2-4 layout reads each), step 7 (--tap Rewards --region top) was refused as "ambiguous (2 elements at [871,320] [870,319])": the tab is a container with content-desc "Rewards" and a text "Rewards" inside it, centers 1 px apart. My ambiguity rule of the C10 design fix (distinct center strings) was too strict; the offline tests used far-apart fixtures and the recorded stand-in screens never had such a pair for the tapped labels. Fix: hits whose centers are within 30 px of the first hit count as the same target; hits farther apart stay ambiguous. A unit test with the real pair is added. The whole walk is rerun from step 1 (it is read-only), so the first run's rows are not kept.

### Result of the real-emulator walk and the note edit (2026-10-12T05:01:22Z)
- Real walk (eval/ui-step-real.mjs, result eval/results-r2/C10-real.json), read-only, 7 steps with --safe: all gates met (a: 7 of 7 steps exit 0, settled, anchor present; b: the 3 refusals exit 3 and the screen is unchanged; c: ends on Deals > Rewards; d: --shot wrote a 540x1212 JPEG). Measured, last run: 2-4 layout reads per step (mean 3), 5.2-9.2 s per step (mean 7.0 s), one command per step against the 3-4 manual commands plus a fixed "sleep 4". The user dismissed the email-verification screen themselves; the assistant made no exception tap. One earlier run stopped at step 1 on that screen (designed behaviour), another at step 7 on the defect below.
- Defect found by the real device and fixed: a tab is a container and a label whose centers are 1 px apart; the ambiguity rule counted them as two. Hits within 30 px of the first hit are now one target (unit tests added).
- Design decision (Jev decide, 4 candidates, pick default_open_safe_flag, confidence 1.00): ui-step as tested refused every label outside the 9 tabs of the QA app, which would break a global note. The CLI default is now open (any exact label; no stop on login / verify / error screens, because a login screen is something the model must see); --safe restores the whitelist, the forbidden list and the stop texts; the evaluation walk and the CLI tests pass --safe. 54 offline tests pass (51 + 3 open-mode tests).
- The note: ~/.claude/skills/android-cli/references/interact.md got the one tested line at the end (backup interact.md.bak-20261012T050111Z next to it); the three scripts (ui-step.mjs, ui-digest.mjs, img-shrink.mjs) were copied to ~/.claude/skills/android-cli/scripts/ and ui-step ran from there on the emulator (no action, read only). The copies are NOT linked to the worktree: a later change to ui-step.mjs here must be copied again. C11 tested the line with the safe default and a /tmp path; the open default and the ~ path are untested with a model.
- Not changed, but seen: the note still advises "layout --diff", which is a deprecated no-op in the installed CLI (android 1.0.16500706).

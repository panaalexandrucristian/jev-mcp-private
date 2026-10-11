# Round 2: the same principle on the updated transcript

Written 2026-10-11T19:10:30Z BEFORE any round-2 run. Round 1 (EVAL-RULES.md, eval/results/) stays as it was.

Transcript: the same session file (7a484193-...), now updated: last entry 2026-10-11T19:08:38Z, 1,167 entries, active chain 89 tool results,
text 239,508 chars, media 3,567,480 chars. New in it since round 1: the user's work after 18:15 (emulator, 10 screenshots, commit, review script, retouches) and, from
19:05, a handoff request that loaded the handoff-verify skill (22k-char body, a 27,298-char reference Read, prepare.py output 8,585 chars) and a /context report.
Measured fact from that report (19:05:08): context 257.6k tokens, Messages 226.8k (88%), Skills 9.9k (jev:class-graph ~270, jev:handoff-verify ~220).
Calibration: the listing entry of class-graph is 813 chars = ~270 tokens, so prose here is ~3 chars/token, not 4; "estimate" below uses 3.2.
My own tally of the active chain up to that report: text-like blocks 298,613 chars (~93k tokens), thinking signatures 147,228 chars, 10 images, 2 PDFs;
the rest of the 226.8k is probably retained thinking (INFERENCE, not measured; no script here touches it).

## A. Re-run on the new transcript (same scripts, same gates as round 1, as-of values)
C1 pdf-text, C2 diff-map, C3 search-digest, C4 md-outline, C6 duplicate guard, C7 img-shrink (sizes), C5 static size. Results go to eval/results-r2/.
C5's Haiku battery is NOT repeated (gate already failed; the new transcript brings no new evidence on it).

## B. Token measurements with the session's own model
Round 1 measured tokens with Haiku. The session runs claude-sonnet-5-5. Repeat the C1 and C7 token sessions with --model sonnet (same confinement, same prompts,
baseline session included). Gate wording of round 1 is kept but judged on the per-file increment over the baseline (the disclosed correction); the as-written
whole-context number is also printed. The Haiku numbers stay in the report for comparison.

## C. New replay target from the new phase
C4 md-outline on the 27,298-char reference the handoff skill made the model Read (reference/jev-and-au...). Same gates as C4 (headings 100%, output <= 15%, break-even);
usage heuristic as in round 1 (identifiers of a section that reappear in later calls). The skill body (22k) is not a tool result and is not replayed.

## D. New candidates from the patterns found after round 1
| id | candidate | replayed case | gate (all must hold) |
|----|-----------|---------------|----------------------|
| C8 | ui-digest: the app windows of "android layout" JSON as one line per element (class, label, center, actions), system windows dropped | the real "android layout --flat" output of 18:26:12 (login screen), 3,370 chars | every app element that has a text, a description, an id or an action is listed (recall 100%); output <= 30% of the raw JSON; MEASURED (Sonnet, confined, one session each): the digest inline costs <= 50% of the tokens of the screenshot of the same screen (increment over the baseline), and the answers to 3 questions (screen title, button labels, where to tap to sign in) agree with the screenshot answers in >= 2 of 3. Limit stated in advance: ONE screen (a WebView login), dense native screens are untested. |
| C9 | callers coverage: can a multi-target class-graph/find-usages run replace the model's batched rg lookups (2-4 labelled searches in one command, 18:44-18:45)? | every labelled section of the batched rg commands after 18:30 | FIRST a coverage test, no script: classify each section as in scope (users/callers of a named class or top-level function, users of a named member, definition of a named function) or out of scope (literal text, local variable, multi-name regex, XML). Build a prototype only if >= 70% of the sections are in scope; then gate: recall of call-site lines of the in-scope sections >= 90% against the rg output of the same state, output <= 60% of the rg output. |

Ranking rule at the end: as in round 1 (only candidates that pass the whole gate are recommended; rank by verified saving; tokens only where measured).
Limits stated in advance: one session, one user; the transcript is still being written, so every number is "as of" its run time; Sonnet measures cost one model's tokenizer only.

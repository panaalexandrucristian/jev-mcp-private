# Context-saver candidates: evaluation rules

Written 2026-10-11T18:44:40Z BEFORE any candidate was run on the transcript.

Case: session "DSE-47609" (transcript 7a484193-91fd-4c2d-9333-9d1585869838.jsonl), the ACTIVE chain after the user's rewinds
(abandoned branches are counted only where a rule says so). One session, one user: every result is an observation about this
transcript, not a rate. Sizes are characters of the tool result the model received; tokens are chars/4 (ESTIMATE) except where a
rule says "measured" (Haiku sessions, usage fields).

Common numbers per candidate: R = chars the model actually received for the replayed call; O = chars the candidate prints for the same case;
reduction = 1 - O/R. "Negligible" = the saving in this transcript is under 2,000 chars.

| id | candidate | replayed call | gate (all must hold to be "recommended") |
|----|-----------|---------------|-------------------------------------------|
| C1 | pdf-text (PDF to compact text, images flagged) | the 2 PDF Reads, R = 446,814 stored chars | text retention vs the model's own pypdf extraction in the transcript >= 0.97 (token-set overlap, both directions); O <= 5% of R; MEASURED with 2 Haiku sessions each (Read PDF vs run the script): input-side tokens fall >= 25% and both answers state the same ticket facts; images reported, not silently dropped; works without a library the plugin does not ship, or says so (a missing library is a gate failure for bundling) |
| C2 | diff-map (changed files and functions with exact ranges, from find-def) | git diff --stat && git diff, R = 10,750 | recall 100% (every changed file and every changed new-side line of the original diff lies in a listed range); O <= 25% of R; net-cost test: B = chars of the bodies of the touched functions; break-even f* = (R-O)/B; "navigation only, not a saver" if f* < 0.5 |
| C3 | search-digest (several names, grouped, declarations kept) | the rg of 3 names, R = 8,984 | recall 100% of (file,line,name) triples of the raw rg output with the same regex and directory; O <= 60% of R; report what is NOT kept (snippet text) |
| C4 | md-outline (headings, line ranges, section sizes) | Read of the handoff note, R = 12,243 | every heading present with the right line range; O <= 15% of R; break-even k* = how many of the sections the model may open before outline + sections exceeds R |
| C5 | slim SKILL.md (find-usages + find-def sections moved to a reference file read on demand) | the 13.8k-char skill body loaded twice | static saving >= 4,000 chars per load; MEASURED Haiku battery: routing R1-R6 passes 6/6, probes pB pD pF pP pS pass exactly as the reference does, class-graph-only sessions (R1, pV) cost no more than the reference + max(0.0005 USD, 5%), find-def/find-usages probes cost <= +10% |
| C6 | duplicate-read guard (measurement only) | all tool results of the active chain | worth building only if identical results returned again are >= 10% of the text results on the ACTIVE chain |

Ranking at the end: only candidates that pass their whole gate are "recommended"; among them rank by the verified saving in this
transcript (chars; tokens only where measured). A candidate that fails a gate is reported with the failing rule. Gate flaws found
after seeing results are fixed for all candidates and disclosed.
Safety: no test session reads the user's real files; the PDFs are copied to a scratch folder and the sessions are path-scoped.

## Addendum 2026-10-11T18:46:33Z (before C7 or anything else was run)
The transcript kept growing while this was prepared (last entry 18:44:49 UTC): the active chain now holds 66 tool results, 165,151 text chars
and 3,567,480 media chars. The four replayed calls (2 PDF Reads 18:09:54, git diff 18:10:07, note Read 18:09:58, rg 18:10:19) are unchanged;
all totals are reported "as of" the moment the evaluation ran. New fact: from 18:24 the session read 10 emulator screenshots
(1080x2424 PNG, 148k-644k stored chars each, 3.1M in total), far more stored media than the PDFs. Stored chars are NOT tokens for images
(Read recompresses them), so C7 is judged by MEASURED tokens only.

| C7 | img-shrink (screenshot to smaller JPEG, optional crop) | the 10 screenshot Reads | works with tools present on the machine (macOS sips) and says so otherwise; MEASURED with Haiku (2 screenshots x full vs shrunk, 1 session each): context length at the last call falls >= 25%; the 3 factual questions about the screen get the same answers from the shrunk image as from the full one in >= 2 of 3 per screenshot (ground truth unknown: agreement with the full-size answer is the test, so a systematic misreading would not be caught - stated as a limit) |

C1 and C7 token measurement: the number is the context length at the LAST model call of the session (input_tokens + cache_creation + cache_read of the
final assistant message), which isolates what the Read added; sessions are path-scoped (Read of the scratch folder only, dontAsk), files are copies.

## Addendum 2 2026-10-11T18:55:20Z (after the first C5 attempt, before its rerun)
First C5 attempt (slim variant, harness as before): routing stopped at R2 (find-usages): 10 calls and 5 refusals against 3 calls for the reference.
Cause, read from the transcript of the session: the harness option --restricted confines file tools to the session folder and the project, so the Read of
reference/find-tools.md in the plugin folder was refused ("outside ... --restricted confines the file tools"), and a sed on it as well; the model then improvised with --help.
That is a harness limit, not a property of the variant (real sessions read a skill's own reference files from the plugin cache). Fix: the plugin folder is added as a
readable directory (ADD_PLUGIN_DIR=1) for the SLIM rerun; the reference arm needs no reading of that folder, so its results (c5ref, r6rt, r6cB) stand.
The first attempt is reported. C5 gates unchanged; the decision uses the rerun.
Also stale: probe pD still tests "says the list may be cut", which the paging rule of round 4 made obsolete; the reference fails it too, so pD is compared as "same result as the reference".
Token gates C1/C7: the baseline session without any file costs 7,840 tokens of fixed context; the gate "context falls >= 25%" diluted every per-file saving. Both numbers are reported,
the decision uses the per-file increment over that baseline (C1 passes either way).

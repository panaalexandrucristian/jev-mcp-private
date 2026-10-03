# Results

Sanitized summaries of the jev-control campaign rounds: `Rxx/summary.md` and `Rxx/metrics.json` (counts, ids, hashes; never raw transcripts, code or Jev payloads), written with `../measure.mjs`. Each round records the base commit, the versions in use, the fixture and oracle hashes, the session ledger lines it used and the provenance of every figure. A round without live sessions reports its live metrics as `"unmeasured"` (never reused from another round, never 0).

`T2/` is the build round: offline checks only, no live session.

`R01/` is the first live round: one Sonnet baseline session (S1) of the planned two; S2 was held back because the isolation check of S1 found ambient configuration that D28 did not anticipate (see its summary).

`R02/` is the second live round (D30-D32): two clean baselines (S1, S2) and two dev sessions (S1, S2) with the activation text of D31, ledger lines 2-5. `R01/`'s S1 is a pilot with the claude.ai connectors loaded and is not comparable for tokens; dev sessions are compared only with the clean baselines of R02.

`R03/` is the third live round: two dev sessions on S3 (ledger lines 6-7, 7/20 used). S3 has no clean baseline, so its token comparison is `unmeasured`. It found that `Skill jev:jev-control` returns the same-named command and never `SKILL.md`, and one dev session (b) ended with the mode off and the task unanswered; the fix is offline only.

`R04/` is the fourth live round: dev S2 (ledger 8) and the dev S3 regression of the R03 failure (ledger 9), 9/20 used. The R03 fix worked as an activation (`on` ran first in both sessions, the Skill tool was not used) but `SKILL.md` was unreadable in both (a `Read` outside the working directory is refused in this configuration); S3 was answered exactly, S2 was not done: the model learned the `decide` batch format by trial and error (seven invalid results), asked which task goes first, got a top score of 0.93-0.94 and stopped. The fix is offline only: `cli.mjs help [command]` / `--help` print the batch format and the search form, and the activation text names them.

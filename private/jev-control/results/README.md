# Results

Sanitized summaries of the jev-control campaign rounds: `Rxx/summary.md` and `Rxx/metrics.json` (counts, ids, hashes; never raw transcripts, code or Jev payloads), written with `../measure.mjs`. Each round records the base commit, the versions in use, the fixture and oracle hashes, the session ledger lines it used and the provenance of every figure. A round without live sessions reports its live metrics as `"unmeasured"` (never reused from another round, never 0).

`T2/` is the build round: offline checks only, no live session.

`R01/` is the first live round: one Sonnet baseline session (S1) of the planned two; S2 was held back because the isolation check of S1 found ambient configuration that D28 did not anticipate (see its summary).

`R02/` is the second live round (D30-D32): two clean baselines (S1, S2) and two dev sessions (S1, S2) with the activation text of D31, ledger lines 2-5. `R01/`'s S1 is a pilot with the claude.ai connectors loaded and is not comparable for tokens; dev sessions are compared only with the clean baselines of R02.

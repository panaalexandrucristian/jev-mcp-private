# Results

Sanitized summaries of the jev-control campaign rounds: `Rxx/summary.md` and `Rxx/metrics.json` (counts, ids, hashes; never raw transcripts, code or Jev payloads), written with `../measure.mjs`. Each round records the base commit, the versions in use, the fixture and oracle hashes, the session ledger lines it used and the provenance of every figure. A round without live sessions reports its live metrics as `"unmeasured"` (never reused from another round, never 0).

`T2/` is the build round: offline checks only, no live session.

`R01/` is the first live round: one Sonnet baseline session (S1) of the planned two; S2 was held back because the isolation check of S1 found ambient configuration that D28 did not anticipate (see its summary).

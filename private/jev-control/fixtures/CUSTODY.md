# Fixture custody

- **Dev scenarios** (`scenarios.mjs`, S1–S4) are used in R01–R09. Their oracles are fixed
  before the first run; `oracle-hashes.json` records a hash of each scenario *including the
  oracle's source*, and `node seal.mjs verify` (also run by the offline tests) fails when one
  of them changes. A deliberate change means rewriting the hash file in the same commit and
  saying why.
- **Final scenarios** (`final-scenarios.mjs`, F1–F2) are sealed: written before the campaign,
  their hashes committed in `sealed.json`, never run in a live session, never used to tune the
  control, and never adjusted after the results of R10. They are only checked offline for
  validity (the oracle fails on the pristine repository and passes on the reference
  solution) and for the recorded hash. Unused reserve sessions are added to R10 (final 2–4).
- The sealing proves that the files did not change after the hash was committed. It does
  not prove that the author of the fixtures did not know how they are built: the author did.
- Each session runs in a disposable copy (`materialize()`), never in the real jev-mcp.
- Results are summarized (counts, ids, hashes) under `../results/`; raw transcripts are not committed.

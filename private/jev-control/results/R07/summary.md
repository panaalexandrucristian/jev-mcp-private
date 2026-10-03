# R07 — completion path (offline round)

**No live session was started in R07** (ledger 13/20 before and after, no lock). The two gate sessions planned for R07 (D36) were run at the start of R08 under the user's D39 (see below); nothing in this file is a live result, and every live metric is `"unmeasured"`.

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin version 0.7.0 (unchanged), Node v22.23.1, Claude Code 2.1.288 (`claude plugin validate .`).

## Why a code change before the sessions (D37, D38)

`/jev:jev-done` had never run in a campaign session. Its documented claims file lives in `/tmp`; in the headless sessions a Write outside the working directory and a heredoc with braces and quotes were refused (R05, R06), so the gate looked unreachable. An inline JSON on the command line is avoided for the same risk; it was never tried live. A claims file left in the repository would itself be part of the diff the gate judges. D37 allowed a minimal offline fix with regression tests, ratified by the council before any session; D38 limited the surface to `private/jev-control/`, `skills/jev-control/`, `commands/jev-control.md` and the "jev-control branch" paragraph of `commands/jev-done.md`. The protected paths (`src/`, `skills/jev`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `test/`, `skills/handoff-verify`, `opencode-plugin.js`) are untouched (diff against the base: empty); `private/jev-flow/`, `scripts/`, `agents/` and `PRIVATE.md` were not edited in this round.

## What changed (commits `e57cd85`, `bdbf7fe`, `d61b652` (adds this file) and the round-4 commit)

- `done --claims jev-claims*.json` CONSUMES a claims file written in the repository root: the helper reads it, validates it and its checks, and removes it before the gate takes its snapshot; the result carries `claims_removed` and `claims_sha256` (removal is not acceptance). New `claimsfile.mjs`; `help done` (1031 bytes); `SKILL.md` and the jev-control paragraph of `jev-done.md` give the recipe.
- A file is consumed only when all hold: a plain relative name (`^jev-claims[A-Za-z0-9_.-]*\.json$`, at most 120 bytes), run from the repository root, the root holds an entry with exactly that name (case included), a regular file of at most 1 MiB, not tracked (also not under another case), not ignored, git able to say so, and the same file (inode, device, size, sha256) when it is removed. A file really outside the work tree and `-` are read as before and never removed. Every refusal leaves the file alone and never echoes the input.
- Every check (`--check` flags first, then the file's) is validated, with the combined limit of 8, before the removal; every handled return of `done` is a JSON report and, after a consumption, names the file; an unexpected error after the removal prints a fixed error line with the removal and never an acceptance.
- `measure.mjs`: a claims Write is helper input, not an edit, only when the transcript proves the whole chain (see `coverage.protocol_claims_files` and `protocol_claims_removals`; they are 0 on the R06 transcripts, whose other numbers re-measure byte-identically).

## Defects found by the council in the offline review (all fixed)

| Round | Finding | Fix |
| --- | --- | --- |
| 1 (A) | On a case-insensitive file system (macOS) `jev-claims.json` reached a TRACKED `Jev-Claims.json`: the exact-name `git ls-files` did not list it and the helper deleted it (reproduced) | the root must hold exactly that name; the index is also searched with `:(icase,literal)`; tests fail on `e57cd85` |
| 1 (B) | an invalid `--check` was validated after the removal and printed an empty line; an absolute path and a `checks_failed` report were accepted by the measurer; error messages echoed input keys; the docs called an inline JSON "refused" | checks validated before the removal; JSON line on every handled path; only the plain name counts; a pre-gate refusal is the only harmless one; fixed messages; wording "avoided for the same risk (it was never tried)" |
| 3 (B) | `coherentReport` accepted `snapshot_changed` with exit 2 and unknown outcomes by exclusion | an explicit list of the runner's real not-accepted outcomes with the fields each implies |
| 4 (B) | `checks_failed` without a verdict or with an unknown one, and `contradicted` without a status or with an unknown one, still got the exemption; the summary described the `is_error` rule wrongly | presence and domain of `status` and `verdict` (the runner's `STATUS_ORDER`, `VERDICT_ORDER`, explicit `null` allowed) checked first; the documentation says the plan refused `is_error` |

## The `is_error` policy (a later adjustment, not the plan's rule)

The plan (R07-c2) refused the exemption for any result that is an error. Allowing a coherent not-accepted report with exit 2 is a LATER adjustment, proposed by the council (B) and applied by C, subject to the council's ratification; it is not the plan's rule and not a narrowing of a permission the plan gave. A consumption is proven by the helper's report only when the report is complete, its fields are in the runner's domains (`status` in `ok`, `unavailable`, `checks_failed`, `snapshot_changed`; `verdict` one of `accepted`, `needs_evidence`, `ask_user`, `escalate`, `contradicted`, or an explicit `null`; an absent field is not `null`) and they agree with how the call ended: (i) not an error, outcome `accepted`, exit 0, verdict `accepted`, status `ok`; or (ii) an error whose text starts with `Exit code 2`, report exit 2, and one of the runner's not-accepted outcomes with its implied fields (`needs_evidence`, `ask_user`, `escalate`: verdict equal to the outcome and status `ok`; `contradicted`: verdict `contradicted`, any status of the runner's domain; `checks_failed`: status `checks_failed`, verdict `null` or any known verdict except `contradicted`). `snapshot_changed` (exit 4), `unavailable`, `disabled`, `invalid_input`, `not_ready`, an unknown outcome, an accepted report that is an error, a not-accepted report that is not, a text/report exit mismatch, or a missing or unknown `status` or `verdict` prove nothing: the Write then stays an edit (the conservative direction).

## Offline verification (this round, at the round-3 commit)

| Check | Result |
| --- | --- |
| `node --test private/jev-control/test/` | 505 tests, 84 suites, 505 pass (495 at `e57cd85`, 465 before R07); the round-4 cases are assertions inside existing tests |
| `node --test private/jev-flow/test/` | 324 pass |
| `claude plugin validate .` | passed |
| `seal.mjs verify` | ok |
| `git diff --check`, protected-path diff, secret grep | clean, empty, none |
| `help decide` / `help done` | 1499 / 1031 bytes (limit 1500) |

New tests fail on the previous code (10 on `e57cd85` after round 1; the measurer regressions of rounds 3 and 4 fail on the commit before them). About 55 guard mutations before round 1, 17 on the round-1 fixes and 11 on `coherentReport` were run; every survivor was fixed by a test or a removed redundant guard.

## Not measured, not verified

- Everything live: whether the headless permission layer accepts `node …/cli.mjs done --claims jev-claims.json` and a Write of `jev-claims.json` in the root, whether the model reaches `done` at all, and the effect on tokens, are **unmeasured**. The helper was not run under the real headless permissions.
- The `cleanup` line of R06 on live data is still unmeasured.
- No claim of saving or conformance is made for any session.

## D39: where the R07 sessions run (corrected in R08, D41)

Ratification ends a council task, so a "Phase 2 after ratification" cannot run inside R07. At the end of R07 the orchestrator proposed, with a `jev_decide` of 0.98, that the two gate sessions run at the START of R08 and that R08 "may run up to 4 sessions". **That proposal was withdrawn: it was never an answer of the user** (the user's answers are D1-D38 for R07). The user's own D39 (R08, `jev_decide` 0.97) replaced it: R08 runs EXACTLY 2 sessions, both on revision `86e8497`, strictly sequentially, dev S1 at the default 0.95, then dev S2 at 0.90 via `run-session.mjs launch --threshold 0.90` (the D36 exception extended explicitly to that one R08 session; D31 prompt unchanged; D35 stays valid), and these two sessions are at once the live measurement of the R07 gate and R08's composed regression and token comparison; the offline fix of R08 comes after both. Their results are in `results/R08` under the heading «R07 gate sessions (run in R08 per D39)». The budget that counts is the ledger and `cap.txt` read at launch.

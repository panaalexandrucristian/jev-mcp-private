# Evaluation

## What is measured (D17), in this order

1. **Eliminators:** the correct task result (from the fixture's oracle, never from Jev's confidence) and **no action below the threshold without a recorded approval**.
2. The share of observable decision events linked to a Jev call: `covered / (covered + uncovered)`, with numerator, denominator, exceptions (a path the user named, protocol commands) and unclassifiable events reported. Choices made internally and never visible are declared unmeasurable; a missing log never turns an action into an exception.
3. Threshold and ordering compliance (plans against their scores; tie-breaks; actions after a stop). The order in which actions were executed carries no option id in the transcript, so it is reported "unmeasurable" in v0.
4. **Orchestrator tokens** from the transcript's `usage`: input, output, cache_read and cache_creation, per unique message, reported separately and against the baseline; subagent usage and Jev usage kept apart; a missing field is `unknown`, never 0. `claude -p` stream totals are kept as `reported_total`, never added again.
5. Jev latency and cost; MCP attempts per source; provider calls `unknown`.

No numeric targets are fixed; trends per round are reported with `n`. A round without live sessions reports its live metrics as "unmeasured" (never reused). Early stops are not sold as savings at equal correctness.

## Tools

`node private/jev-control/measure.mjs --transcript <file> [--threshold x] [--baseline <file>] [--out dir]` writes `metrics.json` and `summary.md` (counts and ids only). `private/jev-control/run-session.mjs` launches campaign sessions one at a time, detached (launcher → worker in its own session → wrapper in its own process group), with `--model sonnet`, `--max-turns 40`, a 20-minute limit and a stop after 5 minutes without log progress; it refuses to start with a full ledger or a running session and, outside the offline tests, only through the authorized budget wrapper and `JEV_CONTROL_LIVE=1`.

## Campaign (20 Sonnet sessions, nothing live in T2)

| Round | Sessions | Content |
| --- | --- | --- |
| R01 | 2 baseline | no skill, no flow: S1 (bug) and S2 (ordered tasks); validates measurement and oracles |
| R02 | 2 dev | same tasks as the baseline; the first dev session also confirms live activation and slash/plugin integration |
| R03 | 2 dev | S3 ambiguous search, file selection |
| R04 | 2 dev | S2 ordering with dependencies, one regression |
| R05 | 2 dev | S4 stop/ask and a configured threshold |
| R06 | 2 dev | compact helper and delegation, one regression |
| R07 | 2 dev | completion/gate |
| R08 | 2 dev | composed regression and token comparison on comparable tasks |
| R09 | 0 | offline consolidation and freeze; live metrics "unmeasured" |
| R10 | 2 sealed (+ unused reserve, up to 4) | F1, F2 sealed; no adjustment after unsealing |

2 baseline + 14 dev + 2 sealed + 2 reserve = 20. The reserve re-runs failed or lost sessions only; unused reserve joins R10. Each session: `--model sonnet`, `--max-turns 40`, 20 minutes, a failed or timed-out session counts, subagents are not sessions. Scenarios and oracles are in `private/jev-control/fixtures/` (see `CUSTODY.md`); sealed finals are hashed in `sealed.json`.

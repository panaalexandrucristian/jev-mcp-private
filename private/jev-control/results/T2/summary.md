# T2 — build and offline tests

**No live session was started** (ledger 0/20 before and after). Everything below was checked offline against a fake stdio MCP server and fixture payloads; none of it is live Claude Code behavior.

| Check | Result |
| --- | --- |
| `node --test private/jev-flow/test/` | 324 tests, 61 suites, 324 pass, exit 0 |
| `node --test private/jev-control/test/` | 209 tests, 49 suites, 209 pass, exit 0 |
| `claude plugin validate .` (Claude Code 2.1.288) | passed, exit 0 |
| `node private/jev-control/fixtures/seal.mjs verify` | ok (dev oracle hashes and sealed final hashes recorded) |
| `git diff --check` | clean |

Base commit `879c2ba032c8b3779862e696e33653504e818265`, branch `jev-control-skill`, plugin version 0.7.0, Node v22.23.1.

## What the offline tests cover

Threshold boundaries (0.95 rejected, 0.951 accepted; 0.5, 1, 0, −1, NaN, abc invalid; precedence; prospective change); option batches (≥ 5, ≤ 20, evidence lines, escape-hatch id collisions, duplicates); the decision protocol (independent `jev_noul` scores, strict eligibility, ordering, successive tie-breaks, a gap of exactly 0.02, shortlist > 6 with a rerank tie on the boundary, expansion rounds, headless `Incomplete:`, control options, unavailability, budget stop, metadata-only log); the shared budget (per source, reserved before each send, retry at the limit, 24/25/26, concurrent processes); file search (rerank/find rules, two logical evaluations, no lexical fallback, exact path, widening, opt-out); completion at the session threshold (strict `>`, T below 0.8, multipart, checks, budget); session state, identity, binding, locking, retention; the hook (reminder, new request, compaction, startup reset, flow standing down, data guard kept); receipts (replay, forgery, stale, planned-to-execute); transcript measuring (usage de-duplication, unknown ≠ 0, coverage, threshold violations); the campaign runner with a simulated executable (sequential, detached, timeout, no progress); the fixtures (oracle fails on the pristine repository, passes on the reference solution; hashes); the seven examples replayed through the real protocol; manifests, scope and the absence of any real `claude` process spawn.

## Not measured, not verified

All live metrics (correctness, decision coverage, threshold and ordering compliance in a real session, orchestrator tokens, Jev latency and cost) are **unmeasured**; provider calls inside the server are **unknown**. Not verified outside the offline tests (to be confirmed in R02): `CLAUDE_CODE_SESSION_ID` in the Bash tool, the raw slash-command text in the prompt hook, `agent_id` in a subagent hook payload, `/jev:jev-control` in `claude -p`, `--plugin-dir` with an installed `jev` plugin, the real server's tool schemas and the handshake latency (the contracts were checked against the sources in `src/`, not against a running server).

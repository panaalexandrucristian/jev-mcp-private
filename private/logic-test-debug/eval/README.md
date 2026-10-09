# Live-test material for logic-test-debug (no session has been run)

This folder holds what a live test of the skill needs, built and checked offline. Nothing here starts a model session.

- `../test/fixtures/` - the three visible fixtures an agent works on (activation, conditions, bug), each a tiny Node 22 project.
- `prompts.json` - the frozen prompts, including the four non-code prompts. `fixtures.lock.json` freezes every fixture file, the prompts and the protected helpers; `node freeze.mjs` rewrites it and must not be run after the first live start.
- `oracles/` - the hidden oracles. They are run by `lib/evaluate.mjs` in a separate process, after the session, from outside the workspace, and are never copied into a workspace (`lib/workspace.mjs` audits for that).
- `reference/` - correct solutions and known-wrong variants (including two harmless rewrites of a protected helper) used only to test the oracles.
- `lib/transcript.mjs` - scores a stream-json transcript: loaded (a successful `Skill` call for logic-test-debug or a successful read of its SKILL.md), not loaded (a complete transcript with neither), or unknown (an incomplete one); the Scope/Method/Result record counts as application, never as loading.
- `lib/stats.mjs` - the exact two-sided Fisher test; an effect is claimed only for p below 0.05.
- `lib/ledger.mjs`, `lib/budget.mjs`, `budget.json` and `session-budget.mjs` - session accounting. Every start is a ledger line; the cap (50, prior use 0, chosen with `jev_decide` after the user delegated it), the planned runs per scenario and arm (8, 16, 16, 4), the reserve (6) and the USD guard (5, guessed) are enforced when a session is started. A live session may be started only after `node session-budget.mjs start ...` printed its id; `finish` records the outcome and cost. The cap is a plain number in `budget.json` that the user can change.

Status labels: the 136 and 17 scored cases, the fixtures and the pair-coverage property are checked by `node --test private/logic-test-debug/test/`. The answer check of the activation oracle and the transcript's unsupported-check flag are heuristics (guessed, not measured). The `result` event of the stream-json output is not yet confirmed on this CLI version.

---
description: Delegate a code-location question to the read-only jev-locator subagent and get compact, hash-checked locations back.
argument-hint: <behavior or code you are looking for>
---

Locate the code for this question with the **jev-locator** subagent:

$ARGUMENTS

Rules for this delegation:

1. Start exactly one jev-locator for this question, in the background when the CLI allows it (Claude Code: `run_in_background: true` on the Agent/Task call; OpenCode: a background subagent call if supported). While it runs, continue independent work (files already known, reproduction, planning the checks), but do not explore the same question in this thread. Do not pass a `model` yourself: the plugin configures the locator's model (haiku in Claude Code; `JEV_FLOW_LOCATOR_MODEL` overrides it).
2. Pass it only: the question above, the repository root (the current working directory's git top level), the priorities that matter for the answer, and any locations already known. Do not pass this conversation's history.
3. Budgets the locator must respect: at most two semantically different candidate batches, at most 48 candidates per batch, each at most 1,000 characters; its report has at most 5 hits and 4,000 characters.
4. When the report arrives, **read only the returned ranges** (`path` + `lines`, with Read `offset`/`limit`; up to 40 lines around them). Do not read the whole file or re-grep the same area: the locator already did that work, and the plugin hints each time a read or grep repeats it. Before editing a file, confirm its current sha256 matches the reported `sha256` (for example `shasum -a 256 <path>`). If it differs, the location is stale: re-read or locate again.
5. The ranking rule is applied mechanically by the locator's helper: more than 3 candidates or candidates from 2+ files → the helper itself runs `jev_rerank` with `top_k: 5` (`jev_find` when the question asks for one definitive location) and hands the locator only up to 5 compact ranked hits (lexical order, marked as not semantically ranked, when Jev is unavailable); the locator has no Jev tool and never composes rerank arguments; an exact path or whole-token symbol found in one file → plain read, kept only if reading confirms it answers the question (otherwise the helper's `--fallback` ranking). The report states `jev_used` and why.
6. `coverage_complete: false` means the candidates were a partial, lexical preselection. Do not treat "not found" as proof of absence in the repository.
7. If the repo's `.jev-flow-denylist` disables Jev, the locator works from local reads only; report that Jev was not used.

**jev-control branch.** If `jev-control` is on for this session (`node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" status` prints `"mode":"on"`), the locator follows the control search rules instead of the helper's few-candidates shortcuts: `jev_rerank` always decides eligibility over several files (relevance strictly above the session threshold), `jev_find` only for one location (winner and `exists` both strictly above it), at most 2 logical evaluations, no exact-match "plain read" and no lexical fallback; an exact path you name yourself is read directly. Its Jev calls count in the shared budget of 25 per request. Without the control mode, ignore this paragraph.

Then continue the task with the jev-flow route (see the `jev-flow` skill), or, with the control mode on, with the `jev-control` skill.

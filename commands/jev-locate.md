---
description: Delegate a code-location question to the read-only jev-locator subagent and get compact, hash-checked locations back.
argument-hint: <behavior or code you are looking for>
---

Locate the code for this question with the **jev-locator** subagent:

$ARGUMENTS

Rules for this delegation:

1. Start exactly one jev-locator for this question. Do not explore the same question in parallel in this thread. Do not pass a `model` yourself: the plugin configures the locator's model (haiku in Claude Code; `JEV_FLOW_LOCATOR_MODEL` overrides it).
2. Pass it only: the question above, the repository root (the current working directory's git top level), the priorities that matter for the answer, and any locations already known. Do not pass this conversation's history.
3. Budgets the locator must respect: at most two semantically different candidate batches, at most 48 candidates per batch, each at most 1,000 characters; its report has at most 5 hits and 4,000 characters.
4. When the report arrives, read only the returned ranges (`path` + `lines`). Before editing a file, confirm its current sha256 matches the reported `sha256` (for example `shasum -a 256 <path>`). If it differs, the location is stale: re-read or locate again.
5. The locator follows the helper's ranking rule: an exact path or whole-token symbol found in one file → plain read, kept only if reading confirms it answers the question (otherwise the threshold rule below); more than 3 candidates or candidates from 2+ files → `jev_rerank` with `top_k: 5` (`jev_find` only when the question asks for one definitive location); its report states `jev_used` and why.
6. `coverage_complete: false` means the candidates were a partial, lexical preselection. Do not treat "not found" as proof of absence in the repository.
7. If the repo's `.jev-flow-denylist` disables Jev, the locator works from local reads only; report that Jev was not used.

Then continue the task with the jev-flow route (see the `jev-flow` skill).

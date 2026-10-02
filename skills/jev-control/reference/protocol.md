# jev-control protocol

The contract of the mode. Everything here is implemented by `private/jev-control/` and covered by the offline tests in `private/jev-control/test/`; nothing in this file claims a live measurement.

## Threshold

- `T` is a number strictly between 0.5 and 1. Precedence: the session value (`/jev:jev-control on <x>` or `threshold <x>`) > `JEV_CONTROL_THRESHOLD` (the default of new sessions) > `0.95`. A value that is not a finite number in (0.5, 1) gives `0.95` plus one notice (it does not fall through to the other source).
- Always **strict**: `p > T` on the raw number the tool returned. `0.95` does not pass at `T = 0.95`; `0.951` does. The labels of a tool (`likely`, `auto`, `action`, `decision`) mean `>=`, can be `true` for a proposition judged *unlikely*, and are never the criterion.
- `auto_accept = T` is sent wherever the tool's schema has it (`jev_noul`, `jev_verify`, `jev_gate`, `jev_review`, `jev_classify`, `jev_compare`, `jev_extract`); `jev_decide`, `jev_find` and `jev_rerank` have no such parameter and receive none. Other indicators (`minimum_margin`, `subject_at`, `composite_floor`, `review_at`, the `screen` and `audit` thresholds) keep the tool's own values.
- A change applies to **later** decisions; every logged decision keeps the threshold it was taken with.

## Batch (the file you give `decide`)

```json
{
  "decision": "Which module should hold the fix?",
  "kind": "approach",
  "priorities": "optional one-line override of the session priorities",
  "space_small": false,
  "new_material": "only on an expansion round: what is new",
  "options": [
    {"id": "opt_a", "text": "Fix the bound in clamp.mjs", "evidence": ["clamp.mjs:3 uses < instead of <="]}
  ]
}
```

- `kind` is one of `order | approach | command | edit | delegate | ask | done`. **`order` runs every eligible option in order; every other kind is exclusive: only the first runs and the rest are ordered reserves.**
- At least 5 distinct real options when that many alternatives exist, at most 20 including the control options; `evidence` has 1–3 concrete lines per option; ids are lowercase slugs. `ask_user`, `investigate` and `none` are `jev_decide`'s escape hatches and are **refused as option ids**; the control options are `action_gather_evidence` and `action_ask_user`. They are always added and take part in the selection like any other option, but are never triggered just because they score above `T`.
- Duplicates (the same text) are merged, keeping the first id and up to three evidence lines.

## Scoring, eligibility, ordering

1. One `jev_noul` call: one atomic proposition per option ("taking option X is the right next step for this decision …"), the evidence lines and the priorities as context, `auto_accept = T`. The result is bound to the options by position and content hash; a missing or malformed probability is an invalid answer, never a score.
2. **Eligible = probability strictly above `T`**, ordered by that probability (ties keep input order).
3. **Tie-break (D20).** A group needs a tie-break when its members are within **0.02** of the group's top score (a gap of exactly 0.02 is *not* a tie) or, for exclusive kinds, whenever two or more options are eligible. The helper runs `jev_decide` over the group (2–6 candidates) and accepts the pick only if `confidence > T`, no escape hatch was chosen and there are no warnings. For `order`, the winner is removed and the step repeats **only while a tie remains**; the rest follow in score order.
4. **More than six in a group:** the group is cut to the six best independent scores. If the cut falls inside a tie, all options tied at the boundary go through one `jev_rerank` "which should come first" pass and the shortlist is filled from its order; if that cannot separate them, the step ends as `tie_unresolved` and the expansion/ask rule applies (never a lexical pick).
5. A single eligible option needs no `jev_decide` (it requires at least two candidates).
6. A control option placed first means nothing is executed: gathering evidence is an expansion round, asking the user stops. Placed later in an `order` plan it becomes a `suspend` point: items after it wait.

Result (one line, ≤ 1.5 KB): `status`, `decision_id`, `kind`, `threshold`, `round`, `calls`, `tiebreaks`, `scores`, `plan` (`execute | reserve | suspend | after_suspend`), `receipt`.

## Nothing eligible, escape hatches, unavailability

- **Nothing above `T`**, a tie-break whose confidence is not above `T`, or a `jev_decide` escape hatch: `investigate` and `none` are expansion rounds, `ask_user` and an exhausted budget of rounds stop and ask. **At most two expansion rounds**, each with genuinely new options or evidence and a `new_material` note; a round whose options and evidence were all seen before is refused (`no_new_material`). A different hash is necessary but does not prove the change is real: it is on you to bring something new.
- After the rounds: `ask_user` (with the options and their scores). Headless (`--headless` or `JEV_CONTROL_HEADLESS=1`): `incomplete` and a `report` that starts `Incomplete:` and lists the scores.
- **No action below the threshold without the user's explicit approval of that exact option**, recorded with `approve` (decision id, option, the user's words). It is not a general exception and does not carry to another decision.
- **Jev unavailable:** after a transport failure, a timeout or an invalid response there is exactly **one identical retry**; then the step stops with "Jev unavailable". The user chooses to wait/retry or to turn the mode off and continue uncontrolled. A valid answer below the threshold is not an error and is never retried.
- A missing core tool or an incompatible schema refuses activation; `jev_audit` is optional (only that function is disabled without it).

## Budget

- **25 MCP `tools/call` attempts per user request**, counted for every source: the model's direct calls, subagents, helper calls, each part of a gate run, tie-breaks and retries. A slot is reserved before the request is sent, so a retry at the limit cannot become call 26; a reservation that was never sent is released and reported apart.
- At the limit: stop, report what was already received, and ask whether to continue (`budget approve` raises the limit by 25).
- The server's own HTTP/provider calls are reported `unknown` (0 only when the server explicitly says there was none). Activation is **not** refused for such transports and the server is not modified.
- `tools/list` at activation is discovery, not a `tools/call`.

## Search

`rg`/`glob`/the candidate generator produce candidates (at most 48 fragments of at most 1,000 characters); `top_k = 5`; a compact answer (≤ 4 KB). `jev_rerank` decides eligibility over several files (relevance `> T`). `jev_find` is allowed only for one location, and accepted only when the winner **and** `exists` are both `> T`; otherwise `jev_rerank` runs as the second logical evaluation. At most two logical evaluations per search, each with its own single transport retry. A near-tie among the eligible hits goes through one `jev_decide` in the shared budget; if it does not fit the rest is reported as unresolved. Control options are never injected as files. `none_candidates` allows one widening.

## Provenance and state

State is metadata only (ids, hashes, scores, counters, never code or text) under `~/.cache/jev-control/<repo-hash>/<session-hash>/`, kept 30 days. A decision receipt (HMAC under a per-session key) binds session, request, options, threshold, the Jev calls (argument and result hashes) and the snapshot; replays, receipts of another session or request, stale snapshots and options that were not planned to execute are rejected. A receipt proves where the helper's metadata came from, **not** that an action was carried out: execution is checked in the transcript.

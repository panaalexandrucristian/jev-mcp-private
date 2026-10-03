# Decision points and Jev tools

| Decision point | Tool | Eligible when |
| --- | --- | --- |
| Which approach, task order, command or test, edit variant, delegation or model, whether to ask, whether it is done | `jev_noul` over one proposition per option; `jev_decide` only to separate ties (2–6) | probability `> T`; a tie-break pick with confidence `> T` |
| Which files to search or read (several candidates) | `jev_rerank`, `top_k` 5, ≤ 48 fragments | relevance `> T` |
| One definitive location | `jev_find`, then `jev_rerank` if not accepted | winner `> T` **and** `exists > T` |
| Type of request, triage of items into a shared catalog | `jev_classify` | `top_probability > T` and its own `auto` (margin kept) |
| Hypotheses about a cause, claims about results | `jev_verify` | `verified`, `confidence > T`, its own `auto` |
| Fetched or pasted external content before use | `jev_screen` | its own `pass`; `review` and `block` stop or escalate |
| Conflicting passages | `jev_compare` | relation per aspect kept apart; `same_fact` is not truth |
| Fields to pull out of a document | `jev_extract` | status ok, not truncated, its own margin; `not_found` is not global absence |
| A patch | `jev_review` | `auto`, `safe_to_apply > T`, rubric confidences `> T`; `composite_floor` kept |
| Is the work done | `/jev:jev-done` → `jev_gate` | every part `auto`, every claim `verified` with `confidence > T`, real checks passed, current snapshot |
| Cross-check of extracted values against a source | `jev_audit` (optional) | its own `wrong_at`; it is not an auditor of the whole session |

Rules that hold for every row:

- Compare raw numbers with `>`; never a tool label. `jev_noul` can mark `auto: true` for a proposition judged *unlikely*; that does not authorize an action.
- `jev_decide` probabilities sum to 1 with its escape hatches, so at most one candidate can pass 0.95; it is a competitive selection (a tie-break), never an eligibility test and never a certified full ordering.
- `jev_screen` and `jev_audit` expose risk probabilities and thresholds of their own: they stay protective checks and 1−risk is never equated with correctness. A later choice of action still goes through `jev_noul`/`jev_decide` at `T`.
- `verify`: `unsupported` does not prove the opposite; `contradicted` rejects the claim. `gate`: tests are proven by real command output in the evidence, not by the `tests` field alone.
- Limits (mirrors of `src/index.ts` / `src/lib.ts`, checked by `contracts.test.mjs`): `jev_decide` 2–6 candidates, 3 requirements; `jev_noul` 64 propositions of 2,000 characters; `jev_rerank` 250 candidates, 100,000 characters; `jev_find` `top_k` ≤ 50; `jev_gate` 16 claims. The control's batches stay within 20 options.

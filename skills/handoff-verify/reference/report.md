## Output
Directory `<session-cwd>/.handoff-verify/<session-id>/<run-id>/` (unique run id; never overwrite). Per handoff: `<basename>-<hash8 of the real path>.verify.md` (Romanian) and `.verify.json` (schema `scripts/report.schema.json`, v1): session/line, variant/model/versions, inventory and classifications, aliases/copies, versions + sha256 + uuid/timestamp, source ranges, status, checks (`id`, `tool`, `verdict` and `confidence` copied EXACTLY from the Jev result, `null` if missing, `jev_ref`, `version_ref`, `retries`; `input_hash` is added later by the auditor from the recorded call — never invent it), findings/unresolved with quotes + uuid, where a finding counts as CONFIRMED (FAIL) only if ALL hold: its `check_id` points to a bound, resolved check; its own `confidence` is a number > 0.95 copied EXACTLY from that same Jev result; the real verdict fits the defect (`contradicted` for wrong_fact/stale_state/dead_path; for lost_detail the explicit pair of "Omissions (R04)" carrying `omission_ref`; an `unsupported` result never confirms any finding except the absence half of a valid omission pair and a `verified` result never confirms a fact defect); it carries an explicit `claim` = the exact text of that check's claim (its `jev_ref.key`), and `quote_handoff` is a passage copied verbatim from the handoff version whose sha256 you list in `handoff.versions` (report.py and the auditor re-read exactly that version, by hash; if it cannot be recovered or the passage is not in it the finding stays unsupported, so never invent or paraphrase a passage; only a lost_detail may have no `quote_handoff`); `quote_source` is a passage of the evidence you gave that call (for lost_detail: an exact quote lying inside the source passage given to the SOURCE check). Anything else is an unsupported finding (the status stays UNRESOLVED, never FAIL). Quotations are compared exactly, in case, whitespace and newlines: `quote_handoff` must be an exact substring of the text of the handoff version you list (no normalization), and `quote_source` an exact substring of one raw entry of the evidence the call was given (an evidence entry, a compare passage or the gate diff), never a concatenation of unrelated entries; only the `claim` and the omission `detail` are whitespace-normalized. A confidence is a finite number in [0, 1] (not a boolean, not a string) before the strict > 0.95 test; infinity, NaN, a negative number or a number above 1 is unusable (null), never clamped or rounded into acceptance. The report also holds `scope_exclusions` (see "Scope filter (R05)"; `scope_audit` is written by report.py), `audit` (see "Mandatory audit"; REQUIRED for a PASS), kit/skips, cost/time (`unavailable`, never 0, when not exposed), patch/approval.
The Markdown report is written by you; `report.py` rewrites ONLY its main status line to the audited status: the first line `Stare|Stat|Status|Estado: <token>` of the document whose label is at the start of the line (preceded by nothing but up to three spaces, a heading marker, a list marker and markdown emphasis) and that is not inside a fenced block, a blockquote (`> Stare: ...` is a quotation or an example), a quotation (`"Stare: PASS"`, `'Stare: PASS'`, curly quotes, guillemets), inline code, an indented code block (four or more spaces, or a tab), a table cell, an HTML comment, or the section of a version ("Versiunea N") or of an example ("Exemplu", "Example"). Every other status (a quoted example, a later repetition, a warning, a per-version status) is kept as written, and the recalculated / stale notices are prepended. The status the report declares in its JSON is the writer's to set: a `status` that is not PASS, FAIL or UNRESOLVED is ignored (`status_claimed` is `null` and the reason is recorded), never kept.
Chat summary (short, Romanian), per handoff: `PASS | FAIL | UNRESOLVED`, lost details, wrong facts — each with an excerpt, Jev verdict and confidence.
Patch: concrete lines to add/correct, each with its transcript quote; verify patch content with `jev_verify` and the patch with `jev_gate`, both with the strict filter; show the per-file diff; wait for approval.

## Binding checks to Jev calls (required; report v1 + jev_ref v1)
Every check that relies on a Jev result must carry `jev_ref` = `{"tool_use_id": "<id>", "result_index": <int>, "key": "<exact text>"}`. You cannot see tool_use ids yourself, so NEVER type or invent them: run
`python3 <skill-dir>/scripts/jevref.py list --cwd <session cwd>` (read-only; it reads the current session's log, prints its path as `session`, and refuses when the current session is ambiguous) and copy the `tool_use_id`, `index` (= `result_index`) and `key` of the result your check uses.
`key` is the exact claim text for `jev_verify`/`jev_gate`, the item/field id for `jev_classify`/`jev_extract`; for `jev_compare` index 0 is the overall result and index 1+k is aspect k (key as listed).
`verdict` and `confidence` must equal that result exactly. A check with no result (Jev unavailable, error) has `jev_ref: null` and stays UNRESOLVED.
Version identity (R02): every check also carries `version_ref`, the identity of the handoff version it evaluates. You cannot see these ids either, so never type them: for a handoff you wrote in this session run `python3 <skill-dir>/scripts/versions.py list --cwd <session cwd> --file <handoff> --evaluated-against session_end` (use `prefix` for an earlier version judged against the transcript up to its own write); for a handoff written in a saved session you are auditing run `versions.py list --source <saved session .jsonl> --file <handoff copy> --evaluated-against prefix`. Copy the `version_ref` object of the version you verify EXACTLY (write_tool_use_id, sha256, evaluated_against and, for `session_end` when a verification run follows the write, `run`; with several runs `versions.py list` shows them in `runs` and you pass `--run ID` for the one you are in), set `handoff.path` to the printed `path` and `session.jsonl` to the printed `source_session_jsonl`; if the printed `handoff_source_path` is not null (your file is a hash-verified copy of a handoff written elsewhere in that saved session) set `handoff.path` to the copy and `handoff.source_path` to that value. The path must be identical, by canonical path, to a path written in that transcript: the same file name in another directory is not the handoff. For a handoff written in this session a check verifies a version only if its Jev call was made after that write's result and the Jev result came back before the next write or edit of the same path. A check without a valid version_ref stays UNRESOLVED (never PASS); report.py also writes status per version and a `delivery` block, and `versions.py status` re-derives everything from the transcript and the file on disk.
Write the reports ONLY with `report.write_report(run_dir, handoff_path, doc, md_text, calls_jsonl=<the session path printed by jevref.py list>)` (`sys.path.insert(0, "<skill-dir>/scripts"); import report`): it re-binds every check against the logged calls, recomputes the status (a PASS with an unbound check becomes UNRESOLVED and your claimed status is kept as `status_claimed`) and keeps the Markdown status consistent. Never write the `.verify.json` by hand.
If `versions.py list` (or `omissions.py prepare`) exits 3 with `no recorded supported Write/Edit`, the note has no write identity: do not invent a `version_ref`, make no version-dependent call, and write the report anyway (status UNRESOLVED, no checks needed): `report.write_report` re-derives `binding_summary.version_identity.provenance` and adds the blocker to `binding_summary.reasons`.
Example (one batch call, two results with the SAME confidence, told apart by `result_index` and `key`):
`jev_verify` input `{"claims": ["The decision was to use lmdb instead of etcd", "The public API must not change"], "evidence": [...]}` → results[0] and results[1] both `verified` 0.97. Checks: `{"id": "c1", "tool": "jev_verify", "verdict": "verified", "confidence": 0.97, "jev_ref": {"tool_use_id": "<from list>", "result_index": 0, "key": "The decision was to use lmdb instead of etcd"} }` and `{"id": "c2", ..., "jev_ref": {"tool_use_id": "<from list>", "result_index": 1, "key": "The public API must not change"} }`.

## Examples (the same six cases for every engine; calls are the engine's own)
Responses marked ILLUSTRATIVE are invented SHORTHAND, not measured and not real response contracts: a real `jev_verify` response is the flat `results` form of "Jev tool contracts" (per claim `verdict`, `confidence`, `action`, `same_subject`, with `subject_at` at the top level), and the contracts of `jev_compare` and the others are in that section too; a recorded response that lacks the subject fields leaves a check UNRESOLVED (`protocol_fields_absent`). Synthetic stories use made-up values. Historical measurements are in `scripts/HISTORY.md`, not here.

### Example 01 — Real sanitized example (dev corpus, no linked transcript) — REAL, sanitized

**Transcript excerpt**
```
(none: the corpus note `scratchp__...handover-g1-D.md` has no Write/Edit-linked transcript in `~/.claude/projects`; so the corpus inventory lists it as unlinked)
```
**Handoff excerpt**
```
- Working directory: `/Users/apana/dev/opencode-council`
- Branch: `map-prepass`
- Member D is the only executor permitted to edit files. Do not commit or push.
```
**Exact Jev call(s) (txdiff engine)**

n/a (no transcript to verify against; only the local path check applies)

**Jev response**: n/a — no Jev call can resolve source-dependent claims without a transcript. Only the path check (kit / `os.path.exists`) is available.

**Expected report (Romanian, abridged)**
> Estado: **UNRESOLVED**. Inventar: 1 handoff, fără transcript asociat (nelegat). Căi: `/Users/apana/dev/opencode-council` verificată local (existență actuală, nu adevăr istoric). Omisiuni/fapte: **nerezolvate — fără sursă** (nu se calculează recall). Constatări confirmate: 0. Nerezolvate: 3 (fără transcript).

### Example 02 — Lost detail (omitted user constraint) — synthetic

**Transcript excerpt**
```
[u-101 user] Goal: ship the zephyr billing migration to duckdb by Friday. Do NOT change the public API of billing. Never run migrate.sh against prod, it drops the audit table (ticket T-5521).
```
**Handoff excerpt**
```
- Goal: ship the zephyr billing migration to duckdb by Friday.
- Never run migrate.sh against prod: it drops the audit table.
(the constraint about the public API is missing)
```
**Exact Jev call(s) (txdiff engine)**

`python3 <skill-dir>/scripts/omissions.py prepare --source <session> --file <handoff> --write-id <id from versions.py list> --evaluated-against prefix --detail "Do NOT change the public API of billing." --source-quote "Do NOT change the public API of billing."` prints `absence_claim`, `source_claim`, `source_passage` and `material` (the complete canonical material of that note version); copy them, never type them. Then, ABSENCE-first:
1. `mcp__jev__jev_verify` input: `{"claims": ["Do NOT change the public API of billing."], "evidence": [{"text": "<material, verbatim and complete>"}]}`: ONE claim (the bare detail) and ONE evidence entry (exactly the printed material).
2. Only because (1) is `unsupported` > 0.95 with `action` `auto`: `mcp__jev__jev_verify` input: `{"claims": ["The supplied source passage states this detail: Do NOT change the public API of billing."], "evidence": [{"text": "<source_passage>"}]}`: the claim exactly as printed (`source_claim`) and the WHOLE evidence exactly the printed passage (the transcript record that holds the quote, nothing added).

**What makes the pair a confirmed omission** (report.py and the gate re-derive all of it; any difference leaves the obligation UNRESOLVED): both checks are bound to real recorded, error-free calls and carry the SAME `version_ref` as `prepare` printed (one write id, sha256 and `evaluated_against`, and the same `run` for `session_end`); the ABSENCE result is `unsupported` with confidence > 0.95 and an explicit `action` `auto` (`same_subject` is not required for this half, and only for it); the SOURCE result is `verified` with confidence > 0.95, `action` `auto` and BOTH `same_subject` (on the result) and `subject_at` (at the top level) present with `same_subject` >= `subject_at`; the finding is `lost_detail` with `check_id` = the ABSENCE check, `omission_ref` = `{"detail": "...", "source_check_id": "<the SOURCE check>"}`, `claim` = the absence claim, `confidence` = that check's, `quote_source` = the exact quote and `quote_handoff` null. A server whose recorded `jev_verify` responses carry no `same_subject`/`subject_at` can never complete the SOURCE half, so the pair stays UNRESOLVED (`protocol_fields_absent`). The old shape "absence call `verified` plus a confirmed finding" is not an omission and confirms nothing: a `verified` or `contradicted` absence result means the note states (or contradicts) the detail.

**Jev response**: ILLUSTRATIVE shorthand (not measured, not the real contract): (1) `unsupported` 0.98 with `action` `auto`, so the SOURCE call is made; (2) `verified` 0.99 with `action` `auto` and `same_subject` >= `subject_at`. Had (1) been `verified` or `contradicted` there would be no second call and no finding; had it been <= 0.95 or `review`, the omission would stay UNRESOLVED, never FAIL.

**Expected report (Romanian, abridged)**
> Stare: **FAIL**. Detaliu pierdut (categoria 2, constrângere utilizator): „Do NOT change the public API of billing” (u-101). Perechea sursă + absență explicită pe aceeași scriere: absență unsupported 0.98 cu action auto pe materialul complet al notei, apoi sursă verified 0.99 (ILUSTRATIV); constatarea poartă omission_ref (detail, source_check_id). Patch: adaugă `- Constraint: do NOT change the public API of billing.` Dacă absența nu depășește 0.95: UNRESOLVED. (Un FAIL rămâne FAIL chiar dacă auditul nu e complet; un PASS are nevoie de audit complet.)

### Example 03 — Wrong fact (decision inverted) — synthetic

**Transcript excerpt**
```
[u-104 assistant] I will use duckdb instead of mongo because it needs no network service in CI.
```
**Handoff excerpt**
```
- Decision: use mongo instead of duckdb because it needs no network service in CI.
```
**Exact Jev call(s) (txdiff engine)**

`mcp__jev__jev_compare` input: `{"passage_a": "Decision: use mongo instead of duckdb because it needs no network service in CI.", "passage_b": "I will use duckdb instead of mongo because it needs no network service in CI.", "aspects": ["chosen database"]}`, then confirm with `mcp__jev__jev_verify` input: `{"claims": ["The decision was to use mongo instead of duckdb"], "evidence": [{"id": "chunk-0001", "text": "I will use duckdb instead of mongo because it needs no network service in CI."}]}`

**Jev response**: ILLUSTRATIVE (not measured): `{"results":[{"id":"claim0","verdict":"contradicted","confidence":0.99}]}`.

**Expected report (Romanian, abridged)**
> Stare: **FAIL**. Fapt greșit (categoria 3): nota spune „use mongo instead of duckdb”, transcriptul (u-104, asistent) spune „use duckdb instead of mongo”. contradicted 0.99 (ILUSTRATIV). Patch: inversează decizia.

### Example 04 — Dead path and stale state — synthetic

**Transcript excerpt**
```
[u-105 tool_result ERROR] 403 Forbidden: registry access for security not granted
[u-106 user] Access to the security registry has now been granted, you can continue.
[u-102 assistant] ... half-done in /work/zephyr/src/billing.py
```
**Handoff excerpt**
```
- Key values: file /work/zephyr/source/billing.py
- Blocker: registry access for security is not granted yet (403).
```
**Exact Jev call(s) (txdiff engine)**

`mcp__jev__jev_compare` input: `{"passage_a": "Blocker: registry access for security is not granted yet (403).", "passage_b": "[u-105] 403 Forbidden: registry access for security not granted. [u-106 user] Access to the security registry has now been granted, you can continue.", "aspects": ["registry access"]}`, then confirm with `mcp__jev__jev_verify` input: `{"claims": ["Registry access for the security team is still not granted"], "evidence": [{"id": "chunk-0001", "text": "[u-105] 403 Forbidden: registry access for security not granted. [u-106 user] Access to the security registry has now been granted, you can continue."}]}`

**Jev response**: ILLUSTRATIVE (not measured): `{"results":[{"id":"claim0","verdict":"contradicted","confidence":0.97}]}`; kit/`os.path.exists`: `/work/zephyr/source/billing.py` missing, `/work/zephyr/src/billing.py` present.

**Expected report (Romanian, abridged)**
> Stare: **FAIL**. Cale moartă (cat. 9): `/work/zephyr/source/billing.py` nu există; transcriptul indică `/work/zephyr/src/billing.py` (u-102). Stare învechită (cat. 5): blocajul „registry access … not granted” a fost rezolvat în u-106 (contradicted 0.97, ILUSTRATIV).

### Example 05 — UNRESOLVED (confidence ≤ 0.95) — synthetic

**Transcript excerpt**
```
[u-107 tool_result] 33 passed, 2 failed in 2.31s (pytest -q tests/test_billing.py)
```
**Handoff excerpt**
```
- Verify with `pytest -q tests/test_billing.py`; last result: 33 passed, 2 failed.
```
**Exact Jev call(s) (txdiff engine)**

`mcp__jev__jev_compare` input: `{"passage_a": "last result: 33 passed, 2 failed", "passage_b": "33 passed, 2 failed in 2.31s", "aspects": ["last test result"]}`, then confirm with `mcp__jev__jev_verify` input: `{"claims": ["The last result of pytest -q tests/test_billing.py was 33 passed, 2 failed"], "evidence": [{"id": "chunk-0001", "text": "33 passed, 2 failed in 2.31s"}]}`

**Jev response**: ILLUSTRATIVE (not measured): first call `verified` at 0.91 (≤ 0.95). One re-verification with NEW evidence (the preceding chunk with the command line `pytest -q tests/test_billing.py`); if it stays ≤ 0.95 → UNRESOLVED. Never the same input twice.

**Expected report (Romanian, abridged)**
> Stare: **UNRESOLVED**. Verificare „ultimul rezultat al testelor” nerezolvată: confidence 0.91 (≤ 0.95) și după reverificarea cu dovezi noi 0.93. Constatări confirmate: 0. Nerezolvate: 1. Nu este PASS.

### Example 06 — Clean PASS — synthetic

**Transcript excerpt**
```
[u-109 tool_result] e41a9c2 migrate billing to duckdb
```
**Handoff excerpt**
```
- Key values: commit e41a9c2.
```
**Exact Jev call(s) (txdiff engine)**

`mcp__jev__jev_compare` input: `{"passage_a": "Key values: commit e41a9c2.", "passage_b": "e41a9c2 migrate billing to duckdb", "aspects": ["latest commit"]}`, then confirm with `mcp__jev__jev_verify` input: `{"claims": ["The latest commit is e41a9c2 (migrate billing to duckdb)"], "evidence": [{"id": "chunk-0001", "text": "e41a9c2 migrate billing to duckdb"}]}`

**Jev response**: ILLUSTRATIVE (not measured): every required check `verified`/`same_fact` with confidence > 0.95 (e.g. 0.99) and bound, zero defects, and a COMPLETE audit block: every expected chunk reviewed for the nine categories (each review and each no-candidate / not-applicable outcome grounded in a record of the source), an explicit outcome per category, no unaccounted registered candidate (`coverage.json` `complete` alone would not justify a PASS).

**Expected report (Romanian, abridged)**
> Stare: **PASS**. 9/9 categorii acoperite sau neaplicabile (rezultat explicit pentru fiecare), toate verificările rezolvate > 0.95, 0 constatări, audit complet: toate fragmentele așteptate revizuite pentru cele 9 categorii și toți candidații înregistrați cu dispoziție derivată (`binding_summary.audit.complete`; coverage.json: complete singur nu justifică PASS).


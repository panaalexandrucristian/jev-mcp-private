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

`python3 <skill-dir>/scripts/omissions.py prepare --source <session> --file <handoff> --write-id <id from versions.py list> --evaluated-against prefix --detail "Do NOT change the public API of billing." --source-quote "Do NOT change the public API of billing."` prints the canonical claims, the source passage and the complete material; then (1) `mcp__jev__jev_verify` input: `{"claims": ["The supplied source passage states this detail: Do NOT change the public API of billing."], "evidence": "<source_passage>"}` and (2) `mcp__jev__jev_verify` input: `{"claims": ["The complete supplied handoff material neither states nor implies this detail: Do NOT change the public API of billing."], "evidence": "<material, verbatim and complete>"}`

**Jev response**: ILLUSTRATIVE (not measured): (1) `verified` 0.99; (2) `verified` 0.97 with `action` auto and `same_subject` at or above `subject_at`. In the direct R03 probes on this Jev version the absence claim reached only 0.21-0.42 (`review`) on truly missing details: the omission would then stay UNRESOLVED, never FAIL.

**Expected report (Romanian, abridged)**
> Stare: **FAIL**. Detaliu pierdut (categoria 2, constrângere utilizator): „Do NOT change the public API of billing” (u-101). Perechea sursă + absență explicită pe aceeași scriere: sursă verified 0.99, absență verified 0.97 pe materialul complet al notei (ILUSTRATIV); constatarea poartă omission_ref (detail, source_check_id). Patch: adaugă `- Constraint: do NOT change the public API of billing.` Dacă absența nu depășește 0.95: UNRESOLVED.

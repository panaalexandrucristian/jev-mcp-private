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

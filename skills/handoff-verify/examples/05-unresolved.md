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

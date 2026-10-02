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

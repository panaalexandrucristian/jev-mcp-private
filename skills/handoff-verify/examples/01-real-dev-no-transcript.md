### Example 01 — Real sanitized example (dev corpus, no linked transcript) — REAL, sanitized

**Transcript excerpt**
```
(none: the corpus note `scratchp__...handover-g1-D.md` has no Write/Edit-linked transcript in `~/.claude/projects`; see results/evidence/corpus_inventory.json)
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

#!/usr/bin/env python3
"""Shared test helper (NOT a test module; stdlib only): complete audit data for a fixture report, DERIVED from the fixture's real source transcript.
`complete(doc)` returns the report with a full `audit` object (one evaluation block per evaluation the checks name, a review record for every chunk that audit.py expects, with the sha256 of its text and all nine categories, and an
explicit outcome for each category) and the `scope_exclusions` accounting; nothing is exempted and no expectation is relaxed: the same audit that judges a real report accepts it, because the review it describes is exactly the review
the audit re-derives (the expected chunks come from prepare.derive on the fixture's source). `details` are registered (before any scope filter) in the registry of the session, which preparation establishes. Used by the tests that expect a PASS."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A

MISSING = object()   # scope_exclusions=MISSING: the report declares no scope accounting at all

def keys_of(doc):
    """The evaluations the checks of the fixture name through their version_ref: [(write id, sha256, mode, run)], or [GLOBAL] when none does (a report without version identity)."""
    out = []
    for c in doc.get("checks") or []:
        r = c.get("version_ref") if isinstance(c, dict) else None
        k = A.key_from_dict({k: v for k, v in r.items() if k in ("write_tool_use_id", "sha256", "evaluated_against", "run")}) if isinstance(r, dict) else None
        if k is not None and k not in out: out.append(k)
    return out or [A.GLOBAL]

def shell(doc):
    """The legitimate required properties of a report that a fixture does not care about (variant, environment, kit, cost, patch, status, an empty scope accounting and an audit object without evaluations: no review at all), added only when the fixture does not carry them: the schema requires them and nothing is relaxed."""
    d = dict(doc)
    d.setdefault("variant", dict(name="fixture")); d.setdefault("environment", dict(model="fixture")); d.setdefault("kit", dict(status="not found", exit=None, skips=[])); d.setdefault("cost", dict(tokens="unavailable", usd="unavailable", wall_s="unavailable", jev_calls=0))
    d.setdefault("patch", dict(proposed=False, approved=False)); d.setdefault("status", "UNRESOLVED"); d.setdefault("scope_exclusions", []); d.setdefault("audit", dict(version=A.AUDIT_VERSION, evaluations=[]))
    return d

def basis_of(plan, win, index=None, nth=0):
    """A grounded basis {uuid, quote}: an exact quote of the body of a record that lies in the window (a record of the chunk `index`, else of the first expected chunk). None when the window holds no record."""
    for i in ([index] if index is not None else win["indexes"]):
        spans = [x for x in win["spans"].get(i, []) if plan["texts"][i][x[1]:x[2]].strip()]
        if len(spans) > nth:
            u, a, b = spans[nth]; return dict(uuid=u, quote=plan["texts"][i][a:b].strip()[:24])
    return None

def window(plan, k, source=None):
    win, why = A.window_of(plan, source or plan["source"], k)
    if win is None: raise ValueError(why)
    return win

def block(plan, k, candidates=(), source=None):
    """The COMPLETE evaluation block of the evaluation `k`: every expected chunk reviewed for the nine categories with a source-grounded basis; the categories list the given registered candidates ((id, category)), the others are grounded no-candidate outcomes."""
    win = window(plan, k, source); by = {c["index"]: c for c in plan["chunks"]}
    mine = {}
    for cid, cat in candidates: mine.setdefault(cat, []).append(cid)
    free = basis_of(plan, win)
    def outcome(c):
        if c in mine: return dict(category=c, outcome="candidates", candidates=mine[c])
        return dict(category=c, outcome="no_candidate", **({"basis": basis_of(plan, win, nth=c % 3) or free} if win["indexes"] else {}))
    return dict(evaluation=A.dict_of(k), chunks=[dict(index=i, sha256=by[i]["sha256"], reviewed=True, categories=list(A.CATEGORIES), basis=basis_of(plan, win, i)) for i in win["indexes"]],
                categories=[outcome(c) for c in A.CATEGORIES], unresolved=[])

def registry_of(plan_or_source, note=None, max_chars=None):
    """The registry path of the session (derived from its source)."""
    plan = plan_or_source if isinstance(plan_or_source, dict) else A.plan_of(plan_or_source, note, max_chars or A.CHUNK_CHARS)
    return A.registry_path(plan)

def register(doc, details, category=2, source=None):
    """Register `details` (before any scope filter) for every evaluation of the fixture, in the registry of the session -> {evaluation key: [(candidate id, category)]}."""
    src = source or doc["session"]["jsonl"]; out = {}; path = A.registry_path_of(src)
    for k in keys_of(doc):
        for d in details:
            c, _ = A.register(path, A.D.canon(src), k, d, category); out.setdefault(k, []).append((c["id"], category))
    return out

def complete(doc, registry=None, ledger=None, details=(), category=2, scope_exclusions=None, max_chars=None, blocks=None, source=None, establish=True):
    """The fixture report with the mandatory audit data (see the module doc). `blocks` replaces the derived evaluation blocks (for a deliberately incomplete or stale review). `source` = the transcript the version identity is judged in when it is not the one the report names
    (the writer and the gate read the calls log when it is the same session: pass that path). The evaluations are ESTABLISHED in the registry of the session first (what `audit.py template` does); `details` are registered in it. `registry` is accepted for old
    callers and ignored: the registry is the one of the session, never a path the report picks."""
    d = shell(dict(doc)); d.setdefault("schema_version", "1")
    for f in ("checks", "findings", "unresolved"): d.setdefault(f, [])
    d.setdefault("handoff", dict(path=None, versions=[])); d["handoff"].setdefault("versions", [])
    if scope_exclusions is MISSING: d.pop("scope_exclusions", None)
    else: d["scope_exclusions"] = scope_exclusions if scope_exclusions is not None else d.get("scope_exclusions", [])
    src, note = source or d["session"]["jsonl"], d["handoff"].get("path"); keys = keys_of(d); versioned = keys != [A.GLOBAL]
    plan = A.plan_of(src, note if versioned else None, max_chars or A.CHUNK_CHARS); path = A.registry_path(plan)
    if establish and path:
        for k in keys: A.establish(path, plan["source"], k)
    named = (d.get("session") or {}).get("jsonl") if isinstance(d.get("session"), dict) else None
    if establish and isinstance(named, str) and named and os.path.isfile(named) and A.D.canon(named) != plan["source"]:
        import versions
        if versions.same_session(named, src):      # another representation of the same session that the report names: the audit requires ITS accounting too (a positive fixture establishes it, as `audit.py template --source <it>` does)
            other = A.registry_path_of(named)
            if other:
                for k in keys: A.establish(other, A.D.canon(named), k)
    regs = register(d, details, category, source) if details else {}
    def safe(k):
        try: return block(plan, k, regs.get(k, ()), src)
        except ValueError: return dict(evaluation=A.dict_of(k), chunks=[], categories=[], unresolved=[])      # an evaluation whose window is not demonstrated cannot be reviewed (the audit says why)
    evs = blocks if blocks is not None else [safe(k) for k in keys]
    au = dict(version=A.AUDIT_VERSION, evaluations=evs)
    if max_chars: au["max_chars"] = max_chars
    if path: au["registry"] = path
    if ledger: au["ledger"] = ledger
    d["audit"] = au
    return d

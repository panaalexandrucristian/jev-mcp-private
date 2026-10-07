"""Report core: strict Jev threshold, status precedence, retry policy, report writing, patch approval/backup.
Stdlib only. Never calls Jev (Claude Code calls MCP directly)."""
import datetime, hashlib, json, math, os, re, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevref, scope, versions

THRESHOLD = 0.95
SCHEMA_VERSION = "1"

def passes(confidence):
    """Strictly > 0.95, no rounding. None/NaN/bool/str never pass."""
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return False
    if isinstance(confidence, float) and math.isnan(confidence):
        return False
    return confidence > THRESHOLD

def check_status(check):
    """check: {kind: 'defect'|'obligation', verdict_ok: bool, confidence: float|None, error: str|None, aux_ok: bool=True}
    returns 'confirmed' | 'cleared' | 'unresolved'.
    A defect is confirmed only when the defect verdict holds with confidence > threshold and auxiliary conditions are satisfied.
    An obligation is cleared only when satisfied with confidence > threshold."""
    if check.get("error") or not passes(check.get("confidence")) or not check.get("aux_ok", True) or check.get("bound") is False:
        return "unresolved"   # bound=False: no demonstrable Jev call/result behind the check (R01: PASS is impossible with an unbound check)
    if check["kind"] == "defect":
        return "confirmed" if check["verdict_ok"] else "cleared"
    return "cleared" if check["verdict_ok"] else "confirmed"

def overall_status(checks):
    """FAIL if any confirmed defect (unresolved kept & counted); else UNRESOLVED if any unresolved; else PASS (also requires >=1 check)."""
    st = [check_status(c) for c in checks]
    unresolved = st.count("unresolved")
    confirmed = st.count("confirmed")
    if confirmed:
        status = "FAIL"
    elif unresolved or not checks:
        status = "UNRESOLVED"
    else:
        status = "PASS"
    return {"status": status, "confirmed": confirmed, "unresolved": unresolved, "cleared": st.count("cleared"), "total": len(st)}

TRANSPORT_ERRORS = {"transport", "invalid_response"}

def retry_decision(error_kind, attempts_identical, low_confidence=False, new_evidence=False, reverifications=0):
    """One identical retry only for transport/invalid_response; low confidence: at most one re-verification with NEW documented evidence;
    never an identical re-call for a nicer score. Returns 'retry_identical' | 'reverify_new_evidence' | 'stop_unresolved'."""
    if error_kind in TRANSPORT_ERRORS:
        return "retry_identical" if attempts_identical < 1 else "stop_unresolved"
    if low_confidence:
        return "reverify_new_evidence" if (new_evidence and reverifications < 1) else "stop_unresolved"
    return "stop_unresolved"

def input_hash(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def confidence_or_null(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and not (isinstance(v, float) and math.isnan(v)) else None

def cost_field(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else "unavailable"

def short_hash(path, extra=0):
    return hashlib.sha256(os.path.realpath(path).encode()).hexdigest()[:8 + extra]

def report_names(handoff_path, existing=()):
    base = os.path.basename(handoff_path)
    extra = 0
    while True:
        stem = "%s-%s" % (base, short_hash(handoff_path, extra))
        if not any(e.startswith(stem) and os.path.realpath(e) != os.path.realpath(handoff_path) for e in existing) or extra > 8:
            return stem + ".verify.md", stem + ".verify.json"
        extra += 1

def new_run_dir(session_cwd, session_id, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    run_id = now.strftime("%Y%m%dT%H%M%S%fZ")
    d = os.path.join(session_cwd, ".handoff-verify", session_id, run_id)
    os.makedirs(d, exist_ok=False)  # unique run id: never overwrite
    return d, run_id

STATUS_LINE = re.compile(r"^\W*(Stare|Stat|Status|Estado)\b", re.I)

def session_cwd_of(run_dir):
    """The cwd of the CURRENT Claude session = the part before /.handoff-verify/ in the run dir (else the process cwd). NOT the cwd of the verified transcript."""
    marker = os.sep + ".handoff-verify" + os.sep
    return run_dir.split(marker)[0] if marker in run_dir else os.getcwd()

def bind_report(doc, calls_jsonl=None, run_dir=None, extra_paths=(), require_version_identity=False, handoff_path=None, session_id=None, omission_contract="R04"):
    """Bind every check of `doc` against the Jev calls logged in the CURRENT session's JSONL (never the verified fixture's transcript) and recompute the status.
    Returns the new doc (status_claimed kept when the status changes). Without a readable calls log every check stays unbound -> UNRESOLVED.
    R02 (`require_version_identity`, True in write_report): every bound check must carry a version_ref whose identity is verified against the source transcript named by `session.jsonl`
    (shared/versions.py); a bound check without a valid version identity is unresolved, findings validate quote_handoff against their check's own version, status/binding_summary are also
    computed per version, and for a handoff written in the current session a `delivery` block records the gate state (the gate itself is `versions.py status`)."""
    doc = dict(doc); checks = [dict(c) for c in doc.get("checks", [])]; calls, note, cpath = [], None, None
    try:
        path = calls_jsonl
        if not path:
            import discover as D
            path, how, amb = D.resolve_session_info(None, session_cwd_of(run_dir or os.getcwd()))
            if amb: path, note = None, "current session not demonstrated (ambiguous)"
            elif not path: note = "current session log not found"
        if path: calls = jevref.load_calls(path); cpath = path
    except Exception as e:
        note = "calls log unreadable: %s" % e
    ctr = jevref.contract_of(omission_contract); bs = jevref.bind(checks, calls, ctr); vnote = None
    htxt = jevref.resolve_handoff_text(doc.get("handoff"), extra_paths)[0]
    if require_version_identity:
        h = doc.get("handoff") if isinstance(doc.get("handoff"), dict) else {}
        hp = h.get("path") if isinstance(h.get("path"), str) else handoff_path
        src = (doc.get("session") or {}).get("jsonl"); same = bool(cpath) and versions.same_session(src, cpath, session_id)
        rows = versions.bind_versions(checks, bs, hp or "", (cpath if same else src) if isinstance(src, str) else None, calls, same, h.get("source_path") if isinstance(h.get("source_path"), str) else None)
        bs = versions.attach(bs, rows)
        bs = jevref.finalize(bs, doc.get("findings", []), htxt, ctr)   # R04: the absence half of a valid pair is resolved once the identity and the material are attached
        vnote = dict(same_session=same, identity_ok=sum(1 for r in rows.values() if r["ok"]), identity_failed=sum(1 for r in rows.values() if not r["ok"]), reasons=sorted({r["reason"] for r in rows.values() if not r["ok"]}))
    for c, b in zip(checks, bs): c["binding"] = {k: b[k] for k in ("bound", "reason", "resolved", "aux_ok")}
    ev = jevref.audited_status(checks, bs, doc.get("findings", []), doc.get("unresolved", []), htxt, ctr)
    if "scope_exclusions" in doc:   # R05: every declared out-of-scope exclusion is re-derived from the real jev_classify call; one that cannot be demonstrated makes a PASS UNRESOLVED (a FAIL stays FAIL)
        sa = scope.validate_exclusions(doc["scope_exclusions"], calls, (doc.get("session") or {}).get("jsonl"), doc.get("findings", []))
        doc["scope_audit"] = dict(threshold=scope.THRESHOLD, **sa)
        if sa["invalid"]:
            ev["reasons"].append("invalid scope exclusions: %d" % sa["invalid"])
            if ev["status"] == "PASS": ev["status"] = "UNRESOLVED"
    if doc.get("status") != ev["status"]: doc["status_claimed"] = doc.get("status")
    if ctr != "R02": doc["omission_contract"] = ctr   # informative only (never read): the contract the writer applied (strict auxiliary conditions and the explicit omission pair; the gate and the auditors recompute under their own contract)
    doc.update(checks=checks, status=ev["status"], jev_ref_version="1", binding_summary=dict(checks=ev["checks"], bound=ev["bound"], resolved=ev["resolved"], unbound=ev["unbound"], reasons=ev["reasons"], calls_log_note=note, jev_calls_in_log=len(calls)))
    if vnote is not None:
        doc["binding_summary"]["version_identity"] = vnote
        h = dict(doc.get("handoff") or {}); pv = versions.per_version(checks, bs, doc.get("findings", []), doc.get("unresolved", []), h.get("versions", []), omission_contract)
        wids = versions.write_ids((cpath if same else src) if isinstance(src, str) else None, hp or "", h.get("source_path") if isinstance(h.get("source_path"), str) else None)
        def attach_pv(v):
            if not isinstance(v, dict): return v
            e, how = versions.lookup(pv, v, wids)
            if e is not None: return dict(v, audited_status=e["audited_status"], binding_summary=e["binding_summary"], evaluations=e["evaluations"], attributed_write=e["write_tool_use_id"], attribution=how)
            return dict(v, audited_status="UNRESOLVED", binding_summary=dict(checks=0, bound=0, resolved=0, unbound=0, reasons=[how], valid_findings=0), evaluations={}, attribution=how)
        h["versions"] = [attach_pv(v) for v in h.get("versions", [])]
        doc["handoff"] = h
        if vnote["same_session"] and cpath:
            g = versions.gate(cpath, h.get("path") or handoff_path or "", dict(doc), disk_path=handoff_path or h.get("path"), session_id=session_id, omission_contract=ctr)
            doc["delivery"] = {k: g[k] for k in ("delivery_state", "current_sha256", "latest_write_id", "bound_checks_for_version", "reasons")}
            if g.get("stale"): doc["delivery"]["stale"] = g["stale"]   # the report is about a version that is not the latest write of the path (the exact notice is derived from it by render_md / versions.py status)
    return doc

def render_md(md_text, doc):
    """Keep the Markdown consistent with the final JSON status: status lines are rewritten, and a notice is prepended when the model's status was overridden."""
    final = doc["status"]
    lines = [re.sub(r"\b(PASS|FAIL|UNRESOLVED)\b", final, l) if STATUS_LINE.match(l) else l for l in md_text.splitlines()]
    out = "\n".join(lines) + ("\n" if md_text.endswith("\n") else "")
    if "status_claimed" in doc:
        out = "> Stare finală (recalculată de report.py din legăturile verificare→apel Jev): **%s**; declarată inițial: %s. Motiv: %s.\n\n" % (final, doc["status_claimed"], "; ".join(doc["binding_summary"]["reasons"]) or "n/a") + out
    stale = (doc.get("delivery") or {}).get("stale")
    if stale: out = versions.stale_notice(stale) + "\n\n" + out
    return out

def write_report(run_dir, handoff_path, doc, md_text, existing=(), calls_jsonl=None, require_version_identity=True, omission_contract="R04"):
    """Writes <name>.verify.md/.json. Checks are bound to the real Jev calls of the current session (see jevref.py) and the status is recomputed: PASS is impossible
    with an unbound mandatory check. `calls_jsonl` = explicit path of the current session log (else resolved with discover.py; ambiguity => unbound)."""
    md, js = report_names(handoff_path, existing)
    doc = bind_report(dict(doc, schema_version=SCHEMA_VERSION), calls_jsonl, run_dir, [handoff_path], require_version_identity, handoff_path, None, omission_contract)
    json.dump(doc, open(os.path.join(run_dir, js), "w"), indent=1, ensure_ascii=False)
    open(os.path.join(run_dir, md), "w").write(render_md(md_text, doc))
    return md, js

def sha256_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

def apply_patch(path, expected_sha256, new_content, approved, now=None):
    """Apply a patch to ONE file only after explicit per-file approval, with hash check and a non-overwriting backup <file>.bak-<UTC>."""
    if approved is not True:
        raise PermissionError("patch not approved for %s" % path)
    if sha256_file(path) != expected_sha256:
        raise RuntimeError("file changed since verification: hash mismatch")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    bak = "%s.bak-%s" % (path, now.strftime("%Y%m%dT%H%M%SZ"))
    n = 0
    while os.path.exists(bak):
        n += 1; bak = "%s.bak-%s-%d" % (path, now.strftime("%Y%m%dT%H%M%SZ"), n)
    shutil.copy2(path, bak)
    open(path, "w").write(new_content)
    return bak

#!/usr/bin/env python3
"""Version identity and the delivered-version gate (R02). Stdlib only, read-only: it parses Claude Code JSONL transcripts and files and never executes anything it reads.

A handoff VERSION is one successful Write/Edit of a path, reconstructed with slice.reconstruct (Edit on an unknown base / ambiguous Edit stays `content not recoverable`).
`source_session_jsonl` = the transcript where the handoff was written; `calls_session_jsonl` = the transcript holding the real Jev calls. They are the same file for a handoff generated
in the current session (chronology applies: a call verifies a version only after that write and before the next write/edit of the same path) and different files for the retrospective
verification of a saved session (no cross-transcript chronology). A check names the version it evaluates with `version_ref` = {write_tool_use_id, sha256, evaluated_against}; the model never types
those values: it copies them from `versions.py list`. Absent or inconsistent identity is never deduced from the last listed version nor from the call's window.

CLI:
  versions.py list   [--source ID|PATH.jsonl] --file HANDOFF [--evaluated-against prefix|session_end] [--cwd DIR]   exit 0 unambiguous, 3 absent/ambiguous source or unidentifiable path
  versions.py status [--session ID|PATH.jsonl] --file HANDOFF --report R.verify.json [--cwd DIR]                  exit 0 verified_version, 2 needs_reverification, 3 unresolved
`verified_version` = the delivered (last) version has a valid report with >= 1 genuinely bound check; it does NOT mean PASS."""
import argparse, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover as D, slice as SL, jevref as J, omissions as O

EVALUATED = ("prefix", "session_end")

def sha256_text(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

def _items(source_jsonl):
    items, _ = D.inventory(source_jsonl, "session")
    return items

def resolve_path(items, path, source_path=None):
    """-> (canonical path | None, how, note). The requested path must be, by canonical identity (realpath), a path written in the source transcript. A basename match is NEVER accepted.
    Retrospective relocation (the saved session wrote /work/x/handoff.md, the copy being verified lives elsewhere) needs an explicit `source_path` = the written path (the report's
    `handoff.source_path`, printed as `path` by `versions.py list`); the caller must additionally verify the copy's bytes against the version hash (bind_versions does)."""
    written = {os.path.realpath(i["path"]) for i in items}
    real = os.path.realpath(path)
    if real in written: return real, "realpath", None
    if isinstance(source_path, str) and source_path:
        sp = os.path.realpath(source_path)
        if sp in written: return sp, "relocated", None
        return None, "none", "handoff.source_path %s was not written in the source session" % source_path
    return None, "none", "%s is not (by canonical path) a file written in the source session%s" % (path, "; written: %s" % sorted(written)[:5] if written else "")

def versions_of(source_jsonl, path, source_path=None):
    """-> (versions, canonical_path, how, note). version = dict(version, write_tool_use_id, uuid, index, pos, result_pos, op, status, reason, content, sha256, next_index, next_pos).
    `index` = 1-based ordinal of the write's tool_use among ALL tool_use blocks; `pos`/`result_pos` = positions of the write's tool_use and tool_result on the common event timeline
    (jevref.timeline); `next_pos` = `pos` of the next successful write/edit of the path (None = last). Complete, demonstrable Reads of the same path (discover.reads) are passed to
    slice.reconstruct as the base of an Edit; partial or unstructured Reads are not."""
    items = _items(source_jsonl)
    canon, how, note = resolve_path(items, path, source_path)
    if canon is None: return [], None, how, note
    its = sorted([i for i in items if os.path.realpath(i["path"]) == canon], key=lambda x: x["index"])
    rds = [dict(r, path=canon) for r in D.reads(source_jsonl) if r["complete"] and isinstance(r["path"], str) and os.path.realpath(r["path"]) == canon]
    vs, op = SL.reconstruct(its, rds), {i["tool_use_id"]: i for i in its}
    out = [dict(version=v["version"], write_tool_use_id=v["tool_use_id"], uuid=v["uuid"], index=v["index"], pos=op[v["tool_use_id"]].get("pos"), result_pos=op[v["tool_use_id"]].get("result_pos"), op=op[v["tool_use_id"]]["op"],
                status=v["status"], reason=v["reason"], content=v["content"], sha256=sha256_text(v["content"]) if v["content"] is not None else None) for v in vs]
    for k, v in enumerate(out): v["next_index"] = out[k + 1]["index"] if k + 1 < len(out) else None; v["next_pos"] = out[k + 1]["pos"] if k + 1 < len(out) else None
    return out, canon, how, (None if out else "no successful Write/Edit of %s in the source session" % os.path.basename(path))

def relocation_candidate(source_jsonl, path):
    """Explicit retrospective relocation for `versions.py list`: the file at `path` is a COPY of a handoff written elsewhere in the source session. -> (written path | None, note). Demonstrated only when
    exactly one written path has the same basename AND the bytes at `path` hash to a recoverable version of that written path. The report must then carry that path as `handoff.source_path`."""
    items = _items(source_jsonl); cand = sorted({os.path.realpath(i["path"]) for i in items if os.path.basename(i["path"]) == os.path.basename(path)})
    if len(cand) != 1: return None, "no unique written path named %s in the source session (%s)" % (os.path.basename(path), cand)
    try: sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    except OSError: return None, "the copy %s cannot be read: relocation not verified" % path
    if sha in {v["sha256"] for v in versions_of(source_jsonl, path, cand[0])[0] if v["sha256"]}: return cand[0], None
    return None, "the bytes of %s do not hash to any recoverable version of %s" % (path, cand[0])

def version_ref(v, evaluated_against="session_end"):
    return dict(write_tool_use_id=v["write_tool_use_id"], sha256=v["sha256"], evaluated_against=evaluated_against)

def replay_all(source_jsonl):
    """tool_use_id -> (content | None, sha256 | None) of EVERY successful Write/Edit of the transcript, per path, via slice.reconstruct (shared with the skill: one implementation),
    with the demonstrably complete Reads of the same path as Edit bases."""
    items = _items(source_jsonl); rds = [r for r in D.reads(source_jsonl) if r["complete"] and isinstance(r["path"], str)]; out = {}
    for real in {os.path.realpath(i["path"]) for i in items}:
        base = [dict(r, path=real) for r in rds if os.path.realpath(r["path"]) == real]
        for v in SL.reconstruct(sorted([i for i in items if os.path.realpath(i["path"]) == real], key=lambda x: x["index"]), base):
            out[v["tool_use_id"]] = (v["content"], sha256_text(v["content"]) if v["content"] is not None else None)
    return out

def _identity(path):
    """(session ids named in the transcript metadata, {tool_use_id: (tool name, input hash)}) of a JSONL transcript or stream; ({}, {}) when unreadable."""
    sids, tools = set(), {}
    try:
        for d in D.load_jsonl(path):
            for k in ("sessionId", "session_id"):
                if isinstance(d.get(k), str): sids.add(d[k])
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            if d.get("type") == "assistant" and isinstance(msg.get("content"), list):
                for b in msg["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_use": tools[b["id"]] = (b.get("name"), J.input_hash(b.get("input")))
    except OSError: return set(), {}
    return sids, tools

def same_session(report_source, calls_path, session_id=None):
    """Is the report's `session.jsonl` the CURRENT (calls) transcript? Demonstrated only by (a) the same file (realpath), or (b) a copy/stream of the same session: both files exist, their real
    metadata name a common session id (and `session_id`, when given, is named by the report's transcript) and their tool_use records correspond (same ids with the same tool and input,
    one transcript contained in the other, at least one in common). A path that does not exist, or a file with the same basename/stem but another content, is NOT evidence."""
    if not isinstance(report_source, str) or not report_source or not isinstance(calls_path, str) or not os.path.isfile(report_source) or not os.path.isfile(calls_path): return False
    if os.path.realpath(report_source) == os.path.realpath(calls_path): return True
    sa, ta = _identity(report_source); sb, tb = _identity(calls_path)
    if session_id: sid_ok = session_id in sa and (not sb or session_id in sb)
    else: sid_ok = bool(sa & sb)
    common = set(ta) & set(tb)
    return bool(sid_ok and common and all(ta[i] == tb[i] for i in common) and (set(ta) <= set(tb) or set(tb) <= set(ta)))

def validate_ref(ref, vs, call=None, same=False):
    """-> (kind, reason, version). kind: ok | absent | inconsistent | window | unrecoverable. call = the bound Jev call (dict with pos/result_pos on the transcript's event timeline, same transcript only).
    Window (R02 contract): the call's tool_use comes after the version's write result and the call's RESULT arrives before the next successful write/edit of the same path."""
    if not isinstance(ref, dict): return "absent", "no version_ref: version identity absent", None
    wid, sh, ev = ref.get("write_tool_use_id"), ref.get("sha256"), ref.get("evaluated_against")
    if not isinstance(wid, str) or not isinstance(sh, str) or ev not in EVALUATED: return "inconsistent", "malformed version_ref (write_tool_use_id, sha256, evaluated_against prefix|session_end)", None
    v = next((x for x in vs if x["write_tool_use_id"] == wid), None)
    if v is None: return "inconsistent", "version_ref.write_tool_use_id is not a write of this handoff in the source transcript", None
    if v["status"] != "ok" or v["sha256"] is None: return "unrecoverable", "version content not recoverable (%s)" % v["reason"], v
    if v["sha256"] != sh: return "inconsistent", "version_ref.sha256 differs from the reconstructed version", v
    if same and call is not None:
        cp, cr, start = call.get("pos"), call.get("result_pos"), v.get("result_pos") or v.get("pos")
        if not (isinstance(cp, int) and isinstance(cr, int) and isinstance(start, int) and cp > start and (v.get("next_pos") is None or cr < v["next_pos"])):
            return "window", "call or its result is outside the window of the referenced version (call after its write; result before the next write/edit of the same path)", v
    return "ok", "ok", v

def bind_versions(checks, bindings, handoff_path, source_jsonl, calls, same, source_path=None):
    """-> {check id: dict(kind, ok, reason, version, sha256, write_tool_use_id, text)} for every BOUND check. Unbound checks have no row (they are unresolved already).
    `source_path` (retrospective only, never with `same`): explicit relocation, additionally requires the bytes of the file at `handoff_path` to hash to a recoverable version of the written handoff."""
    cm = {c["tool_use_id"]: c for c in calls}
    vs, note, how, canon = [], None, "none", None
    try:
        vs, canon, how, note = versions_of(source_jsonl, handoff_path, None if same else source_path) if source_jsonl and os.path.isfile(source_jsonl) else ([], None, "none", "source transcript unavailable: provenance not demonstrated")
    except Exception as e:
        note = "source transcript unreadable: %s" % e
    disk = None
    if how == "relocated":
        try: disk = hashlib.sha256(open(handoff_path, "rb").read()).hexdigest()
        except OSError: disk = None
    rows = {}
    for c, b in zip(checks, bindings):
        if not b["bound"]: continue
        if not vs:
            kind, why, v = "inconsistent", note or "no versions of the handoff in the source transcript", None
        else:
            kind, why, v = validate_ref(c.get("version_ref"), vs, cm.get(b["tool_use_id"]), same)
            if kind == "ok" and how == "relocated" and disk not in {x["sha256"] for x in vs if x["sha256"]}: kind, why = "inconsistent", "relocated copy: the bytes at handoff.path do not hash to any recoverable version of the written handoff"
        row = dict(kind=kind, ok=kind == "ok", reason=why, version=v["version"] if v else None, sha256=v["sha256"] if v else None, write_tool_use_id=v["write_tool_use_id"] if v else None,
                   text=v["content"] if kind == "ok" else None, evaluated_against=(c.get("version_ref") or {}).get("evaluated_against") if isinstance(c.get("version_ref"), dict) else None)
        if kind == "ok" and canon and row["evaluated_against"] in EVALUATED:   # R03: what the omission pair is validated against (eligible source of THIS version, canonical material)
            try: row["omission"] = O.context(source_jsonl, canon, v, row["evaluated_against"], [os.path.dirname(handoff_path or ""), os.getcwd()] if handoff_path else [os.getcwd()])
            except Exception as e: row["omission"] = dict(eligible_source=None, material=None, material_reason="omission context unavailable: %s" % e)
        rows[b["id"]] = row
    return rows

def attach(bindings, rows):
    """Bindings with the version outcome: a bound check without a valid version identity becomes UNRESOLVED (never PASS); findings of a check validate quote_handoff against ITS version text."""
    out = []
    for b in bindings:
        r = rows.get(b["id"])
        if r is None: out.append(b); continue
        b = dict(b, version={k: r[k] for k in ("kind", "ok", "reason", "version", "sha256", "write_tool_use_id", "evaluated_against")})
        if r["ok"]:
            b["version_text"] = r["text"]
            if r.get("omission"): b.update(eligible_source=r["omission"]["eligible_source"], eligible_blocks=r["omission"].get("eligible_blocks"), omission_material=r["omission"]["material"], omission_material_reason=r["omission"]["material_reason"])
        else: b["resolved"] = False
        out.append(b)
    return out

def per_version(checks, bindings, findings, declared_unresolved, declared_versions, omission_contract=False):
    """Status/binding summary per WRITE (not per hash: A -> B -> A has two distinct writes of identical bytes), over the checks explicitly attributed to it by the verified version identity
    (`version.write_tool_use_id` + sha256). -> {write_tool_use_id: dict(sha256, write_tool_use_id, audited_status, binding_summary, evaluations={evaluated_against: dict(audited_status, binding_summary)})}.
    Checks and findings are never shared between writes with the same hash; the evaluations of one write against `prefix` and `session_end` are kept apart (the write-level status covers both).
    A declared version (handoff.versions entry) without checks of its own is not in the result: use `lookup` (UNRESOLVED stub)."""
    ok = [b for b in bindings if b.get("version") and b["version"]["ok"]]
    out = {}
    def summary(ids):
        cs = [c for c in checks if c.get("id") in ids]; bs = [b for b in bindings if b["id"] in ids]
        fs = [f for f in findings if isinstance(f, dict) and f.get("check_id") in ids]; un = [u for u in declared_unresolved if isinstance(u, dict) and u.get("check_id") in ids]
        ev = J.audited_status(cs, bs, fs, un, None, omission_contract)
        return dict(audited_status=ev["status"], binding_summary=dict(checks=ev["checks"], bound=ev["bound"], resolved=ev["resolved"], unbound=ev["unbound"], reasons=ev["reasons"], valid_findings=ev["valid_findings"]))
    ref_of = {c.get("id"): (c.get("version_ref") if isinstance(c.get("version_ref"), dict) else {}) for c in checks if isinstance(c, dict)}
    for wid in dict.fromkeys(b["version"]["write_tool_use_id"] for b in ok):
        mine = [b for b in ok if b["version"]["write_tool_use_id"] == wid]; ids = {b["id"] for b in mine}
        ev = dict(summary(ids), sha256=mine[0]["version"]["sha256"], write_tool_use_id=wid)
        ev["evaluations"] = {e: summary({i for i in ids if ref_of.get(i, {}).get("evaluated_against") == e}) for e in EVALUATED if any(ref_of.get(i, {}).get("evaluated_against") == e for i in ids)}
        out[wid] = ev
    return out

def write_ids(source_jsonl, path, source_path=None):
    """Ids of every successful write/edit of the handoff in the source transcript (None when it cannot be read)."""
    try: return {v["write_tool_use_id"] for v in versions_of(source_jsonl, path, source_path)[0]} if source_jsonl and os.path.isfile(source_jsonl) else None
    except Exception: return None

def lookup(pv, declared, writes=None):
    """The per_version entry of a declared handoff.versions entry: by its `tool_use_id` (the write id); the sha256 fallback is used ONLY when that id is not a known write of the transcript
    (`writes`; a placeholder id) and exactly one write with checks has that hash. A declared real write without checks of its own never borrows the checks of an earlier write with the same bytes.
    -> (entry | None, how)."""
    if not isinstance(declared, dict): return None, "malformed"
    tid = declared.get("tool_use_id")
    if tid in pv: return pv[tid], "write id"
    if writes is not None and tid in writes: return None, "no check of its own (a write with the same bytes does not transfer its checks)"
    cand = [e for e in pv.values() if e["sha256"] == declared.get("sha256")]
    if len(cand) == 1: return cand[0], "unique sha256"
    return None, "ambiguous sha256 (several writes)" if cand else "no check of its own"

def gate(calls_path, handoff_path, doc, disk_path=None, session_id=None, omission_contract="R04"):
    """The delivered-version gate (current contract R04; "R03" / False (R02) only when passed explicitly for a historical/baseline evaluation; `jevref.contract_of`). -> dict(delivery_state, current_sha256, latest_write_id, report_path?, audited_status, bound_checks_for_version, reasons). Same code for the CLI, the report
    writer and the auditor. `disk_path` = file whose bytes are compared (default: handoff_path)."""
    res = dict(delivery_state="unresolved", current_sha256=None, latest_write_id=None, audited_status=None, bound_checks_for_version=0, reasons=[])
    def fin(state, why): res["delivery_state"] = state; res["reasons"].append(why); return res
    try: vs, canon, how, note = versions_of(calls_path, handoff_path)
    except Exception as e: return fin("unresolved", "session transcript unreadable: %s" % e)
    if not vs: return fin("unresolved", note or "no successful Write/Edit of the handoff in this session")
    last = vs[-1]; res["latest_write_id"] = last["write_tool_use_id"]
    if last["status"] != "ok": return fin("unresolved", "the last version is not recoverable: %s" % last["reason"])
    dp = disk_path or handoff_path
    try: raw = open(dp, "rb").read()
    except OSError: return fin("unresolved", "the handoff file is absent on disk: %s" % dp)
    res["current_sha256"] = hashlib.sha256(raw).hexdigest()
    if res["current_sha256"] != last["sha256"]: return fin("unresolved", "bytes on disk differ from the last recorded write of this session (external change or unrecorded edit)")
    if not isinstance(doc, dict) or doc.get("schema_version") != "1" or not isinstance(doc.get("checks"), list) or not isinstance(doc.get("findings"), list): return fin("unresolved", "report missing or not schema v1")
    h = doc.get("handoff") if isinstance(doc.get("handoff"), dict) else {}
    if not isinstance(h.get("path"), str) or os.path.realpath(h["path"]) != os.path.realpath(handoff_path) or os.path.realpath(handoff_path) != canon: return fin("unresolved", "the report is about another handoff file (canonical path of the report, of the requested file and of the transcript writes must be identical)")
    src = (doc.get("session") or {}).get("jsonl")
    if not same_session(src, calls_path, session_id): return fin("unresolved", "the report's source session is not demonstrated to be the current session (a retrospective report cannot certify a current delivery)")
    calls = J.load_calls(calls_path); checks = doc["checks"]
    r03 = J.contract_of(omission_contract)   # the CURRENT contract is chosen by the evaluator (default R04: strict auxiliary conditions, explicit omission pair with the R04 absence half), never by a marker in the report; R03 / R02 only by an explicit selection (historical evaluation)
    bs = J.bind(checks, calls, r03); rows = bind_versions(checks, bs, handoff_path, calls_path, calls, True); bs2 = J.finalize(attach(bs, rows), doc["findings"], None, r03)
    ev = J.audited_status(checks, bs2, doc["findings"], doc.get("unresolved", []), None, r03)
    res["audited_status"] = ev["status"]
    if doc.get("status") != ev["status"]: return fin("unresolved", "stored report status %r differs from the recomputed %r (invalid or hand-edited report)" % (doc.get("status"), ev["status"]))
    # Identity validity comes BEFORE the verified_version branch: a valid check must not mask an absent/inconsistent/unrecoverable identity elsewhere in the same report. An unresolved check from
    # confidence/verdict (authentic UNRESOLVED, documents the verification done) is not an identity problem. A version_ref on an unbound check is validated too (it must not be wrong).
    invalid = {b["version"]["reason"] for b in bs2 if b["bound"] and b.get("version") and b["version"]["kind"] in ("absent", "inconsistent", "unrecoverable")}
    for c, b in zip(checks, bs):
        if not b["bound"] and isinstance(c, dict) and c.get("version_ref") is not None:
            k, why, _ = validate_ref(c["version_ref"], vs)
            if k != "ok": invalid.add("unbound check %s: %s" % (c.get("id"), why))
    if invalid: return fin("unresolved", "invalid version identity in the report: " + "; ".join(sorted(invalid)))
    good = [b for b in bs2 if b["bound"] and b.get("version") and b["version"]["ok"] and b["version"]["write_tool_use_id"] == last["write_tool_use_id"] and b["version"]["sha256"] == last["sha256"]]   # THIS write, not any write with the same bytes
    res["bound_checks_for_version"] = len(good)
    kinds = [(b["version"]["kind"], b["version"]["write_tool_use_id"]) for b in bs2 if b["bound"] and b.get("version")]
    if good and any(k == "window" for k, _ in kinds): return fin("unresolved", "a check of the report cites a call or result outside its version window: the report is inconsistent")
    if good: return fin("verified_version", "the delivered version %s has %d genuinely bound check(s) in a valid report" % (last["sha256"][:8], len(good)))
    if any(k == "window" for k, _ in kinds) or any(k == "ok" and w != last["write_tool_use_id"] for k, w in kinds):
        return fin("needs_reverification", "no genuinely bound check for the delivered version %s: the report verifies an earlier version or cites calls made before the last write/edit" % last["sha256"][:8])
    return fin("unresolved", "no bound check with a demonstrated version identity for the delivered version (identity absent, unrecoverable or no bound check)")

def _resolve(arg, cwd):
    sp, how, amb = D.resolve_session_info(arg, cwd)
    return sp, how, amb

def cmd_list(a):
    sp, how, amb = _resolve(a.source, a.cwd)
    if amb: print(json.dumps({"error": "source session not demonstrated: several recently modified sessions; pass --source ID or PATH.jsonl", "resolution": how})); return 3
    if not sp or not os.path.isfile(sp): print(json.dumps({"error": "source session not found", "arg": a.source})); return 3
    path = a.file if os.path.isabs(a.file) else os.path.join(a.cwd or os.getcwd(), a.file)
    vs, canon, pathhow, note = versions_of(sp, path)
    reloc = None
    if canon is None:
        reloc, rnote = relocation_candidate(sp, path)
        if reloc: vs, canon, pathhow, note = versions_of(sp, path, reloc)
        else: note = "%s; relocation: %s" % (note, rnote)
    if canon is None or not vs: print(json.dumps({"error": note or "path not identifiable", "source_session_jsonl": sp, "resolution": how})); return 3
    rows = []
    for v in vs:
        r = dict(version=v["version"], index=v["index"], uuid=v["uuid"], write_tool_use_id=v["write_tool_use_id"], op=v["op"], state=v["status"], sha256=v["sha256"])
        if v["status"] == "ok": r["version_ref"] = version_ref(v, a.evaluated_against)
        else: r["reason"] = v["reason"]
        rows.append(r)
    print(json.dumps(dict(source_session_jsonl=sp, resolution=how, path=canon, path_match=pathhow, handoff_source_path=reloc, evaluated_against=a.evaluated_against, versions=rows,
                          note="copy the version_ref object of the version you verify into each check; set handoff.path to `path` and session.jsonl to `source_session_jsonl`; when handoff_source_path is not null (the file is a verified copy of a handoff written elsewhere in that session) set handoff.path to the copy you were given and handoff.source_path to handoff_source_path"), indent=1, ensure_ascii=False)); return 0

def cmd_status(a):
    sp, how, amb = _resolve(a.session, a.cwd)
    def out(d, code): print(json.dumps(d, indent=1, ensure_ascii=False)); return code
    if amb or not sp or not os.path.isfile(sp):
        return out(dict(delivery_state="unresolved", current_sha256=None, latest_write_id=None, report_path=a.report, audited_status=None, bound_checks_for_version=0,
                        reasons=["current session not demonstrated (ambiguous: pass --session ID or PATH.jsonl)" if amb else "session not found"]), 3)
    path = a.file if os.path.isabs(a.file) else os.path.join(a.cwd or os.getcwd(), a.file)
    try: doc = json.load(open(a.report, encoding="utf-8"))
    except (OSError, ValueError) as e: doc = None
    g = gate(sp, path, doc, disk_path=path); g["report_path"] = a.report
    return out(g, {"verified_version": 0, "needs_reverification": 2}.get(g["delivery_state"], 3))

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("list"); l.add_argument("--source"); l.add_argument("--file", required=True); l.add_argument("--evaluated-against", choices=EVALUATED, required=True); l.add_argument("--cwd")
    s = sub.add_parser("status"); s.add_argument("--session"); s.add_argument("--file", required=True); s.add_argument("--report", required=True); s.add_argument("--cwd")
    a = ap.parse_args()
    return cmd_list(a) if a.cmd == "list" else cmd_status(a)

if __name__ == "__main__": sys.exit(main())

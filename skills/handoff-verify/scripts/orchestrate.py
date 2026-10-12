#!/usr/bin/env python3
"""Thin same-session orchestrator of the handoff-verify scripts (stdlib only, offline). It only chains the authoritative scripts in fixed order with explicit identities and keeps their outputs in a state directory; it makes no model request, no Jev call and no network call,
grants no approval, writes no review or outcome of its own and never changes the note. Every semantic decision (the review of each chunk, the Jev calls, the choice of the results that become checks, the report text) stays with the writer session; every validation stays in the
scripts it calls (prepare.py, versions.py, audit.py, omissions.py, checks.py, report.write_report). Nothing in a note or a transcript is ever executed.
commands (JSON on stdout; exit 0 = done, 2 = session not found, or `needs_reverification` of the gate (finalize), 3 = refused or not a success):
  prepare --session ID|PATH --file NOTE --cwd DIR --state DIR [--evaluated-against prefix|session_end [--run ID]] [--previous-state DIR] [--expect-sha256 H] [--location DIR ...] [--context-tokens N [--window 1000000] [--guard 500000]]
      identities (the latest RECORDED write of the note, which must be what is on disk), the transcript chunks (prepare.py) and the UNREVIEWED audit template (audit.py template); a fresh --state per version.
  package --state DIR --spec FILE
      model-free preparation of the omission candidates the writer REGISTERED (audit.py register) with omissions.py prepare-batch (ledger kept in the state); a refusal is printed, never cleared.
  finalize --state DIR --spec FILE
      spec = {"check_specs": [...], "doc": {...}, "audit_block": {...}, "md": "..." | "md_file": PATH}: checks.py build on the selected real Jev results, report.write_report, then versions.py status. Success = complete audit AND status PASS AND verified_version.
  edit-preflight --state DIR --expected-sha256 H --approved
      after the user's per-file approval of the diff: hash-checks the verified version and makes the non-overwriting backup; the note is NOT replaced (the writer performs a recorded Edit, then runs `prepare` with a new --state and --previous-state)."""
import argparse, datetime, difflib, hashlib, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, discover as D, report as R

FORMAT = 1
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
WINDOW, GUARD = 1000000, 500000      # the context window and the guard the user declared; a count is accepted only when it is given (nothing is read from usage records)

DOC_TEMPLATE = dict(variant=dict(name="orchestrated"), environment=dict(model="unknown"), kit=dict(status="not run by orchestrate.py", exit=None, skips=[]), cost=dict(tokens="unavailable", usd="unavailable", wall_s="unavailable"), patch=dict(proposed=False, approved=False),
                    findings=[], unresolved=[], scope_exclusions=[], status="UNRESOLVED")      # the report properties the schema requires besides the identities, the checks and the audit: "unknown" / "unavailable" / "not run" defaults, no claim about the work; the writer edits them (findings, unresolved, scope_exclusions after the scope filter, kit, environment, patch); the status is recomputed whatever is claimed

HINT_WINDOW = "an earlier command of this session names a skill script through a shell variable or a path that cannot be resolved, so the verification run it belongs to is not demonstrated; that history cannot be changed, so this session cannot certify a later version. Write every skill-script path literally and absolute"

def out(obj, code): print(json.dumps(obj, indent=1, ensure_ascii=False)); return code

def refuse(phase, reasons, code=3, **extra): return out(dict(ok=False, phase=phase, reasons=list(reasons), **extra), code)

def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def sha256_bytes(b): return hashlib.sha256(b).hexdigest()

def script(name, args):
    """Fixed local invocation of a sibling script -> (exit code, parsed stdout or None, tail of stderr)."""
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, name)] + [str(x) for x in args], capture_output=True, text=True, env=ENV)
    try: obj = json.loads(p.stdout)
    except ValueError: obj = None
    return p.returncode, obj, p.stderr.strip()[-300:]

def disk_sha(path):
    try:
        with open(path, "rb") as f: return sha256_bytes(f.read())
    except OSError: return None

def write_json(path, obj):
    fd, tmp = tempfile.mkstemp(prefix=".orch-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(obj, f, indent=1, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def load_state(state_dir):
    try:
        with open(os.path.join(state_dir, "state.json"), encoding="utf-8") as f: st = json.load(f)
    except (OSError, ValueError) as e: return None, ["state unreadable: %s" % e]
    if not isinstance(st, dict) or st.get("format") != FORMAT: return None, ["state has an unknown format"]
    return st, []

def save_state(state_dir, st): write_json(os.path.join(state_dir, "state.json"), st)

def identity(session, note, cwd, ev="prefix", run=None):
    """-> (identity of the LATEST recorded write of the note, problems). The note on disk must be exactly that write: bytes that no recorded Write/Edit explains are never certifiable. `ev` = the window the version is judged in (`prefix`: the transcript up to its write;
    `session_end`: up to the start of the verification run that follows it, `run` names that run when several follow)."""
    code, o, err = script("versions.py", ["list", "--source", session, "--file", note, "--evaluated-against", ev, "--cwd", cwd] + (["--run", run] if run else []))
    if code != 0 or not isinstance(o, dict) or not o.get("versions"): return None, [(o or {}).get("error") or "versions.py list failed: %s" % (err or "no versions")]
    last = o["versions"][-1]; probs = list(o.get("blockers") or [])
    if last.get("state") != "ok" or "version_ref" not in last: probs.append("the latest recorded write is not usable: %s" % last.get("reason", last.get("state")))
    if ev == "session_end" and last.get("window"): probs.append(str(last["window"]))      # several runs follow the write and none is named: the evaluated run is not demonstrated
    disk = disk_sha(note)
    if disk is None: probs.append("the note cannot be read")
    elif disk != last.get("sha256"): probs.append("bytes on disk differ from the last recorded write (an Edit that was not recorded, or an external change): nothing is certifiable")
    return dict(version=last["version"], write_id=last["write_tool_use_id"], op=last.get("op"), sha256=last.get("sha256"), version_ref=last.get("version_ref"), canonical_path=o.get("path"), versions_total=len(o["versions"])), probs

def revalidate(st):
    """Authoritative identities are re-derived at every phase: a state is never trusted for them."""
    sp = st["session"]["jsonl"]
    if not D.source_exists(sp): return ["the session transcript is gone"]
    ident, probs = identity(sp, st["note"], st["cwd"], st.get("evaluated_against", "prefix"), st.get("run"))
    if ident is None: return probs
    v = st["version"]
    if (ident["write_id"], ident["sha256"]) != (v["write_id"], v["sha256"]): probs.append("the note has a newer recorded write than this state (%s): start a fresh cycle with `prepare`" % ident["write_id"])
    return probs

def registered(st):
    """-> the set of detail hashes registered (audit.py register) for THIS evaluation: another version, mode or run does not count."""
    k = (st["version"]["write_id"], st["version"]["sha256"], st.get("evaluated_against", "prefix"), st.get("run"))
    with open(st["registry"], encoding="utf-8") as f: doc = json.load(f)
    return {c.get("detail_sha256") for c in doc.get("candidates", []) if A.applicable(c, k)}

def context_of(tokens, window, guard):
    if tokens is None: return dict(state="unknown", note="no reliable count was given: nothing is guessed or taken from usage records")
    c = dict(tokens=tokens, window=window, guard=guard, share_of_window=round(tokens / window, 3))
    if tokens > guard: c.update(high_context_risk=True, note="above the guard: every model turn of this run re-reads this context (cost = turns x context). The run continues in this session; this script reduces neither the audit nor the mandatory reading")
    return c

def cmd_prepare(a):
    state_dir = os.path.abspath(a.state)
    if os.path.exists(os.path.join(state_dir, "state.json")): return refuse("prepare", ["the state already exists: a new version needs a fresh --state"])
    cwd = os.path.abspath(a.cwd); note = a.file if os.path.isabs(a.file) else os.path.join(cwd, a.file)
    sp, how, amb = D.resolve_session_info(a.session, cwd)
    if amb or not sp or not D.source_exists(sp): return refuse("prepare", ["session not found or not demonstrated: pass --session ID or PATH.jsonl"], 2)
    ev = a.evaluated_against; ident, probs = identity(sp, note, cwd, ev, a.run); prev = None
    if a.previous_state:
        prev, why = load_state(os.path.abspath(a.previous_state))
        if prev is None: probs += why
        else:
            pe, pv = prev.get("edit_preflight"), prev["version"]
            if os.path.realpath(prev["note"]) != os.path.realpath(note) or prev["session"]["jsonl"] != sp: probs.append("the previous state is about another note or another session")
            if not pe: probs.append("the previous state has no approved edit-preflight: no approval step is recorded")
            if prev.get("finalized") is None: probs.append("the previous state was never finalized")
            if ident and ident["sha256"] == pv["sha256"]: probs.append("the note is still the verified base: no Edit was recorded")
            if ident and ident["version"] <= pv["version"]: probs.append("no recorded write after the verified base")
            elif ident and ident["version"] != pv["version"] + 1: probs.append("%d recorded writes since the verified base: the approval covered one change (use one Edit, MultiEdit or Write)" % (ident["version"] - pv["version"]))
    if ident and a.expect_sha256 and ident["sha256"] != a.expect_sha256: probs.append("the recorded write is not the intended content (sha256 %s, expected %s)" % (ident["sha256"], a.expect_sha256))
    if probs: return refuse("prepare", probs)
    os.makedirs(state_dir, exist_ok=True); work = os.path.join(state_dir, "work")
    code, prep, err = script("prepare.py", [sp, "--cwd", cwd, "--target", note, "--out", work] + [x for l in a.location for x in ("--location", l)])
    if code != 0 or not isinstance(prep, dict): return refuse("prepare", [(prep or {}).get("error") or "prepare.py failed: %s" % err])
    try:
        with open(os.path.join(work, "coverage.json"), encoding="utf-8") as f: cov = json.load(f)
    except (OSError, ValueError) as e: return refuse("prepare", ["coverage.json unreadable: %s" % e])
    run = (ident["version_ref"] or {}).get("run") or a.run
    code, tpl, err = script("audit.py", ["template", "--source", sp, "--file", note, "--write-id", ident["write_id"], "--evaluated-against", ev, "--cwd", cwd] + (["--run", run] if run else []))
    if code != 0 or not isinstance(tpl, dict) or not tpl.get("ok"):
        why = (tpl or {}).get("reason") or "audit.py template failed: %s" % err
        return refuse("prepare", [why] + ([HINT_WINDOW] if "source window ambiguous" in why else []))
    tpath = os.path.join(state_dir, "audit-template.json"); write_json(tpath, tpl)
    st = dict(format=FORMAT, created=now(), session=dict(jsonl=sp, session_id=D.session_label(sp)), cwd=cwd, note=note, evaluated_against=ev, run=run, locations=list(a.location), version=ident, work=work, audit_template=tpath, registry=tpl.get("registry"),
              chunks=[dict(index=c["index"], sha256=c["sha256"]) for c in cov.get("chunk_list", [])], previous=os.path.abspath(a.previous_state) if a.previous_state else None, finalized=None, edit_preflight=None)
    save_state(state_dir, st); dpath = os.path.join(state_dir, "doc-template.json"); write_json(dpath, DOC_TEMPLATE); change = None
    if prev and (prev.get("edit_preflight") or {}).get("backup"):
        try:
            with open(prev["edit_preflight"]["backup"], encoding="utf-8") as f1, open(note, encoding="utf-8") as f2: change = "".join(list(difflib.unified_diff(f1.readlines(), f2.readlines(), "verified base", "current", n=1))[:80])[:4000]
        except (OSError, UnicodeDecodeError) as e: change = "unavailable: %s" % e
    window_note = "the audit covers the transcript up to the note's write; a request made after the write and before the verification is NOT in this window (use --evaluated-against session_end for the window up to the verification run)" if ev == "prefix" else "the audit covers the transcript up to the start of the verification run that follows the write"
    return out(dict(ok=True, phase="prepare", state=state_dir, session=st["session"], note=note, version=ident, window=dict(evaluated_against=ev, run=run, note=window_note), change_since_verified_base=change, work=work, audit_template=tpath, doc_template=dpath, transcript_chunks=len(st["chunks"]), audit_chunks_expected=len(tpl.get("block", {}).get("chunks", [])), coverage_complete=cov.get("complete"),
                    expected_candidates=len(tpl.get("expected_candidates", [])), blockers=prep.get("blockers", []), context=context_of(a.context_tokens, a.window, a.guard),
                    next="review EVERY chunk of work/transcript/ for the nine categories (the template lists them; unread chunks stay unreviewed), register candidates with audit.py register, then package / the Jev calls / finalize"), 0)

def cmd_package(a):
    state_dir = os.path.abspath(a.state); st, why = load_state(state_dir)
    if st is None: return refuse("package", why)
    probs = revalidate(st)
    if probs: return refuse("package", probs)
    try:
        with open(a.spec, encoding="utf-8") as f: spec = json.load(f)
    except (OSError, ValueError) as e: return refuse("package", ["spec unreadable: %s" % e])
    items = spec.get("omissions") if isinstance(spec, dict) else None
    if not isinstance(items, list) or not items: return refuse("package", ['spec must be {"omissions": [{"detail", "source_quote"}, ...]}'])
    try: reg = registered(st)
    except (OSError, ValueError, TypeError, KeyError) as e: return refuse("package", ["the candidate registry is unreadable: %s" % e])
    missing = [i for i, x in enumerate(items) if isinstance(x, dict) and isinstance(x.get("detail"), str) and A.detail_sha(x["detail"]) not in reg]
    if missing: return refuse("package", ["candidate(s) %s were not registered with audit.py register for this version and window before the preparation: a detail is registered BEFORE any filtering" % missing])
    pkg = os.path.join(state_dir, "package"); os.makedirs(pkg, exist_ok=True); sfile = os.path.join(pkg, "omissions-spec.json"); write_json(sfile, items)
    code, res, err = script("omissions.py", ["prepare-batch", "--source", st["session"]["jsonl"], "--file", st["note"], "--write-id", st["version"]["write_id"], "--evaluated-against", st.get("evaluated_against", "prefix"), "--spec", sfile, "--cwd", st["cwd"], "--ledger", os.path.join(state_dir, "ledger.json")] + (["--run", st["run"]] if st.get("run") else []) + [x for l in st.get("locations", []) for x in ("--location", l)])
    if not isinstance(res, list): return refuse("package", ["omissions.py prepare-batch failed: %s" % ((res or {}).get("reasons") if isinstance(res, dict) else err)])
    rpath = os.path.join(pkg, "omissions-batch.json"); write_json(rpath, res)
    refused = [dict(index=i, reasons=r.get("reasons") or [r.get("reason")]) for i, r in enumerate(res) if not (isinstance(r, dict) and r.get("ok"))]
    return out(dict(ok=not refused, phase="package", batch=rpath, ledger=os.path.join(state_dir, "ledger.json"), candidates=len(res), refused=refused,
                    next="copy the claims, the material and the write id from the batch into the Jev calls (never type them); a refused candidate stays refused"), 0 if not refused else 3)

def read_text(spec):
    if isinstance(spec.get("md"), str): return spec["md"]
    if isinstance(spec.get("md_file"), str):
        with open(spec["md_file"], encoding="utf-8") as f: return f.read()
    return None

def cmd_finalize(a):
    state_dir = os.path.abspath(a.state); st, why = load_state(state_dir)
    if st is None: return refuse("finalize", why)
    probs = revalidate(st)
    if probs: return refuse("finalize", probs)
    try:
        with open(a.spec, encoding="utf-8") as f: spec = json.load(f)
        md_text = read_text(spec) if isinstance(spec, dict) else None
    except (OSError, ValueError) as e: return refuse("finalize", ["spec unreadable: %s" % e])
    if not isinstance(spec, dict) or not isinstance(spec.get("doc"), dict) or md_text is None or not isinstance(spec.get("audit_block"), dict): return refuse("finalize", ['spec must hold "doc" (object), "audit_block" (the reviewed block) and "md" or "md_file"'])
    sp, note, v = st["session"]["jsonl"], st["note"], st["version"]; specs = spec.get("check_specs") or []
    for i, c in enumerate(specs):
        if not isinstance(c, dict): return refuse("finalize", ["check spec %d is not an object" % i])
        if "version_ref" not in c: c["version_ref"] = v["version_ref"]
        elif c["version_ref"] != v["version_ref"]: return refuse("finalize", ["check spec %d names another version than the one verified here (%s): a check of an older version is never carried over" % (i, v["sha256"])])
    built = []
    if specs:
        cfile = os.path.join(state_dir, "check-specs.json"); write_json(cfile, specs)
        code, res, err = script("checks.py", ["build", "--session", sp, "--source", sp, "--file", note, "--spec", cfile, "--cwd", st["cwd"]])
        if code != 0 or not isinstance(res, dict) or not res.get("ok"): return refuse("finalize", ["checks.py build refused the selection"], errors=(res or {}).get("errors", err))
        built = res["checks"]
    doc = dict(spec["doc"], session=dict(session_id=st["session"]["session_id"], jsonl=sp, cwd=st["cwd"]), handoff=dict(path=note, versions=[]), checks=built, audit=dict(version=A.AUDIT_VERSION, evaluations=[spec["audit_block"]], registry=st["registry"]))
    run_dir, run_id = R.new_run_dir(st["cwd"], st["session"]["session_id"])
    md, js = R.write_report(run_dir, note, doc, md_text, calls_jsonl=sp); jpath = os.path.join(run_dir, js)
    code, g, err = script("versions.py", ["status", "--session", sp, "--file", note, "--report", jpath, "--cwd", st["cwd"]])
    with open(jpath, "rb") as f: raw = f.read()
    rep = json.loads(raw); au = (rep.get("binding_summary") or {}).get("audit") or {}; g = g or {}
    success = code == 0 and g.get("delivery_state") == "verified_version" and g.get("audited_status") == "PASS" and rep.get("status") == "PASS" and au.get("complete") is True
    fin = dict(run_id=run_id, report_json=jpath, report_md=os.path.join(run_dir, md), report_sha256=sha256_bytes(raw), note_sha256=disk_sha(note), delivery_state=g.get("delivery_state"), audited_status=g.get("audited_status"), status=rep.get("status"), audit_complete=au.get("complete") is True, success=success)
    st["finalized"] = fin; save_state(state_dir, st)
    return out(dict(ok=success, success=success, phase="finalize", report=dict(json=jpath, md=fin["report_md"], sha256=fin["report_sha256"], status=rep.get("status")), delivery=dict(state=g.get("delivery_state"), audited_status=g.get("audited_status"), bound_checks_for_version=g.get("bound_checks_for_version"), reasons=g.get("reasons", []), stale_notice=g.get("stale_notice")),
                    audit=dict(complete=fin["audit_complete"], unfinished=au.get("unfinished", {})), blockers=rep.get("blockers", []), reasons=(rep.get("binding_summary") or {}).get("reasons", []),
                    next="success: report the gate state and the Jev status; propose the patch" if success else "not a success: say plainly that the delivered version has no demonstrated PASS, with these reasons; nothing here lowers a threshold or clears a blocker"),
               0 if success else (2 if code == 2 else 3))

def cmd_edit_preflight(a):
    state_dir = os.path.abspath(a.state); st, why = load_state(state_dir)
    if st is None: return refuse("edit-preflight", why)
    probs = revalidate(st); fin = st.get("finalized"); v = st["version"]
    if not a.approved: probs.append("the per-file approval of the diff is not stated (--approved): nothing is backed up")
    if not fin: probs.append("this state has no report: finalize first")
    elif fin["note_sha256"] != v["sha256"]: probs.append("the note changed after the report was written")
    if a.expected_sha256 != v["sha256"]: probs.append("the approval is about another version (sha256 %s); the verified version is %s" % (a.expected_sha256, v["sha256"]))
    if probs: return refuse("edit-preflight", probs)
    try: bak = R.backup_only(st["note"], v["sha256"], True)
    except (PermissionError, RuntimeError, OSError) as e: return refuse("edit-preflight", [str(e)])
    st["edit_preflight"] = dict(backup=bak, base_sha256=v["sha256"], base_write_id=v["write_id"], at=now()); save_state(state_dir, st)
    return out(dict(ok=True, phase="edit-preflight", backup=bak, base_sha256=v["sha256"], base_write_id=v["write_id"],
                    next="make the approved change with ONE recorded Edit/Write of the writer's own tool (not apply_patch), check its result, then `prepare --state NEW --previous-state %s` and verify the new version from the start" % state_dir), 0)

def build_parser():
    ap = argparse.ArgumentParser(description="Thin same-session orchestrator of the handoff-verify scripts."); sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare"); p.add_argument("--session", required=True); p.add_argument("--file", required=True); p.add_argument("--cwd", required=True); p.add_argument("--state", required=True); p.add_argument("--previous-state", dest="previous_state"); p.add_argument("--evaluated-against", dest="evaluated_against", choices=("prefix", "session_end"), default="prefix"); p.add_argument("--run")
    p.add_argument("--expect-sha256", dest="expect_sha256"); p.add_argument("--location", action="append", default=[]); p.add_argument("--context-tokens", dest="context_tokens", type=int); p.add_argument("--window", type=int, default=WINDOW); p.add_argument("--guard", type=int, default=GUARD)
    for name in ("package", "finalize"): q = sub.add_parser(name); q.add_argument("--state", required=True); q.add_argument("--spec", required=True)
    e = sub.add_parser("edit-preflight"); e.add_argument("--state", required=True); e.add_argument("--expected-sha256", dest="expected_sha256", required=True); e.add_argument("--approved", action="store_true")
    return ap

def main(argv=None):
    a = build_parser().parse_args(argv)
    return {"prepare": cmd_prepare, "package": cmd_package, "finalize": cmd_finalize, "edit-preflight": cmd_edit_preflight}[a.cmd](a)

if __name__ == "__main__": sys.exit(main())

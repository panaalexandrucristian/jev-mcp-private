#!/usr/bin/env python3
"""Construction of report checks from deliberately selected REAL Jev results. Stdlib only, read-only: it parses Claude Code JSONL transcripts and files and never executes anything it reads.

Copying the exact `jev_ref.key` of a long `jev_compare` (both passages and the aspects) by hand is where checks get unbound. `build_checks` takes, per check, the (tool_use_id, result_index) the model selected, the expected tool,
the COMPLETE expected tool input and the demonstrated `version_ref`, and copies tool, verdict, confidence and the exact key from the recorded result. It refuses (all or nothing) when: the call is not unique or not of that
tool; the expected input is not the recorded input (its sha256 is derived with `jevref.input_hash`; a supplied `input_hash` must agree); the selected result is missing, unusable or does not carry its claim/aspect/id; a
(call, result) pair or a check id is used twice (in the batch or by an `existing` check); or the version identity is not demonstrated by versions.py (canonical path, reconstruction and sha256, `evaluated_against`, relocation
and, for the same session, the call/result window). A legitimately bound low-confidence check is built and stays unresolved. Nothing here replaces `report.write_report`, which rebinds every check and revalidates the versions.

CLI: checks.py build --spec SPEC.json [--session ID|PATH.jsonl|opencode:ID|opencode-db:/ABS/DB#ID] [--source ID|PATH.jsonl|...] --file HANDOFF [--source-path WRITTEN_PATH] [--existing CHECKS_OR_REPORT.json]
     [--session-id ID] [--cwd DIR] [--location DIR ...]
  SPEC.json = a list (or {"checks": [...]}) of {id, tool, tool_use_id, result_index, input, version_ref[, input_hash]}. --session = the session holding the Jev calls, --source = the session where the handoff was written.
  exit 0 = {"ok": true, "checks": [...]}, 3 = {"ok": false, "errors": [{index, id, reason}]} and nothing is built, 2 = session not found."""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevref as J

SPEC_KEYS = {"id", "tool", "tool_use_id", "result_index", "input", "input_hash", "version_ref"}

class CheckError(ValueError):
    """Everything wrong with a batch: `errors` = [{index, id, reason}]."""
    def __init__(self, errors):
        self.errors = errors
        super().__init__("; ".join("%s: %s" % (e["id"] if e.get("id") is not None else "spec %s" % e.get("index"), e["reason"]) for e in errors))

def _existing_refs(existing):
    ids, used = {}, {}
    for c in existing if isinstance(existing, (list, tuple)) else []:
        if not isinstance(c, dict): continue
        ids[c.get("id")] = True
        ref = c.get("jev_ref")
        if isinstance(ref, dict) and isinstance(ref.get("tool_use_id"), str) and isinstance(ref.get("result_index"), int): used.setdefault((ref["tool_use_id"], ref["result_index"]), c.get("id"))
    return ids, used

def _calls_context(calls, calls_path):
    """None when `calls_path` is demonstrated to be the readable session that records `calls` (every call, by tool_use_id and input hash, is found in it), else the reason it is not. The same-session chronology window
    must never be skipped because the context is missing, unreadable or another session's: a retrospective reading is chosen only by the session identity check, never by default."""
    import discover as D
    if not isinstance(calls_path, str) or not calls_path: return "calls session not demonstrated: calls_path (the transcript that records the Jev calls) is required"
    if not D.source_exists(calls_path): return "calls session not demonstrated: calls_path is not a readable transcript"
    try: rec = {(c["tool_use_id"], c["input_hash"]) for c in J.load_calls(calls_path)}
    except Exception: return "calls session not demonstrated: calls_path cannot be read as a transcript"
    if any((c.get("tool_use_id"), c.get("input_hash")) not in rec for c in calls): return "calls session not demonstrated: the given Jev calls are not recorded in calls_path"
    return None

def build_checks(specs, calls, source=None, file=None, calls_path=None, session_id=None, source_path=None, existing=(), work_locations=None):
    """-> list of checks {id, tool, verdict, confidence, jev_ref, version_ref}, in spec order, or raises CheckError listing EVERY problem (nothing is returned for a partly valid batch).
    calls = jevref.load_calls of the session holding the Jev calls; calls_path = the REQUIRED transcript that records `calls` (demonstrated, never defaulted: it decides `same session`, i.e. whether the chronology window applies, exactly as report.write_report does);
    source = the transcript where the handoff was written; file = the handoff path (the copy, with source_path = the written path, for a retrospective relocation)."""
    import versions as V
    errs = []
    def bad(i, spec, why): errs.append(dict(index=i, id=spec.get("id") if isinstance(spec, dict) and isinstance(spec.get("id"), str) else None, reason=why))
    if not isinstance(specs, list) or not specs: raise CheckError([dict(index=None, id=None, reason="the specs must be a non-empty list")])
    if not isinstance(source, str) or not source: raise CheckError([dict(index=None, id=None, reason="no source transcript: the version identity cannot be demonstrated")])
    if not isinstance(file, str) or not file: raise CheckError([dict(index=None, id=None, reason="no handoff file: the version identity cannot be demonstrated")])
    ctx = _calls_context(calls, calls_path)
    if ctx: raise CheckError([dict(index=None, id=None, reason=ctx)])
    by_id = {}
    for c in calls: by_id.setdefault(c["tool_use_id"], []).append(c)
    old_ids, old_used = _existing_refs(existing)
    seen_ids, seen_pairs, built, pending = set(), {}, [], []
    for i, sp in enumerate(specs):
        if not isinstance(sp, dict): bad(i, sp, "a spec must be an object"); continue
        unknown = sorted(set(sp) - SPEC_KEYS)
        if unknown: bad(i, sp, "unknown key(s) %s: tool, verdict, confidence and the jev_ref key are copied from the recorded result, never given" % unknown); continue
        cid, tool, tid, ri, inp = sp.get("id"), sp.get("tool"), sp.get("tool_use_id"), sp.get("result_index"), sp.get("input")
        if not isinstance(cid, str) or not cid: bad(i, sp, "id must be a non-empty string"); continue
        if cid in seen_ids: bad(i, sp, "duplicate check id in the batch"); continue
        seen_ids.add(cid)
        if cid in old_ids: bad(i, sp, "duplicate check id: an existing check already has it"); continue
        if not isinstance(tool, str) or not isinstance(tid, str) or not tid: bad(i, sp, "tool and tool_use_id must be strings"); continue
        if not isinstance(ri, int) or isinstance(ri, bool) or ri < 0: bad(i, sp, "result_index must be an integer >= 0"); continue
        if not isinstance(inp, dict): bad(i, sp, "input must be the complete expected tool input (an object)"); continue
        if not isinstance(sp.get("version_ref"), dict): bad(i, sp, "version_ref must be the object printed by versions.py list"); continue
        if "input_hash" in sp and not isinstance(sp["input_hash"], str): bad(i, sp, "input_hash must be a string"); continue
        found = by_id.get(tid, [])
        if not found: bad(i, sp, "tool_use_id not found among the session's Jev calls"); continue
        if len(found) > 1: bad(i, sp, "ambiguous call identity: %d recorded calls share tool_use_id %s" % (len(found), tid)); continue
        call = found[0]
        if J.norm_tool(tool) != call["tool"]: bad(i, sp, "tool %s is not the tool of the recorded call (%s)" % (tool, call["tool"])); continue
        h = J.input_hash(inp)
        if "input_hash" in sp and sp["input_hash"] != h: bad(i, sp, "input_hash differs from the hash derived from the expected input"); continue
        if h != call["input_hash"]: bad(i, sp, "expected input differs from the recorded call (input_hash %s != %s)" % (h[:12], call["input_hash"][:12])); continue
        ents, why = J.results_of(call)
        if why: bad(i, sp, why); continue
        e = next((x for x in ents if x["index"] == ri), None)
        if e is None: bad(i, sp, "result_index %d does not exist" % ri); continue
        if e.get("mismatch"): bad(i, sp, e["mismatch"]); continue
        if not isinstance(e.get("key"), str) or not isinstance(e.get("verdict"), str) or e.get("confidence") is None: bad(i, sp, "the selected result has no usable key, verdict and confidence"); continue
        if (tid, ri) in old_used: bad(i, sp, "result (%s, %d) is already used by the existing check %s" % (tid, ri, old_used[(tid, ri)])); continue
        if (tid, ri) in seen_pairs: bad(i, sp, "result (%s, %d) is already used by check %s of this batch" % (tid, ri, seen_pairs[(tid, ri)])); continue
        seen_pairs[(tid, ri)] = cid
        chk = dict(id=cid, tool="jev_" + call["tool"], verdict=e["verdict"], confidence=e["confidence"], jev_ref=dict(tool_use_id=tid, result_index=ri, key=e["key"]), version_ref=dict(sp["version_ref"]))
        built.append(chk); pending.append((i, sp))
    if built:   # binding and version identity are the validators of the report itself, applied to the batch before anything is returned
        same = V.same_session(source, calls_path, session_id)
        bs = J.bind(built, calls, "R04")
        rows = V.bind_versions(built, bs, file, source, calls, same, source_path, work_locations, [calls_path] if same else ())
        for (i, sp), b in zip(pending, bs):
            if not b["bound"]: bad(i, sp, "the check does not bind to the recorded call: %s" % b["reason"]); continue
            r = rows.get(b["id"])
            if r is None or not r["ok"]: bad(i, sp, "version identity not demonstrated: %s" % (r["reason"] if r else "no version row"))
    if errs: raise CheckError(sorted(errs, key=lambda x: (x["index"] if x["index"] is not None else -1)))
    return built

def build_parser():
    ap = argparse.ArgumentParser(description="Build report checks from selected real Jev results (copies tool, verdict, confidence and the exact jev_ref key)."); sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--spec", required=True); b.add_argument("--session"); b.add_argument("--source"); b.add_argument("--file", required=True); b.add_argument("--source-path", dest="source_path")
    b.add_argument("--existing"); b.add_argument("--session-id", dest="session_id"); b.add_argument("--cwd"); b.add_argument("--location", action="append", default=[])
    return ap

def main(argv=None):
    a = build_parser().parse_args(argv)
    import discover as D, omissions as O
    def out(obj, code): print(json.dumps(obj, indent=1, ensure_ascii=False)); return code
    try: spec = json.load(open(a.spec, encoding="utf-8"))
    except (OSError, ValueError) as e: return out(dict(ok=False, errors=[dict(index=None, id=None, reason="spec unreadable: %s" % e)]), 3)
    specs = spec.get("checks") if isinstance(spec, dict) else spec
    locs, why = O.check_locations(a.location)
    if why: return out(dict(ok=False, errors=[dict(index=None, id=None, reason=why)]), 3)
    cp, how, amb = D.resolve_session_info(a.session, a.cwd)
    if amb: return out(dict(ok=False, errors=[dict(index=None, id=None, reason="current session not demonstrated: several recently modified sessions; pass --session ID or PATH.jsonl")], resolution=how), 3)
    sp, shot, samb = D.resolve_session_info(a.source, a.cwd) if a.source else (cp, how, amb)
    if not cp or not D.source_exists(cp) or not sp or not D.source_exists(sp) or samb: return out(dict(ok=False, errors=[dict(index=None, id=None, reason="session or source not found or not demonstrated")]), 2)
    existing = []
    if a.existing:
        try: ex = json.load(open(a.existing, encoding="utf-8"))
        except (OSError, ValueError) as e: return out(dict(ok=False, errors=[dict(index=None, id=None, reason="existing checks unreadable: %s" % e)]), 3)
        existing = ex.get("checks", []) if isinstance(ex, dict) else ex
    path = a.file if os.path.isabs(a.file) else os.path.join(a.cwd or os.getcwd(), a.file)
    try: built = build_checks(specs, J.load_calls(cp), sp, path, cp, a.session_id, a.source_path, existing, locs)
    except CheckError as e: return out(dict(ok=False, errors=e.errors), 3)
    return out(dict(ok=True, checks=built, note="copy these checks into the report; report.write_report rebinds every check and revalidates the version identity"), 0)

if __name__ == "__main__": sys.exit(main())

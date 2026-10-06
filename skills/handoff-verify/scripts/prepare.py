#!/usr/bin/env python3
"""Deterministic preparation for handoff-verify (no Jev, no network, never executes handoff code).
usage: prepare.py [SESSION_ID|PATH.jsonl|opencode:ID|opencode-db:/ABS/DB#ID] [--cwd DIR] [--out DIR] [--max-chars N]
Writes into the run directory <session-cwd>/.handoff-verify/<session-id>/<run-id>/work/ (or --out):
  inventory.json         handoff candidates + dispositions (included_by_name / needs_jev_classify / failed / unlinked / excluded) + aliases/copies
  handoffs/<name>.v<N>.md  reconstructed versions (sanitized) ; versions[] in inventory.json carry sha256/uuid/timestamp/status/evaluated_against
  transcript/chunk-NNNN.txt sanitized transcript chunks, each line prefixed [uuid role pos]; chunks never straddle a version write position
  coverage.json          chunk registry proving the whole transcript is covered (+ sanitization counters)
Prints a compact JSON summary on stdout."""
import argparse, glob, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover as D, slice as SL, sanitize as S, report as R

def flatten(path, source):
    out = []
    for d in D.load_jsonl(path):
        if d.get("type") not in ("user", "assistant"): continue
        c = d.get("message", {}).get("content"); parts = []
        if isinstance(c, str): parts.append(c)
        else:
            for b in c or []:
                if not isinstance(b, dict): continue
                if b.get("type") == "text": parts.append(b.get("text", ""))
                elif b.get("type") == "tool_use": parts.append("[tool_use %s] %s" % (b["name"], json.dumps(b["input"], ensure_ascii=False)))
                elif b.get("type") == "tool_result":
                    cc = b.get("content"); cc = "".join(x.get("text", "") for x in cc if isinstance(x, dict)) if isinstance(cc, list) else str(cc)
                    parts.append("[tool_result%s] %s" % (" ERROR" if b.get("is_error") else "", cc))
        if parts: out.append(dict(uuid=d.get("uuid") or "no-uuid", role=d["type"], text=" ".join(parts), pos=(d.get("timestamp") or "", source, d["_line"]), file=path))
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("session", nargs="?"); ap.add_argument("--cwd"); ap.add_argument("--out"); ap.add_argument("--max-chars", type=int, default=9000)
    a = ap.parse_args()
    sp, how, ambiguous = D.resolve_session_info(a.session, a.cwd)
    if ambiguous: print(json.dumps({"error": "current session not demonstrated: several recently modified sessions in this project; pass the session id or .jsonl path", "resolution": how})); return 3
    if not sp or not D.source_exists(sp): print(json.dumps({"error": "session not found", "arg": a.session})); return 2
    sid = D.session_label(sp)
    files = [(sp, "session")] + [(f, "subagent") for f in D.subagent_files(sp)]
    items, bash = [], []
    for f, src in files:
        i, b = D.inventory(f, src); items += i; bash += b
    cwd0 = next((i["cwd"] for i in items if i.get("cwd")), a.cwd or os.getcwd())
    if a.out: work = a.out
    else:
        rd, run_id = R.new_run_dir(a.cwd or cwd0, sid); work = os.path.join(rd, "work")
    os.makedirs(os.path.join(work, "handoffs"), exist_ok=True); os.makedirs(os.path.join(work, "transcript"), exist_ok=True)
    cls = D.classify_candidates(items)
    # group by real path; identical copies share analysis, but every write keeps its own temporal evaluation
    by_real = {}
    for it in cls["included_by_name"] + cls["needs_jev_classify"]:
        by_real.setdefault(os.path.realpath(it["path"]), []).append(it)
    flat = sorted(sum((flatten(f, src) for f, src in files), []), key=lambda r: r["pos"])
    san_total = {"redactions": {}, "ambiguous_redacted": 0, "canary_leaks": []}
    inv_h, write_pos = [], []
    for real, its in sorted(by_real.items()):
        its = sorted(its, key=lambda x: (x.get("timestamp") or "", x["line"]))
        versions = SL.reconstruct(its)
        vrows = []
        for v, it in zip(versions, [i for i in its if i["success"]]):
            txt, rep = (S.sanitize(v["content"]) if v["content"] is not None else (None, {"redactions": {}, "ambiguous_redacted": 0}))
            for k, n in rep["redactions"].items(): san_total["redactions"][k] = san_total["redactions"].get(k, 0) + n
            san_total["ambiguous_redacted"] += rep["ambiguous_redacted"]
            fn = None
            if txt is not None:
                fn = "handoffs/%s.v%d.md" % (os.path.basename(real), v["version"])
                open(os.path.join(work, fn), "w", encoding="utf-8", newline="").write(txt)
            pos = (it.get("timestamp") or "", it["source"], it["line"]); write_pos.append(pos)
            vrows.append(dict(version=v["version"], file=fn, sha256=hashlib.sha256(v["content"].encode()).hexdigest() if v["content"] is not None else None, tool_use_id=v["tool_use_id"], uuid=v["uuid"],
                              timestamp=v["timestamp"], status=v["status"], reason=v["reason"], op=it["op"], write_pos=list(pos), sanitized_ambiguous=rep["ambiguous_redacted"],
                              evaluated_against="session_end" if v is versions[-1] else "prefix",
                              prefix_records=sum(1 for r in flat if r["pos"] < pos)))
        inv_h.append(dict(path=real, aliases=sorted({i["path"] for i in its if os.path.realpath(i["path"]) == real and i["path"] != real}), disposition="included_by_name" if D.name_matches(real) else "needs_jev_classify",
                          linked=True, versions=vrows, exists_now=os.path.exists(real)))
    # chunk the whole transcript; force a break at every handoff write position so prefixes are chunk-aligned
    chunks_meta, buf, size, n = [], [], 0, 0
    marks = sorted(write_pos)
    def flush():
        nonlocal buf, size, n
        if buf:
            fn = "transcript/chunk-%04d.txt" % n
            open(os.path.join(work, fn), "w", encoding="utf-8", newline="").write("".join(x[1] for x in buf))
            chunks_meta.append(dict(file=fn, uuids=[x[0] for x in buf], first_pos=list(buf[0][2]), last_pos=list(buf[-1][2]), chars=size)); buf, size, n = [], 0, n + 1
    mi = 0
    for r in flat:
        while mi < len(marks) and marks[mi] <= r["pos"]: flush(); mi += 1
        t, rep = S.sanitize("[%s %s] %s\n" % (r["uuid"], r["role"], r["text"]))
        for k, c in rep["redactions"].items(): san_total["redactions"][k] = san_total["redactions"].get(k, 0) + c
        san_total["ambiguous_redacted"] += rep["ambiguous_redacted"]
        for piece in [t[i:i + a.max_chars] for i in range(0, len(t), a.max_chars)] or [t]:
            if size + len(piece) > a.max_chars: flush()
            buf.append((r["uuid"], piece, r["pos"])); size += len(piece)
    flush()
    covered = {u for c in chunks_meta for u in c["uuids"]}
    cov = dict(records=len(flat), chunks=len(chunks_meta), uuids_in_chunks=len(covered), complete=covered == {r["uuid"] for r in flat}, sanitization=san_total,
               continuation="links not demonstrated: leafUuid only points inside the same file (results/PROTOCOL.md P1); sibling sessions are NOT included")
    json.dump(cov, open(os.path.join(work, "coverage.json"), "w"), indent=1)
    inv = dict(session=dict(session_id=sid, jsonl=sp, cwd=cwd0, subagents=[f for f, s in files if s == "subagent"]), handoffs=inv_h,
               needs_jev_classify=[dict(path=i["path"], tool_use_id=i["tool_use_id"], uuid=i["uuid"], excerpt_hint="read handoffs/ file; classify with jev_classify (>0.95 decides)") for i in cls["needs_jev_classify"]],
               failed_writes=[dict(path=i["path"], tool_use_id=i["tool_use_id"], op=i["op"]) for i in cls["failed"]],
               unlinked_bash=[dict(path=b["path"], tool_use_id=b["tool_use_id"], note="unlinked: created via Bash, no Write/Edit link") for b in bash],
               excluded_non_text=[i["path"] for i in cls["excluded_non_text"]], env_excluded=[i["path"] for i in items if S.is_excluded_file(i["path"])])
    json.dump(inv, open(os.path.join(work, "inventory.json"), "w"), indent=1)
    print(json.dumps(dict(work=work, session_id=sid, handoff_files=len(inv_h), versions=sum(len(h["versions"]) for h in inv_h), unlinked=len(inv["unlinked_bash"]), failed_writes=len(inv["failed_writes"]),
                          transcript_chunks=len(chunks_meta), transcript_complete=cov["complete"], needs_jev_classify=len(inv["needs_jev_classify"]))))
    return 0
if __name__ == "__main__": sys.exit(main())

"""Session discovery and Write/Edit inventory from Claude Code JSONL transcripts. Pure parsing; never executes anything."""
import glob, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevref as J

NAME_RX = re.compile(r"(?i)(^HANDOVER|^HANDOFF|^CONTINUE-HERE|handoff|handover)")
BASH_WRITE = re.compile(r"(?:>>?|\btee\s+(?:-a\s+)?)\s*([\"']?)([^\s\"'|;&<>]+\.(?:md|txt|markdown))\1")
TEXT_EXT = (".md", ".markdown", ".txt")

def projects_dir():
    return os.environ.get("CLAUDE_PROJECTS_DIR", os.path.expanduser("~/.claude/projects"))

def load_jsonl(path):
    out = []
    for i, l in enumerate(open(path, encoding="utf-8", errors="replace")):
        l = l.strip()
        if not l: continue
        try: d = json.loads(l)
        except Exception: continue
        d["_line"] = i + 1
        out.append(d)
    return out

def resolve_session_info(arg=None, cwd=None, window_s=120):
    """Returns (path, how, ambiguous). how: path | id | env:CLAUDE_SESSION_ID | heuristic_most_recent | none.
    Without an explicit path/id the current session is NOT demonstrated: the most recent jsonl of cwd's project dir is only a heuristic, and it is flagged ambiguous
    when another jsonl of the same project was modified within `window_s` seconds of it (concurrent sessions)."""
    if arg and arg.endswith(".jsonl") and os.path.isfile(arg): return os.path.abspath(arg), "path", False
    arg = arg or os.environ.get("CLAUDE_SESSION_ID")
    if arg:
        m = glob.glob(os.path.join(projects_dir(), "*", arg + ".jsonl"))
        return (m[0] if m else None), ("id" if arg != os.environ.get("CLAUDE_SESSION_ID") else "env:CLAUDE_SESSION_ID"), False
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd or os.getcwd()))
    cands = glob.glob(os.path.join(projects_dir(), slug, "*.jsonl"))
    if not cands: return None, "none", False
    best = max(cands, key=os.path.getmtime)
    return best, "heuristic_most_recent", any(c != best and os.path.getmtime(best) - os.path.getmtime(c) <= window_s for c in cands)

def resolve_session(arg=None, cwd=None):
    """arg: .jsonl path | session id | None (=current: env CLAUDE_SESSION_ID else most recent jsonl of cwd's project dir, see resolve_session_info). Returns path or None."""
    return resolve_session_info(arg, cwd)[0]

def subagent_files(session_path):
    d = os.path.splitext(session_path)[0] + os.sep + "subagents"
    return sorted(glob.glob(os.path.join(d, "*.jsonl")))

def _results(records):
    res = {}
    for d in records:
        if d.get("type") == "user" and isinstance(d.get("message", {}).get("content"), list):
            for c in d["message"]["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    res[c["tool_use_id"]] = {"is_error": bool(c.get("is_error")), "content": c.get("content"), "uuid": d.get("uuid"), "line": d["_line"]}
    return res

def inventory(path, source="session"):
    """Successful Write/Edit calls (success = correlated tool_result without is_error), plus failed ones flagged, plus Bash-only candidates."""
    recs = load_jsonl(path); res = _results(recs); upos, rpos = J.timeline(recs)
    items, bash, idx = [], [], 0
    for d in recs:
        if d.get("type") != "assistant": continue
        for c in d.get("message", {}).get("content", []):
            if not isinstance(c, dict) or c.get("type") != "tool_use": continue
            idx += 1
            meta = {"tool_use_id": c["id"], "uuid": d.get("uuid"), "timestamp": d.get("timestamp"), "cwd": d.get("cwd"),
                    "line": d["_line"], "index": idx, "pos": upos.get(c["id"]), "result_pos": rpos.get(c["id"]), "source": source, "file": path}
            if c["name"] in ("Write", "Edit") and "file_path" in c["input"]:
                r = res.get(c["id"])
                meta.update(op=c["name"], path=c["input"]["file_path"], result_found=r is not None,
                            success=bool(r) and not r["is_error"], result_uuid=(r or {}).get("uuid"))
                if c["name"] == "Write": meta["content"] = c["input"].get("content")
                else: meta.update(old_string=c["input"].get("old_string"), new_string=c["input"].get("new_string"),
                                  replace_all=bool(c["input"].get("replace_all")))
                items.append(meta)
            elif c["name"] == "Bash":
                cmd = c["input"].get("command", "")
                for m in BASH_WRITE.finditer(cmd):
                    bash.append({**meta, "op": "bash-redirect", "path": m.group(2), "linked": False})
    return items, bash

def reads(path):
    """Read tool calls of a transcript whose content is DEMONSTRABLY the complete file: the call has no offset/limit, the result is not an error and the recorded structured result
    (`toolUseResult` of a session log, `tool_use_result` of a stream-json) is a text file with startLine 1 and numLines == totalLines; the content comes from that structure (the
    `cat -n` text cannot tell whether the file ended with a newline, so a Read without the structure is NOT a base). -> [{index (tool_use ordinal, as in inventory), pos, path, content, complete}]"""
    recs = load_jsonl(path); out, idx, uses = [], 0, {}
    upos, rpos = J.timeline(recs)
    for d in recs:
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}; cont = msg.get("content")
        if d.get("type") == "assistant" and isinstance(cont, list):
            for c in cont:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    idx += 1
                    if c.get("name") == "Read" and isinstance(c.get("input"), dict): uses[c["id"]] = (idx, c["input"])
        elif d.get("type") == "user" and isinstance(cont, list):
            sr = d.get("toolUseResult", d.get("tool_use_result"))
            for c in cont:
                if not (isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in uses): continue
                i, inp = uses[c["tool_use_id"]]
                f = sr.get("file") if isinstance(sr, dict) else None
                fp = inp.get("file_path")
                complete = (isinstance(fp, str) and not c.get("is_error") and "offset" not in inp and "limit" not in inp and isinstance(sr, dict) and sr.get("type") == "text" and isinstance(f, dict)
                            and isinstance(f.get("content"), str) and f.get("startLine") == 1 and isinstance(f.get("numLines"), int) and f.get("numLines") == f.get("totalLines")
                            and (f.get("filePath") is None or os.path.realpath(f["filePath"]) == os.path.realpath(fp)))
                out.append(dict(index=i, pos=upos.get(c["tool_use_id"]), path=fp, content=f["content"] if complete else None, complete=bool(complete)))
    return out

def name_matches(path):
    return bool(NAME_RX.search(os.path.basename(path)))

def classify_candidates(items):
    """Split successful Write/Edit into: included_by_name, needs_jev_classify (text files with other names), excluded_non_text, failed."""
    out = {"included_by_name": [], "needs_jev_classify": [], "excluded_non_text": [], "failed": []}
    for it in items:
        if not it["success"]: out["failed"].append(it); continue
        p = it["path"]
        if name_matches(p): out["included_by_name"].append(it)
        elif p.lower().endswith(TEXT_EXT): out["needs_jev_classify"].append(it)
        else: out["excluded_non_text"].append(it)
    return out

def alias_info(path):
    """symlink resolved to real path; alias kept."""
    real = os.path.realpath(path)
    return {"path": path, "real": real, "is_alias": real != os.path.abspath(path), "exists": os.path.exists(real)}

def apply_classification(item, label, confidence):
    """jev_classify outcome handling. label in handoff|non-handoff|manual_review. >0.95 decides; else 'possible_handoff_unconfirmed'."""
    from report import passes
    if label == "handoff" and passes(confidence): return "included"
    if label == "non-handoff" and passes(confidence): return "excluded: non-handoff (confidence %s)" % confidence
    return "possible_handoff_unconfirmed"

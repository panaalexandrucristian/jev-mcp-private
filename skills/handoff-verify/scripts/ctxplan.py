#!/usr/bin/env python3
"""Context optimizer of the skill (offline, stdlib only, no model, no Jev, no network; it runs only when the user asks). It proposes MECHANICAL changes of the active documentation and PROVES that nothing is lost; a proposal it cannot prove is REFUSED, never allowed.
Two kinds only. move_block: a whole block of split_manifest.json goes to another declared file, its bytes kept, a pointer left behind. reflow: an over-long prose line is re-wrapped (one space becomes a newline, plus the item indent inside a list). No deduplication, no shortening, no rewording.
Proof: AFTER is built here from BEFORE and the operations, never read from the proposal. The inverse of AFTER must give every BEFORE file byte for byte, the words must be the same in the same order, the loading contract must hold. BEFORE is the active documentation as it stands, proven against the frozen baseline by split_skill.check.
usage: ctxplan.py propose --skill-dir D [--out F] | check --skill-dir D --proposal F | usage --session F.jsonl [--session ...] | apply --skill-dir D --proposal F --approve PATH --snapshot SHA256 [--headless]      (explanations are Romanian, JSON fields snake_case)"""
import argparse, collections, hashlib, json, os, re, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sanitize, split_skill as S

LONG, WIDTH, ROOT_CAP, SHOWN, SUMMARY_CAP, FULL_CAP = 1000, 160, 22000, 10, 8192, 262144
PROTECTED = ("head", "triggered", "checklist", "loading", "hard-rules", "statuses")      # these blocks stay in the root in v1
LIST = re.compile(r"^(?:[-*+]|\d+[.)])\s+")
SPANS = re.compile(r"`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|\"[^\"\n]*\"|«[^»\n]*»|<[^>\n]+>")      # code, link, quoted literal, tag: never broken inside
POINTER = "[block %s moved to %s]\n"
AFTER_CHECK = S.check      # does the layout AFTER still satisfy the manifest? (a hook so that a later manifest format can say yes to a recorded reflow)

def sha(b): return hashlib.sha256(b).hexdigest()

def refuse(code, detail=""): return {"code": code, "detail": detail}

def load(root, m=None):
    """-> ({name: bytes}, reasons): the active files under `root`, proven lossless against the baseline; any doubt about encoding or layout is a reason."""
    m = m or S.load_manifest(); why = [refuse("incomplete_manifest", p) for p in S.manifest_problems(m)] + [refuse("baseline_changed", p) for p in S.check(root, m)]
    files = {}
    for name in m["files"]:
        p = os.path.join(root, name)
        if os.path.islink(p) or os.path.islink(os.path.dirname(p)): why.append(refuse("markdown_ambiguous", "%s is a symlink" % name)); continue
        try: data = open(p, "rb").read(); data.decode("utf-8")
        except (OSError, UnicodeDecodeError): why.append(refuse("markdown_ambiguous", "%s: missing or not UTF-8" % name)); continue
        if data.startswith(b"\xef\xbb\xbf") or b"\r" in data: why.append(refuse("markdown_ambiguous", "%s: BOM or CR" % name))
        files[name] = data
    return files, why

def reflow_line(line):
    """-> (candidate break offsets, indent of the continuation lines) for a plain prose line, or a refusal code (str). A break is a single space outside code spans, links, quoted literals and tags, never before a token that could start a block."""
    if line[:1].isspace() or line[:1] in "#>|<" or line.startswith("```") or line != line.rstrip() or line.endswith("\\"): return "markdown_ambiguous"
    spans = [m.span() for m in SPANS.finditer(line)]
    if re.search("[`\"«»]", SPANS.sub("", line)): return "markdown_ambiguous"      # an unbalanced code span or quote
    lead = LIST.match(line); indent = lead.end() if lead else 0; out = []
    for j, ch in enumerate(line):
        if ch != " " or j < indent or not 0 < j < len(line) - 1 or line[j - 1] in " \\" or line[j + 1] == " " or any(a <= j < b for a, b in spans): continue
        tok = line[j + 1:].split(" ", 1)[0]
        if tok in ("-", "+", "*") or tok.startswith(("#", ">", "|", "<", "```")) or re.fullmatch(r"[-*_=]+|\d+[.)]", tok): continue
        out.append(j)
    return out, indent

def plan_breaks(line, cands):
    out, start = [], 0
    while len(line) - start > WIDTH:
        near = [j for j in cands if start < j <= start + WIDTH]; j = near[-1] if near else next((j for j in cands if j > start + WIDTH), None)
        if j is None: break
        out.append(j); start = j + 1
    return out

def wrap(line, breaks, indent):
    parts, prev = [], 0
    for j in breaks: parts.append(line[prev:j]); prev = j + 1
    return ("\n" + " " * indent).join(parts + [line[prev:]])

def touched(ops, m):
    """-> sorted names of the files the operations read or change."""
    sp = spans_of(m); names = set()
    for o in ops:
        if o.get("kind") == "reflow": names.add(o.get("file"))
        elif o.get("kind") == "move_block": names |= {o.get("to"), sp.get(o.get("block"), (None,))[0]}
    return sorted(n for n in names if n)

def spans_of(m):
    size = {x["id"]: x["bytes"] for x in m["blocks"] + m.get("additions", [])}; out = {}
    for name, ids in m["files"].items():
        off = 0
        for i in ids: out[i] = (name, off, off + size[i]); off += size[i]
    return out

def reflow_ops(name, text):
    """-> (ops, refused) for the lines of one file longer than LONG characters."""
    ops, refused, fence = [], [], False
    for n, line in enumerate(text.split("\n"), 1):
        if line.startswith("```"): fence = not fence
        if fence or len(line) <= LONG or line.startswith("```"): continue
        r = reflow_line(line)
        if isinstance(r, str): refused.append({"kind": "reflow", "file": name, "line": n, "reason": r}); continue
        b = plan_breaks(line, r[0])
        if b: ops.append({"kind": "reflow", "file": name, "line": n, "breaks": b, "indent": r[1]})
        else: refused.append({"kind": "reflow", "file": name, "line": n, "reason": "markdown_ambiguous"})
    return ops, refused

def forward(files, ops, m):
    """-> (AFTER files, added pointer bytes, reasons): the operations applied to BEFORE, each one checked against the rules above."""
    out, why, added, seen, work = dict(files), [], 0, set(), {}
    for o in ops:
        k = o.get("kind")
        if k == "reflow" and set(o) == {"kind", "file", "line", "breaks", "indent"} and o["file"] in files:
            lines = work.setdefault(o["file"], files[o["file"]].decode().split("\n")); key = (o["file"], o["line"])      # line numbers are those of BEFORE: a wrapped line stays one list item
            if key in seen: why.append(refuse("duplicate_mapping", "%s:%s" % key)); continue
            if not 0 < o["line"] <= len(lines): why.append(refuse("unknown_operation", "%s:%s: no such line" % key)); continue
            seen.add(key); r = reflow_line(lines[o["line"] - 1]); br = o["breaks"]
            if isinstance(r, str): why.append(refuse(r, "%s:%s" % key)); continue
            if not br or br != sorted(set(br)) or not set(br) <= set(r[0]) or o["indent"] != r[1]: why.append(refuse("non_whitespace_edit", "%s:%s: a break is not a lossless one" % key)); continue
            lines[o["line"] - 1] = wrap(lines[o["line"] - 1], br, o["indent"])
        elif k == "move_block" and set(o) == {"kind", "block", "to", "before_block", "from_offset", "to_offset", "length"} and len([x for x in ops if x.get("kind") == "move_block"]) == 1:
            sp = spans_of(m); ids = [b["id"] for b in m["blocks"]]
            if o["block"] not in ids: why.append(refuse("missing_block", str(o["block"]))); continue
            src, s, e = sp[o["block"]]
            if o["block"] in PROTECTED: why.append(refuse("protected_bytes_changed", o["block"])); continue
            if o["to"] not in files or o["to"] == src or (o["before_block"] and sp.get(o["before_block"], (None,))[0] != o["to"]): why.append(refuse("unreachable_reference", str(o["to"]))); continue
            pos = sp[o["before_block"]][1] if o["before_block"] else len(files[o["to"]]); ptr = (POINTER % (o["block"], o["to"])).encode()
            if (o["from_offset"], o["to_offset"], o["length"]) != (s, pos, e - s) or any(src == x.get("file") or o["to"] == x.get("file") for x in ops if x.get("kind") == "reflow"): why.append(refuse("non_whitespace_edit", "offsets differ or the files are shared with a reflow")); continue
            out[src] = files[src][:s] + ptr + files[src][e:]; out[o["to"]] = files[o["to"]][:pos] + files[src][s:e] + files[o["to"]][pos:]; added += len(ptr)
        else: why.append(refuse("unknown_operation", json.dumps(o, sort_keys=True)[:120]))
    for f, lines in work.items(): out[f] = "\n".join(lines).encode()
    return out, added, why

def inverse(after, ops):
    """-> BEFORE rebuilt from AFTER and the operations alone (independent of `forward`): newline plus indent back to one space, the moved block cut out of its new place and put back over its pointer."""
    out = dict(after)
    for f in {o["file"] for o in ops if o["kind"] == "reflow"}:
        lines, shift, res = out[f].decode().split("\n"), 0, []
        pending = sorted((o for o in ops if o["kind"] == "reflow" and o["file"] == f), key=lambda o: o["line"]); i = 0
        for o in pending:
            res += lines[i:o["line"] - 1 + shift]; n = len(o["breaks"]); res.append((" ").join([lines[o["line"] - 1 + shift]] + [lines[o["line"] + shift + k][o["indent"]:] for k in range(n)])); i = o["line"] + shift + n; shift += n
        out[f] = "\n".join(res + lines[i:]).encode()
    for o in (x for x in ops if x["kind"] == "move_block"):
        src = next(n for n, d in after.items() if (POINTER % (o["block"], o["to"])).encode() in d and n != o["to"]); ptr = (POINTER % (o["block"], o["to"])).encode()
        blk = after[o["to"]][o["to_offset"]:o["to_offset"] + o["length"]]; out[o["to"]] = after[o["to"]][:o["to_offset"]] + after[o["to"]][o["to_offset"] + o["length"]:]
        assert after[src][o["from_offset"]:o["from_offset"] + len(ptr)] == ptr; out[src] = after[src][:o["from_offset"]] + blk + after[src][o["from_offset"] + len(ptr):]
    return out

def contract_reasons(ops, m):
    why = []
    for o in (x for x in ops if x["kind"] == "move_block"):
        need = next((b.get("loading", {}).get("needed_at") for b in m["blocks"] if b["id"] == o["block"]), None); opens = m.get("opens", {}).get(o["to"])
        if not isinstance(need, int) or not isinstance(opens, int): why.append(refuse("unknown_loading_contract", "block %s -> %s: needed_at/opens not declared" % (o["block"], o["to"])))
        elif opens > need: why.append(refuse("loading_contract_weakened", "%s opens at step %d, block %s is needed at step %d" % (o["to"], opens, o["block"], need)))
    return why

def heads(files): return collections.Counter(l for d in files.values() for l in d.decode().split("\n") if l.startswith("#"))

def prove(root, prop, m=None):
    """-> (verdict, AFTER): verdict = {verdict: PROVEN|REFUSED, reasons, added_bytes, requires_manifest_change}. Fails closed: the first doubt is a reason, there is no warn level."""
    m = m or S.load_manifest(); files, why = load(root, m); ops = prop.get("operations") if isinstance(prop, dict) else None
    if not why and (prop.get("schema_version") != 1 or not isinstance(ops, list) or not ops or not isinstance(prop.get("snapshot"), dict)): why.append(refuse("unknown_operation", "not a proposal of schema_version 1"))
    if not why and not all(isinstance(o, dict) and o.get("kind") in ("reflow", "move_block") for o in ops): why.append(refuse("unknown_operation", "an operation of an unknown kind"))
    if not why and not set(touched(ops, m)) <= set(files): why.append(refuse("unreachable_reference", "an operation names a file that the manifest does not declare"))
    if not why and prop["snapshot"] != {n: sha(files[n]) for n in touched(ops, m)}:
        why.append(refuse("baseline_changed", "the files are not the ones the proposal was made for"))
    if why: return {"verdict": "REFUSED", "reasons": why, "added_bytes": 0, "requires_manifest_change": None}, None
    after, added, why = forward(files, ops, m)
    if not why:
        try: back = inverse(after, ops)
        except (IndexError, KeyError, StopIteration, AssertionError): back = None      # an AFTER that cannot be undone is a refusal, not a crash
        if back != files: why.append(refuse("missing_block", "the inverse of AFTER does not give BEFORE byte for byte"))
        moved = any(o["kind"] == "move_block" for o in ops); tok = lambda fs: collections.Counter(w for d in fs.values() for w in d.decode().split())
        if moved: ptr = collections.Counter(w for o in ops if o["kind"] == "move_block" for w in (POINTER % (o["block"], o["to"])).split()); same = tok(after) - ptr == tok(files) and tok(files) - tok(after) == collections.Counter()
        else: same = all(after[n].decode().split() == files[n].decode().split() for n in files)
        if not same: why.append(refuse("non_whitespace_edit", "the words differ"))
        if heads(after) != heads(files) + collections.Counter() and moved: why.append(refuse("unreachable_reference", "a heading was lost or doubled"))
        if len(after.get("SKILL.md", b"")) > ROOT_CAP: why.append(refuse("budget_exceeded", "SKILL.md is over %d bytes" % ROOT_CAP))
        why += contract_reasons(ops, m)
    with tempfile.TemporaryDirectory() as tmp:
        for n, d in (after or {}).items(): os.makedirs(os.path.dirname(os.path.join(tmp, n)), exist_ok=True); open(os.path.join(tmp, n), "wb").write(d)
        need = bool(AFTER_CHECK(tmp, m)) if not why else None
    return {"verdict": "REFUSED" if why else "PROVEN", "reasons": why, "added_bytes": added, "requires_manifest_change": need}, (None if why else after)

def propose(root, m=None):
    """-> {proposals, refused_operations}: one proposal per file for the reflow (apply takes one file), the move_block ones only when the manifest declares a loading contract; every proposal carries its own proof."""
    m = m or S.load_manifest(); files, why = load(root, m); props, refused = [], []
    if why: return {"proposals": [], "refused_operations": [{"kind": "all", "reason": w["code"], "detail": w["detail"]} for w in why]}
    def offer(ops, kind):
        files_of = touched(ops, m)
        p = {"schema_version": 1, "id": "%s-%d" % (kind, len(props) + 1), "operation": kind, "affected_files": files_of, "snapshot": {n: sha(files[n]) for n in files_of}, "operations": ops}
        v, after = prove(root, p, m)
        if after is None: refused.extend({"kind": kind, "reason": r["code"], "detail": r["detail"]} for r in v["reasons"]); return
        p.update(before_after_sizes={n: {"before": len(files[n]), "after": len(after[n])} for n in files_of}, loading_contract="unchanged: the text is the same and is loaded where it was" if kind == "reflow" else "declared in the manifest", proof=v, refused_operations=[], application_state="proposed"); props.append(p)
    for name, data in files.items():
        ops, ref = reflow_ops(name, data.decode()); refused += ref
        if ops: offer(ops, "reflow")
    sp = spans_of(m)
    for b in m["blocks"]:
        if sp[b["id"]][0] != "SKILL.md" or b["id"] in PROTECTED: continue
        for to in (t for t in m.get("opens", {}) if t != "SKILL.md"):
            offer([{"kind": "move_block", "block": b["id"], "to": to, "before_block": None, "from_offset": sp[b["id"]][1], "to_offset": len(files[to]), "length": b["bytes"]}], "move_block")
        if not m.get("opens") or "loading" not in b: refused.append({"kind": "move_block", "block": b["id"], "reason": "unknown_loading_contract", "detail": "no needed_at/opens declared"})
    return {"proposals": props, "refused_operations": refused}

def summary_ro(res):
    shown = res["proposals"][:SHOWN]; out = ["Propuneri de optimizare a contextului (doar mecanice, cu dovada că nu se pierde nimic): %d, afișate %d, ascunse %d." % (len(res["proposals"]), len(shown), len(res["proposals"]) - len(shown))]
    for p in shown:
        a = p["before_after_sizes"]; out += ["- %s: %s, fișiere %s, bytes %s -> %s, octeți adăugați %d, dovadă %s, încărcare: %s" % (p["id"], p["operation"], ", ".join(p["affected_files"]), sum(v["before"] for v in a.values()), sum(v["after"] for v in a.values()), p["proof"]["added_bytes"], p["proof"]["verdict"], p["loading_contract"])]
    n = collections.Counter(r["reason"] for r in res["refused_operations"]); out.append("Refuzate: %s." % (", ".join("%s x%d" % kv for kv in sorted(n.items())) or "nimic"))
    out.append("Beneficiu: reflow-ul nu scade bytes (poate ajuta citirea parțială, nemăsurat); nimic nu se aplică fără cuvântul tău și aprobarea fiecărui fișier.")
    return "\n".join(out)

def usage(paths, root=None):
    """-> aggregate counts for the transcripts the user named (nothing else is read, no text leaves): Skill calls, reads of the reference files, script runs, errors of those calls. A missing signal proves nothing."""
    top = os.path.realpath(root or os.path.expanduser("~/.claude/projects")); refs = [n for n in S.load_manifest()["files"] if n != "SKILL.md"]; scripts = sorted(f[:-3] for f in os.listdir(HERE) if f.endswith(".py") and not f.startswith("test_"))
    out = {"sessions": 0, "records": 0, "skill_calls": 0, "reads": {r: 0 for r in refs}, "script_runs": {}, "errors_of_these_calls": 0, "read_order": []}; ids = set()
    for p in paths:
        real = os.path.realpath(p)
        if os.path.islink(p) or not real.endswith(".jsonl") or not real.startswith(top + os.sep) or not os.path.isfile(real): raise ValueError("session_not_selected: %s" % os.path.basename(p))
        out["sessions"] += 1
        for line in open(real, encoding="utf-8", errors="replace"):
            try: rec = json.loads(line)
            except ValueError: continue
            out["records"] += 1; c = (rec.get("message") or {}).get("content")
            for b in c if isinstance(c, list) else ():
                if not isinstance(b, dict): continue
                if b.get("type") == "tool_use":
                    i = b.get("input") or {}; s = sanitize.sanitize(str(i.get("skill") or i.get("file_path") or i.get("command") or i.get("path") or i.get("pattern") or ""))[0]
                    if b.get("name") == "Skill" and re.fullmatch(r"(?:[\w.-]+:)?handoff-verify", s): out["skill_calls"] += 1; ids.add(b.get("id"))
                    for r in refs:
                        if b.get("name") in ("Read", "Grep", "Bash") and "handoff-verify" in s + str(i.get("path", "")) and r in s: out["reads"][r] += 1; ids.add(b.get("id")); r in out["read_order"] or out["read_order"].append(r)
                    for sc in scripts:
                        if b.get("name") == "Bash" and re.search(r"\b%s\.py\b" % re.escape(sc), s) and "handoff-verify" in s: out["script_runs"][sc] = out["script_runs"].get(sc, 0) + 1; ids.add(b.get("id"))
                elif b.get("type") == "tool_result" and b.get("is_error") and b.get("tool_use_id") in ids: out["errors_of_these_calls"] += 1
    return out

def apply(root, prop, approved, snapshot, headless=False, m=None):
    """-> {applied, reasons, sha256}: one reflowed file at a time, only with the user's approval of that file AND of its snapshot hash, only when no other file (the manifest included) has to change, with a backup and a hash check (report.apply_patch)."""
    m = m or S.load_manifest(); no = lambda c, d="": {"applied": False, "reasons": [refuse(c, d)], "sha256": None}
    if headless: return no("headless_refused", "nobody can approve")
    v, after = prove(root, prop, m)
    if after is None: return {"applied": False, "reasons": v["reasons"], "sha256": None}
    ops = prop["operations"]; names = {o["file"] for o in ops if o["kind"] == "reflow"}
    if len(names) != 1 or any(o["kind"] != "reflow" for o in ops): return no("multi_file_atomic_publication_unavailable", "only the reflow of ONE file can be applied in v1")
    f = next(iter(names)); target = os.path.join(root, f)
    if v["requires_manifest_change"]: return no("requires_manifest_change", "the manifest or another file would have to change as well; apply refuses")
    if os.path.realpath(target) not in {os.path.realpath(a) for a in approved} or snapshot != prop["snapshot"][f]: return no("not_approved", "the file and its snapshot hash must both be approved")
    import report
    report.apply_patch(target, prop["snapshot"][f], after[f].decode(), True); now = sha(open(os.path.realpath(target), "rb").read())
    return {"applied": now == sha(after[f]), "reasons": [] if now == sha(after[f]) else [refuse("final_check_failed", "the hash on disk differs from the proven AFTER")], "sha256": now}

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0]); s = p.add_subparsers(dest="cmd", required=True)
    a = s.add_parser("propose"); a.add_argument("--skill-dir", required=True); a.add_argument("--out")
    c = s.add_parser("check"); c.add_argument("--skill-dir", required=True); c.add_argument("--proposal", required=True)
    u = s.add_parser("usage"); u.add_argument("--session", action="append", required=True)
    y = s.add_parser("apply"); y.add_argument("--skill-dir", required=True); y.add_argument("--proposal", required=True); y.add_argument("--approve", action="append", required=True); y.add_argument("--snapshot", required=True); y.add_argument("--headless", action="store_true")
    a = p.parse_args(argv)
    if a.cmd == "usage":
        try: print(json.dumps(usage(a.session), indent=1, sort_keys=True)); return 0
        except ValueError as e: print("REFUZAT: %s (doar sesiunile alese, din ~/.claude/projects, fișiere .jsonl)" % e); return 1
    root = os.path.realpath(a.skill_dir)
    if a.cmd == "propose":
        res = propose(root); text = summary_ro(res); full = json.dumps(res, indent=1, sort_keys=True)
        if len(text.encode()) > SUMMARY_CAP or (a.out and len(full.encode()) > FULL_CAP): print("REFUZAT: ieșirea depășește plafonul; nu export una trunchiată."); return 1
        if a.out: open(a.out, "w", encoding="utf-8").write(full)
        print(text); return 0
    prop = json.load(open(a.proposal, encoding="utf-8"))
    if a.cmd == "check":
        v, _ = prove(root, prop); print(json.dumps(v, indent=1, sort_keys=True)); return 0 if v["verdict"] == "PROVEN" else 1
    r = apply(root, prop, a.approve, a.snapshot, a.headless); print(json.dumps(r, indent=1, sort_keys=True)); return 0 if r["applied"] else 1

if __name__ == "__main__": sys.exit(main())

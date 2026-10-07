#!/usr/bin/env python3
"""Omission evidence (R03). Stdlib only, read-only: it parses Claude Code JSONL transcripts and files and never executes anything it reads.

A `lost_detail` (a useful detail of the session that the handoff note lost) is confirmed only by a PAIR of Jev verify checks on the SAME write of the note (write_tool_use_id + sha256 +
evaluated_against, `versions.py`): a SOURCE check (the supplied source passage states the detail) and an ABSENCE check (R04: the claim is the bare detail and the complete supplied handoff material gets the
real verdict `unsupported`; R03, historical: the claim "... neither states nor implies this detail: <detail>" verified). Both claims are canonical (built here from one `detail`), the source quote must be exact in the eligible source of the evaluated version, and the evidence given to the absence call must equal the
canonical MATERIAL of the version (the note itself + its direct references, one level, delimited, in order). The CLI `prepare` prints all of it so the model copies, never types, the values; the validator
(jevref.validate_finding) re-derives everything. This module decides nothing semantic: Jev judges the claims; here only provenance, eligibility and completeness are deterministic.

CLI: omissions.py prepare --source ID|PATH.jsonl|opencode:ID|opencode-db:/ABS/DB#ID --file HANDOFF --write-id ID --evaluated-against prefix|session_end --detail TEXT --source-quote QUOTE [--cwd DIR]
  exit 0 = ready (JSON on stdout), 3 = something is ambiguous or not recoverable (JSON with `reasons`; the omission stays UNRESOLVED)."""
import argparse, hashlib, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refs as R

SOURCE_PREFIX = "The supplied source passage states this detail: "
ABSENCE_PREFIX = "The complete supplied handoff material neither states nor implies this detail: "
EVALUATED = ("prefix", "session_end")
WRITERS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
BLOCK_SEP = "\n\u0000\n"   # joins the eligible records; a quote can never span two records
SKILL_SCRIPTS = ("omissions.py", "versions.py", "jevref.py", "report.py", "discover.py", "kit.py", "prepare.py", "slice.py", "refs.py", "sanitize.py", "scope.py", "advice.py")   # the skill's own scripts (verification activity)
JEV_PREFIX = ("mcp__jev__", "mcp__plugin_jev_jev__")   # direct MCP config, or the server shipped by the jev Claude Code plugin
_MODULE_USE = re.compile(r"(?:-m\s+|\bimport\s+|\bfrom\s+)(?:%s)\b" % "|".join(x[:-3] for x in SKILL_SCRIPTS))   # a script of the skill used as a module: -m omissions, import omissions, from omissions ...

def sha256_text(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()
def wsnorm(s): return " ".join(str(s if s is not None else "").split())

def claims(detail, contract="R04"):
    """-> (source_claim, absence_claim) for one detail (whitespace-normalized): the two canonical claims, never typed by the model. SOURCE claim = SOURCE_PREFIX + detail in every contract. ABSENCE claim: R04 = the BARE detail
    (the form measured as `b` in the R03 probes: the call asks whether the complete material states the detail and a real `unsupported` means it does not); R03 = ABSENCE_PREFIX + detail (kept for the historical evaluator)."""
    import jevref as J
    c = J.contract_of(contract); d = wsnorm(detail)
    if c == "R02": raise ValueError("the R02 evaluator has no omission claims")
    return SOURCE_PREFIX + d, (d if c == "R04" else ABSENCE_PREFIX + d)

def material(note_text, references=()):
    """Canonical material of a note version: the note and each direct reference (ref text, sha256, content), delimited, in order of appearance. `references` = [(ref, content)]."""
    out = "=== HANDOFF NOTE (sha256: %s) ===\n%s\n=== END HANDOFF NOTE ===\n" % (sha256_text(note_text), note_text)
    for ref, content in references: out += "=== DIRECT REFERENCE %s (sha256: %s) ===\n%s\n=== END DIRECT REFERENCE ===\n" % (ref, sha256_text(content), content)
    return out

def material_bases(note_path, version):
    """The ordered bases of the material, the SAME for `prepare` and the report re-derivation: the directory of the note, then the cwd recorded in the transcript for THIS write of the note (when it has one; never the process cwd or --cwd);
    build_material adds the git root of each."""
    out = []
    for b in (os.path.dirname(note_path) if note_path else None, (version or {}).get("cwd")):
        if isinstance(b, str) and b and b not in out: out.append(b)
    return out

def build_material(note_text, bases=()):
    """-> (material | None, manifest, reason). Direct references (refs.py: one level, existing files; the git roots of the bases are extra bases) found in the note are part of the eligible material; a reference that cannot be resolved or read means that
    completeness is not demonstrated (None, reason). A note without references: the note alone."""
    manifest, found, bases = [], [], R.with_git_roots(bases)
    for ref in R.direct_refs(note_text, bases):
        real, how = R.resolve_info(ref, bases)
        if real is None: return None, manifest, "direct reference %r cannot be resolved (%s): the complete material is not demonstrated" % (ref, how)
        try: txt = open(real, encoding="utf-8", newline="").read()   # newline="": no newline translation, the text (and its sha256) is exactly the bytes presented
        except (OSError, UnicodeDecodeError): return None, manifest, "direct reference %r cannot be read: the complete material is not demonstrated" % ref
        manifest.append(dict(ref=ref, path=real, sha256=sha256_text(txt), resolution=how)); found.append((ref, txt))
    return material(note_text, found), manifest, None

def _blocks_of(content):
    if isinstance(content, str): return [content]
    out = []
    for b in content if isinstance(content, list) else []:
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str): out.append(b["text"])
        elif isinstance(b, dict) and b.get("type") == "tool_result":
            c = b.get("content"); out.append(c if isinstance(c, str) else "".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else "")
    return out

def _is_verification_use(b):
    """A tool_use that is verification activity (not source): the Skill handoff-verify, a run of one of the skill's scripts (any input that names them), any Jev call."""
    name = str(b.get("name") or ""); inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    if name.startswith(JEV_PREFIX): return True
    if name == "Skill" and "handoff-verify" in str(inp.get("skill") or ""): return True
    blob = json.dumps(inp, ensure_ascii=False)
    if "handoff-verify" in blob: return True   # the skill's directory (Read SKILL.md, cd into scripts/, ...)
    return any(x in blob for x in SKILL_SCRIPTS) or bool(_MODULE_USE.search(blob))

def verification_limit(records):
    """Position (common timeline of jevref.timeline: tool_use / tool_result blocks counted in record order) of the FIRST verification event of the transcript: the Skill handoff-verify, a run of a script of the
    skill (omissions.py, versions.py, jevref.py, report.py, discover.py, kit.py, ...) or any mcp__jev__ call. None = the transcript holds no verification activity. For `session_end` the eligible source stops strictly
    before it (the verification's own commands, Jev inputs and generated material are not source)."""
    n = 0
    for d in records:
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}; c = msg.get("content")
        if d.get("type") == "assistant" and isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    n += 1
                    if _is_verification_use(b): return n
        elif d.get("type") == "user" and isinstance(c, list): n += sum(1 for b in c if isinstance(b, dict) and b.get("type") == "tool_result")
    return None

def eligible_blocks(records, handoff_real, pos=None):
    """Source text blocks eligible to evaluate a version of the note: user/assistant text, tool results and tool inputs of the transcript, EXCLUDING every Write/Edit of the handoff path itself (the note is
    not its own source) and EVERY Jev call (claims and evidence are inputs of a verification, not facts established by the transcript) with its result. `pos` = position on the common timeline (jevref.timeline):
    only what comes strictly before it is eligible (`prefix`: the position of the write's tool_use; `session_end`: `verification_limit`, None when the session holds no verification activity = the whole transcript). -> [text]."""
    out, n, skip = [], 0, set()
    for d in records:
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}; c = msg.get("content"); t = d.get("type")
        if t not in ("user", "assistant"): continue
        if isinstance(c, str):
            if pos is None or n < pos: out.append(c)
            continue
        for b in c if isinstance(c, list) else []:
            if not isinstance(b, dict): continue
            ty = b.get("type")
            if ty == "text":
                if isinstance(b.get("text"), str) and (pos is None or n < pos): out.append(b["text"])
            elif ty == "tool_use":
                n += 1
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                if str(b.get("name") or "").startswith(JEV_PREFIX): skip.add(b.get("id")); continue
                if b.get("name") in WRITERS and os.path.realpath(str(inp.get("file_path") or inp.get("notebook_path") or "")) == handoff_real: continue
                if pos is None or n < pos: out.append("[tool_use %s] %s" % (b.get("name"), json.dumps(inp, ensure_ascii=False)))
            elif ty == "tool_result":
                n += 1
                if b.get("tool_use_id") in skip: continue
                if pos is None or n < pos:
                    x = b.get("content"); out.append(x if isinstance(x, str) else "".join(y.get("text", "") for y in x if isinstance(y, dict)) if isinstance(x, list) else "")
    return out

def passage_of(blocks, quote):
    """The first eligible block that contains the quote EXACTLY (case-sensitive, internal whitespace and newlines as in the record), else None."""
    return next((b for b in blocks if isinstance(quote, str) and quote.strip() and quote in b), None)

def evidence_raw(call_input):
    """The evidence texts the REAL call was given, in order, unmodified (verify/gate: a string, one item or a list of items)."""
    ev = (call_input or {}).get("evidence")
    if isinstance(ev, str): return [ev]
    if isinstance(ev, dict): return [ev["text"]] if isinstance(ev.get("text"), str) else []
    return [x["text"] if isinstance(x, dict) else x for x in ev if isinstance(x, (dict, str)) and (not isinstance(x, dict) or isinstance(x.get("text"), str))] if isinstance(ev, list) else []

def material_matches(raw_texts, mat):
    """The evidence of the absence call IS the canonical material: exactly the same text, order, delimiters and internal whitespace/newlines (contiguous chunks that concatenate to it are accepted); extra or missing content is not."""
    return mat is not None and bool(raw_texts) and "".join(raw_texts) == mat

def passage_matches(raw_texts, passage):
    """The WHOLE evidence of the source call IS the eligible passage that holds the quote (exactly; contiguous chunks that concatenate to it are accepted): no extra claims, no other text."""
    return passage is not None and bool(raw_texts) and "".join(raw_texts) == passage

_MEMO = {}
def context(source_jsonl, handoff_real, version, evaluated_against, bases=()):
    """Everything the validator needs about one version: the eligible source text and the canonical material. -> dict(eligible_source, material, material_reason). Cached by transcript identity."""
    import discover as D, jevref as J
    try: key = D.fingerprint(source_jsonl)
    except OSError: return dict(eligible_source=None, eligible_blocks=None, material=None, material_reason="source transcript unreadable")
    if key not in _MEMO: recs = D.load_jsonl(source_jsonl); _MEMO[key] = (recs, J.timeline(recs)[0])
    recs, use_pos = _MEMO[key]
    pos = use_pos.get(version["write_tool_use_id"]) if evaluated_against == "prefix" else verification_limit(recs)
    if evaluated_against == "prefix" and pos is None: return dict(eligible_source=None, eligible_blocks=None, material=None, material_reason="position of the write not found")
    blocks = eligible_blocks(recs, handoff_real, pos); mat, manifest, why = build_material(version["content"], bases)
    return dict(eligible_source=BLOCK_SEP.join(blocks), eligible_blocks=blocks, material=mat, material_reason=why, manifest=manifest)

def prepare_one(a):
    """The prepare result for one candidate -> (object, exit code); `cmd_prepare` prints it, `cmd_prepare_batch` collects it."""
    import discover as D, versions as V
    def fail(*reasons, **extra): return dict(ok=False, reasons=list(reasons), **extra), 3
    sp, how, amb = D.resolve_session_info(a.source, a.cwd)
    if amb: return fail("source session not demonstrated: several recently modified sessions; pass --source ID or PATH.jsonl")
    if not sp or not D.source_exists(sp): return fail("source session not found")
    path = a.file if os.path.isabs(a.file) else os.path.join(a.cwd or os.getcwd(), a.file)
    vs, canon, _, note = V.versions_of(sp, path); reloc = None
    if canon is None:
        reloc, rnote = V.relocation_candidate(sp, path)
        if reloc: vs, canon, _, note = V.versions_of(sp, path, reloc)
        else: return fail("%s; relocation: %s" % (note, rnote))
    v = next((x for x in vs if x["write_tool_use_id"] == a.write_id), None)
    if v is None: return fail("--write-id is not a write of this handoff in the source session (copy it from `versions.py list`)")
    if v["status"] != "ok" or v["sha256"] is None: return fail("the version is not recoverable: %s" % v["reason"])
    if reloc:
        try: disk = hashlib.sha256(open(path, "rb").read()).hexdigest()
        except OSError: return fail("the copy cannot be read: relocation not verified")
        if disk not in {x["sha256"] for x in vs if x["sha256"]}: return fail("relocated copy: the bytes do not hash to a recoverable version of the written handoff")
    ctx = context(sp, canon, v, a.evaluated_against, material_bases(path, v))
    if ctx["material"] is None: return fail(ctx["material_reason"] or "material not available")
    if not wsnorm(a.detail): return fail("empty detail")
    if wsnorm(a.detail).startswith(SOURCE_PREFIX.strip()) or wsnorm(a.detail).startswith(ABSENCE_PREFIX.strip()): return fail("the detail must be the bare detail, not a canonical claim (the helper builds the claims itself)")
    passage = passage_of(ctx["eligible_blocks"], a.source_quote)
    if passage is None: return fail("the source quote is not (exactly, case-sensitive, whitespace as in the record, inside ONE transcript record) in the eligible source of this version (%s; session_end stops before the verification activity, Jev calls are never source)" % a.evaluated_against)
    sc, ac = claims(a.detail, "R04")
    return (dict(ok=True, contract="R04", detail=wsnorm(a.detail), source_claim=sc, absence_claim=ac, source_passage=passage, material=ctx["material"], material_manifest=ctx.get("manifest", []),
                          version_ref=dict(write_tool_use_id=v["write_tool_use_id"], sha256=v["sha256"], evaluated_against=a.evaluated_against), handoff_source_path=reloc,
                          omission_ref_template=dict(detail=wsnorm(a.detail), source_check_id="<id of the check whose call used source_claim and source_passage>"),
                          note="Call jev_verify twice: (1) claims=[source_claim], evidence=source_passage (verbatim, the WHOLE passage, nothing added); (2) claims=[absence_claim] (the bare detail, the ONLY claim of that call), evidence=material, verbatim and complete. Both checks carry the same version_ref. Only if (1) is verified > 0.95 AND (2) comes back `unsupported` > 0.95 with action auto, report a finding (type lost_detail): omission_ref, claim = absence_claim, check_id = the absence check, confidence = its confidence, quote_source = the exact quote. If (2) is verified or contradicted the note states the detail: record the check, report NO finding. Anything else stays UNRESOLVED."), 0)

def cmd_prepare(a):
    obj, code = prepare_one(a); print(json.dumps(obj, indent=1, ensure_ascii=False)); return code

BATCH_KEYS = ("source", "file", "write_id", "evaluated_against", "cwd")

def cmd_prepare_batch(a):
    """Many candidates in ONE process, also across handoffs and versions: each spec item is {detail, source_quote} plus optional source/file/write_id/evaluated_against/cwd
    overriding the command-line defaults; element i is exactly the object `prepare` prints for item i with those arguments (exit 3 if any element is not ok)."""
    def bad(reason): print(json.dumps(dict(ok=False, reasons=[reason]), indent=1, ensure_ascii=False)); return 3
    try: spec = json.load(open(a.spec, encoding="utf-8"))
    except (OSError, ValueError) as e: return bad("spec unreadable: %s" % e)
    items = spec.get("candidates") if isinstance(spec, dict) else spec
    if not isinstance(items, list) or not items: return bad('spec must be a non-empty list (or {"candidates": [...]}) of {"detail", "source_quote"[, %s]}' % ", ".join(BATCH_KEYS))
    args = []
    for i, x in enumerate(items):
        if not isinstance(x, dict) or not isinstance(x.get("detail"), str) or not isinstance(x.get("source_quote"), str): return bad("item %d: detail and source_quote must be strings" % i)
        unknown = set(x) - {"detail", "source_quote"} - set(BATCH_KEYS)
        if unknown: return bad("item %d: unknown keys %s" % (i, sorted(unknown)))
        n = dict(vars(a), **{k: x[k] for k in BATCH_KEYS if k in x}, detail=x["detail"], source_quote=x["source_quote"])
        if not all(isinstance(n.get(k), str) and n[k] for k in ("file", "write_id", "evaluated_against")): return bad("item %d: file, write_id and evaluated_against are required (item or command line)" % i)
        if n["evaluated_against"] not in EVALUATED: return bad("item %d: evaluated_against must be one of %s" % (i, list(EVALUATED)))
        args.append(argparse.Namespace(**n))
    out, code = [], 0
    for n in args:
        obj, c = prepare_one(n); out.append(obj); code = max(code, c)
    print(json.dumps(out, indent=1, ensure_ascii=False)); return code

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True); p = sub.add_parser("prepare")
    p.add_argument("--source"); p.add_argument("--file", required=True); p.add_argument("--write-id", required=True, dest="write_id"); p.add_argument("--evaluated-against", choices=EVALUATED, required=True, dest="evaluated_against")
    p.add_argument("--detail", required=True); p.add_argument("--source-quote", required=True, dest="source_quote"); p.add_argument("--cwd")
    b = sub.add_parser("prepare-batch")
    b.add_argument("--source"); b.add_argument("--file"); b.add_argument("--write-id", dest="write_id"); b.add_argument("--evaluated-against", choices=EVALUATED, dest="evaluated_against")
    b.add_argument("--spec", required=True); b.add_argument("--cwd")
    a = ap.parse_args()
    return cmd_prepare_batch(a) if a.cmd == "prepare-batch" else cmd_prepare(a)

if __name__ == "__main__": sys.exit(main())

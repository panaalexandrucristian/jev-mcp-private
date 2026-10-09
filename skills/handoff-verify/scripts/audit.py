#!/usr/bin/env python3
"""Mandatory full-report audit (item 11; stdlib only, read-only on everything but a registry file, no Jev call). ONE function judges whether the review behind a report is complete, and the report writer (report.bind_report /
write_report), the delivery gate (versions.gate, so `versions.py status`) and the per-version evaluation (versions.per_version, the write summary and each prefix / session_end evaluation) all call it. PASS needs a COMPLETE audit;
an incomplete one turns a PASS into UNRESOLVED and a confirmed defect keeps FAIL (the reasons and the unfinished-work counts stay visible in `binding_summary.audit`). It never creates a FAIL and never changes a Jev threshold.

What the audit re-derives (nothing the report says about itself is evidence: not its stored status, `binding_summary`, `scope_audit`, `coverage.complete`, `source_ranges[].complete`, a `reviewed` boolean alone or the sha256 of a ledger):
 1. the structure of the report: the WHOLE report is validated against report.schema.json (schema_check.py, the validator the writer and the gate use too: required properties, types, nested records, exactly nine category records, ...); anything missing or
    malformed fails closed with a reason, never a crash and never a PASS;
 2. the scope exclusions with `scope.validate_exclusions` against the real source, the canonical scope, the known writes and the report's evaluation; a missing or non-list `scope_exclusions` is missing accounting (an empty list is valid);
 3. per evaluated write (write id + sha256 + prefix|session_end + run; equal-byte writes share nothing): the EXPECTED chunks, re-derived from the source transcript by prepare.derive (the chunking of prepare.py itself: its source eligibility, sanitization,
    stream boundaries) and bounded by the REAL window of THIS evaluation (omissions.source_window: a prefix ends at the write, a session_end ends at the start of the selected verification run; the spans of the other runs are not source). A chunk is expected when it holds
    material of the window; the part of a chunk that lies outside the window (a window boundary inside a chunk) is never evidence. Each expected chunk needs exactly one review record naming its index, the sha256 of its text, all nine categories and a basis;
 4. a SOURCE-GROUNDED outcome for each of the nine categories: `candidates` (exactly the registered candidates of the category), or `no_candidate` / `not_applicable`, each with a basis = a uuid and an exact quote of THAT record, inside the window of the evaluation;
    a chunk review is grounded the same way. A flags-only review (reviewed true, nine categories, nine outcomes with no basis) is not a review;
 5. every REGISTERED candidate must be accounted for by an independently derived disposition: `present` (a bound, resolved check on the canonical absence claim with the exact material), `excluded` (a valid scope exclusion), `omission` (a validated finding) or
    explicit unresolved work. The registry is NOT chosen by the report: its location is derived from the source session (registry_path), preparation establishes it (prepare.py, `audit.py template`), it records which evaluations were established and which
    omission ledgers belong to the session (`omissions.py prepare-batch --ledger`, `audit.py template --ledger`), and the audit reads it from there. With several representations of the session demonstrated by the inputs (a copy or the original of the calls log / of the transcript the report names: `Context.also`, versions.same_session) the registries of ALL of them are merged
    (`Context.representations`): an established empty registry of one never erases the work registered against another, and the missing registry of one is not replaced by the registry of another (each demonstrated representation needs its own). A missing, unreadable, foreign, substituted (another path named by the report) or not established registry,
    and an unreadable ledger of the session, are unfinished work; a genuinely established empty registry is a valid zero. A ledger shared by several sessions counts only the rows of THIS session (`ledger_candidates`: `identity.source` is a
    representation of it; a row positively of another session (`versions.distinct_sessions`) is excluded; a withheld, missing, unreadable, empty, malformed or metadata-deficient source never excludes). Every obligation of those ledgers counts, whatever its state: valid, invalidated or unavailable. A model-written disposition never clears a candidate.
Honest limit: the registry and the ledger are editable files and a sha256 binds only a snapshot. The audit proves that what WAS registered is accounted for and that the chunks WERE reviewed in the way the report states; it cannot prove that the reviewer
discovered every semantic candidate, and nothing here excuses dropping a registered one.

CLI: audit.py register --source S --file NOTE --write-id ID --evaluated-against prefix|session_end [--run ID] --detail TEXT [--category 1-9] [--quote TEXT] [--cwd DIR]   (exit 0, 3 refused; the registry is the one of the session: `--registry` is accepted only when it names it)
     audit.py template --source S --file NOTE --write-id ID --evaluated-against prefix|session_end [--run ID] [--ledger FILE] [--cwd DIR]   (establishes the evaluation in the registry and prints the unreviewed evaluation block of the report's `audit` object)"""
import argparse, hashlib, json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover as D, jevref as J, omissions as O, schema_check as SC, scope, versions as V

AUDIT_VERSION = 1
CATEGORIES = tuple(range(1, 10))
REGISTRY_SCHEMA, REGISTRY_VERSION = "handoff-verify-audit-registry", 1
CHUNK_CHARS = 9000   # prepare.py's default --max-chars; a report may declare another one (`audit.max_chars`), the expected chunks are re-derived with it
GLOBAL = (None, None, "session_end", None)   # a report without version identity: the whole transcript, no write
OUTCOMES = ("candidates", "no_candidate", "not_applicable")
LIMIT = "The registry and the ledger are editable files and a hash binds a snapshot: the audit proves that what was registered is accounted for and that the chunks were reviewed as the report states, not that every semantic candidate was discovered."

def wsnorm(s): return O.wsnorm(s)
def sha256_text(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()
def detail_sha(detail): return sha256_text(wsnorm(detail))

def key_of(v):
    """The evaluation key of a version row / binding: (write id, sha256, evaluated_against, run | None)."""
    return (v["write_tool_use_id"], v["sha256"], v["evaluated_against"], v.get("run") or None)

def key_from_dict(d):
    """-> evaluation key of {write_tool_use_id, sha256, evaluated_against[, run]} | None when malformed."""
    if d is None: return GLOBAL
    if not isinstance(d, dict) or set(d) - {"write_tool_use_id", "sha256", "evaluated_against", "run"}: return None
    w, s, m, r = d.get("write_tool_use_id"), d.get("sha256"), d.get("evaluated_against"), d.get("run")
    if not (isinstance(w, str) and w and isinstance(s, str) and s and m in ("prefix", "session_end") and (r is None or (isinstance(r, str) and r))): return None
    return (w, s, m, r)

def dict_of(k):
    return None if k == GLOBAL else dict(write_tool_use_id=k[0], sha256=k[1], evaluated_against=k[2], **({"run": k[3]} if k[3] else {}))

def label(k): return "the whole transcript" if k == GLOBAL else "write %s (%s%s)" % (O.id_text(k[0]), k[2], ", run %s" % O.id_text(k[3]) if k[3] else "")

def candidate_id(k, dsha):
    return sha256_text(json.dumps([k[0], k[1], k[2], k[3], dsha], ensure_ascii=False))[:16]

# ---------------------------------------------------------------- the expected chunks (prepare.py's own derivation) and the window of an evaluation
_PLANS = {}
def plan_of(source, note, max_chars):
    """-> the preparation of the source (prepare.derive, nothing written) as the audit needs it: chunks (index, file, sha256, positions, the entries that lie in the chunk text) and the version rows. Memoized by the CONTENT identity of the transcripts."""
    import prepare
    key = (tuple(D.content_fingerprint(f) for f in [source] + D.subagent_files(source)), os.path.realpath(note) if note else None, max_chars)
    if key not in _PLANS:
        if len(_PLANS) > 32: _PLANS.clear()
        P = prepare.derive(source, None, [os.path.realpath(note)] if note else [], max_chars, None)
        _PLANS[key] = dict(source=D.canon(source), chunks=P["chunks_meta"], texts=P["chunk_texts"], notes=P["inv_h"], cwd=session_cwd(source))
    return _PLANS[key]

def find_version(plan, k):
    """-> ((note row, version row), None) of the evaluated write in the prepared source, or (None, reason)."""
    hit = None
    for h in plan["notes"]:
        for v in h.get("versions", []):
            if v.get("tool_use_id") == k[0]: hit = (h, v)
    if hit is None: return None, "the evaluated write is not a version of the note in the prepared source"
    if hit[1].get("sha256") != k[1]: return None, "the evaluated hash is not the hash of that write in the prepared source"
    return hit, None

def _body_start(e):
    """Offset (inside the chunk text) where the BODY of an entry piece starts: after its `[uuid role] ` header when the piece is the first of its entry."""
    return e["start"] + ((e["entry_text"].find("] ") + 2) if e["eoff"] == 0 and "] " in e["entry_text"][:400] else 0)

def _prefix_end(e, inside):
    """Offset (inside the entry's sanitized text) where the part of the entry that lies in the window ends: the header and the leading blocks that are in the window, sanitized exactly as the entry is. When that sanitization is not a prefix of the sanitized
    entry (a secret that spans the boundary) nothing of the entry is evidence: fail closed (0)."""
    head = "[%s %s] " % (e["uuid"], e["role"]); part = head + " ".join(t for j, t in e["parts"] if j in inside)
    try: p = O.S.sanitize(part)[0]
    except Exception: return 0
    return len(p) if e["entry_text"].startswith(p) else 0

def window_of(plan, source, k):
    """-> (dict(indexes, spans, partial, source_blocks), None) or (None, reason): the chunks an evaluation must review and, per chunk, the SPANS of its text (uuid, start, end offsets of the body of a record) that lie in the window of the evaluation.
    The window is the one every consumer uses (omissions.source_window with the evaluated write, mode and run): a `prefix` ends at the write; a `session_end` ends at the start of the selected verification run, the spans of the other runs are generated material,
    and a run that is not demonstrated makes the evaluation unauditable (the reason says why). A chunk is expected when it holds material of the window; `partial` lists the chunks that also hold material outside it (a window boundary inside a chunk):
    only the spans count as evidence, the rest of the chunk is not certified. A report without version identity (GLOBAL) = every record of every chunk."""
    spans, partial = {}, []
    if k == GLOBAL:
        for c in plan["chunks"]: spans[c["index"]] = [(e["uuid"], _body_start(e), e["end"]) for e in c["entries"]]
        return dict(indexes=sorted(spans), spans=spans, partial=[]), None
    hit, why = find_version(plan, k)
    if hit is None: return None, why
    h, v = hit
    w, recs = O.window_for(source, k[0], k[2], k[3])
    if w is None: return None, "the source transcript of the window is unreadable"
    if w["ambiguous"]: return None, O.S.sanitize(w["ambiguous"])[0]
    main = D.canon(source)
    ib = O.eligible_blocks_indexed(recs, h["path"], w["limit"], w["excluded"])
    elig = {(p["line"], p["block"]) for _, p in ib}; seen = set()
    for c in plan["chunks"]:
        if D.canon(c["source_file"]) != main: continue
        mine, cut = [], False
        for e in c["entries"]:
            blocks = [j for j, _ in e["parts"]]; seen |= {(e["line"], j) for j in blocks}
            inside = {j for j in blocks if (e["line"], j) in elig}
            if not inside: cut = True; continue
            lo, hi = _body_start(e), e["end"]
            if len(inside) < len(blocks):
                cut = True; limit = _prefix_end(e, inside)
                hi = min(hi, e["start"] + max(0, limit - e["eoff"]))
                if hi <= lo: continue
            mine.append((e["uuid"], lo, hi))
        if mine: spans[c["index"]] = mine; partial += [c["index"]] if cut else []
    lost = sorted(b for b in elig if b not in seen)
    if lost: return None, "%d eligible source block(s) of the window are not part of any prepared chunk (line %s, block %s): the window cannot be reviewed" % (len(lost), lost[0][0], lost[0][1])
    return dict(indexes=sorted(spans), spans=spans, partial=sorted(set(partial))), None

def expected_chunks(plan, k, source=None):
    """-> (indexes of the chunks an evaluation must review, None) or (None, reason): the chunks that hold material of the window of the evaluation (`window_of`)."""
    win, why = window_of(plan, source if source is not None else plan["source"], k)
    return (win["indexes"], None) if win else (None, why)

def quote_in(spans_of_chunk, text, uuid, quote):
    """Is `quote` an exact substring of the body of a record with this uuid that lies in the window? (the SAME record: the text between the record's own offsets, never the rest of the chunk)."""
    return isinstance(quote, str) and bool(quote.strip()) and isinstance(uuid, str) and bool(uuid) and any(u == uuid and quote in text[a:b] for u, a, b in spans_of_chunk)

def block_template(plan, k, source=None):
    """The UNREVIEWED evaluation block of the report's `audit` object: one record per expected chunk (index + sha256 of its text, reviewed false, no category and no basis yet) and a pending outcome per category. A template is work to do, not a review."""
    win, why = window_of(plan, source if source is not None else plan["source"], k)
    if win is None: raise ValueError(why)
    by = {c["index"]: c for c in plan["chunks"]}
    return dict(evaluation=dict_of(k), chunks=[dict(index=i, file=by[i]["file"], sha256=by[i]["sha256"], reviewed=False, categories=[], **({"window_partial": True} if i in win["partial"] else {})) for i in win["indexes"]],
                categories=[dict(category=c, outcome=None) for c in CATEGORIES], unresolved=[])

# ---------------------------------------------------------------- the registry (candidates registered BEFORE the scope filter) and the ledger
def session_cwd(source):
    """The first cwd the session line records (an absolute path), else None."""
    for d in D.load_jsonl(source):
        c = d.get("cwd")
        if isinstance(c, str) and os.path.isabs(c): return c
    return None

def registry_path(plan):
    """The ONE registry of a source session: `<first cwd the session records>/.handoff-verify/<session label>/audit-registry-<hash8 of the canonical source>.json`. It is derived from the SOURCE, never chosen by a report; None when the session records no usable cwd."""
    cwd = plan.get("cwd")
    if not cwd or not os.path.isdir(cwd): return None
    return os.path.join(cwd, ".handoff-verify", D.session_label(plan["source"]), "audit-registry-%s.json" % sha256_text(plan["source"])[:8])

def registry_path_of(source):
    """`registry_path` of a source given as a path / selector (no preparation needed)."""
    return registry_path(dict(source=D.canon(source), cwd=session_cwd(source)))

def associate_session_ledger(source, ledger_path):
    """`associate_ledger` for the session `source` (path / selector). -> the registry path. Raises ValueError when the registry of the session cannot be located or is malformed."""
    path = registry_path_of(source)
    if path is None: raise ValueError("the session records no usable cwd, so its candidate registry cannot be located and the ledger cannot be associated with it")
    associate_ledger(path, D.canon(source), ledger_path); return path

def empty_registry(source=None): return dict(schema=REGISTRY_SCHEMA, version=REGISTRY_VERSION, source=source, limit=LIMIT, established=[], ledgers=[], candidates=[])

def _candidate_ok(c):
    return (isinstance(c, dict) and isinstance(c.get("id"), str) and key_from_dict(c.get("evaluation")) is not None and isinstance(c.get("detail_sha256"), str) and len(c["detail_sha256"]) == 64
            and (c.get("category") is None or (isinstance(c["category"], int) and not isinstance(c["category"], bool) and c["category"] in CATEGORIES)) and (c.get("detail") is None or isinstance(c["detail"], str)))

def load_registry(path):
    """-> (document | None, reason | None): a malformed registry is refused (fail closed), never repaired."""
    try: doc = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e: return None, "the candidate registry is unreadable (%s)" % e.__class__.__name__
    if not isinstance(doc, dict) or doc.get("schema") != REGISTRY_SCHEMA or doc.get("version") != REGISTRY_VERSION or not isinstance(doc.get("candidates"), list): return None, "the candidate registry is not a %s v%d document" % (REGISTRY_SCHEMA, REGISTRY_VERSION)
    est, led = doc.get("established", []), doc.get("ledgers", [])
    if not (isinstance(est, list) and all(key_from_dict(x) is not None for x in est) and isinstance(led, list) and all(isinstance(x, str) and x for x in led)): return None, "the candidate registry holds a malformed list of established evaluations or ledgers"
    seen = set()
    for c in doc["candidates"]:
        if not _candidate_ok(c): return None, "the candidate registry holds a malformed candidate"
        if c["id"] != candidate_id(key_from_dict(c["evaluation"]), c["detail_sha256"]) or c["id"] in seen: return None, "the candidate registry holds a candidate whose id is not the hash of its identity (or a duplicate)"
        seen.add(c["id"])
    return dict(doc, established=list(est), ledgers=list(led)), None

def save_registry(path, doc):
    """Atomic write that never drops a registered candidate, an established evaluation or a ledger association (the registry only grows)."""
    if os.path.exists(path):
        old, why = load_registry(path)
        if old is None: raise ValueError(why)
        if {c["id"] for c in old["candidates"]} - {c["id"] for c in doc["candidates"]}: raise ValueError("refused: the new registry would drop registered candidates")
        if {json.dumps(x, sort_keys=True) for x in old["established"]} - {json.dumps(x, sort_keys=True) for x in doc.get("established", [])}: raise ValueError("refused: the new registry would drop established evaluations")
        if set(old["ledgers"]) - set(doc.get("ledgers", [])): raise ValueError("refused: the new registry would drop ledger associations")
    d = os.path.dirname(os.path.abspath(path)); os.makedirs(d, exist_ok=True); fd, tmp = tempfile.mkstemp(prefix=".audit-registry-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(doc, f, indent=1, ensure_ascii=False); f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def _open_registry(path, source):
    doc = load_registry(path)[0] if os.path.exists(path) else empty_registry(source)
    if doc is None: raise ValueError("the existing registry is malformed: refused, nothing is written over it")
    if doc.get("source") is None: doc["source"] = source
    elif doc["source"] != source: raise ValueError("the registry belongs to another source session: refused")
    return doc

def ensure_registry(path, source):
    """Preparation: the (empty) registry of the session exists and is bound to the source. -> True when it was created now. An existing registry is never rewritten."""
    if os.path.exists(path): _open_registry(path, source); return False
    save_registry(path, _open_registry(path, source)); return True

def establish(path, source, k):
    """Preparation of ONE evaluation: the registry records that the evaluation `k` was set up BEFORE any scope filtering (an established evaluation with no candidate is a demonstrated zero; an unknown one is missing accounting)."""
    doc = _open_registry(path, source); d = dict_of(k)
    if not any(key_from_dict(x) == k for x in doc["established"]): doc["established"].append(d); save_registry(path, doc)
    return doc

def associate_ledger(path, source, ledger_path):
    """Preparation: the omission ledger `ledger_path` belongs to the session. Its obligations are then expected by the audit whatever the report names. Never dropped."""
    doc = _open_registry(path, source); real = os.path.realpath(ledger_path)
    if real not in doc["ledgers"]: doc["ledgers"].append(real); save_registry(path, doc)
    return doc

def register(path, source, k, detail, category=None, quote=None):
    """Register one candidate lost detail of an evaluation (before any scope filtering or omission scheduling); the evaluation is established too. A detail that holds a secret or a redaction marker is registered by hash only and can never be cleared
    (what it hides is not demonstrated). -> (candidate, added: bool)."""
    doc = _open_registry(path, source)
    if not wsnorm(detail): raise ValueError("empty detail")
    dsha = detail_sha(detail); cid = candidate_id(k, dsha)
    if not any(key_from_dict(x) == k for x in doc["established"]): doc["established"].append(dict_of(k))
    c = next((x for x in doc["candidates"] if x["id"] == cid), None)
    if c is not None: save_registry(path, doc); return c, False
    c = dict(id=cid, evaluation=dict_of(k), category=category, detail_sha256=dsha, detail=None if O.redaction_dependent(detail) else wsnorm(detail), quote_sha256=sha256_text(quote) if isinstance(quote, str) else None)
    doc["candidates"].append(c); save_registry(path, doc); return c, True

def applicable(c, k):
    """Does the registered candidate `c` apply to the evaluation `k`? (same write and mode; a hash or run that is not recorded applies to any)."""
    ck = key_from_dict(c["evaluation"])
    return ck[0] == k[0] and ck[2] == k[2] and ck[1] in (None, k[1]) and ck[3] in (None, k[3])

def _withheld(x): return isinstance(x, str) and x.startswith("withheld:sha256:")

def unrelated_source(row_source, sources):
    """Does the ledger row belong DEMONSTRABLY to another session than every representation in `sources` (canonical sources of the session being audited)? Positive evidence only (`versions.distinct_sessions`: both transcripts readable with a
    recorded identity and no common session id, or two different selectors): a source that is withheld, absent, not a string, empty, malformed, unreadable, metadata-deficient or of an undemonstrated identity is NOT demonstrated unrelated (the row
    keeps counting); one that is, or is a copy / the original of, a representation of the session is related."""
    if not sources or not isinstance(row_source, str) or not row_source or _withheld(row_source): return False
    if any(row_source == s for s in sources): return False
    try:
        return all(V.distinct_sessions(row_source, s) for s in sources if isinstance(s, str) and s)
    except Exception: return False

def ledger_candidates(path, k, note_real, sources=None):
    """-> ([candidates of the ledger that apply to the evaluation `k`], reason | None). EVERY obligation of the audited session counts, whatever its state (valid, invalidated, unavailable): the ledger never drops a row and neither does the audit.
    A ledger can be shared by several sessions (`omissions.py prepare-batch --ledger` over several sources): a row whose `identity.source` is DEMONSTRABLY another session than every representation in `sources` is not this session's work
    (`unrelated_source`; without `sources` nothing is excluded for its source). An obligation whose write id or note path is withheld cannot be shown inapplicable by those and counts for every evaluation; a withheld, missing or unreadable source never
    excludes a row. A row with no version hash or run (unavailable: it could not be prepared) applies to any hash / run of that write and mode."""
    import ledger as L
    try: doc = L.load(path)
    except L.LedgerError as e: return [], "the obligation ledger is unusable: %s" % O.S.sanitize(str(e))[0][:160]
    out = []
    for r in doc["obligations"]:
        idn = r["identity"]; w = idn.get("write_id")
        if unrelated_source(idn.get("source"), sources): continue
        unknown = _withheld(w) or _withheld(idn.get("file"))
        if not unknown:
            if k == GLOBAL or w != k[0] or idn.get("evaluated_against") != k[2]: continue
            if idn.get("version_sha256") not in (None, k[1]) or idn.get("run") not in (None, k[3]): continue
            if note_real and idn.get("file") != note_real: continue
        args = r.get("args") or {}
        out.append(dict(id=candidate_id(k, idn["detail_sha256"]), category=None, detail_sha256=idn["detail_sha256"], detail=args.get("detail") if isinstance(args.get("detail"), str) else None, origin="ledger:%s" % r["state"]))
    return out, None

# ---------------------------------------------------------------- the context of one report
class Context:
    """Everything the audit needs about ONE evaluated report: the report, its checks, the bindings (with the version identity and the material attached), the real calls, the source transcript and the note. Built once, shared by the
    writer, the gate and the per-version evaluation (the same inputs give the same answer: the writer's status and the gate's never disagree)."""
    def __init__(self, doc, checks, bindings, calls, source, handoff_path, source_path=None, versioned=True, same=True, contract="R04", writer_input=False, also=()):
        self.doc = doc if isinstance(doc, dict) else {}; self.checks = checks; self.bindings = bindings; self.calls = calls; self.source = source
        self.also = tuple(x for x in (also or ()) if isinstance(x, str) and x)   # the other representations (a copy or the original of the transcript) of the SAME session, as far as the evaluation inputs demonstrate it (versions.same_session); never a guess
        self.handoff_path = handoff_path; self.source_path = None if same else source_path; self.versioned = versioned; self.contract = J.contract_of(contract)
        self.writer_input = writer_input   # the document is the author's input of the report writer: the properties the writer owns (status, binding_summary, ...) are not judged yet
        self._cache = {}
    def cached(self, name, fn):
        if name not in self._cache: self._cache[name] = fn()
        return self._cache[name]

    def evaluations(self):
        if not self.versioned: return [GLOBAL]
        out = []
        for b in self.bindings:
            v = b.get("version")
            if b.get("bound") and isinstance(v, dict) and v.get("ok") and key_of(v) not in out: out.append(key_of(v))
        return out

    def scope_state(self):
        """-> dict(declared: bool, valid, invalid, reasons, flags {index: bool}); the one re-derivation of the exclusions (report.bind_report writes it as `scope_audit`)."""
        def make():
            doc = self.doc; ex = doc.get("scope_exclusions")
            if not isinstance(ex, list): return dict(declared="scope_exclusions" in doc, listed=False, valid=0, invalid=1, reasons=[dict(index=None, detail=None, reason="scope_exclusions is missing or not a list: the accounting of the scope filter is absent")], flags={})
            h = doc.get("handoff") if isinstance(doc.get("handoff"), dict) else {}; src = (doc.get("session") or {}).get("jsonl") if isinstance(doc.get("session"), dict) else None
            known = V.write_ids(self.source, self.handoff_path or "", self.source_path) if self.versioned and self.handoff_path and self.source else None
            default = scope.report_evaluation(self.checks) if self.versioned else None
            sa = scope.validate_exclusions(ex, self.calls, src, doc.get("findings", []) if isinstance(doc.get("findings"), list) else [], known, default)
            bad = {r["index"] for r in sa["reasons"] if isinstance(r.get("index"), int)}
            return dict(declared=True, listed=True, flags={i: i not in bad for i in range(len(ex))}, **sa)
        return self.cached("scope", make)

    def plan(self, max_chars):
        def make():
            if not self.source or not D.source_exists(self.source): return None, "the source transcript is not available: the expected chunks cannot be derived"
            try: return plan_of(self.source, self.handoff_path if self.versioned else None, max_chars), None
            except Exception as e: return None, "the expected chunks could not be derived from the source (%s)" % e.__class__.__name__
        return self.cached(("plan", max_chars), make)

    def structure(self):
        """-> the problems of the WHOLE report against report.schema.json (schema_check; the same validator as the writer and the gate)."""
        return self.cached("structure", lambda: SC.validate_report(self.doc, self.writer_input))

    def representations(self, plan):
        """-> [(canonical source, cwd)]: the source of the audit and every other representation of the same session that the evaluation inputs demonstrate (`also`: the report's transcript when it is a copy / the original of the calls log, same_session).
        The accounting of the session is the accounting of ALL of them: a registry or a ledger association made against one representation is not hidden by the (empty) registry of another."""
        out = [(plan["source"], plan.get("cwd"))]
        for f in self.also:
            try:
                if not D.source_exists(f): continue
                c = D.canon(f)
                if all(c != x for x, _ in out): out.append((c, session_cwd(f)))
            except Exception: continue
        return out

    def registry_state(self, plan):
        """-> (registry document | None, reason | None): the registry of the SOURCE SESSION, read from its derived location (registry_path), whatever path the report names. With several demonstrated representations of the session (`representations`)
        the registries of ALL of them are read and merged: every registered candidate, every established evaluation and every ledger association of any of them counts. EVERY demonstrated representation must have its registry: a missing one is a reason next to the merged document (an established registry of another representation does not stand in for it). Missing, unreadable, foreign: a reason (a malformed or foreign registry of ANY representation fails closed)."""
        def make():
            docs, lost = [], []
            for src, cwd in self.representations(plan):
                path = registry_path(dict(source=src, cwd=cwd))
                if path is None: lost.append("the session records no usable cwd, so the location of its candidate registry is not demonstrated: the accounting of the registered candidates is missing"); continue
                if not os.path.exists(path): lost.append("no candidate registry was established for this source session (prepare.py / audit.py template): the accounting of the registered candidates is missing"); continue
                doc, why = load_registry(path)
                if doc is None: return None, why
                if doc.get("source") not in (None, src): return None, "the candidate registry belongs to another source session"
                docs.append(doc)
            reason = None if not lost else (lost[0] if not docs else "a demonstrated representation of the session has no established candidate registry (audit.py template --source <it>): the accounting of the work registered against it is missing; an established registry of another representation does not stand in for it")
            if not docs: return None, reason
            merged = empty_registry(plan["source"]); ids = set()
            for d in docs:
                for c in d["candidates"]:
                    if c["id"] not in ids: ids.add(c["id"]); merged["candidates"].append(c)
                for x in d["established"]:
                    if not any(key_from_dict(y) == key_from_dict(x) for y in merged["established"]): merged["established"].append(x)
                for l in d["ledgers"]:
                    if l not in merged["ledgers"]: merged["ledgers"].append(l)
            return merged, reason
        return self.cached(("registry", plan["source"], tuple(x for x, _ in self.representations(plan))), make)

# ---------------------------------------------------------------- dispositions (re-derived from the existing validators)
def _present(ctx, k, detail):
    """Is the detail demonstrably STATED by the note (or contradicted by it) in the evaluation `k`? A bound, resolved, error-free jev_verify check of this evaluation whose only claim is the canonical absence claim of the detail, with
    a `verified` / `contradicted` real result (R03: `contradicted` only: its `verified` means the note neither states nor implies the detail) above the strict threshold and whose evidence is the exact complete material."""
    if detail is None: return False
    claim = (O.ABSENCE_PREFIX + wsnorm(detail)) if ctx.contract == "R03" else wsnorm(detail)
    ok = ("contradicted",) if ctx.contract == "R03" else ("verified", "contradicted")
    by = {c["tool_use_id"]: c for c in ctx.calls}
    for b in ctx.bindings:
        v = b.get("version")
        if not (b.get("bound") and b.get("resolved") and b.get("tool") == "verify" and not b.get("check_error") and wsnorm(b.get("claim_key")) == claim): continue
        if ctx.versioned and not (isinstance(v, dict) and v.get("ok") and key_of(v) == k): continue
        if str(b.get("real_verdict")).lower() not in ok or not J.strict_pass(b.get("real_confidence")): continue
        call = by.get(b.get("tool_use_id"))
        if call is None or call["input"].get("claims") != [claim]: continue
        if O.material_matches(b.get("call_evidence_raw") or [], b.get("omission_material")): return True
    return False

def _confirmed_omission(ctx, k, dsha, findings, verdicts):
    ids = {b["id"]: b for b in ctx.bindings}
    for f, v in zip(findings, verdicts):
        if not (isinstance(f, dict) and f.get("type") == "lost_detail" and v.get("confirmed") and isinstance(f.get("omission_ref"), dict) and isinstance(f["omission_ref"].get("detail"), str)): continue
        b = ids.get(f.get("check_id")); ver = b.get("version") if b else None
        if detail_sha(f["omission_ref"]["detail"]) == dsha and (not ctx.versioned or (isinstance(ver, dict) and ver.get("ok") and key_of(ver) == k)): return True
    return False

def _excluded(ctx, k, dsha):
    ss = ctx.scope_state(); ex = ctx.doc.get("scope_exclusions")
    if not ss.get("listed"): return False
    default = scope.report_evaluation(ctx.checks) if ctx.versioned else None
    for i, e in enumerate(ex):
        if not ss["flags"].get(i) or not isinstance(e, dict) or not isinstance(e.get("detail"), str) or detail_sha(e["detail"]) != dsha: continue
        evk, _ = scope.evaluation_of(e, default)
        if evk is None: continue
        if k == GLOBAL and evk[0] is None: return True
        if k != GLOBAL and evk[0] == k[0] and evk[1] == k[2] and evk[2] == k[3]: return True
    return False

# ---------------------------------------------------------------- the audit
def _valid_basis(b):
    return isinstance(b, dict) and isinstance(b.get("uuid"), str) and bool(b["uuid"]) and isinstance(b.get("quote"), str) and bool(b["quote"].strip())

def _chunk_reasons(block, plan, win, k, unfinished):
    by = {c["index"]: c for c in plan["chunks"]}; recs = block.get("chunks"); out = []; idx = win["indexes"]
    if not isinstance(recs, list): unfinished["chunks_unreviewed"] += len(idx); return ["%s: no chunk review records (a list is required)" % label(k)]
    seen = {}
    for r in recs:
        if isinstance(r, dict) and isinstance(r.get("index"), int) and not isinstance(r["index"], bool): seen.setdefault(r["index"], []).append(r)
        else: out.append("%s: a chunk review record without a valid index" % label(k)); unfinished["structure"] += 1
    for i in seen:
        if i not in by: out.append("%s: a review record for chunk %d, which does not exist in the prepared source" % (label(k), i)); unfinished["structure"] += 1
    miss = dup = stale = unrev = shortlist = ungrounded = 0
    for i in idx:
        rs = seen.get(i, [])
        if not rs: miss += 1; continue
        if len(rs) > 1: dup += 1; continue
        r = rs[0]
        if r.get("sha256") != by[i]["sha256"]: stale += 1; continue
        if r.get("reviewed") is not True: unrev += 1; continue
        cats = r.get("categories")
        if not (isinstance(cats, list) and len(cats) == 9 and all(isinstance(c, int) and not isinstance(c, bool) for c in cats) and sorted(cats) == list(CATEGORIES)): shortlist += 1; continue
        b = r.get("basis")
        if not (_valid_basis(b) and quote_in(win["spans"][i], plan["texts"][i], b["uuid"], b["quote"])): ungrounded += 1
    for n, key, text in ((miss, "chunks_missing", "chunks have no review record"), (dup, "chunks_duplicate", "chunks have several review records"), (stale, "chunks_stale", "chunks were reviewed against another text (stale sha256)"),
                         (unrev, "chunks_unreviewed", "chunks are not marked reviewed"), (shortlist, "chunks_partial_categories", "chunks record fewer than the nine categories"),
                         (ungrounded, "chunks_ungrounded", "chunk reviews have no basis (a uuid and an exact quote of that record, inside the window of the evaluation)")):
        if n: unfinished[key] += n; out.append("%s: %d of %d expected %s" % (label(k), n, len(idx), text))
    return out

def _category_reasons(block, plan, win, k, cands, unfinished):
    recs = block.get("categories"); out = []
    if not isinstance(recs, list): unfinished["categories"] += len(CATEGORIES); return ["%s: no category records (a list of nine is required)" % label(k)]
    by_cat = {}
    for r in recs:
        if isinstance(r, dict) and isinstance(r.get("category"), int) and not isinstance(r["category"], bool) and r["category"] in CATEGORIES: by_cat.setdefault(r["category"], []).append(r)
        else: unfinished["categories"] += 1; out.append("%s: a category record that is not one of the nine categories (extra or malformed)" % label(k))
    def grounded(b):
        if not win["indexes"]: return True      # the window holds no record at all: there is nothing a basis could quote (derived from the source, not claimed)
        return _valid_basis(b) and any(quote_in(win["spans"][i], plan["texts"][i], b["uuid"], b["quote"]) for i in win["indexes"])
    for c in CATEGORIES:
        rs = by_cat.get(c, []); mine = {x["id"] for x in cands if x.get("category") == c}
        if len(rs) != 1: unfinished["categories"] += 1; out.append("%s: category %d has %d outcome records (exactly one is required)" % (label(k), c, len(rs))); continue
        r = rs[0]; o = r.get("outcome")
        if o not in OUTCOMES: unfinished["categories"] += 1; out.append("%s: category %d has no explicit outcome (%s)" % (label(k), c, " | ".join(OUTCOMES))); continue
        lst = r.get("candidates"); listed = lst if isinstance(lst, list) and all(isinstance(x, str) for x in lst) else None
        if o == "candidates":
            if not mine or listed is None or len(listed) != len(set(listed)) or set(listed) != mine:
                unfinished["categories"] += 1; out.append("%s: category %d does not list exactly its %d registered candidate(s) (a missing, foreign or repeated id)" % (label(k), c, len(mine)))
        elif mine: unfinished["categories"] += 1; out.append("%s: category %d says %s although %d registered candidate(s) belong to it" % (label(k), c, o, len(mine)))
        elif listed or lst not in (None, []): unfinished["categories"] += 1; out.append("%s: category %d says %s but lists candidates" % (label(k), c, o))
        elif not grounded(r.get("basis")): unfinished["categories"] += 1; out.append("%s: category %d is declared %s without a source-grounded basis (uuid + an exact quote of that record, inside the window of the evaluation)" % (label(k), c, o))
    return out

def assess(ctx, evals=None, findings=None, verdicts=None):
    """The audit of a report (or of the evaluations `evals` of it) -> dict(complete, reasons, unfinished {counts}, evaluations, scope {valid, invalid}, limit). Never raises: anything that cannot be evaluated is a reason."""
    unfinished = dict(structure=0, scope=0, evaluations=0, chunks_missing=0, chunks_duplicate=0, chunks_stale=0, chunks_unreviewed=0, chunks_ungrounded=0, chunks_partial_categories=0, categories=0, candidates_unaccounted=0, candidates_unresolved=0)
    reasons = []; n_evals = 0
    try:
        doc = ctx.doc; au = doc.get("audit")
        # 1. structure: the whole report against the schema (the one validator of the writer and the gate)
        if not (isinstance(ctx.doc, dict) and ctx.doc): reasons.append("the report is not an object"); unfinished["structure"] += 1
        problems = ctx.structure()
        if problems: reasons.append("the report does not match report.schema.json: " + SC.summarize(problems)); unfinished["structure"] += len(problems)
        # 2. scope accounting (the exclusions are re-derived whatever the report says about them)
        ss = ctx.scope_state()
        if not ss.get("listed"): reasons.append("scope_exclusions is missing or not a list: the accounting of the scope filter is absent"); unfinished["scope"] += 1
        elif ss["invalid"]: reasons.append("invalid scope exclusions: %d" % ss["invalid"]); unfinished["scope"] += ss["invalid"]
        # 3. the evaluations (each distinct evaluation once: two checks of one evaluation are one evaluation)
        evs = list(dict.fromkeys(ctx.evaluations() if evals is None else evals)); n_evals = len(evs)
        if not evs: reasons.append("no evaluation with a demonstrated version identity: there is nothing the review can be tied to"); unfinished["evaluations"] += 1
        findings = doc.get("findings", []) if findings is None else findings
        if not isinstance(findings, list): findings = []
        if verdicts is None: verdicts = [dict(confirmed=False)] * len(findings)
        if isinstance(au, dict) and isinstance(au.get("evaluations"), list):
            mc = au.get("max_chars", CHUNK_CHARS); max_chars = mc if isinstance(mc, int) and not isinstance(mc, bool) and 200 <= mc <= 1000000 else None
            if max_chars is None: max_chars = CHUNK_CHARS      # (the schema problem above is the reason)
            plan, why = ctx.plan(max_chars)
            if plan is None: reasons.append(why); unfinished["evaluations"] += len(evs)
            reg = rwhy = None; named = au.get("registry"); ledgers = []
            if plan is not None:
                reg, rwhy = ctx.registry_state(plan)
                if named is not None:
                    mine = [registry_path(dict(source=x, cwd=c)) for x, c in ctx.representations(plan)]      # the registry of the session, or of a representation of it that the inputs demonstrate
                    if not (isinstance(named, str) and any(m and os.path.realpath(named) == os.path.realpath(m) for m in mine)):
                        reasons.append("audit.registry names another registry than the one established for this source session (a substituted registry accounts for nothing): the session's own registry is used"); unfinished["candidates_unaccounted"] += 1
                ledgers = list(reg["ledgers"]) if reg else []
            if au.get("ledger") is not None:
                if isinstance(au["ledger"], str):
                    if os.path.realpath(au["ledger"]) not in ledgers: ledgers.append(os.path.realpath(au["ledger"]))
                else: reasons.append("audit.ledger is not a path"); unfinished["candidates_unaccounted"] += 1
            note_real = os.path.realpath(ctx.handoff_path) if ctx.handoff_path else None
            sources = [x for x, _ in ctx.representations(plan)] if plan is not None else []
            for k in (evs if plan is not None else []):
                blocks = [b for b in au["evaluations"] if isinstance(b, dict) and key_from_dict(b.get("evaluation")) == k]
                if len(blocks) != 1: unfinished["evaluations"] += 1; reasons.append("%s: %d audit blocks (exactly one is required)" % (label(k), len(blocks))); continue
                block = blocks[0]
                win, why = ctx.cached(("window", max_chars, k), lambda: window_of(plan, ctx.source, k))
                if win is None: unfinished["evaluations"] += 1; reasons.append("%s: %s" % (label(k), why)); continue
                reasons += _chunk_reasons(block, plan, win, k, unfinished)
                # expected candidates: the registry of the session (applicable to this write / hash / mode / run) and the whole applicable ledger(s)
                cands = {}
                if reg is None: reasons.append("%s: %s" % (label(k), rwhy)); unfinished["candidates_unaccounted"] += 1
                else:
                    if rwhy: reasons.append("%s: %s" % (label(k), rwhy)); unfinished["candidates_unaccounted"] += 1      # a readable registry of one representation never stands in for the missing one of another (the readable ones still count)
                    if not any(key_from_dict(x) == k for x in reg["established"]): reasons.append("%s: the evaluation was never established in the session's candidate registry (audit.py template / register): its accounting is missing" % label(k)); unfinished["candidates_unaccounted"] += 1
                    for c in reg["candidates"]:
                        if applicable(c, k): cands[c["detail_sha256"]] = dict(c, origin="registry")   # the id the registration printed
                for lp in ledgers:
                    rows, lwhy = ledger_candidates(lp, k, note_real, sources)
                    if lwhy: reasons.append("%s: %s" % (label(k), lwhy)); unfinished["candidates_unaccounted"] += 1
                    for c in rows:
                        if c["detail_sha256"] in cands: cands[c["detail_sha256"]].setdefault("also", []).append(c["origin"])
                        else: cands[c["detail_sha256"]] = c
                cl = list(cands.values())
                reasons += _category_reasons(block, plan, win, k, cl, unfinished)
                expl, ids = set(), {c["id"]: d for d, c in cands.items()}
                for x in block.get("unresolved") if isinstance(block.get("unresolved"), list) else []:
                    if isinstance(x, dict):
                        if isinstance(x.get("candidate"), str) and x["candidate"] in ids: expl.add(ids[x["candidate"]])
                        if isinstance(x.get("detail"), str): expl.add(detail_sha(x["detail"]))
                for dsha, c in cands.items():
                    if _confirmed_omission(ctx, k, dsha, findings, verdicts) or _excluded(ctx, k, dsha) or _present(ctx, k, c.get("detail")): continue
                    if dsha in expl: unfinished["candidates_unresolved"] += 1; reasons.append("%s: candidate %s is declared unresolved work" % (label(k), c["id"]))
                    else: unfinished["candidates_unaccounted"] += 1; reasons.append("%s: registered candidate %s (%s) has no derived disposition (no valid exclusion, no resolved present check with the exact material, no validated finding)" % (label(k), c["id"], c.get("origin")))
    except Exception as e:   # fail closed: an audit that cannot be evaluated is an incomplete audit, never a PASS and never a crash
        reasons.append("the audit could not be evaluated (%s)" % e.__class__.__name__); unfinished["structure"] += 1
    ss = ctx.scope_state() if isinstance(ctx.doc, dict) else dict(valid=0, invalid=0)
    return dict(complete=not reasons, reasons=reasons, unfinished=unfinished, evaluations=n_evals, scope=dict(valid=ss.get("valid", 0), invalid=ss.get("invalid", 0)), limit=LIMIT)

def summary(a, cap=5):
    """The compact form stored in `binding_summary.audit` (the reasons are kept up to `cap`; counts are exact). A reason is built only from fixed text, counts, schema names and ids vetted by `O.id_text`, and every dynamic external text
    (a ledger error, a window reason) was sanitized where it was produced, so a recorded identifier stays exact here and a refused one is the display marker."""
    return dict(complete=a["complete"], reasons=list(a["reasons"][:cap]), reasons_total=len(a["reasons"]),
                unfinished={k: v for k, v in a["unfinished"].items() if v}, evaluations=a["evaluations"], scope=a["scope"])

def certify(ev, ctx, evals=None, findings=None):
    """The ONE certifying status function: `ev` = jevref.audited_status(...) of the same checks / findings. A PASS needs a COMPLETE audit, otherwise it is UNRESOLVED (the audit reasons are added); a FAIL stays FAIL (a validated defect keeps
    its precedence) and an UNRESOLVED stays UNRESOLVED; in every case the audit is exposed as `audit` (see `summary`). The writer, the gate and the per-version evaluation all call this."""
    fs = findings if findings is not None else ctx.doc.get("findings", [])
    a = assess(ctx, evals, fs, ev.get("finding_verdicts"))
    out = dict(ev, audit=summary(a), audit_complete=a["complete"]); reasons = list(ev.get("reasons") or [])
    ss = ctx.scope_state()
    if ss.get("listed") and ss["invalid"]: reasons.append("invalid scope exclusions: %d" % ss["invalid"])   # the exact reason the writer has always given (also next to another reason)
    if ev["status"] == "PASS" and not a["complete"]:
        out["status"] = "UNRESOLVED"; rest = [r for r in a["reasons"] if not r.startswith("invalid scope exclusions")]
        reasons.append("audit incomplete: " + "; ".join((rest or a["reasons"])[:3]) + (" (+%d more)" % (len(rest or a["reasons"]) - 3) if len(rest or a["reasons"]) > 3 else ""))
    out["reasons"] = reasons
    return out

def no_context(ev, why="no audit context was supplied"):
    """A status evaluation that has no way to audit (the caller supplied no context): a PASS is capped, nothing else changes."""
    out = dict(ev, audit=dict(complete=False, reasons=[why], reasons_total=1, unfinished=dict(structure=1), evaluations=0, scope=dict(valid=0, invalid=0)), audit_complete=False)
    if ev["status"] == "PASS": out["status"] = "UNRESOLVED"; out["reasons"] = list(ev.get("reasons") or []) + ["audit incomplete: " + why]
    return out

# ---------------------------------------------------------------- CLI
def _version_of(source, note, write_id, cwd):
    sp, how, amb = D.resolve_session_info(source, cwd)
    if amb or not sp or not D.source_exists(sp): return None, None, "source session not found or not demonstrated"
    path = note if os.path.isabs(note) else os.path.join(cwd or os.getcwd(), note)
    vs, canon, _, why = V.versions_of(sp, path)
    v = next((x for x in vs or [] if x["write_tool_use_id"] == write_id), None)
    return (sp, v, None) if v else (sp, None, why or "the write id is not a version of the note in the source session")

def build_parser():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("register", "template"):
        p = sub.add_parser(name); p.add_argument("--source"); p.add_argument("--file", required=True); p.add_argument("--write-id", dest="write_id", required=True)
        p.add_argument("--evaluated-against", choices=("prefix", "session_end"), required=True, dest="evaluated_against"); p.add_argument("--run"); p.add_argument("--cwd")
        p.add_argument("--registry", help="accepted only when it names the registry of the session (its location is derived from the source; a report cannot choose it)")
        if name == "register": p.add_argument("--detail", required=True); p.add_argument("--category", type=int, choices=CATEGORIES); p.add_argument("--quote")
        else: p.add_argument("--ledger", help="an omission ledger of the session (`omissions.py prepare-batch --ledger`): its obligations become expected work")
    return ap

def main(argv=None):
    a = build_parser().parse_args(argv)
    def fail(why): print(json.dumps(dict(ok=False, reason=O.S.sanitize(why)[0]))); return 3
    sp, v, why = _version_of(a.source, a.file, a.write_id, a.cwd)
    if v is None: return fail(why)
    k = (a.write_id, v["sha256"], a.evaluated_against, a.run if a.evaluated_against == "session_end" else None)
    note = a.file if os.path.isabs(a.file) else os.path.join(a.cwd or os.getcwd(), a.file)
    plan = plan_of(sp, note, CHUNK_CHARS); reg_path = registry_path(plan)
    if reg_path is None: return fail("the session records no usable cwd: the location of its candidate registry is not demonstrated")
    if a.registry and os.path.realpath(a.registry) != os.path.realpath(reg_path): return fail("--registry is not the registry of this session (%s): its location is derived from the source and cannot be chosen" % reg_path)
    source = D.canon(sp)
    try:
        if a.cmd == "register":
            c, added = register(reg_path, source, k, a.detail, a.category, a.quote)
            print(json.dumps(dict(ok=True, registered=added, candidate=c["id"], category=c["category"], detail_withheld=c["detail"] is None, registry=reg_path, note="registered BEFORE the scope filter: a registered candidate stays work until a derived disposition accounts for it"), ensure_ascii=False)); return 0
        reg = establish(reg_path, source, k)
        if a.ledger: reg = associate_ledger(reg_path, source, a.ledger)
    except ValueError as e: return fail(str(e))
    try: block = block_template(plan, k, sp)
    except ValueError as e: return fail(str(e))
    cands = {c["detail_sha256"]: dict(id=c["id"], category=c["category"], detail=c["detail"], origin="registry") for c in reg["candidates"] if applicable(c, k)}
    for lp in reg["ledgers"]:
        for c in ledger_candidates(lp, k, os.path.realpath(note), [source])[0]: cands.setdefault(c["detail_sha256"], dict(id=c["id"], category=None, detail=c["detail"], origin=c["origin"]))
    print(json.dumps(dict(ok=True, block=block, registry=reg_path, expected_candidates=list(cands.values()), note="UNREVIEWED work: review every expected chunk for all nine categories, then set reviewed true, list the nine categories and give a basis (uuid + exact quote of a record of the chunk inside the window) per chunk, and one grounded outcome per category; the audit re-derives the expected chunks and the window", limit=LIMIT), indent=1, ensure_ascii=False)); return 0

if __name__ == "__main__": sys.exit(main())

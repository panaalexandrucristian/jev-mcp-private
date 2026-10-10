#!/usr/bin/env python3
"""Collect NEW evidence for the single re-verification of a verify/gate result that did not pass (stdlib only; offline: no Jev call, no network, nothing executed; files are only READ).

advice.py says what is missing (`advice.evidence_request`, state collect_local). This module checks what the agent or the user PROPOSES and moves the request on:
  collect_local --new eligible material found--> ready          (a corrected claim for a claim_correction request)
  collect_local --nothing, interactive---------> ask_user       (ONE grouped question, local paths only)
  collect_local --nothing, headless-------------> blocked        (the check stays UNRESOLVED; nobody is waited for)
  ask_user      --asked already, still nothing--> blocked
A question is not a Jev call and does not consume the single re-verification; this module never changes rounds_used, rounds_limit or retry_remaining of a request that stays open.

A proposal is {"request_id", "kind": "local_file" | "local_dir" | "transcript_record" | "corrected_claim", "path", "lines": [first, last], "uuid", "quote", "text"}. Only local ABSOLUTE paths are admitted (no URL, no .env or alias of one, no symlink,
no binary or oversized file, no path that holds a secret); the shared sanitizing policy (sanitize.sanitize_material) runs BEFORE anything is shown or stored and a redaction-dependent item is ineligible and is never echoed.
A transcript_record is an EXACT quote (case-sensitive, inside one block) of the session itself; it is eligible only in the shared source window of the evaluated write (omissions.window_for / eligible_blocks_indexed: before the write,
never the note's own Write or Edit, never a Jev call, never verification material) and only when the request is bound to a version_ref. That the note's path was not written in several streams is re-derived when the
re-verification is authorized, not here. Material is NEW only when its normalized text is not already inside one evidence entry the original call received (case, spacing and identifiers do not make it new), and one passage counts once. An answer typed in
the chat is never evidence. Authorizing the re-verification, binding its input hash and recording it come later.

CLI: evidence.py collect --session ID|PATH.jsonl|... [--cwd DIR] [--registry PATH] [--proposals FILE.json] [--version-ref-file FILE.json] [--headless] [--asked]   -> JSON {requests, question, unmatched_proposals, ignored_proposals}."""
import argparse, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import advice as AD, jevref as J, refs, sanitize as S

MAX_FILE_BYTES = 1_000_000      # a larger file is not read
MAX_DIR_FILES = 100             # a directory proposal is expanded one level, in name order, up to this many files
MAX_QUOTE_CHARS = 8000          # one item (a whole short file or a line range) is at most this long
QUESTION_RO = ("Nu am găsit dovezi locale eligibile pentru verificările enumerate. Indicați numai căile locale absolute ale fișierelor sau directoarelor care conțin materialul solicitat. "
               "Nu trimiteți conținut, explicații sau secrete. Răspunsul nu poate deveni dovadă retroactivă pentru versiunea istorică. Dacă nu aveți o cale disponibilă, verificările rămân UNRESOLVED.")

def sha256(x): return hashlib.sha256(x if isinstance(x, bytes) else str(x).encode("utf-8")).hexdigest()

def _unsafe(text):
    """True when the shared policy would change the text or the text depends on a redaction marker: it is never echoed, shown to the user or sent to Jev."""
    info = S.identity_altered(text)
    return info["changed"] or info["redaction_dependent"]

def _excluded_parts(path): return any(S.is_excluded_file(p) for p in path.split(os.sep) if p)

def admit_path(path):
    """-> (real path | None, reason | None). The path and its alias are judged BEFORE anything is opened: absolute and local, no URL, no secret in the name, no .env (or a .env component), no symlink, an existing regular
    file of at most MAX_FILE_BYTES that is UTF-8 text without NUL, or a directory."""
    if not isinstance(path, str) or not path or "\x00" in path: return None, "not_absolute"
    if refs.is_remote(path): return None, "remote_url"
    if not os.path.isabs(path): return None, "not_absolute"
    if _unsafe(path): return None, "path_redaction_dependent"
    if _excluded_parts(path): return None, "excluded_env"
    if os.path.islink(path): return None, "symlink"
    if not os.path.lexists(path): return None, "not_found"
    real = os.path.realpath(path)
    if _excluded_parts(real): return None, "excluded_env"
    if os.path.isdir(real): return real, None
    if not os.path.isfile(real): return None, "not_regular"
    try:
        if os.path.getsize(real) > MAX_FILE_BYTES: return None, "too_large"
        with open(real, "rb") as f: data = f.read(MAX_FILE_BYTES + 1)
        if b"\x00" in data: return None, "not_text"
        data.decode("utf-8")
    except UnicodeDecodeError: return None, "not_text"
    except OSError: return None, "not_found"
    return real, None

def expand(real):
    """A directory -> its regular, non-hidden, non-symlink files (one level, in name order, at most MAX_DIR_FILES); a file -> [file]."""
    if not os.path.isdir(real): return [real]
    try: names = sorted(os.listdir(real))
    except OSError: return []
    out = []
    for n in names:
        p = os.path.join(real, n)
        if n.startswith(".") or S.is_excluded_file(n) or os.path.islink(p) or not os.path.isfile(p): continue
        out.append(p)
        if len(out) >= MAX_DIR_FILES: break
    return out

def _bad(path, reason, kind="local_file"): return dict(kind=kind, path=path, eligible=False, reason=reason)

def read_item(path, lines=None):
    """-> an item of a local file (read-only). Eligible: {kind, path, lines [first, last] (1-based), file_sha256 (the file's bytes), quote (exactly the selected lines), raw_sha256 and sanitized_sha256 of the quote, eligible True}.
    Not eligible: {kind, path | None, eligible False, reason}; a secret in the text is never echoed. A file longer than MAX_QUOTE_CHARS needs a line range."""
    real, why = admit_path(path)
    if real is None: return _bad(None if why in ("path_redaction_dependent", "not_absolute", "remote_url") else path, why)
    if os.path.isdir(real): return _bad(real, "not_a_file")
    with open(real, "rb") as f: data = f.read()
    rows = data.decode("utf-8").splitlines()
    if lines is None:
        first, last = 1, max(1, len(rows))
        if len("\n".join(rows)) > MAX_QUOTE_CHARS: return _bad(real, "too_long_select_lines")
    else:
        if not (isinstance(lines, (list, tuple)) and len(lines) == 2 and all(type(x) is int for x in lines)): return _bad(real, "bad_line_range")
        first, last = lines
        if not (1 <= first <= last <= len(rows)): return _bad(real, "bad_line_range")
    quote = "\n".join(rows[first - 1:last])
    if len(quote) > MAX_QUOTE_CHARS: return _bad(real, "too_long_select_lines")
    clean, info = S.sanitize_material(quote)
    if info["changed"] or info["redaction_dependent"]: return _bad(real, "redaction_dependent")
    return dict(kind="local_file", path=real, lines=[first, last], file_sha256=sha256(data), quote=quote, raw_sha256=sha256(quote), sanitized_sha256=sha256(clean), eligible=True)

def _rejected(kind, path, reason): return dict(kind=kind, path=path, reason=reason)

def _transcript(source, version_ref):
    """-> ((eligible blocks [(text, provenance)], sha256 of the transcript, window), None) or (None, reason): the blocks of the shared source window of the evaluated write, nothing else."""
    if version_ref is None: return None, "version_unbound"
    if not source: return None, "transcript_unavailable"
    import discover as D, omissions as O
    try:
        w, recs = O.window_for(source, version_ref["write_tool_use_id"], version_ref["evaluated_against"], version_ref.get("run"))
        if w is None: return None, "transcript_unreadable"
        if w["ambiguous"]: return None, "window_ambiguous"
        return (O.eligible_blocks_indexed(recs, None, w["limit"], w["excluded"]), D.content_fingerprint(source)[2], w), None
    except (OSError, ValueError, KeyError, TypeError): return None, "transcript_unreadable"

def _record_item(blocks, sha, w, version_ref, uuid, quote):
    """-> an eligible item for the first eligible block that holds the quote EXACTLY (and, when a uuid is given, belongs to that record), or (None, reason)."""
    hit = next(((t, p) for t, p in blocks if quote in t and (uuid is None or p.get("uuid") == uuid)), None)
    if hit is None: return None, ("quote_not_in_record" if uuid is not None and any(quote in t for t, _ in blocks) else "not_in_eligible_source")
    clean, info = S.sanitize_material(quote)
    if info["changed"] or info["redaction_dependent"]: return None, "redaction_dependent"
    p = hit[1]
    return dict(kind="transcript_record", uuid=p.get("uuid"), record=p.get("record"), line=p.get("line"), block=p.get("block"), block_kind=p.get("kind"), quote=quote, source_sha256=sha,
                window=dict(write_tool_use_id=version_ref["write_tool_use_id"], evaluated_against=version_ref["evaluated_against"], run=version_ref.get("run"), limit=w["limit"]),
                raw_sha256=sha256(quote), sanitized_sha256=sha256(clean), eligible=True), None

def collect(request, call, proposals, source=None):
    """Check the PROPOSALS for one request against the evidence its original `call` received; `source` = the session transcript (path or selector) the transcript_record proposals are read from.
    -> {items (eligible and NEW), rejected [{kind, path, reason}], searched [admitted paths and the transcript], corrected_claim | None}."""
    originals = J.call_evidence(call)
    claim = ((request.get("target") or {}).get("jev_ref") or {}).get("key"); version_ref = (request.get("target") or {}).get("version_ref")
    items, rejected, searched, seen, corrected, tx = [], [], [], set(), None, []

    def keep(kind, shown, it):
        n = J._norm(it["quote"])
        if n in seen: rejected.append(_rejected(kind, shown, "duplicate")); return
        if not n or any(n in o for o in originals): rejected.append(_rejected(kind, shown, "not_new")); return
        seen.add(n); items.append(dict(it, new=True))
    for p in proposals:
        if not isinstance(p, dict): rejected.append(_rejected(None, None, "malformed_proposal")); continue
        kind = p.get("kind")
        if kind in ("local_file", "local_dir"):
            real, why = admit_path(p.get("path"))
            if real is None: rejected.append(_rejected(kind, None if why in ("path_redaction_dependent", "not_absolute", "remote_url") else p.get("path"), why)); continue
            if kind == "local_file" and os.path.isdir(real): rejected.append(_rejected(kind, real, "not_a_file")); continue
            if kind == "local_dir" and not os.path.isdir(real): rejected.append(_rejected(kind, real, "not_a_directory")); continue
            searched.append(real)
            for f in expand(real):
                it = read_item(f, p.get("lines") if kind == "local_file" else None)
                if not it["eligible"]: rejected.append(_rejected(kind, it["path"], it["reason"])); continue
                keep(kind, it["path"], it)
        elif kind == "transcript_record":
            quote, uuid = p.get("quote"), p.get("uuid")
            if not isinstance(quote, str) or not quote.strip() or not (uuid is None or isinstance(uuid, str)): rejected.append(_rejected(kind, None, "malformed_proposal")); continue
            if len(quote) > MAX_QUOTE_CHARS: rejected.append(_rejected(kind, None, "quote_too_long")); continue
            if not tx: tx.append(_transcript(source, version_ref))
            ctx, why = tx[0]
            if ctx is None: rejected.append(_rejected(kind, None, why)); continue
            it, why = _record_item(*ctx, version_ref, uuid, quote)
            if it is None: rejected.append(_rejected(kind, None, why)); continue
            if source not in searched: searched.append(source)
            keep(kind, None, it)
        elif kind == "corrected_claim":
            text = p.get("text")
            if not isinstance(text, str) or not text.strip(): rejected.append(_rejected(kind, None, "malformed_proposal")); continue
            info = S.sanitize_material(text)[1]
            if info["changed"] or info["redaction_dependent"]: rejected.append(_rejected(kind, None, "redaction_dependent")); continue
            if not isinstance(claim, str): rejected.append(_rejected(kind, None, "no_claim_to_correct")); continue
            if J._norm(text) == J._norm(claim): rejected.append(_rejected(kind, None, "not_a_correction")); continue
            if corrected is not None: rejected.append(_rejected(kind, None, "duplicate")); continue
            corrected = dict(text=text, sha256=sha256(text))
        else: rejected.append(_rejected(kind if isinstance(kind, str) and not _unsafe(kind) else None, None, "unknown_kind"))
    return dict(items=items, rejected=rejected, searched=searched, corrected_claim=corrected)

def advance(request, collected, headless=False, asked=False):
    """-> a COPY of the request moved on by what was collected (see the module doc). Only an open request (collect_local or ask_user) moves; blocked, exhausted and ready requests are returned as they are.
    rounds_used, rounds_limit and the rest of the identity never change; an open request keeps its single re-verification (a question is not a Jev call)."""
    r = dict(request)
    if r["state"] not in ("collect_local", "ask_user"): return r
    left = r["rounds_limit"] - r["rounds_used"]
    if r["remedy"] == "claim_correction":      # a wrong fact is answered by a corrected claim, never by files, and the user is not asked for a path
        if collected.get("corrected_claim"): r.update(state="ready", question_ro=None, stop_reason=None, retry_remaining=left)
        return r
    if r["remedy"] != "semantic_evidence": return r
    if collected.get("items"): r.update(state="ready", question_ro=None, stop_reason=None, retry_remaining=left)
    elif asked: r.update(state="blocked", question_ro=None, stop_reason="no_local_evidence_after_question", retry_remaining=0)
    elif headless: r.update(state="blocked", question_ro=None, stop_reason="no_local_evidence_headless", retry_remaining=0)
    else: r.update(state="ask_user", question_ro=QUESTION_RO, stop_reason=None, retry_remaining=left)
    return r

def grouped_question(requests, searched=()):
    """-> {text, requests} for the ONE grouped question of the requests still in ask_user (the agreed Romanian text plus a sanitized list of the request ids, what is missing and where was searched), or None."""
    asks = [r for r in requests if r.get("state") == "ask_user"]
    if not asks: return None
    where = [s for s in searched if isinstance(s, str) and not _unsafe(s)]
    lines = ["- %s: %s" % (r["request_id"], ", ".join(r["missing_artifacts"]) or "dovezi locale") for r in asks]
    text = QUESTION_RO + "\n\nVerificări care așteaptă o cale:\n" + "\n".join(lines) + ("\n\nLocuri deja căutate: " + ", ".join(where) if where else "")
    return dict(text=text, requests=[dict(request_id=r["request_id"], missing_artifacts=list(r["missing_artifacts"])) for r in asks])

def _fail(msg, rc): print(json.dumps({"error": msg})); return rc

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect"); c.add_argument("--session"); c.add_argument("--cwd"); c.add_argument("--registry"); c.add_argument("--proposals"); c.add_argument("--version-ref-file"); c.add_argument("--headless", action="store_true"); c.add_argument("--asked", action="store_true")
    a = ap.parse_args()
    import discover as D
    sp, how, amb = D.resolve_session_info(a.session, a.cwd)
    if amb: return _fail("current session not demonstrated: several recently modified sessions; pass --session ID or PATH.jsonl", 3)
    if not sp or not D.source_exists(sp): return _fail("session not found", 2)
    props = []
    if a.proposals:
        try: doc = json.load(open(a.proposals, encoding="utf-8"))
        except (OSError, ValueError) as e: return _fail("proposals file unreadable (%s)" % e.__class__.__name__, 2)
        if not (isinstance(doc, dict) and isinstance(doc.get("proposals"), list)): return _fail("proposals file must be an object with a list `proposals`", 2)
        props = doc["proposals"]
    vref, bad = AD.load_version_ref(a.version_ref_file)
    if bad: return _fail(bad, 2)
    history, consulted, why = AD.load_history(a.registry)
    calls = J.load_calls(sp); by_id = {x["tool_use_id"]: x for x in calls}
    rows = AD.session_advice(calls, history, vref)
    ids = {r["advice"]["evidence_request"]["request_id"] for r in rows}
    own = lambda p: p.get("request_id") if isinstance(p, dict) else None
    out, searched, ignored = [], [], []
    for r in rows:
        req = r["advice"]["evidence_request"]; mine = [p for p in props if own(p) == req["request_id"]]
        if req["state"] != "collect_local":
            if mine: ignored.append(dict(request_id=req["request_id"], state=req["state"]))
            out.append(dict(request=req, collected=dict(items=[], rejected=[], searched=[], corrected_claim=None))); continue
        got = collect(req, by_id[r["tool_use_id"]], mine, sp); searched += [x for x in got["searched"] if x not in searched]
        out.append(dict(request=advance(req, got, a.headless, a.asked), collected=got))
    unmatched = [dict(request_id=own(p) if isinstance(own(p), str) else None, kind=p.get("kind") if isinstance(p, dict) and isinstance(p.get("kind"), str) and not _unsafe(p["kind"]) else None) for p in props if own(p) not in ids]
    res = dict(session=sp, resolution=how, history_consulted=consulted, requests=out, question=grouped_question([o["request"] for o in out], searched), unmatched_proposals=unmatched, ignored_proposals=ignored)
    if why: res["history_error"] = why
    print(json.dumps(res, indent=1, ensure_ascii=False)); return 0

if __name__ == "__main__": sys.exit(main())

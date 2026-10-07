#!/usr/bin/env python3
"""What to try first for a jev_verify / jev_gate claim that did not pass (deterministic hint, never a verdict; stdlib only, read-only).

The rules come from the real history of this machine (918 Claude Code and OpenCode sessions, 2026-10-07): 966 jev_verify results were not `verified` above 0.95;
of the 110 real cases later re-asked in a similar form and passed, 62 kept the same claim and changed the evidence (43 with > 20% more evidence) and 48 narrowed
the claim (32 with shorter, more focused evidence); `contradicted` results were real wrong facts (test counts, versions, inverted decisions), fixed by correcting the claim.
Backtest of these rules (836 non-lab sessions, 785 results that did not pass, 63 later re-asked in a similar form and passed): after add_direct_evidence the claim was kept with new
evidence 29 times and changed 28 times, so for low confidence the history does not tell which works (the hint asks for both when the claim is compound); none of the 76 fix_fact claims passed later.

The advice never changes a status and never relaxes report.retry_decision: at most one re-verification, only with NEW evidence or a corrected claim, never an identical call.

CLI: advice.py --session ID|PATH.jsonl|opencode:ID|opencode-db:/ABS/DB#ID [--cwd DIR]   -> JSON with every verify/gate result that did not pass and its advice."""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevref as J

CODES = ("evidence_off_subject", "fix_fact", "recheck_fact", "remove_unsupported_detail", "add_source_passage", "add_direct_evidence", "no_result")
HINTS = {
    "evidence_off_subject": "Jev judged the evidence to be about another subject (same_subject below subject_at): give the exact passage about this claim's subject.",
    "fix_fact": "The evidence contradicts the claim with high confidence: correct the fact from the source; more evidence of the same kind will not help.",
    "recheck_fact": "The evidence leans against the claim, below the threshold: compare the claim with the source; if it is wrong, correct it, if it is right, add the exact passage that states it.",
    "remove_unsupported_detail": "These details of the claim do not appear in the evidence: remove them from the claim or add the passage that states them.",
    "add_source_passage": "The evidence does not state the claim: add the exact source passage (command output, file lines, transcript quote) that states it.",
    "add_direct_evidence": "The claim is supported below the threshold: add the direct evidence for it (the exact output or lines), not a summary.",
    "no_result": "No usable result: only a transport error allows one identical retry; otherwise the check stays unresolved.",
}
SPLIT_HINT = " It joins several facts: in the same single re-verification, split it into one claim per fact, each with only its own evidence."
# identifiers that must appear in the evidence when the claim states them: numbers, versions, hashes, paths, file names, code names
DETAIL = re.compile(r"`[^`]+`|[\w./~:-]*\d[\w./:-]*|[\w-]+(?:/[\w.-]+)+|\w+\.\w{1,5}\b|\b\w+_\w+\b")
JOIN = re.compile(r";|,? (?:and|but|while|whereas|și|iar|dar|însă) |, ", re.I)

def passed(entry, call):
    """The claim holds: `verified`, strictly > 0.95, with the strict auxiliary conditions (a confirmed `contradicted` is a claim that failed, not a pass)."""
    return str(entry.get("verdict")).lower() == "verified" and J.strict_pass(entry.get("confidence")) and J.aux_ok(entry, call, True)

def evidence_text(call):
    return " ".join(J.call_evidence(call))

def unsupported_details(claim, evidence):
    """Claim details (see DETAIL) that the normalized evidence does not contain, in claim order, without repeats."""
    ev, out = J._norm(evidence), []
    for m in DETAIL.findall(claim or ""):
        d = m.strip("`").rstrip(".,:;)").lower()
        if len(d) > 1 and d not in ev and d not in out: out.append(d)
    return out

def compound(claim):
    """True when the claim joins at least two facts (split on ;, commas and conjunctions) of three or more words each."""
    parts = [p for p in JOIN.split(claim or "") if len(p.split()) >= 3]
    return len(parts) >= 2

def advise(entry, call):
    """entry: a jevref.results_of entry of a verify/gate call; -> {code, hint[, details][, split]}, or None when the result passed."""
    if call.get("is_error") or entry.get("verdict") is None or entry.get("confidence") is None:
        return dict(code="no_result", hint=HINTS["no_result"])
    if passed(entry, call): return None
    sa, ss = (call.get("parsed") or {}).get("subject_at"), entry.get("same_subject")
    verdict = str(entry["verdict"]).lower()
    if J._num(ss) and J._num(sa) and ss < sa: code = "evidence_off_subject"
    elif verdict == "contradicted": code = "fix_fact" if J.strict_pass(entry["confidence"]) else "recheck_fact"
    elif verdict == "unsupported":
        miss = unsupported_details(entry.get("key"), evidence_text(call))
        if miss: return dict(code="remove_unsupported_detail", hint=HINTS["remove_unsupported_detail"], details=miss)
        code = "add_source_passage"
    elif compound(entry.get("key")): return dict(code="add_direct_evidence", hint=HINTS["add_direct_evidence"] + SPLIT_HINT, split=True)
    else: code = "add_direct_evidence"
    return dict(code=code, hint=HINTS[code])

def session_advice(calls):
    out = []
    for c in calls:
        if c["tool"] not in ("verify", "gate"): continue
        ents, why = J.results_of(c)
        if why:
            out.append(dict(tool_use_id=c["tool_use_id"], tool=c["tool"], result_index=None, claim=None, verdict=None, confidence=None, advice=dict(code="no_result", hint=HINTS["no_result"]))); continue
        for e in ents:
            a = advise(e, c)
            if a: out.append(dict(tool_use_id=c["tool_use_id"], tool=c["tool"], result_index=e["index"], claim=e["key"], verdict=e["verdict"], confidence=e["confidence"], advice=a))
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--session"); ap.add_argument("--cwd"); a = ap.parse_args()
    import discover as D
    sp, how, amb = D.resolve_session_info(a.session, a.cwd)
    if amb: print(json.dumps({"error": "current session not demonstrated: several recently modified sessions; pass --session ID or PATH.jsonl", "resolution": how})); return 3
    if not sp or not D.source_exists(sp): print(json.dumps({"error": "session not found", "arg": a.session})); return 2
    print(json.dumps(dict(session=sp, resolution=how, rule="at most one re-verification, with new evidence or a corrected claim; never an identical call", results=session_advice(J.load_calls(sp))), indent=1, ensure_ascii=False)); return 0

if __name__ == "__main__": sys.exit(main())

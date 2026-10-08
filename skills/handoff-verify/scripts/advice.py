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

CODES = ("protocol_fields_absent", "evidence_off_subject", "fix_fact", "recheck_fact", "remove_unsupported_detail", "add_source_passage", "add_direct_evidence", "aux_condition_failed", "result_mismatch", "no_result")
HINTS = {
    "protocol_fields_absent": "The recorded response does not contain %s, which the strict conditions need (same_subject on each result, subject_at at the top level of the response): this response cannot pass whatever the evidence, so more evidence will not help. Do not spend the single re-verification on it; the check stays UNRESOLVED. A future run needs a server whose recorded verify/gate responses carry these fields (an ABSENCE check of an omission pair does not need them).",
    "evidence_off_subject": "Jev judged the evidence to be about another subject (same_subject below subject_at): give the exact passage about this claim's subject.",
    "fix_fact": "The evidence contradicts the claim with high confidence: correct the fact from the source; more evidence of the same kind will not help.",
    "recheck_fact": "The evidence leans against the claim, below the threshold: compare the claim with the source; if it is wrong, correct it, if it is right, add the exact passage that states it.",
    "remove_unsupported_detail": "These details of the claim do not appear in the evidence: remove them from the claim or add the passage that states them.",
    "add_source_passage": "The evidence does not state the claim: add the exact source passage (command output, file lines, transcript quote) that states it.",
    "add_direct_evidence": "The claim is supported below the threshold: add the direct evidence for it (the exact output or lines), not a summary.",
    "aux_condition_failed": "Jev did not let the verdict stand on its own: the action is review, or same_subject/subject_at is missing. Give evidence about exactly this claim; a server that returns no same_subject/subject_at cannot pass the strict conditions.",
    "result_mismatch": "The result does not carry the claim that was sent (%s): no advice can be read from it; the check stays unresolved. Re-verify only with a corrected call that carries this claim.",
    "no_result": "No usable result: only a transport or invalid_response error allows one identical retry; otherwise the check stays unresolved.",
}
CAPABILITY_NOTE = ("What the recorded verify/gate responses of this session show, per tool and envelope shape: the state (absent / null / invalid / finite) of same_subject on each result and of subject_at at the top level. Every response is judged on its own fields: "
                   "strict acceptance needs both finite at those locations, a response without them cannot be accepted whatever the evidence, and a later response that carries them is judged normally. Future runs need a server whose recorded responses carry these fields; "
                   "this skill installs or restarts nothing, retrofits no old result and leaves the retry rule unchanged.")
SPLIT_HINT = " It joins several facts: in the same single re-verification, split it into one claim per fact, each with only its own evidence."
# identifiers that must appear in the evidence when the claim states them: numbers, versions, hashes, paths, file names, code names
DETAIL = re.compile(r"`[^`]+`|[\w./~:-]*\d[\w./:-]*|[\w-]+(?:/[\w.-]+)+|\w+\.(?:md|txt|json|py|sh|yml|yaml|toml|js|mjs|ts)\b|\b\w+_\w+\b")
JOIN = re.compile(r";|\b(?:and|but|while|whereas|și|iar|dar|însă)\b", re.I)

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
    """True when the claim joins at least two facts (split on ; and the conjunctions only, never on a bare comma) of three or more words each."""
    parts = [p for p in JOIN.split(claim or "") if len(p.split()) >= 3]
    return len(parts) >= 2

FIELD_WHERE = (("same_subject", "same_subject (on the result)"), ("subject_at", "subject_at (at the top level)"))

def field_states(entry, call):
    """-> {same_subject, subject_at}: absent / null / invalid / finite as the REAL recorded response has them (jevref.field_state)."""
    return dict(same_subject=entry.get("same_subject_state") or J.field_state(entry, "same_subject"), subject_at=entry.get("subject_at_state") or J.field_state(call.get("parsed"), "subject_at"))

def causes_of(entry, call, fields):
    """Every coexisting reason why the result did not pass, in a FIXED order (the primary code is chosen by `advise`, by its precedence): protocol_fields_absent, subject_fields_null_or_invalid, evidence_off_subject,
    action_not_auto, verdict_contradicted | verdict_unsupported, confidence_not_above_threshold."""
    sa, ss, out = (call.get("parsed") or {}).get("subject_at"), entry.get("same_subject"), []
    if "absent" in fields.values(): out.append("protocol_fields_absent")
    if any(v in ("null", "invalid") for v in fields.values()): out.append("subject_fields_null_or_invalid")
    if J._num(ss) and J._num(sa) and ss < sa: out.append("evidence_off_subject")
    if entry.get("action") not in (None, "auto"): out.append("action_not_auto")
    verdict = str(entry.get("verdict")).lower()
    if verdict in ("contradicted", "unsupported"): out.append("verdict_" + verdict)
    if not J.strict_pass(entry.get("confidence")): out.append("confidence_not_above_threshold")
    return out

def advise(entry, call):
    """entry: a jevref.results_of entry of a verify/gate call; -> {code, hint[, details][, split], fields, causes[, evidence_retry]}, or None when the result passed. `fields` = the recorded state of same_subject / subject_at
    (absent|null|invalid|finite), `causes` = every coexisting reason in a fixed order. protocol_fields_absent (a usable, correctly identified result whose response lacks a field the strict conditions need) comes before the
    evidence-focused codes and recommends NO evidence retry (`evidence_retry` false)."""
    if entry.get("mismatch"): return dict(code="result_mismatch", hint=HINTS["result_mismatch"] % entry["mismatch"])
    if call.get("is_error") or entry.get("verdict") is None or entry.get("confidence") is None:
        return dict(code="no_result", hint=HINTS["no_result"])
    if passed(entry, call): return None
    fields = field_states(entry, call)
    miss = [w for k, w in FIELD_WHERE if fields[k] == "absent"]
    a = dict(code="protocol_fields_absent", hint=HINTS["protocol_fields_absent"] % " and ".join(miss), evidence_retry=False) if miss else _evidence_advice(entry, call)
    return dict(a, fields=fields, causes=causes_of(entry, call, fields))

def _evidence_advice(entry, call):
    """The established evidence-focused advice (precedence unchanged)."""
    sa, ss = (call.get("parsed") or {}).get("subject_at"), entry.get("same_subject")
    verdict = str(entry["verdict"]).lower()
    if J._num(ss) and J._num(sa) and ss < sa: code = "evidence_off_subject"
    elif verdict == "contradicted": code = "fix_fact" if J.strict_pass(entry["confidence"]) else "recheck_fact"
    elif verdict == "unsupported":
        miss = unsupported_details(entry.get("key"), evidence_text(call))
        if miss: return dict(code="remove_unsupported_detail", hint=HINTS["remove_unsupported_detail"], details=miss)
        code = "add_source_passage"
    elif verdict == "verified" and J.strict_pass(entry["confidence"]): code = "aux_condition_failed"
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

def build_parser():
    ap = argparse.ArgumentParser(); ap.add_argument("--session"); ap.add_argument("--cwd")
    return ap

def main():
    a = build_parser().parse_args()
    import discover as D
    sp, how, amb = D.resolve_session_info(a.session, a.cwd)
    if amb: print(json.dumps({"error": "current session not demonstrated: several recently modified sessions; pass --session ID or PATH.jsonl", "resolution": how})); return 3
    if not sp or not D.source_exists(sp): print(json.dumps({"error": "session not found", "arg": a.session})); return 2
    calls = J.load_calls(sp)
    print(json.dumps(dict(session=sp, resolution=how, rule="at most one re-verification, with new evidence or a corrected claim; never an identical call", results=session_advice(calls), capabilities=J.capabilities(calls), capability_note=CAPABILITY_NOTE,
                                                                                                         gate_summaries=[dict(tool_use_id=c["tool_use_id"], **J.gate_summary(c)) for c in calls if c["tool"] == "gate"]), indent=1, ensure_ascii=False)); return 0

if __name__ == "__main__": sys.exit(main())

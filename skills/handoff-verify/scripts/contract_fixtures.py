#!/usr/bin/env python3
"""Builders of recorded Jev responses for the offline tests (a helper, NOT a test module; stdlib only, no Jev call).

Two kinds of fixtures, never mixed up:
 - REALISTIC (the default): the shapes the inspected implementations return. A jev_verify result is FLAT (`results` at the top level; `claim`, `verdict` verified | contradicted | unsupported | unknown, `confidence`,
   `action`, and NO `same_subject` / `subject_at`). A jev_gate response is NESTED (`verification.results`, `review`, the aggregate `action` and `truncated`; no top-level `results`; tool `jev_gate`). Neither inspected server
   emits `same_subject` or `subject_at`, so a check built on such a response stays UNRESOLVED under the strict conditions and `advice.py` says `protocol_fields_absent` (no evidence retry).
 - COMPATIBLE SYNTHETIC (`compatible_synthetic=True`, the ONLY way to get `same_subject` / `subject_at`): invented values that exercise the strict POSITIVE rules (action auto, same_subject >= subject_at). They are not a copy of
   the inspected server contract and must never be presented as one.
The builders reject an unknown verdict (`supported` is not a Jev verdict), an unknown action and an unknown shape. A deliberate NEGATIVE fixture is still possible through `negative=True`, which skips those checks
(the test must then assert a failure or a non-resolution).
usage: imported by the tests."""
import json

VERDICTS = ("verified", "contradicted", "unsupported", "unknown")
ACTIONS = ("auto", "review", "escalate")
SHAPES = ("flat", "nested")

def _row(r, k, compatible_synthetic, negative):
    r = dict(r)
    claim = r.pop("claim"); verdict = r.pop("verdict"); confidence = r.pop("confidence"); action = r.pop("action", "auto"); sid = r.pop("id", "claim%d" % k); same = r.pop("same_subject", None)
    if r: raise ValueError("unknown result fields %s" % sorted(r))
    if not negative and verdict not in VERDICTS: raise ValueError("verdict %r is not a jev_verify/jev_gate verdict %s (pass negative=True for a deliberate negative fixture)" % (verdict, VERDICTS))
    if not negative and action not in ACTIONS + (None,): raise ValueError("action %r is not one of %s" % (action, ACTIONS))
    if same is not None and not compatible_synthetic: raise ValueError("same_subject is available only through compatible_synthetic=True (the inspected server emits no subject fields)")
    out = dict(id=sid, claim=claim, verdict=verdict, confidence=confidence)
    if action is not None: out["action"] = action
    if compatible_synthetic: out["same_subject"] = 0.9 if same is None else same
    return out

def result_rows(rows, compatible_synthetic=False, negative=False):
    """rows: [dict(claim, verdict, confidence[, action='auto', id, same_subject])] or [(claim, verdict, confidence)] -> the result objects."""
    norm = [r if isinstance(r, dict) else dict(zip(("claim", "verdict", "confidence", "action", "same_subject"), r)) for r in rows]
    return [_row(r, k, compatible_synthetic, negative) for k, r in enumerate(norm)]

def verify_body(rows, compatible_synthetic=False, subject_at=0.5, negative=False, tool="jev_verify"):
    """A recorded jev_verify response (FLAT) as the JSON text of the tool_result."""
    body = dict(tool=tool, results=result_rows(rows, compatible_synthetic, negative))
    if compatible_synthetic: body["subject_at"] = subject_at
    return json.dumps(body)

def gate_body(rows, compatible_synthetic=False, subject_at=0.5, review_action="auto", action="auto", truncated=False, shape="nested", negative=False):
    """A recorded jev_gate response. `nested` (the default, the inspected envelope): verification.results + review + aggregate action/truncated, NO top-level results. `flat`: the explicit historical compatibility form
    (top-level results, same tool `jev_gate`)."""
    if shape not in SHAPES and not negative: raise ValueError("unknown gate shape %r (expected %s)" % (shape, SHAPES))
    if not negative and (review_action not in ACTIONS or action not in ACTIONS): raise ValueError("unknown action")
    res = result_rows(rows, compatible_synthetic, negative)
    body = dict(tool="jev_gate", review=dict(action=review_action), action=action, truncated=truncated)
    if shape == "flat": body["results"] = res
    else: body["verification"] = dict(results=res, action="auto")
    if compatible_synthetic: body["subject_at"] = subject_at
    return json.dumps(body)

def invalid_response_body(message="invalid_response"):
    """The inspected verify failure shape: no results, an error marker. It must never resolve anything."""
    return json.dumps(dict(tool="jev_verify", status="invalid_response", error=message))

def classify_body(rows):
    """rows: [(item id, classification, confidence, decision)] -> a jev_classify response (the labels are the caller's classes: no verdict domain)."""
    return json.dumps(dict(tool="jev_classify", results=[dict(id=i, classification=c, confidence=p, decision=d) for i, c, p, d in rows]))

def compare_body(overall, aspects=(), relation_domain=("same_fact", "contradicts", "different_facts")):
    """overall: (relation, confidence); aspects: [(aspect, relation, confidence)] -> a jev_compare response."""
    if overall[0] not in relation_domain: raise ValueError("relation %r is not a jev_compare relation" % (overall[0],))
    return json.dumps(dict(tool="jev_compare", overall=dict(relation=overall[0], confidence=overall[1]), aspects=[dict(aspect=a, relation=r, confidence=p) for a, r, p in aspects]))

def tool_pair(tid, tool, inp, body, uuid_use="u-use", uuid_res="u-res", is_error=False):
    """The two transcript records of one Jev call (assistant tool_use + user tool_result)."""
    return [dict(type="assistant", uuid=uuid_use, message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="mcp__jev__jev_" + tool, input=inp)])),
            dict(type="user", uuid=uuid_res, message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=body, is_error=is_error)]))]

if __name__ == "__main__":
    print(__doc__)

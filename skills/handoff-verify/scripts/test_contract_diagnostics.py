#!/usr/bin/env python3
"""Offline test of the structural contract diagnostics (stdlib only, no Jev call, never reads .handoff-verify/): every recorded jev_verify / jev_gate response is judged on its OWN fields. A result whose
response lacks `same_subject` (on the result) or `subject_at` (top level) cannot pass the strict conditions whatever the evidence: advice.py then prints the code `protocol_fields_absent` (no evidence retry,
the single re-verification is not spent), distinct from a field that is present but null/invalid and from finite off-subject evidence; `capabilities` counts what the recorded responses show, never what a
package version would. Advice never changes a status.
usage: python3 -B test_contract_diagnostics.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit_fixtures as AF
import advice, jevref, report

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
OMIT = object()
CLAIM = "HEAD is 54edd39."
EVIDENCE = "$ git log --oneline -1\n54edd39 Plugin 0.7.8: handoff-verify scope filter"

def res(claim=CLAIM, verdict="verified", confidence=0.99, action="auto", **kw):
    """One raw result; same_subject is given as a keyword (not given = the key is ABSENT); action=OMIT drops the key."""
    r = dict(claim=claim, verdict=verdict, confidence=confidence, **kw)
    if action is not OMIT: r["action"] = action
    return r

def mkcall(results, subject_at=0.5, tool="verify", tid="c1", sent=None, evidence=EVIDENCE):
    top = dict(tool="jev_" + tool, results=results)
    if subject_at is not OMIT: top["subject_at"] = subject_at
    claims = sent if sent is not None else [r["claim"] for r in results]
    rec = [dict(type="assistant", uuid="u1", message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="mcp__jev__jev_" + tool, input=dict(claims=claims, evidence=evidence))])),
           dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=json.dumps(top))]))]
    return rec, jevref.calls_from_records(rec)[0]

def advise_one(r, **kw):
    _, c = mkcall([r], **kw)
    return advice.advise(jevref.results_of(c)[0][0], c)

class FieldStates(unittest.TestCase):
    def test_the_state_of_a_field_is_absent_null_invalid_or_finite(self):
        st = jevref.field_state
        self.assertEqual(st({}, "x"), "absent"); self.assertEqual(st({"x": None}, "x"), "null"); self.assertEqual(st({"x": 0.4}, "x"), "finite"); self.assertEqual(st({"x": 0}, "x"), "finite")
        for bad in (True, "0.9", float("nan"), float("inf"), [0.9], {}): self.assertEqual(st({"x": bad}, "x"), "invalid", bad)
        self.assertEqual(st(None, "x"), "absent"); self.assertEqual(st([], "x"), "absent")

    def test_entries_carry_the_states_and_the_listing_is_unchanged(self):
        _, c = mkcall([res(same_subject=0.9), res(claim="B.", same_subject=None), res(claim="C.")], subject_at=OMIT)
        ents, _ = jevref.results_of(c)
        self.assertEqual([(e["same_subject_state"], e["subject_at_state"]) for e in ents], [("finite", "absent"), ("null", "absent"), ("absent", "absent")])
        for row in jevref.listing([c])[0]["results"]: self.assertEqual(set(row), {"index", "key", "verdict", "confidence", "action", "same_subject"})
        self.assertEqual([e["same_subject"] for e in ents], [0.9, None, None])   # the normalized value is what it was

class Advice(unittest.TestCase):
    def test_absent_fields_are_a_structural_diagnostic_without_evidence_retry(self):
        for kw in (dict(subject_at=OMIT, same_subject=0.9), dict(subject_at=0.5), dict(subject_at=OMIT)):
            a = advise_one(res(**{k: v for k, v in kw.items() if k != "subject_at"}), subject_at=kw.get("subject_at", 0.5))
            self.assertEqual(a["code"], "protocol_fields_absent", kw)
            self.assertIs(a["evidence_retry"], False); self.assertNotIn("split", a); self.assertNotIn("details", a)
            self.assertIn("not spend", a["hint"]); self.assertIn("UNRESOLVED", a["hint"]); self.assertNotIn("add the", a["hint"].lower())
            self.assertIn("future", a["hint"]); self.assertNotIn("latest", a["hint"].lower()); self.assertNotIn("npx", a["hint"].lower())

    def test_the_hint_names_the_missing_fields_at_their_original_locations(self):
        a = advise_one(res(), subject_at=0.5)
        self.assertIn("does not contain same_subject (on the result)", a["hint"]); self.assertNotIn("does not contain same_subject (on the result) and", a["hint"])
        b = advise_one(res(same_subject=0.9), subject_at=OMIT)
        self.assertIn("does not contain subject_at (at the top level)", b["hint"])
        c = advise_one(res(), subject_at=OMIT)
        self.assertIn("does not contain same_subject (on the result) and subject_at (at the top level)", c["hint"])

    def test_null_is_not_absent(self):
        a = advise_one(res(same_subject=None))
        self.assertEqual(a["code"], "aux_condition_failed"); self.assertNotIn("evidence_retry", a)
        self.assertEqual(a["causes"], ["subject_fields_null_or_invalid"])
        self.assertEqual(advise_one(res(same_subject=0.9), subject_at=None)["code"], "aux_condition_failed")

    def test_invalid_values_are_distinguished_from_absent_ones(self):
        for bad in (True, "0.9", float("nan")):
            a = advise_one(res(same_subject=bad))
            self.assertEqual(a["code"], "aux_condition_failed", bad); self.assertEqual(a["fields"]["same_subject"], "invalid", bad)

    def test_finite_off_subject_keeps_evidence_advice(self):
        a = advise_one(res(same_subject=0.3))
        self.assertEqual(a["code"], "evidence_off_subject"); self.assertEqual(a["causes"], ["evidence_off_subject"]); self.assertNotIn("evidence_retry", a)
        self.assertIn("exact passage", a["hint"])
        self.assertEqual(advise_one(res(confidence=0.9, action="review", same_subject=0.3))["code"], "evidence_off_subject")   # the established precedence

    def test_review_escalate_with_present_fields_keeps_the_old_code(self):
        self.assertEqual(advise_one(res(action="review", same_subject=0.9))["code"], "aux_condition_failed")
        self.assertEqual(advise_one(res(action="escalate", same_subject=0.9))["code"], "aux_condition_failed")
        self.assertEqual(advise_one(res(confidence=0.9, action="review", same_subject=0.9))["code"], "add_direct_evidence")

    def test_a_passing_result_gets_no_advice(self):
        self.assertIsNone(advise_one(res(same_subject=0.9)))

    def test_guards_come_first(self):
        _, c = mkcall([res()], sent=["Another claim."])
        e = jevref.results_of(c)[0][0]; self.assertTrue(e.get("mismatch"))
        self.assertEqual(advice.advise(e, c)["code"], "result_mismatch")
        self.assertEqual(advise_one(res(confidence=None))["code"], "no_result")
        _, bad = mkcall([res()]); bad = dict(bad, is_error=True)
        self.assertEqual(advice.advise(jevref.results_of(dict(bad, is_error=False))[0][0], bad)["code"], "no_result")

    def test_every_verdict_is_a_structural_diagnostic_when_the_fields_are_absent(self):
        for verdict, conf in (("verified", 0.99), ("verified", 0.9), ("contradicted", 0.99), ("contradicted", 0.9), ("unsupported", 0.9)):
            self.assertEqual(advise_one(res(verdict=verdict, confidence=conf))["code"], "protocol_fields_absent", (verdict, conf))

    def test_all_coexisting_causes_are_listed_in_a_fixed_order(self):
        a = advise_one(res(action="review"))                                        # absent + review
        self.assertEqual((a["code"], a["causes"]), ("protocol_fields_absent", ["protocol_fields_absent", "action_not_auto"]))
        b = advise_one(res(verdict="contradicted", confidence=0.9, action="review"), subject_at=OMIT)
        self.assertEqual(b["causes"], ["protocol_fields_absent", "action_not_auto", "verdict_contradicted", "confidence_not_above_threshold"])
        c = advise_one(res(confidence=0.9, action="review", same_subject=0.3))
        self.assertEqual((c["code"], c["causes"]), ("evidence_off_subject", ["evidence_off_subject", "action_not_auto", "confidence_not_above_threshold"]))
        d = advise_one(res(verdict="unsupported", confidence=0.9, same_subject=None))
        self.assertEqual(d["causes"], ["subject_fields_null_or_invalid", "verdict_unsupported", "confidence_not_above_threshold"])
        self.assertEqual(advise_one(res(action="review", same_subject=None))["causes"], ["subject_fields_null_or_invalid", "action_not_auto"])
        self.assertEqual(advise_one(res(action="review"))["causes"], advise_one(res(action="review"))["causes"])   # deterministic

    def test_a_later_compatible_response_is_judged_normally(self):
        _, c1 = mkcall([res()], tid="c1"); _, c2 = mkcall([res(same_subject=0.9)], tid="c2"); _, c3 = mkcall([res(same_subject=0.9, confidence=0.9)], tid="c3")
        out = advice.session_advice([c1, c2, c3])
        self.assertEqual([(r["tool_use_id"], r["advice"]["code"]) for r in out], [("c1", "protocol_fields_absent"), ("c3", "add_direct_evidence")])   # c2 passes: nothing blocks it

    def test_gate_results_get_the_same_diagnostic(self):
        self.assertEqual(advise_one(res(), tool="gate")["code"], "protocol_fields_absent")

class Capabilities(unittest.TestCase):
    def test_counts_by_tool_shape_and_field_states_from_the_recorded_responses(self):
        _, a = mkcall([res(), res(claim="B.")], tid="a"); _, b = mkcall([res(same_subject=0.9)], tid="b"); _, c = mkcall([res(same_subject=None)], tid="c", subject_at=OMIT)
        _, g = mkcall([res()], tid="g", tool="gate")
        rows = jevref.capabilities([a, b, c, g])
        self.assertEqual(rows, [
            dict(tool="gate", shape="flat", same_subject="absent", subject_at="finite", results=1, calls=1),
            dict(tool="verify", shape="flat", same_subject="absent", subject_at="finite", results=2, calls=1),
            dict(tool="verify", shape="flat", same_subject="finite", subject_at="finite", results=1, calls=1),
            dict(tool="verify", shape="flat", same_subject="null", subject_at="absent", results=1, calls=1)])

    def test_mixed_responses_are_not_grouped_or_voted(self):
        calls = [mkcall([res()], tid="x%d" % k)[1] for k in range(3)] + [mkcall([res(same_subject=0.9)], tid="y")[1]]
        rows = jevref.capabilities(calls)
        self.assertEqual([(r["same_subject"], r["results"]) for r in rows], [("absent", 3), ("finite", 1)])   # both are reported; no majority, no verdict on "the server"
        self.assertTrue(all(set(r) == {"tool", "shape", "same_subject", "subject_at", "results", "calls"} for r in rows))

    def test_error_other_tools_and_unknown_shapes(self):
        _, ok = mkcall([res(same_subject=0.9)])
        _, err = mkcall([res()], tid="e"); err = dict(err, is_error=True)
        self.assertEqual(jevref.capabilities([err]), [])
        rec, odd = mkcall([res()], tid="o"); odd = dict(odd, parsed=dict(unexpected=1))
        self.assertEqual(jevref.capabilities([odd]), [dict(tool="verify", shape="unknown", same_subject=None, subject_at=None, results=0, calls=1)])
        self.assertEqual(jevref.capabilities([]), [])

    def test_the_cli_exposes_the_observations_additively(self):
        with tempfile.TemporaryDirectory() as d:
            rec, _ = mkcall([res(same_subject=0.9), res(claim="B.", verdict="contradicted")])
            log = os.path.join(d, "s.jsonl")
            with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", log], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 0, p.stderr); o = json.loads(p.stdout)
            self.assertIn("never an identical call", o["rule"]); self.assertEqual([r["advice"]["code"] for r in o["results"]], ["protocol_fields_absent"])
            self.assertEqual([(r["same_subject"], r["results"]) for r in o["capabilities"]], [("absent", 1), ("finite", 1)])
            self.assertIn("capability_note", o); self.assertNotIn("latest", o["capability_note"].lower())

class StatusInvariance(unittest.TestCase):
    def doc(self, results, findings=(), subject_at=0.5):
        rec, c = mkcall(results, subject_at=subject_at)
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup); log = os.path.join(self.t.name, "s.jsonl")
        with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(dict(r, cwd=self.t.name)) + "\n" for r in rec))      # (a real session records its cwd: the registry of the session lives there)
        checks = [dict(id="k%d" % k, tool="jev_verify", verdict=r["verdict"], confidence=r["confidence"], jev_ref=dict(tool_use_id="c1", result_index=k, key=r["claim"])) for k, r in enumerate(results)]
        d = AF.complete(dict(session=dict(session_id="s1", jsonl=log, cwd=self.t.name), handoff=dict(path=os.path.join(self.t.name, "HANDOFF.md"), versions=[]), status="PASS", findings=list(findings), unresolved=[], checks=checks))
        return report.bind_report(d, log, self.t.name, (), False, None, None, "R04"), c

    def test_the_check_stays_unresolved_and_the_status_is_what_it_was(self):
        out, c = self.doc([res()])
        self.assertEqual(out["checks"][0]["advice"]["code"], "protocol_fields_absent"); self.assertEqual(out["status"], "UNRESOLVED")
        self.assertEqual(out["binding_summary"]["resolved"], 0); self.assertEqual(out["checks"][0]["binding"], dict(bound=True, reason="bound", resolved=False, aux_ok=False))
        bs = jevref.bind(out["checks"], [c], "R04"); self.assertFalse(bs[0]["resolved"])
        plain = jevref.audited_status([dict(x, advice=None) for x in out["checks"]], bs, [], [], None, "R04")["status"]
        self.assertEqual(plain, out["status"])

    def test_a_result_with_the_fields_present_resolves_as_before(self):
        out, _ = self.doc([res(same_subject=0.9)])
        self.assertEqual(out["status"], "PASS"); self.assertNotIn("advice", out["checks"][0])

    def test_the_checks_of_an_omission_pair_still_get_no_advice(self):
        rows = [res(claim="The note states X.", verdict="unsupported", confidence=0.99), res(claim="The supplied source passage states this detail: X")]
        f = dict(type="lost_detail", check_id="k0", omission_ref=dict(detail="X", source_check_id="k1"), claim=rows[0]["claim"], confidence=0.99, quote_source="X", quote_handoff=None, uuid="u", category="c")
        out, _ = self.doc(rows, [f])
        self.assertTrue(all("advice" not in c for c in out["checks"]))

class SkillText(unittest.TestCase):
    def test_retry_advice_section_documents_the_structural_code(self):
        t = open(os.path.join(os.path.dirname(HERE), "SKILL.md"), encoding="utf-8").read()
        for must in ("protocol_fields_absent", "capabilities", "causes", "recorded response", "does not spend"): self.assertIn(must, t)

if __name__ == "__main__": unittest.main()

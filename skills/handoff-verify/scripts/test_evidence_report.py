#!/usr/bin/env python3
"""Offline test of the evidence requests in the report (stdlib only, no Jev call, no network, never reads the real .handoff-verify/): the writer derives, for every bound verify / gate check that did not pass, the same
`evidence_request` advice.py derives (check.advice.evidence_request), bound to the version of the note that the writer demonstrated for that check, and lists them in the writer-owned top-level `evidence_requests`. The
authorizations come from the registry of the session (a missing, unreadable or foreign registry refuses a new allowance: the request is blocked). A result that is itself the recorded re-verification of another call is
exhausted (the allowance cannot be reset through the id of the re-verification). Nothing the author wrote there is kept; a status never changes because of a request.
The positive responses are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at, which the inspected server does not emit; test_contract_fixtures pins the realistic bodies).
usage: python3 -B test_evidence_report.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit as A, discover, jevref, report, schema_check as SC
import contract_fixtures as CF
import test_evidence_request as E
import test_reverification_audit as RA

CLAIM = RA.CLAIM

class Chain(unittest.TestCase):
    """advice.evidence_request: the result of a call that is recorded as a re-verification can not be re-verified again."""
    def test_the_result_of_a_recorded_reverification_is_exhausted(self):
        _, c = E.T.call([E.SHORT], tid="c2"); e = jevref.results_of(c)[0][0]; adv = advice.advise(e, c)
        h = [RA.rec("c2", "1" * 64)]
        r = advice.evidence_request(e, c, adv, history=h, version_ref=RA.VREF)
        self.assertEqual((r["state"], r["stop_reason"], r["rounds_used"], r["retry_remaining"]), ("exhausted", "result_of_a_reverification", 1, 0))
        other = advice.evidence_request(e, c, adv, history=[RA.rec("c9", "1" * 64)], version_ref=RA.VREF)             # a re-verification recorded for ANOTHER call says nothing about this one
        self.assertEqual(other["state"], "collect_local")
        reserved = advice.evidence_request(e, c, adv, history=[RA.auth("1" * 64)], version_ref=RA.VREF)                # reserved only: the call may not exist yet
        self.assertEqual(reserved["state"], "collect_local")

class Written(RA.Story):
    """The Example 06 session whose only check did not pass (verified 0.9): the writer must say what to do next, bound to the version."""
    def setUp(self):
        super().setUp()
        self.weak = CF.verify_body([dict(claim=CLAIM, verdict="verified", confidence=0.9)], compatible_synthetic=True)
        self.first = ("c1", dict(claims=[CLAIM], evidence=[dict(text=self.user)]), self.weak)
    def write(self, extra=None, rows=None, mutate=None, doc_edit=None):
        t = self.build(self.user, self.note, extra or [self.first]); block, o = self.audit_block()
        if mutate: mutate(t)
        doc = self.doc(t, self.checks_for(t, rows or [("p1", "c1", CLAIM, "verified", 0.9)]), [], block)
        if doc_edit: doc_edit(doc)
        return t, self.report(t, doc)

class Report(Written):
    def test_a_check_that_did_not_pass_carries_its_request_bound_to_the_version(self):
        t, (out, g, path) = self.write()
        c = out["checks"][0]; req = c["advice"]["evidence_request"]
        self.assertEqual(out["status"], "UNRESOLVED")
        self.assertEqual(req["target"]["version_ref"], RA.versions_ref(t)); self.assertEqual(req["target"]["jev_ref"], dict(tool_use_id="c1", result_index=0, key=CLAIM)); self.assertEqual(req["target"]["stage"], "verify")
        self.assertEqual((req["state"], req["remedy"], req["rounds_used"], req["retry_remaining"]), ("collect_local", "semantic_evidence", 0, 1))
        self.assertEqual(req["request_id"], A.evidence_request_id(req["target"]))
        self.assertEqual(out["evidence_requests"], [dict(check_id="p1", request_id=req["request_id"], state="collect_local", remedy="semantic_evidence", stop_reason=None)])

    def test_the_request_is_the_one_advice_py_derives_for_the_same_session_and_version(self):
        t, (out, g, path) = self.write()
        rows = advice.session_advice(jevref.load_calls(t.log), history=json.load(open(A.registry_path_of(t.log)))["evidence_history"], version_ref=RA.versions_ref(t))
        self.assertEqual(out["checks"][0]["advice"]["evidence_request"], rows[0]["advice"]["evidence_request"])

    def test_a_check_that_passed_has_no_request_and_the_list_is_empty(self):
        t, (out, g, path) = self.write([self.first[:2] + (self.body,)], [("p1", "c1", CLAIM, "verified", 0.99)])
        self.assertEqual(out["status"], "PASS"); self.assertNotIn("advice", out["checks"][0]); self.assertEqual(out["evidence_requests"], [])

    def test_an_authorized_or_recorded_request_is_exhausted(self):
        def mut(t):
            reg, src = A.registry_path_of(t.log), discover.canon(t.log); target = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=RA.versions_ref(t), stage="verify")
            self.assertEqual(A.reserve_evidence(reg, src, A.evidence_request_id(target), target, "4" * 64)[0], "reserved")
        t, (out, g, path) = self.write(mutate=mut); req = out["checks"][0]["advice"]["evidence_request"]
        self.assertEqual((req["state"], req["stop_reason"], req["rounds_used"], req["retry_remaining"]), ("exhausted", "reverification_used", 1, 0))
        self.assertEqual(out["evidence_requests"][0]["state"], "exhausted")

    def test_a_registry_that_is_missing_or_unreadable_refuses_a_new_allowance(self):
        for how in ("missing", "broken"):
            def mut(t):
                p = A.registry_path_of(t.log)
                if how == "missing": os.unlink(p)
                else:
                    with open(p, "w", encoding="utf-8") as f: f.write("{broken")
            with self.subTest(how):
                self.setUp(); t, (out, g, path) = self.write(mutate=mut); req = out["checks"][0]["advice"]["evidence_request"]
                self.assertEqual((req["state"], req["stop_reason"], req["retry_remaining"]), ("blocked", "history_unavailable", 0))

    def test_the_result_of_a_recorded_reverification_is_exhausted_in_the_report_too(self):
        second = ("c2", dict(claims=[CLAIM], evidence=[dict(text=self.user), dict(text="more")]), self.weak)
        def mut(t):
            reg, src = A.registry_path_of(t.log), discover.canon(t.log); h = next(c for c in jevref.load_calls(t.log) if c["tool_use_id"] == "c2")["input_hash"]
            target = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=RA.versions_ref(t), stage="verify"); rid = A.evidence_request_id(target)
            A.reserve_evidence(reg, src, rid, target, h); A.record_evidence(reg, src, rid, h, dict(tool_use_id="c2", result_index=None, key=None))
        t, (out, g, path) = self.write([self.first, second], [("p1", "c1", CLAIM, "verified", 0.9), ("p2", "c2", CLAIM, "verified", 0.9)], mut)
        by = {x["check_id"]: x for x in out["evidence_requests"]}
        self.assertEqual(by["p1"]["state"], "exhausted"); self.assertEqual((by["p2"]["state"], by["p2"]["stop_reason"]), ("exhausted", "result_of_a_reverification"))

    def test_nothing_the_author_wrote_is_kept_and_the_report_is_valid(self):
        def edit(doc):
            doc["evidence_requests"] = [dict(check_id="forged", request_id="0" * 16, state="ready", remedy="x", stop_reason=None)]
            doc["checks"][0]["advice"] = dict(code="x", hint="y", evidence_request=dict(state="ready"))
        t, (out, g, path) = self.write(doc_edit=edit)
        self.assertEqual([x["check_id"] for x in out["evidence_requests"]], ["p1"]); self.assertEqual(out["checks"][0]["advice"]["evidence_request"]["state"], "collect_local")
        self.assertEqual(SC.validate_report(out), [])

    def test_a_request_never_changes_a_status(self):
        t, (out, g, path) = self.write(); self.assertEqual((out["status"], g["audited_status"]), ("UNRESOLVED", "UNRESOLVED"))
        self.assertEqual(out["binding_summary"]["resolved"], 0)

    def test_the_schema_knows_the_new_properties_and_the_writer_owns_them(self):
        s = json.load(open(os.path.join(HERE, "report.schema.json"), encoding="utf-8"))
        self.assertIn("evidence_requests", s["properties"]); self.assertIn("evidence_request", s["properties"]["checks"]["items"]["properties"]["advice"]["properties"])
        self.assertIn("evidence_requests", SC.WRITER_OWNED)

if __name__ == "__main__": unittest.main()

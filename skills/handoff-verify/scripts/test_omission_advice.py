#!/usr/bin/env python3
"""Offline test of the stage-aware advice for the two halves of an omission pair (R04; stdlib only, no Jev call, no network, never reads the real .handoff-verify/). The generic retry advice is wrong for them: the ABSENCE half takes
the complete canonical material and NOTHING else, and the SOURCE half takes exactly one eligible record. So a distinct generator knows the stage: a qualified `unsupported` ABSENCE (> 0.95, action auto) is the EXPECTED half and
is told to go on to the SOURCE call (a first call, not a re-verification); an ABSENCE that does not qualify takes no new evidence (the request is blocked: the material is unchanged, or the call did not use the canonical
material); an unqualified SOURCE may be re-asked once with ANOTHER eligible record from the session, never a file. The pair exception stays: the checks of a finding-linked pair get no advice at all.
The positive responses are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at, which the inspected server does not emit; test_contract_fixtures pins the realistic bodies).
usage: python3 -B test_omission_advice.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit as A, jevref, omissions
import contract_fixtures as CF
import test_retry_advice as T
import test_doc_end_to_end as E2E

DETAIL = "The public API must not change."
SRC = omissions.SOURCE_PREFIX + DETAIL
VREF = dict(write_tool_use_id="w1", sha256="a" * 64, evaluated_against="prefix")

def row(claim, verdict, conf, action="auto", same=0.9): return (claim, verdict, conf, action, same)
def entry_call(r, tool="verify"):
    _, c = T.call([r], tool=tool); return jevref.results_of(c)[0][0], c

class Stage(unittest.TestCase):
    def test_a_source_claim_is_recognized_by_its_canonical_prefix_only_on_a_verify_call(self):
        self.assertEqual(advice.stage_of(SRC, "verify", False), "source")
        self.assertEqual(advice.stage_of("  " + SRC.replace(" ", "  ") + "\n", "verify", False), "source")
        self.assertIsNone(advice.stage_of(SRC, "gate", False)); self.assertIsNone(advice.stage_of(DETAIL, "verify", False)); self.assertIsNone(advice.stage_of(None, "verify", True))

    def test_an_absence_call_is_recognized_by_the_canonical_material_or_the_r03_prefix(self):
        self.assertEqual(advice.stage_of(DETAIL, "verify", True), "absence")
        self.assertEqual(advice.stage_of(omissions.ABSENCE_PREFIX + DETAIL, "verify", False), "absence")
        self.assertIsNone(advice.stage_of(DETAIL, "gate", True)); self.assertIsNone(advice.stage_of(DETAIL, "verify", False))
        self.assertEqual(advice.stage_of(SRC, "verify", True), "source")                                          # the claim decides first

class Advice(unittest.TestCase):
    def adv(self, stage, r, material_ok=True):
        e, c = entry_call(r); return advice.omission_advise(stage, e, c, material_ok)

    def test_a_qualified_unsupported_absence_goes_on_to_the_source_call_and_is_not_told_to_add_a_passage(self):
        a = self.adv("absence", row(DETAIL, "unsupported", 0.98, "auto", 0.2))        # same_subject is NOT required for this half
        self.assertEqual((a["code"], a["stage"], a["evidence_retry"]), ("absence_awaits_source", "absence", False)); self.assertIn("SOURCE", a["hint"]); self.assertNotIn("add_source_passage", json.dumps(a))
        self.assertEqual(advice.advise(*entry_call(row(DETAIL, "unsupported", 0.98, "auto", 0.2)))["code"], "evidence_off_subject")      # what the generic advice would have said

    def test_an_absence_that_does_not_qualify_takes_no_new_evidence(self):
        for name, r in (("0.95 exactly", row(DETAIL, "unsupported", 0.95)), ("review", row(DETAIL, "unsupported", 0.98, "review")), ("low", row(DETAIL, "unsupported", 0.9)), ("verified", row(DETAIL, "verified", 0.9)), ("contradicted", row(DETAIL, "contradicted", 0.9))):
            with self.subTest(name):
                a = self.adv("absence", r, True); self.assertEqual((a["code"], a["stage"], a["evidence_retry"]), ("absence_material_unchanged", "absence", False))
                a = self.adv("absence", r, False); self.assertEqual(a["code"], "absence_material_not_canonical")
        self.assertEqual(self.adv("absence", row(DETAIL, "unsupported", 0.98, None))["code"], "absence_material_unchanged")      # the action must be explicitly auto

    def test_an_unqualified_source_may_be_asked_again_with_another_record(self):
        for name, r in (("verified low", row(SRC, "verified", 0.9)), ("unsupported", row(SRC, "unsupported", 0.97)), ("contradicted", row(SRC, "contradicted", 0.99)), ("review", row(SRC, "verified", 0.99, "review"))):
            with self.subTest(name):
                a = self.adv("source", r); self.assertEqual((a["code"], a["stage"]), ("source_not_qualified", "source")); self.assertIn("another", a["hint"]); self.assertNotIn("evidence_retry", a)

    def test_the_causes_and_fields_of_the_real_response_are_kept(self):
        a = self.adv("source", row(SRC, "verified", 0.9)); self.assertIn("confidence_not_above_threshold", a["causes"]); self.assertEqual(set(a["fields"]), {"same_subject", "subject_at"})

    def test_a_result_that_qualifies_gets_none(self):
        self.assertIsNone(self.adv("source", row(SRC, "verified", 0.99)))                                          # nothing to advise: it passed

class Request(unittest.TestCase):
    def req(self, stage, r, material_ok=True, history=(), version_ref=VREF):
        e, c = entry_call(r); a = advice.omission_advise(stage, e, c, material_ok)
        return advice.evidence_request(e, c, a, history=history, version_ref=version_ref, stage=stage)

    def test_the_absence_request_is_blocked_and_names_why(self):
        r = self.req("absence", row(DETAIL, "unsupported", 0.9))
        self.assertEqual((r["target"]["stage"], r["state"], r["remedy"], r["stop_reason"], r["retry_remaining"], r["allowed_sources"]), ("absence", "blocked", "protocol_blocker", "absence_material_unchanged", 0, []))
        r = self.req("absence", row(DETAIL, "unsupported", 0.9), material_ok=False); self.assertEqual(r["stop_reason"], "absence_material_not_canonical")

    def test_the_source_request_asks_for_another_record_of_the_session_only(self):
        r = self.req("source", row(SRC, "verified", 0.9))
        self.assertEqual((r["target"]["stage"], r["state"], r["remedy"], r["allowed_sources"], r["missing_artifacts"], r["retry_remaining"]), ("source", "collect_local", "semantic_evidence", ["session_transcript"], ["another_eligible_record_stating_the_detail"], 1))
        self.assertNotIn("admitted_local_file", r["allowed_sources"])

    def test_the_source_request_is_used_up_by_its_history_and_has_its_own_id(self):
        r = self.req("source", row(SRC, "verified", 0.9)); generic = advice.evidence_request(*entry_call(row(SRC, "verified", 0.9)), advice.advise(*entry_call(row(SRC, "verified", 0.9))), history=(), version_ref=VREF)
        self.assertNotEqual(r["request_id"], generic["request_id"]); self.assertEqual(r["request_id"], A.evidence_request_id(r["target"]))
        e = dict(request_id=r["request_id"], target=r["target"], input_hash="1" * 64, state="authorized")
        used = self.req("source", row(SRC, "verified", 0.9), history=[e]); self.assertEqual((used["state"], used["stop_reason"], used["rounds_used"]), ("exhausted", "reverification_used", 1))
        self.assertEqual(self.req("source", row(SRC, "verified", 0.9), history=None)["stop_reason"], "history_unavailable")

    def test_the_ids_of_the_generic_requests_are_unchanged(self):
        e, c = entry_call(row("HEAD is 54edd39.", "verified", 0.9)); r = advice.evidence_request(e, c, advice.advise(e, c), history=(), version_ref=VREF)
        self.assertEqual((r["target"]["stage"], r["request_id"]), ("verify", A.evidence_request_id(r["target"])))

    def test_session_advice_recognizes_a_source_claim_by_the_log_alone(self):
        _, c = T.call([row(SRC, "verified", 0.9)]); out = advice.session_advice([c], history=(), version_ref=VREF)
        self.assertEqual((out[0]["advice"]["code"], out[0]["advice"]["evidence_request"]["target"]["stage"]), ("source_not_qualified", "source"))
        _, c = T.call([row(DETAIL, "unsupported", 0.9)]); out = advice.session_advice([c], history=(), version_ref=VREF)
        self.assertEqual(out[0]["advice"]["evidence_request"]["target"]["stage"], "verify")                     # the log alone cannot tell an ABSENCE call (the report can: it knows the canonical material)

class Story(E2E.QualifyingOmission):
    """Example 02: the constraint about the public API is missing from the note. The report is written with the pair in various states."""
    def written(self, abs_body, src_body=None, rows=None, findings=(), absence_evidence=None, ac=0.98, sc=0.99, register=False):
        extra = [("a1", dict(claims=[self.p["absence_claim"]], evidence=absence_evidence if absence_evidence is not None else [dict(text=self.p["material"])]), abs_body)]
        if src_body is not None: extra.append(("s1", dict(claims=[self.p["source_claim"]], evidence=[dict(text=self.p["source_passage"])]), src_body))
        t = self.build(self.user, self.note, extra); self.t = t
        if register: self.register(self.detail)           # `audit.py register`: the detail is a candidate of the session (its registry also holds the authorizations)
        else: self.audit_block()                          # `audit.py template` establishes the registry of the session
        rows = rows or [("abs", "a1", self.p["absence_claim"], "unsupported", ac)] + ([("src", "s1", self.p["source_claim"], "verified", sc)] if src_body is not None else [])
        out, g, path = self.report(t, self.doc(t, self.checks_for(t, rows), list(findings), None, None, "UNRESOLVED")); return t, out
    def finding(self): return dict(type="lost_detail", check_id="abs", claim=self.p["absence_claim"], confidence=0.98, quote_source=self.quote, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=self.detail, source_check_id="src"))

class Report(Story):
    def test_a_qualified_absence_without_a_source_call_goes_on_to_the_source_call(self):
        t, out = self.written(self.absence())
        c = out["checks"][0]; self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual((c["advice"]["code"], c["advice"]["stage"]), ("absence_awaits_source", "absence"))
        self.assertNotIn("evidence_request", c["advice"]); self.assertEqual(out["evidence_requests"], [])      # a first SOURCE call is not a re-verification

    def test_an_absence_that_does_not_qualify_with_the_canonical_material_takes_no_new_evidence(self):
        t, out = self.written(self.absence(conf=0.9), ac=0.9)
        r = out["checks"][0]["advice"]["evidence_request"]
        self.assertEqual((out["checks"][0]["advice"]["code"], r["target"]["stage"], r["state"], r["stop_reason"]), ("absence_material_unchanged", "absence", "blocked", "absence_material_unchanged"))
        self.assertEqual(r["target"]["version_ref"], self.p["version_ref"]); self.assertEqual(out["evidence_requests"][0]["state"], "blocked")

    def test_an_absence_call_with_other_evidence_than_the_canonical_material_is_told_so(self):
        t, out = self.written(self.absence(conf=0.9), ac=0.9, register=True, absence_evidence=[dict(text=self.p["material"] + "\nan extra neighbour line")])
        self.assertEqual(out["checks"][0]["advice"]["code"], "absence_material_not_canonical")

    def test_an_absence_call_that_nothing_identifies_keeps_the_generic_advice(self):
        """A LIMIT, stated: the bare detail is a claim like any other. Without the canonical material as its evidence and without a registered candidate, nothing says the call is an ABSENCE call."""
        t, out = self.written(self.absence(conf=0.9), ac=0.9, absence_evidence=[dict(text=self.p["material"] + "\nan extra neighbour line")])
        self.assertNotIn(out["checks"][0]["advice"]["code"], ("absence_material_not_canonical", "absence_material_unchanged", "absence_awaits_source"))

    def test_an_unqualified_source_asks_for_another_record_and_its_id_is_the_one_the_cli_derives(self):
        t, out = self.written(self.absence(), self.source(conf=0.9), sc=0.9)
        absc, src = out["checks"]; self.assertEqual(absc["advice"]["code"], "absence_awaits_source")
        self.assertEqual((src["advice"]["code"], src["advice"]["evidence_request"]["state"], src["advice"]["evidence_request"]["target"]["stage"]), ("source_not_qualified", "collect_local", "source"))
        cli_rows = advice.session_advice(jevref.load_calls(t.log), history=(), version_ref=self.p["version_ref"]); mine = next(r for r in cli_rows if r["tool_use_id"] == "s1")
        self.assertEqual(mine["advice"]["evidence_request"]["request_id"], src["advice"]["evidence_request"]["request_id"])
        self.assertEqual([x["check_id"] for x in out["evidence_requests"]], ["src"])

    def test_the_checks_of_a_finding_linked_pair_still_get_no_advice(self):
        t, out = self.written(self.absence(verdict="verified", conf=0.97), self.source(), [("abs", "a1", self.p["absence_claim"], "verified", 0.97), ("src", "s1", self.p["source_claim"], "verified", 0.99)], [self.finding()])
        self.assertTrue(all("advice" not in c for c in out["checks"])); self.assertEqual(out["evidence_requests"], [])
        t, out = self.written(self.absence(), self.source(), findings=[self.finding()])                                          # a valid pair
        self.assertEqual(out["status"], "FAIL"); self.assertTrue(all("advice" not in c for c in out["checks"]))

    def test_an_absence_that_comes_back_verified_means_the_detail_is_present_and_needs_nothing(self):
        t, out = self.written(self.absence(verdict="verified", conf=0.97), rows=[("abs", "a1", self.p["absence_claim"], "verified", 0.97)])
        self.assertNotIn("advice", out["checks"][0]); self.assertEqual((out["findings"], out["evidence_requests"]), ([], []))      # no finding, no SOURCE call, nothing to collect

    def test_a_generic_claim_still_gets_the_generic_advice(self):
        claim = "The latest commit is e41a9c2 (migrate billing to duckdb)"
        t = self.build(self.user, self.note, [("c1", dict(claims=[claim], evidence=[dict(text=self.user)]), CF.verify_body([dict(claim=claim, verdict="verified", confidence=0.9)], compatible_synthetic=True))])
        out, g, path = self.report(t, self.doc(t, self.checks_for(t, [("p1", "c1", claim, "verified", 0.9)]), [], None, None, "UNRESOLVED"))
        self.assertEqual((out["checks"][0]["advice"]["code"], out["checks"][0]["advice"]["evidence_request"]["target"]["stage"]), ("add_direct_evidence", "verify"))

if __name__ == "__main__": unittest.main()

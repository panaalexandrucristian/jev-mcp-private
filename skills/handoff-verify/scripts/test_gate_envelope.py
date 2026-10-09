#!/usr/bin/env python3
"""Offline test of the explicit nested gate adapter (stdlib only, no Jev call, never reads .handoff-verify/): the real jev_gate envelope puts the claim results under `verification.results` (src/index.ts, cached
0.14.1 dist/server.js) with the patch review in `review` and the aggregate in `action`/`truncated`. `jevref` binds those results by exact claim string and original index (no recursive search), keeps the flat
top-level `results` working, treats a response holding both locations as an unknown shape, and keeps every strict condition: the real gate envelope carries neither `same_subject` nor `subject_at`, so its claim
results stay UNRESOLVED. `jevref.gate_summary` reports the patch review and the aggregate action separately; passing claims never imply an accepted patch.
usage: python3 -B test_gate_envelope.py [-v]"""
import copy, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit_fixtures as AF
import advice, jevref, report, skilldocs

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
OMIT = object()
C1, C2 = "The plugin is at 0.7.10.", "The tests all pass."

def claim(c, verdict="verified", confidence=0.99, action="auto", **kw): return dict(claim=c, verdict=verdict, confidence=confidence, action=action, **kw)

def nested(results, review=OMIT, action="auto", truncated=False, v_action="auto", subject_at=OMIT, extra=None):
    """The real nested envelope; the review of a success omits `status`."""
    rv = dict(action="auto", reason_codes=["accepted"], safe_to_apply=0.99) if review is OMIT else review
    top = dict(tool="jev_gate", truncated=truncated, action=action, reason_codes=[], review=rv, verification=dict(action=v_action, summary={}, results=results), usage={})
    if subject_at is not OMIT: top["subject_at"] = subject_at
    return dict(top, **(extra or {}))

def mkcall(top, claims, tool="gate", tid="g1"):
    rec = [dict(type="assistant", uuid="u1", message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="mcp__jev__jev_" + tool, input=dict(claims=claims, evidence="E", diff="D", request="R"))])),
           dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=json.dumps(top))]))]
    return rec, jevref.calls_from_records(rec)[0]

def good_results(): return [claim(C1, same_subject=0.9), claim(C2, same_subject=0.9)]

class Adapter(unittest.TestCase):
    def test_a_real_nested_envelope_binds_each_result_by_claim_and_index(self):
        _, c = mkcall(nested([claim(C1), claim(C2, "contradicted", 0.97)]), [C1, C2])
        ents, why = jevref.results_of(c)
        self.assertIsNone(why); self.assertEqual([(e["index"], e["key"], e["verdict"], e["confidence"], e.get("mismatch")) for e in ents], [(0, C1, "verified", 0.99, None), (1, C2, "contradicted", 0.97, None)])
        checks = [dict(id="k0", tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=0, key=C1)),
                  dict(id="k1", tool="jev_gate", verdict="contradicted", confidence=0.97, jev_ref=dict(tool_use_id="g1", result_index=1, key=C2))]
        self.assertEqual([b["bound"] for b in jevref.bind(checks, [c], "R04")], [True, True])

    def test_the_real_envelope_has_no_subject_fields_so_the_claims_stay_unresolved(self):
        _, c = mkcall(nested([claim(C1), claim(C2)]), [C1, C2])
        checks = [dict(id="k0", tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=0, key=C1))]
        b = jevref.bind(checks, [c], "R04")[0]
        self.assertTrue(b["bound"]); self.assertFalse(b["aux_ok"]); self.assertFalse(b["resolved"])
        a = advice.advise(jevref.results_of(c)[0][0], c)
        self.assertEqual(a["code"], "protocol_fields_absent"); self.assertEqual(a["fields"], dict(same_subject="absent", subject_at="absent"))

    def test_a_fully_compatible_nested_envelope_resolves_only_under_every_condition(self):
        def resolved(results, **kw):
            _, c = mkcall(nested(results, subject_at=kw.pop("subject_at", 0.5), **kw), [C1])
            return jevref.bind([dict(id="k", tool="jev_gate", verdict="verified", confidence=results[0]["confidence"], jev_ref=dict(tool_use_id="g1", result_index=0, key=C1))], [c], "R04")[0]["resolved"]
        self.assertTrue(resolved([claim(C1, same_subject=0.9)]))
        self.assertFalse(resolved([claim(C1, same_subject=0.9)], subject_at=OMIT))                # subject_at only at the existing top-level location
        self.assertFalse(resolved([claim(C1, same_subject=0.3)]))                                  # off subject
        self.assertFalse(resolved([claim(C1, action="review", same_subject=0.9)]))                  # action
        self.assertFalse(resolved([claim(C1, confidence=0.95, same_subject=0.9)]))                  # 0.95 itself
        _, c = mkcall(dict(nested([claim(C1)]), verification=dict(action="auto", results=[claim(C1, same_subject=None)]), subject_at=0.5), [C1])
        self.assertIsNone(jevref.results_of(c)[0][0]["same_subject"])

    def test_same_subject_is_read_only_from_the_selected_result(self):
        top = nested([claim(C1)], subject_at=0.5, extra=dict(same_subject=0.9)); top["verification"]["same_subject"] = 0.9; top["review"]["same_subject"] = 0.9
        _, c = mkcall(top, [C1]); e = jevref.results_of(c)[0][0]
        self.assertEqual((e["same_subject"], e["same_subject_state"]), (None, "absent"))

    def test_flat_gate_envelope_keeps_working(self):
        _, c = mkcall(dict(tool="jev_gate", subject_at=0.5, results=[claim(C1, same_subject=0.9)]), [C1])
        ents, why = jevref.results_of(c); self.assertIsNone(why); self.assertEqual((ents[0]["key"], ents[0]["same_subject"]), (C1, 0.9))
        self.assertEqual(jevref.envelope_shape(c), "flat")

    def test_both_locations_in_one_response_are_an_unknown_shape(self):
        _, c = mkcall(dict(nested([claim(C1, same_subject=0.9)], subject_at=0.5), results=[claim(C1, same_subject=0.9)]), [C1])
        ents, why = jevref.results_of(c)
        self.assertEqual((ents, jevref.envelope_shape(c)), ([], "ambiguous")); self.assertIn("unknown response shape", why)
        self.assertEqual(jevref.bind([dict(id="k", tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=0, key=C1))], [c], "R04")[0]["bound"], False)

    def test_the_nested_location_is_gate_only_and_never_found_by_searching(self):
        _, v = mkcall(nested([claim(C1, same_subject=0.9)], subject_at=0.5), [C1], tool="verify")
        self.assertEqual(jevref.results_of(v)[1], "unknown response shape (claims/results)"); self.assertEqual(jevref.envelope_shape(v), "unknown")
        _, deep = mkcall(dict(tool="jev_gate", wrapper=dict(verification=dict(results=[claim(C1)]))), [C1])
        self.assertEqual(jevref.results_of(deep), ([], "unknown response shape (claims/results)"))
        _, other = mkcall(dict(tool="jev_gate", verification=dict(items=[claim(C1)])), [C1]); self.assertEqual(jevref.envelope_shape(other), "unknown")

    def test_a_mismatched_result_is_a_mismatch_and_a_matching_one_still_binds(self):
        _, c = mkcall(nested([claim(C1), claim("Another claim.")]), [C1, C2])
        ents, _ = jevref.results_of(c); self.assertIsNone(ents[0].get("mismatch")); self.assertIn("does not carry the claim", ents[1]["mismatch"])
        chk = lambda i, k: dict(id="k%d" % i, tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=i, key=k))
        self.assertEqual([b["bound"] for b in jevref.bind([chk(0, C1), chk(1, C2)], [c], "R04")], [True, False])
        self.assertEqual(advice.advise(ents[1], c)["code"], "result_mismatch")

    def test_the_listing_shows_the_nested_results(self):
        _, c = mkcall(nested([claim(C1, same_subject=0.9)], subject_at=0.5), [C1])
        row = jevref.listing([c])[0]; self.assertIsNone(row["note"]); self.assertEqual([(r["index"], r["key"]) for r in row["results"]], [(0, C1)])

    def test_capabilities_name_the_nested_shape(self):
        _, c = mkcall(nested([claim(C1)]), [C1]); _, f = mkcall(dict(tool="jev_gate", subject_at=0.5, results=[claim(C1, same_subject=0.9)]), [C1], tid="g2")
        rows = jevref.capabilities([c, f])
        self.assertEqual([(r["shape"], r["same_subject"], r["subject_at"], r["results"]) for r in rows], [("flat", "finite", "finite", 1), ("nested", "absent", "absent", 1)])

class DualLocations(unittest.TestCase):
    """Both locations are detected by KEY PRESENCE, before the value types are validated."""
    ODD = [None, "x", True, False, 5, {}, {"a": 1}, []]

    def _bind(self, c):
        return jevref.bind([dict(id="k", tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=0, key=C1))], [c], "R04")[0]["bound"]

    def test_valid_nested_results_plus_any_top_level_results_value_is_ambiguous(self):
        for odd in self.ODD:
            top = dict(nested([claim(C1, same_subject=0.9)], subject_at=0.5), results=odd); _, c = mkcall(top, [C1])
            self.assertEqual(jevref.envelope_shape(c), "ambiguous", odd); ents, why = jevref.results_of(c)
            self.assertEqual(ents, [], odd); self.assertIn("unknown response shape", why); self.assertFalse(self._bind(c), odd)
            s = jevref.gate_summary(c); self.assertFalse(s["holds"], odd); self.assertEqual((s["shape"], s["results"]), ("ambiguous", None))

    def test_valid_flat_results_plus_any_nested_results_value_is_ambiguous(self):
        for odd in self.ODD:
            top = dict(tool="jev_gate", truncated=False, action="auto", subject_at=0.5, review=dict(action="auto", reason_codes=[]), results=[claim(C1, same_subject=0.9)], verification=dict(action="auto", results=odd)); _, c = mkcall(top, [C1])
            self.assertEqual(jevref.envelope_shape(c), "ambiguous", odd); ents, why = jevref.results_of(c)
            self.assertEqual(ents, [], odd); self.assertIn("unknown response shape", why); self.assertFalse(self._bind(c), odd)
            self.assertFalse(jevref.gate_summary(c)["holds"], odd)

    def test_two_malformed_locations_and_a_single_malformed_location_stay_unknown(self):
        for odd in self.ODD:
            if isinstance(odd, list): continue
            _, c = mkcall(dict(tool="jev_gate", results=odd), [C1]); self.assertEqual(jevref.envelope_shape(c), "unknown", odd)
            _, c = mkcall(dict(tool="jev_gate", verification=dict(action="auto", results=odd)), [C1]); self.assertEqual(jevref.envelope_shape(c), "unknown", odd)
            _, c = mkcall(dict(tool="jev_gate", results=odd, verification=dict(results=odd)), [C1]); self.assertEqual(jevref.envelope_shape(c), "ambiguous", odd)
            for c in (mkcall(dict(tool="jev_gate", results=odd), [C1])[1], mkcall(dict(tool="jev_gate", verification=dict(results=odd)), [C1])[1]):
                self.assertEqual(jevref.results_of(c)[0], []); self.assertFalse(jevref.gate_summary(c)["holds"])

    def test_verify_never_reads_a_nested_location(self):
        _, c = mkcall(dict(results=[claim(C1)], verification=dict(results=None)), [C1], tool="verify"); self.assertEqual(jevref.envelope_shape(c), "flat")

class Summary(unittest.TestCase):
    def summary(self, top, claims=(C1, C2)):
        _, c = mkcall(top, list(claims)); before = copy.deepcopy(c); s = jevref.gate_summary(c); self.assertEqual(c, before); return s

    def good(self, **kw): return nested(good_results(), subject_at=0.5, **kw)

    def test_a_complete_compatible_gate_holds_and_reports_the_halves_separately(self):
        s = self.summary(self.good())
        self.assertTrue(s["holds"], s["reasons"]); self.assertEqual(s["reasons"], [])
        self.assertEqual((s["shape"], s["claims"], s["results"], s["matched"], s["strict_resolved"]), ("nested", 2, 2, 2, 2))
        self.assertEqual((s["review"]["action"], s["review"]["status"], s["aggregate"]["action"], s["aggregate"]["truncated"], s["verification_action"]), ("auto", None, "auto", False, "auto"))

    def test_a_successful_review_without_status_is_not_penalized(self):
        rv = dict(action="auto", reason_codes=["accepted"]); self.assertNotIn("status", rv)
        self.assertTrue(self.summary(self.good(review=rv))["holds"])

    def test_the_real_contract_without_subject_fields_never_holds(self):
        s = self.summary(nested([claim(C1), claim(C2)]))
        self.assertFalse(s["holds"]); self.assertEqual((s["matched"], s["strict_resolved"]), (2, 0)); self.assertTrue(any("strict" in r for r in s["reasons"]))

    def test_a_failed_patch_review_keeps_holds_false_even_when_every_claim_passes(self):
        for rv in (dict(action="review", reason_codes=["review_required"]), dict(action="escalate", reason_codes=["review_escalated"]), dict(action="escalate", status="invalid_response", reason_codes=["invalid_response"]),
                   dict(action="auto", status="invalid_response", reason_codes=[]), dict(action="auto", reason_codes=["incomplete_context"]), None, "auto", dict(), dict(action="maybe")):
            s = self.summary(self.good(review=rv)); self.assertFalse(s["holds"], rv); self.assertEqual(s["strict_resolved"], 2, rv)   # the claims pass, the patch is not accepted
            self.assertTrue(any("review" in r for r in s["reasons"]), rv)

    def test_aggregate_truncation_and_verification_action_are_separate_conditions(self):
        self.assertFalse(self.summary(self.good(action="review"))["holds"])
        self.assertFalse(self.summary(self.good(action="escalate"))["holds"])
        self.assertFalse(self.summary(self.good(truncated=True))["holds"])
        self.assertFalse(self.summary(self.good(v_action="review"))["holds"])                       # an observed non-auto verification action cannot establish acceptance
        self.assertFalse(self.summary(dict(self.good(), action=None))["holds"])
        t = self.good(); del t["truncated"]; self.assertFalse(self.summary(t)["holds"])               # not demonstrably complete
        s = self.summary(self.good(action="review", v_action="auto")); self.assertEqual((s["aggregate"]["action"], s["verification_action"], s["review"]["action"]), ("review", "auto", "auto"))

    def flat(self, v=OMIT, review=OMIT, **kw):
        top = dict(tool="jev_gate", truncated=False, action="auto", subject_at=0.5, results=good_results(), review=dict(action="auto", reason_codes=["accepted"]) if review is OMIT else review)
        if v is not OMIT: top["verification"] = v
        return dict(top, **kw)

    def test_a_flat_envelope_keeps_an_observed_verification_action(self):
        for act in ("review", "escalate", "maybe", False, 0, ""):
            s = self.summary(self.flat(dict(action=act, summary={}))); self.assertEqual(s["verification_action"], act, act); self.assertFalse(s["holds"], act)
            self.assertEqual(s["shape"], "flat"); self.assertEqual((s["matched"], s["strict_resolved"]), (2, 2)); self.assertTrue(any("verification action" in r for r in s["reasons"]), act)
        s = self.summary(self.flat(dict(action="auto", summary={}))); self.assertTrue(s["holds"], s["reasons"]); self.assertEqual(s["verification_action"], "auto")
        s = self.summary(self.flat()); self.assertTrue(s["holds"], s["reasons"]); self.assertIsNone(s["verification_action"])
        s = self.summary(self.flat(dict(summary={}))); self.assertTrue(s["holds"], s["reasons"]); self.assertIsNone(s["verification_action"])   # no action observed

    def test_flat_review_actions_still_fail_and_a_status_free_success_still_holds(self):
        for rv in (dict(action="review", reason_codes=["review_required"]), dict(action="escalate", reason_codes=[])):
            self.assertFalse(self.summary(self.flat(review=rv))["holds"], rv)
        self.assertTrue(self.summary(self.flat(review=dict(action="auto", reason_codes=[])))["holds"])
        _, c = mkcall(self.flat(dict(action="escalate")), [C1, C2]); ents, why = jevref.results_of(c)   # the flat binding itself is unchanged
        self.assertIsNone(why); self.assertEqual([e["key"] for e in ents], [C1, C2])

    def test_incomplete_extra_or_mismatched_claim_results_never_hold(self):
        self.assertFalse(self.summary(nested([claim(C1, same_subject=0.9)], subject_at=0.5))["holds"])                                  # a result is missing
        self.assertFalse(self.summary(nested(good_results() + [claim("Extra.", same_subject=0.9)], subject_at=0.5))["holds"])         # an extra result
        self.assertFalse(self.summary(nested([claim(C1, same_subject=0.9), claim("Other.", same_subject=0.9)], subject_at=0.5))["holds"])   # a mismatched claim
        s = self.summary(nested([claim(C1, same_subject=0.9), claim("Other.", same_subject=0.9)], subject_at=0.5)); self.assertEqual((s["matched"], s["strict_resolved"]), (1, 1))
        self.assertFalse(self.summary(nested([], subject_at=0.5), claims=())["holds"])                                                  # nothing to verify
        self.assertFalse(self.summary(nested([claim(C1, "contradicted", 0.99, same_subject=0.9), claim(C2, same_subject=0.9)], subject_at=0.5))["holds"])
        self.assertFalse(self.summary(nested([claim(C1, confidence=0.95, same_subject=0.9), claim(C2, same_subject=0.9)], subject_at=0.5))["holds"])

    def test_unknown_ambiguous_and_other_tools_never_hold(self):
        amb = dict(self.good(), results=good_results())
        s = self.summary(amb); self.assertEqual((s["holds"], s["shape"]), (False, "ambiguous"))
        s = self.summary(dict(tool="jev_gate", action="auto")); self.assertEqual((s["holds"], s["shape"]), (False, "unknown"))
        _, v = mkcall(self.good(), [C1, C2], tool="verify"); self.assertFalse(jevref.gate_summary(v)["holds"])
        _, e = mkcall(self.good(), [C1, C2]); self.assertFalse(jevref.gate_summary(dict(e, is_error=True))["holds"])
        flat = dict(tool="jev_gate", subject_at=0.5, action="auto", truncated=False, results=good_results())
        self.assertFalse(self.summary(flat)["holds"])                                                    # a flat envelope has no patch review

    def test_the_cli_prints_the_gate_summaries_additively(self):
        with tempfile.TemporaryDirectory() as d:
            rec, _ = mkcall(self.good(), [C1, C2]); log = os.path.join(d, "s.jsonl")
            with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", log], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 0, p.stderr); o = json.loads(p.stdout)
            self.assertEqual(o["results"], []); self.assertEqual([(g["tool_use_id"], g["holds"]) for g in o["gate_summaries"]], [("g1", True)])

    def test_a_summary_never_changes_a_report_status(self):
        with tempfile.TemporaryDirectory() as d:
            rec, c = mkcall(self.good(review=dict(action="escalate", reason_codes=["review_escalated"])), [C1, C2]); log = os.path.join(d, "s.jsonl")
            with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(dict(r, cwd=d)) + "\n" for r in rec))      # (a real session records its cwd: the registry of the session lives there)
            checks = [dict(id="k%d" % i, tool="jev_gate", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="g1", result_index=i, key=k)) for i, k in enumerate((C1, C2))]
            doc = report.bind_report(AF.complete(dict(session=dict(session_id="s1", jsonl=log, cwd=d), handoff=dict(path=os.path.join(d, "HANDOFF.md"), versions=[]), status="PASS", findings=[], unresolved=[], checks=checks)), log, d, (), False, None, None, "R04")
            self.assertEqual(doc["status"], "PASS")        # the claim results are resolved on their own; the patch review is a separate observation (holds false)
            self.assertFalse(jevref.gate_summary(c)["holds"])

class SkillText(unittest.TestCase):
    def test_skill_md_documents_the_nested_adapter_and_its_limits(self):
        t = skilldocs.doc("reference/jev-and-audit.md")
        for must in ("verification.results", "gate_summary", "unknown response shape", "both", "does not by itself"): self.assertIn(must, t)

if __name__ == "__main__": unittest.main()

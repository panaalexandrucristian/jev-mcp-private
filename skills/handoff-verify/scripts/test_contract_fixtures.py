#!/usr/bin/env python3
"""Offline test of the response contracts the fixtures and the binding rely on (item 9; stdlib only, no Jev call, never reads .handoff-verify/):
 - contract_fixtures builds REALISTIC bodies (flat verify, nested gate, no same_subject / subject_at) and rejects non-contract input; subject fields exist only as an explicitly named "compatible synthetic";
 - realistic responses bind but the strict conditions cannot be met: the checks stay UNRESOLVED and the advice is `protocol_fields_absent` with no evidence retry;
 - a bound result whose verdict is outside its TOOL's contract (`supported`, `unknown` for verify/gate) is recorded faithfully with a reason and is never resolved, never PASS, never a gate `holds`;
   compare relations and classify/extract labels keep their own contracts (no global three-verdict rule);
 - a nested gate without top-level results binds while a flat-only reader does not; malformed and ambiguous envelopes bind nothing;
 - the offline CI discovery (`npm run test:py`) contains the two regressions that guard the basename collision of reconstructed artifacts and the verification-name false positive.
usage: python3 -B test_contract_fixtures.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, jevref
import contract_fixtures as CF

C1, C2 = "The note says the billing migration ships on Friday.", "The public API must not change."
EVIDENCE = [dict(id="chunk-1", text="Billing ships on Friday. The public API must not change.")]

def call(tool, body, claims=(C1,), tid="c1", extra=None):
    inp = dict(claims=list(claims), evidence=EVIDENCE, **(extra or {}))
    return jevref.calls_from_records(CF.tool_pair(tid, tool, inp, body))[0]

def check(tool, verdict, conf, key=C1, idx=0, tid="c1"):
    return dict(id="k%d" % idx, tool=tool, verdict=verdict, confidence=conf, jev_ref=dict(tool_use_id=tid, result_index=idx, key=key))

def flat_only_reader(c):
    """A reader of the historical flat form only: the results at the top level of the response."""
    return (c["parsed"] or {}).get("results")

class Builders(unittest.TestCase):
    def test_realistic_verify_is_flat_and_has_no_subject_fields(self):
        b = json.loads(CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.99)]))
        self.assertEqual(b["tool"], "jev_verify"); self.assertNotIn("subject_at", b); self.assertEqual(len(b["results"]), 1)
        self.assertNotIn("same_subject", b["results"][0]); self.assertEqual(b["results"][0]["action"], "auto")

    def test_realistic_gate_is_nested_without_top_level_results(self):
        b = json.loads(CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)]))
        self.assertEqual(b["tool"], "jev_gate"); self.assertNotIn("results", b); self.assertNotIn("subject_at", b)
        self.assertEqual(len(b["verification"]["results"]), 1); self.assertNotIn("same_subject", b["verification"]["results"][0])
        self.assertEqual((b["review"]["action"], b["action"], b["truncated"]), ("auto", "auto", False))

    def test_subject_fields_exist_only_through_the_named_compatible_synthetic_option(self):
        with self.assertRaises(ValueError): CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.99, same_subject=0.9)])
        b = json.loads(CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True))
        self.assertEqual((b["subject_at"], b["results"][0]["same_subject"]), (0.5, 0.9))
        self.assertIn("compatible synthetic", CF.__doc__.lower())

    def test_unknown_verdicts_actions_and_shapes_are_rejected_unless_the_fixture_is_deliberately_negative(self):
        for bad in ("supported", "SUPPORTED", "maybe", None):
            with self.assertRaises(ValueError, msg=bad): CF.verify_body([dict(claim=C1, verdict=bad, confidence=0.9)])
            with self.assertRaises(ValueError, msg=bad): CF.gate_body([dict(claim=C1, verdict=bad, confidence=0.9)])
        with self.assertRaises(ValueError): CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.9, action="maybe")])
        with self.assertRaises(ValueError): CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.9)], shape="wrapped")
        with self.assertRaises(ValueError): CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.9)], review_action="maybe")
        with self.assertRaises(ValueError): CF.compare_body(("verified", 0.9))
        self.assertEqual(json.loads(CF.verify_body([dict(claim=C1, verdict="supported", confidence=0.9)], negative=True))["results"][0]["verdict"], "supported")
        self.assertEqual(json.loads(CF.verify_body([dict(claim=C1, verdict="unknown", confidence=0.9)]))["results"][0]["verdict"], "unknown")   # `unknown` is a shape the inspected verify can return

class RealisticResponsesStayUnresolved(unittest.TestCase):
    def test_a_realistic_verify_binds_but_the_strict_conditions_cannot_be_met(self):
        c = call("verify", CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.99)]))
        b = jevref.bind([check("verify", "verified", 0.99)], [c], "R04")[0]
        self.assertTrue(b["bound"]); self.assertFalse(b["aux_ok"]); self.assertFalse(b["resolved"])
        ev = jevref.results_of(c)[0][0]; a = advice.advise(ev, c)
        self.assertEqual(a["code"], "protocol_fields_absent"); self.assertFalse(a["evidence_retry"])
        self.assertEqual(jevref.audited_status([check("verify", "verified", 0.99)], [b], [])["status"], "UNRESOLVED")

    def test_a_realistic_nested_gate_binds_but_stays_unresolved_with_the_same_advice(self):
        c = call("gate", CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)]), extra=dict(request="r", diff="d"))
        self.assertEqual(jevref.envelope_shape(c), "nested")
        b = jevref.bind([check("gate", "verified", 0.99)], [c], "R04")[0]
        self.assertTrue(b["bound"]); self.assertFalse(b["resolved"])
        a = advice.advise(jevref.results_of(c)[0][0], c); self.assertEqual((a["code"], a["evidence_retry"]), ("protocol_fields_absent", False))
        self.assertFalse(jevref.gate_summary(c)["holds"])

    def test_the_compatible_synthetic_fixture_exercises_the_strict_positive_rule(self):
        c = call("verify", CF.verify_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True))
        b = jevref.bind([check("verify", "verified", 0.99)], [c], "R04")[0]
        self.assertTrue(b["bound"] and b["aux_ok"] and b["resolved"])

    def test_the_inspected_invalid_response_shape_never_resolves(self):
        c = call("verify", CF.invalid_response_body())
        b = jevref.bind([check("verify", "verified", 0.99)], [c], "R04")[0]
        self.assertFalse(b["bound"]); self.assertFalse(b["resolved"]); self.assertIn("unknown response shape", b["reason"])

class VerdictContractPerTool(unittest.TestCase):
    def one(self, tool, verdict, conf=0.99, compat=True, contract="R04"):
        mk = CF.verify_body if tool == "verify" else CF.gate_body
        c = call(tool, mk([dict(claim=C1, verdict=verdict, confidence=conf)], compatible_synthetic=compat, negative=True), extra=dict(request="r", diff="d") if tool == "gate" else None)
        return c, jevref.bind([check(tool, verdict, conf)], [c], contract)[0]

    def test_supported_and_unknown_never_resolve_for_verify_and_gate(self):
        for tool in ("verify", "gate"):
            for verdict in ("supported", "unknown", "Supported", "ok"):
                for contract in ("R02", "R03", "R04"):
                    c, b = self.one(tool, verdict, contract=contract)
                    self.assertTrue(b["bound"], (tool, verdict)); self.assertFalse(b["resolved"], (tool, verdict, contract)); self.assertIn("outside the jev_%s contract" % tool, b["contract_reason"])
                    self.assertEqual(b["real_verdict"], verdict)   # recorded faithfully
                    ck = check(tool, verdict, 0.99); st = jevref.audited_status([ck], [b], [])
                    self.assertNotEqual(st["status"], "PASS", (tool, verdict)); self.assertTrue([r for r in st["reasons"] if "outside the tool contract" in r])

    def test_a_gate_with_a_non_contract_verdict_does_not_hold(self):
        for verdict in ("supported", "unknown"):
            c = call("gate", CF.gate_body([dict(claim=C1, verdict=verdict, confidence=0.99)], compatible_synthetic=True, negative=True), extra=dict(request="r", diff="d"))
            self.assertFalse(jevref.gate_summary(c)["holds"], verdict)
        ok = call("gate", CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True), extra=dict(request="r", diff="d"))
        self.assertTrue(jevref.gate_summary(ok)["holds"])

    def test_the_three_contract_verdicts_still_resolve_where_they_did(self):
        for verdict in ("verified", "contradicted"):
            c, b = self.one("verify", verdict); self.assertTrue(b["resolved"], verdict); self.assertIsNone(b["contract_reason"])
        c, b = self.one("verify", "unsupported", contract="R03"); self.assertTrue(b["bound"] and b["resolved"])   # unchanged: R03 keeps its closed rules, `unsupported` is a contract verdict
        c, b = self.one("verify", "unsupported", contract="R04"); self.assertTrue(b["bound"] and not b["resolved"] and b["contract_reason"] is None)   # R04: resolved only by `finalize`, as before

    def test_compare_relations_and_classify_labels_keep_their_own_contracts(self):
        inp = dict(passage_a="A", passage_b="B", aspects=["asp"])
        c = jevref.calls_from_records(CF.tool_pair("m1", "compare", inp, CF.compare_body(("same_fact", 0.99), [("asp", "contradicts", 0.99)])))[0]
        ents = jevref.results_of(c)[0]; self.assertEqual([e["verdict"] for e in ents], ["same_fact", "contradicts"])
        cks = [dict(id="a", tool="compare", verdict="same_fact", confidence=0.99, jev_ref=dict(tool_use_id="m1", result_index=0, key=ents[0]["key"])),
               dict(id="b", tool="compare", verdict="contradicts", confidence=0.99, jev_ref=dict(tool_use_id="m1", result_index=1, key=ents[1]["key"]))]
        bs = jevref.bind(cks, [c], "R04"); self.assertTrue(all(b["bound"] and b["resolved"] and b["contract_reason"] is None for b in bs))
        other = jevref.calls_from_records(CF.tool_pair("m2", "compare", inp, CF.compare_body(("different_facts", 0.99))))[0]
        k = jevref.results_of(other)[0][0]["key"]
        b = jevref.bind([dict(id="a", tool="compare", verdict="different_facts", confidence=0.99, jev_ref=dict(tool_use_id="m2", result_index=0, key=k))], [other], "R04")[0]
        self.assertTrue(b["bound"] and b["resolved"] and b["contract_reason"] is None)   # a three-verdict rule applied globally would have rejected every compare relation
        self.assertIsNone(jevref.verdict_contract("compare", "same_fact")); self.assertIsNone(jevref.verdict_contract("compare", "different_facts"))
        ci = jevref.calls_from_records(CF.tool_pair("k1", "classify", dict(items=[dict(id="d1", text="x")], classes=[dict(id="out_of_scope")]), CF.classify_body([("d1", "out_of_scope", 0.995, "auto")])))[0]
        b = jevref.bind([dict(id="s", tool="classify", verdict="out_of_scope", confidence=0.995, jev_ref=dict(tool_use_id="k1", result_index=0, key="d1"))], [ci], "R04")[0]
        self.assertTrue(b["bound"] and b["resolved"] and b["contract_reason"] is None)
        self.assertIsNone(jevref.verdict_contract("classify", "anything-the-caller-named")); self.assertIsNone(jevref.verdict_contract("extract", "not_found"))

class Envelopes(unittest.TestCase):
    def test_a_nested_gate_without_top_level_results_binds_but_a_flat_only_reader_finds_nothing(self):
        c = call("gate", CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True), extra=dict(request="r", diff="d"))
        self.assertIsNone(flat_only_reader(c)); self.assertEqual(jevref.envelope_shape(c), "nested")
        b = jevref.bind([check("gate", "verified", 0.99)], [c], "R04")[0]; self.assertTrue(b["bound"] and b["resolved"])

    def test_the_explicit_flat_gate_compatibility_is_kept(self):
        c = call("gate", CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True, shape="flat"), extra=dict(request="r", diff="d"))
        self.assertIsNotNone(flat_only_reader(c)); self.assertEqual(jevref.envelope_shape(c), "flat")
        self.assertTrue(jevref.bind([check("gate", "verified", 0.99)], [c], "R04")[0]["bound"])

    def test_an_ambiguous_or_unknown_envelope_binds_nothing(self):
        both = json.loads(CF.gate_body([dict(claim=C1, verdict="verified", confidence=0.99)], compatible_synthetic=True))
        both["results"] = both["verification"]["results"]
        for label, body in (("both locations", json.dumps(both)), ("verify with nested results", json.dumps(dict(tool="jev_verify", verification=dict(results=both["results"])))),
                            ("results not a list", json.dumps(dict(tool="jev_gate", results="x"))), ("neither", json.dumps(dict(tool="jev_gate", review=dict(action="auto")))),
                            ("verification not an object", json.dumps(dict(tool="jev_gate", verification=[])))):
            tool = "verify" if label.startswith("verify") else "gate"
            c = call(tool, body, extra=dict(request="r", diff="d")); b = jevref.bind([check(tool, "verified", 0.99)], [c], "R04")[0]
            self.assertFalse(b["bound"], label); self.assertFalse(b["resolved"], label)

    def test_a_result_that_does_not_carry_the_sent_claim_stays_unbound(self):
        c = call("verify", CF.verify_body([dict(claim="Another claim.", verdict="verified", confidence=0.99)], compatible_synthetic=True))
        self.assertFalse(jevref.bind([check("verify", "verified", 0.99)], [c], "R04")[0]["bound"])

class CiDiscovery(unittest.TestCase):
    """`npm run test:py` is exactly this discovery. The two regressions below guard bugs that were fixed: if their test were not discovered, restoring the bug would not fail CI."""
    def discovered(self):
        out = set()
        def walk(s):
            for t in s:
                if isinstance(t, unittest.TestSuite): walk(t)
                else: out.add(t.id())
        walk(unittest.TestLoader().discover(HERE, pattern="test_*.py", top_level_dir=HERE)); return out

    def test_the_discovery_contains_the_basename_collision_and_the_verification_name_regressions(self):
        ids = self.discovered()
        self.assertIn("test_stream_reconstruction.Names.test_two_notes_with_the_same_basename_get_distinct_artifacts_with_their_own_content", ids)
        self.assertIn("test_source_window.Classifier.test_the_ordinary_inputs_are_not_verification", ids)

    def test_the_package_script_is_the_exact_offline_discovery_command(self):
        pkg = json.load(open(os.path.join(HERE, "..", "..", "..", "package.json"), encoding="utf-8"))
        self.assertEqual(pkg["scripts"]["test:py"], "python3 -B -W ignore::ResourceWarning -m unittest discover -s skills/handoff-verify/scripts -p 'test_*.py'")
        ci = open(os.path.join(HERE, "..", "..", "..", ".github", "workflows", "ci.yml"), encoding="utf-8").read()
        self.assertIn("actions/setup-python@", ci); self.assertIn("npm run test:py", ci); self.assertNotIn("secrets.", ci.split("npm run test:py")[0].split("setup-python")[-1])

    def test_the_real_database_probe_is_opt_in(self):
        src = open(os.path.join(HERE, "test_opencode_adapter.py"), encoding="utf-8").read()
        self.assertIn('os.environ.get(REAL_OPT_IN) == "1"', src); self.assertIn('REAL_OPT_IN = "HANDOFF_VERIFY_REAL_OPENCODE_DB"', src)

if __name__ == "__main__": unittest.main()

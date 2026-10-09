#!/usr/bin/env python3
"""Offline test of the confidence domain and of the exact quotations (stdlib only, no Jev call, never reads .handoff-verify/): a confidence counts only if it is a finite number in [0, 1] (not a bool, not a
string) AND strictly > 0.95 (jevref.is_probability / strict_pass, report.passes / confidence_or_null; never clamped or rounded), and a finding's quotations are exact (case, whitespace, newlines):
`quote_handoff` inside the text of the demonstrated version, `quote_source` inside ONE raw entry of the evidence the call was given (evidence entries, compare passages, gate diff), never a concatenation.
usage: python3 -B test_confidence_quotes.py [-v]"""
import json, math, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import jevref, omissions, report, skilldocs

BAD = [float("inf"), float("-inf"), float("nan"), -0.1, -1, 1.0000001, 1.5, 2, 100, True, False, "0.99", "1", None, [0.99], {}, 0.95, 0, 0.5, 0.0]
DEFAULT = object()
GOOD = [0.9500001, 0.96, 0.99, 1.0, 1]

class Domain(unittest.TestCase):
    def test_the_shared_predicate_is_the_probability_domain(self):
        for v in (0, 0.0, 0.5, 0.95, 1, 1.0, 0.9500001): self.assertTrue(jevref.is_probability(v), v)
        for v in (float("inf"), float("-inf"), float("nan"), -0.0000001, 1.0000001, 2, True, False, "0.5", None, [0.5], {}): self.assertFalse(jevref.is_probability(v), v)

    def test_strict_pass_and_report_passes_reject_everything_outside_the_domain_and_0_95(self):
        for fn in (jevref.strict_pass, report.passes):
            for v in BAD: self.assertFalse(fn(v), (fn.__module__, fn.__name__, v))
            for v in GOOD: self.assertTrue(fn(v), (fn.__module__, fn.__name__, v))

    def test_confidence_or_null_never_clamps_or_rounds(self):
        for v in (float("inf"), float("nan"), -1, 1.5, 2, True, False, "0.9", None): self.assertIsNone(report.confidence_or_null(v), v)
        for v in (0, 0.5, 0.95, 0.9500001, 1, 1.0): self.assertEqual(report.confidence_or_null(v), v)

    def test_check_status_does_not_confirm_a_malformed_confidence(self):
        for v in (float("inf"), 1.5, -1, True, "0.99", None, 0.95): self.assertEqual(report.check_status(dict(kind="defect", verdict_ok=True, confidence=v)), "unresolved", v)
        self.assertEqual(report.check_status(dict(kind="defect", verdict_ok=True, confidence=1.0)), "confirmed")

    def test_the_numeric_helper_for_auxiliary_numbers_and_cost_are_untouched(self):
        self.assertTrue(jevref._num(1.5) and jevref._num(float("inf")) and not jevref._num(True) and not jevref._num(float("nan")))   # same_subject / subject_at keep their own rules
        self.assertEqual(report.cost_field(12.5), 12.5); self.assertEqual(report.cost_field(float("inf")), float("inf")); self.assertEqual(report.cost_field("x"), "unavailable")

HUGE = [10**1000, -10**1000, 10**400, -(10**400), 2**2000, -(2**2000)]

class Oversized(unittest.TestCase):
    """Python integers beyond float range: a rejection, never an OverflowError."""
    def test_the_predicate_and_the_strict_rules_reject_without_raising(self):
        for v in HUGE:
            self.assertFalse(jevref.is_probability(v), v); self.assertFalse(jevref.strict_pass(v), v); self.assertFalse(report.passes(v), v); self.assertIsNone(report.confidence_or_null(v), v)
            self.assertFalse(jevref._finite(v) is None)   # the helper itself never raises
        self.assertEqual(jevref.field_state(dict(a=10**1000), "a"), "finite")

    def test_adapters_and_binding_treat_it_as_an_unusable_confidence(self):
        for v in HUGE:
            c = call_of([row("A claim.", "verified", v)]); e = jevref.results_of(c)[0][0]; self.assertIsNone(e["confidence"], v)
            self.assertFalse(jevref.bind([check("k", "A claim.", "verified", v)], [c], "R04")[0]["bound"], v)
            self.assertIsNone(jevref.listing([c])[0]["results"][0]["confidence"])
            self.assertEqual(report.check_status(dict(kind="defect", verdict_ok=True, confidence=v)), "unresolved", v)

    def test_huge_auxiliary_numbers_do_not_raise(self):
        c = call_of([row("A claim.", "verified", 0.99, same_subject=10**1000)]); self.assertTrue(jevref.bind([check("k", "A claim.", "verified", 0.99)], [c], "R04")[0]["bound"])
        c = call_of([row("A claim.", "verified", 0.99, same_subject=-(10**1000))]); self.assertFalse(jevref.bind([check("k", "A claim.", "verified", 0.99)], [c], "R04")[0]["resolved"])

    def test_the_absence_scheduler_rejects_it(self):
        for v in HUGE:
            o = dict(bound=True, error=False, verdict="unsupported", confidence=v, action="auto", aux_ok=True, version_ok=True, material_complete=True)
            self.assertEqual(omissions.plan_absence(o)["disposition"], "unresolved", v)

def call_of(results, evidence=None, tool="verify", tid="c1", **inp):
    top = dict(subject_at=0.5, results=results) if tool in ("verify", "gate") else results
    base = dict(claims=[r["claim"] for r in results], evidence=evidence) if tool in ("verify", "gate") else {}
    rec = [dict(type="assistant", uuid="u1", message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="mcp__jev__jev_" + tool, input=dict(base, **inp))])),
           dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=json.dumps(top, allow_nan=True))]))]
    return jevref.calls_from_records(rec)[0]

def row(claim, verdict="verified", confidence=0.99, **kw): return dict(dict(claim=claim, verdict=verdict, confidence=confidence, action="auto", same_subject=0.9), **kw)
def check(cid, claim, verdict, confidence, tid="c1", idx=0, tool="jev_verify"): return dict(id=cid, tool=tool, verdict=verdict, confidence=confidence, jev_ref=dict(tool_use_id=tid, result_index=idx, key=claim))

class Adapted(unittest.TestCase):
    def test_an_out_of_domain_confidence_is_unusable_in_the_adapted_result_and_the_check_is_unbound(self):
        for v in (1.5, -0.5, float("inf"), 2):
            c = call_of([row("A claim.", "verified", v)]); e = jevref.results_of(c)[0][0]
            self.assertIsNone(e["confidence"], v)
            self.assertFalse(jevref.bind([check("k", "A claim.", "verified", v)], [c], "R04")[0]["bound"], v)
            self.assertIsNone(jevref.listing([c])[0]["results"][0]["confidence"])
        c = call_of([row("A claim.", "verified", 1.0)]); self.assertTrue(jevref.bind([check("k", "A claim.", "verified", 1.0)], [c], "R04")[0]["resolved"])

    def test_0_95_fails_and_just_above_passes_only_the_numeric_portion(self):
        for conf, expect in ((0.95, False), (0.9500001, True), (1.0, True)):
            self.assertEqual(jevref.bind([check("k", "A claim.", "verified", conf)], [call_of([row("A claim.", "verified", conf)])], "R04")[0]["resolved"], expect, conf)
        c = call_of([row("A claim.", "verified", 0.9500001, action="review")]); self.assertFalse(jevref.bind([check("k", "A claim.", "verified", 0.9500001)], [c], "R04")[0]["resolved"])   # other conditions still apply
        c = call_of([row("A claim.", "verified", 0.9500001, same_subject=0.1)]); self.assertFalse(jevref.bind([check("k", "A claim.", "verified", 0.9500001)], [c], "R04")[0]["resolved"])

    def test_a_missing_action_outside_the_absence_half_is_handled_exactly_as_before(self):
        r = row("A claim."); del r["action"]
        self.assertTrue(jevref.bind([check("k", "A claim.", "verified", 0.99)], [call_of([r])], "R04")[0]["resolved"])

class Omission(unittest.TestCase):
    PASSAGE = "Never run migrate.sh against prod."
    def pair(self, absence_conf=0.98, finding_conf=DEFAULT, source_conf=0.99, action="auto"):
        sc, ac = omissions.claims("Never run migrate.sh against prod.", "R04"); ver = dict(ok=True, write_tool_use_id="w0", sha256="a" * 64, evaluated_against="prefix")
        mk = lambda cid, claim, verdict, conf, ev, act: dict(id=cid, bound=True, resolved=verdict == "verified", real_verdict=verdict, real_confidence=conf, real_action=act, tool="verify", check_error=False, claim_key=claim,
                                                             version=dict(ver), eligible_blocks=[self.PASSAGE], call_evidence_raw=ev, omission_material="MAT", omission_material_reason=None)
        by = dict(s=mk("s", sc, "verified", source_conf, [self.PASSAGE], "auto"), a=mk("a", ac, "unsupported", absence_conf, ["MAT"], action))
        f = dict(type="lost_detail", check_id="a", confidence=absence_conf if finding_conf is DEFAULT else finding_conf, claim=ac, omission_ref=dict(detail="Never run migrate.sh against prod.", source_check_id="s"), quote_source=self.PASSAGE, quote_handoff=None)
        return f, by

    def test_an_oversized_integer_confidence_cannot_confirm_an_r04_omission_and_never_raises(self):
        for bad in HUGE:
            f, by = self.pair(absence_conf=bad); self.assertFalse(jevref._validate_omission(f, by["a"], by, "R04")[0], bad)
            f, by = self.pair(finding_conf=bad); self.assertFalse(jevref.validate_finding(f, by, None, "R04")[0], bad)
            f, by = self.pair(source_conf=bad); self.assertFalse(jevref._validate_omission(f, by["a"], by, "R04")[0], bad)

    def test_a_malformed_confidence_cannot_confirm_an_r04_omission(self):
        for bad in (float("inf"), 1.5, -1, 2, True, "0.98", None, 0.95):
            f, by = self.pair(absence_conf=bad); self.assertFalse(jevref._validate_omission(f, by["a"], by, "R04")[0], bad)
            f, by = self.pair(finding_conf=bad); self.assertFalse(jevref.validate_finding(f, by, None, "R04")[0], bad)
            f, by = self.pair(source_conf=bad); self.assertFalse(jevref._validate_omission(f, by["a"], by, "R04")[0], bad)
        for ok in (0.9500001, 1.0):
            f, by = self.pair(absence_conf=ok, source_conf=ok); self.assertTrue(jevref._validate_omission(f, by["a"], by, "R04")[0], ok)
        f, by = self.pair(action=None); self.assertFalse(jevref._validate_omission(f, by["a"], by, "R04")[0])      # the absence half still needs an explicit auto

HANDOFF = "Decision: use mongo instead of duckdb.\nNote: the retry is manual.\n"

class Quotes(unittest.TestCase):
    def verdict(self, f, call, row_, handoff=HANDOFF, tool="jev_verify", contract="R04"):
        chk = check("k", row_["claim"], row_["verdict"], row_["confidence"], tool=tool)
        by = {b["id"]: b for b in jevref.bind([chk], [call], contract)}
        self.assertTrue(by["k"]["resolved"], by["k"])
        return jevref.validate_finding(dict(dict(type="wrong_fact", check_id="k", confidence=row_["confidence"], claim=row_["claim"], quote_handoff="use mongo", quote_source="use duckdb", uuid="u", category="c"), **f), by, handoff, contract)

    def fixture(self, evidence=None):
        r = row("The decision was to use mongo instead of duckdb.", "contradicted", 0.99)
        return r, call_of([r], evidence if evidence is not None else [dict(text="we will use duckdb\nnot mongo")])

    def test_genuine_exact_quotes_confirm(self):
        r, c = self.fixture(); self.assertEqual(self.verdict({}, c, r), (True, "confirmed"))
        self.assertEqual(self.verdict(dict(quote_source="use duckdb\nnot mongo"), c, r), (True, "confirmed"))

    def test_altered_case_whitespace_or_newlines_are_rejected_in_quote_handoff(self):
        r, c = self.fixture()
        for q in ("USE MONGO", "Use mongo", "use  mongo", "use\nmongo", "use mongo\t", "use mongo instead of  duckdb", "instead of duckdb. Note: the retry"):
            ok, why = self.verdict(dict(quote_handoff=q), c, r)
            self.assertFalse(ok, q); self.assertIn("quote_handoff not found", why)
        self.assertTrue(self.verdict(dict(quote_handoff="duckdb.\nNote: the retry"), c, r)[0])      # a newline as in the version is fine

    def test_altered_case_whitespace_or_newlines_are_rejected_in_quote_source(self):
        r, c = self.fixture()
        for q in ("USE DUCKDB", "Use duckdb", "use  duckdb", "use duckdb not mongo", "use duckdb\n not mongo", "we will use duckdb\n"):
            ok, why = self.verdict(dict(quote_source=q), c, r)
            if q == "we will use duckdb\n": self.assertTrue(ok); continue      # an exact substring (the newline is in the entry)
            self.assertFalse(ok, q); self.assertIn("source quote not found", why)

    def test_a_source_quote_must_lie_inside_one_raw_entry(self):
        r, c = self.fixture([dict(text="we will use duckdb"), dict(text="not mongo")])
        self.assertEqual(self.verdict(dict(quote_source="we will use duckdb"), c, r), (True, "confirmed"))
        for q in ("duckdbnot mongo", "use duckdb not mongo", "use duckdb\nnot mongo", "duckdb not"): self.assertFalse(self.verdict(dict(quote_source=q), c, r)[0], q)
        r2, c2 = self.fixture(["we will use duckdb", "not mongo"]); self.assertTrue(self.verdict(dict(quote_source="not mongo"), c2, r2)[0])      # entries given as plain strings
        r3, c3 = self.fixture("we will use duckdb"); self.assertTrue(self.verdict({}, c3, r3)[0])      # one string

    def test_empty_or_missing_quotes_are_still_refused(self):
        r, c = self.fixture()
        self.assertIn("no source quote", self.verdict(dict(quote_source="  "), c, r)[1]); self.assertIn("no source quote", self.verdict(dict(quote_source=None), c, r)[1])
        self.assertIn("no quote_handoff", self.verdict(dict(quote_handoff=None), c, r)[1])
        self.assertIn("not available", self.verdict({}, c, r, handoff=None)[1])

    def test_compare_passages_and_the_gate_diff_are_raw_evidence(self):
        cmp_ = call_of(dict(overall=dict(verdict="contradicted", confidence=0.99), aspects=[]), tool="compare", tid="k1", passage_a="Decision: use mongo.", passage_b="We will use DuckDB\nnot mongo.", aspects=[])
        self.assertEqual(jevref.quote_evidence_raw(cmp_), ["Decision: use mongo.", "We will use DuckDB\nnot mongo."])
        chk = dict(id="k", tool="jev_compare", verdict="contradicted", confidence=0.99, jev_ref=dict(tool_use_id="k1", result_index=0, key=jevref.compare_key(cmp_["input"])))
        by = {b["id"]: b for b in jevref.bind([chk], [cmp_], "R04")}
        f = dict(type="wrong_fact", check_id="k", confidence=0.99, claim=chk["jev_ref"]["key"], quote_handoff="use mongo", quote_source="use DuckDB\nnot mongo", uuid="u", category="c")
        self.assertEqual(jevref.validate_finding(f, by, HANDOFF, "R04"), (True, "confirmed"))
        for q in ("use duckdb\nnot mongo", "use DuckDB not mongo", "USE MONGO"):
            self.assertFalse(jevref.validate_finding(dict(f, quote_source=q), by, HANDOFF, "R04")[0], q)
        g = call_of([row("Patch removes the guard.", "contradicted", 0.99)], [dict(text="evidence A")], tool="gate", tid="g1", diff="-guard()\n+noop()")
        self.assertEqual(jevref.quote_evidence_raw(g), ["evidence A", "-guard()\n+noop()"])
        gby = {b["id"]: b for b in jevref.bind([check("g", "Patch removes the guard.", "contradicted", 0.99, tid="g1", tool="jev_gate")], [g], "R04")}
        gf = dict(type="wrong_fact", check_id="g", confidence=0.99, claim="Patch removes the guard.", quote_handoff="use mongo", quote_source="-guard()\n+noop()", uuid="u", category="c")
        self.assertTrue(jevref.validate_finding(gf, gby, HANDOFF, "R04")[0]); self.assertFalse(jevref.validate_finding(dict(gf, quote_source="-GUARD()\n+noop()"), gby, HANDOFF, "R04")[0])

    def test_the_normalized_advisory_evidence_and_the_omission_raw_evidence_keep_their_meaning(self):
        _, c = self.fixture([dict(text="We WILL use   DuckDB")]); b = jevref.bind([check("k", "The decision was to use mongo instead of duckdb.", "contradicted", 0.99)], [c], "R04")[0]
        self.assertEqual(b["call_evidence"], ["we will use duckdb"]); self.assertEqual(b["call_evidence_raw"], ["We WILL use   DuckDB"]); self.assertEqual(b["call_quote_evidence"], ["We WILL use   DuckDB"])
        _, g = self.fixture([dict(text="E")]); g = dict(g, input=dict(g["input"], passage_a="PA", diff="DD"))
        self.assertEqual(jevref.call_evidence_raw(g), ["E"]); self.assertEqual(jevref.quote_evidence_raw(g), ["E", "PA", "DD"])

    def test_r02_lost_detail_needs_the_exact_quote_in_a_source_side_raw_entry(self):
        absence = row("Never run migrate.sh against prod.", "unsupported", 0.99); source = row("The source states: never run migrate.sh against prod.", "verified", 0.99)
        ca, cs = call_of([absence], [dict(text=HANDOFF)], tid="a1"), call_of([source], [dict(text="User said: Never run migrate.sh against prod.")], tid="s1")
        chk = [check("a", absence["claim"], "unsupported", 0.99, tid="a1"), check("s", source["claim"], "verified", 0.99, tid="s1")]
        by = {b["id"]: b for b in jevref.bind(chk, [ca, cs], False)}
        f = dict(type="lost_detail", check_id="a", confidence=0.99, claim=absence["claim"], quote_handoff=None, quote_source="Never run migrate.sh against prod.", uuid="u", category="c")
        self.assertEqual(jevref.validate_finding(f, by, HANDOFF, False), (True, "confirmed"))
        for q in ("never run migrate.sh against prod.", "Never run  migrate.sh against prod."): self.assertFalse(jevref.validate_finding(dict(f, quote_source=q), by, HANDOFF, False)[0], q)

class SkillText(unittest.TestCase):
    def test_skill_md_states_the_exact_quotation_and_probability_rules(self):
        t = skilldocs.doc("reference/report.md"); i = t.index("## Output"); out = t[i:t.index("\n## ", i + 5)]
        for must in ("exact", "case, whitespace and newlines", "finite number in [0, 1]", "one raw entry"): self.assertIn(must, out)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the retry advice (stdlib only, no Jev call, never reads .handoff-verify/): advice.py reads the REAL jev_verify / jev_gate result of a claim that did not pass
and says what to change in the single re-verification; report.py stores it on bound, unresolved checks outside an omission pair and never changes a status because of it.
The verify result shape is the one returned by the live Jev server (claim, verdict, confidence, action, same_subject; subject_at at the top level).
usage: python3 -B test_retry_advice.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, jevref, report

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
EVIDENCE = "$ git log --oneline -1\n54edd39 Plugin 0.7.8: handoff-verify scope filter\n$ python3 -B -m unittest\nRan 69 tests\nOK"

def verify_result(rows, subject_at=0.5):
    return json.dumps(dict(tool="jev_verify", subject_at=subject_at, results=[dict(id="claim%d" % k, claim=c, verdict=v, confidence=p, action=a, same_subject=s) for k, (c, v, p, a, s) in enumerate(rows)]))

def call(rows, evidence=EVIDENCE, subject_at=0.5, tid="c1", tool="verify", result_claims=None):
    sent = [r[0] for r in rows]; shown = [(c, *r[1:]) for c, r in zip(result_claims or sent, rows)]
    rec = [dict(type="assistant", uuid="u1", message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="mcp__jev__jev_" + tool, input=dict(claims=sent, evidence=evidence))])),
           dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=verify_result(shown, subject_at))]))]
    return rec, jevref.calls_from_records(rec)[0]

def advise_one(row, **kw):
    _, c = call([row], **kw)
    return advice.advise(jevref.results_of(c)[0][0], c)

class Rules(unittest.TestCase):
    def test_a_result_that_passes_gets_no_advice(self):
        self.assertIsNone(advise_one(("HEAD is 54edd39.", "verified", 0.96, "auto", 0.9)))
        self.assertIsNotNone(advise_one(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9)))   # a confirmed contradiction is a claim that failed, not a pass

    def test_contradicted_above_the_threshold_means_fix_the_fact_and_below_recheck(self):
        self.assertEqual(advise_one(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9))["code"], "fix_fact")
        self.assertEqual(advise_one(("HEAD is 0000000.", "contradicted", 0.95, "auto", 0.9))["code"], "recheck_fact")   # 0.95 itself is not above

    def test_evidence_about_another_subject_comes_first(self):
        a = advise_one(("HEAD is 54edd39.", "verified", 0.9, "review", 0.3))
        self.assertEqual(a["code"], "evidence_off_subject")
        self.assertEqual(advise_one(("HEAD is 54edd39.", "verified", 0.9, "review", 0.9))["code"], "add_direct_evidence")   # review alone is not off-subject

    def test_unsupported_lists_the_claim_details_absent_from_the_evidence(self):
        a = advise_one(("Commit 54edd39 is plugin 0.7.8 and 71 tests pass in report_test.py.", "unsupported", 0.9, "auto", 0.8))
        self.assertEqual(a["code"], "remove_unsupported_detail")
        self.assertEqual(a["details"], ["71", "report_test.py"])
        self.assertEqual(advise_one(("The scope filter landed.", "unsupported", 0.9, "auto", 0.8))["code"], "add_source_passage")

    def test_low_confidence_adds_direct_evidence_and_splits_a_compound_claim(self):
        a = advise_one(("The unit tests pass.", "verified", 0.9, "auto", 0.9))
        self.assertEqual(a["code"], "add_direct_evidence"); self.assertNotIn("split", a)
        b = advise_one(("Commit 54edd39 is plugin 0.7.8 and all 69 unit tests pass on it.", "verified", 0.9, "auto", 0.9))
        self.assertEqual(b["code"], "add_direct_evidence"); self.assertTrue(b["split"]); self.assertIn("one claim per fact", b["hint"])

    def test_no_usable_result(self):
        rec, c = call([("HEAD is 54edd39.", "verified", None, "auto", 0.9)])
        self.assertEqual(advice.advise(jevref.results_of(c)[0][0], c)["code"], "no_result")

    def test_aux_only_failure_advice(self):
        for row in (("HEAD is 54edd39.", "verified", 0.99, "review", 0.9), ("HEAD is 54edd39.", "verified", 0.99, "auto", None), ("HEAD is 54edd39.", "verified", 0.99, "auto", 0.3)):
            a = advise_one(row)
            self.assertEqual(a["code"], "aux_condition_failed" if row[4] != 0.3 else "evidence_off_subject", row)
        a = advise_one(("HEAD is 54edd39.", "verified", 0.99, "review", 0.9))
        self.assertNotIn("below the threshold", a["hint"]); self.assertIn("same_subject/subject_at", a["hint"]); self.assertIn("exactly this claim", a["hint"])
        self.assertEqual(advise_one(("HEAD is 54edd39.", "verified", 0.9, "review", 0.9))["code"], "add_direct_evidence")   # low confidence is still the old advice

    def test_no_result_hint_matches_retry_policy(self):
        for k in report.TRANSPORT_ERRORS: self.assertIn(k, advice.HINTS["no_result"])
        self.assertEqual(report.TRANSPORT_ERRORS, {"transport", "invalid_response"})

    def test_result_mismatch_no_verdict_advice(self):
        _, c = call([("HEAD is 54edd39.", "contradicted", 0.99, "auto", 0.9)], result_claims=["HEAD is 0000000."])
        e = jevref.results_of(c)[0][0]; self.assertTrue(e.get("mismatch"))
        a = advice.advise(e, c)
        self.assertEqual(a["code"], "result_mismatch"); self.assertIn(e["mismatch"], a["hint"])
        out = advice.session_advice([c])
        self.assertEqual([(r["advice"]["code"]) for r in out], ["result_mismatch"])
        self.assertTrue(all(r["advice"]["code"] not in ("fix_fact", "recheck_fact", "add_direct_evidence") for r in out))

    def test_comma_list_not_compound(self):
        self.assertFalse(advice.compound("files a.md, b.md, c.md exist in the repository"))
        self.assertFalse(advice.compound("Files a.md, b.md and c.md exist"))

    def test_single_fact_with_comma_not_compound(self):
        self.assertFalse(advice.compound("In the repository, the plugin version is 0.7.10"))

    def test_semicolon_and_conjunction_compound(self):
        self.assertTrue(advice.compound("The plugin is at 0.7.10; the tests all pass"))
        self.assertTrue(advice.compound("The plugin is at 0.7.10 but the tests fail"))
        self.assertFalse(advice.compound("Tests pass and ok"))   # a part with fewer than 3 words does not count

    def test_romanian_conjunctions(self):
        for c in ("Versiunea este 0.7.10 și toate testele trec", "Versiunea este 0.7.10 iar toate testele trec", "Versiunea este 0.7.10 dar toate testele pică", "Versiunea este 0.7.10 însă toate testele pică"):
            self.assertTrue(advice.compound(c), c)

    def test_eg_and_dotted_words_not_details(self):
        self.assertEqual(advice.unsupported_details("Use tools, e.g. the tests.pass flag", "nothing relevant"), [])
        self.assertEqual(advice.unsupported_details("Use e.g tests.pass here", "x"), [])

    def test_filename_with_extension_or_separator_still_detail(self):
        self.assertEqual(advice.unsupported_details("See notes.md and run.mjs and docs/readme", "x"), ["notes.md", "run.mjs", "docs/readme"])

    def test_every_code_has_a_hint(self):
        self.assertEqual(set(advice.CODES), set(advice.HINTS))

class ReportAdvice(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = self.t.name
    def tearDown(self): self.t.cleanup()

    def doc(self, rows, findings=()):
        rec, _ = call(rows)
        log = os.path.join(self.d, "s.jsonl")
        with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
        checks = [dict(id="k%d" % k, tool="jev_verify", verdict=r[1], confidence=r[2], jev_ref=dict(tool_use_id="c1", result_index=k, key=r[0]), advice=dict(code="invented", hint="x")) for k, r in enumerate(rows)]
        d = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), status="PASS", findings=list(findings), unresolved=[], checks=checks)
        return report.bind_report(d, log, self.d, (), False, None, None, "R04")

    def test_unresolved_checks_get_the_real_advice_and_the_status_is_unchanged(self):
        rows = [("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9), ("Commit 54edd39 is plugin 0.7.8 and all 69 unit tests pass on it.", "verified", 0.9, "auto", 0.9)]
        out = self.doc(rows)
        self.assertNotIn("advice", out["checks"][0])                     # resolved: a declared advice is dropped
        self.assertEqual(out["checks"][1]["advice"]["code"], "add_direct_evidence"); self.assertTrue(out["checks"][1]["advice"]["split"])
        with_advice = out["status"]
        for c in out["checks"]: c.pop("advice", None)
        self.assertEqual(with_advice, "UNRESOLVED")
        report.attach_advice(out["checks"], [dict(bound=False)] * 2, [], [])
        self.assertTrue(all("advice" not in c for c in out["checks"]))

    def test_the_checks_of_an_omission_pair_get_no_advice(self):
        rows = [("The note states X.", "unsupported", 0.9, "auto", 0.2), ("The supplied source passage states this detail: X", "verified", 0.9, "auto", 0.9)]
        f = dict(type="lost_detail", check_id="k0", omission_ref=dict(detail="X", source_check_id="k1"), claim=rows[0][0], confidence=0.9, quote_source="X", quote_handoff=None, uuid="u", category="c")
        out = self.doc(rows, [f])
        self.assertTrue(all("advice" not in c for c in out["checks"]))

    def test_gate_result_in_session_advice(self):
        _, c = call([("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9), ("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9)], tool="gate")
        self.assertEqual(c["tool"], "gate")
        out = advice.session_advice([c])
        self.assertEqual([(r["tool"], r["result_index"], r["advice"]["code"]) for r in out], [("gate", 0, "fix_fact")])

    def test_gate_result_in_attach_advice(self):
        rec, c = call([("HEAD is 0000000.", "contradicted", 0.9, "auto", 0.9)], tool="gate")
        checks = [dict(id="k0", tool="jev_gate", verdict="contradicted", confidence=0.9, jev_ref=dict(tool_use_id="c1", result_index=0, key="HEAD is 0000000."))]
        b = jevref.bind(checks, [c], True)
        self.assertTrue(b[0]["bound"])
        self.assertEqual(b[0]["tool"], "gate")
        report.attach_advice(checks, b, [c], [])
        self.assertEqual(checks[0]["advice"]["code"], "recheck_fact")

    def test_mismatched_unbound_check_has_no_attached_verdict_advice(self):
        rec, c = call([("HEAD is 54edd39.", "contradicted", 0.9, "auto", 0.9)], result_claims=["HEAD is 0000000."])
        checks = [dict(id="k0", tool="jev_verify", verdict="contradicted", confidence=0.9, jev_ref=dict(tool_use_id="c1", result_index=0, key="HEAD is 54edd39."))]
        b = jevref.bind(checks, [c], True)
        self.assertFalse(b[0]["bound"])
        report.attach_advice(checks, b, [c], [])
        self.assertNotIn("advice", checks[0])

class Cli(unittest.TestCase):
    def test_cli_lists_every_result_that_did_not_pass(self):
        with tempfile.TemporaryDirectory() as d:
            rec, _ = call([("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9), ("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9)])
            log = os.path.join(d, "s.jsonl")
            with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", log], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 0, p.stderr); out = json.loads(p.stdout)
            self.assertEqual([(r["result_index"], r["advice"]["code"]) for r in out["results"]], [(1, "fix_fact")])
            self.assertIn("never an identical call", out["rule"])
            self.assertEqual(subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", os.path.join(d, "missing.jsonl")], capture_output=True, text=True, env=ENV).returncode, 2)

if __name__ == "__main__": unittest.main()

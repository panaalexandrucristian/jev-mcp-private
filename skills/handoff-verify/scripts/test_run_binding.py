#!/usr/bin/env python3
"""Offline test of the demonstrated evaluation in the report and the gate (council round 3, fixes 1 and 2; stdlib only, simulated I/O, no Jev call, never reads .handoff-verify/):
 - a check whose version_ref names no run while several verification runs follow its write, or a run that is not one of them, is an INVALID evaluation: `report.bind_report` / `report.write_report` and
   `versions.gate` never certify the delivery on it (not PASS, not verified_version), while a check that names one of the runs stays valid;
 - the candidate runs end at the next SUCCESSFUL mutation of the note: a failed Write between the write and the run does not hide the run;
 - an exclusion of `scope_exclusions` without `evaluation`, in a report about versions, is re-derived in the evaluation of the report (the one every version_ref of its checks names); with none it keeps the
   global scope, with several it is not demonstrated: the classification of another evaluation's context never validates it.
All fixtures are invented.
usage: python3 -B test_run_binding.py [-v]"""
import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover, jevref, omissions, report, scope, versions
import contract_fixtures as CF
import audit_fixtures as AF
from test_scope_filter import classify_result, payload, DETAILS, ROWS, excl

CLAIM = "The note says the billing migration ships on Friday."
V1, V2 = "# Handoff\n- alpha\n", "# Handoff\n- beta\n"

class Tx:
    def __init__(self, d):
        self.d, self.n, self.recs = d, 0, []
        self.note = os.path.join(d, "HANDOFF.md"); self.log = os.path.join(d, "session.jsonl")
    def rec(self, typ, content, **extra):
        self.n += 1; self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.d, sessionId="s1", message=dict(role=typ, content=content), **extra))
    def user(self, text): self.rec("user", text)
    def tool(self, tid, name, inp, result="ok", err=False):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)]); self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result, is_error=err)])
    def write(self, tid, text, err=False): self.tool(tid, "Write", dict(file_path=self.note, content=text), "boom" if err else "File created successfully", err)
    def run(self, tid): self.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded")
    def verify(self, tid="c1"):
        self.tool(tid, "mcp__jev__jev_verify", dict(claims=[CLAIM], evidence=[dict(text="Friday is the date.")]), CF.verify_body([dict(claim=CLAIM, verdict="verified", confidence=0.99)], compatible_synthetic=True))
    def save(self):
        with open(self.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return self.log

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name); scope._MEMO.clear(); omissions._MEMO.clear()
    def check(self, t, wid, ea, **ref):
        v = next(x for x in versions.versions_of(t.log, t.note)[0] if x["write_tool_use_id"] == wid)
        return dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=dict(versions.version_ref(v, ea), **ref))
    def doc(self, t, checks, **extra):
        return AF.complete(dict(dict(session=dict(session_id="s1", jsonl=t.log, cwd=self.d), handoff=dict(path=t.note, versions=[]), checks=checks, findings=[], unresolved=[], status="PASS"), **extra))   # complete audit data derived from the fixture's real source
    def write(self, t, doc, name="run"):
        rd = os.path.join(self.d, name); os.makedirs(rd)
        md, js = report.write_report(rd, t.note, doc, "Stare: **PASS**\n", calls_jsonl=t.log); return json.load(open(os.path.join(rd, js), encoding="utf-8"))

class RunInTheReport(Base):
    def session(self):
        t = Tx(self.d); t.user("first request"); t.write("w1", V1); t.run("r1"); t.user("second request"); t.run("r2"); t.verify(); t.save(); open(t.note, "w").write(V1); return t

    def test_two_runs_without_a_selector_never_certify_the_delivery(self):
        t = self.session(); doc = self.write(t, self.doc(t, [self.check(t, "w1", "session_end")]))
        self.assertNotEqual(doc["status"], "PASS"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        vi = doc["binding_summary"]["version_identity"]; self.assertEqual(vi["identity_ok"], 0); self.assertTrue([r for r in vi["reasons"] if "run" in r])
        g = versions.gate(t.log, t.note, doc, disk_path=t.note); self.assertNotEqual(g["delivery_state"], "verified_version")

    def test_a_run_that_does_not_exist_never_certifies_the_delivery(self):
        t = self.session(); doc = self.write(t, self.doc(t, [self.check(t, "w1", "session_end", run="not-a-run")]))
        self.assertNotEqual(doc["status"], "PASS"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version"); self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 0)
        self.assertNotEqual(versions.gate(t.log, t.note, doc, disk_path=t.note)["delivery_state"], "verified_version")

    def test_bind_report_alone_agrees(self):
        t = self.session(); d = report.bind_report(self.doc(t, [self.check(t, "w1", "session_end")]), t.log, self.d, (), True, t.note, None, "R04")
        self.assertEqual(d["status"], "UNRESOLVED"); self.assertEqual(d["binding_summary"]["version_identity"]["identity_ok"], 0)

    def test_a_named_run_stays_valid(self):
        t = self.session()
        for run in ("r1", "r2"):
            doc = self.write(t, self.doc(t, [self.check(t, "w1", "session_end", run=run)]), name="run-" + run)
            self.assertEqual(doc["status"], "PASS", run); self.assertEqual(doc["delivery"]["delivery_state"], "verified_version", run); self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 1)

    def test_one_run_needs_no_selector_and_prefix_never_has_one(self):
        t = Tx(self.d); t.user("req"); t.write("w1", V1); t.run("r1"); t.verify(); t.save(); open(t.note, "w").write(V1)
        self.assertEqual(self.write(t, self.doc(t, [self.check(t, "w1", "session_end")]), "a")["status"], "PASS")
        self.assertEqual(self.write(t, self.doc(t, [self.check(t, "w1", "prefix")]), "b")["status"], "PASS")
        self.assertNotEqual(self.write(t, self.doc(t, [self.check(t, "w1", "prefix", run="r1")]), "c")["status"], "PASS")

class CandidateRuns(Base):
    def test_a_failed_write_does_not_end_the_candidate_region(self):
        t = Tx(self.d); t.user("req"); t.write("w1", V1); t.write("w1x", V2, err=True); t.run("r1"); t.say = None
        w = omissions.source_window(t.recs, "w1", "session_end", "r1")
        self.assertIsNone(w["ambiguous"]); self.assertEqual((w["run"], [r["id"] for r in w["runs"]]), ("r1", ["r1"]))
        self.assertIsNone(omissions.source_window(t.recs, "w1", "session_end")["ambiguous"])

    def test_a_successful_later_write_still_ends_it(self):
        t = Tx(self.d); t.user("req"); t.write("w1", V1); t.write("w2", V2); t.run("r1")
        self.assertEqual([r["id"] for r in omissions.source_window(t.recs, "w1", "session_end")["runs"]], [])
        self.assertEqual([r["id"] for r in omissions.source_window(t.recs, "w2", "session_end")["runs"]], ["r1"])

class ScopeOfTheReport(Base):
    def session(self, ctx_of):
        """request A, w1, verify c1 (in w1's window), request B, w2 (no verification run: the global scope equals the scope of w2 / session_end), then a jev_classify call whose context is the scope of `ctx_of` -> (Tx, ctx)."""
        t = Tx(self.d); t.user("request A"); t.write("w1", V1); t.verify(); t.user("request B"); t.write("w2", V2); t.save()
        scope._MEMO.clear(); ctx = scope.scope_of(t.log, *ctx_of)[0]; self.assertIsNotNone(ctx)
        t.tool("k1", "mcp__jev__jev_classify", payload(ctx), classify_result(ROWS)); t.save(); scope._MEMO.clear(); omissions._MEMO.clear(); return t, ctx

    def test_a_classification_of_the_later_context_does_not_validate_an_exclusion_without_evaluation(self):
        t, _ = self.session(("w2", "session_end"))
        doc = self.write(t, self.doc(t, [self.check(t, "w1", "prefix")], scope_exclusions=[excl(0)]))
        self.assertEqual(doc["scope_audit"]["valid"], 0); self.assertEqual(doc["scope_audit"]["invalid"], 1); self.assertIn("canonical scope", doc["scope_audit"]["reasons"][0]["reason"])
        self.assertNotEqual(doc["status"], "PASS")

    def test_the_context_of_the_evaluation_of_the_report_validates_it(self):
        t, _ = self.session(("w1", "prefix"))
        doc = self.write(t, self.doc(t, [self.check(t, "w1", "prefix")], scope_exclusions=[excl(0)]))
        self.assertEqual((doc["scope_audit"]["valid"], doc["scope_audit"]["invalid"]), (1, 0)); self.assertEqual(doc["status"], "PASS")

    def test_several_evaluations_in_the_report_leave_an_unnamed_exclusion_undemonstrated(self):
        t, _ = self.session(("w1", "prefix"))
        doc = self.write(t, self.doc(t, [self.check(t, "w1", "prefix"), dict(self.check(t, "w2", "session_end"), id="p2")], scope_exclusions=[excl(0)]))
        self.assertEqual(doc["scope_audit"]["invalid"], 1); self.assertIn("several evaluations", doc["scope_audit"]["reasons"][0]["reason"]); self.assertNotEqual(doc["status"], "PASS")

    def test_an_exclusion_that_names_its_evaluation_is_unchanged(self):
        t, _ = self.session(("w2", "session_end"))
        e = dict(excl(0), evaluation=dict(write_tool_use_id="w2", evaluated_against="session_end"))
        doc = self.write(t, self.doc(t, [self.check(t, "w1", "prefix")], scope_exclusions=[e]))
        self.assertEqual((doc["scope_audit"]["valid"], doc["scope_audit"]["invalid"]), (1, 0))

    def test_a_report_without_version_checks_keeps_the_global_scope(self):
        t, _ = self.session(())          # the classification was made on the scope of the whole session (no write)
        doc = self.write(t, self.doc(t, [], scope_exclusions=[excl(0)]))
        self.assertEqual((doc["scope_audit"]["valid"], doc["scope_audit"]["invalid"]), (1, 0))

class OtherRepresentations(Base):
    """The same session recorded twice: the original holds w1, r1, c1, r2; the copy stops after c1 (w1, r1, c1). The evaluation is judged in every representation: the original shows two runs after w1."""
    def pair(self):
        t = Tx(self.d); t.user("first request"); t.write("w1", V1); t.run("r1"); t.verify(); n = len(t.recs); t.user("second request"); t.run("r2"); t.save(); open(t.note, "w").write(V1)
        cp = os.path.join(self.d, "copy.jsonl")
        with open(cp, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in t.recs[:n]))
        return t, cp

    def run_report(self, t, session, calls, ref, name):
        doc = self.doc(t, [self.check(t, "w1", "session_end", **ref)]); doc["session"]["jsonl"] = session; doc = AF.complete(doc, source=calls)   # the review is derived again, from the transcript that demonstrates the version identity (the calls log of the same session)
        rd = os.path.join(self.d, name); os.makedirs(rd)
        md, js = report.write_report(rd, t.note, doc, "Stare: **PASS**\n", calls_jsonl=calls); return json.load(open(os.path.join(rd, js), encoding="utf-8"))

    def test_the_original_with_two_runs_and_the_copy_with_one_never_certify_without_a_run(self):
        t, cp = self.pair()
        for name, session, calls in (("a", cp, t.log), ("b", t.log, cp)):
            doc = self.run_report(t, session, calls, {}, name)
            self.assertNotEqual(doc["status"], "PASS", name); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version", name)
            vi = doc["binding_summary"]["version_identity"]; self.assertEqual(vi["identity_ok"], 0, name); self.assertTrue([r for r in vi["reasons"] if "run" in r], name)
            self.assertNotEqual(versions.gate(calls, t.note, doc, disk_path=t.note)["delivery_state"], "verified_version", name)

    def test_the_check_constructor_agrees(self):
        import checks
        t, cp = self.pair(); v = next(x for x in versions.versions_of(t.log, t.note)[0] if x["write_tool_use_id"] == "w1")
        inp = dict(claims=[CLAIM], evidence=[dict(text="Friday is the date.")])
        def spec(**ref): return [dict(id="p1", tool="jev_verify", tool_use_id="c1", result_index=0, input=inp, version_ref=dict(versions.version_ref(v, "session_end"), **ref))]
        for source, calls in ((cp, t.log), (t.log, cp)):
            with self.assertRaises(checks.CheckError) as cm: checks.build_checks(spec(), jevref.load_calls(calls), source, t.note, calls)
            self.assertIn("run", cm.exception.errors[0]["reason"])
            self.assertEqual(len(checks.build_checks(spec(run="r1"), jevref.load_calls(calls), source, t.note, calls)), 1)

    def test_a_named_run_that_the_original_demonstrates_stays_valid(self):
        t, cp = self.pair()
        for name, session, calls in (("c", cp, t.log), ("d", t.log, cp)):
            doc = self.run_report(t, session, calls, dict(run="r1"), name)
            self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 1, name); self.assertEqual(doc["status"], "PASS", name)

    def test_a_run_that_no_representation_holds_is_invalid(self):
        t, cp = self.pair()
        doc = self.run_report(t, cp, t.log, dict(run="nope"), "e"); self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 0); self.assertNotEqual(doc["status"], "PASS")

    def test_independent_transcripts_are_not_one_session(self):
        t, cp = self.pair()
        with open(cp, "w", encoding="utf-8") as f: f.write("".join(json.dumps(dict(r, sessionId="other")) + "\n" for r in t.recs[:len(t.recs) - 2]))
        self.assertEqual(versions.run_problem(t.log, dict(write_tool_use_id="w1", sha256="x", evaluated_against="session_end"), [cp])[0], "run")
        self.assertEqual(versions.run_problem(cp, dict(write_tool_use_id="w1", sha256="x", evaluated_against="session_end"))[0], "ok")

if __name__ == "__main__": unittest.main()

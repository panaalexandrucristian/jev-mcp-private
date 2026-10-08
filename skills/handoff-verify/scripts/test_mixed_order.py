#!/usr/bin/env python3
"""Offline test of the mixed-stream order carried through the whole pipeline (council fix 5; stdlib only, no Jev call, never reads .handoff-verify/): a path written in the selected session AND in one of its
subagent transcripts has no demonstrated common order. `prepare.py` already said so in its inventory; now `versions.versions_of`, `replay_all`, `validate_ref`, `bind_versions`, the report and the gate say it
too: the bytes of every full Write stay (hash, source), an Edit whose base the interleaved stream may have changed is `content not recoverable`, and the combined history, the last version and the same-session
windows stay UNRESOLVED (never a recoverable Edit, a report PASS or `verified_version`). Different paths stay independent; a child-only path is not a version of the parent and the report keeps that blocker.
All fixtures are invented.
usage: python3 -B test_mixed_order.py [-v]"""
import contextlib, hashlib, io, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import jevref, prepare, report, versions
from test_stream_reconstruction import Tx

CLAIM = "The note says the billing migration ships on Friday."
def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "s.jsonl"); self.sub = os.path.join(self.d, "s", "subagents", "agent-1.jsonl")
    def jev(self, t, tid="c1"):
        t.tool(tid, "mcp__jev__jev_verify", dict(claims=[CLAIM], evidence=[dict(text="Friday is the date.")]), json.dumps(dict(subject_at=0.5, results=[dict(claim=CLAIM, verdict="supported", confidence=0.99, same_subject=0.9)])))
    def parent(self, *steps):
        t = Tx(self.d)
        for s in steps: s(t)
        t.save(self.log); return t
    def child(self, *writes, path=None):
        t = Tx(self.d)
        for tid, content in writes: t.write(tid, path or self.note, content)
        t.save(self.sub)
    def prepare(self):
        out = io.StringIO(); work = os.path.join(self.d, "work%d" % len(os.listdir(self.d))); old = sys.argv; sys.argv = ["prepare.py", self.log, "--cwd", self.d, "--out", work]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        return code, json.loads(out.getvalue()), json.load(open(os.path.join(work, "inventory.json")))
    def doc(self, wid="pw1", call="c1"):
        v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == wid)
        chk = dict(id="p1", tool="verify", verdict="supported", confidence=0.99, jev_ref=dict(tool_use_id=call, result_index=0, key=CLAIM), version_ref=versions.version_ref(v, "session_end"))
        return dict(session=dict(session_id="s1", jsonl=self.log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS")
    def write_report(self, doc):
        rd = os.path.join(self.d, "run%d" % len(os.listdir(self.d))); os.makedirs(rd)
        md, js = report.write_report(rd, self.note, doc, "Stare: **PASS**\n", calls_jsonl=self.log); return json.load(open(os.path.join(rd, js)))

class Edits(Base):
    def setUp(self):
        super().setUp(); self.parent(lambda t: t.write("pw1", self.note, "alpha beta\n"), self.jev, lambda t: t.edit("pe1", self.note, "beta", "gamma")); self.child(("cw1", "CHILD\n"))

    def test_versions_of_keeps_the_full_write_and_marks_the_dependent_edit_unrecoverable(self):
        vs = versions.versions_of(self.log, self.note)[0]
        self.assertEqual([(v["write_tool_use_id"], v["status"]) for v in vs], [("pw1", "ok"), ("pe1", "content not recoverable")])
        self.assertEqual(vs[0]["sha256"], sha("alpha beta\n")); self.assertIsNone(vs[1]["sha256"]); self.assertIn("stream", vs[1]["reason"])
        self.assertTrue(all(v["mixed"] == [self.sub] for v in vs)); self.assertIn("several streams", versions.mixed_reason(vs[0]))
        self.assertEqual(versions.replay_all(self.log)["pe1"], (None, None)); self.assertEqual(versions.replay_all(self.log)["pw1"][1], sha("alpha beta\n"))

    def test_prepare_and_versions_of_agree(self):
        code, out, inv = self.prepare(); h = inv["handoffs"][0]; rows = {r["tool_use_id"]: r for r in h["versions"] if r["source_kind"] == "session"}
        self.assertFalse(h["ordering"]["demonstrated"]); self.assertEqual((rows["pw1"]["status"], rows["pe1"]["status"]), ("ok", "content not recoverable")); self.assertIsNone(rows["pe1"]["sha256"])
        vs = {v["write_tool_use_id"]: v for v in versions.versions_of(self.log, self.note)[0]}; self.assertEqual({k: r["sha256"] for k, r in rows.items()}, {k: v["sha256"] for k, v in vs.items()})
        self.assertTrue(out["blockers"])

    def test_validate_ref_refuses_a_same_session_certificate_but_not_a_retrospective_snapshot(self):
        vs = versions.versions_of(self.log, self.note)[0]; call = jevref.load_calls(self.log)[0]
        kind, why, _ = versions.validate_ref(versions.version_ref(vs[0]), vs, call, same=True); self.assertEqual(kind, "unordered"); self.assertIn("several streams", why)
        self.assertEqual(versions.validate_ref(versions.version_ref(vs[0]), vs)[0], "ok")                       # a retrospective check cites the bytes of the full Write

    def test_the_gate_and_the_report_never_certify_it(self):
        open(self.note, "w").write("alpha gamma\n"); doc = self.write_report(self.doc())
        self.assertNotEqual(doc["status"], "PASS"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        g = versions.gate(self.log, self.note, doc, disk_path=self.note); self.assertEqual(g["delivery_state"], "unresolved"); self.assertEqual(g["bound_checks_for_version"], 0)
        self.assertIn("not recoverable", " ".join(g["reasons"]))
        self.assertEqual(doc["binding_summary"]["version_identity"]["identity_failed"], 1); self.assertIn("several streams", " ".join(doc["binding_summary"]["version_identity"]["reasons"]))

class LastWrite(Base):
    def test_a_last_write_in_a_mixed_history_is_not_the_delivered_version(self):
        self.parent(lambda t: t.write("pw1", self.note, "one\n"), self.jev, lambda t: t.write("pw2", self.note, "two\n")); self.child(("cw1", "CHILD\n"))
        vs = versions.versions_of(self.log, self.note)[0]; self.assertEqual([v["status"] for v in vs], ["ok", "ok"])
        open(self.note, "w").write("two\n"); doc = self.write_report(self.doc("pw1"))
        g = versions.gate(self.log, self.note, doc, disk_path=self.note); self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("several streams", " ".join(g["reasons"]))
        self.assertNotEqual(doc["status"], "PASS"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")

    def test_a_single_stream_history_is_unchanged(self):
        self.parent(lambda t: t.write("pw1", self.note, "one\n"), self.jev); open(self.note, "w").write("one\n"); self.assertEqual(versions.versions_of(self.log, self.note)[0][0]["mixed"], [])
        doc = self.write_report(self.doc()); self.assertEqual(doc["status"], "PASS"); self.assertEqual(doc["delivery"]["delivery_state"], "verified_version")

    def test_different_paths_stay_independent(self):
        other = os.path.join(self.d, "OTHER.md"); self.parent(lambda t: t.write("pw1", self.note, "alpha beta\n"), self.jev, lambda t: t.edit("pe1", self.note, "beta", "gamma")); self.child(("cw1", "CHILD\n"), path=other)
        vs = versions.versions_of(self.log, self.note)[0]; self.assertEqual([(v["status"], v["mixed"]) for v in vs], [("ok", []), ("ok", [])]); self.assertEqual(vs[1]["content"], "alpha gamma\n")
        open(self.note, "w").write("alpha gamma\n"); doc = self.write_report(self.doc("pw1"))
        self.assertEqual(versions.gate(self.log, self.note, doc, disk_path=self.note)["delivery_state"], "needs_reverification")        # v1 is stale, as before; nothing about the other path

class ChildOnly(Base):
    def test_a_child_only_path_is_not_a_version_of_the_parent_up_to_the_report(self):
        self.parent(lambda t: t.rec("user", "req"), self.jev); self.child(("cw1", "CHILD\n"))
        self.assertEqual(versions.versions_of(self.log, self.note)[0], []); p = versions.provenance(self.log, self.note)
        self.assertEqual(p["state"], "no_record"); self.assertIn("subagent", p["blocker"])
        cv = versions.versions_of(self.sub, self.note)[0][0]
        chk = dict(id="p1", tool="verify", verdict="supported", confidence=0.99, jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=versions.version_ref(cv, "session_end"))
        open(self.note, "w").write("CHILD\n")
        doc = self.write_report(dict(session=dict(session_id="s1", jsonl=self.log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS"))
        self.assertEqual(doc["status"], "UNRESOLVED"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        self.assertEqual(doc["binding_summary"]["version_identity"]["provenance"]["state"], "no_record"); self.assertIn("subagent", " ".join(doc["binding_summary"]["reasons"]))
        code, out, inv = self.prepare(); self.assertIn("subagent", " ".join(inv["handoffs"][0]["blockers"]))

class Copies(Base):
    """The same session reached through another representation (a copy of the transcript without the subagent directory) keeps the blockers the original demonstrates."""
    def setUp(self):
        super().setUp(); self.parent(lambda t: t.write("pw1", self.note, "one\n"), self.jev); self.child(("cw1", "CHILD\n"))
        self.copy = os.path.join(self.d, "copy", "s.jsonl"); os.makedirs(os.path.dirname(self.copy)); open(self.copy, "w").write(open(self.log).read()); open(self.note, "w").write("one\n")

    def test_the_copy_alone_is_not_mixed_and_the_original_is(self):
        self.assertEqual(versions.versions_of(self.copy, self.note)[0][0]["mixed"], []); self.assertTrue(versions.versions_of(self.log, self.note)[0][0]["mixed"])
        self.assertTrue(versions.same_session(self.log, self.copy))

    def test_a_report_about_the_original_checked_against_the_copy_never_certifies(self):
        rd = os.path.join(self.d, "r1"); os.makedirs(rd)
        doc = report.bind_report(dict(self.doc(), schema_version="1"), self.copy, rd, (), True, self.note, None, "R04")                 # session.jsonl = the original, the calls log = the copy
        self.assertNotEqual(doc["status"], "PASS"); self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 0); self.assertIn("several streams", " ".join(doc["binding_summary"]["version_identity"]["reasons"]))

    def test_the_gate_on_the_copy_with_a_report_about_the_original_keeps_the_blocker(self):
        rd = os.path.join(self.d, "r2"); os.makedirs(rd); doc = report.bind_report(dict(self.doc(), schema_version="1"), self.log, rd, (), True, self.note, None, "R04")
        g = versions.gate(self.copy, self.note, doc, disk_path=self.note); self.assertNotEqual(g["delivery_state"], "verified_version"); self.assertIn("several streams", " ".join(g["reasons"]))
        vs = versions.latest_versions(self.copy, self.note, doc)[0]; self.assertTrue(vs[-1]["mixed"])

    def test_the_equal_length_copy_does_not_win_by_being_listed_first(self):
        vs, canon, why = versions.latest_versions(self.copy, self.note, dict(session=dict(jsonl=self.log)))
        self.assertTrue(all(v["mixed"] for v in vs))

    def test_an_unmixed_copy_of_an_unmixed_session_is_unchanged(self):
        os.remove(self.sub); doc = dict(self.doc(), schema_version="1"); rd = os.path.join(self.d, "r3"); os.makedirs(rd)
        out = report.bind_report(doc, self.copy, rd, (), True, self.note, None, "R04"); self.assertEqual(out["status"], "PASS"); self.assertEqual(out["delivery"]["delivery_state"], "verified_version")

QUOTE = "ZZ-DETAIL: never deploy on friday"
class Windows(Base):
    """Windows that depend on the order of the streams stay unavailable for preparation and for the retrospective validation of an omission pair; the bytes of each full Write stay checkable."""
    def setUp(self):
        super().setUp(); self.text = "# Handoff\n- unrelated\n"
        self.parent(lambda t: t.rec("user", QUOTE), lambda t: t.write("pw1", self.note, self.text)); open(self.note, "w").write(self.text)

    def args(self, **kw):
        import argparse
        return argparse.Namespace(**dict(dict(source=self.log, file=self.note, cwd=self.d, write_id="pw1", evaluated_against="prefix", detail="Never deploy on friday", source_quote=QUOTE, location=[], run=None), **kw))

    def test_prepare_works_on_an_unmixed_note(self):
        import omissions
        obj, code = omissions.prepare_one(self.args()); self.assertEqual(code, 0, obj)

    def test_prepare_refuses_a_mixed_full_write(self):
        import omissions
        self.child(("cw1", "CHILD\n")); omissions._MEMO.clear()
        for ea in ("prefix", "session_end"):
            obj, code = omissions.prepare_one(self.args(evaluated_against=ea)); self.assertEqual(code, 3, ea); self.assertFalse(obj["ok"]); self.assertIn("several streams", " ".join(obj["reasons"]))

    def pair_report(self, calls_log):
        """A retrospective ABSENCE-first pair about write pw1: the real calls live in `calls_log` (another session), the saved session is self.log."""
        import omissions
        vs = versions.versions_of(self.log, self.note)[0]; v = vs[0]; ref = versions.version_ref(v, "prefix")
        mat = omissions.material(self.text); passage = QUOTE; d = "Never deploy on friday"
        sc, ac = omissions.claims(d, "R04")
        t = Tx(self.d); t.cwd = self.d
        t.tool("a1", "mcp__jev__jev_verify", dict(claims=[ac], evidence=[dict(text=mat)]), json.dumps(dict(subject_at=0.5, results=[dict(claim=ac, verdict="unsupported", confidence=0.99, action="auto")])))
        t.tool("s1", "mcp__jev__jev_verify", dict(claims=[sc], evidence=[dict(text=passage)]), json.dumps(dict(subject_at=0.5, results=[dict(claim=sc, verdict="verified", confidence=0.99, action="auto", same_subject=0.9)])))
        for r in t.recs: r["sessionId"] = "calls-session"
        t.save(calls_log)
        checks = [dict(id="abs", tool="verify", verdict="unsupported", confidence=0.99, jev_ref=dict(tool_use_id="a1", result_index=0, key=ac), version_ref=ref),
                  dict(id="src", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="s1", result_index=0, key=sc), version_ref=ref)]
        f = dict(type="lost_detail", check_id="abs", claim=ac, confidence=0.99, quote_source=QUOTE, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=d, source_check_id="src"))
        return dict(session=dict(session_id="s1", jsonl=self.log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=checks, findings=[f], unresolved=[], status="FAIL")

    def test_the_control_pair_on_an_unmixed_note_is_confirmed(self):
        calls = os.path.join(self.d, "calls", "c.jsonl"); doc = report.bind_report(self.pair_report(calls), calls, self.d, (), True, self.note, None, "R04")
        self.assertEqual(doc["status"], "FAIL", doc["binding_summary"]["reasons"])

    def test_a_retrospective_pair_on_a_mixed_full_write_is_not_confirmed(self):
        import omissions
        self.child(("cw1", "CHILD\n")); omissions._MEMO.clear(); calls = os.path.join(self.d, "calls", "c.jsonl"); doc = report.bind_report(self.pair_report(calls), calls, self.d, (), True, self.note, None, "R04")
        self.assertNotEqual(doc["status"], "FAIL"); self.assertEqual(doc["status"], "UNRESOLVED")
        self.assertEqual(doc["binding_summary"]["version_identity"]["identity_ok"], 2)      # the bytes of the full Write are still checked (the retrospective identity holds)

    def test_a_retrospective_check_about_the_bytes_of_the_mixed_write_stays_valid(self):
        self.child(("cw1", "CHILD\n")); vs = versions.versions_of(self.log, self.note)[0]
        self.assertEqual(versions.validate_ref(versions.version_ref(vs[0], "prefix"), vs)[0], "ok")

if __name__ == "__main__": unittest.main()

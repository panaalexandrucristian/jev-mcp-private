#!/usr/bin/env python3
"""Offline test of the base of a dependent mutation (council fixes 7, 8 and 9; stdlib only, no Jev call, never reads .handoff-verify/):
 - fix 7: a complete Read refreshes the base only when its real USE and RESULT positions are both known and it lies strictly after the previous mutation's result and before the dependent mutation's tool_use;
   a Read without a use position, or one that started before a Write and ended after it, never replaces the Write's content; `versions_of`, `replay_all` and `prepare.py` agree and the earlier version stays;
 - fix 8: the OpenCode diagnostics (a successful mutation that could not be placed or attributed) are consumed by the common reconstruction: an Edit of an affected path (or of any path for a pathless
   diagnostic) is `content not recoverable` until a later full Write with a demonstrated order restores the path, a demonstrably unrelated path is untouched; the chain adapter -> versions / replay /
   prepare / report never certifies a base the diagnostic may have changed;
 - fix 9: a failed read/grep/glob that the metadata marks as truncated keeps BOTH facts, sanitised, in the stream and in the prepared material.
All fixtures are invented.
usage: python3 -B test_base_freshness.py [-v]"""
import contextlib, hashlib, io, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, prepare, report, slice as SL, versions
from test_stream_reconstruction import Tx, full, Base as CBase
from test_opencode_adapter import Base as OBase, T0, assistant, user, tool, jev_input, jev_json, CLAIM, results, uses
from test_opencode_diagnostics import untimed

def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

class Fresh(CBase):
    A, NEW, STALE = "alpha beta", "alpha NEW beta", "alpha beta"
    def agree(self, expected):
        vs = versions.versions_of(self.log, self.note)[0]; self.assertEqual([v["content"] for v in vs], expected)
        rep = versions.replay_all(self.log); self.assertEqual([rep[v["write_tool_use_id"]][0] for v in vs], expected)
        code, out, work = self.prepare(); rows = self.vrows(self.inventory(work)); self.assertEqual([r["sha256"] for r in rows], [sha(c) if c is not None else None for c in expected])

    def test_a_read_that_started_before_a_write_and_ended_after_it_is_not_a_base(self):
        t = Tx(self.d); t.write("w1", self.note, self.A)
        t.use("r1", "Read", dict(file_path=self.note)); t.use("w2", "Write", dict(file_path=self.note, content=self.NEW)); t.result("w2", "File updated"); t.result("r1", "cat -n", structured=full(self.note, self.STALE))
        t.edit("e1", self.note, "beta", "gamma"); t.save(self.log)
        self.agree([self.A, self.NEW, "alpha NEW gamma"])                                    # the Read's snapshot predates w2: it must not bring the old content back over it
        self.assertEqual(versions.versions_of(self.log, self.note)[0][0]["content"], self.A)   # the earlier version is unchanged

    def test_a_read_that_started_after_the_previous_result_is_still_a_base(self):
        t = Tx(self.d); t.write("w1", self.note, self.A); t.read("r1", self.note, "alpha external beta"); t.edit("e1", self.note, "beta", "gamma"); t.save(self.log)
        self.agree([self.A, "alpha external gamma"])

    def test_a_read_without_a_use_position_is_not_a_base(self):
        items = [dict(tool_use_id="w1", uuid="1", index=1, pos=1, result_pos=2, op="Write", content=self.A, success=True), dict(tool_use_id="e1", uuid="2", index=3, pos=5, result_pos=6, op="Edit", old_string="beta", new_string="gamma", replace_all=False, success=True)]
        rd = dict(index=2, path="/p", content="alpha external beta", complete=True)
        for r in (dict(rd, result_pos=4), dict(rd, pos=None, result_pos=4), dict(rd, pos="3", result_pos=4), dict(rd, pos=True, result_pos=4)):
            self.assertEqual([v["content"] for v in SL.reconstruct(items, [r])], [self.A, "alpha gamma"], r)
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=3, result_pos=4)])], [self.A, "alpha external gamma"])
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=2, result_pos=4)])], [self.A, "alpha gamma"])        # started at the previous result's position: not strictly after
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=1, result_pos=4)])], [self.A, "alpha gamma"])        # started before the previous mutation

class Diagnosed(OBase):
    A, D2 = "alpha beta", "different beta"
    def setUp(self):
        super().setUp(); self.sid = "ses_f8"
    def build(self, *blocks, extra_path=None):
        w1 = tool("w1", "write", dict(filePath=self.path(), content=self.A), T0 + 10, T0 + 12)
        return self.sel([user("Goal: ship it.", T0), assistant([w1], T0 + 9)] + [assistant(b, T0 + 30 + 10 * k) for k, b in enumerate(blocks)], sid=self.sid)
    def edit(self, tid="e1", at=40): return tool(tid, "edit", dict(filePath=self.path(), oldString="beta", newString="gamma"), T0 + at, T0 + at + 2)
    def blind(self, path=None, content=None, name="write", tid="w2"):
        inp = dict(filePath=path or self.path(), content=content or self.D2) if name == "write" else dict(path=path, content=content)
        return untimed(tool(tid, name, inp, T0 + 31, T0 + 32), None, T0 + 32)
    def prepare(self, sel):
        out = io.StringIO(); work = os.path.join(self.base, "work%d" % len(os.listdir(self.base))); old = sys.argv; sys.argv = ["prepare.py", sel, "--cwd", self.cwd, "--out", work]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        return code, json.load(open(os.path.join(work, "inventory.json")))

    def test_an_edit_after_a_completed_untimed_rewrite_is_not_reconstructed_from_the_older_base(self):
        sel = self.build([self.blind()], [self.edit()])
        vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["status"], v["content"]) for v in vs], [("w1", "ok", self.A), ("e1", "content not recoverable", None)]); self.assertIn("w2", vs[1]["reason"])
        self.assertEqual(vs[0]["unpositioned"], ["w2"]); self.assertEqual(vs[1]["unpositioned"], ["w2"])
        rep = versions.replay_all(sel); self.assertEqual(rep["w1"][0], self.A); self.assertEqual(rep["e1"], (None, None))
        code, inv = self.prepare(sel); rows = inv["handoffs"][0]["versions"]
        self.assertEqual([(r["tool_use_id"], r["status"], r["sha256"]) for r in rows], [("w1", "ok", sha(self.A)), ("e1", "content not recoverable", None)])

    def test_the_report_and_the_gate_never_certify_the_stale_base(self):
        sel = self.build([self.blind()], [self.edit()], [tool("j1", "jev:jev_verify", jev_input(), T0 + 60, T0 + 65, out=jev_json())])
        open(self.path(), "w").write("alpha gamma")
        v = versions.versions_of(sel, self.path())[0][0]
        chk = dict(id="p1", tool="verify", verdict="supported", confidence=0.99, jev_ref=dict(tool_use_id="j1", result_index=0, key=CLAIM), version_ref=versions.version_ref(v, "session_end"))
        d = dict(session=dict(session_id=self.sid, jsonl=sel, cwd=self.cwd), handoff=dict(path=self.path(), versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS")
        rd = os.path.join(self.base, "run"); os.makedirs(rd); md, js = report.write_report(rd, self.path(), d, "Stare: **PASS**\n", calls_jsonl=sel); doc = json.load(open(os.path.join(rd, js)))
        self.assertNotEqual(doc["status"], "PASS"); g = versions.gate(sel, self.path(), doc, disk_path=self.path())
        self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("not recoverable", " ".join(g["reasons"]))

    def test_an_unknown_impact_diagnostic_affects_every_path_and_a_unrelated_one_none(self):
        pathless = untimed(tool("w3", "write", dict(content=self.D2), T0 + 31, T0 + 32), None, None)
        sel = self.build([pathless], [self.edit()]); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([v["status"] for v in vs], ["ok", "content not recoverable"]); self.assertIn("w3", vs[1]["reason"])
        self.sid = "ses_f8b"
        sel2 = self.build([self.blind(path=os.path.join(self.cwd, "other.md"))], [self.edit()]); vs2 = versions.versions_of(sel2, self.path())[0]
        self.assertEqual([(v["status"], v["content"], v["unpositioned"]) for v in vs2], [("ok", self.A, []), ("ok", "alpha gamma", [])])      # demonstrably another path: untouched
        self.assertEqual(versions.replay_all(sel2)["e1"][0], "alpha gamma")

    def test_a_later_full_write_with_a_demonstrated_order_restores_the_dependent_edits(self):
        w3 = tool("w3", "write", dict(filePath=self.path(), content="restored beta"), T0 + 50, T0 + 52)
        sel = self.build([self.blind()], [self.edit("e1", 40)], [w3], [self.edit("e2", 60)])
        vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["status"], v["content"], v["unpositioned"]) for v in vs],
                         [("w1", "ok", self.A, ["w2"]), ("e1", "content not recoverable", None, ["w2"]), ("w3", "ok", "restored beta", []), ("e2", "ok", "restored gamma", [])])
        rep = versions.replay_all(sel); self.assertEqual((rep["e1"][0], rep["e2"][0]), (None, "restored gamma"))

    def test_a_failed_untimed_mutation_changes_nothing(self):
        failed = untimed(tool("w2", "write", dict(filePath=self.path(), content=self.D2), T0 + 31, status="error"), None, T0 + 32)
        sel = self.build([failed], [self.edit()]); self.assertEqual([(v["status"], v["content"]) for v in versions.versions_of(sel, self.path())[0]], [("ok", self.A), ("ok", "alpha gamma")])

class TruncatedErrors(OBase):
    SECRET = "sk-TESTFAKEFAKEFAKEFAKE12345678"
    def session(self, blocks, sid="ses_f9"): return self.sel([user("Goal: tidy the module.", T0), assistant(blocks, T0 + 1)], sid=sid)

    def test_an_errored_truncated_result_keeps_both_facts(self):
        blocks = [tool("r1", "read", dict(filePath=self.path("a.py")), T0 + 10, T0 + 11, status="error", metadata=dict(truncated=True)), tool("g1", "grep", dict(pattern="x"), T0 + 12, T0 + 13, status="error", metadata=dict(truncated=True)),
                  tool("l1", "glob", dict(pattern="*"), T0 + 14, T0 + 15, status="error", metadata=dict(truncated=False)), tool("r2", "read", dict(filePath=self.path("b.py")), T0 + 16, T0 + 17, status="error")]
        rs = results(self.recs(self.session(blocks)))
        for tid in ("r1", "g1"):
            c = rs[tid][0]; self.assertTrue(c["is_error"], tid); self.assertIn("boom", c["content"]); self.assertIn("truncated", c["content"]); self.assertTrue(c["content"].startswith("boom"))
        for tid in ("l1", "r2"): self.assertTrue(rs[tid][0]["is_error"]); self.assertEqual(rs[tid][0]["content"], "boom")
        ok = results(self.recs(self.session([tool("r3", "read", dict(filePath=self.path("c.py")), T0 + 10, T0 + 11, out="1: part", metadata=dict(truncated=True))], "ses_f9b")))
        self.assertIn("truncated", ok["r3"][0]["content"]); self.assertFalse(ok["r3"][0]["is_error"])

    def test_the_prepared_material_is_sanitised_and_keeps_the_marker(self):
        b = tool("r1", "read", dict(filePath=self.path("a.py")), T0 + 10, T0 + 11, status="error", metadata=dict(truncated=True)); b["state"]["error"]["message"] = "cannot read, token %s" % self.SECRET
        sel = self.session([b]); out = io.StringIO(); work = os.path.join(self.base, "work"); old = sys.argv; sys.argv = ["prepare.py", sel, "--cwd", self.cwd, "--out", work]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        text = "".join(open(os.path.join(work, "transcript", f), encoding="utf-8").read() for f in sorted(os.listdir(os.path.join(work, "transcript"))))
        self.assertEqual(code, 0); self.assertNotIn(self.SECRET, text); self.assertIn("[REDACTED:", text); self.assertIn("truncated", text); self.assertIn("tool_result ERROR", text)
        self.assertEqual(results(self.recs(sel))["r1"][0]["content"].count(self.SECRET), 0)

if __name__ == "__main__": unittest.main()

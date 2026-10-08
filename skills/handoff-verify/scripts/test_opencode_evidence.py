#!/usr/bin/env python3
"""Offline test of the OpenCode read/search evidence (item 16; stdlib only, no Jev call, never reads .handoff-verify/): a TIMED OpenCode `read` / `grep` / `glob` call (valid top-level tool times, no
fallback to the message time) is part of the normalized stream as an ordinary, sanitised `Read` / `Grep` / `Glob` tool_use + tool_result, with the recorded input, output, error flag and a truncation
marker from the recorded metadata. It is evidence only: no structured `toolUseResult` is fabricated, the adapter's per-path state and `discover.reads` / `slice.reconstruct` never take it as a base
(an Edit on an unknown base stays `content not recoverable`), Jev mapping and the other tools are unchanged. Invented fixtures.
usage: python3 -B test_opencode_evidence.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, omissions, slice as SL, versions
from test_opencode_adapter import Base, T0, assistant, user, tool, uses, results, iso

QUOTE = "The public API must not change"
SECRET = "sk-TESTFAKEFAKEFAKEFAKE12345678"

class Evidence(Base):
    def session(self, blocks, sid="ses_ev"): return self.sel([user("Goal: tidy the module.", T0), assistant(blocks, T0 + 1)], sid=sid)

    def test_a_read_grep_glob_only_session_keeps_chronological_evidence(self):
        sel = self.session([tool("g1", "grep", dict(pattern="api", path=self.cwd), T0 + 30, T0 + 31, out="a.py:1:api"), tool("r1", "read", dict(filePath=self.path("a.py")), T0 + 10, T0 + 12, out="1: x = 1"),
                            tool("l1", "glob", dict(pattern="*.py"), T0 + 20, T0 + 21, out="a.py")])
        recs = self.recs(sel); us = uses(recs); rs = results(recs)
        self.assertEqual([(c["id"], c["name"]) for c, _ in us], [("r1", "Read"), ("l1", "Glob"), ("g1", "Grep")])
        self.assertEqual([r["timestamp"] for _, r in us], [iso(T0 + 10), iso(T0 + 20), iso(T0 + 30)]); self.assertEqual(rs["r1"][1]["timestamp"], iso(T0 + 12))
        self.assertEqual(us[0][0]["input"]["file_path"], self.path("a.py")); self.assertEqual(us[2][0]["input"]["pattern"], "api")
        self.assertEqual((rs["r1"][0]["content"], rs["r1"][0]["is_error"], rs["g1"][0]["content"], rs["l1"][0]["content"]), ("1: x = 1", False, "a.py:1:api", "a.py"))
        for r in recs: self.assertNotIn("toolUseResult", r); self.assertNotIn("tool_use_result", r)

    def test_the_public_api_sentence_is_eligible_source_and_secrets_are_redacted(self):
        out = "NOTE: %s\nTOKEN = %s\n" % (QUOTE, SECRET)
        sel = self.session([tool("r1", "read", dict(filePath=self.path("DESIGN.md")), T0 + 10, T0 + 12, out=out)])
        recs = D.load_jsonl(sel); bl = omissions.eligible_blocks(recs, "/nope/HANDOFF.md")
        passage = omissions.passage_of(bl, QUOTE); self.assertIsNotNone(passage); self.assertNotIn(SECRET, passage); self.assertIn("[REDACTED:", passage)
        self.assertEqual(self.recs(sel)[2]["message"]["content"][0]["content"].count(SECRET), 0)

    def test_errors_and_truncation_are_marked_not_hidden(self):
        sel = self.session([tool("r1", "read", dict(filePath=self.path("a.py")), T0 + 10, T0 + 11, status="error"), tool("r2", "read", dict(filePath=self.path("b.py")), T0 + 12, T0 + 13, out="1: part", metadata=dict(truncated=True)),
                            tool("r3", "read", dict(filePath=self.path("c.py")), T0 + 14, T0 + 15, out="1: whole", metadata=dict(truncated=False))])
        rs = results(self.recs(sel)); self.assertTrue(rs["r1"][0]["is_error"]); self.assertIn("boom", rs["r1"][0]["content"])
        self.assertTrue(rs["r2"][0]["content"].startswith("1: part")); self.assertIn("truncated", rs["r2"][0]["content"][len("1: part"):]); self.assertFalse(rs["r2"][0]["is_error"])
        self.assertEqual(rs["r3"][0]["content"], "1: whole")

    def test_untimed_or_malformed_calls_are_not_placed_and_there_is_no_message_time_fallback(self):
        a = tool("a", "read", dict(filePath=self.path("a.py")), T0 + 10, T0 + 11); a["time"] = dict(completed=T0 + 11)        # no created
        b = tool("b", "grep", dict(pattern="x"), T0 + 12); b["time"] = dict(created=T0 + 12)                                  # no completed
        c = tool("c", "glob", dict(pattern="x"), T0 + 14, T0 + 13)                                                           # completed before created
        d = tool("d", "read", dict(filePath=self.path("d.py")), T0 + 16, T0 + 17, status="running")                           # not finished
        recs = self.recs(self.session([a, b, c, d])); self.assertEqual(uses(recs), []); self.assertEqual(results(recs), {})

    def test_other_tools_stay_out_of_the_stream(self):
        recs = self.recs(self.session([tool("w", "webfetch", dict(url="https://x.invalid"), T0 + 10, T0 + 11), tool("t", "todowrite", dict(todos=[]), T0 + 12, T0 + 13), tool("r1", "read", dict(filePath=self.path("a.py")), T0 + 14, T0 + 15)]))
        self.assertEqual([c["name"] for c, _ in uses(recs)], ["Read"])

    def test_evidence_is_never_a_base_and_an_unknown_base_edit_stays_unrecoverable(self):
        sel = self.session([tool("r1", "read", dict(filePath=self.path()), T0 + 10, T0 + 11, out="alpha beta"), tool("e1", "edit", dict(filePath=self.path(), oldString="beta", newString="gamma"), T0 + 20, T0 + 21)])
        self.assertEqual([r for r in D.reads(sel) if r["complete"] or r["content"] is not None], [])
        vs = versions.versions_of(sel, self.path())[0]; self.assertEqual([(v["status"], v["content"]) for v in vs], [("content not recoverable", None)]); self.assertIn("base", vs[0]["reason"])
        self.assertEqual(versions.replay_all(sel)["e1"], (None, None))
        read = [r for r in D.reads(sel)]; self.assertEqual(len(read), 1); self.assertFalse(read[0]["complete"])
        # a base recorded by a real write still works, and a read between the two does not replace it
        sel2 = self.session([tool("w1", "write", dict(filePath=self.path(), content="alpha beta"), T0 + 5, T0 + 6), tool("r1", "read", dict(filePath=self.path()), T0 + 10, T0 + 11, out="alpha EXTERNAL beta"),
                             tool("e1", "edit", dict(filePath=self.path(), oldString="beta", newString="gamma"), T0 + 20, T0 + 21)], sid="ses_ev2")
        self.assertEqual([v["content"] for v in versions.versions_of(sel2, self.path())[0]], ["alpha beta", "alpha gamma"])

if __name__ == "__main__": unittest.main()

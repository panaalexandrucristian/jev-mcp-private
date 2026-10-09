#!/usr/bin/env python3
"""Offline regressions of the identity protection of the SUCCESSFUL output of `scope.py prepare` (stdlib, no Jev call; the scope is extracted from invented transcripts by the real command): before readiness the source identity
(as given and canonical), the evaluation write id and the named or automatically selected run id are checked under the shared identity policy. An unsafe identity (a credential, a redaction marker, a path that holds one, also
behind a clean alias) makes the preparation not ready (exit 3, no payload, no evaluation, the value never echoed, no placeholder printed as the original identity); a clean identity, also a long recorded one, is printed exactly.
usage: python3 -B test_scope_identities.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import scope as SC
from test_obligation_ledger import Base, Tx, ENV, Q1, Q2, write
from test_identity_roles import BODY, LONG, C

DETAIL = "the billing migration ships on Friday"

class ScopeIdentities(Base):
    def scope(self, *args, log=None):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare", "--source", log or self.t.log, "--detail", DETAIL] + list(args), cwd=self.d, capture_output=True, text=True, env=ENV); return p.returncode, p.stdout

    def transcript(self, wid="w0", run=None):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note(wid)
        if run: self.t.tool(run, "Skill", dict(skill="jev:handoff-verify"), "loaded")
        self.t.save()

    def refused(self, c, out, *secrets):
        self.assertEqual(c, 3, out); o = json.loads(out); self.assertFalse(o["ok"]); self.assertNotIn("payloads", o); self.assertNotIn("evaluation", o); self.assertNotIn("scope_sha256", o)
        for s in secrets: self.assertNotIn(s, out)
        self.assertNotIn("REDACTED", json.dumps(o.get("source")))
        return o

class CleanIdentities(ScopeIdentities):
    def test_long_recorded_write_ids_are_printed_exactly(self):
        for tid in LONG:
            with self.subTest(tid=tid):
                self.setUp(); self.transcript(tid); c, out = self.scope("--write-id", tid, "--evaluated-against", "prefix"); o = json.loads(out); self.assertEqual(c, 0, out)
                self.assertEqual(o["evaluation"], dict(write_tool_use_id=tid, evaluated_against="prefix")); self.assertEqual(o["source"], self.t.log); self.tearDown()

    def test_long_recorded_run_ids_are_printed_exactly_selected_and_named(self):
        for tid in LONG:
            with self.subTest(tid=tid):
                self.setUp(); self.transcript("w0", tid)
                for extra in ((), ("--run", tid)):
                    c, out = self.scope("--write-id", "w0", "--evaluated-against", "session_end", *extra); o = json.loads(out); self.assertEqual(c, 0, out)
                    self.assertEqual(o["evaluation"], dict(write_tool_use_id="w0", evaluated_against="session_end", run=tid))
                self.tearDown()

    def test_short_ids_and_no_evaluation_are_unchanged(self):
        self.transcript("w0", "run1"); c, out = self.scope("--write-id", "w0", "--evaluated-against", "session_end"); o = json.loads(out); self.assertEqual((c, o["evaluation"]), (0, dict(write_tool_use_id="w0", evaluated_against="session_end", run="run1")))
        c, out = self.scope(); o = json.loads(out); self.assertEqual((c, o["evaluation"], o["source"]), (0, None, self.t.log))

class UnsafeIdentities(ScopeIdentities):
    UNSAFE = ["API_KEY=" + C, "sk-" + "A" * 24, "[REDACTED:openai_key]", "toolu_bdrk_[REDACTED:ambiguous]", "call_AKIA" + "IOSFODNN7EXAMPLE", "foo_" + BODY, "PASSWORD=" + C]

    def test_an_unsafe_write_id_is_not_ready(self):
        for tid in self.UNSAFE:
            with self.subTest(tid=tid):
                self.setUp(); self.transcript(tid); c, out = self.scope("--write-id", tid, "--evaluated-against", "prefix"); self.refused(c, out, tid, C); self.tearDown()

    def test_an_unsafe_write_id_that_is_not_in_the_transcript_is_not_ready_either(self):
        self.transcript("w0")
        for tid in self.UNSAFE: c, out = self.scope("--write-id", tid, "--evaluated-against", "prefix"); self.refused(c, out, tid, C)

    def test_an_unsafe_named_run_is_not_ready(self):
        for tid in self.UNSAFE:
            with self.subTest(tid=tid):
                self.setUp(); self.transcript("w0", tid); c, out = self.scope("--write-id", "w0", "--evaluated-against", "session_end", "--run", tid); self.refused(c, out, tid, C); self.tearDown()

    def test_an_unsafe_selected_run_is_not_ready(self):
        for tid in self.UNSAFE:
            with self.subTest(tid=tid):
                self.setUp(); self.transcript("w0", tid); c, out = self.scope("--write-id", "w0", "--evaluated-against", "session_end"); self.refused(c, out, tid, C); self.tearDown()

    def test_an_unsafe_source_path_is_not_ready(self):
        for name in ("PASSWORD=" + C, "API_KEY=" + C, "sk-" + "A" * 24):
            with self.subTest(name=name):
                self.setUp(); self.transcript(); d = os.path.join(self.d, name); os.makedirs(d); log = os.path.join(d, "session.jsonl"); write(log, open(self.t.log, encoding="utf-8").read())
                c, out = self.scope(log=log); self.refused(c, out, name, C); self.tearDown()

    def test_a_clean_alias_of_an_unsafe_path_is_not_ready(self):
        self.setUp(); self.transcript(); d = os.path.join(self.d, "API_KEY=" + C); os.makedirs(d); real = os.path.join(d, "session.jsonl"); write(real, open(self.t.log, encoding="utf-8").read())
        alias = os.path.join(self.d, "alias.jsonl"); os.symlink(real, alias)
        c, out = self.scope(log=alias); self.refused(c, out, C)

    def test_the_ambiguity_of_unsafe_runs_does_not_echo_them(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0")
        self.t.tool("run-API_KEY=" + C, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.user("next"); self.t.tool("run2", "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, out = self.scope("--write-id", "w0", "--evaluated-against", "session_end"); self.assertEqual(c, 3, out); self.assertNotIn(C, out)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline regressions of the output protection of the stage ids, the write / run ids and the scope diagnostics (stdlib, no Jev call; invented transcripts):
 - a tool_use id that holds a secret or a redaction marker is never stored in the ledger nor printed (`ledger record` refuses it); an UNSAFE id already in a ledger file makes the ledger refused (exit 3, nothing written
   over it, the value never echoed, no placeholder taken for the original id); clean ids are unchanged;
 - a recorded write id or a selected run id that needs redaction makes the omission preparation not ready (exit 3, nothing printed, the unavailable obligation kept by the ledger mechanism);
 - the failure diagnostics of `scope.py prepare` (an unreadable spec's file name included) are sanitized.
usage: python3 -B test_output_ids.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O
from test_obligation_ledger import Base, Tx, ENV, NOTE, Q1, Q2, run, write

C = "Zq" + "8f" + "Lm3" + "Xv9"

class StageIds(Base):
    def prepared(self):
        self.session("intro", Q1); c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); return self.doc()["obligations"][0]["id"]

    def no_canary(self, *outs):
        self.assertNotIn(C, open(self.ledger, encoding="utf-8").read())
        for o in outs: self.assertNotIn(C, o if isinstance(o, str) else json.dumps(o))

    def test_record_refuses_an_unsafe_id_and_stores_and_prints_nothing(self):
        oid = self.prepared(); before = open(self.ledger, encoding="utf-8").read()
        for tid in ("PASSWORD=" + C, "API_KEY=" + C, "sk-" + "A" * 24, "[REDACTED:openai_key]", "ghp_" + "B" * 24):
            c, out = self.record(oid, "absence", tid); self.assertEqual(c, 3, tid); self.assertFalse(json.loads(out)["ok"]); self.assertNotIn(tid, out); self.no_canary(out)
        self.assertEqual(open(self.ledger, encoding="utf-8").read(), before, "the ledger is not touched by a refused id")

    def test_clean_ids_are_unchanged(self):
        oid = self.prepared()
        for tid in ("c1", "toolu_01XmEHE1sGzkjq8MPLm3vrBc", "k-2"):
            c, out = self.record(oid, "absence", tid); self.assertEqual(c, 0, out)
        self.assertEqual([x["tool_use_id"] for x in self.doc()["obligations"][0]["stages"]["absence"]], ["c1", "toolu_01XmEHE1sGzkjq8MPLm3vrBc", "k-2"])

    def test_an_unsafe_existing_stage_id_refuses_the_ledger_without_echo(self):
        oid = self.prepared(); self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        d = self.doc(); d["obligations"][0]["stages"]["absence"][0]["tool_use_id"] = "API_KEY=" + C
        write(self.ledger, json.dumps(d, indent=1)); raw = open(self.ledger, encoding="utf-8").read()
        c, out = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual(c, 3); self.assertFalse(json.loads(out)["ok"]); self.assertNotIn(C, out)
        c, out = self.record(oid, "source", "c2"); self.assertEqual(c, 3); self.assertNotIn(C, out)
        args = ["prepare-batch", "--source", self.t.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", self.ledger]
        c, out = run(args, self.d, json.dumps([dict(detail=Q1, source_quote=Q1, write_id="w0", evaluated_against="prefix")])); self.assertEqual(c, 3); self.assertNotIn(C, out)
        self.assertEqual(open(self.ledger, encoding="utf-8").read(), raw, "nothing is written over it")
        with self.assertRaises(L.LedgerError) as cm: L.load(self.ledger)
        self.assertNotIn(C, str(cm.exception))

    def test_a_placeholder_is_never_taken_for_the_original_id(self):
        oid = self.prepared(); self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        d = self.doc(); d["obligations"][0]["stages"]["absence"][0]["tool_use_id"] = "[REDACTED:assignment]"
        write(self.ledger, json.dumps(d, indent=1))
        c, out = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual(c, 3, out)

class WriteAndRunIds(Base):
    def test_a_recorded_write_id_that_needs_redaction_is_not_ready(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("API_KEY=" + C); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="API_KEY=" + C))]); self.assertEqual(c, 3, outs); self.assertFalse(outs[0]["ok"]); self.assertNotIn(C, json.dumps(outs))
        raw = open(self.ledger, encoding="utf-8").read(); self.assertNotIn(C, raw)
        row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertTrue(row["reasons"]); self.assertTrue(row["args"]["withheld"])
        c, r = self.resume(); self.assertNotIn(C, json.dumps(r)); self.assertEqual(r["obligations"][0]["state"], "unavailable")

    def test_a_clean_write_id_is_unchanged(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("toolu_01XmEHE1sGzkjq8MPLm3vrBc"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="toolu_01XmEHE1sGzkjq8MPLm3vrBc"))]); self.assertEqual(c, 0, outs); self.assertEqual(outs[0]["version_ref"]["write_tool_use_id"], "toolu_01XmEHE1sGzkjq8MPLm3vrBc")
        self.assertNotIn("withheld", json.dumps(self.doc()))

    def test_a_selected_run_id_that_needs_redaction_is_not_ready(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.tool("run-API_KEY=" + C, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 3, outs); self.assertFalse(outs[0]["ok"]); self.assertNotIn(C, json.dumps(outs))
        self.assertNotIn(C, open(self.ledger, encoding="utf-8").read())
        row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertTrue(row["reasons"])
        c, r = self.resume(); self.assertNotIn(C, json.dumps(r)); self.assertEqual(r["obligations"][0]["state"], "unavailable")

    def test_a_named_run_id_that_needs_redaction_is_not_ready(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.tool("run-PASSWORD=" + C, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end", run="run-PASSWORD=" + C))]); self.assertEqual(c, 3, outs); self.assertNotIn(C, json.dumps(outs))
        raw = open(self.ledger, encoding="utf-8").read(); self.assertNotIn(C, raw)
        row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertIn("args.run", row["args"]["withheld"])

    def test_the_listed_runs_of_an_ambiguous_selection_are_sanitized(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0")
        self.t.tool("run-API_KEY=" + C, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.user("next"); self.t.tool("run2", "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 3, outs); self.assertNotIn(C, json.dumps(outs)); self.assertNotIn(C, open(self.ledger, encoding="utf-8").read())

    def test_a_clean_run_id_is_unchanged(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.tool("run1", "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); self.assertEqual(outs[0]["version_ref"]["run"], "run1")

class ScopeDiagnostics(Base):
    def scope(self, *args):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare"] + list(args), cwd=self.d, capture_output=True, text=True, env=ENV); return p.returncode, p.stdout

    def test_an_unreadable_spec_file_name_is_not_echoed(self):
        self.session("intro", Q1)
        c, out = self.scope("--source", self.t.log, "--spec", os.path.join(self.d, "missing", "PASSWORD=" + C + ".json")); self.assertEqual(c, 3, out); self.assertFalse(json.loads(out)["ok"]); self.assertNotIn(C, out)

    def test_the_other_failures_are_sanitized_too(self):
        self.session("intro", Q1)
        c, out = self.scope("--source", self.t.log, "--spec", self.d); self.assertEqual(c, 3, out); self.assertNotIn(C, out)
        c, out = self.scope("--source", self.t.log, "--detail", "API_KEY=" + C); self.assertEqual(c, 3, out); self.assertNotIn(C, out)
        c, out = self.scope("--source", self.t.log, "--detail", "a detail", "--write-id", "w0"); self.assertEqual(c, 3, out); self.assertNotIn(C, out)

    def test_a_clean_failure_is_unchanged(self):
        self.session("intro", Q1)
        c, out = self.scope("--source", self.t.log); self.assertEqual(c, 3); self.assertEqual(json.loads(out), dict(ok=False, reasons=["no detail given"]))
        c, out = self.scope("--source", self.t.log, "--spec", os.path.join(self.d, "missing.json")); self.assertEqual(c, 3)
        self.assertIn("missing.json", json.loads(out)["reasons"][0])

if __name__ == "__main__": unittest.main()

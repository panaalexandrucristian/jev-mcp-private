#!/usr/bin/env python3
"""Offline regressions of the council corrections to the obligation ledger, round 3 (stdlib, no Jev call; the calls are simulated in invented transcripts):
 - the ledger FILE obeys the shared secret policy as stdout does: a candidate whose location, source or note path (or alias) would need redaction is kept as an UNAVAILABLE row whose unsafe identity fields are
   WITHHELD (hash only, listed in `args.withheld`), never stored, never replayed, never echoed by a resume; clean rows are unchanged;
 - a recorded call (and its result) belongs to ONE evaluation: the same call recorded for different writes, modes or runs is never usable for them (also retrospectively, when the calls live in another transcript); obligations of the
   SAME evaluation still share it.
usage: python3 -B test_ledger_isolation.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O
from test_obligation_ledger import Base, Tx, write, run, NOTE, Q1, Q2

C = "Zq" + "8f" + "Lm3" + "Xv9"

class Withheld(Base):
    def assert_safe(self, *outs):
        raw = open(self.ledger, encoding="utf-8").read(); self.assertNotIn(C, raw)
        for o in outs: self.assertNotIn(C, json.dumps(o))
        c, r = self.resume(); self.assertNotIn(C, json.dumps(r)); return r

    def one_unavailable(self, outs):
        d = self.doc(); self.assertEqual(len(d["obligations"]), 1, "the rejected candidate is kept as a row")
        row = d["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertFalse(row["identity"]["available"]); self.assertTrue(row["args"]["withheld"]); self.assertTrue(row["reasons"])
        self.assertTrue(any("unreplayable" in x for x in row["reasons"]), row["reasons"]); self.assertIsNone(L.validate(d, self.ledger)); return row

    def test_a_rejected_location_is_withheld(self):
        self.session("intro", Q1)
        c, outs = self.batch([(Q1, {})], extra=["--location", "/invented/PASSWORD=" + C]); self.assertEqual(c, 3)
        row = self.one_unavailable(outs); self.assertEqual(row["args"]["withheld"], ["args.location[0]"]); self.assertTrue(row["args"]["location"][0].startswith("withheld:sha256:"))
        r = self.assert_safe(outs); o = r["obligations"][0]; self.assertEqual(o["state"], "unavailable"); self.assertTrue(any("unreplayable" in x for x in o["reasons"]))
        self.assertEqual(self.record(row["id"], "absence", "c1")[0], 3)

    def test_a_rejected_source_path_is_withheld(self):
        d = os.path.join(self.d, "PASSWORD=" + C); os.makedirs(d); self.t.log = os.path.join(d, "session.jsonl"); self.session("intro", Q1)
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 3)
        row = self.one_unavailable(outs); self.assertIn("args.source", row["args"]["withheld"]); self.assertIn("identity.source", row["args"]["withheld"]); self.assert_safe(outs)

    def test_a_rejected_note_path_and_alias_are_withheld(self):
        self.session("intro", Q1)
        alias = os.path.join(self.d, "API_KEY=%s.md" % C); os.symlink(self.t.note, alias)
        c, outs = self.batch([(Q1, dict(file=alias))]); self.assertEqual(c, 3)
        row = self.one_unavailable(outs); self.assertEqual(row["args"]["withheld"], ["args.file"]); self.assertEqual(row["identity"]["file"], os.path.realpath(self.t.note)); self.assert_safe(outs)

    def test_a_rejected_note_directory_is_withheld(self):
        d = os.path.join(self.d, "SECRET_TOKEN=" + C); os.makedirs(d); self.t.note = os.path.join(d, "HANDOFF.md"); write(self.t.note, NOTE); self.session("intro", Q1)
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 3)
        row = self.one_unavailable(outs); self.assertIn("identity.file", row["args"]["withheld"]); self.assert_safe(outs)

    def test_a_rejected_cwd_and_ids_are_withheld(self):
        self.session("intro", Q1)
        c, outs = self.batch([(Q1, dict(write_id="PASSWORD=" + C))], extra=[]); self.assertEqual(c, 3)
        row = self.one_unavailable(outs); self.assertIn("args.write_id", row["args"]["withheld"]); self.assert_safe(outs)

    def test_the_placeholder_is_never_a_path_and_never_restores_readiness(self):
        self.session("intro", Q1); self.batch([(Q1, {})], extra=["--location", "/invented/PASSWORD=" + C])
        d = self.doc(); row = d["obligations"][0]; self.assertNotEqual(row["args"]["location"], ["/invented"]); self.assertFalse(os.path.exists(row["args"]["location"][0]))
        d["obligations"][0]["state"] = "prepared"; d["obligations"][0]["identity"]["available"] = True
        with self.assertRaises(L.LedgerError): L.validate(d, "x")      # a withheld row is never prepared
        # a clean batch afterwards is a different row, prepared and ready, and the unavailable one is kept
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0); rows = self.doc()["obligations"]; self.assertEqual(sorted(r["state"] for r in rows), ["prepared", "unavailable"])

    def test_clean_rows_are_unchanged(self):
        self.session("intro", Q1); c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0)
        row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "prepared"); self.assertNotIn("withheld", row["args"]); self.assertEqual(row["args"]["file"], self.t.note)
        self.assertEqual(row["identity"]["file"], os.path.realpath(self.t.note)); self.assertNotIn("withheld", json.dumps(self.doc()))
        c, outs = self.batch([("a detail that is not in the transcript", {})]); self.assertEqual(c, 3)
        un = [r for r in self.doc()["obligations"] if r["state"] == "unavailable"][0]; self.assertNotIn("withheld", un["args"]); self.assertEqual(un["args"]["file"], self.t.note)

class Isolation(Base):
    """Retrospective (the calls live in another transcript): the window rule is not available, so one call must not serve two evaluations."""
    def calls_session(self, out, tid="k1"):
        t2 = Tx(self.d); t2.log = os.path.join(self.d, "calls.jsonl"); t2.user("verification"); t2.verify(tid, out["absence_claim"], out["material"]); t2.save(); return t2

    def stages(self, *extra):
        r = self.resume("--session", os.path.join(self.d, "calls.jsonl"), *extra)[1]; return r["obligations"]

    def test_one_result_does_not_serve_two_same_hash_writes(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.write_note("w1"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="w0")), (Q1, dict(write_id="w1"))]); self.assertEqual(c, 0, outs); self.calls_session(outs[0])
        rows = self.doc()["obligations"]
        for r in rows: self.record(r["id"], "absence", "k1")
        obl = self.stages()
        for o in obl:
            self.assertEqual(o["state"], "valid"); s = o["stages"][0]; self.assertEqual(s["state"], "stale", s); self.assertIn("different", s["reason"]); self.assertIsNone(s["observed"]); self.assertEqual(o["next"], "call_absence")
        self.assertEqual([x["tool_use_id"] for r in self.doc()["obligations"] for x in r["stages"]["absence"]], ["k1", "k1"])       # the history is kept

    def test_one_result_does_not_serve_two_modes_or_runs(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.save()
        c, outs = self.batch([(Q1, dict(evaluated_against="prefix")), (Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); self.calls_session(outs[0])
        for r in self.doc()["obligations"]: self.record(r["id"], "absence", "k1")
        self.assertEqual([o["stages"][0]["state"] for o in self.stages()], ["stale", "stale"])

    def test_a_single_evaluation_keeps_its_bound_call(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.save()
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); self.calls_session(outs[0]); self.record(self.doc()["obligations"][0]["id"], "absence", "k1")
        o = self.stages()[0]; self.assertEqual(o["stages"][0]["state"], "bound"); self.assertEqual(o["next"], "call_source")

    def test_obligations_of_the_same_evaluation_still_share_the_call(self):
        self.t.user("intro"); self.t.user(Q1 + " And more."); self.t.write_note("w0"); self.t.save()
        c, outs = self.batch([(Q1, dict(source_quote=Q1)), (Q1, dict(source_quote=Q1 + " And more."))]); self.assertEqual(c, 0, outs)
        self.assertEqual(len(self.doc()["obligations"]), 2); self.calls_session(outs[0])
        for r in self.doc()["obligations"]: self.record(r["id"], "absence", "k1")
        self.assertEqual([o["stages"][0]["state"] for o in self.stages()], ["bound", "bound"])

    def test_different_calls_for_different_writes_stay_bound(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.write_note("w1"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="w0")), (Q1, dict(write_id="w1"))]); self.assertEqual(c, 0, outs)
        t2 = Tx(self.d); t2.log = os.path.join(self.d, "calls.jsonl"); t2.user("verification"); t2.verify("k1", outs[0]["absence_claim"], outs[0]["material"]); t2.verify("k2", outs[1]["absence_claim"], outs[1]["material"]); t2.save()
        rows = self.doc()["obligations"]; self.record(rows[0]["id"], "absence", "k1"); self.record(rows[1]["id"], "absence", "k2")
        self.assertEqual([o["stages"][0]["state"] for o in self.stages()], ["bound", "bound"])

if __name__ == "__main__": unittest.main()

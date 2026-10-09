#!/usr/bin/env python3
"""Offline regressions of the retrospective call ownership of the obligation ledger (stdlib, no Jev call; the calls are simulated in invented transcripts): a recorded call (and its result) belongs to ONE evaluation, also
when the earlier row that recorded it became INVALIDATED. When the chronology does not demonstrate an exclusive owner (the calls live in another transcript), the retained recorded reference of the invalidated evaluation takes
part in the conflict detection: the call does not migrate to the newer write / evaluation, its progress stays stale (observed None, history kept) and yields no `no_source_call`. Chronology that does demonstrate the owner (the same
session: the call lies in the window of ONE write) and compatible same-evaluation sharing are unchanged.
usage: python3 -B test_ledger_history.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O
from test_obligation_ledger import Base, Tx, write, run, NOTE, Q1, Q2

class History(Base):
    """Row A is prepared for write w0 (session_end) before w1 (the SAME note bytes) exists; w1 and work between the writes change A's evaluated source (A is invalidated); row B is prepared for w1."""
    def first(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="w0", evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); return outs[0]

    def second(self):
        self.t.user("more work between the two writes"); self.t.write_note("w1"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="w1", evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); return outs[0]

    def calls_session(self, out, tid="k1", verdict="verified"):
        t2 = Tx(self.d); t2.log = os.path.join(self.d, "calls.jsonl"); t2.user("verification"); t2.verify(tid, out["absence_claim"], out["material"], verdict=verdict); t2.save()

    def resumed(self, *extra):
        c, r = self.resume(*extra); self.assertEqual(c, 0, r); return r["obligations"]

    def test_the_invalidated_rows_call_does_not_migrate_to_the_newer_write(self):
        out0 = self.first(); self.calls_session(out0); oid0 = self.doc()["obligations"][0]["id"]; self.assertEqual(self.record(oid0, "absence", "k1")[0], 0)
        out1 = self.second(); self.assertEqual(out0["absence_claim"], out1["absence_claim"]); self.assertEqual(out0["material"], out1["material"])       # identical canonical call input
        rows = self.doc()["obligations"]; self.assertEqual(len(rows), 2); self.assertEqual(self.record(rows[1]["id"], "absence", "k1")[0], 0)
        old, new = self.resumed("--session", os.path.join(self.d, "calls.jsonl"))
        self.assertEqual(old["state"], "invalidated"); self.assertEqual(new["state"], "valid")
        s = new["stages"][0]; self.assertEqual(s["state"], "stale", s); self.assertIsNone(s["observed"]); self.assertEqual(new["next"], "call_absence"); self.assertNotEqual(new["next"], "no_source_call")
        self.assertEqual([x["tool_use_id"] for r in self.doc()["obligations"] for x in r["stages"]["absence"]], ["k1", "k1"])       # the history is kept
        self.assertEqual(old["stages"][0]["state"], "stale")

    def test_the_older_rows_reference_is_enough_even_when_it_is_recorded_after_the_newer_one(self):
        out0 = self.first(); self.calls_session(out0); out1 = self.second()
        rows = self.doc()["obligations"]; self.record(rows[1]["id"], "absence", "k1"); self.record(rows[0]["id"], "absence", "k1")
        new = self.resumed("--session", os.path.join(self.d, "calls.jsonl"))[1]; self.assertEqual(new["stages"][0]["state"], "stale"); self.assertEqual(new["next"], "call_absence")

    def test_a_call_recorded_only_for_the_newer_write_stays_bound(self):
        out0 = self.first(); out1 = self.second(); self.calls_session(out1); self.record(self.doc()["obligations"][1]["id"], "absence", "k1")
        new = self.resumed("--session", os.path.join(self.d, "calls.jsonl"))[1]; self.assertEqual(new["stages"][0]["state"], "bound"); self.assertEqual(new["next"], "no_source_call")

    def test_a_distinct_call_for_the_newer_write_stays_bound(self):
        out0 = self.first(); self.calls_session(out0); self.record(self.doc()["obligations"][0]["id"], "absence", "k1"); out1 = self.second()
        t2 = Tx(self.d); t2.log = os.path.join(self.d, "calls.jsonl"); t2.user("verification"); t2.verify("k1", out0["absence_claim"], out0["material"], verdict="verified"); t2.verify("k2", out1["absence_claim"], out1["material"], verdict="verified"); t2.save()
        self.record(self.doc()["obligations"][1]["id"], "absence", "k2")
        old, new = self.resumed("--session", os.path.join(self.d, "calls.jsonl")); self.assertEqual(new["stages"][0]["state"], "bound"); self.assertEqual(new["next"], "no_source_call")

    def test_a_changed_evaluation_of_the_same_write_is_not_inherited_either(self):
        out0 = self.first(); self.calls_session(out0); self.record(self.doc()["obligations"][0]["id"], "absence", "k1")
        self.t.user("later work in the same window"); self.t.save()                      # the session_end evaluation of w0 grows: row A is invalidated, a new row is prepared for the same write
        c, outs = self.batch([(Q1, dict(write_id="w0", evaluated_against="session_end"))]); self.assertEqual(c, 0, outs)
        rows = self.doc()["obligations"]; self.assertEqual(len(rows), 2); self.record(rows[1]["id"], "absence", "k1")
        old, new = self.resumed("--session", os.path.join(self.d, "calls.jsonl")); self.assertEqual(old["state"], "invalidated"); self.assertEqual(new["stages"][0]["state"], "stale"); self.assertEqual(new["next"], "call_absence")

    def test_the_same_session_window_that_demonstrates_the_owner_is_unchanged(self):
        out0 = self.first(); self.record(self.doc()["obligations"][0]["id"], "absence", "k1")
        self.t.user("more work between the two writes"); self.t.write_note("w1"); self.t.verify("k1", out0["absence_claim"], out0["material"], verdict="verified"); self.t.save()   # the call lies in the window of w1 only
        c, outs = self.batch([(Q1, dict(write_id="w1", evaluated_against="session_end"))]); self.assertEqual(c, 0, outs)
        rows = self.doc()["obligations"]; self.assertEqual(len(rows), 2); self.record(rows[1]["id"], "absence", "k1")
        old, new = self.resumed(); self.assertEqual(old["state"], "invalidated"); self.assertEqual(new["state"], "valid")
        self.assertEqual(new["stages"][0]["state"], "bound", new["stages"][0]); self.assertEqual(new["next"], "no_source_call")

    def test_obligations_of_the_same_evaluation_still_share_the_call(self):
        self.t.user("intro"); self.t.user(Q1 + " And more."); self.t.write_note("w0"); self.t.save()
        c, outs = self.batch([(Q1, dict(source_quote=Q1)), (Q1, dict(source_quote=Q1 + " And more."))]); self.assertEqual(c, 0, outs); self.calls_session(outs[0], verdict="unsupported")
        for r in self.doc()["obligations"]: self.record(r["id"], "absence", "k1")
        self.assertEqual([o["stages"][0]["state"] for o in self.resumed("--session", os.path.join(self.d, "calls.jsonl"))], ["bound", "bound"])

if __name__ == "__main__": unittest.main()

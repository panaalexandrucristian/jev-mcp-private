#!/usr/bin/env python3
"""Offline test of the recording of the real call of a re-verification (stdlib only, no Jev call, no network, never reads the real .handoff-verify/): after the call, the authorized entry of the candidate registry moves to `recorded`
and carries the REAL reference of the call, copied from the session log (never invented); only the call made with exactly the authorized bytes can be recorded, once, under an exclusive lock; a recorded entry is never changed,
dropped or recorded again with another call; a registry that cannot prove its history records nothing. The registry is DERIVED from the session, never chosen.
usage: python3 -B test_evidence_record.py [-v]"""
import json, os, subprocess, sys, tempfile, textwrap, threading, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit, evidence, jevref
import test_retry_advice as T
import test_evidence_request as E
import test_evidence_authorize as AU

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
HASH_A, HASH_B = AU.HASH_A, AU.HASH_B

def ref(tid="c2"): return dict(tool_use_id=tid, result_index=None, key=None)

def recorded(i=0, h=HASH_A, tid="c2"): return dict(AU.entry(i, h), state="recorded", recorded_ref=ref(tid))

class Format(unittest.TestCase):
    def test_a_recorded_entry_carries_the_real_ref_and_an_authorized_one_does_not(self):
        self.assertTrue(audit._evidence_ok(recorded()))
        self.assertTrue(audit._evidence_ok(dict(recorded(), recorded_ref=dict(tool_use_id="c2", result_index=0, key="The claim 0."))))   # the ref of one result of the call is as good
        self.assertFalse(audit._evidence_ok(dict(AU.entry(), state="recorded")))                  # recorded without the ref of the call
        self.assertFalse(audit._evidence_ok(dict(AU.entry(), recorded_ref=ref())))                # authorized with a ref: the call does not exist yet
        self.assertFalse(audit._evidence_ok(dict(recorded(), recorded_ref=None)))
        self.assertFalse(audit._evidence_ok(dict(recorded(), recorded_ref=dict(tool_use_id="", result_index=None, key=None))))
        self.assertFalse(audit._evidence_ok(dict(recorded(), recorded_ref=dict(tool_use_id="c2", result_index=-1, key="k"))))
        self.assertFalse(audit._evidence_ok(dict(recorded(), extra=1)))

class Record(AU.Reg):
    def rec(self, e=None, tid="c2", h=None, path=None, src=None, r=None):
        e = e or AU.entry(); return audit.record_evidence(path or self.path, src or self.src, e["request_id"], h or e["input_hash"], r if r is not None else ref(tid))

    def test_the_real_call_moves_the_entry_to_recorded(self):
        self.reserve(AU.entry()); status, e = self.rec()
        self.assertEqual((status, e), ("recorded", recorded())); self.assertEqual(self.history(), [recorded()])

    def test_recording_the_same_call_again_changes_nothing(self):
        self.reserve(AU.entry()); self.rec(); status, e = self.rec()
        self.assertEqual(status, "already_recorded"); self.assertEqual(self.history(), [recorded()])

    def test_another_call_never_replaces_the_recorded_one(self):
        self.reserve(AU.entry()); self.rec(); status, e = self.rec(tid="c3")
        self.assertEqual(status, "recorded_elsewhere"); self.assertEqual(self.history(), [recorded()])

    def test_only_the_authorized_bytes_can_be_recorded(self):
        self.assertEqual(self.rec()[0], "not_authorized"); self.assertEqual(self.history(), [])             # nothing was reserved: an unauthorized call is not recorded
        self.reserve(AU.entry()); self.assertEqual(self.rec(h=HASH_B)[0], "input_mismatch"); self.assertEqual(self.history(), [AU.entry()])

    def test_a_malformed_ref_is_refused_before_anything_is_written(self):
        self.reserve(AU.entry())
        for bad in ({}, dict(tool_use_id="", result_index=None, key=None), dict(tool_use_id="c2", result_index=-1, key="k"), dict(tool_use_id="c2"), "c2", 7):
            self.assertEqual(self.rec(r=bad)[0], "invalid_ref", bad)
        self.assertEqual(self.history(), [AU.entry()])

    def test_a_registry_that_cannot_prove_its_history_records_nothing(self):
        missing = os.path.join(self.d, "none.json"); self.assertEqual(self.rec(path=missing)[0], "registry_missing"); self.assertFalse(os.path.exists(missing))
        bad = os.path.join(self.d, "bad.json"); open(bad, "w").close(); self.assertEqual(self.rec(path=bad)[0], "registry_unreadable")
        unbound = os.path.join(self.d, "unbound.json")
        with open(unbound, "w", encoding="utf-8") as f: json.dump(audit.empty_registry(), f)
        self.assertEqual(self.rec(path=unbound)[0], "registry_unbound")

    def test_a_foreign_registry_records_nothing(self):
        self.reserve(AU.entry()); self.assertEqual(self.rec(src=os.path.join(self.d, "other.jsonl"))[0], "foreign_registry"); self.assertEqual(self.history(), [AU.entry()])

    def test_a_recorded_request_stays_exhausted(self):
        self.reserve(AU.entry()); self.rec()
        for h in (HASH_A, HASH_B): self.assertEqual(self.reserve(AU.entry(h=h))[0], "exhausted")

    def test_six_racing_processes_record_exactly_one_call(self):
        self.reserve(AU.entry())
        code = textwrap.dedent("""
            import sys; sys.path.insert(0, %r)
            import audit
            e = audit.evidence_request_id(%r)
            print(audit.record_evidence(%r, %r, e, %r, dict(tool_use_id="call" + sys.argv[1], result_index=None, key=None))[0])""") % (HERE, AU.target(), self.path, self.src, HASH_A)
        procs = [subprocess.Popen([sys.executable, "-B", "-c", code, str(k)], stdout=subprocess.PIPE, text=True, env=ENV) for k in range(6)]
        res = sorted(p.communicate()[0].strip() for p in procs)
        self.assertEqual(res, ["recorded"] + ["recorded_elsewhere"] * 5); self.assertEqual(len(self.history()), 1); self.assertEqual(self.history()[0]["state"], "recorded")

    def test_a_crash_while_writing_leaves_the_authorization_whole(self):
        self.reserve(AU.entry())
        with mock.patch("os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError): self.rec()
        self.assertEqual(self.history(), [AU.entry()]); self.assertEqual(self.rec()[0], "recorded")

class Save(AU.Reg):
    def put(self, history):
        doc = audit.load_registry(self.path)[0]; doc["evidence_history"] = history; audit.save_registry(self.path, doc)
    def test_a_save_may_move_authorized_to_recorded_with_its_ref_and_nothing_more(self):
        self.reserve(AU.entry()); self.put([recorded()]); self.assertEqual(self.history(), [recorded()])
        self.reserve(AU.entry(1)); self.assertEqual(len(self.history()), 2)

    def test_a_save_refuses_the_move_when_anything_else_changed(self):
        self.reserve(AU.entry())
        for bad in (dict(recorded(), input_hash=HASH_B), dict(recorded(), target=AU.target(5)), dict(AU.entry(), state="recorded")):
            with self.assertRaises(ValueError): self.put([bad])
        self.assertEqual(self.history(), [AU.entry()])

    def test_a_recorded_ref_cannot_be_changed_or_dropped(self):
        self.reserve(AU.entry()); self.put([recorded()])
        with self.assertRaises(ValueError): self.put([recorded(tid="c9")])
        with self.assertRaises(ValueError): self.put([])
        with self.assertRaises(ValueError): self.put([AU.entry()])                                   # nor moved back
        self.assertEqual(self.history(), [recorded()])

    def test_the_merge_of_representations_keeps_the_most_advanced_state_and_refuses_two_refs(self):
        a = dict(audit.empty_registry(self.src), evidence_history=[AU.entry()]); b = dict(audit.empty_registry(self.src), evidence_history=[recorded()])
        merged, why = audit.merge_registries([a, b], self.src); self.assertIsNone(why); self.assertEqual(merged["evidence_history"], [recorded()])
        merged, why = audit.merge_registries([b, a], self.src); self.assertIsNone(why); self.assertEqual(merged["evidence_history"], [recorded()])
        c = dict(audit.empty_registry(self.src), evidence_history=[recorded(tid="c9")])
        merged, why = audit.merge_registries([b, c], self.src); self.assertIsNone(merged); self.assertIn("different", why)

class Session(AU.Session):
    """The session of the authorization tests plus the call the authorization allowed: exactly the authorized payload, made with the id `c2`."""
    def setUp(self):
        super().setUp()
        rec2, _ = T.call([E.SHORT], evidence=self.payload["evidence"], tid="c2")
        with open(self.log, "a", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec2))
        self.calls = jevref.load_calls(self.log); self.second = next(c for c in self.calls if c["tool_use_id"] == "c2")
    def record(self, call=None, rid=None): return evidence.record(rid or self.req["request_id"], call or self.second, self.log)

class RecordCall(Session):
    def test_the_call_made_with_the_authorized_bytes_is_recorded_with_its_real_ref(self):
        self.assertEqual(self.second["input_hash"], jevref.input_hash(self.payload))
        self.authorize(); r = self.record()
        self.assertEqual((r["recorded"], r["status"], r["recorded_ref"], r["request_id"]), (True, "recorded", ref("c2"), self.req["request_id"]))
        self.assertEqual(self.history(), [dict(request_id=self.req["request_id"], target=self.req["target"], input_hash=self.second["input_hash"], state="recorded", recorded_ref=ref("c2"))])
        again = self.record(); self.assertEqual((again["recorded"], again["status"]), (True, "already_recorded"))

    def test_a_call_with_other_bytes_is_not_recorded(self):
        self.authorize(); first = next(c for c in self.calls if c["tool_use_id"] == "c1")
        r = self.record(first); self.assertEqual((r["recorded"], r["status"], r["recorded_ref"]), (False, "input_mismatch", None)); self.assertEqual(self.history()[0]["state"], "authorized")

    def test_a_call_without_an_authorization_is_not_recorded(self):
        r = self.record(); self.assertEqual((r["recorded"], r["status"]), (False, "not_authorized")); self.assertEqual(self.history(), [])

    def test_only_a_verification_call_can_be_recorded(self):
        self.authorize(); r = self.record(dict(self.second, tool="classify"))
        self.assertEqual((r["recorded"], r["reason"]), (False, "not_a_verification_call")); self.assertEqual(self.history()[0]["state"], "authorized")

    def test_a_session_without_a_registry_location_records_nothing(self):
        self.authorize(); other = os.path.join(self.d, "elsewhere.jsonl")
        with open(other, "w", encoding="utf-8") as f: f.write(json.dumps(dict(type="user", message=dict(role="user", content="no cwd here"))) + "\n")
        r = evidence.record(self.req["request_id"], self.second, other); self.assertEqual((r["recorded"], r["reason"]), (False, "registry_unlocatable"))

class Cli(Session):
    def run_cli(self, *args, rc=0):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "record", *args], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, rc, p.stderr + p.stdout); return json.loads(p.stdout) if p.stdout.strip() else None
    def base(self, tid="c2", rid=None): return ["--session", self.log, "--request-id", rid or self.req["request_id"], "--tool-use-id", tid]

    def test_record_through_the_cli(self):
        self.authorize(); r = self.run_cli(*self.base()); self.assertEqual((r["recorded"], r["status"], r["recorded_ref"]), (True, "recorded", ref("c2")))
        self.assertEqual(self.history()[0]["state"], "recorded")

    def test_a_refusal_exits_with_one(self):
        self.authorize(); r = self.run_cli(*self.base("c1"), rc=1); self.assertEqual((r["recorded"], r["status"]), (False, "input_mismatch"))
        r = self.run_cli(*self.base(rid="0" * 16), rc=1); self.assertEqual((r["recorded"], r["status"]), (False, "not_authorized"))

    def test_an_unknown_call_and_a_missing_session_are_errors(self):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "record", *self.base("nope")], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2); self.assertIn("error", json.loads(p.stdout))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "record", "--session", os.path.join(self.d, "none.jsonl"), "--request-id", "0" * 16, "--tool-use-id", "c2"], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2); self.assertIn("error", json.loads(p.stdout))

    def test_the_registry_cannot_be_chosen_on_the_command_line(self):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "record", *self.base(), "--registry", self.reg], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2); self.assertIn("unrecognized arguments", p.stderr)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the authorization of the single re-verification (stdlib only, no Jev call, no network, never reads the real .handoff-verify/): the limit is reserved in the candidate registry BEFORE the call, atomically
(an exclusive lock plus an atomic replace), once per request; the authorization fixes the exact input hash (the hash of the exact tool input, as the recorded call will carry) and the version of the note; changed
bytes never get the same authorization silently; a crash never gives the allowance back; a registry that is missing, unreadable, foreign or unbound refuses a new allowance. The registry is DERIVED from the session,
never chosen. Recording the real call and the audit come later.
usage: python3 -B test_evidence_authorize.py [-v]"""
import json, os, subprocess, sys, tempfile, textwrap, threading, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit, discover, evidence, jevref
import test_retry_advice as T
import test_evidence_request as E
import test_evidence_collect as C

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
VREF = C.VREF
HASH_A, HASH_B = "a" * 64, "b" * 64

def target(i=0): return dict(jev_ref=dict(tool_use_id="toolu_jev_%d" % i, result_index=0, key="The claim %d." % i), version_ref=VREF, stage="verify")

def entry(i=0, h=HASH_A, state="authorized"):
    t = target(i); return dict(request_id=audit.evidence_request_id(t), target=t, input_hash=h, state=state)

class Reg(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.path = os.path.join(self.d, "reg", "audit-registry-test.json")
        self.src = os.path.join(self.d, "source.jsonl"); audit.ensure_registry(self.path, self.src)
    def tearDown(self): self.t.cleanup()
    def reserve(self, e, path=None, src=None): return audit.reserve_evidence(path or self.path, src or self.src, e["request_id"], e["target"], e["input_hash"])
    def history(self): return audit.load_registry(self.path)[0]["evidence_history"]

class Reserve(Reg):
    def test_the_first_reservation_records_an_authorized_entry(self):
        status, e = self.reserve(entry()); self.assertEqual((status, e), ("reserved", entry()))
        self.assertEqual(self.history(), [entry()])

    def test_the_same_input_again_is_the_same_authorization_not_a_second_allowance(self):
        self.reserve(entry()); status, e = self.reserve(entry()); self.assertEqual(status, "already_authorized"); self.assertEqual(self.history(), [entry()])

    def test_changed_bytes_never_get_the_same_authorization(self):
        self.reserve(entry()); status, e = self.reserve(entry(h=HASH_B)); self.assertEqual(status, "input_changed"); self.assertEqual(self.history(), [entry()])

    def test_a_recorded_request_is_exhausted(self):
        self.reserve(entry()); doc = audit.load_registry(self.path)[0]; doc["evidence_history"][0].update(state="recorded", recorded_ref=dict(tool_use_id="c2", result_index=None, key=None)); audit.save_registry(self.path, doc)
        for h in (HASH_A, HASH_B): self.assertEqual(self.reserve(entry(h=h))[0], "exhausted")

    def test_other_requests_are_independent(self):
        self.reserve(entry(0)); self.assertEqual(self.reserve(entry(1))[0], "reserved"); self.assertEqual(len(self.history()), 2)

    def test_a_registry_that_cannot_prove_its_history_refuses_a_new_allowance(self):
        missing = os.path.join(self.d, "none.json"); self.assertEqual(self.reserve(entry(), path=missing)[0], "registry_missing"); self.assertFalse(os.path.exists(missing))
        bad = os.path.join(self.d, "bad.json"); open(bad, "w").close()
        self.assertEqual(self.reserve(entry(), path=bad)[0], "registry_unreadable")
        self.assertEqual(self.reserve(entry(), src=os.path.join(self.d, "other.jsonl"))[0], "foreign_registry")
        unbound = os.path.join(self.d, "unbound.json")
        with open(unbound, "w", encoding="utf-8") as f: json.dump(audit.empty_registry(), f)
        self.assertEqual(self.reserve(entry(), path=unbound)[0], "registry_unbound")
        self.assertEqual(self.history(), [])

    def test_an_invalid_entry_is_refused_before_anything_is_written(self):
        e = entry(); e["request_id"] = "0" * 16
        self.assertEqual(self.reserve(e)[0], "invalid_entry"); self.assertEqual(self.history(), [])
        self.assertEqual(self.reserve(dict(entry(), input_hash="short"))[0], "invalid_entry")

    def test_eight_racing_reservations_give_exactly_one_allowance(self):
        out, gate = [], threading.Barrier(8)
        def go(k):
            gate.wait(); out.append(self.reserve(entry(h=("%x" % k) * 64 if k < 10 else HASH_A))[0])
        ts = [threading.Thread(target=go, args=(k,)) for k in range(8)]
        for t in ts: t.start()
        for t in ts: t.join()
        self.assertEqual(sorted(out), ["input_changed"] * 7 + ["reserved"]); self.assertEqual(len(self.history()), 1)

    def test_racing_processes_give_exactly_one_allowance(self):
        code = textwrap.dedent("""
            import sys; sys.path.insert(0, %r)
            import audit
            e = audit.evidence_request_id(%r)
            print(audit.reserve_evidence(%r, %r, e, %r, sys.argv[1] * 64)[0])""") % (HERE, target(), self.path, self.src, target())
        procs = [subprocess.Popen([sys.executable, "-B", "-c", code, "%x" % k], stdout=subprocess.PIPE, text=True, env=ENV) for k in range(6)]
        res = sorted(p.communicate()[0].strip() for p in procs)
        self.assertEqual(res, ["input_changed"] * 5 + ["reserved"]); self.assertEqual(len(self.history()), 1)

    def test_a_crash_while_writing_leaves_the_registry_whole_and_a_later_reservation_works(self):
        with mock.patch("os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError): self.reserve(entry())
        self.assertEqual(self.history(), []); self.assertEqual([n for n in os.listdir(os.path.dirname(self.path)) if n.startswith(".audit-registry-")], [])
        self.assertEqual(self.reserve(entry())[0], "reserved")

    def test_a_crash_after_the_reservation_does_not_give_the_allowance_back(self):
        self.assertEqual(self.reserve(entry())[0], "reserved")          # the process "dies" here: nothing in the code can release the entry
        self.assertEqual(self.reserve(entry(h=HASH_B))[0], "input_changed")
        doc = audit.load_registry(self.path)[0]; doc["evidence_history"] = []
        with self.assertRaises(ValueError): audit.save_registry(self.path, doc)              # and the registry refuses to drop it

class Session(unittest.TestCase):
    """A session log with a recorded cwd (so that its registry can be derived), one failed verify call and a prepared registry."""
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        rec, self.call = T.call([E.SHORT])
        for r in rec: r["cwd"] = self.d
        self.log = os.path.join(self.d, "s.jsonl")
        with open(self.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
        self.reg = audit.registry_path_of(self.log); audit.ensure_registry(self.reg, discover.canon(self.log))
        self.req = advice.session_advice([self.call], version_ref=VREF)[0]["advice"]["evidence_request"]
        self.new = self.write("run.log", C.NEW_PASSAGE + "\n")
        self.props = [dict(kind="local_file", path=self.new)]
        self.payload = dict(claims=[E.SHORT[0]], evidence=[T.EVIDENCE, C.NEW_PASSAGE])
    def tearDown(self): self.t.cleanup()
    def write(self, name, text):
        p = os.path.join(self.d, "files", name); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f: f.write(text)
        return p
    def authorize(self, payload=None, props=None, req=None):
        return evidence.authorize(req or self.req, self.call, self.props if props is None else props, self.payload if payload is None else payload, self.log)
    def history(self): return audit.load_registry(self.reg)[0]["evidence_history"]

class Authorize(Session):
    def test_an_authorization_binds_the_exact_input_and_the_version(self):
        r = self.authorize()
        self.assertEqual((r["authorized"], r["status"], r["request_id"], r["input_hash"]), (True, "reserved", self.req["request_id"], jevref.input_hash(self.payload)))
        self.assertEqual(self.history(), [dict(request_id=self.req["request_id"], target=self.req["target"], input_hash=jevref.input_hash(self.payload), state="authorized")])
        self.assertEqual(self.history()[0]["target"]["version_ref"], VREF)

    def test_the_same_input_again_is_not_a_second_allowance_and_other_bytes_are_refused(self):
        self.authorize(); again = self.authorize(); self.assertEqual((again["authorized"], again["status"]), (True, "already_authorized"))
        other = self.authorize(payload=dict(self.payload, evidence=self.payload["evidence"] + ["extra"]))
        self.assertEqual((other["authorized"], other["status"]), (False, "input_changed")); self.assertEqual(len(self.history()), 1)

    def refused(self, why, **kw):
        r = self.authorize(**kw); self.assertEqual((r["authorized"], r["reason"]), (False, why), r); self.assertEqual(self.history(), []); return r

    def test_the_payload_must_keep_the_original_evidence_and_add_the_new(self):
        self.refused("original_evidence_dropped", payload=dict(self.payload, evidence=[C.NEW_PASSAGE]))             # dropping contrary proof is not new evidence
        self.refused("new_evidence_missing_in_payload", payload=dict(self.payload, evidence=[T.EVIDENCE, "something else entirely"]))
        self.refused("claim_missing_in_payload", payload=dict(self.payload, claims=["Another claim altogether."]))
        self.refused("claims_malformed", payload=dict(self.payload, claims=[]))
        self.refused("payload_not_object", payload=["x"])

    def test_whitespace_and_case_do_not_hide_a_dropped_original_but_do_not_make_it_missing_either(self):
        r = self.authorize(payload=dict(self.payload, evidence=[T.EVIDENCE.upper().replace("\n", "\n  "), C.NEW_PASSAGE]))
        self.assertTrue(r["authorized"], r)

    def test_a_secret_in_the_payload_is_refused_and_never_echoed(self):
        r = self.refused("payload_redaction_dependent", payload=dict(self.payload, evidence=self.payload["evidence"] + [C.SECRET_LINE]))
        self.assertNotIn("abcdefgh12345678", json.dumps(r))

    def test_a_request_is_authorized_only_when_ready_and_bound_to_a_version(self):
        r = self.refused("not_ready", props=[]); self.assertEqual(r["state"], "ask_user")
        unbound = advice.session_advice([self.call])[0]["advice"]["evidence_request"]
        self.refused("version_unbound", req=unbound)
        blocked = E.request_of(("HEAD is 54edd39.", "verified", 0.99, "auto", None), version_ref=VREF)
        r = evidence.authorize(blocked, self.call, self.props, self.payload, self.log); self.assertEqual((r["authorized"], r["reason"]), (False, "not_ready"))

    def test_changed_bytes_after_the_plan_are_not_silently_authorized(self):
        with open(self.new, "w", encoding="utf-8") as f: f.write("a different new line about the report\n")
        self.refused("new_evidence_missing_in_payload")

    def test_a_used_up_request_is_exhausted(self):
        self.authorize(); doc = audit.load_registry(self.reg)[0]; doc["evidence_history"][0].update(state="recorded", recorded_ref=dict(tool_use_id="c2", result_index=None, key=None)); audit.save_registry(self.reg, doc)
        r = self.authorize(); self.assertEqual((r["authorized"], r["status"]), (False, "exhausted"))

    def test_a_registry_that_is_missing_or_unreadable_refuses_a_new_allowance(self):
        os.unlink(self.reg); r = self.authorize(); self.assertEqual((r["authorized"], r["reason"]), (False, "registry_missing"))
        with open(self.reg, "w", encoding="utf-8") as f: f.write("{broken")
        r = self.authorize(); self.assertEqual((r["authorized"], r["reason"]), (False, "registry_unreadable"))

    def test_a_corrected_claim_needs_a_payload_that_carries_exactly_it(self):
        c = E.request_of(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9), version_ref=VREF)
        _, call = T.call([("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9)])
        fix = [dict(kind="corrected_claim", text="HEAD is 54edd39.")]
        bad = evidence.authorize(c, call, fix, dict(claims=["HEAD is 0000000."], evidence=[T.EVIDENCE]), self.log)
        self.assertEqual((bad["authorized"], bad["reason"]), (False, "claim_missing_in_payload"))
        ok = evidence.authorize(c, call, fix, dict(claims=["HEAD is 54edd39."], evidence=[T.EVIDENCE]), self.log)
        self.assertEqual((ok["authorized"], ok["status"]), (True, "reserved"))

    def test_the_preflight_matches_the_authorized_bytes_only(self):
        self.assertEqual(evidence.check_authorization(self.req, self.payload, self.log), (False, "not_authorized"))
        self.authorize()
        self.assertEqual(evidence.check_authorization(self.req, self.payload, self.log), (True, None))
        self.assertEqual(evidence.check_authorization(self.req, dict(self.payload, claims=["x"]), self.log), (False, "input_changed"))
        doc = audit.load_registry(self.reg)[0]; doc["evidence_history"][0].update(state="recorded", recorded_ref=dict(tool_use_id="c2", result_index=None, key=None)); audit.save_registry(self.reg, doc)
        self.assertEqual(evidence.check_authorization(self.req, self.payload, self.log), (False, "already_used"))

class Cli(Session):
    def run_cli(self, *args, rc=0):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), *args], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, rc, p.stderr + p.stdout); return json.loads(p.stdout) if p.stdout.strip() else None
    def files(self):
        out = {}
        for name, body in (("vr.json", VREF), ("props.json", dict(proposals=self.props)), ("payload.json", self.payload)):
            out[name] = os.path.join(self.d, name)
            with open(out[name], "w", encoding="utf-8") as f: json.dump(body, f)
        return out
    def args(self, f, *extra): return ["--session", self.log, "--version-ref-file", f["vr.json"], "--request-id", self.req["request_id"], "--payload", f["payload.json"], *extra]

    def test_authorize_then_preflight_through_the_cli(self):
        f = self.files()
        r = self.run_cli("authorize", *self.args(f, "--proposals", f["props.json"]))
        self.assertEqual((r["authorized"], r["status"]), (True, "reserved"))
        self.assertEqual(self.run_cli("check", *self.args(f))["authorized"], True)
        self.assertEqual(len(self.history()), 1)

    def test_a_refusal_exits_with_one(self):
        f = self.files(); os.unlink(self.reg)
        r = self.run_cli("authorize", *self.args(f, "--proposals", f["props.json"]), rc=1); self.assertEqual((r["authorized"], r["reason"]), (False, "registry_missing"))
        self.assertEqual(self.run_cli("check", *self.args(f), rc=1)["authorized"], False)

    def test_the_registry_cannot_be_chosen_on_the_command_line(self):
        f = self.files(); p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "authorize", *self.args(f), "--registry", self.reg], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2); self.assertIn("unrecognized arguments", p.stderr)

    def test_an_unknown_request_id_and_bad_files_are_errors(self):
        f = self.files()
        for extra in (["--request-id", "0" * 16], ["--payload", os.path.join(self.d, "missing.json")]):
            args = self.args(f); i = args.index(extra[0]); args[i + 1] = extra[1]
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "authorize", *args], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 2, extra); self.assertIn("error", json.loads(p.stdout))

if __name__ == "__main__": unittest.main()

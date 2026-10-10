#!/usr/bin/env python3
"""Offline test of the audit of the re-verifications (stdlib only, no Jev call, no network, never reads the real .handoff-verify/): a verify / gate call that REPEATS an earlier call for the same claim and the same version of the
note is allowed only when the registry of the session holds a RECORDED authorization for exactly that call (the real tool_use_id and the authorized bytes). A repeat without it is exposed by the audit as a protocol violation
(`unfinished.reverifications`, one reason each) and a PASS cannot survive it; a FAIL keeps its precedence. An authorization that was only reserved, other bytes, another call, another claim, another version or a lost registry
authorize nothing. What it cannot see is stated: an earlier attempt that no check cites, and a corrected claim (another text) are not repeats of a claim.
usage: python3 -B test_reverification_audit.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, discover, jevref, report
import contract_fixtures as CF
import test_doc_end_to_end as E2E

H1, H2, H3 = "1" * 64, "2" * 64, "3" * 64
V1 = dict(ok=True, write_tool_use_id="w1", sha256="a" * 64, evaluated_against="prefix", run=None)
V2 = dict(V1, write_tool_use_id="w2", sha256="b" * 64)
CLAIM = "The latest commit is e41a9c2 (migrate billing to duckdb)"
VREF = dict(write_tool_use_id="w1", sha256="a" * 64, evaluated_against="prefix")

def binding(tid, claim=CLAIM, version=V1, tool="verify", bound=True): return dict(bound=bound, tool=tool, tool_use_id=tid, claim_key=claim, version=version)
def call(tid, seq, h, is_error=False): return dict(tool_use_id=tid, seq=seq, input_hash=h, is_error=is_error)
def rec(tid, h, rid_target=None):
    t = rid_target or dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=VREF, stage="verify")
    return dict(request_id=A.evidence_request_id(t), target=t, input_hash=h, state="recorded", recorded_ref=dict(tool_use_id=tid, result_index=None, key=None))
def auth(h):
    e = rec("c2", h); return dict(request_id=e["request_id"], target=e["target"], input_hash=h, state="authorized")

class Repeats(unittest.TestCase):
    def found(self, bindings, calls, history=(), versioned=True): return A.unauthorized_repeats(bindings, calls, list(history), versioned)

    def test_one_call_per_claim_is_not_a_repeat(self):
        self.assertEqual(self.found([binding("c1")], [call("c1", 0, H1)]), [])
        self.assertEqual(self.found([binding("c1"), binding("c2", claim="Another claim.")], [call("c1", 0, H1), call("c2", 1, H2)]), [])

    def test_the_second_call_for_the_same_claim_and_version_without_a_record_is_exposed(self):
        r = self.found([binding("c1"), binding("c2")], [call("c1", 0, H1), call("c2", 1, H2)])
        self.assertEqual([(x["tool_use_id"], x["first_tool_use_id"], x["claim"]) for x in r], [("c2", "c1", CLAIM)]); self.assertIn("write w1", r[0]["version"])

    def test_the_first_call_by_position_is_the_original_whatever_the_order_of_the_checks(self):
        r = self.found([binding("c2"), binding("c1")], [call("c1", 0, H1), call("c2", 1, H2)]); self.assertEqual([x["tool_use_id"] for x in r], ["c2"])

    def test_a_recorded_authorization_for_exactly_that_call_allows_it(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2)]; b = [binding("c1"), binding("c2")]
        self.assertEqual(self.found(b, calls, [rec("c2", H2)]), [])
        self.assertEqual(len(self.found(b, calls, [rec("c2", H3)])), 1)                  # other bytes than the authorized ones
        self.assertEqual(len(self.found(b, calls, [rec("c9", H2)])), 1)                  # the record belongs to another call
        self.assertEqual(len(self.found(b, calls, [auth(H2)])), 1)                       # only reserved: the call is not recorded

    def test_a_record_must_be_about_this_claim_in_this_version_of_the_original_call(self):
        """The registry entry is chosen by the caller (a version file): the audit accepts it only when it says what the audit saw: the original call and claim, and the version the writer demonstrated."""
        calls = [call("c1", 0, H1), call("c2", 1, H2)]; b = [binding("c1"), binding("c2")]
        def target(**kw): return dict(dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=VREF, stage="verify"), **kw)
        self.assertEqual(self.found(b, calls, [rec("c2", H2, target())]), [])
        invented = dict(VREF, write_tool_use_id="w9", sha256="f" * 64)                      # an allowance obtained under a version that is not the one demonstrated is a reset
        for why, t in (("another version", target(version_ref=invented)), ("no version", target(version_ref=None)), ("another original call", target(jev_ref=dict(tool_use_id="c7", result_index=0, key=CLAIM))),
                       ("another claim", target(jev_ref=dict(tool_use_id="c1", result_index=0, key="Another claim."))), ("a whole call, no claim", target(jev_ref=dict(tool_use_id="c1", result_index=None, key=None))), ("no call at all", target(jev_ref=None))):
            with self.subTest(why): self.assertEqual(len(self.found(b, calls, [rec("c2", H2, t)])), 1)

    def test_whitespace_in_the_recorded_claim_does_not_matter(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2)]; t = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key="  " + CLAIM.replace(" ", "  ") + "\n"), version_ref=VREF, stage="verify")
        self.assertEqual(self.found([binding("c1"), binding("c2")], calls, [rec("c2", H2, t)]), [])

    def test_a_record_covers_one_call_only(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2), call("c3", 2, H2)]; b = [binding("c1"), binding("c2"), binding("c3")]
        r = self.found(b, calls, [rec("c2", H2)]); self.assertEqual([x["tool_use_id"] for x in r], ["c3"])         # identical bytes again: a second re-verification

    def test_the_same_claim_for_another_version_or_without_a_version_is_judged_apart(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2)]
        self.assertEqual(self.found([binding("c1"), binding("c2", version=V2)], calls), [])                             # another write of the note
        self.assertEqual(self.found([binding("c1"), binding("c2", version=dict(V1, ok=False))], calls), [])             # a version that is not demonstrated is not grouped
        self.assertEqual(len(self.found([binding("c1", version=None), binding("c2", version=None)], calls, versioned=False)), 1)   # no version identity at all: the whole transcript

    def test_verify_and_gate_for_the_same_claim_are_repeats_of_each_other_and_whitespace_does_not_hide_it(self):
        r = self.found([binding("c1"), binding("c2", tool="gate", claim="  The latest commit is  e41a9c2 (migrate billing to duckdb)\n")], [call("c1", 0, H1), call("c2", 1, H2)])
        self.assertEqual([x["tool_use_id"] for x in r], ["c2"])

    def test_unbound_checks_and_other_tools_are_not_grouped(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2)]
        self.assertEqual(self.found([binding("c1"), binding("c2", bound=False)], calls), [])
        self.assertEqual(self.found([binding("c1"), binding("c2", tool="classify")], calls), [])

    def test_the_same_call_cited_twice_is_one_call(self):
        self.assertEqual(self.found([binding("c1"), binding("c1")], [call("c1", 0, H1)]), [])

    def test_a_malformed_history_authorizes_nothing_and_never_crashes(self):
        calls = [call("c1", 0, H1), call("c2", 1, H2)]; b = [binding("c1"), binding("c2")]
        for bad in ([None], ["x"], [dict(rec("c2", H2), recorded_ref=None)], [dict(rec("c2", H2), state="recorded", recorded_ref="c2")]):
            self.assertEqual(len(self.found(b, calls, bad)), 1, bad)

class Story(E2E.Base):
    """The documented complete PASS (Example 06) with a second call for the very same claim."""
    def setUp(self):
        super().setUp(); self.user, self.note, _ = self.story(6)
        self.body = CF.verify_body([dict(claim=CLAIM, verdict="verified", confidence=0.99)], compatible_synthetic=True)
        self.first = ("c1", dict(claims=[CLAIM], evidence=[dict(text=self.user)]), self.body)
        self.again = ("c2", dict(claims=[CLAIM], evidence=[dict(text=self.user), dict(text="the note itself says so")]), self.body)
    def run_report(self, extra, rows, mutate=None):
        t = self.build(self.user, self.note, extra); block, o = self.audit_block()
        if mutate: mutate(t)
        return t, self.report(t, self.doc(t, self.checks_for(t, rows), [], block))
    def two(self): return [self.first, self.again], [("p1", "c1", CLAIM, "verified", 0.99), ("p2", "c2", CLAIM, "verified", 0.99)]
    def record_for(self, t, tid="c2", payload=None, state="recorded"):
        """What evidence.py authorize + record leave in the registry of the session for the call `tid`."""
        reg, src = A.registry_path_of(t.log), discover.canon(t.log)
        call_ = next(c for c in jevref.load_calls(t.log) if c["tool_use_id"] == tid)
        v = versions_ref(t); target = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=v, stage="verify"); rid = A.evidence_request_id(target)
        self.assertEqual(A.reserve_evidence(reg, src, rid, target, call_["input_hash"])[0], "reserved")
        if state == "recorded": self.assertEqual(A.record_evidence(reg, src, rid, call_["input_hash"], dict(tool_use_id=tid, result_index=None, key=None))[0], "recorded")

def versions_ref(t):
    import versions
    v = versions.versions_of(t.log, t.note)[0][0]; return versions.version_ref(v, "prefix")

class Audit(Story):
    def test_a_single_call_is_still_a_pass(self):
        t, (out, g, path) = self.run_report([self.first], [("p1", "c1", CLAIM, "verified", 0.99)])
        self.assertEqual(out["status"], "PASS", out["binding_summary"]["reasons"]); self.assertNotIn("reverifications", out["binding_summary"]["audit"]["unfinished"])

    def test_a_repeat_without_a_record_cannot_be_a_pass_and_is_counted_and_explained(self):
        (extra, rows) = self.two(); t, (out, g, path) = self.run_report(extra, rows)
        self.assertEqual(out["status"], "UNRESOLVED"); au = out["binding_summary"]["audit"]
        self.assertEqual(au["unfinished"].get("reverifications"), 1); self.assertFalse(au["complete"])
        self.assertTrue(any("c2" in r and "c1" in r and "authoriz" in r for r in au["reasons"]), au["reasons"])
        self.assertEqual((g["audited_status"], g["delivery_state"]), ("UNRESOLVED", "verified_version"))          # the gate re-derives the same answer

    def test_the_recorded_authorization_of_that_call_makes_it_a_pass_again(self):
        (extra, rows) = self.two()
        def mut(t): self.record_for(t)
        t, (out, g, path) = self.run_report(extra, rows, mut)
        self.assertEqual(out["status"], "PASS", out["binding_summary"]["reasons"]); self.assertEqual(g["audited_status"], "PASS")

    def test_an_authorization_that_was_only_reserved_is_not_enough(self):
        (extra, rows) = self.two()
        def mut(t): self.record_for(t, state="authorized")
        t, (out, g, path) = self.run_report(extra, rows, mut)
        self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["binding_summary"]["audit"]["unfinished"].get("reverifications"), 1)

    def test_a_lost_or_unreadable_registry_authorizes_nothing(self):
        (extra, rows) = self.two()
        def mut(t):
            self.record_for(t)
            with open(A.registry_path_of(t.log), "w", encoding="utf-8") as f: f.write("{broken")
        t, (out, g, path) = self.run_report(extra, rows, mut)
        self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["binding_summary"]["audit"]["unfinished"].get("reverifications"), 1)

if __name__ == "__main__": unittest.main()

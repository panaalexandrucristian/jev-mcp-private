#!/usr/bin/env python3
"""Offline test of the flow as a real agent walks it (stdlib only, no Jev call, no network, never reads the real .handoff-verify/). Written from a live Haiku test (6 sessions): (1) `authorize` took EVERY proposal of the file although each
carries a `request_id` (`collect` filtered them), so a file with two requests made the authorization of each ask for the evidence of both and refuse it (`new_evidence_missing_in_payload`): one session gave up, one needed seven attempts
and the source code; (2) `advice.py` / `collect` run without --version-ref-file print request ids that `authorize` (which needs the version) does not know, and its error did not say why; (3) a proposal with a wrong key (`claim`
instead of `text`) was only "malformed" and the agent had to read the code to find the format. The positive responses are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at, which the inspected server does not emit;
test_contract_fixtures pins the realistic bodies).
usage: python3 -B test_evidence_flow.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit, discover, evidence, jevref
import test_retry_advice as T
import test_evidence_collect as C

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
VREF = C.VREF
ROW1 = ("The unit tests pass.", "verified", 0.9, "auto", 0.9)
ROW2 = ("Rollback uses release tag v2.14.3.", "verified", 0.8, "auto", 0.9)
NEW1, NEW2 = "report_test.py: 41 passed, 0 failed in 3.2s", "release.txt: rollback: release tag v2.14.3"

class Flow(unittest.TestCase):
    """A session with TWO claims that did not pass, one proposals file for both (as the agents wrote it), one payload each."""
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        rec, self.call = T.call([ROW1, ROW2])
        for r in rec: r["cwd"] = self.d
        self.log = os.path.join(self.d, "s.jsonl")
        with open(self.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
        self.reg = audit.registry_path_of(self.log); audit.ensure_registry(self.reg, discover.canon(self.log))
        self.vr = self.put("vr.json", VREF)
        self.rows = advice.session_advice([self.call], version_ref=VREF); self.ids = [r["advice"]["evidence_request"]["request_id"] for r in self.rows]
        self.f1, self.f2 = self.write("new1.log", NEW1 + "\n"), self.write("new2.txt", NEW2 + "\n")
        self.props = self.put("props.json", dict(proposals=[dict(request_id=self.ids[0], kind="local_file", path=self.f1), dict(request_id=self.ids[1], kind="local_file", path=self.f2)]))
        self.p1 = self.put("p1.json", dict(claims=[ROW1[0]], evidence=[T.EVIDENCE, NEW1])); self.p2 = self.put("p2.json", dict(claims=[ROW2[0]], evidence=[T.EVIDENCE, NEW2]))
    def write(self, name, text):
        p = os.path.join(self.d, name)
        with open(p, "w", encoding="utf-8") as f: f.write(text)
        return p
    def put(self, name, body): return self.write(name, json.dumps(body))
    def cli(self, *args, rc=0, script="evidence.py"):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script), *args], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, rc, p.stderr + p.stdout); return json.loads(p.stdout) if p.stdout.strip() else None
    def authorize(self, rid, payload, props=None, rc=0): return self.cli("authorize", "--session", self.log, "--version-ref-file", self.vr, "--request-id", rid, "--payload", payload, "--proposals", props or self.props, rc=rc)
    def history(self): return audit.load_registry(self.reg)[0]["evidence_history"]

class Proposals(Flow):
    def test_each_request_is_authorized_with_its_own_proposals_from_one_shared_file(self):
        a = self.authorize(self.ids[0], self.p1); self.assertEqual((a["authorized"], a["status"]), (True, "reserved"), a)
        b = self.authorize(self.ids[1], self.p2); self.assertEqual((b["authorized"], b["status"]), (True, "reserved"), b)
        self.assertEqual(sorted(e["request_id"] for e in self.history()), sorted(self.ids))

    def test_the_proposals_of_another_request_are_not_the_evidence_of_this_one(self):
        wrong = self.put("wrong.json", dict(claims=[ROW1[0]], evidence=[T.EVIDENCE, NEW2]))            # the claim of request 1 with the evidence that request 2 collected
        r = self.authorize(self.ids[0], wrong, rc=1); self.assertEqual((r["authorized"], r["reason"]), (False, "new_evidence_missing_in_payload")); self.assertEqual(self.history(), [])

    def test_a_proposal_without_a_request_id_still_applies_to_the_request_being_authorized(self):
        props = self.put("anon.json", dict(proposals=[dict(kind="local_file", path=self.f1)]))
        a = self.authorize(self.ids[0], self.p1, props); self.assertTrue(a["authorized"], a)

    def test_collect_and_authorize_agree_on_what_belongs_to_a_request(self):
        out = self.cli("collect", "--session", self.log, "--proposals", self.props, "--version-ref-file", self.vr)
        got = {x["request"]["request_id"]: [i["quote"] for i in x["collected"]["items"]] for x in out["requests"]}
        self.assertEqual(len(got[self.ids[0]]), 1); self.assertIn(NEW1, got[self.ids[0]][0]); self.assertEqual(len(got[self.ids[1]]), 1); self.assertIn(NEW2, got[self.ids[1]][0])

class Versions(Flow):
    def ids_without_a_version(self): return [r["advice"]["evidence_request"]["request_id"] for r in advice.session_advice([self.call])]

    def test_advice_and_collect_say_when_the_requests_are_not_bound_to_a_version(self):
        o = self.cli("--session", self.log, script="advice.py"); self.assertFalse(o["version_bound"]); self.assertIn("--version-ref-file", o["version_note"])
        o = self.cli("--session", self.log, "--version-ref-file", self.vr, script="advice.py"); self.assertTrue(o["version_bound"]); self.assertNotIn("version_note", o)
        o = self.cli("collect", "--session", self.log); self.assertFalse(o["version_bound"]); self.assertIn("--version-ref-file", o["version_note"])
        o = self.cli("collect", "--session", self.log, "--version-ref-file", self.vr); self.assertTrue(o["version_bound"]); self.assertNotIn("version_note", o)

    def test_an_id_made_without_a_version_is_explained_and_the_known_ids_are_listed(self):
        unbound = self.ids_without_a_version(); self.assertFalse(set(unbound) & set(self.ids))
        r = self.authorize(unbound[0], self.p1, rc=2)
        self.assertIn("without --version-ref-file", r["error"]); self.assertEqual(sorted(r["known_request_ids"]), sorted(self.ids))

    def test_an_id_nobody_made_is_a_plain_error_that_still_lists_the_known_ids(self):
        r = self.authorize("0" * 16, self.p1, rc=2); self.assertNotIn("without --version-ref-file", r["error"]); self.assertEqual(sorted(r["known_request_ids"]), sorted(self.ids))
        r = self.cli("check", "--session", self.log, "--version-ref-file", self.vr, "--request-id", "0" * 16, "--payload", self.p1, rc=2); self.assertEqual(sorted(r["known_request_ids"]), sorted(self.ids))

class Format(Flow):
    def collect(self, p):
        props = self.put("one.json", dict(proposals=[dict(dict(request_id=self.ids[0]), **p)]))
        out = self.cli("collect", "--session", self.log, "--proposals", props, "--version-ref-file", self.vr)
        return next(x for x in out["requests"] if x["request"]["request_id"] == self.ids[0])["collected"]

    def test_a_proposal_that_lacks_its_field_names_the_field(self):
        for p, why in ((dict(kind="corrected_claim", claim="x y z"), "corrected_claim_needs_text"), (dict(kind="local_file"), "local_file_needs_path"), (dict(kind="local_dir"), "local_dir_needs_path"),
                       (dict(kind="transcript_record"), "transcript_record_needs_quote"), (dict(kind="corrected_claim", text="  "), "corrected_claim_needs_text")):
            with self.subTest(why): self.assertEqual([x["reason"] for x in self.collect(p)["rejected"]], [why])

    def test_an_unknown_kind_lists_the_kinds(self):
        r = self.collect(dict(kind="file", path=self.f1))["rejected"][0]; self.assertEqual(r["reason"], "unknown_kind"); self.assertEqual(sorted(r["kinds"]), ["corrected_claim", "local_dir", "local_file", "transcript_record"])

    def test_the_help_shows_the_three_file_formats(self):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "-h"], capture_output=True, text=True, env=ENV).stdout
        for must in ("proposals", "request_id", "local_file", "corrected_claim", "payload", "claims", "evidence", "version_ref"): self.assertIn(must, p, must)

if __name__ == "__main__": unittest.main()

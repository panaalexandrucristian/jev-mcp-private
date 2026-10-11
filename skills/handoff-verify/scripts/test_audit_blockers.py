#!/usr/bin/env python3
"""Offline test of the `blockers` of the report (stdlib only, no Jev call, no network, never reads the real .handoff-verify/). Written from a live Haiku test: in 5 of 5 reports the audit was not completed (`unfinished.evaluations: 1`), so no
report could PASS, and nothing told the agent what to do about it. The writer now lists, at the top of the report, one blocker per kind of unfinished audit work (the counts that `audit.assess` already derives), each with a FIXED hint
that names the real command (no dynamic text, so nothing needs sanitizing). The list is writer-owned (an author's value is dropped), informative (it never changes a status, never completes the audit for the agent, never calls Jev) and
empty for a complete audit. A re-verification made without an authorization is a `protocol_violation`: it cannot be repaired afterwards. The positive responses are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at,
which the inspected server does not emit; test_contract_fixtures pins the realistic bodies).
usage: python3 -B test_audit_blockers.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, schema_check as SC
import contract_fixtures as CF
import test_doc_end_to_end as E2E
import test_reverification_audit as RA

class Pure(unittest.TestCase):
    def test_nothing_unfinished_is_no_blocker(self):
        self.assertEqual(A.blockers({}), []); self.assertEqual(A.blockers({"structure": 0, "scope": 0}), [])

    def test_one_blocker_per_unfinished_kind_in_a_fixed_order_with_its_count(self):
        out = A.blockers({"reverifications": 2, "evaluations": 1, "structure": 3})
        self.assertEqual([(b["code"], b["count"]) for b in out], [("structure", 3), ("evaluations", 1), ("reverifications", 2)])
        for b in out: self.assertEqual(set(b), {"code", "family", "remedy", "count", "hint"}); self.assertEqual(b["family"], "audit"); self.assertTrue(b["hint"].strip())

    def test_every_kind_the_audit_counts_has_a_blocker_and_no_other_does(self):
        kinds = set(A.assess(A.Context({}, [], [], [], None, None, None, False, False, "R04", False, ()))["unfinished"])
        self.assertEqual(set(A.BLOCKERS), kinds)

    def test_the_remedies_are_the_agreed_ones(self):
        self.assertEqual({r for r, _ in A.BLOCKERS.values()}, {"report_structure", "audit_completion", "protocol_violation"})
        self.assertEqual(A.BLOCKERS["reverifications"][0], "protocol_violation"); self.assertEqual(A.BLOCKERS["evaluations"][0], "audit_completion")

    def test_the_hints_name_commands_that_exist(self):
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "audit.py"), "-h"], capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1")).stdout
        for sub in ("template", "register"): self.assertIn(sub, out)
        hints = " ".join(h for _, h in A.BLOCKERS.values()); self.assertIn("audit.py template", hints); self.assertIn("audit.py register", hints)

    def test_a_hint_is_a_fixed_text(self):
        for k, (_, h) in A.BLOCKERS.items(): self.assertNotIn("%", h, k); self.assertEqual(A.blockers({k: 1})[0]["hint"], h)

class Report(E2E.Base):
    def setUp(self):
        super().setUp(); self.user, self.note, _ = self.story(6); self.claim = "The latest commit is e41a9c2 (migrate billing to duckdb)"
        self.body = CF.verify_body([dict(claim=self.claim, verdict="verified", confidence=0.99)], compatible_synthetic=True)
        self.t = self.build(self.user, self.note, [("c1", dict(claims=[self.claim], evidence=[dict(text=self.user)]), self.body)])
    def write(self, block=None, edit=None):
        doc = self.doc(self.t, self.checks_for(self.t, [("p1", "c1", self.claim, "verified", 0.99)]), [], block)
        if edit: edit(doc)
        return self.report(self.t, doc)

    def test_a_complete_audit_has_no_blocker_and_is_a_pass(self):
        block, _ = self.audit_block(); out, g, path = self.write(block)
        self.assertEqual(out["status"], "PASS", out["binding_summary"]["reasons"]); self.assertEqual(out["blockers"], [])

    def test_a_report_without_the_audit_review_names_it_and_the_command(self):
        out, g, path = self.write(None)
        self.assertEqual(out["status"], "UNRESOLVED"); b = {x["code"]: x for x in out["blockers"]}
        self.assertEqual((b["evaluations"]["count"], b["evaluations"]["remedy"], b["evaluations"]["family"]), (1, "audit_completion", "audit")); self.assertIn("audit.py template", b["evaluations"]["hint"])
        self.assertEqual({x["code"]: x["count"] for x in out["blockers"]}, out["binding_summary"]["audit"]["unfinished"])      # the blockers ARE the unfinished counts

    def test_a_stale_review_is_named(self):
        block, _ = self.audit_block(); block["chunks"][0]["sha256"] = "0" * 64
        out, g, path = self.write(block); self.assertIn("chunks_stale", [x["code"] for x in out["blockers"]])

    def test_blockers_never_change_the_status(self):
        for block in (None, self.audit_block()[0]):
            out, g, path = self.write(block); without = dict(out); without.pop("blockers")
            self.assertEqual(out["status"], without["status"]); self.assertEqual((out["status"], g["audited_status"]), (out["status"], out["status"]))

    def test_nothing_the_author_wrote_is_kept_and_the_report_is_valid(self):
        def edit(doc): doc["blockers"] = [dict(code="forged", family="audit", remedy="audit_completion", count=9, hint="trust me")]
        out, g, path = self.write(None, edit)
        self.assertNotIn("forged", [x["code"] for x in out["blockers"]]); self.assertEqual(SC.validate_report(out), [])

    def test_the_schema_knows_the_property_and_the_writer_owns_it(self):
        s = json.load(open(os.path.join(HERE, "report.schema.json"), encoding="utf-8"))
        self.assertIn("blockers", s["properties"]); self.assertIn("blockers", SC.WRITER_OWNED)
        for k in ("code", "family", "remedy", "count", "hint"): self.assertIn(k, s["properties"]["blockers"]["items"]["required"])

class Repeat(RA.Story):
    def test_a_repeat_without_an_authorization_is_a_protocol_violation_not_a_task(self):
        extra, rows = self.two(); t, (out, g, path) = self.run_report(extra, rows)
        b = next(x for x in out["blockers"] if x["code"] == "reverifications")
        self.assertEqual((b["count"], b["remedy"]), (1, "protocol_violation")); self.assertIn("cannot be repaired", b["hint"])

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the documentation of the re-verification evidence (stdlib only, no Jev call, no network, never reads the real .handoff-verify/). The new instructions are DECLARED ADDITIONS of the split documentation (never an edit of an
original block, so the zero-loss proof stays green): the exact preflight sentence in the root loading section (R8), one section in each of reference/jev-and-audit.md (the flow), reference/candidates.md (the two halves of an omission pair)
and reference/report.md (the fields of the report). The documentation must not drift from the code: every command, state, remedy, stop code and advice code the code can produce is named where it is explained, and every command or code the
documentation names exists. What the mechanism does NOT do is written down next to what it does.
usage: python3 -B test_reverification_docs.py [-v]"""
import os, re, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit, split_skill as S
import test_split_lossless as SL

PREFLIGHT = ("R8: Before any re-verification, run advice.py, collect eligible new evidence locally, and obtain an evidence.py authorization bound to the exact prepared input. "
             "Never reset an exhausted allowance through another id, split claim, run, or report.")
D = SL.docs(S.SKILL_DIR)
FLOW, HALVES, FIELDS = "## Re-verification evidence", "## Omission halves and re-verification", "## Evidence requests in the report"

def section(name, head):
    t = D[name]; i = t.index(head); j = t.find("\n## ", i + 5); return t[i:j if j > 0 else len(t)]

def subcommands():
    """The commands evidence.py offers, read from its own --help."""
    out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "-h"], capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1")).stdout
    return re.search(r"\{([a-z,]+)\}", out).group(1).split(",")

class Root(unittest.TestCase):
    def test_the_exact_preflight_sentence_is_the_eighth_loading_rule_and_the_agreed_rules_are_untouched(self):
        lines = SL.section(D["SKILL.md"], SL.LOADING).splitlines()
        self.assertIn(PREFLIGHT, lines)
        self.assertEqual(SL.loading_problems(S.SKILL_DIR), []); self.assertEqual(SL.names_problems(S.SKILL_DIR), [])      # R0-R7 as agreed, every heading indexed
        self.assertLess(lines.index(SL.RULES[-1]), lines.index(PREFLIGHT))

    def test_the_new_text_is_declared_and_the_zero_loss_proof_is_green(self):
        self.assertEqual(S.manifest_problems(S.load_manifest()), []); self.assertEqual(S.check(), [])
        m = S.load_manifest(); self.assertTrue({"loading", "reverification", "omission-halves", "evidence-requests"} <= {a["id"] for a in m["additions"]})
        self.assertFalse(SL.over_cap(S.SKILL_DIR))

class Flow(unittest.TestCase):
    def setUp(self): self.t = section("reference/jev-and-audit.md", FLOW)

    def test_every_command_of_evidence_py_is_documented_and_no_other_is(self):
        cmds = sorted(subcommands()); self.assertEqual(cmds, ["authorize", "check", "collect", "record"])
        for c in cmds: self.assertIn("evidence.py %s" % c, self.t, c)
        self.assertEqual(sorted(set(re.findall(r"evidence\.py (\w+)", self.t))), cmds); self.assertIn("advice.py", self.t)

    def test_the_order_the_rule_and_the_registry_are_stated(self):
        for must in ("per_check_only", "once", "advice → collect → authorize → Jev → record → report", "authorized → recorded", "exclusive lock", "BEFORE the call", "never given back", "Never reset an exhausted allowance",
                     "one grouped question", "not a Jev call", "headless", "compound claim", "every part exactly once", "same single authorization", "version_bound", "known_request_ids", "the version file", "the proposals file", "the payload file", "corrected_claim_needs_text", "sanitizing", "unfinished.reverifications", "protocol violation", "PASS", "FAIL keeps its precedence"):
            self.assertIn(must, self.t, must)

    def test_every_state_remedy_and_stage_the_code_produces_is_named(self):
        remedies = {v[0] for v in advice.REMEDY.values()}
        for name in sorted(remedies | {"collect_local", "ask_user", "ready", "blocked", "exhausted"} | set(audit.EVIDENCE_STATES) | set(audit.EVIDENCE_STAGES)): self.assertIn(name, self.t, name)

    def test_the_stop_reasons_of_the_request_are_named(self):
        for why in ("history_unavailable", "reverification_used", "result_of_a_reverification", "no_usable_result", "protocol_fields_absent", "subject_fields_null_or_invalid", "no_local_evidence_after_question", "no_local_evidence_headless"):
            self.assertIn(why, self.t, why)

    def test_the_limits_are_written_next_to_what_the_mechanism_does(self):
        for must in ("cannot stop a Jev call", "no check cites", "corrected claim", "editable files", "identity", "material"):
            self.assertIn(must, self.t, must)

class Halves(unittest.TestCase):
    def setUp(self): self.t = section("reference/candidates.md", HALVES)

    def test_every_omission_advice_code_and_stop_reason_is_named(self):
        for code in ("absence_awaits_source", "absence_material_unchanged", "absence_material_not_canonical", "source_not_qualified", "no_other_eligible_record", "stage_takes_no_new_evidence"): self.assertIn(code, self.t, code)
        self.assertEqual(set(advice.CODES) - set(advice.HINTS), set())

    def test_the_rules_of_the_two_halves_are_stated(self):
        for must in ("complete canonical material", "nothing may be added", "SOURCE call", "first call", "another eligible record", "whole", "only evidence", "never a file", "ABSENCE-first", "pair exception", "no finding", "transcript_record", "canonical SOURCE claim"):
            self.assertIn(must, self.t, must)

    def test_what_is_recognized_and_what_is_not_is_written_down(self):
        for must in ("canonical prefix", "registered candidate", "log alone", "generic advice"):
            self.assertIn(must, self.t, must)

class Fields(unittest.TestCase):
    def setUp(self): self.t = section("reference/report.md", FIELDS)

    def test_the_new_fields_are_documented_with_their_ownership(self):
        for must in ("evidence_requests", "advice.evidence_request", "check_id", "request_id", "writer-owned", "never change a status", "unfinished.reverifications", "recorded", "version", "readable", "blockers", "audit_completion", "report_structure", "protocol_violation", "never changes a status"):
            self.assertIn(must, self.t, must)

    def test_the_documented_keys_are_the_keys_the_code_writes(self):
        import json
        s = json.load(open(os.path.join(HERE, "report.schema.json"), encoding="utf-8")); item = s["properties"]["evidence_requests"]["items"]
        for k in item["required"]: self.assertIn(k, self.t, k)
        for k in s["properties"]["checks"]["items"]["properties"]["advice"]["properties"]["evidence_request"]["required"]: self.assertIn(k, self.t, k)
        for k in s["properties"]["blockers"]["items"]["required"]: self.assertIn("`%s`" % k, self.t, k)

if __name__ == "__main__": unittest.main()

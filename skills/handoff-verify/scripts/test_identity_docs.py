#!/usr/bin/env python3
"""Documentation contract of the role-aware recorded-identifier policy (stdlib, offline): the skill documentation (SKILL.md and its reference files) states the behavior that test_identity_roles.py, test_scope_identities.py and test_identity_places.py test, and the forms it
names are exactly the forms the code recognizes (so the text cannot drift from sanitize.py).
usage: python3 -B test_identity_docs.py [-v]"""
import os, re, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions as O, sanitize as S, skilldocs

ROOT, CANDIDATES, DOCS = skilldocs.doc("SKILL.md"), skilldocs.doc("reference/candidates.md"), skilldocs.text()      # the active documentation: the one SKILL.md today (every name reads it), split later
BODY = "01AbCdEfGhIjKlMnOpQrStUvWxYz"

class Docs(unittest.TestCase):
    def test_the_recorded_identifier_rule_is_documented(self):
        for needle in ("Recorded identifiers", "`toolu_`", "`toolu_bdrk_`", "`toolu_vrtx_`", "`srvtoolu_`", "`call_`", "`~n`", "`#k`", "byte-for-byte", "only that rule", "`call_AKIA...`", "never invents a replacement identity"):
            self.assertIn(needle, ROOT, needle)

    def test_the_documented_prefixes_and_suffixes_are_the_recognized_ones(self):
        for prefix in ("toolu_", "toolu_bdrk_", "toolu_vrtx_", "srvtoolu_", "call_"):
            for suffix in ("", "~2", "#1", "~2#1"): self.assertTrue(S.RECORDED_ID.fullmatch(prefix + BODY + suffix), prefix + suffix)
        for bad in ("foo_" + BODY, "toolu_" + BODY + "~1", "toolu_" + BODY + "#0"): self.assertFalse(S.RECORDED_ID.fullmatch(bad), bad)
        self.assertIn("`~n` (n >= 2)", ROOT); self.assertIn("`#k` (k >= 1)", ROOT)

    def test_the_scope_readiness_check_is_documented(self):
        self.assertIn("`scope.py prepare` checks the source session path (as given and canonical), the write id and the named or automatically selected run id", CANDIDATES)
        self.assertIn("exit 3, no payload and no `evaluation`", CANDIDATES)

    def test_the_unchanged_rules_are_still_documented(self):
        for needle in ("`[REDACTED:ambiguous]`", "never altered or echoed"): self.assertIn(needle, ROOT, needle)
        for needle in ("strictly > 0.99", "the 0.95 rules are unchanged"): self.assertIn(needle, CANDIDATES, needle)

    def test_the_copy_source_surfaces_and_the_diagnostics_are_documented(self):
        for needle in ("`versions.py list`", "exactly as the transcript recorded"): self.assertIn(needle, ROOT, needle)
        # the guarantee about values given by the caller is scoped to the fields that are actually guarded; OB4 (an unsafe --file) is kept as a stated gap
        for needle in ("only these given values are guarded in a diagnostic", "the missing-session argument of `prepare.py`", "the missing-source argument and the rejected `--run` of `versions.py list`", "`report_path` of `versions.py status`",
                       "an unsafe `--file` path is NOT guarded", "provenance and gate diagnostics of `versions.py list` / `status`"): self.assertIn(needle, ROOT, needle)
        self.assertNotIn("a value you gave that needs redaction is not echoed in a diagnostic of `prepare.py`, `versions.py list` or `versions.py status`", DOCS)

    def test_the_display_marker_of_a_refused_run_is_documented_and_is_the_one_the_code_uses(self):
        self.assertIn("`" + O.ID_WITHHELD + "`", ROOT); self.assertIn("a clean recorded id stays exact in the `runs` list", ROOT); self.assertIn("the marker is never an identity", ROOT)
        self.assertTrue(S.identity_altered(O.ID_WITHHELD, S.ID_ROLE)["redaction_dependent"])

if __name__ == "__main__": unittest.main()

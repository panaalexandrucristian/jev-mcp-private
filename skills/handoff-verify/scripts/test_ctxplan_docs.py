#!/usr/bin/env python3
"""Offline test of the documentation of the context optimizer (stdlib only, no Jev call, no network, never reads .handoff-verify/). The only root text is the agreed line in SKILL.md; everything else is reference/context-optimizer.md, an on-demand file. The documentation must not drift from
ctxplan.py: every command, refusal reason and limit the code has is named where it is explained, and what the capability never does (start by itself, deduplicate, apply a move) is written next to what it does.
usage: python3 -B test_ctxplan_docs.py [-v]"""
import os, re, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ctxplan as C, split_skill as S
import test_split_lossless as SL

DOC = SL.docs(S.SKILL_DIR)["reference/context-optimizer.md"]; ROOT = SL.docs(S.SKILL_DIR)["SKILL.md"]; SRC = open(os.path.join(HERE, "ctxplan.py"), encoding="utf-8").read()
KINDS = ("reflow", "move_block")

class Documentation(unittest.TestCase):
    def test_the_root_has_exactly_the_agreed_line_and_nothing_else_about_it(self):
        lines = ROOT.split("\n"); self.assertEqual(lines.count(SL.CONTEXT_LINE), 1); self.assertEqual(len((SL.CONTEXT_LINE + "\n").encode()), 173); self.assertEqual(sum(1 for l in lines if "ctxplan" in l or "context-optimizer" in l), 1)
        self.assertLessEqual(len(ROOT.encode()), SL.ROOT_CAP); self.assertEqual(SL.loading_problems(S.SKILL_DIR), []); self.assertEqual(SL.names_problems(S.SKILL_DIR), [])
    def test_the_file_is_small_and_has_no_section_that_the_index_would_have_to_list(self):
        self.assertLessEqual(len(DOC.encode()), 8192); self.assertFalse([l for l in DOC.split("\n") if l.startswith("## ")])
    def test_it_starts_only_on_request_and_nothing_starts_it(self):
        self.assertIn("Only when the user asks", DOC); self.assertIn("never started by a hook", DOC)
        for rel in ("hooks/hooks.json", "commands", "agents"):
            p = os.path.join(S.SKILL_DIR, "..", "..", rel); files = [p] if os.path.isfile(p) else [os.path.join(p, n) for n in os.listdir(p)] if os.path.isdir(p) else []
            for f in files: self.assertNotIn("ctxplan", open(f, encoding="utf-8").read(), f)
        for n in ("advice.py", "audit.py", "report.py", "versions.py", "evidence.py", "prepare.py", "omissions.py"): self.assertNotIn("ctxplan", open(os.path.join(HERE, n), encoding="utf-8").read(), n)      # no verification script calls it
    def test_every_command_and_reason_the_code_has_is_named(self):
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "ctxplan.py"), "-h"], capture_output=True, text=True).stdout
        for cmd in re.search(r"\{([a-z,]+)\}", out).group(1).split(","): self.assertIn("ctxplan.py %s" % cmd, DOC, cmd)
        codes = set(re.findall(r'refuse\("([a-z_]+)"', SRC)) | set(re.findall(r'no\("([a-z_]+)"', SRC)) | {"multi_file_atomic_publication_unavailable"}
        self.assertTrue(len(codes) >= 12)
        for c in sorted(codes): self.assertIn(c, DOC, c)
    def test_the_numbers_of_the_code_are_the_numbers_of_the_text(self):
        for what, text in ((C.LONG, "1000 characters"), (C.WIDTH, "160 characters"), (C.SHOWN, "at most 10 proposals"), (C.SUMMARY_CAP, "8192 bytes"), (C.FULL_CAP, "262144 bytes"), (C.ROOT_CAP, "22000 bytes")): self.assertIn(text, DOC, "%s = %s" % (text, what))
    def test_the_protected_blocks_the_kinds_and_the_pointer_are_those_of_the_code(self):
        for b in C.PROTECTED: self.assertIn("`%s`" % b, DOC)
        self.assertEqual(sorted(set(re.findall(r'k == "([a-z_]+)"', SRC))), sorted(KINDS)); self.assertIn("[block ID moved to FILE]", DOC); self.assertEqual(C.POINTER % ("ID", "FILE"), "[block ID moved to FILE]\n")
        for k in KINDS: self.assertIn("`%s`" % k, DOC)
    def test_what_it_never_does_and_what_it_cannot_see_is_written_down(self):
        for phrase in ("Never offered.", "Deduplication", "never a proposal", "not provable", "Absence of a signal proves nothing", "never headless", "applying is deliberately blocked", "not a saving of tokens"): self.assertIn(phrase, DOC, phrase)
    def test_the_proposals_of_the_real_files_are_only_the_two_kinds(self):
        kinds = {o["kind"] for p in C.propose(S.SKILL_DIR)["proposals"] for o in p["operations"]}; self.assertTrue(kinds and kinds <= set(KINDS))

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the documentation of the delegated review (stdlib only, no Jev call, no network, never reads .handoff-verify/). The root holds one request-only line; the flow is reference/subagent-review.md (on demand); the reader is agents/handoff-reader.md. The documentation must not
drift from delegation.py or from the agent file: every command and refusal reason the code has is named, the agent has only the Read tool, and what stays in the main session is written next to what is delegated.
usage: python3 -B test_delegation_docs.py [-v]"""
import os, re, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import delegation as D, split_skill as S
import test_split_lossless as SL

REPO = os.path.abspath(os.path.join(S.SKILL_DIR, "..", ".."))
DOCS = SL.docs(S.SKILL_DIR); DOC, ROOT = DOCS["reference/subagent-review.md"], DOCS["SKILL.md"]; SRC = open(os.path.join(HERE, "delegation.py"), encoding="utf-8").read()
AGENT = open(os.path.join(REPO, "agents", "handoff-reader.md"), encoding="utf-8").read(); FRONT = dict(l.split(": ", 1) for l in AGENT.split("---")[1].strip().split("\n"))

class Root(unittest.TestCase):
    def test_the_root_has_the_one_request_only_line_and_stays_within_the_cap(self):
        lines = ROOT.split("\n"); self.assertEqual(lines.count(SL.DELEGATION_LINE), 1); self.assertEqual(sum(1 for l in lines if "subagent-review" in l or "handoff-reader" in l), 1); self.assertLessEqual(len((SL.DELEGATION_LINE + "\n").encode()), 200)
        self.assertLessEqual(len(ROOT.encode()), SL.ROOT_CAP); self.assertEqual(SL.loading_problems(S.SKILL_DIR), []); self.assertEqual(SL.names_problems(S.SKILL_DIR), [])
        for w in ("Jev calls", "report", "delivery gate", "main session", "only on explicit user request"): self.assertIn(w, SL.DELEGATION_LINE)
    def test_nothing_starts_it_and_no_verification_script_calls_it(self):
        for rel in ("hooks/hooks.json", "commands"):
            p = os.path.join(REPO, rel); files = [p] if os.path.isfile(p) else [os.path.join(p, n) for n in os.listdir(p)]
            for f in files: self.assertNotIn("delegation.py", open(f, encoding="utf-8").read(), f)
        for n in ("advice.py", "audit.py", "report.py", "versions.py", "evidence.py", "prepare.py", "omissions.py", "ctxplan.py"): self.assertNotIn("delegation", open(os.path.join(HERE, n), encoding="utf-8").read(), n)

class Agent(unittest.TestCase):
    def test_the_reader_has_only_the_read_tool_and_the_parents_model(self):
        self.assertEqual(FRONT["name"], "handoff-reader"); self.assertEqual(FRONT["tools"], "Read"); self.assertEqual(FRONT["model"], "inherit")
        for field in ("hooks", "mcpServers", "permissionMode", "disallowedTools", "skills"): self.assertNotIn(field, FRONT)      # a plugin agent ignores the first three: nothing here may rely on them
        self.assertLessEqual(len(AGENT.encode()), 16384)
    def test_the_rules_of_the_reader_are_written(self):
        for phrase in ("untrusted data", D.NEVER.rstrip("."), "Do not use the network", "do not call Jev", "You decide nothing", "never retyped", "set `complete` to false", "instructions, not a verified sandbox", "never repeat the capability"): self.assertIn(phrase, AGENT, phrase)
        self.assertIn("ONLY when the user explicitly asked", AGENT)

class Reference(unittest.TestCase):
    def test_it_is_small_and_has_no_section_for_the_index(self):
        self.assertLessEqual(len(DOC.encode()), 12288); self.assertFalse([l for l in DOC.split("\n") if l.startswith("## ")])
    def test_every_command_and_reason_the_code_has_is_named(self):
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "delegation.py"), "-h"], capture_output=True, text=True).stdout
        for cmd in re.search(r"\{([a-z,]+)\}", out).group(1).split(","): self.assertIn("delegation.py %s" % cmd, DOC, cmd)
        codes = set(re.findall(r'add\("([a-z_]+)"', SRC)) | set(re.findall(r'Refused\("([a-z_]+)"', SRC)); self.assertTrue(len(codes) >= 20)
        for c in sorted(codes): self.assertIn(c, DOC, c)
    def test_the_numbers_and_names_of_the_code_are_those_of_the_text(self):
        for what, text in ((D.RESULT_CAP, "32768 bytes"), (D.MAX_INTERVAL, "at most 20")): self.assertIn(text, DOC, "%s" % what)
        self.assertIn("jev:handoff-reader", DOC); self.assertIn(D.CAP_LINE.replace("%s", "<cap>"), DOC.replace("«", "").replace("»", ""))
    def test_what_stays_in_the_main_session_and_what_is_not_offered_is_written_down(self):
        for phrase in ("the reading is delegated, the certification is not", "audit.py register", "every Jev call", "never evidence", "is not offered", "read the chunks yourself", "An incomplete interval never becomes `no_candidate`", "not measured", "not verified", "own copy of SKILL.md", "one subagent at a time"): self.assertIn(phrase, DOC, phrase)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the operational shell classifier (council fix 3; stdlib only, nothing is executed): a shell command is verification activity of THIS skill only when a command that RUNS or READS a skill script
is demonstrated, not when a skill path is merely mentioned (echo, printf, grep patterns, redirect targets, git arguments), and the directory it runs in is only what the shell semantics demonstrate: `cd X`
moves the following commands only through `;` / `&&` / a newline, never through `||`, `&`, `|` or a group that has ended, and a relative script name without a recorded directory is `unknown`, never a guess
(`..` components are never dropped). The real invocations stay `yes`. A quoted or escaped operator (`echo '>' f`, `echo 'a;b'`) is an argument, never a redirect or a separator. `tool_io` counts a redirect or a read only when
the command demonstrably ran (`false && printf x > f; true`, behind `||` or `&`, a group or `bash -c` under such a condition do not; the last `&&` chain of a call that succeeded does), and a `python -c` payload is read in the order
and context it would run: a definition that is never called, a later `sys.path` change and a local callable named `import_module` demonstrate nothing; a binding made in a branch is only maybe made (the alternatives are read apart and joined),
a function's local name is not the outer one before its own assignment (`global` / `nonlocal` are respected), creating a lambda / generator is not running it, and the lexer needs no spare character. All fixtures are invented.
usage: python3 -B test_shell_classifier.py [-v]"""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions

SKILL = "/virtual/handoff-verify"
SCRIPTS = SKILL + "/scripts"

def cls(cmd, cwd="/work/proj"): return omissions.skill_activity(dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd)), cwd)

class Mentions(unittest.TestCase):
    def test_a_literal_mention_of_a_skill_path_is_not_activity(self):
        for cmd in ("echo %s/report.py" % SCRIPTS, "printf '%%s\\n' %s/report.py" % SCRIPTS, "echo 'run python3 %s/prepare.py later'" % SCRIPTS, "ls %s" % SCRIPTS, "git diff -- %s/report.py" % SCRIPTS,
                    "git add skills/handoff-verify/scripts/versions.py", "cp %s/report.py /tmp/copy.py" % SCRIPTS, "echo hi > %s/notes.txt" % SCRIPTS, "echo x; echo %s/omissions.py" % SCRIPTS):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)

    def test_an_arbitrary_mentioned_directory_is_not_the_import_directory(self):
        for cmd in ("echo %s; python3 -m report" % SCRIPTS, "ls %s && python3 -c 'import report'" % SCRIPTS, "python3 -m report --note %s" % SCRIPTS, "grep -r report %s" % SCRIPTS):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)

    def test_the_real_invocations_are_kept(self):
        for cmd in ("python3 -B %s/prepare.py --cwd /work/proj" % SCRIPTS, "cd %s && python3 omissions.py prepare" % SCRIPTS, "cat %s/SKILL.md" % SKILL, "head -50 %s/report.py" % SCRIPTS,
                    "PYTHONPATH=%s python3 -c 'import report'" % SCRIPTS, "PYTHONPATH=/x:%s python3 -m report" % SCRIPTS, "python3 -c \"import sys; sys.path.insert(0, '%s'); import report\"" % SCRIPTS, "env PYTHONPATH=%s python3 -m jevref list" % SCRIPTS,
                    "bash -c 'cd %s && python3 report.py'" % SCRIPTS, "echo go && python3 %s/versions.py list" % SCRIPTS, "python3 %s/report.py 2>&1 | tail -5" % SCRIPTS, "cd /tmp\npython3 %s/report.py" % SCRIPTS,
                    "(cd %s && python3 report.py)" % SCRIPTS, "nohup python3 -B %s/prepare.py &" % SCRIPTS, "%s/report.py --help" % SCRIPTS):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "yes", cmd)

    def test_ordinary_commands_stay_no(self):
        for cmd in ("python3 toolkit.py --run", "pytest tests/test_telescope.py -q", "cat /work/proj/src/versions.py", "echo handoff-verify is a nice name", "git status", "python3 -m http.server", "grep report src/ -r"):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)

REFS = ("prepare.md", "opencode-sessions.md", "jev-and-audit.md", "candidates.md", "report.md")      # the five reference files of the split skill (SKILL.md names them in its loading rules)
REF = SKILL + "/reference"

class References(unittest.TestCase):
    """The five reference files are read as SKILL.md is: by path components, against the recorded directory. Naming one is not reading it, and no other file under a `reference` directory is the skill's."""
    def test_reading_a_reference_file_is_verification_activity(self):
        for n in REFS:
            for cmd in ("cat %s/%s" % (REF, n), "head -50 %s/%s" % (REF, n), "grep -n audit %s/%s" % (REF, n), "sed -n '1,20p' %s/%s" % (REF, n), "bash -c 'cat %s/%s'" % (REF, n), "cd %s && cat reference/%s" % (SKILL, n), "echo go && wc -c %s/%s" % (REF, n)):
                with self.subTest(cmd): self.assertEqual(cls(cmd), "yes", cmd)
            with self.subTest("relative to the recorded directory: " + n): self.assertEqual(cls("cat reference/%s" % n, SKILL), "yes")

    def test_a_mention_of_a_reference_file_is_not_activity(self):
        for n in REFS:
            for cmd in ("echo %s/%s" % (REF, n), "printf '%%s\\n' %s/%s" % (REF, n), "ls %s/%s" % (REF, n), "git diff -- %s/%s" % (REF, n), "cp %s/%s /tmp/copy.md" % (REF, n), "echo hi > %s/%s" % (REF, n), "grep -e %s/%s /virtual/file.txt" % (REF, n)):
                with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)

    def test_a_relative_path_into_the_skill_is_unknown_without_a_recorded_directory_and_a_bare_name_is_no(self):
        for n in REFS:
            with self.subTest(n):
                self.assertEqual(cls("cat skills/handoff-verify/reference/%s" % n, None), "unknown"); self.assertEqual(cls("cat ../handoff-verify/reference/%s" % n, None), "unknown")
                self.assertEqual(cls("cat reference/%s" % n, None), "no")      # as for a bare SKILL.md: every project has a `reference/report.md` of its own, the name alone proves nothing

    def test_homonyms_and_other_files_under_reference_are_not_the_skills(self):
        for n in REFS:
            for cmd in ("cat /other/reference/%s" % n, "cat /work/proj/reference/%s" % n, "cat /virtual/handoff-verify-copy/reference/%s" % n, "cat /virtual/other-skill/reference/%s" % n, "cat %s/reference/sub/%s" % (SKILL, n),
                        "cat %s/%s" % (SCRIPTS, n), "cat %s/%s" % (SKILL, n), "cat %s/%s.bak" % (REF, n)):
                with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)
        for other in ("README.md", "evidence.md", "notes.md", "prepare.py", "Report.md"):
            with self.subTest(other): self.assertEqual(cls("cat %s/%s" % (REF, other)), "no", other)      # only the five names count, never every file under reference/

class Options(unittest.TestCase):
    def test_a_pattern_given_as_an_option_argument_is_not_a_file_that_is_read(self):
        P = SCRIPTS + "/report.py"
        for cmd in ("grep -e %s /virtual/file.txt" % P, "grep --regexp=%s /virtual/file.txt" % P, "grep --regexp %s /virtual/file.txt" % P, "grep -ie %s /virtual/file.txt" % P, "grep -e%s /virtual/file.txt" % P,
                    "grep %s /virtual/file.txt" % P, "rg -e %s /virtual/file.txt" % P, "sed -e 's#%s#x#' /virtual/file.txt" % P, "sed -n '/%s/p' /virtual/file.txt" % P, "awk '/%s/' /virtual/file.txt" % P,
                    "grep -m 3 %s /virtual/file.txt" % P, "grep -A 2 -e %s /virtual/file.txt" % P):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "no", cmd)

    def test_a_file_that_is_really_read_through_an_option_or_operand_is_kept(self):
        P = SCRIPTS + "/report.py"
        for cmd in ("grep -f %s /virtual/file.txt" % P, "grep --file=%s /virtual/file.txt" % P, "grep --file %s /virtual/file.txt" % P, "grep -e x %s" % P, "grep x %s" % P, "grep -n -e x -- %s" % P,
                    "sed -f %s /virtual/file.txt" % P, "awk -f %s /virtual/file.txt" % P, "rg -e x %s" % P, "sed -n 1p %s" % P):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "yes", cmd)

class Flow(unittest.TestCase):
    def test_a_failed_or_background_cd_does_not_move_the_command(self):
        # `cd scripts || cmd` runs cmd only when cd failed, `cd scripts & cmd` moves a background process: the directory is NOT the scripts directory
        for cmd in ("cd scripts || python3 report.py", "cd scripts & python3 report.py", "cd scripts | python3 report.py"):
            with self.subTest(cmd):
                self.assertEqual(cls(cmd, SKILL), "no", cmd)                       # the recorded directory is the skill directory: report.py does not exist there
                self.assertEqual(cls(cmd, None), "unknown", cmd)                   # no recorded directory at all: not demonstrable
        self.assertEqual(cls("cd scripts || python3 report.py", SCRIPTS), "yes")    # cd fails there (no such directory), the script runs in the recorded directory
        self.assertEqual(cls("cd scripts && python3 report.py", SKILL), "yes")

    def test_a_cd_that_may_or_may_not_have_happened_leaves_the_directory_undemonstrated(self):
        self.assertEqual(cls("cd scripts || echo none; python3 report.py", SKILL), "unknown")
        self.assertEqual(cls("true || cd scripts; python3 report.py", SKILL), "unknown")
        self.assertEqual(cls("(cd scripts); python3 report.py", SKILL), "no")        # the group ended: the directory is the recorded one again

    def test_a_relative_path_without_a_directory_is_unknown_and_never_repaired(self):
        for p in ("../scripts/report.py", "scripts/report.py", "report.py", "./report.py"):
            with self.subTest(p):
                self.assertEqual(cls("python3 " + p, None), "unknown", p)
                self.assertEqual(omissions.skill_activity(dict(type="tool_use", id="x", name="Read", input=dict(file_path=p)), None), "unknown", p)
        for p in ("skills/handoff-verify/scripts/report.py", "../handoff-verify/scripts/report.py"):   # components that look like the skill's path are not a resolution: without a recorded directory nothing is invented
            with self.subTest(p):
                self.assertEqual(omissions.skill_activity(dict(type="tool_use", id="x", name="Read", input=dict(file_path=p)), None), "unknown", p)
                self.assertEqual(cls("python3 " + p, None), "unknown", p)
        self.assertEqual(omissions.skill_activity(dict(type="tool_use", id="x", name="Read", input=dict(file_path="docs/handoff-verify/notes.md")), None), "no")
        self.assertEqual(omissions.skill_activity(dict(type="tool_use", id="x", name="Read", input=dict(file_path="../scripts/report.py")), SCRIPTS), "yes")
        self.assertEqual(cls("python3 ../scripts/report.py", SCRIPTS), "yes")
        self.assertEqual(cls("python3 ../scripts/report.py", "/work/proj"), "no")

    def test_a_cd_followed_by_a_semicolon_or_newline_does_not_demonstrate_the_directory(self):
        # `;` and a newline run the next command also when the cd failed: only `&&` ties the next command to the new directory
        for cmd in ("cd %s; python3 report.py" % SCRIPTS, "cd %s\npython3 report.py" % SCRIPTS, "cd %s ; python3 omissions.py prepare" % SCRIPTS):
            with self.subTest(cmd): self.assertEqual(cls(cmd, "/work/proj"), "unknown", cmd)
        self.assertEqual(cls("cd %s && python3 report.py" % SCRIPTS, "/work/proj"), "yes")
        self.assertEqual(cls("cd %s; python3 %s/report.py" % (SCRIPTS, SCRIPTS), "/work/proj"), "yes")       # an absolute path does not depend on the directory
        self.assertEqual(cls("cd /tmp; python3 /work/x.py", "/work/proj"), "no")

    def test_unterminated_quotes_are_unknown_only_when_a_skill_script_is_named(self):
        self.assertEqual(cls("python3 'oops report.py", None), "unknown"); self.assertEqual(cls("python3 'oops toolkit.py", None), "no")

class Imports(unittest.TestCase):
    """A `python -c` payload is read syntactically (stdlib ast, nothing runs): an import statement is an import, a string or a comment that says so is not."""
    def test_a_literal_or_a_comment_is_not_an_import(self):
        for code in ('print("example import report")', "x = 'from versions import gate'", "# import report\nprint(1)", '"""import report"""', "print('sys.path.insert(0, \"%s\"); import report')" % SCRIPTS,
                     "import sys; print('sys.path.insert(0, \"%s\")'); import json"):
            with self.subTest(code): self.assertEqual(cls("python3 -c '%s'" % code.replace("'", "'\\''"), SCRIPTS), "no", code)

    def test_a_string_that_looks_like_a_path_change_does_not_put_the_directory_on_the_path(self):
        code = "import sys; print('sys.path.insert(0, \"%s\")'); import report" % SCRIPTS
        self.assertEqual(cls("python3 -c '%s'" % code, "/work/proj"), "no")                       # the directory is not on the import path: `report` is some other module
        self.assertEqual(cls("python3 -c 'import sys; sys.path.insert(0, \"%s\"); import report'" % SCRIPTS, "/work/proj"), "yes")

    def test_every_import_form_is_found(self):
        for code in ("import report", "import json, report", "from versions import gate", "import report.x as y", "def f():\n    import omissions\nf()", "try:\n    import jevref\nexcept ImportError:\n    pass", "__import__('report')",
                     "import importlib; importlib.import_module('versions')"):
            with self.subTest(code): self.assertEqual(cls("python3 -c '%s'" % code.replace("'", "'\\''"), SCRIPTS), "yes", code)

    def test_a_payload_that_is_not_python_is_unknown_only_when_it_names_a_script(self):
        self.assertEqual(cls("python3 -c 'import report +'", SCRIPTS), "no"); self.assertEqual(cls("python3 -c 'import (; report.py'", SCRIPTS), "unknown")

    def test_a_dynamic_import_path_or_text_is_not_demonstrated(self):
        self.assertEqual(cls("python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import report'", "/work/proj"), "unknown")
        self.assertEqual(cls("python3 -c 'exec(\"import report\")'", "/work/proj"), "unknown")
        self.assertEqual(cls("python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); print(1)'", "/work/proj"), "no")

class Redirects(unittest.TestCase):
    """`tool_io`: what a shell command READS and WRITES, canonical in the recorded cwd; literal redirects only."""
    def io(self, cmd, cwd="/virtual/reports"): return omissions.tool_io(dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd)), cwd)

    def test_readers_open_their_operands_in_the_recorded_cwd(self):
        self.assertEqual(self.io("cat a.md ./b.md ../c.md | head -3")["reads"], {"/virtual/reports/a.md", "/virtual/reports/b.md", "/virtual/c.md"})
        self.assertEqual(self.io("cd sub && cat a.md")["reads"], {"/virtual/reports/sub/a.md"})
        self.assertEqual(self.io("cd sub; cat a.md")["reads"], set())          # the directory is not demonstrated: nothing is placed
        self.assertEqual(self.io("cat < a.md")["reads"], {"/virtual/reports/a.md"})
        self.assertEqual(self.io("grep -e a.md b.md")["reads"], {"/virtual/reports/b.md"}); self.assertEqual(self.io("grep -f pats.txt b.md")["reads"], {"/virtual/reports/pats.txt", "/virtual/reports/b.md"})
        self.assertEqual(self.io("bash -c 'cat a.md'")["reads"], {"/virtual/reports/a.md"})

    def test_a_command_that_only_names_a_path_reads_nothing(self):
        for cmd in ("echo /virtual/reports/a.md", "printf '%s' a.md", "ls a.md", "git add a.md", "cp a.md b.md", "grep a.md", "echo hi > a.md"):
            with self.subTest(cmd): self.assertEqual(self.io(cmd)["reads"], set(), cmd)

    def test_literal_redirects_are_the_only_writes(self):
        o = self.io("printf x > a.md; echo y >> b.md")
        self.assertEqual((o["outs"], o["trunc"]), ({"/virtual/reports/a.md", "/virtual/reports/b.md"}, {"/virtual/reports/a.md"}))
        for cmd in ("printf x > \"$OUT\"", "printf x > ~/a.md", "printf x > *.md", "false || printf x > a.md", "printf x > a.md &", "printf x | tee a.md", "printf x 2>&1", "printf x > /dev/null", "cat <<EOF\nx\nEOF"):
            with self.subTest(cmd): self.assertEqual(self.io(cmd)["outs"], set(), cmd)

def io_of(cmd, cwd="/virtual/reports"): return omissions.tool_io(dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd)), cwd)
R = "/virtual/reports/"

class QuotedOperators(unittest.TestCase):
    """A quoted or escaped `>` `;` `&&` `|` `(` is an argument of the command, never a redirect or a separator; the real operators and the real redirect targets (also quoted ones) are kept."""
    def test_a_quoted_or_escaped_operator_is_an_argument(self):
        for cmd in ("echo '>' prior.verify.md", 'echo x ">" a.md', "printf '%s' '>>' a.md", "echo x \\> a.md", "echo 'a;b' c", "echo '&&' a.md", "echo '|' a.md", "echo \"(\" a.md", "echo '>' > /dev/null", "echo 'x > y.md'"):
            with self.subTest(cmd): self.assertEqual(io_of(cmd)["outs"], set(), cmd)

    def test_a_quoted_operator_is_still_an_argument_of_a_reader(self):
        self.assertEqual(io_of("cat '<' a.md")["reads"], {R + "<", R + "a.md"})     # `<` is a file NAME here, not an input redirect; the only redirect-free reading
        self.assertEqual(io_of("cat '>' a.md")["outs"], set())
        self.assertEqual(cls("echo ';' python3 %s/report.py" % SCRIPTS), "no")

    def test_a_real_redirect_stays_real_also_with_a_quoted_target(self):
        for cmd, want in (("printf REAL > prior.verify.md", {R + "prior.verify.md"}), ("printf REAL >'a b.md'", {R + "a b.md"}), ("printf REAL > \"a b.md\"", {R + "a b.md"}), ("printf '>' > a.md", {R + "a.md"}), ("echo '>' && printf x > a.md", {R + "a.md"})):
            with self.subTest(cmd): self.assertEqual(io_of(cmd)["outs"], want, cmd)

    def test_a_character_used_as_an_internal_marker_is_an_ordinary_argument(self):
        for ch in ("\ue000", "\ue001", "\ue006", "\uf8ff"):
            with self.subTest(ch):
                self.assertEqual(io_of("echo '%s>' a.md" % ch)["outs"], set()); self.assertEqual(io_of("echo %s a.md > b.md" % ch)["outs"], {R + "b.md"})
                self.assertEqual(io_of("cat '%s;' a.md" % ch)["reads"], {R + "%s;" % ch, R + "a.md"})

class Conditions(unittest.TestCase):
    """`tool_io`: a segment counts only when it demonstrably ran. `outs` / `reads` = what runs unconditionally or follows `&&` up to the end of the command (the whole call succeeded); `reads_always` = unconditional only. The
    global success of a call proves the last `&&` chain, never a segment behind `||`, `&`, `|` or followed by `;`."""
    def outs(self, cmd): return io_of(cmd)["outs"]

    def test_a_redirect_that_the_exit_status_may_have_skipped_is_not_demonstrated(self):
        for cmd in ("false && printf REAL > prior.verify.md; true", "true && printf x > a.md; echo done", "test -f x && printf x > a.md || echo none", "false || printf x > a.md", "true && printf x > a.md &", "printf x | true && printf y > a.md; true",
                    "(true && printf x > a.md); echo", "false && (printf x > a.md); true"):
            with self.subTest(cmd): self.assertEqual(self.outs(cmd), set(), cmd)

    def test_a_redirect_that_ran_whenever_the_call_succeeded_is_kept(self):
        for cmd, want in (("true && printf x > a.md", {R + "a.md"}), ("cd sub && printf x > a.md", {R + "sub/a.md"}), ("true && printf x > a.md && echo done", {R + "a.md"}), ("printf x > a.md || true", {R + "a.md"}), ("printf x > a.md; true", {R + "a.md"}),
                          ("(cd sub && printf x > a.md)", {R + "sub/a.md"}), ("(true && printf x > a.md)", {R + "a.md"}), ("true && (printf x > a.md)", {R + "a.md"}), ("false; printf x > a.md", {R + "a.md"}), ("printf x > a.md\necho done", {R + "a.md"})):
            with self.subTest(cmd): self.assertEqual(self.outs(cmd), want, cmd)

    def test_the_condition_of_a_group_reaches_the_commands_inside(self):
        for cmd in ("false || (printf x > a.md)", "false && (printf x > a.md; true); echo", "true || (printf x > a.md)", "true && (printf x > a.md; true); echo", "(printf x > a.md) &", "false || { printf x > a.md; }"):
            with self.subTest(cmd): self.assertEqual(self.outs(cmd), set(), cmd)
        self.assertEqual(self.outs("true; (printf x > a.md; true)"), {R + "a.md"})       # a `;` inside does not erase the demonstrated execution of the group
        self.assertEqual(self.outs("false && (printf x > a.md; true)"), {R + "a.md"})    # the call can only have succeeded if the group ran (the chain `&&` ends with it)

    def test_bash_c_carries_the_condition_of_the_command_around_it(self):
        for cmd in ("false || bash -c 'printf x > a.md'", "bash -c 'false || printf x > a.md'", "false && bash -c 'printf x > a.md'; true", "bash -c 'true && printf x > a.md; true'", "bash -c 'printf x > a.md' &", "echo | bash -c 'printf x > a.md' || true; false",
                    "true || bash -c 'printf x > a.md'", "bash -c 'false && bash -c \"printf x > a.md\"; true'"):
            with self.subTest(cmd): self.assertEqual(self.outs(cmd), set(), cmd)
        for cmd, want in (("true && bash -c 'printf x > a.md'", {R + "a.md"}), ("bash -c 'printf x > a.md'", {R + "a.md"}), ("bash -c 'bash -c \"printf x > a.md\"'", {R + "a.md"}), ("bash -c 'cd sub && printf x > a.md'", {R + "sub/a.md"}),
                          ("bash -c 'true && printf x > a.md' || true", set())):
            with self.subTest(cmd): self.assertEqual(self.outs(cmd), want, cmd)

    def test_a_read_that_may_not_have_happened_is_not_a_read(self):
        for cmd in ("false && cat prior.verify.md; printf REAL", "false || cat a.md", "test -f a.md && cat a.md; true", "false && bash -c 'cat a.md'; true", "false && (cat a.md); true", "false && grep x a.md; echo", "false && cat < a.md; true"):
            with self.subTest(cmd): self.assertEqual(io_of(cmd)["reads"], set(), cmd)
        for cmd in ("cat a.md || true", "cat a.md; printf REAL", "cat a.md | head -3", "bash -c 'cat a.md'", "(cat a.md)", "cat < a.md"):
            with self.subTest(cmd): self.assertEqual((io_of(cmd)["reads"], io_of(cmd)["reads_always"]), ({R + "a.md"},) * 2, cmd)

    def test_a_read_that_followed_a_success_is_only_demonstrated_when_the_call_succeeded(self):
        o = io_of("true && cat a.md"); self.assertEqual((o["reads"], o["reads_always"]), ({R + "a.md"}, set()))
        o = io_of("cd sub && cat a.md"); self.assertEqual((o["reads"], o["reads_always"]), ({R + "sub/a.md"}, set()))
        o = io_of("true && bash -c 'cat a.md'"); self.assertEqual((o["reads"], o["reads_always"]), ({R + "a.md"}, set()))

    def test_truncation_and_append_follow_the_same_demonstration(self):
        o = io_of("false && printf x > a.md; printf y >> b.md; true"); self.assertEqual((o["outs"], o["trunc"]), ({R + "b.md"}, set()))
        o = io_of("true && printf x > a.md"); self.assertEqual((o["outs"], o["trunc"]), ({R + "a.md"}, {R + "a.md"}))

    def test_the_activity_classifier_is_unchanged_by_the_conditions(self):
        for cmd, want in (("false && python3 %s/report.py" % SCRIPTS, "yes"), ("echo '>' %s/report.py" % SCRIPTS, "no"), ("echo x '|' python3 %s/report.py" % SCRIPTS, "no"), ("true || cat %s/SKILL.md" % SKILL, "yes")):
            with self.subTest(cmd): self.assertEqual(cls(cmd), want, cmd)

def pcls(code, cwd="/work/proj"): return cls("python3 -c '%s'" % code.replace("'", "'\\''"), cwd)
IMP = "import sys\nsys.path.insert(0, '%s')\n" % SCRIPTS

class ImportOrder(unittest.TestCase):
    """The import evidence of a `python -c` payload is read in the order and context it would run (stdlib ast, nothing executes): a definition that is never called, a `sys.path` change that comes later and a local callable
    named `import_module` demonstrate nothing; a call of the definition runs its body with the path of THAT moment."""
    def test_a_definition_that_is_never_called_is_not_an_import(self):
        for code in ("def f():\n    import report", "class C:\n    def m(self):\n        import report", "def f():\n    __import__('report')", "async def f():\n    import report",
                     "def f():\n    import report\ndef g():\n    f()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)

    def test_a_definition_that_is_called_runs_its_body(self):
        for code in ("def f():\n    import report\nf()", "def f():\n    import report\ndef g():\n    f()\ng()", "g = lambda: __import__('report')\ng()", "(lambda: __import__('report'))()", "def f():\n    import report\nx = f()",
                     "class C:\n    import report", "def f(a=1):\n    import report\nf(2)"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)

    def test_a_path_change_that_comes_later_does_not_resolve_an_import_backwards(self):
        for code in ("import report\nimport sys\nsys.path.insert(0, '%s')" % SCRIPTS, "def f():\n    import report\nf()\nimport sys\nsys.path.insert(0, '%s')" % SCRIPTS, "import sys\nimport report\nsys.path.append('%s')" % SCRIPTS):
            with self.subTest(code): self.assertEqual(pcls(code, "/work/proj"), "no", code)
        self.assertEqual(pcls(IMP + "import report"), "yes"); self.assertEqual(pcls(IMP + "def f():\n    import report\nf()"), "yes")
        self.assertEqual(pcls("import sys\ndef f():\n    import report\nsys.path.insert(0, '%s')\nf()" % SCRIPTS), "yes")      # the body runs at the call, with the path of that moment
        self.assertEqual(pcls("import sys\ndef f():\n    import report\nf()\nsys.path.insert(0, '%s')" % SCRIPTS), "no")

    def test_a_path_change_inside_a_definition_that_is_never_called_changes_nothing(self):
        self.assertEqual(pcls("import sys\ndef f():\n    sys.path.insert(0, '%s')\nimport report" % SCRIPTS), "no")
        self.assertEqual(pcls("import sys\ndef f():\n    sys.path.insert(0, '%s')\nf()\nimport report" % SCRIPTS), "yes")
        self.assertEqual(pcls("import sys\ndef f():\n    sys.path.insert(0, sys.argv[1])\nimport report", SCRIPTS), "yes")      # never called: no dynamic path change happened

    def test_a_local_callable_named_import_module_is_not_importlib(self):
        for code in ("def import_module(n):\n    pass\nimport_module('report')", "import_module = lambda n: None\nimport_module('report')", "class X:\n    def import_module(self, n): pass\nX().import_module('report')", "x = object()\nx.import_module('report')",
                     "def __import__(n): pass\n__import__('report')", "import importlib\ndef import_module(n): pass\nimportlib = None\nimport_module('report')", "def f(import_module):\n    import_module('report')\nf(print)", "from os import path as import_module\nimport_module('report')"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)

    def test_the_authentic_dynamic_imports_are_kept(self):
        for code in ("import importlib\nimportlib.import_module('report')", "import importlib as il\nil.import_module('versions')", "from importlib import import_module\nimport_module('report')", "from importlib import import_module as im\nim('report')",
                     "import importlib\nm = importlib.import_module\nm('report')", "__import__('report')", "i = __import__\ni('report')", "import importlib\nimportlib.import_module('report.x')"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)
        self.assertEqual(pcls("importlib.import_module('report')", SCRIPTS), "no")      # `importlib` is not bound: the payload would fail with a NameError before importing anything

    def test_what_may_or_may_not_run_is_unknown_and_what_runs_is_yes(self):
        for code in ("import sys\nif sys.argv:\n    import report", "for x in []:\n    import report", "while x:\n    import report", "try:\n    pass\nexcept Exception:\n    import report", "x = 1 if y else __import__('report')",
                     "def f():\n    import report\nimport atexit\natexit.register(f)", "def f():\n    import report\n    return 1\nprint(f)", "def f():\n    import report\nlist(map(f, [1]))", "def d(g): return g\n@d\ndef f():\n    import report", "y and __import__('report')", "[__import__('report') for _ in z]"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)
        for code in ("try:\n    import report\nexcept ImportError:\n    pass", "with open('x') as f:\n    import report", "if True:\n    import report", "try:\n    pass\nfinally:\n    import report", "if False:\n    pass\nelse:\n    import report"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)
        self.assertEqual(pcls("if False:\n    import report", SCRIPTS), "no")      # a constant test: the branch cannot run

    def test_a_path_change_that_may_not_have_happened_leaves_the_directory_undemonstrated(self):
        self.assertEqual(pcls("import sys\nif sys.argv:\n    sys.path.insert(0, '%s')\nimport report" % SCRIPTS), "unknown")
        self.assertEqual(pcls("import sys\nsys.path.insert(0, sys.argv[1])\nimport report"), "unknown")
        self.assertEqual(pcls("import report\nimport sys\nsys.path.insert(0, sys.argv[1])", SCRIPTS), "yes")      # a dynamic change AFTER the import cannot undo it
        self.assertEqual(pcls("import sys\nsys.path.insert(0, sys.argv[1])\nimport json", "/work/proj"), "no")

    def test_exec_is_unknown_only_when_it_can_run(self):
        self.assertEqual(pcls("exec('import report')", "/work/proj"), "unknown")
        self.assertEqual(pcls("def f():\n    exec('import report')", "/work/proj"), "no")
        self.assertEqual(pcls("def f():\n    exec('import report')\nf()", "/work/proj"), "unknown")
        self.assertEqual(pcls("if x:\n    exec('import report')", "/work/proj"), "unknown")

    def test_recursion_and_odd_payloads_terminate_without_a_guess(self):
        for code in ("def f():\n    f()\nf()", "def f():\n    g()\ndef g():\n    f()\nf()", "def f():\n    import report\n    f()\nf()", "f = f\nf()", "class C(C): pass", "\n".join("def f%d():\n    f%d()" % (i, i + 1) for i in range(30)) + "\nf0()"):
            with self.subTest(code[:30]): self.assertIn(pcls(code, SCRIPTS), ("no", "yes", "unknown"))
        self.assertEqual(pcls("def f():\n    import report\n    f()\nf()", SCRIPTS), "yes")
        self.assertEqual(pcls("def f():\n    f()\nf()", SCRIPTS), "no")

    def test_what_runs_when_a_definition_is_defined_is_part_of_the_flow(self):
        for code in ("def f(a=__import__('report')):\n    pass", "f = lambda a=__import__('report'): a", "class C:\n    x = __import__('report')", "class C:\n    def m(self, a=__import__('report')): pass", "def a():\n    def b():\n        import report\n    b()\na()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)
        for code in ("def f():\n    return 1\n    import report\nf()", "def f(sys):\n    sys.path.insert(0, '%s')\nf(1)\nimport json" % SCRIPTS):
            with self.subTest(code): self.assertEqual(pcls(code, "/work/proj"), "no", code)
        for code in ("def f():\n    if x:\n        return 1\n    import report\nf()", "match x:\n    case 1:\n        import report", "async def m():\n    import report\nm()", "import functools\n@functools.cache\ndef f():\n    import report"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)

    def test_the_cwd_and_pythonpath_demonstrations_are_kept(self):
        self.assertEqual(cls("PYTHONPATH=%s python3 -c 'def f():\n    import report\nf()'" % SCRIPTS, "/work/proj"), "yes")
        self.assertEqual(cls("PYTHONPATH=%s python3 -c 'def f():\n    import report'" % SCRIPTS, "/work/proj"), "no")
        self.assertEqual(pcls("def f():\n    import report\nf()", SCRIPTS), "yes"); self.assertEqual(pcls("def f():\n    import report\nf()", "/work/proj"), "no")


class BranchBindings(unittest.TestCase):
    """What a MAYBE branch (condition, loop, handler, case, `a and b`) binds is only MAYBE bound afterwards: the alternatives are read apart from each other and joined conservatively; a name that is local to a function
    is not the outer one before its own assignment, and `global` / `nonlocal` send the binding where Python does."""
    def test_a_binding_made_in_a_branch_is_not_a_certain_binding(self):
        for code in ("import sys\nif sys.argv[1:]:\n    import importlib\nimportlib.import_module('report')",
                     "import sys\nif sys.argv[1:]:\n    from importlib import import_module\nimport_module('report')",
                     "import sys\nif sys.argv[1:]:\n    def import_module(n): pass\nelse:\n    from importlib import import_module\nimport_module('report')",
                     "import sys\nif sys.argv[1:]:\n    from importlib import import_module\nelse:\n    import_module = lambda n: None\nimport_module('report')",
                     "for x in y:\n    import importlib\nimportlib.import_module('report')",
                     "try:\n    pass\nexcept Exception:\n    import importlib\nimportlib.import_module('report')",
                     "import sys\nx = sys.argv[1:] and __import__('report')", "import sys\nsys.argv[1:] and exec('import report')"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)

    def test_a_definition_introduced_by_a_condition_is_maybe_defined(self):
        for code in ("import sys\nif sys.argv[1:]:\n    def f():\n        import report\nf()", "import sys\nif sys.argv[1:]:\n    def f():\n        import report\nelse:\n    def f():\n        pass\nf()",
                     "import sys\nwhile sys.argv[1:]:\n    def f():\n        import report\nf()", "import sys\ntry:\n    pass\nexcept Exception:\n    def f():\n        import report\nf()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)
        self.assertEqual(pcls("import sys\nif sys.argv[1:]:\n    def f():\n        import report\n    f()", SCRIPTS), "unknown")      # called in the branch: the call is MAYBE too
        self.assertEqual(pcls("import sys\nif sys.argv[1:]:\n    def f():\n        import report\n", SCRIPTS), "no")        # never called

    def test_the_branches_do_not_contaminate_each_other_and_the_certain_bindings_stay(self):
        self.assertEqual(pcls("import sys\nfrom importlib import import_module\nif sys.argv[1:]:\n    import_module = lambda n: None\nelse:\n    pass\nimport_module('report')", SCRIPTS), "unknown")
        self.assertEqual(pcls("import sys\nif sys.argv[1:]:\n    import_module = lambda n: None\nelse:\n    from importlib import import_module\n    import_module('report')", SCRIPTS), "unknown")
        for code in ("import importlib\nimportlib.import_module('report')", "import sys\nimport importlib\nif sys.argv[1:]:\n    pass\nimportlib.import_module('report')",
                     "import sys\nif sys.argv[1:]:\n    pass\nelse:\n    pass\nimport importlib\nimportlib.import_module('report')", "import importlib\nimport sys\nif sys.argv[1:]:\n    x = 1\nimportlib.import_module('report')"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)
        self.assertEqual(pcls("import sys\nif sys.argv[1:]:\n    import importlib\nelse:\n    import importlib\nimportlib.import_module('report')", SCRIPTS), "yes")      # bound the same way in every alternative
        self.assertEqual(pcls("import sys\nif sys.argv[1:]:\n    import importlib\nimportlib.import_module('json')", SCRIPTS), "no")      # nothing of the skill is named

    def test_a_local_name_is_not_the_outer_one_before_its_own_assignment(self):
        for code in ("from importlib import import_module\ndef f():\n    import_module('report')\n    import_module = lambda n: None\nf()",
                     "import importlib\ndef f():\n    importlib.import_module('report')\n    importlib = None\nf()",
                     "from importlib import import_module\ndef f():\n    import_module('report')\n    from os import path as import_module\nf()",
                     "from importlib import import_module\ndef f():\n    import_module('report')\n    for import_module in []:\n        pass\nf()"):
            with self.subTest(code): self.assertNotEqual(pcls(code, SCRIPTS), "yes", code)
        for code in ("from importlib import import_module\ndef f():\n    import_module = lambda n: None\n    import_module('report')\nf()",
                     "from importlib import import_module\ndef f(import_module):\n    import_module('report')\nf(print)",
                     "from importlib import import_module\ndef f():\n    def import_module(n): pass\n    import_module('report')\nf()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)
        for code in ("from importlib import import_module\ndef f():\n    import_module('report')\nf()", "import importlib\ndef f():\n    importlib.import_module('report')\nf()",
                     "from importlib import import_module\ndef f():\n    x = 1\n    import_module('report')\nf()", "def f():\n    from importlib import import_module\n    import_module('report')\nf()",
                     "import sys\nfrom importlib import import_module\ndef f():\n    for _ in sys.argv:\n        pass\n    import_module('report')\nf()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)

    def test_global_and_nonlocal_declarations_are_respected(self):
        for code in ("from importlib import import_module\ndef f():\n    global import_module\n    import_module = lambda n: None\nf()\nimport_module('report')",
                     "import importlib\ndef f():\n    global importlib\n    importlib = None\nf()\nimportlib.import_module('report')"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)      # the global was rebound by the call that surely ran
        OUTER = "from importlib import import_module\ndef outer():\n    import_module = lambda n: None\n    def inner():\n        nonlocal import_module\n        import_module = __import__\n    %s\n    import_module('report')\nouter()"
        self.assertEqual(pcls(OUTER % "inner()", SCRIPTS), "yes")      # nonlocal: the enclosing binding is the one that changed
        self.assertEqual(pcls(OUTER % "pass", SCRIPTS), "no")
        self.assertEqual(pcls(OUTER % "import sys\n    if sys.argv[1:]:\n        inner()", SCRIPTS), "unknown")
        self.assertEqual(pcls("from importlib import import_module\ndef f():\n    global import_module\n    import_module = lambda n: None\nf()\nimport_module('report')", SCRIPTS), "no")
        self.assertEqual(pcls("def f():\n    global im\n    from importlib import import_module as im\nf()\nim('report')", SCRIPTS), "yes")      # a global binding that is made and used
        self.assertEqual(pcls("def f():\n    from importlib import import_module as im\nf()\nim('report')", SCRIPTS), "no")      # without `global` the binding stays local
        self.assertEqual(pcls("from importlib import import_module\ndef f():\n    import_module = print\nf()\nimport_module('report')", SCRIPTS), "yes")      # a local assignment leaves the global alone
        self.assertEqual(pcls("import sys\ndef f():\n    global im\n    from importlib import import_module as im\nif sys.argv[1:]:\n    f()\nim('report')", SCRIPTS), "unknown")


class CreationIsNotExecution(unittest.TestCase):
    """Creating a callable or an iterator does not run its body: a lambda that is thrown away, a generator function that is called and never consumed, a generator expression that is only built."""
    def test_a_lambda_that_is_only_created_does_not_run(self):
        for code in ("lambda: __import__('report')", "(lambda: __import__('report'))", "f = lambda: __import__('report')", "lambda: __import__('report')\nx = 1"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)
        for code in ("(lambda: __import__('report'))()", "g = lambda: __import__('report')\ng()", "print(lambda: __import__('report'))", "import atexit\natexit.register(lambda: __import__('report'))", "[lambda: __import__('report')][0]()"):
            with self.subTest(code): self.assertIn(pcls(code, SCRIPTS), ("yes", "unknown"), code)
        self.assertEqual(pcls("(lambda: __import__('report'))()", SCRIPTS), "yes"); self.assertEqual(pcls("lambda a=__import__('report'): a", SCRIPTS), "yes")      # the default runs at creation

    def test_a_generator_function_that_is_called_does_not_run_its_body(self):
        for code in ("def f():\n    yield 1\n    import report\nf()", "def f():\n    yield 1\n    import report\nf()\nf()", "def f():\n    import report\n    yield 1\nf()", "async def f():\n    yield 1\n    import report\nf()",
                     "def f():\n    yield from []\n    import report\nf()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)
        for code in ("def f():\n    yield 1\n    import report\nlist(f())", "def f():\n    yield 1\n    import report\nfor _ in f():\n    pass", "def f():\n    import report\n    yield 1\ng = f()\nnext(g)",
                     "def f():\n    yield 1\n    import report\nx = f()", "def f():\n    import report\n    yield 1\nprint(f())"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)
        self.assertEqual(pcls("def f():\n    import report\n    return 1\nf()", SCRIPTS), "yes")      # an ordinary function still runs when called
        self.assertEqual(pcls("def f():\n    def g():\n        yield 1\n    import report\nf()", SCRIPTS), "yes")      # a yield in a nested definition does not make f a generator

    def test_a_generator_lambda_that_is_called_does_not_run_its_body(self):
        for code in ("(lambda: (__import__('report'), (yield 1)))()", "(lambda: (yield 1, __import__('report')))()", "f = lambda: (__import__('report'), (yield 1))\nf()", "(lambda: (yield from __import__('report')))()"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "no", code)
        for code in ("g = (lambda: (__import__('report'), (yield 1)))()", "list((lambda: (__import__('report'), (yield 1)))())", "f = lambda: (__import__('report'), (yield 1))\nx = f()", "print((lambda: (__import__('report'), (yield 1)))())"):
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "unknown", code)
        for code in ("(lambda x=__import__('report'): (yield 1))()", "(lambda a: (yield 1))(__import__('report'))"):      # a default and an argument are evaluated by the call itself
            with self.subTest(code): self.assertEqual(pcls(code, SCRIPTS), "yes", code)
        self.assertEqual(pcls("(lambda: (__import__('report'), 1))()", SCRIPTS), "yes")      # an ordinary lambda still runs when called

    def test_a_name_that_a_lambda_assigns_is_local_in_the_whole_lambda(self):
        pre = "from importlib import import_module\n"
        self.assertEqual(pcls(pre + "(lambda: (import_module('report'), (import_module := lambda n: None)))()", SCRIPTS), "unknown")      # the first call is not the outer import
        self.assertEqual(pcls(pre + "f = lambda: (import_module('report'), (import_module := lambda n: None))\nf()", SCRIPTS), "unknown")
        self.assertEqual(pcls(pre + "(lambda: ((import_module := lambda n: None), import_module('report')))()", SCRIPTS), "no")      # a demonstrable local callable
        self.assertEqual(pcls(pre + "(lambda import_module: import_module('report'))(len)", SCRIPTS), "no")      # a parameter
        self.assertEqual(pcls(pre + "(lambda: import_module('report'))()", SCRIPTS), "yes")      # the outer import is authentic when nothing is local

    def test_a_generator_expression_that_is_only_built_does_not_run(self):
        self.assertEqual(pcls("(__import__('report') for _ in [1])", SCRIPTS), "no")
        self.assertEqual(pcls("(1 for _ in __import__('report').x)", SCRIPTS), "yes")      # the first iterable is evaluated at creation
        self.assertEqual(pcls("list(__import__('report') for _ in [1])", SCRIPTS), "unknown")
        self.assertEqual(pcls("g = (__import__('report') for _ in [1])\nlist(g)", SCRIPTS), "unknown")


class MarkerCollisions(unittest.TestCase):
    """The lexer needs no spare character: a command that contains every private-use character is tokenised like any other."""
    ALL = "".join(chr(c) for c in range(0xE000, 0xF900))

    def test_a_command_holding_the_whole_private_use_block_keeps_its_arguments(self):
        r = io_of("cat " + self.ALL + " a.md"); self.assertEqual(r["reads"], {R + self.ALL, R + "a.md"})
        self.assertEqual(io_of("echo '" + self.ALL + ">' a.md")["outs"], set()); self.assertEqual(io_of("echo " + self.ALL + " a.md > b.md")["outs"], {R + "b.md"})
        self.assertEqual(io_of("printf x > '" + self.ALL + "'")["outs"], {R + self.ALL})

    def test_fewer_than_seven_characters_available_still_works(self):
        for keep in (6, 3, 1, 0):
            free = self.ALL[:keep]; used = self.ALL[keep:]
            with self.subTest(keep):
                self.assertEqual(io_of("cat '" + used + ";' a.md")["reads"], {R + used + ";", R + "a.md"})
                self.assertEqual(io_of("echo '" + used + free + "(' a.md; printf x > b.md")["outs"], {R + "b.md"})
                self.assertEqual(io_of("echo \\> " + used + " > c.md")["outs"], {R + "c.md"})
        self.assertEqual(cls("echo " + self.ALL + "; python3 %s/report.py" % SCRIPTS), "yes")
        self.assertEqual(cls("echo '" + self.ALL + ";' python3 %s/report.py" % SCRIPTS), "no")

    def test_the_real_operators_still_work_next_to_the_escape_character(self):
        self.assertEqual(io_of("false && printf x > a.md; true"), dict(reads=frozenset(), reads_always=frozenset(), outs=frozenset(), trunc=frozenset()))
        self.assertEqual(io_of("true && printf x > \ue000a.md")["outs"], {R + "\ue000a.md"}); self.assertEqual(io_of("echo \ue000 \ue0000 'a;b' \\; printf x > a.md")["outs"], {R + "a.md"})


if __name__ == "__main__": unittest.main()

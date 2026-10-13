#!/usr/bin/env python3
"""Offline test of the command-substitution rule of the shell classifier (stdlib only, nothing is executed; all fixtures are invented; the hole was found by a probe, not seen in a transcript). `python3 $(pwd)/scripts/audit.py` is cut by the tokeniser into the words `python3 $`, a group `( pwd )` and the word `/scripts/audit.py`: no
segment runs a skill script, so the command used to be classified `no` ("not skill activity") although the shell runs the skill script. A `no` is the one answer the source window trusts, so that was a fail-open. A command substitution (`$( ... )`, `$(( ... ))`, backticks), outside single
quotes, is now also replaced by one unresolvable variable and the command is classified once more; `yes` stays `yes`, otherwise the more severe of the two answers wins (`unknown` over `no`). A path that cannot be resolved stays `unknown` exactly as a shell variable does.
The table is EXHAUSTIVE over three factors (strength t = 3, because the factors interact: the form of the substitution, where it stands in the path and what the command does with the path; 8 x 6 x 7 = 336 commands are cheap, so no sampling is used).
usage: python3 -B test_shell_subst.py [-v]"""
import itertools, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions

SKILL = "/virtual/handoff-verify"
CWD = "/work/proj"

def cls(cmd, cwd=CWD): return omissions.skill_activity(dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd)), cwd)

def cls_before(cmd, cwd=CWD):
    """The class the command had BEFORE the substitution rule existed (the rule switched off): the control for every case that must stay as it was."""
    real = omissions._flatten_subst; omissions._flatten_subst = lambda text: (text, 0)
    try: return cls(cmd, cwd)
    finally: omissions._flatten_subst = real

FORMS = {"dollar_paren": "$(pwd)", "backtick": "`pwd`", "with_args": "$(dirname /x/y)", "nested": "$(echo $(pwd))", "arith": "$((1+1))", "quoted_paren": '$(echo ")")', "escaped_paren": "$(echo \\))", "escaped_quote": '$(echo "a\\")")'}
# where the substitution stands in the path that names the script: the whole front, the middle, or not in the path at all (a plain argument)
PLACES = {"front": "{F}/scripts/audit.py", "middle": SKILL + "/{F}/audit.py", "argument": SKILL + "/scripts/audit.py --note {F}", "double_front": '"{F}/scripts/audit.py"', "double_middle": '"' + SKILL + '/{F}/audit.py"', "single_front": "'{F}/scripts/audit.py'"}
# command word -> (what it does with the path, a template)
USES = {"python": "python3 -B {P} template", "python_module_path": "python {P}", "bash": "bash {P}", "direct": "{P} template", "cat": "cat {P}", "echo": "echo {P}", "git_add": "git add {P}"}
RUNS = ("python", "python_module_path", "bash", "direct", "cat")      # they run or read the path as a skill file; echo and git only name it

def expected(use, place, form):
    """The class the table demands, derived from the three factors alone (not from the code under test)."""
    if place == "argument": return "yes" if use in RUNS else "no"                                  # the script word is a literal absolute path; the substitution is only an argument
    if place == "single_front": return "unknown" if use in RUNS and "$" in FORMS[form] else "no"   # nothing is substituted: `$(pwd)/scripts/audit.py` still holds a `$` (undecided, as before), while a literal "`pwd`/scripts/audit.py" is an ordinary relative path
    return "unknown" if use in RUNS else "no"                                                      # the path cannot be resolved: a runner or reader leaves it undecided, a naming-only command does not run it

class Table(unittest.TestCase):
    def test_exhaustive_form_place_and_use(self):
        n = 0
        for form, place, use in itertools.product(FORMS, PLACES, USES):
            cmd = USES[use].replace("{P}", PLACES[place].replace("{F}", FORMS[form])); got = cls(cmd)
            with self.subTest(form=form, place=place, use=use): self.assertEqual(got, expected(use, place, form), cmd)
            n += 1
        self.assertEqual(n, 8 * 6 * 7)

    def test_a_tail_that_is_already_a_whole_skill_path_was_and_stays_yes(self):
        cmd = "python3 $(git rev-parse --show-toplevel)/skills/handoff-verify/scripts/audit.py x"      # the old tokeniser left the path whole after the group
        self.assertEqual((cls_before(cmd), cls(cmd)), ("yes", "yes"))

    def test_the_fail_open_found_by_a_probe_is_closed(self):
        for cmd in ("python3 $(pwd)/scripts/audit.py template", "python3 `pwd`/scripts/audit.py template", "python3 -B $(dirname $0)/audit.py x", "$(pwd)/scripts/audit.py", "python3 $(git rev-parse --show-toplevel)/scripts/audit.py x"):
            with self.subTest(cmd):
                self.assertEqual(cls_before(cmd), "no", cmd)      # the control: it WAS undecided-as-not-activity
                self.assertEqual(cls(cmd), "unknown", cmd)

class Unchanged(unittest.TestCase):
    CORPUS = ("python3 -B " + SKILL + "/scripts/prepare.py --cwd /work/proj", "echo $(pwd)", "echo $(pwd) && python3 -B " + SKILL + "/scripts/report.py", "cd $(mktemp -d) && ls", "git commit -m \"$(cat <<'X'\nmessage\nX\n)\"",
              "N=$(wc -l < " + SKILL + "/scripts/audit.py); echo $N", "python3 -B " + SKILL + "/scripts/audit.py $(cat /work/proj/args.txt)", "echo '$(pwd)/scripts/audit.py' > /work/proj/out.txt", "printf '%s' `date` > /work/proj/d.txt",
              "ls $(dirname " + SKILL + ")", "grep -n x $(ls /work/proj)", "python3 -c 'print(1)' | head", "echo $((2*3))", "cat /work/proj/a.txt | tr a b")

    def test_commands_that_name_no_skill_path_through_a_substitution_keep_their_class(self):
        for cmd in self.CORPUS:
            with self.subTest(cmd): self.assertEqual(cls(cmd), cls_before(cmd), cmd)

    def test_a_substitution_only_inside_single_quotes_is_not_a_substitution(self):
        self.assertEqual(omissions._flatten_subst("echo '$(pwd)' `x`"), ("echo '$(pwd)' $-", 1))
        self.assertEqual(omissions._flatten_subst("echo \\$(pwd) \"$(a) $(b)\""), ("echo \\$(pwd) \"$- $-\"", 2))
        self.assertEqual(omissions._flatten_subst("echo $((1+(2*3))) $(a $(b) c)"), ("echo $- $-", 2))
        self.assertEqual(omissions._flatten_subst("echo plain"), ("echo plain", 0))

    def test_an_unclosed_substitution_that_mentions_the_skill_is_undecided_and_otherwise_untouched(self):
        self.assertEqual(omissions._flatten_subst("echo $(pwd"), None)
        self.assertEqual(omissions._flatten_subst("echo `pwd"), None)
        self.assertEqual(cls("python3 $(pwd/scripts/audit.py"), "unknown")
        self.assertEqual(cls("echo $(pwd"), cls_before("echo $(pwd"))

    def test_an_apostrophe_inside_double_quotes_does_not_hide_a_later_substitution(self):
        for cmd in ('echo "it\'s" && python3 -B $(pwd)/scripts/audit.py "it\'s"', 'echo "a\'b" "c" && python3 -B `pwd`/scripts/audit.py "d\'e"'):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)
        self.assertEqual(omissions._flatten_subst('echo "it\'s" $(x) \'$(y)\''), ('echo "it\'s" $- \'$(y)\'', 1))

    def test_yes_stays_yes_and_a_command_inside_the_substitution_is_still_seen(self):
        self.assertEqual(cls("echo $(python3 -B %s/scripts/audit.py template)" % SKILL), "yes")
        self.assertEqual(cls("python3 -B %s/scripts/audit.py $(pwd)" % SKILL), "yes")
        self.assertEqual(cls("X=$(python3 -B %s/scripts/report.py x); echo $X" % SKILL), "yes")

    def test_a_here_document_is_left_to_the_old_rule(self):
        cmd = "python3 $(pwd)/scripts/audit.py <<'EOF'\nx\nEOF"
        self.assertEqual(cls(cmd), cls_before(cmd))      # documented limit: with a here-document the text after it is data, and it is not rewritten

    def test_the_payload_of_a_shell_is_covered(self):
        self.assertEqual(cls('bash -c "python3 $(pwd)/scripts/audit.py x"'), "unknown")
        self.assertEqual(cls("bash -c 'python3 $(pwd)/scripts/audit.py x'"), "unknown")      # the inner shell would expand it itself

class CouncilFindings(unittest.TestCase):
    """The two defects the council of round 1 found by reading the first version of the rule."""
    def test_a_command_cannot_assign_the_placeholder(self):
        for cmd in ("__subst__=/work; python3 $(pwd)/scripts/audit.py x", "S=/work __subst__=/work python3 -B $(pwd)/scripts/audit.py x", "-=/work; python3 $(pwd)/scripts/audit.py x", "true && __subst__=/work && python3 $(pwd)/scripts/audit.py x"):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)
        self.assertFalse(omissions._VAR.search(omissions._SUBST_VAR)); self.assertFalse(omissions._ASSIGN.match(omissions._SUBST_VAR))

    def test_only_a_real_here_document_keeps_the_old_rule(self):
        for cmd in ("echo '<<'; python3 $(pwd)/scripts/audit.py x", 'echo "<<" && python3 $(pwd)/scripts/audit.py x', "echo \\<\\<; python3 $(pwd)/scripts/audit.py x", "python3 $(pwd)/scripts/audit.py <<< hello", "python3 $(pwd)/scripts/audit.py x <<<'a<<b'"):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)
        for cmd in ("python3 $(pwd)/scripts/audit.py <<'EOF'\nx\nEOF", "python3 $(pwd)/scripts/audit.py <<EOF\nx\nEOF", "python3 $(pwd)/scripts/audit.py <<-EOF\nx\nEOF", "cat <<'E'\nhi\nE\npython3 $(pwd)/scripts/audit.py"):
            with self.subTest(cmd): self.assertTrue(omissions._has_heredoc(cmd), cmd); self.assertEqual(cls(cmd), cls_before(cmd), cmd)
        self.assertTrue(omissions._has_heredoc("echo \\' ; cat <<EOF\nx\nEOF"))      # an escaped quote opens no quoted text: the here-document after it is real
        self.assertFalse(omissions._has_heredoc("echo \\<<x"))      # `\<` is a plain character, the second `<` is an input redirect
        self.assertEqual(cls("echo \\<<x; python3 $(pwd)/scripts/audit.py y"), "unknown")
        for cmd in ("echo '<<'", 'echo "<<"', "echo \\<\\<", "cat <<< x", "echo a <<<'b'"):
            with self.subTest(cmd): self.assertFalse(omissions._has_heredoc(cmd), cmd)

    def test_the_source_window_sees_a_run_next_to_a_quoted_heredoc_marker_and_a_forged_placeholder(self):
        w = SourceWindow().window
        for cmd in ("echo '<<'; python3 -B $(pwd)/scripts/audit.py template --source s", "__subst__=/work; python3 -B $(pwd)/scripts/audit.py template --source s"):
            with self.subTest(cmd): self.assertTrue(w(cmd)["ambiguous"], cmd)

class SourceWindow(unittest.TestCase):
    """The reason for the change: a command that runs a skill script through a substitution used to leave the window of a later version unambiguous although the shell had run the script."""
    def window(self, command, ev="prefix"):
        recs = [dict(type="user", uuid="u1", message=dict(role="user", content="Write the note.")),
                dict(type="assistant", uuid="a1", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="w1", name="Write", input=dict(file_path="/work/proj/N.md", content="x\n"))])),
                dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w1", content="ok")])),
                dict(type="assistant", uuid="a2", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="b1", name="Bash", input=dict(command=command))])),
                dict(type="user", uuid="u3", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="b1", content="ok")])),
                dict(type="assistant", uuid="a3", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="e1", name="Edit", input=dict(file_path="/work/proj/N.md", old_string="x", new_string="y"))])),
                dict(type="user", uuid="u4", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="e1", content="ok")]))]
        return omissions.source_window(recs, "e1", ev)

    def test_a_substituted_script_path_makes_the_window_ambiguous(self):
        cmd = "python3 -B $(pwd)/scripts/audit.py template --source s"
        real = omissions._flatten_subst; omissions._flatten_subst = lambda text: (text, 0)
        try: before = self.window(cmd)
        finally: omissions._flatten_subst = real
        self.assertFalse(before["ambiguous"], before)      # the control: the old rule did not see the run
        self.assertTrue(self.window(cmd)["ambiguous"])

if __name__ == "__main__": unittest.main()

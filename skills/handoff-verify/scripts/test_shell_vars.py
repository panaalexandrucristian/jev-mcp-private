#!/usr/bin/env python3
"""Offline test of the variable expansion of the shell classifier (stdlib only, nothing is executed; all fixtures are invented). A script path built from a shell variable (`SK=/x/handoff-verify; python3 -B $SK/scripts/audit.py`) used to make the whole command
`unknown`, and one `unknown` event makes the source window of every LATER version of the session ambiguous. It is now expanded in exactly one demonstrable case: the same command assigns the variable earlier on its straight line, as a plain `NAME=value` statement that certainly ran, one plain absolute word
(possibly built from variables assigned the same way; the last assignment wins). Then the command is classified as the literal command would be (the equivalence is checked on a corpus and on the whole table); in every other case it stays as it was (`unknown`).
The table below is EXHAUSTIVE over three factors (strength t = 3, because the factors interact: where the assignment stands, what the value is and how the use is quoted; 11 x 12 x 4 = 528 commands are cheap, so no sampling is used).
usage: python3 -B test_shell_vars.py [-v]"""
import itertools, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions

SKILL = "/virtual/handoff-verify"
CWD = "/work/proj"

def cls(cmd, cwd=CWD): return omissions.skill_activity(dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd)), cwd)

def cls_before(cmd, cwd=CWD):
    """The class the command had BEFORE the expansion existed (the expansion switched off): the control for every case that must stay as it was."""
    real = omissions._expand_vars; omissions._expand_vars = lambda items, c: items
    try: return cls(cmd, cwd)
    finally: omissions._expand_vars = real

# value kind -> (statements that build SK, the literal value it stands for or None when nothing is demonstrated)
VALUES = {
    "abs_skill": (["SK=%s" % SKILL], SKILL),
    "abs_other": (["SK=/work/proj/tools"], "/work/proj/tools"),
    "chain": (["ROOT=/virtual", "SK=$ROOT/handoff-verify"], SKILL),
    "braces": (["ROOT=/virtual", "SK=${ROOT}/handoff-verify"], SKILL),
    "chain_unset": (["SK=$NOPE/handoff-verify"], None),
    "relative": (["SK=handoff-verify"], None),
    "cmdsub": (["SK=$(pwd)/handoff-verify"], None),
    "backtick": (["SK=`pwd`/handoff-verify"], None),
    "glob": (["SK=/virtual/hand*"], None),
    "space": (['SK="/virtual/hand off/handoff-verify"'], None),
    "tilde": (["SK=~/handoff-verify"], None),
    "modifier": (["SK=${HOME:-/virtual}/handoff-verify"], None),
}
USES = {"plain": "$SK/scripts/audit.py", "braces": "${SK}/scripts/audit.py", "double": '"$SK/scripts/audit.py"', "single": "'$SK/scripts/audit.py'"}
LEADING = ("lead_semicolon", "lead_and", "lead_newline", "after_command")      # the assignment certainly ran, on the straight line, before the use
OTHER = ("group", "or", "background", "env_prefix", "and_after_command", "pipe", "use_before")      # it may not have run, ran in a subshell, or comes after the use

def build(position, stmts, use):
    run = "python3 -B %s template" % use
    if position == "lead_semicolon": return "; ".join(stmts) + "; " + run
    if position == "lead_and": return " && ".join(stmts) + " && " + run
    if position == "lead_newline": return "\n".join(stmts) + "\n" + run
    if position == "after_command": return "true; " + "; ".join(stmts) + "; " + run
    if position == "group": return "(" + "; ".join(stmts) + "; " + run + ")"
    if position == "or": return "; ".join(stmts[:-1] + [stmts[-1] + " || true"]) + "; " + run
    if position == "background": return "; ".join(stmts[:-1] + [stmts[-1] + " &"]) + " " + run if len(stmts) == 1 else "; ".join(stmts[:-1]) + "; " + stmts[-1] + " & " + run
    if position == "env_prefix": return " ".join(stmts[-1:]) + " " + run
    if position == "and_after_command": return "true && " + "; ".join(stmts) + "; " + run
    if position == "pipe": return "true | " + "; ".join(stmts) + "; " + run
    if position == "use_before": return run + "; " + "; ".join(stmts)
    raise AssertionError(position)

class Table(unittest.TestCase):
    def test_exhaustive_position_value_and_use(self):
        n = 0
        for position, kind, use in itertools.product(LEADING + OTHER, VALUES, USES):
            stmts, literal = VALUES[kind]; cmd = build(position, stmts, USES[use]); got = cls(cmd)
            if position in LEADING and literal is not None and use != "single":
                want = cls("python3 -B %s/scripts/audit.py template" % literal if use != "double" else 'python3 -B "%s/scripts/audit.py" template' % literal)      # the literal command, written without any variable
                self.assertIn(want, ("yes", "no")); self.assertEqual(got, want, (position, kind, use, cmd))
            else: self.assertEqual(got, cls_before(cmd), (position, kind, use, cmd)); self.assertIn(got, ("unknown", "no"), cmd)      # nothing demonstrated: exactly what it was before, never "yes"
            n += 1
        self.assertEqual(n, 11 * 12 * 4)

    def test_the_two_kinds_of_answer_both_occur(self):
        self.assertEqual(cls("SK=%s; python3 -B $SK/scripts/audit.py template" % SKILL), "yes")
        self.assertEqual(cls("SK=/work/proj/tools; python3 -B $SK/scripts/audit.py template"), "no")      # resolved, and not the skill's directory: an ordinary command, as the literal path is

class Observed(unittest.TestCase):
    """The shapes of the commands that blocked the verification of a later version in the live sessions of 2026-10-12 (paths invented)."""
    def test_the_shapes_seen_live_are_recognised(self):
        for cmd in ("SKD=%s; CWD=/work/proj; SESS=d45049c3; python3 -B $SKD/scripts/jevref.py list --session $SESS --cwd $CWD 2>&1 | head -c 6000; echo; python3 -B $SKD/scripts/versions.py list --source $SESS --file $CWD/HANDOFF.md --evaluated-against prefix --cwd $CWD" % SKILL,
                    "S=%s/scripts; C4=/work/proj; cd \"$C4\"; python3 -B $S/jevref.py list --session 1fef --cwd \"$C4\" 2>&1 | head -c 6000; echo ----; python3 -B $S/versions.py list --source 1fef --file \"$C4/HANDOFF.md\" --cwd \"$C4\"" % SKILL,
                    "S=/virtual; SK=$S/handoff-verify; N=$S/note.md; python3 -B $SK/scripts/audit.py register --source s --file $N --write-id w1",
                    "SK=%s; CWD=/work/proj; RUN=$CWD/.handoff-verify/s/r1; mkdir -p \"$RUN\"; cat > \"$RUN/checks-spec.json\" <<'EOF'\n[{\"id\": \"c1\", \"tool\": \"jev_verify\"}]\nEOF\npython3 -B $SK/scripts/checks.py build --spec \"$RUN/checks-spec.json\"" % SKILL,
                    "SK=%s; CWD=/work/proj; python3 -B $SK/scripts/orchestrate.py prepare --session s --file \"$CWD/HANDOFF.md\" --cwd \"$CWD\" --state \"$CWD/st\"" % SKILL,
                    "D=$HOME/.claude/projects/x; ls -lt \"$D\" | head; SK=%s; python3 -B $SK/scripts/orchestrate.py prepare --help 2>&1 | head -30" % SKILL,
                    "W=/work/proj/state-v1; cat \"$W/doc-template.json\"; echo; cat \"$W/state.json\" | head -c 1500; echo; SK=%s; python3 -B $SK/scripts/orchestrate.py finalize --help 2>&1 | head -20" % SKILL):
            with self.subTest(cmd[:60]): self.assertEqual(cls(cmd), "yes", cmd)

    def test_the_same_shapes_without_the_assignment_stay_unknown(self):
        for cmd in ("python3 -B $SKD/scripts/jevref.py list --session s", "cd \"$C4\"; python3 -B $S/versions.py list", "python3 -B $SK/scripts/audit.py register"):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)

class Equivalence(unittest.TestCase):
    CORPUS = ("python3 -B {S}/prepare.py --cwd /work/proj", "cd {S} && python3 omissions.py prepare", "head -50 {S}/report.py", "PYTHONPATH={S} python3 -c 'import report'", "PYTHONPATH=/x:{S} python3 -m report",
              "env PYTHONPATH={S} python3 -m jevref list", "bash -c \"cd {S} && python3 report.py\"", "echo go && python3 {S}/versions.py list", "python3 {S}/report.py 2>&1 | tail -5", "cd /tmp\npython3 {S}/report.py",
              "(cd {S} && python3 report.py)", "nohup python3 -B {S}/prepare.py &", "{S}/report.py --help", "echo {S}/report.py", "printf '%s\\n' {S}/report.py", "ls {S}", "git diff -- {S}/report.py", "cp {S}/report.py /tmp/copy.py",
              "echo hi > {S}/notes.txt", "grep -r report {S}", "python3 {S}/../scripts/report.py", "cat {S}/../SKILL.md")

    def test_a_command_with_the_variable_is_classified_like_the_literal_one(self):
        # the variable is used where the literal was, in double quotes or not; the literal path of the command text is what the corpus names (written with `{S}`)
        for tpl in self.CORPUS:
            literal = tpl.replace("{S}", "/virtual/handoff-verify/scripts"); var = "S=/virtual/handoff-verify/scripts; " + tpl.replace("{S}", "$S")
            with self.subTest(tpl): self.assertEqual(cls(var), cls(literal), tpl)

    def test_a_command_without_a_dollar_is_untouched(self):
        for tpl in self.CORPUS:
            cmd = tpl.replace("{S}", "/virtual/handoff-verify/scripts"); self.assertEqual(cls(cmd), cls_before(cmd), cmd)
            try: items = omissions._shell_items(cmd)
            except ValueError: continue
            self.assertEqual(omissions._expand_vars(items, cmd), items, cmd)      # not one word is rewritten

class Boundaries(unittest.TestCase):
    def test_what_can_change_a_variable_withdraws_it(self):
        for cmd in ("SK=%s; true; SK=$(pwd)/x; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; SK=$NOPE/x; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; true && SK=/other; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; true | SK=/other; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; export SK=/z; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; read SK; python3 $SK/scripts/audit.py" % SKILL,
                    "SK=%s; eval 'SK=/z'; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; unset SK; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; for SK in /a /b; do python3 $SK/scripts/audit.py; done" % SKILL,
                    "SK=%s; echo ${SK:=/z}; python3 $SK/scripts/audit.py" % SKILL, "SK=%s; true; SK+=/x; python3 $SK/scripts/audit.py" % SKILL):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)

    def test_the_last_assignment_that_certainly_ran_wins_and_an_unrelated_variable_is_not_a_problem(self):
        self.assertEqual(cls("SK=/other; SK=%s; python3 -B $SK/scripts/audit.py x" % SKILL), "yes")
        self.assertEqual(cls("SK=%s; true; SK=/other; python3 -B $SK/scripts/audit.py x" % SKILL), "no")      # the later value is the one in force: a resolved path that is not the skill's
        self.assertEqual(cls("SK=/other; python3 -B $SK/scripts/audit.py x; SK=%s; python3 -B $SK/scripts/audit.py y" % SKILL), "yes")      # each use sees the value in force at that point
        self.assertEqual(cls("SK=%s; OTHER=/y; python3 -B $SK/scripts/audit.py $OTHER" % SKILL), "yes")
        self.assertEqual(cls("SK=%s; python3 -B $SK/scripts/audit.py x; OTHER=/z; echo $OTHER" % SKILL), "yes")

    def test_several_assignments_in_one_statement_are_taken_in_order(self):
        self.assertEqual(cls("X=/other SK=%s; python3 -B $SK/scripts/audit.py x" % SKILL), "yes")
        self.assertEqual(cls("A=/virtual B=$A/handoff-verify; python3 -B $B/scripts/audit.py x"), "yes")
        self.assertEqual(cls("B=$A/handoff-verify A=/virtual; python3 -B $B/scripts/audit.py x"), "unknown")      # B is read before A is set

    def test_a_dollar_in_single_quotes_or_escaped_disables_the_expansion_of_the_whole_command(self):
        for cmd in ("SK=%s; python3 -B $SK/scripts/audit.py --note 'cost $5'" % SKILL, "SK=%s; python3 -B $SK/scripts/audit.py --note \\$x" % SKILL, "SK=%s; echo 'a'\"'\"'$b'; python3 -B $SK/scripts/audit.py" % SKILL):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)

    def test_a_single_quoted_payload_is_not_expanded_by_the_outer_shell(self):
        self.assertEqual(cls("S=%s/scripts; bash -c 'cd $S && python3 report.py'" % SKILL), "unknown")      # the inner shell would expand $S itself, with its own (empty) environment: nothing is demonstrated
        self.assertEqual(cls("S=%s/scripts; bash -c \"cd $S && python3 report.py\"" % SKILL), "yes")      # double quotes: the outer shell expands it before the inner shell starts

    def test_a_redirect_or_a_conditional_on_the_assignment_stops_the_leading_run(self):
        for cmd in ("SK=%s > /dev/null; python3 -B $SK/scripts/audit.py" % SKILL, "SK=%s || exit 1; python3 -B $SK/scripts/audit.py" % SKILL, "{ SK=%s; }; python3 -B $SK/scripts/audit.py" % SKILL):
            with self.subTest(cmd): self.assertEqual(cls(cmd), "unknown", cmd)

    def test_other_tools_and_relative_paths_are_unchanged(self):
        for name, key in (("Read", "file_path"), ("Edit", "file_path")):
            self.assertEqual(omissions.skill_activity(dict(type="tool_use", id="x", name=name, input={key: "$SK/scripts/audit.py"}), CWD), "unknown")
        self.assertEqual(cls("SK=%s; python3 scripts/audit.py" % SKILL, None), "unknown")      # a relative script name without a recorded directory is still never repaired
        self.assertEqual(cls("SK=%s; python3 scripts/audit.py" % SKILL, SKILL), "yes")

class SourceWindow(unittest.TestCase):
    """The reason for the change: a verified note, a Bash event that names the skill scripts through a variable, a recorded Edit, then the window of the new version."""
    def window(self, command, ev="prefix"):
        recs = [dict(type="user", uuid="u1", message=dict(role="user", content="Write the note.")),
                dict(type="assistant", uuid="a1", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="w1", name="Write", input=dict(file_path="/work/proj/N.md", content="x\n"))])),
                dict(type="user", uuid="u2", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w1", content="ok")])),
                dict(type="assistant", uuid="a2", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="b1", name="Bash", input=dict(command=command))])),
                dict(type="user", uuid="u3", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="b1", content="ok")])),
                dict(type="assistant", uuid="a3", cwd=CWD, message=dict(role="assistant", content=[dict(type="tool_use", id="e1", name="Edit", input=dict(file_path="/work/proj/N.md", old_string="x", new_string="y"))])),
                dict(type="user", uuid="u4", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="e1", content="ok")]))]
        return omissions.source_window(recs, "e1", ev)

    def test_a_variable_with_a_literal_assignment_no_longer_makes_the_window_ambiguous(self):
        before = self.window("python3 -B $SK/scripts/audit.py template --source s"); self.assertTrue(before["ambiguous"], before)      # the failure of the live sessions, kept as the control
        after = self.window("SK=%s; python3 -B $SK/scripts/audit.py template --source s" % SKILL); self.assertFalse(after["ambiguous"], after)
        literal = self.window("python3 -B %s/scripts/audit.py template --source s" % SKILL); self.assertEqual((after["limit"], after["excluded"]), (literal["limit"], literal["excluded"]))      # the same window as the literal command

if __name__ == "__main__": unittest.main()

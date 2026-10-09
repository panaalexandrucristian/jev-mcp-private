#!/usr/bin/env python3
"""Offline test of the shared source window (item 5; stdlib only, no Jev call, never reads .handoff-verify/): which tool inputs are verification activity of THIS skill (`omissions.skill_activity`:
yes / no / unknown, from the Skill name, from paths resolved against the recorded cwd by path components and from a shell command split into tokens, never from substrings or from the content of a Write),
which run of the verification bounds `session_end` (`omissions.source_window`: the last run that starts after the evaluated write; a Jev call is never a boundary on its own), and that `omissions.context`,
`scope.user_requests`, `versions.bind_versions` and the `prepare.py` chunks use the SAME window and never take generated verification material for source. All fixtures are invented.
usage: python3 -B test_source_window.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover, omissions, scope, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SKILL = "/home/u/.claude/plugins/cache/jev/skills/handoff-verify"
SCRIPTS = SKILL + "/scripts"
REFS = ("prepare.md", "opencode-sessions.md", "jev-and-audit.md", "candidates.md", "report.md")      # the five reference files of the split skill
CONSTRAINT = "Never run migrate.sh against prod."

def bash(cmd): return dict(type="tool_use", id="x", name="Bash", input=dict(command=cmd))
def use(name, **inp): return dict(type="tool_use", id="x", name=name, input=inp)

class Tx:
    """A synthetic Claude Code transcript: user prompts, assistant text, tool_use/tool_result pairs (every record carries the cwd)."""
    def __init__(self, cwd="/work/proj"):
        self.cwd, self.n, self.recs = cwd, 0, []
    def rec(self, typ, content, **extra):
        self.n += 1
        self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.cwd, sessionId="s1", message=dict(role=typ, content=content), **extra))
    def user(self, text, **extra): self.rec("user", text, **extra)
    def say(self, text): self.rec("assistant", [dict(type="text", text=text)])
    def tool(self, tid, name, inp, result="ok"):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)])
        self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result)])
    def save(self, path):
        with open(path, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return path

def blocks(recs, wid=None, ev="session_end", note="/nope/HANDOFF.md", run=None):
    """The eligible source blocks through the shared window (what omissions.context does)."""
    w = omissions.source_window(recs, wid, ev, run)
    return w, omissions.eligible_blocks(recs, note, w["limit"], w["excluded"])

class Classifier(unittest.TestCase):
    def test_the_ordinary_inputs_are_not_verification(self):
        for b, cwd in ((bash("python3 toolkit.py --run"), "/work/proj"), (bash("python3 telescope.py"), "/work/proj"), (bash("pytest tests/test_telescope.py -q"), "/work/proj"),
                       (use("Write", file_path="/work/proj/notes.py", content="import report\nfrom omissions import x\n"), "/work/proj"),
                       (use("Grep", pattern="slice.py", path="/work/proj"), "/work/proj"), (use("Read", file_path="/work/proj/src/report.py"), "/work/proj"),
                       (bash("cat /work/proj/src/versions.py"), "/work/proj"), (bash("echo handoff-verify is a nice name"), "/work/proj")):
            self.assertEqual(omissions.skill_activity(b, cwd), "no", (b, cwd))
        recs = [dict(type="user", message=dict(role="user", content=CONSTRAINT)), dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[bash("python3 toolkit.py"), use("Read", file_path="/work/proj/src/report.py")]))]
        self.assertIsNone(omissions.verification_limit(recs)); self.assertIsNone(omissions.source_window(recs)["limit"])

    def test_the_skill_is_recognised_by_its_exact_name(self):
        for s in ("handoff-verify", "jev:handoff-verify", "my-plugin:handoff-verify"): self.assertEqual(omissions.skill_activity(use("Skill", skill=s), "/w"), "yes", s)
        for s in ("handoff-verify-extra", "xhandoff-verify", "jev:other", "handoff-verify:jev", "a:b:handoff-verify", "", None): self.assertEqual(omissions.skill_activity(use("Skill", skill=s), "/w"), "no", s)

    def test_paths_resolve_against_the_recorded_cwd_by_components(self):
        yes = [(use("Read", file_path=SCRIPTS + "/omissions.py"), None), (use("Read", file_path=SKILL + "/SKILL.md"), None), (use("Read", file_path="scripts/versions.py"), SKILL),
               (use("Read", file_path="../scripts/report.py"), SCRIPTS), (use("Read", file_path="./report.py"), SCRIPTS),
               (bash("python3 -B %s/prepare.py --cwd /work/proj" % SCRIPTS), "/work/proj"), (bash("python3 -B scripts/omissions.py prepare"), SKILL), (bash("cd %s && python3 omissions.py prepare" % SCRIPTS), "/work/proj"),
               (bash("python3 omissions.py prepare"), SCRIPTS), (bash("python3 -m report"), SCRIPTS), (bash("python3 -c 'import checks; checks.x()'"), SCRIPTS),
               (bash("cd /tmp; cd %s && python3 -m jevref list" % SCRIPTS), "/work/proj"), (bash("PYTHONPATH=%s python3 -c 'import report'" % SCRIPTS), "/work/proj")]
        for b, cwd in yes: self.assertEqual(omissions.skill_activity(b, cwd), "yes", (b["input"], cwd))
        no = [(use("Read", file_path="scripts/versions.py"), "/work/proj"), (bash("python3 omissions.py"), "/work/proj"), (bash("python3 -m report"), "/work/proj"), (bash("python3 -c 'import checks'"), "/work/proj"),
              (bash("cd /tmp && python3 report.py"), SCRIPTS), (use("Read", file_path=SKILL + "/README.md"), None), (use("Read", file_path="/other/scripts/omissions.py"), None)]
        for b, cwd in no: self.assertEqual(omissions.skill_activity(b, cwd), "no", (b["input"], cwd))

    def test_a_relative_path_that_looks_like_the_skills_is_unknown_without_a_recorded_cwd(self):
        for p in ("skills/handoff-verify/scripts/prepare.py", "../handoff-verify/scripts/report.py"): self.assertEqual(omissions.skill_activity(use("Read", file_path=p), None), "unknown", p)

    def test_the_five_reference_files_follow_the_rules_of_skill_md_and_no_other_reference_file_does(self):
        REF = SKILL + "/reference"
        for n in REFS:
            with self.subTest(n):
                for b, cwd in ((use("Read", file_path=REF + "/" + n), None), (use("Read", file_path="reference/" + n), SKILL), (use("Read", file_path="./reference/" + n), SKILL), (use("Read", file_path="../reference/" + n), SCRIPTS),
                               (use("Grep", pattern="audit", path=REF + "/" + n), "/work/proj"), (bash("cat reference/%s" % n), SKILL), (bash("head -20 %s/%s" % (REF, n)), "/work/proj")):
                    self.assertEqual(omissions.skill_activity(b, cwd), "yes", (b["input"], cwd))
                for b, cwd in ((use("Read", file_path="reference/" + n), "/work/proj"), (use("Read", file_path="/other/reference/" + n), None), (use("Read", file_path=SKILL + "/scripts/" + n), None),
                               (use("Read", file_path=REF + "/sub/" + n), None), (use("Read", file_path="/home/u/other-skill/reference/" + n), None), (use("Write", file_path="/work/proj/reference/" + n, content="x"), "/work/proj"),
                               (use("Grep", pattern=REF + "/" + n, path="/work/proj"), "/work/proj"), (bash("echo %s/%s" % (REF, n)), "/work/proj")):
                    self.assertEqual(omissions.skill_activity(b, cwd), "no", (b["input"], cwd))
                for p in ("skills/handoff-verify/reference/" + n, "../handoff-verify/reference/" + n): self.assertEqual(omissions.skill_activity(use("Read", file_path=p), None), "unknown", p)
                self.assertEqual(omissions.skill_activity(use("Read", file_path="reference/" + n), None), "no")      # a bare name proves nothing (as for SKILL.md)
        for other in ("README.md", "evidence.md", "notes.md"): self.assertEqual(omissions.skill_activity(use("Read", file_path=SKILL + "/reference/" + other), None), "no", other)

    def test_without_a_recorded_cwd_a_skill_script_name_is_unknown_not_a_guess(self):
        for b in (use("Read", file_path="scripts/omissions.py"), bash("python3 omissions.py prepare"), bash("python3 -m report"), bash("python3 -c 'import versions'"), bash("python3 'unterminated omissions.py")):
            self.assertEqual(omissions.skill_activity(b, None), "unknown", b["input"])
        self.assertEqual(omissions.skill_activity(bash("python3 'unterminated toolkit.py"), None), "no")

class Window(unittest.TestCase):
    def test_a_request_an_unrelated_jev_call_and_a_later_constraint_are_all_kept(self):
        t = Tx(); t.user("fix the retry loop"); t.tool("j1", "mcp__jev__jev_verify", dict(claims=["CLAIM-J1"], evidence="EV-J1"), "RESULT-J1"); t.user(CONSTRAINT)
        w, bl = blocks(t.recs); self.assertIsNone(w["limit"]); self.assertEqual([b for b in bl if "J1" in b], [])
        self.assertIn("fix the retry loop", bl); self.assertIn(CONSTRAINT, bl)
        t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created"); t.tool("j2", "mcp__jev__jev_gate", dict(claims=["CLAIM-J2"]), "RESULT-J2"); t.user("Also keep the cache warm."); t.tool("sk", "Skill", dict(skill="jev:handoff-verify"))
        w, bl = blocks(t.recs, "w1"); self.assertIn("Also keep the cache warm.", bl); self.assertFalse([b for b in bl if "J2" in b or "Skill" in b])

    def test_early_automatic_invocation_then_work_then_write_then_run_keeps_the_work(self):
        t = Tx(); t.user("write a handoff"); t.tool("sk", "Skill", dict(skill="jev:handoff-verify"), "SKILLBODY"); t.say("WORK: the decision was lmdb instead of etcd")
        t.tool("r1", "Read", dict(file_path="/work/proj/src/a.py"), "FILE-A"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="NOTE"), "created")
        t.say("NARRATION-AFTER-WRITE"); t.tool("b1", "Bash", dict(command="python3 -B %s/omissions.py prepare --source s" % SCRIPTS), "PREPARED-OUTPUT"); t.say("RUN-COMMENTARY")
        w, bl = blocks(t.recs, "w1"); text = "\n".join(bl)
        self.assertIn("WORK: the decision was lmdb instead of etcd", text); self.assertIn("FILE-A", text)
        for gone in ("SKILLBODY", "PREPARED-OUTPUT", "omissions.py", "RUN-COMMENTARY"): self.assertNotIn(gone, text, gone)
        wp, bp = blocks(t.recs, "w1", "prefix"); self.assertIn("WORK: the decision was lmdb instead of etcd", "\n".join(bp)); self.assertNotIn("NARRATION-AFTER-WRITE", "\n".join(bp)); self.assertNotIn("NOTE", "\n".join(bp))

    def test_two_runs_on_one_write_keep_the_work_between_them_and_exclude_the_first_span(self):
        t = Tx(); t.user("write a handoff"); t.say("WORK-1"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="NOTE"), "created")
        t.tool("a1", "Bash", dict(command="python3 -B %s/omissions.py prepare" % SCRIPTS), "RUN1-OUT"); t.say("RUN1-SUMMARY: omission found"); t.tool("g1", "Read", dict(file_path="/work/proj/report.txt"), "RUN1-READ")
        t.user("thanks, now also check the retry loop"); t.say("WORK-2: retry loop has a bug"); t.tool("a2", "Skill", dict(skill="handoff-verify")); t.say("RUN2-SUMMARY"); t.user("LATE-PROMPT")
        self.assertIn("run", omissions.source_window(t.recs, "w1")["ambiguous"])                                     # two runs and no name: the last one is NOT taken (council fix 1)
        w, bl = blocks(t.recs, "w1", run="a2"); text = "\n".join(bl)
        for kept in ("WORK-1", "thanks, now also check the retry loop", "WORK-2: retry loop has a bug"): self.assertIn(kept, text, kept)
        for gone in ("RUN1-OUT", "RUN1-SUMMARY", "RUN1-READ", "RUN2-SUMMARY", "LATE-PROMPT", "omissions.py"): self.assertNotIn(gone, text, gone)
        self.assertEqual([r["id"] for r in w["runs"]], ["a1", "a2"])

    def test_a_run_that_opens_a_reference_file_is_bounded_and_the_rules_it_reads_are_not_source(self):
        for n in REFS:
            with self.subTest(n):
                t = Tx(); t.user("do the work"); t.say("WORK-1"); t.tool("p1", "Read", dict(file_path="/work/proj/reference/" + n), "PROJECT-DOC")      # a file of the project that has the same name: ordinary work
                t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="NOTE"), "created"); t.tool("r1", "Read", dict(file_path=SKILL + "/reference/" + n), "REFERENCE-RULES"); t.say("RUN-NARRATION"); t.user("LATE-PROMPT")
                w, bl = blocks(t.recs, "w1"); text = "\n".join(bl)
                self.assertEqual([r["id"] for r in w["runs"]], ["r1"]); self.assertIn("WORK-1", text); self.assertIn("PROJECT-DOC", text)
                for gone in ("REFERENCE-RULES", "RUN-NARRATION", "LATE-PROMPT"): self.assertNotIn(gone, text, gone)

    def test_prefix_is_strictly_before_the_write(self):
        t = Tx(); t.user("before the write"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="NOTE"), "created"); t.user("after the write")
        w, bl = blocks(t.recs, "w1", "prefix"); self.assertEqual(bl, ["before the write"])

    def test_generated_verification_material_never_enters_the_source(self):
        t = Tx(); t.user("do the work"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="NOTE"), "created")
        t.tool("sk", "Skill", dict(skill="jev:handoff-verify"), "SKILL-TEXT"); t.user("Base directory for this skill: /x\nGENERATED-SKILL-BODY", isMeta=True)
        t.tool("j1", "mcp__jev__jev_verify", dict(claims=["GENERATED-CLAIM"], evidence="GENERATED-EVIDENCE"), "GENERATED-RESULT"); t.say("GENERATED-NARRATION")
        t.user("an ordinary later request"); t.tool("b", "Bash", dict(command="git status"), "clean")
        w, bl = blocks(t.recs, "w1"); text = "\n".join(bl)
        self.assertNotIn("GENERATED", text); self.assertNotIn("SKILL-TEXT", text); self.assertIn("do the work", text)
        # a previous run before a LATER write is not source either (its material is generated), the work around it is
        t2 = Tx(); t2.user("first note"); t2.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N1"), "created"); t2.tool("sk", "Skill", dict(skill="handoff-verify")); t2.tool("j1", "mcp__jev__jev_verify", dict(claims=["OLD-CLAIM"]), "OLD-RESULT")
        t2.say("OLD-RUN-SUMMARY"); t2.user("now change the cache"); t2.say("WORK-AFTER"); t2.tool("w2", "Write", dict(file_path="/nope/HANDOFF.md", content="N2"), "created")
        w, bl = blocks(t2.recs, "w2", "prefix"); text = "\n".join(bl)
        self.assertIn("WORK-AFTER", text); self.assertIn("now change the cache", text)
        for gone in ("OLD-CLAIM", "OLD-RESULT", "OLD-RUN-SUMMARY"): self.assertNotIn(gone, text, gone)

    def test_an_ambiguous_run_selection_gives_no_source(self):
        t = Tx(cwd=None); t.user("x"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created"); t.tool("b", "Bash", dict(command="python3 omissions.py prepare"))
        for r in t.recs: r.pop("cwd")
        w = omissions.source_window(t.recs, "w1", "session_end"); self.assertIn("ambiguous", w["ambiguous"] or "")
        self.assertFalse(omissions.source_window(t.recs, "w1", "prefix")["ambiguous"])      # the unknown event is after the write: the prefix does not depend on it

class Parity(unittest.TestCase):
    """prepare, scope, bind_versions and the chunks of prepare.py use one window."""
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.text = "# Handoff\n- alpha\n"
        open(self.note, "w").write(self.text); self.log = os.path.join(self.d, "session.jsonl")
        t = Tx(self.d); t.user("work request"); t.say("WORK-DECISION we use lmdb"); t.tool("w1", "Write", dict(file_path=self.note, content=self.text), "File created successfully")
        t.tool("j1", "mcp__jev__jev_verify", dict(claims=["GEN-CLAIM"], evidence="GEN-EVIDENCE"), "GEN-RESULT"); t.user(CONSTRAINT)
        t.tool("b1", "Bash", dict(command="python3 -B %s/omissions.py prepare" % SCRIPTS), "GEN-HELPER-OUT"); t.say("GEN-NARRATION"); t.user("LATE-REQUEST"); t.tool("sk", "Skill", dict(skill="jev:handoff-verify"))
        t.save(self.log); self.recs = discover.load_jsonl(self.log)

    def test_prepare_scope_bind_versions_and_chunks_agree(self):
        vs = versions.versions_of(self.log, self.note)[0]; v = vs[0]
        self.assertIsNone(omissions.context(self.log, self.note, v, "session_end")["eligible_source"])       # two runs, none named: no source
        ctx = omissions.context(self.log, self.note, v, "session_end", (), "sk")
        self.assertIn(CONSTRAINT, ctx["eligible_blocks"]); self.assertIn("LATE-REQUEST", ctx["eligible_blocks"]); self.assertFalse([b for b in ctx["eligible_blocks"] if "GEN-" in b])
        rows = versions.bind_versions([dict(version_ref=dict(versions.version_ref(v, "session_end"), run="sk"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        self.assertEqual(rows["k"]["omission"]["eligible_source"], ctx["eligible_source"])
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "session_end", "--detail", "d", "--source-quote", CONSTRAINT, "--run", "sk"],
                             capture_output=True, text=True, env=ENV)
        o = json.loads(out.stdout); self.assertEqual(out.returncode, 0, out.stdout); self.assertEqual(o["source_passage"], CONSTRAINT); self.assertEqual(o["version_ref"]["run"], "sk")
        ctx_s, reqs, why = scope.scope_of(self.log, "w1", "session_end", "sk"); self.assertIsNotNone(ctx_s, why)
        self.assertEqual(reqs, ["work request", CONSTRAINT, "LATE-REQUEST"])
        w = omissions.source_window(self.recs, "w1", "session_end", "sk"); self.assertEqual(scope.user_requests(self.recs, "w1", "session_end", "sk"), reqs)
        work = os.path.join(self.d, "work"); p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), self.log, "--cwd", self.d, "--out", work], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        chunks = "".join(open(os.path.join(work, "transcript", f), encoding="utf-8").read() for f in sorted(os.listdir(os.path.join(work, "transcript"))))
        self.assertIn("WORK-DECISION", chunks); self.assertIn(CONSTRAINT, chunks)
        for gone in ("GEN-CLAIM", "GEN-EVIDENCE", "GEN-RESULT", "GEN-HELPER-OUT", "GEN-NARRATION"): self.assertNotIn(gone, chunks, gone)

    def test_an_ambiguous_selection_makes_prepare_exit_3(self):
        t = Tx(self.d); t.user("work request"); t.tool("w1", "Write", dict(file_path=self.note, content=self.text), "created"); t.tool("b", "Bash", dict(command="python3 omissions.py prepare"))
        for r in t.recs: r.pop("cwd")
        t.save(self.log)
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "session_end", "--detail", "d", "--source-quote", "work request"],
                             capture_output=True, text=True, env=ENV)
        self.assertEqual(out.returncode, 3, out.stdout); self.assertIn("ambiguous", json.loads(out.stdout)["reasons"][0])

if __name__ == "__main__": unittest.main()

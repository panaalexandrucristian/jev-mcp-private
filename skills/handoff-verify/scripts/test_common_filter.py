#!/usr/bin/env python3
"""Offline test of the common filtering and of the canonical positions (council fixes 4 and 6; stdlib only, no Jev call, never reads .handoff-verify/):
 - the use AND the result of the note's own Write/Edit are never source (canonical identity in the cwd recorded for the call, not the process cwd), in `omissions.context`, in `versions.bind_versions` (report
   rebinding) and in the `prepare.py` chunks;
 - verification material keeps its provenance before a later write: a skill run that starts after an earlier version (Skill -> Read of a generated report -> summary -> next prompt) is not source of the next
   write's prefix, nor part of the chunks; the chunks follow the same filtering as the source window;
 - legitimate work is not dropped because it follows a generic, unbound Jev call that no skill run surrounds (write -> Jev -> final decision stays source);
 - one canonical resolution in the recorded cwd for grouping, Reads, relocation and filtering (a relative Write is not grouped under the process cwd, a relative Read with an absolute structured filePath is
   accepted, no recorded cwd means no placement, never the process cwd);
 - `prefix_records` and the prefix chunks come from the real stream positions up to the write's tool_use, never from timestamps (absent or reversed timestamps);
 - a shell redirect or read that is not demonstrated (`false && printf REAL > art; true`, `echo '>' art`, behind `||`, `bash -c` under such a condition) neither creates a verification artifact, nor ends its provenance, nor turns a
   legitimate result into a re-read, on every surface (shared context, report rebinding, prepare.py chunks, the version's prefix chunks) and in `omissions.py prepare` and the ABSENCE-first pair; what really ran keeps its meaning;
 - a `python -c` payload counts as activity only for an import that runs (a definition that is never called, a later `sys.path` change, a local `import_module`, a lambda that is only built and a generator function that is called and
   discarded are real work; a binding made only in a branch, or a call through a local name not bound yet, leaves the window undemonstrated on every surface);
 - the ABSENCE-first pair is judged over two recorded calls (ABSENCE then SOURCE) bound with `jevref.bind`, `versions.bind_versions` / `attach` and `report.bind_report`.
All fixtures are invented.
usage: python3 -B test_common_filter.py [-v]"""
import argparse, contextlib, io, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover, jevref, omissions, prepare, report, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

class Tx:
    def __init__(self, cwd, stamp=True):
        self.cwd, self.n, self.recs, self.stamp = cwd, 0, [], stamp
    def rec(self, typ, content, ts=None, **extra):
        self.n += 1; r = dict(type=typ, uuid="u%d" % self.n, sessionId="s1", message=dict(role=typ, content=content), **extra)
        if self.cwd is not None: r["cwd"] = self.cwd
        if ts is not None: r["timestamp"] = ts
        elif self.stamp: r["timestamp"] = "2026-01-01T00:00:%02dZ" % self.n
        self.recs.append(r)
    def user(self, text, **kw): self.rec("user", text, **kw)
    def say(self, text, **kw): self.rec("assistant", [dict(type="text", text=text)], **kw)
    def tool(self, tid, name, inp, result="ok", ts=None, **extra):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)], ts=ts); self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result)], ts=ts, **extra)
    def run(self, tid): self.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "SKILL-LOADED")
    def save(self, path):
        with open(path, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return path

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "s.jsonl"); omissions._MEMO.clear()
    def prepare(self, session=None):
        out = io.StringIO(); work = os.path.join(self.d, "work%d" % len(os.listdir(self.d))); old = sys.argv; sys.argv = ["prepare.py", session or self.log, "--cwd", self.d, "--out", work]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        return code, json.loads(out.getvalue()), work
    def chunks(self, work): return "".join(open(os.path.join(work, "transcript", f), encoding="utf-8").read() for f in sorted(os.listdir(os.path.join(work, "transcript"))))
    def context(self, wid, ea, run=None):
        omissions._MEMO.clear(); v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == wid)
        return omissions.context(self.log, self.note, v, ea, (), run)
    def surfaces(self, wid="w2"):
        """The text of the source of version `wid` on every surface that derives it: the shared context, the report rebinding, the chunks of prepare.py and the chunks that its inventory selects as the prefix of the version."""
        text = "\n".join(self.context(wid, "prefix")["eligible_blocks"]); v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == wid)
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(v, "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        code, out, work = self.prepare(); self.assertEqual(code, 0)
        inv = json.load(open(os.path.join(work, "inventory.json"))); pv = next(x for h in inv["handoffs"] for x in h["versions"] if x["tool_use_id"] == wid)
        prefix = "".join(open(os.path.join(work, f), encoding="utf-8").read() for f in pv["prefix_chunks"])
        return dict(context=text, rebinding=rows["k"]["omission"]["eligible_source"], chunks=self.chunks(work), prefix_chunks=prefix)
    def assert_source(self, present, absent=(), wid="w2"):
        """`present` / `absent` markers hold on every surface."""
        for name, text in self.surfaces(wid).items():
            for m in present: self.assertIn(m, text, "%s: %s" % (name, m))
            for m in absent: self.assertNotIn(m, text, "%s: %s" % (name, m))
    def prepare_omission(self, quote, wid="w2"):
        omissions._MEMO.clear(); return omissions.prepare_one(argparse.Namespace(source=self.log, cwd=self.d, file=self.note, write_id=wid, evaluated_against="prefix", detail=quote, source_quote=quote, location=None, run=None))

class OwnMutation(Base):
    def build(self, cwd=None):
        t = Tx(cwd or self.d); t.user("real request"); t.tool("w1", "Write", dict(file_path=self.note, content="NOTE-BODY-IN-WRITE\n"), "File created successfully")
        t.tool("e1", "Edit", dict(file_path=self.note, old_string="NOTE-BODY", new_string="NOTE-HEAD"), "The file has been updated:\n 1\tNOTE-HEAD-IN-EDIT-RESULT"); t.say("then real work"); t.save(self.log); return t

    def test_the_result_of_the_notes_own_mutation_is_not_source(self):
        self.build(); text = "\n".join(self.context("e1", "session_end")["eligible_blocks"])
        self.assertIn("real request", text); self.assertIn("then real work", text)
        for gone in ("NOTE-BODY-IN-WRITE", "NOTE-HEAD-IN-EDIT-RESULT", "File created successfully", "The file has been updated"): self.assertNotIn(gone, text, gone)

    def test_the_canonical_identity_uses_the_cwd_recorded_for_the_call(self):
        t = Tx(self.d); t.user("real request"); t.tool("w1", "Write", dict(file_path="HANDOFF.md", content="NOTE-BODY-IN-WRITE\n"), "RESULT-OF-RELATIVE-WRITE"); t.say("then real work"); t.save(self.log)
        old = os.getcwd(); os.chdir(tempfile.gettempdir())
        try: text = "\n".join(self.context("w1", "session_end")["eligible_blocks"])
        finally: os.chdir(old)
        for gone in ("NOTE-BODY-IN-WRITE", "RESULT-OF-RELATIVE-WRITE"): self.assertNotIn(gone, text, gone)
        self.assertIn("then real work", text)

    def test_the_chunks_do_not_carry_the_note_or_the_results_of_its_mutations(self):
        self.build(); code, out, work = self.prepare(); self.assertEqual(code, 0); chunks = self.chunks(work)
        self.assertIn("real request", chunks); self.assertIn("then real work", chunks)
        for gone in ("NOTE-BODY-IN-WRITE", "NOTE-HEAD-IN-EDIT-RESULT", "File created successfully"): self.assertNotIn(gone, chunks, gone)

    def test_report_rebinding_uses_the_same_filtered_source(self):
        self.build(); v = versions.versions_of(self.log, self.note)[0][1]
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(v, "session_end"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        self.assertNotIn("NOTE-HEAD-IN-EDIT-RESULT", rows["k"]["omission"]["eligible_source"]); self.assertIn("then real work", rows["k"]["omission"]["eligible_source"])

class Provenance(Base):
    def build(self):
        t = Tx(self.d); t.user("make a note"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1")
        t.tool("rd", "Read", dict(file_path=os.path.join(self.d, ".handoff-verify", "s", "r1", "work", "HANDOFF.md.verify.md")), "OLD-VERIFY-RESULT: the note lost the lmdb decision")
        t.say("OLD-VERIFY-SUMMARY: one omission found"); t.user("now change the cache"); t.say("WORK-AFTER: the cache uses lmdb"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.user("final request")
        t.save(self.log); return t

    def test_the_old_verification_result_and_summary_are_not_in_the_prefix_of_the_next_write(self):
        self.build(); c = self.context("w2", "prefix"); text = "\n".join(c["eligible_blocks"])
        for gone in ("OLD-VERIFY-RESULT", "OLD-VERIFY-SUMMARY", "SKILL-LOADED", "handoff-verify"): self.assertNotIn(gone, text, gone)
        for kept in ("make a note", "now change the cache", "WORK-AFTER"): self.assertIn(kept, text, kept)
        c = self.context("w2", "session_end"); text = "\n".join(c["eligible_blocks"])
        for gone in ("OLD-VERIFY-RESULT", "OLD-VERIFY-SUMMARY"): self.assertNotIn(gone, text, gone)
        self.assertIn("final request", text)

    def test_the_chunks_follow_the_same_filtering(self):
        self.build(); code, out, work = self.prepare(); self.assertEqual(code, 0); chunks = self.chunks(work)
        for gone in ("OLD-VERIFY-RESULT", "OLD-VERIFY-SUMMARY", "SKILL-LOADED"): self.assertNotIn(gone, chunks, gone)
        for kept in ("make a note", "now change the cache", "WORK-AFTER", "final request"): self.assertIn(kept, chunks, kept)

    def test_report_rebinding_prefix_is_clean(self):
        self.build(); v = versions.versions_of(self.log, self.note)[0][1]
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(v, "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        text = rows["k"]["omission"]["eligible_source"]; self.assertNotIn("OLD-VERIFY", text); self.assertIn("WORK-AFTER", text)

    def test_work_before_the_first_write_that_surrounds_an_automatic_invocation_is_kept(self):
        t = Tx(self.d); t.user("write a handoff"); t.run("sk0"); t.say("WORK: the decision was lmdb"); t.tool("r1", "Read", dict(file_path="/work/a.py"), "FILE-A"); t.tool("w1", "Write", dict(file_path=self.note, content="N\n"), "created"); t.save(self.log)
        text = "\n".join(self.context("w1", "prefix")["eligible_blocks"]); self.assertIn("WORK: the decision was lmdb", text); self.assertIn("FILE-A", text); self.assertNotIn("SKILL-LOADED", text)

class GenericJev(Base):
    def build(self):
        t = Tx(self.d); t.user("make a note"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created")
        t.tool("j1", "mcp__jev__jev_verify", dict(claims=["GENERIC-CLAIM"], evidence="GENERIC-EVIDENCE"), "GENERIC-JEV-RESULT"); t.say("FINAL-DECISION: ship with lmdb"); t.user("thanks"); t.save(self.log); return t

    def test_a_decision_after_an_unbound_generic_jev_call_is_kept_but_the_call_is_not_source(self):
        self.build(); text = "\n".join(self.context("w1", "session_end")["eligible_blocks"])
        self.assertIn("FINAL-DECISION: ship with lmdb", text); self.assertIn("thanks", text)
        for gone in ("GENERIC-CLAIM", "GENERIC-EVIDENCE", "GENERIC-JEV-RESULT"): self.assertNotIn(gone, text, gone)

    def test_the_chunks_and_the_report_rebinding_keep_it_too(self):
        self.build(); code, out, work = self.prepare(); chunks = self.chunks(work)
        self.assertIn("FINAL-DECISION", chunks); self.assertNotIn("GENERIC-JEV-RESULT", chunks)
        v = versions.versions_of(self.log, self.note)[0][0]
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(v, "session_end"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        self.assertIn("FINAL-DECISION", rows["k"]["omission"]["eligible_source"])

    def test_narration_inside_a_skill_run_is_still_excluded(self):
        t = Tx(self.d); t.user("make a note"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1")
        t.tool("j1", "mcp__jev__jev_verify", dict(claims=["C"], evidence="E"), "RUN-RESULT"); t.say("RUN-NARRATION"); t.save(self.log)
        text = "\n".join(self.context("w1", "session_end", "sk1")["eligible_blocks"]); self.assertNotIn("RUN-", text)
        code, out, work = self.prepare(); self.assertNotIn("RUN-", self.chunks(work))

class Reread(Base):
    """A report written during a verification run keeps its provenance: reading it again after the run (after a real prompt) brings generated material back unless the artifact is followed by its canonical identity."""
    ART = "/virtual/reports/prior.verify.json"
    def build(self, reader=("Read", None), mid=None, art_write_outside=False):
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1")
        if not art_write_outside: t.tool("g1", "Write", dict(file_path=self.ART, content='{"fact": "GENERATED-FACT-WRITTEN"}'), "created")
        t.say("RUN1-SUMMARY"); t.user("next request")
        if art_write_outside: t.tool("g1", "Write", dict(file_path=self.ART, content='{"fact": "LEGIT-FACT-WRITTEN"}'), "created")
        if mid: mid(t)
        name, cmd = reader
        t.tool("rd", name, dict(command=cmd) if cmd else dict(file_path=self.ART), "1\t{GENERATED-FACT-READ}")
        t.say("WORK-LEGIT: we chose lmdb"); t.tool("rd2", "Read", dict(file_path="/virtual/src/other.py"), "OTHER-FILE-READ"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.user("final request")
        t.save(self.log); return t

    def eligible(self, ea="prefix"): return "\n".join(self.context("w2", ea, "sk1" if ea == "session_end" else None)["eligible_blocks"])

    def test_the_reread_of_a_report_written_in_a_run_is_not_source(self):
        self.build(); text = self.eligible()
        for gone in ("GENERATED-FACT", "prior.verify.json"): self.assertNotIn(gone, text, gone)
        for kept in ("first request", "next request", "WORK-LEGIT", "OTHER-FILE-READ"): self.assertIn(kept, text, kept)

    def test_a_shell_read_of_the_same_canonical_path_is_followed_too(self):
        self.build(reader=("Bash", "cat /virtual/reports/../reports/prior.verify.json | head -5")); text = self.eligible()
        self.assertNotIn("GENERATED-FACT", text); self.assertIn("WORK-LEGIT", text)

    def test_the_chunks_and_the_report_rebinding_carry_the_same_filter(self):
        self.build(); code, out, work = self.prepare(); self.assertEqual(code, 0); chunks = self.chunks(work)
        self.assertNotIn("GENERATED-FACT", chunks); self.assertIn("WORK-LEGIT", chunks); self.assertIn("OTHER-FILE-READ", chunks)
        v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == "w2")
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(v, "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        self.assertNotIn("GENERATED-FACT", rows["k"]["omission"]["eligible_source"]); self.assertIn("WORK-LEGIT", rows["k"]["omission"]["eligible_source"])

    def test_a_file_written_by_real_work_outside_any_run_is_legitimate_source(self):
        self.build(art_write_outside=True); text = self.eligible(); self.assertIn("LEGIT-FACT-WRITTEN", text); self.assertIn("GENERATED-FACT-READ", text)   # nobody generated it: adjacency to a run proves nothing

    def test_a_later_full_write_by_real_work_ends_the_provenance(self):
        def overwrite(t): t.tool("g2", "Write", dict(file_path=self.ART, content="REAL-OVERWRITE"), "updated")
        self.build(mid=overwrite); text = self.eligible(); self.assertIn("GENERATED-FACT-READ", text); self.assertIn("REAL-OVERWRITE", text)

    def test_a_generic_jev_call_does_not_make_what_follows_generated(self):
        t = Tx(self.d); t.user("req"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.tool("j1", "mcp__jev__jev_verify", dict(claims=["C"], evidence="E"), "JEV-RESULT")
        t.tool("g1", "Write", dict(file_path=self.ART, content="WRITTEN-AFTER-JEV"), "created"); t.user("more"); t.tool("rd", "Read", dict(file_path=self.ART), "READ-AFTER-JEV"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log)
        text = "\n".join(self.context("w2", "prefix")["eligible_blocks"]); self.assertIn("READ-AFTER-JEV", text); self.assertNotIn("JEV-RESULT", text)

class RunBeforeTheNote(Base):
    """A run is a verification of the note only after the note's first successful mutation: what an earlier automatic invocation stretch wrote is real work, its re-reading is source."""
    def test_work_written_after_an_earlier_invocation_is_read_back_as_real_work(self):
        MAIN = "/virtual/src/main.py"
        t = Tx(self.d); t.user("first request"); t.run("auto"); t.tool("m1", "Write", dict(file_path=MAIN, content="print('real work')\n"), "created"); t.say("AUTO-STRETCH-NARRATION"); t.user("real prompt")
        t.tool("rd", "Read", dict(file_path=MAIN), "1\tREAL-MAIN-PY-READ"); t.say("WORK-LEGIT: main.py reads fine"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.user("later"); t.save(self.log)
        text = "\n".join(self.context("w1", "prefix")["eligible_blocks"])
        self.assertIn("REAL-MAIN-PY-READ", text); self.assertIn("WORK-LEGIT", text); self.assertNotIn("SKILL-LOADED", text)
        code, out, work = self.prepare(); chunks = self.chunks(work); self.assertEqual(code, 0)
        self.assertIn("REAL-MAIN-PY-READ", chunks); self.assertNotIn("SKILL-LOADED", chunks)

    def test_the_same_files_written_by_a_run_after_the_note_stay_artifacts(self):
        MAIN = "/virtual/src/main.py"
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1"); t.tool("m1", "Write", dict(file_path=MAIN, content="GENERATED-BODY"), "created"); t.user("next")
        t.tool("rd", "Read", dict(file_path=MAIN), "1\tGENERATED-MAIN-READ"); t.say("WORK-LEGIT"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log)
        text = "\n".join(self.context("w2", "prefix")["eligible_blocks"]); self.assertNotIn("GENERATED-MAIN-READ", text); self.assertIn("WORK-LEGIT", text)

class ShellArtifacts(Base):
    """What a shell command really READS or WRITES decides, in the cwd recorded for the call: `cat prior.verify.md` reads the artifact, an echo, a printf or a pattern that names it do not, and a literal redirect of a successful command inside a run makes the file an artifact."""
    ART = "/virtual/reports/prior.verify.md"
    def build(self, inside="printf 'GENERATED' > /virtual/reports/prior.verify.md", reader="cat prior.verify.md", reader_cwd="/virtual/reports", inside_err=False):
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1")
        if inside_err:
            t.rec("assistant", [dict(type="tool_use", id="g1", name="Bash", input=dict(command=inside))]); t.rec("user", [dict(type="tool_result", tool_use_id="g1", content="boom", is_error=True)])
        elif inside.startswith("WRITE"): t.tool("g1", "Write", dict(file_path=self.ART, content="GENERATED"), "created")
        else: t.tool("g1", "Bash", dict(command=inside), "")
        t.say("RUN1-SUMMARY"); t.user("next request"); t.cwd = reader_cwd; t.tool("rd", "Bash", dict(command=reader), "READER-RESULT"); t.cwd = self.d
        t.say("WORK-LEGIT"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log); return t
    def eligible(self): return "\n".join(self.context("w2", "prefix")["eligible_blocks"])

    def test_a_reader_with_a_relative_operand_reads_the_artifact_in_the_recorded_cwd(self):
        for inside in ("WRITE", "printf 'GENERATED' > /virtual/reports/prior.verify.md", "echo GENERATED >> /virtual/reports/prior.verify.md"):
            for reader in ("cat prior.verify.md", "head -n 5 prior.verify.md", "grep GENERATED prior.verify.md", "cat < prior.verify.md", "tail -5 ./prior.verify.md"):
                with self.subTest(inside=inside, reader=reader):
                    self.build(inside, reader); text = self.eligible(); self.assertNotIn("READER-RESULT", text); self.assertIn("WORK-LEGIT", text)
        code, out, work = self.prepare(); self.assertNotIn("READER-RESULT", self.chunks(work))

    def test_a_command_that_only_names_the_artifact_is_real_work(self):
        for reader in ("echo /virtual/reports/prior.verify.md", "printf '%s\\n' prior.verify.md", "grep -e prior.verify.md /virtual/src/other.py", "ls /virtual/reports/prior.verify.md", "git add prior.verify.md", "cp prior.verify.md /tmp/x"):
            with self.subTest(reader):
                self.build(reader=reader); self.assertIn("READER-RESULT", self.eligible())

    def test_the_same_name_in_another_directory_is_another_file(self):
        self.build(reader="cat prior.verify.md", reader_cwd="/virtual/other"); self.assertIn("READER-RESULT", self.eligible())

    def test_a_redirect_that_is_dynamic_conditional_or_failed_is_no_artifact(self):
        for inside, err in (("printf x > \"$OUT\"", False), ("false || printf x > /virtual/reports/prior.verify.md", False), ("printf x | tee /virtual/reports/prior.verify.md", False), ("printf x > /virtual/reports/prior.verify.md", True), ("printf x 2>&1 | cat > /virtual/reports/prior.verify.md &", False)):
            with self.subTest(inside=inside, err=err):
                self.build(inside, "cat /virtual/reports/prior.verify.md", inside_err=err); self.assertIn("READER-RESULT", self.eligible())

    def test_a_redirect_outside_a_run_is_real_work_and_ends_the_provenance(self):
        self.build("WRITE", "cat /virtual/reports/prior.verify.md")
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.tool("g1", "Bash", dict(command="printf 'REAL' > /virtual/reports/prior.verify.md"), ""); t.user("next")
        t.tool("rd", "Bash", dict(command="cat /virtual/reports/prior.verify.md"), "READER-RESULT"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log); self.assertIn("READER-RESULT", self.eligible())

    def test_the_redirect_is_not_a_supported_write_and_gives_no_version(self):
        self.build(); self.assertEqual([v["write_tool_use_id"] for v in versions.versions_of(self.log, self.note)[0]], ["w1", "w2"])
        self.assertEqual(versions.provenance(self.log, self.ART)["state"], "bash_only")

class ImportedScripts(Base):
    """Only an import statement is an import: a literal or a comment that says `import report` is real work."""
    S = "/virtual/handoff-verify/scripts"
    def build(self, payload, cwd=None):
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.cwd = cwd or self.S
        t.tool("py", "Bash", dict(command=payload), "PAYLOAD-RESULT"); t.cwd = self.d; t.say("WORK-LEGIT"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log)
        blocks = self.context("w2", "prefix")["eligible_blocks"]; return None if blocks is None else "\n".join(blocks)

    def test_a_string_or_a_comment_that_says_import_is_real_work(self):
        for payload in ("python3 -c 'print(\"example import report\")'", "python3 -c '# import report\nprint(1)'", "python3 -c \"x = 'from versions import y'\"", "python3 -c \"import sys; print('sys.path.insert(0, \\'%s\\'); import report')\"" % self.S):
            with self.subTest(payload): self.assertIn("PAYLOAD-RESULT", self.build(payload))

    def test_a_real_import_of_a_script_of_the_skill_is_still_activity(self):
        for payload in ("python3 -c 'import report'", "python3 -c 'from versions import gate'", "python3 -c 'def f():\n    import omissions\nf()'", "python3 -c \"__import__('report')\""):
            with self.subTest(payload): self.assertNotIn("PAYLOAD-RESULT", self.build(payload))

    def test_a_definition_that_is_never_called_is_real_work(self):
        for payload in ("python3 -c 'def f():\n    import report'", "python3 -c 'class C:\n    def m(self):\n        import omissions'", "python3 -c 'def f():\n    __import__(\"report\")'"):
            with self.subTest(payload): self.assertIn("PAYLOAD-RESULT", self.build(payload))

    def test_a_path_change_that_comes_after_the_import_does_not_make_it_the_skills(self):
        later = "python3 -c \"import report\nimport sys\nsys.path.insert(0, '%s')\"" % self.S
        self.assertIn("PAYLOAD-RESULT", self.build(later, cwd="/virtual/proj"))
        before = "python3 -c \"import sys\nsys.path.insert(0, '%s')\nimport report\"" % self.S
        self.assertNotIn("PAYLOAD-RESULT", self.build(before, cwd="/virtual/proj"))

    def test_a_local_callable_named_import_module_is_real_work(self):
        self.assertIn("PAYLOAD-RESULT", self.build("python3 -c 'def import_module(n): pass\nimport_module(\"report\")'"))
        self.assertNotIn("PAYLOAD-RESULT", self.build("python3 -c 'import importlib\nimportlib.import_module(\"report\")'"))

    def test_the_chunks_the_prefix_and_the_rebinding_follow_the_same_decision(self):
        self.build("python3 -c 'def f():\n    import report'"); self.assert_source(["PAYLOAD-RESULT", "WORK-LEGIT"])
        self.build("python3 -c 'def f():\n    import report\nf()'"); self.assert_source(["first request"], ["PAYLOAD-RESULT"])      # a run: the narration up to the next prompt goes with it

    def test_an_import_hidden_in_exec_is_not_demonstrated_either_way(self):
        self.assertIsNone(self.build("python3 -c \"exec('import report')\""))      # unknown: no source at all, never a guess

class PayloadFlowSurfaces(Base):
    """What a `python -c` payload only MAY do (a binding made in a branch, a name that is local but not bound yet) leaves the window undemonstrated on every surface; what it only CREATES (a lambda that is thrown away, a
    generator function that is called and discarded) is real work on every surface; an authentic, certain import is still activity."""
    S = ImportedScripts.S; build = ImportedScripts.build
    def undemonstrated(self, payload):
        self.assertIsNone(self.build(payload), payload)      # the shared context: no source at all, never a guess
        v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == "w2")
        row = versions.bind_versions([dict(version_ref=versions.version_ref(v, "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)["k"]["omission"]      # report rebinding
        self.assertIsNone(row["eligible_source"]); self.assertIn("ambiguous", row["material_reason"])
        obj, code = self.prepare_omission("first request"); self.assertEqual(code, 3, obj); self.assertFalse(obj["ok"]); self.assertIn("ambiguous", " ".join(obj["reasons"]))

    def test_a_binding_made_in_a_branch_is_not_a_certain_binding(self):
        for payload in ("python3 -c 'import sys\nif sys.argv[1:]:\n    import importlib\nimportlib.import_module(\"report\")'", "python3 -c 'import sys\nif sys.argv[1:]:\n    from importlib import import_module\nimport_module(\"report\")'",
                        "python3 -c 'import sys\nif sys.argv[1:]:\n    def import_module(n): pass\nelse:\n    from importlib import import_module\nimport_module(\"report\")'",
                        "python3 -c 'import sys\nif sys.argv[1:]:\n    def f():\n        import report\nf()'"):
            with self.subTest(payload): self.undemonstrated(payload)

    def test_a_local_name_is_not_the_outer_one_before_its_own_assignment(self):
        self.undemonstrated("python3 -c 'from importlib import import_module\ndef f():\n    import_module(\"report\")\n    import_module = lambda n: None\nf()'")
        self.assertIn("PAYLOAD-RESULT", self.build("python3 -c 'from importlib import import_module\ndef f():\n    import_module = lambda n: None\n    import_module(\"report\")\nf()'"))      # a demonstrable local callable

    def test_a_generator_lambda_whose_result_is_used_may_run_and_is_undemonstrated(self):
        self.undemonstrated("python3 -c 'g = (lambda: (__import__(\"report\"), (yield 1)))()'")

    def test_a_name_that_a_lambda_assigns_is_local_in_the_whole_lambda(self):
        self.undemonstrated("python3 -c 'from importlib import import_module\n(lambda: (import_module(\"report\"), (import_module := lambda n: None)))()'")
        self.assertIn("PAYLOAD-RESULT", self.build("python3 -c 'from importlib import import_module\n(lambda: ((import_module := lambda n: None), import_module(\"report\")))()'"))      # a demonstrable local callable
        self.build("python3 -c 'from importlib import import_module\n(lambda: import_module(\"report\"))()'"); self.assert_source(["first request"], ["PAYLOAD-RESULT"])      # the authentic outer import is still activity

    def test_what_is_only_created_is_real_work_on_every_surface(self):
        for payload in ("python3 -c 'lambda: __import__(\"report\")'", "python3 -c 'def f():\n    yield 1\n    import report\nf()'", "python3 -c 'def f():\n    import report\n    yield 1\nf()'",
                        "python3 -c '(lambda: (__import__(\"report\"), (yield 1)))()'", "python3 -c 'f = lambda: (__import__(\"report\"), (yield 1))\nf()'"):
            with self.subTest(payload): self.build(payload); self.assert_source(["PAYLOAD-RESULT", "WORK-LEGIT"])

    def test_an_authentic_certain_import_is_still_activity_on_every_surface(self):
        for payload in ("python3 -c 'from importlib import import_module\ndef f():\n    import_module(\"report\")\nf()'", "python3 -c 'import importlib\nimportlib.import_module(\"report\")'",
                        "python3 -c 'def f():\n    global im\n    from importlib import import_module as im\nf()\nim(\"report\")'"):
            with self.subTest(payload): self.build(payload); self.assert_source(["first request"], ["PAYLOAD-RESULT"])

class ConditionalShellArtifacts(Base):
    """A redirect or a read that the exit statuses may have skipped, or that is only a quoted argument, is not demonstrated: it does not create an artifact, does not end its provenance and does not turn a legitimate
    result into a re-read. What really ran (an unconditional command, the last `&&` chain of a call that succeeded, `bash -c` under the condition of the command around it) keeps its meaning."""
    ART = "/virtual/reports/prior.verify.md"
    def build(self, inside="printf 'GENERATED' > /virtual/reports/prior.verify.md", outside=None, reader="cat /virtual/reports/prior.verify.md", result="READER-RESULT: GENERATED-DETAIL use lmdb"):
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1"); t.tool("g1", "Bash", dict(command=inside), "")
        t.say("RUN1-SUMMARY"); t.user("next request")
        if outside: t.tool("o1", "Bash", dict(command=outside), "OVERWRITE-RESULT")
        t.tool("rd", "Bash", dict(command=reader), result); t.say("WORK-LEGIT"); t.tool("w2", "Write", dict(file_path=self.note, content="N2\n"), "created"); t.save(self.log); return t

    def test_an_overwrite_that_never_ran_does_not_end_the_provenance(self):
        for outside in ("false && printf REAL > /virtual/reports/prior.verify.md; true", "echo '>' /virtual/reports/prior.verify.md", "echo x \">\" /virtual/reports/prior.verify.md", "false || printf REAL > /virtual/reports/prior.verify.md",
                        "false && (printf REAL > /virtual/reports/prior.verify.md); true", "false || bash -c 'printf REAL > /virtual/reports/prior.verify.md'", "bash -c 'false || printf REAL > /virtual/reports/prior.verify.md'",
                        "true && printf REAL > /virtual/reports/prior.verify.md; true", "printf REAL >> /virtual/reports/prior.verify.md"):
            with self.subTest(outside):
                self.build(outside=outside); self.assert_source(["WORK-LEGIT", "OVERWRITE-RESULT"], ["READER-RESULT"])

    def test_an_overwrite_that_really_ran_ends_the_provenance(self):
        for outside in ("printf REAL > /virtual/reports/prior.verify.md", "true && printf REAL > /virtual/reports/prior.verify.md", "cd /virtual/reports && printf REAL > prior.verify.md", "bash -c 'printf REAL > /virtual/reports/prior.verify.md'",
                        "true && bash -c 'printf REAL > /virtual/reports/prior.verify.md'", "printf REAL > /virtual/reports/prior.verify.md || true", "(printf REAL > /virtual/reports/prior.verify.md)", "printf REAL > '/virtual/reports/prior.verify.md'"):
            with self.subTest(outside):
                self.build(outside=outside); self.assert_source(["WORK-LEGIT", "READER-RESULT"])

    def test_a_read_that_never_ran_leaves_the_legitimate_result_in_the_source(self):
        for reader in ("false && cat /virtual/reports/prior.verify.md; printf REAL", "false || cat /virtual/reports/prior.verify.md", "false && bash -c 'cat /virtual/reports/prior.verify.md'; printf REAL", "echo cat > /virtual/reports/other.md; printf REAL",
                       "echo '<' /virtual/reports/prior.verify.md; printf REAL"):
            with self.subTest(reader):
                self.build(reader=reader); self.assert_source(["WORK-LEGIT", "READER-RESULT"])

    def test_a_read_that_ran_is_still_a_re_read(self):
        for reader in ("cat /virtual/reports/prior.verify.md || true", "cat /virtual/reports/prior.verify.md; printf REAL", "true && cat /virtual/reports/prior.verify.md", "bash -c 'cat /virtual/reports/prior.verify.md'", "cat /virtual/reports/prior.verify.md | head -3"):
            with self.subTest(reader):
                self.build(reader=reader); self.assert_source(["WORK-LEGIT"], ["READER-RESULT"])

    def test_a_write_inside_the_run_that_never_ran_creates_no_artifact(self):
        for inside in ("false && printf GENERATED > /virtual/reports/prior.verify.md; true", "echo GENERATED '>' /virtual/reports/prior.verify.md", "false || bash -c 'printf GENERATED > /virtual/reports/prior.verify.md'",
                       "bash -c 'false || printf GENERATED > /virtual/reports/prior.verify.md'", "false || (printf GENERATED > /virtual/reports/prior.verify.md)"):
            with self.subTest(inside):
                self.build(inside=inside); self.assert_source(["WORK-LEGIT", "READER-RESULT"])

    def test_a_write_inside_the_run_that_ran_creates_the_artifact(self):
        for inside in ("true && printf GENERATED > /virtual/reports/prior.verify.md", "bash -c 'printf GENERATED > /virtual/reports/prior.verify.md'", "true && bash -c 'printf GENERATED > /virtual/reports/prior.verify.md'",
                       "cd /virtual/reports && printf GENERATED > prior.verify.md", "printf GENERATED > '/virtual/reports/prior.verify.md'"):
            with self.subTest(inside):
                self.build(inside=inside); self.assert_source(["WORK-LEGIT"], ["READER-RESULT"])

    def test_the_artifact_stays_a_redirect_not_a_supported_write(self):
        self.build(outside="false && printf REAL > /virtual/reports/prior.verify.md; true")
        self.assertEqual([v["write_tool_use_id"] for v in versions.versions_of(self.log, self.note)[0]], ["w1", "w2"]); self.assertEqual(versions.provenance(self.log, self.ART)["state"], "bash_only")

class FalseOmissionPair(Base):
    """ABSENCE-first pair: the detail exists only in a verification artifact that a never-executed overwrite pretended to replace. Two Jev calls are RECORDED in another session (ABSENCE first, then SOURCE; canonical claims,
    the complete material and the passage as their evidence, authentic result shapes), bound with `jevref.bind`, given their version identity and material by `versions.bind_versions` / `attach` and judged by the validator
    (and by `report.bind_report`): the eligible source must not hold the quote any more, so the recorded SOURCE evidence no longer is an eligible passage and the pair is refused; `prepare` refuses the quote too. An overwrite
    that really ran frees the file, and the pair of its legitimate content (same machinery) confirms."""
    ART = "/virtual/reports/prior.verify.md"; DETAIL = "GENERATED-DETAIL we decided on lmdb"; NOTE2 = "N2 the note says nothing of the storage\n"
    def build(self, overwrite, content, log=None, generated=None):
        t = Tx(self.d); t.user("first request"); t.tool("w1", "Write", dict(file_path=self.note, content="N1\n"), "created"); t.run("sk1")
        t.tool("g1", "Bash", dict(command="printf '%s' 'GENERATED-DETAIL we decided on lmdb' > " + (generated or self.ART)), ""); t.say("RUN1-SUMMARY"); t.user("next request")
        t.tool("o1", "Bash", dict(command=overwrite), ""); t.tool("rd", "Bash", dict(command="cat " + self.ART), content); t.say("WORK-LEGIT")
        t.tool("w2", "Write", dict(file_path=self.note, content=self.NOTE2), "created"); t.save(log or self.log)

    def recorded_passage(self, content):
        """The eligible passage the SOURCE call was given when the pair was recorded: the block that holds `content` in a sibling session where the file was never generated by a verification run, so that the result of
        the read is real work (the same records, the same block text). It is derived by `omissions.context`, not typed."""
        log = os.path.join(self.d, "sibling.jsonl"); self.build("true", content, log=log, generated="/virtual/reports/unrelated.md"); omissions._MEMO.clear()
        v = next(x for x in versions.versions_of(log, self.note)[0] if x["write_tool_use_id"] == "w2")
        passage = omissions.passage_of(omissions.context(log, self.note, v, "prefix", (), None)["eligible_blocks"], content); omissions._MEMO.clear()
        self.assertIsNotNone(passage); return passage

    def record(self, detail, passage, calls_log):
        """The calls log of ANOTHER session with the two recorded calls, ABSENCE then SOURCE, and the report document about them (checks, finding) over the saved session."""
        v = next(x for x in versions.versions_of(self.log, self.note)[0] if x["write_tool_use_id"] == "w2"); ref = versions.version_ref(v, "prefix")
        sc, ac = omissions.claims(detail, "R04"); mat = omissions.material(self.NOTE2)
        c = Tx(self.d)
        c.tool("a1", "mcp__jev__jev_verify", dict(claims=[ac], evidence=[dict(text=mat)]), json.dumps(dict(subject_at=0.5, results=[dict(claim=ac, verdict="unsupported", confidence=0.98, action="auto")])))
        c.tool("s1", "mcp__jev__jev_verify", dict(claims=[sc], evidence=[dict(text=passage)]), json.dumps(dict(subject_at=0.5, results=[dict(claim=sc, verdict="verified", confidence=0.99, action="auto", same_subject=0.9)])))
        for r in c.recs: r["sessionId"] = "calls-session"
        c.save(calls_log)
        checks = [dict(id="abs", tool="verify", verdict="unsupported", confidence=0.98, jev_ref=dict(tool_use_id="a1", result_index=0, key=ac), version_ref=ref),
                  dict(id="src", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="s1", result_index=0, key=sc), version_ref=ref)]
        f = dict(type="lost_detail", check_id="abs", claim=ac, confidence=0.98, quote_source=detail, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=detail, source_check_id="src"))
        return dict(session=dict(session_id="s1", jsonl=self.log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=checks, findings=[f], unresolved=[], status="FAIL")

    def judge(self, detail, passage):
        """-> (document, bindings by check id before `finalize`, calls log path, validator answer): bound / resolved / identity come from `jevref.bind`, `versions.bind_versions` and `versions.attach`, never from constants."""
        os.makedirs(os.path.join(self.d, "calls"), exist_ok=True); log = os.path.join(self.d, "calls", "c.jsonl"); doc = self.record(detail, passage, log); omissions._MEMO.clear()
        calls = jevref.load_calls(log); self.assertEqual([c["tool_use_id"] for c in calls], ["a1", "s1"])      # ABSENCE before SOURCE
        bs = jevref.bind(doc["checks"], calls, "R04"); rows = versions.bind_versions(doc["checks"], bs, self.note, self.log, calls, False); by = {b["id"]: b for b in versions.attach(bs, rows)}
        return doc, by, log, jevref._validate_omission(doc["findings"][0], by["abs"], by, "R04")

    def check_recorded_shapes(self, by, passage):
        for cid in ("abs", "src"): self.assertTrue(by[cid]["bound"], by[cid]); self.assertTrue(by[cid]["version"]["ok"], by[cid]["version"]); self.assertEqual(by[cid]["version"]["write_tool_use_id"], "w2")
        self.assertTrue(by["src"]["resolved"]); self.assertFalse(by["abs"]["resolved"])      # R04: an `unsupported` is resolved only by `finalize`, as the half of a valid pair
        self.assertEqual(by["src"]["call_evidence_raw"], [passage])      # the SOURCE evidence as it was recorded

    def test_the_validator_refuses_the_recorded_pair_of_an_overwrite_that_never_ran(self):
        passage = self.recorded_passage(self.DETAIL)
        for overwrite in ("false && printf '%s' REAL > " + self.ART + "; true", "echo '>' " + self.ART, "false || bash -c 'printf REAL > " + self.ART + "'"):
            with self.subTest(overwrite):
                self.build(overwrite, self.DETAIL); doc, by, log, (confirmed, why) = self.judge(self.DETAIL, passage); self.check_recorded_shapes(by, passage)
                self.assertFalse(confirmed, why); self.assertIn("source quote", why)      # the validator itself refuses the pair
                self.assertIsNone(omissions.passage_of(by["src"]["eligible_blocks"], self.DETAIL))      # because the recorded quote is not an eligible passage any more
                self.assertFalse(jevref.finalize(list(by.values()), doc["findings"], None, "R04")[0]["resolved"])      # nothing makes the ABSENCE half resolved
                rep = report.bind_report(doc, log, self.d, (), True, self.note, None, "R04"); self.assertNotEqual(rep["status"], "FAIL"); self.assertEqual(rep["status"], "UNRESOLVED")

    def test_prepare_refuses_the_quote_of_an_overwrite_that_never_ran(self):
        for overwrite in ("false && printf '%s' REAL > " + self.ART + "; true", "echo '>' " + self.ART, "false || bash -c 'printf REAL > " + self.ART + "'"):
            with self.subTest(overwrite):
                self.build(overwrite, self.DETAIL); obj, code = self.prepare_omission(self.DETAIL); self.assertEqual(code, 3, obj); self.assertFalse(obj["ok"]); self.assertIn("source quote", " ".join(obj["reasons"]))

    def test_a_command_line_prepare_refuses_it_too(self):
        self.build("false && printf '%s' REAL > " + self.ART + "; true", self.DETAIL)
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w2", "--evaluated-against", "prefix", "--detail", self.DETAIL, "--source-quote", self.DETAIL,
                            "--cwd", self.d], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 3, p.stdout); self.assertFalse(json.loads(p.stdout)["ok"])

    def test_an_overwrite_that_ran_frees_the_file_and_its_content_confirms(self):
        legit = "REAL-DETAIL we decided on sqlite"; passage = self.recorded_passage(legit)
        for overwrite in ("printf '%s' REAL > " + self.ART, "true && printf '%s' REAL > " + self.ART):
            with self.subTest(overwrite):
                self.build(overwrite, legit); obj, code = self.prepare_omission(legit); self.assertEqual(code, 0, obj); self.assertTrue(obj["ok"])
                doc, by, log, verdict = self.judge(legit, passage); self.check_recorded_shapes(by, passage)
                self.assertEqual(verdict, (True, "confirmed")); self.assertTrue(jevref.finalize(list(by.values()), doc["findings"], None, "R04")[0]["resolved"])
                self.assertEqual(report.bind_report(doc, log, self.d, (), True, self.note, None, "R04")["status"], "FAIL")

class Canonical(Base):
    A, B, X = "alpha beta", "alpha external beta", "alpha external gamma"
    def test_a_relative_write_with_a_recorded_cwd_is_grouped_under_that_cwd(self):
        t = Tx(self.d); t.user("req"); t.tool("w1", "Write", dict(file_path="CONTINUE-HERE.md", content="REL\n"), "created"); t.save(self.log)
        old = os.getcwd(); os.chdir(tempfile.gettempdir())
        try: code, out, work = self.prepare()
        finally: os.chdir(old)
        inv = json.load(open(os.path.join(work, "inventory.json"))); real = os.path.join(self.d, "CONTINUE-HERE.md")
        self.assertEqual([h["path"] for h in inv["handoffs"]], [real]); self.assertEqual([v["status"] for v in inv["handoffs"][0]["versions"]], ["ok"])
        self.assertEqual(open(os.path.join(work, inv["handoffs"][0]["versions"][0]["file"])).read(), "REL\n")

    def test_without_a_recorded_cwd_a_relative_path_is_not_placed_under_the_process_cwd(self):
        t = Tx(None); t.user("req"); t.tool("w1", "Write", dict(file_path="HANDOFF.md", content="REL\n"), "created"); t.save(self.log)
        old = os.getcwd(); os.chdir(self.d)
        try:
            self.assertEqual(versions.versions_of(self.log, os.path.join(self.d, "HANDOFF.md"))[0], [])
            self.assertEqual(versions.provenance(self.log, os.path.join(self.d, "HANDOFF.md"))["state"], "no_record")
            code, out, work = prepare_in(self, self.d)
        finally: os.chdir(old)
        inv = json.load(open(os.path.join(work, "inventory.json"))); self.assertEqual(inv["handoffs"], [])
        self.assertEqual([u["path"] for u in inv["unplaced_writes"]], ["HANDOFF.md"]); self.assertIn("cwd", inv["unplaced_writes"][0]["reason"])

    def test_a_relative_read_with_an_absolute_structured_path_is_a_base(self):
        n = len(self.B.splitlines()); full = dict(type="text", file=dict(filePath=self.note, content=self.B, startLine=1, numLines=n, totalLines=n))
        t = Tx(self.d); t.tool("w1", "Write", dict(file_path=self.note, content=self.A), "created"); t.tool("r1", "Read", dict(file_path="HANDOFF.md"), "cat -n", toolUseResult=full)
        t.tool("e1", "Edit", dict(file_path=self.note, old_string="beta", new_string="gamma"), "edited"); t.save(self.log)
        old = os.getcwd(); os.chdir(tempfile.gettempdir())
        try:
            self.assertEqual([v["content"] for v in versions.versions_of(self.log, self.note)[0]], [self.A, self.X])
            self.assertEqual(versions.replay_all(self.log)["e1"][0], self.X)
            code, out, work = self.prepare()
        finally: os.chdir(old)
        rows = json.load(open(os.path.join(work, "inventory.json")))["handoffs"][0]["versions"]
        self.assertEqual(open(os.path.join(work, rows[1]["file"])).read(), self.X)
        # a structured path that is another file is still rejected
        other = dict(full, file=dict(full["file"], filePath=os.path.join(self.d, "other.md")))
        t2 = Tx(self.d); t2.tool("w1", "Write", dict(file_path=self.note, content=self.A), "created"); t2.tool("r1", "Read", dict(file_path="HANDOFF.md"), "cat -n", toolUseResult=other)
        t2.tool("e1", "Edit", dict(file_path=self.note, old_string="beta", new_string="gamma"), "edited"); t2.save(self.log)
        self.assertEqual([v["content"] for v in versions.versions_of(self.log, self.note)[0]], [self.A, "alpha gamma"])

    def test_relocation_resolves_relative_writes_in_the_recorded_cwd(self):
        sub = os.path.join(self.d, "sub"); os.makedirs(sub); t = Tx(sub); t.user("req"); t.tool("w1", "Write", dict(file_path="HANDOFF.md", content="CONTENT\n"), "created"); t.save(self.log)
        copy = os.path.join(self.d, "HANDOFF.md"); open(copy, "w").write("CONTENT\n")
        old = os.getcwd(); os.chdir(tempfile.gettempdir())
        try: reloc, why = versions.relocation_candidate(self.log, copy)
        finally: os.chdir(old)
        self.assertEqual(reloc, os.path.join(sub, "HANDOFF.md"), why)

class InsideRecord(Base):
    """The audit prefix is the exact tool_use boundary, not the JSONL line: a record [text, Write, text] keeps its first text in the prefix chunks and loses the second."""
    def build(self):
        t = Tx(self.d); t.user("request one")
        t.rec("assistant", [dict(type="text", text="DETAIL-BEFORE-WRITE"), dict(type="tool_use", id="w1", name="Write", input=dict(file_path=self.note, content="N1\n")), dict(type="text", text="DETAIL-AFTER-WRITE")])
        t.rec("user", [dict(type="tool_result", tool_use_id="w1", content="created")]); t.user("request two"); t.save(self.log); return t

    def test_the_prefix_chunks_keep_the_part_of_the_record_before_the_write(self):
        self.build(); code, out, work = self.prepare(); self.assertEqual(code, 0); row = json.load(open(os.path.join(work, "inventory.json")))["handoffs"][0]["versions"][0]
        pre = "".join(open(os.path.join(work, f), encoding="utf-8").read() for f in row["prefix_chunks"])
        self.assertIn("request one", pre); self.assertIn("DETAIL-BEFORE-WRITE", pre); self.assertNotIn("DETAIL-AFTER-WRITE", pre); self.assertNotIn("request two", pre)
        self.assertEqual(row["prefix_records"], 2)
        eligible = "\n".join(self.context_prefix())
        self.assertIn("DETAIL-BEFORE-WRITE", eligible); self.assertNotIn("DETAIL-AFTER-WRITE", eligible)       # the same boundary as the source window
        self.assertTrue(json.load(open(os.path.join(work, "coverage.json")))["complete"])

    def test_nothing_is_lost_or_duplicated_and_chunks_do_not_straddle_the_write(self):
        self.build(); code, out, work = self.prepare(); texts = [open(os.path.join(work, "transcript", f), encoding="utf-8").read() for f in sorted(os.listdir(os.path.join(work, "transcript")))]
        whole = "".join(texts)
        for want in ("request one", "DETAIL-BEFORE-WRITE", "DETAIL-AFTER-WRITE", "request two"): self.assertEqual(whole.count(want), 1, want)
        self.assertFalse([x for x in texts if "DETAIL-BEFORE-WRITE" in x and "DETAIL-AFTER-WRITE" in x])

    def context_prefix(self): return self.context("w1", "prefix")["eligible_blocks"]

class Positions(Base):
    def reversed_session(self):
        t = Tx(self.d, stamp=False)
        t.user("CHATTER-A", ts="2026-01-01T00:00:30Z"); t.tool("w1", "Write", dict(file_path=self.note, content="N\n"), "created", ts="2026-01-01T00:00:20Z")
        t.user("CHATTER-B", ts="2026-01-01T00:00:10Z"); t.user("CHATTER-C", ts="2026-01-01T00:00:05Z"); t.save(self.log)

    def test_prefix_records_and_prefix_chunks_come_from_stream_positions_not_timestamps(self):
        self.reversed_session(); code, out, work = self.prepare(); self.assertEqual(code, 0); inv = json.load(open(os.path.join(work, "inventory.json"))); row = inv["handoffs"][0]["versions"][0]
        self.assertEqual(row["prefix_records"], 1)
        pre = "".join(open(os.path.join(work, f), encoding="utf-8").read() for f in row["prefix_chunks"])
        self.assertIn("CHATTER-A", pre); self.assertNotIn("CHATTER-B", pre); self.assertNotIn("CHATTER-C", pre)
        self.assertTrue(row["prefix_chunks"]); self.assertEqual(row["prefix_source_file"], self.log)

    def test_absent_timestamps_give_the_same_prefix(self):
        t = Tx(self.d, stamp=False); t.user("CHATTER-A"); t.tool("w1", "Write", dict(file_path=self.note, content="N\n"), "created"); t.user("CHATTER-B"); t.save(self.log)
        code, out, work = self.prepare(); row = json.load(open(os.path.join(work, "inventory.json")))["handoffs"][0]["versions"][0]
        self.assertEqual(row["prefix_records"], 1); self.assertNotIn("CHATTER-B", "".join(open(os.path.join(work, f), encoding="utf-8").read() for f in row["prefix_chunks"]))

    def test_chunks_never_straddle_a_write_position(self):
        self.reversed_session(); code, out, work = self.prepare(); cov = json.load(open(os.path.join(work, "coverage.json")))
        self.assertTrue(cov["complete"]); self.assertIn("informational", cov["merged_view"])
        texts = [open(os.path.join(work, "transcript", f), encoding="utf-8").read() for f in sorted(os.listdir(os.path.join(work, "transcript")))]
        self.assertFalse([x for x in texts if "CHATTER-A" in x and "CHATTER-B" in x])

def prepare_in(case, cwd):
    out = io.StringIO(); work = os.path.join(case.d, "workp%d" % len(os.listdir(case.d))); old = sys.argv; sys.argv = ["prepare.py", case.log, "--cwd", cwd, "--out", work]
    try:
        with contextlib.redirect_stdout(out): code = prepare.main()
    finally: sys.argv = old
    return code, json.loads(out.getvalue()), work

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of orchestrate.py, the thin same-session orchestrator (stdlib only, no model session, no Jev call, never reads .handoff-verify/). The sessions are synthetic Claude Code logs and the Jev responses are invented validator fixtures (the same ones as test_doc_end_to_end.py),
not verification evidence. Parity: the orchestrated path and the direct documented path (audit.py template, checks, report.write_report, versions gate) run on identical inputs and must agree on checks, statuses, audit obligations and delivery state. Then the whole cycle of an approved
change: report, per-file approval and backup (the note is NOT replaced), a RECORDED Edit, rejection of the old report, a fresh cycle on the new version (a check of the old version is never carried over) and a PASS with verified_version. Negative variants fail closed; missing review stays missing.
usage: python3 -B test_orchestrate.py [-v]"""
import ast, contextlib, io, json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, omissions, orchestrate, report, scope, versions
import audit_fixtures as AF
import contract_fixtures as CF
import test_doc_end_to_end as E2E
import test_run_binding as RB

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
CLAIM = "The latest commit is e41a9c2 (migrate billing to duckdb)"
EDIT = ("commit e41a9c2.", "commit e41a9c2 (migrate billing to duckdb).")

def sha(t): return __import__("hashlib").sha256(t.encode("utf-8")).hexdigest()

def run(argv):
    """The orchestrator in THIS process (a profiler sees its call sites) -> (exit code, parsed JSON)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): code = orchestrate.main(argv)
    return code, json.loads(buf.getvalue())

def cli(script, args):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + args, capture_output=True, text=True, env=ENV)
    try: return p.returncode, json.loads(p.stdout)
    except ValueError: return p.returncode, None

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name); omissions.reset_caches(); scope._MEMO.clear(); A._PLANS.clear()
        sec, blocks = E2E.example(6); self.user = re.search(r"\[u-\d+ [a-z_ ]+\] (.*)", blocks[0]).group(1)
        self.note = "".join(l + "\n" for l in blocks[1].splitlines() if l.strip() and not l.startswith("("))

    def session(self, sub, calls=(), edit=False):
        """A synthetic session in directory `sub`: the request, the Write of the note, the skill run, then the recorded Jev calls ((id, input, body)) and optionally the recorded Edit."""
        d = os.path.join(self.d, sub); os.makedirs(d, exist_ok=True); t = RB.Tx(d); t.user(self.user); t.write("w1", self.note); t.run("sk1"); open(t.note, "w", encoding="utf-8").write(self.note)
        for tid, inp, body in calls: t.tool(tid, "mcp__jev__jev_verify", inp, body)
        t.save(); return t

    def good_call(self, tid="c1", conf=0.99, compat=True):
        return (tid, dict(claims=[CLAIM], evidence=[dict(text=self.user)]), CF.verify_body([dict(claim=CLAIM, verdict="verified", confidence=conf)], compatible_synthetic=compat))

    def record(self, t, calls=(), edit=False):
        """Append to the SAME log what the session does next: a recorded Edit (and the disk change) and/or Jev calls."""
        if edit:
            t.tool("e1", "Edit", dict(file_path=t.note, old_string=EDIT[0], new_string=EDIT[1]), "The file has been updated successfully"); self.note2 = self.note.replace(*EDIT, 1); open(t.note, "w", encoding="utf-8").write(self.note2)
        for tid, inp, body in calls: t.tool(tid, "mcp__jev__jev_verify", inp, body)
        t.save()

    def prep(self, t, state, *extra):
        return run(["prepare", "--session", t.log, "--file", t.note, "--cwd", t.d, "--state", os.path.join(self.d, state)] + list(extra))

    def reviewed(self, state, complete=True):
        """What the reviewing model does: READ every chunk file that prepare.py wrote and quote a record of it, one grounded outcome per category. -> the audit block."""
        tpl = json.load(open(os.path.join(self.d, state, "audit-template.json"), encoding="utf-8")); b = tpl["block"]
        def basis(i):
            text = open(os.path.join(self.d, state, "work", "transcript", "chunk-%04d.txt" % i), encoding="utf-8").read()
            m = next(m for m in re.finditer(r"^\[([^ \]]+) (?:user|assistant)\] (.+)$", text, re.M) if m.group(2).strip()); return dict(uuid=m.group(1), quote=m.group(2).strip()[:24])
        if complete:
            for c in b["chunks"]: c.update(reviewed=True, categories=list(A.CATEGORIES), basis=basis(c["index"]))
            for c in b["categories"]: c.update(outcome="no_candidate", basis=basis(b["chunks"][0]["index"]))
        return b

    def spec(self, name, t, state, block, status="PASS", call="c1", conf=0.99, md="Stare: **PASS**\n"):
        shell = AF.shell(dict(findings=[], unresolved=[], status=status, scope_exclusions=[])); [shell.pop(k) for k in ("session", "handoff", "checks", "audit") if k in shell]
        spec = dict(doc=shell, audit_block=block, md=md, check_specs=[dict(id="p1", tool="verify", tool_use_id=call, result_index=0, input=dict(claims=[CLAIM], evidence=[dict(text=self.user)]))])
        p = os.path.join(self.d, name); json.dump(spec, open(p, "w", encoding="utf-8")); return p

class Parity(Base):
    def test_the_orchestrated_path_and_the_direct_path_agree_on_identical_inputs(self):
        # direct documented path (the same procedure as test_doc_end_to_end.GenuinePass)
        td = self.session("direct", [self.good_call()]); work = os.path.join(td.d, "work"); self.assertEqual(cli("prepare.py", [td.log, "--cwd", td.d, "--out", work])[0], 0)
        code, o = cli("audit.py", ["template", "--source", td.log, "--file", td.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", td.d]); self.assertEqual(code, 0, o); block = o["block"]
        for c in block["chunks"]:
            text = open(os.path.join(work, "transcript", "chunk-%04d.txt" % c["index"]), encoding="utf-8").read(); m = next(m for m in re.finditer(r"^\[([^ \]]+) (?:user|assistant)\] (.+)$", text, re.M) if m.group(2).strip())
            c.update(reviewed=True, categories=list(A.CATEGORIES), basis=dict(uuid=m.group(1), quote=m.group(2).strip()[:24]))
        for c in block["categories"]: c.update(outcome="no_candidate", basis=block["chunks"][0]["basis"])
        v = versions.versions_of(td.log, td.note)[0][0]; ref = versions.version_ref(v, "prefix")
        chk = [dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM), version_ref=ref)]
        rd = os.path.join(td.d, "run-direct"); os.makedirs(rd)
        ddoc = AF.shell(dict(session=dict(session_id="s1", jsonl=td.log, cwd=td.d), handoff=dict(path=td.note, versions=[]), checks=chk, findings=[], unresolved=[], status="PASS", scope_exclusions=[], audit=dict(version=1, evaluations=[block], registry=o["registry"])))
        _, js = report.write_report(rd, td.note, ddoc, "Stare: **PASS**\n", calls_jsonl=td.log); direct = json.load(open(os.path.join(rd, js), encoding="utf-8")); g = versions.gate(td.log, td.note, direct, disk_path=td.note)
        # orchestrated path on a twin session
        t = self.session("orch", [self.good_call()]); code, p = self.prep(t, "st"); self.assertEqual(code, 0, p); self.assertEqual((p["version"]["write_id"], p["version"]["sha256"]), ("w1", sha(self.note)))
        code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", self.spec("spec.json", t, "st", self.reviewed("st"))]); self.assertEqual(code, 0, f); orch = json.load(open(f["report"]["json"], encoding="utf-8"))
        self.assertTrue(f["success"]); self.assertEqual((f["delivery"]["state"], f["delivery"]["audited_status"], f["report"]["status"]), ("verified_version", "PASS", "PASS"))
        self.assertEqual((direct["status"], g["delivery_state"], g["audited_status"]), ("PASS", "verified_version", "PASS"))
        strip = lambda c: dict(id=c["id"], tool=c["tool"].replace("jev_", ""), verdict=c["verdict"], confidence=c["confidence"], jev_ref=c["jev_ref"], binding=c["binding"])
        self.assertEqual([strip(c) for c in orch["checks"]], [strip(c) for c in direct["checks"]])
        for k in ("checks", "bound", "resolved", "unbound", "reasons"): self.assertEqual(orch["binding_summary"][k], direct["binding_summary"][k], k)
        self.assertEqual({k: orch["binding_summary"]["audit"][k] for k in ("complete", "unfinished")}, {k: direct["binding_summary"]["audit"][k] for k in ("complete", "unfinished")})
        self.assertEqual(orch["blockers"], direct["blockers"]); self.assertEqual(orch["delivery"]["bound_checks_for_version"], direct["delivery"]["bound_checks_for_version"])

class AmbiguousWindow(Base):
    def edited(self, command):
        """A verified note, a skill run that names a script by `command`, then a recorded Edit: -> the session."""
        t = self.session("s", [self.good_call()]); t.tool("b1", "Bash", dict(command=command), "ok"); self.record(t, edit=True); return t

    def test_a_variable_assigned_a_literal_absolute_path_in_the_same_command_is_a_recognised_run(self):
        t = self.edited("SK=/x/skills/handoff-verify; python3 -B $SK/scripts/audit.py template --source s"); code, o = self.prep(t, "st"); self.assertEqual(code, 0, o); self.assertEqual(o["version"]["op"], "Edit")

    def test_a_script_named_through_a_variable_nobody_assigned_blocks_the_later_version_and_the_refusal_says_why(self):
        t = self.edited("python3 -B $SK/scripts/audit.py template --source s")
        code, o = self.prep(t, "st"); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "source window ambiguous" in r], o); self.assertTrue([r for r in o["reasons"] if "literally and absolute" in r], o)
        self.assertFalse(os.path.exists(os.path.join(self.d, "st", "state.json")))      # nothing is certified from a half-prepared state

    def test_the_same_command_with_a_literal_absolute_path_is_a_recognised_run_and_the_next_version_prepares(self):
        t = self.edited("python3 -B /x/skills/handoff-verify/scripts/audit.py template --source s"); code, o = self.prep(t, "st"); self.assertEqual(code, 0, o); self.assertEqual(o["version"]["op"], "Edit")

class DocTemplate(Base):
    def test_the_template_prepare_prints_is_a_complete_report_shell_and_a_pass_needs_nothing_more(self):
        t = self.session("s", [self.good_call()]); code, p = self.prep(t, "st"); self.assertEqual(code, 0, p); tpl = json.load(open(p["doc_template"], encoding="utf-8"))
        self.assertEqual(set(tpl), {"variant", "environment", "kit", "cost", "patch", "findings", "unresolved", "scope_exclusions", "status"}); self.assertEqual(tpl["environment"], {"model": "unknown"})      # honest unknowns, never invented facts
        spec = json.load(open(self.spec("a.json", t, "st", self.reviewed("st")))); spec["doc"] = dict(tpl, status="PASS"); json.dump(spec, open(os.path.join(self.d, "b.json"), "w"))
        code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", os.path.join(self.d, "b.json")]); self.assertEqual(code, 0, f); self.assertTrue(f["success"])
        spec["doc"] = dict(tpl, status="PASS", environment={"model": 5}); json.dump(spec, open(os.path.join(self.d, "c.json"), "w"))      # a template value that breaks the schema is never a PASS
        code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", os.path.join(self.d, "c.json")]); self.assertEqual(code, 3); self.assertFalse(f["success"])

class FullCycle(Base):
    def test_report_approval_backup_recorded_edit_old_report_rejected_and_a_fresh_pass(self):
        t = self.session("s", [self.good_call("c1")]); S1, S2 = os.path.join(self.d, "st1"), os.path.join(self.d, "st2")
        code, p = self.prep(t, "st1"); self.assertEqual(code, 0, p); code, f = run(["finalize", "--state", S1, "--spec", self.spec("s1.json", t, "st1", self.reviewed("st1"))]); self.assertEqual(code, 0, f); self.assertTrue(f["success"])
        old_report = f["report"]["json"]
        # no approval, another version, nothing is backed up and the note is untouched
        for what, args in (("no approval", ["--expected-sha256", sha(self.note)]), ("another version", ["--expected-sha256", sha("x"), "--approved"])):
            code, o = run(["edit-preflight", "--state", S1] + args); self.assertEqual((code, o["ok"]), (3, False), what); self.assertEqual(sorted(x for x in os.listdir(t.d) if ".bak-" in x), [], what)
        code, o = run(["edit-preflight", "--state", S1, "--expected-sha256", sha(self.note), "--approved"]); self.assertEqual(code, 0, o)
        self.assertEqual(open(o["backup"], encoding="utf-8").read(), self.note); self.assertEqual(open(t.note, encoding="utf-8").read(), self.note)      # the backup holds the verified bytes; the note is NOT replaced
        # a fresh cycle before any Edit is recorded refuses: the note is still the verified base
        code, o = self.prep(t, "st-early", "--previous-state", S1); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "no Edit was recorded" in r], o)
        # the writer performs the RECORDED Edit; the old report is no longer a verification of the delivered version
        self.record(t, edit=True); code, g = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", old_report, "--cwd", t.d]); self.assertEqual((code, g["delivery_state"]), (2, "needs_reverification"))
        code, o = self.prep(t, "st2", "--previous-state", S1, "--expect-sha256", sha("not it")); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "not the intended content" in r], o)
        code, o = self.prep(t, "st2", "--previous-state", S1, "--expect-sha256", sha(self.note2)); self.assertEqual(code, 0, o); self.assertEqual((o["version"]["write_id"], o["version"]["op"], o["version"]["sha256"]), ("e1", "Edit", sha(self.note2)))
        self.assertIn("+- Key values: commit e41a9c2 (migrate billing to duckdb).", o["change_since_verified_base"]); self.assertIn("-- Key values: commit e41a9c2.", o["change_since_verified_base"])      # what changed since the verified bytes is printed, so it can be held against the approved diff
        # no Jev call after the Edit yet: a PASS is impossible and the old call is not a check of the new version
        block = self.reviewed("st2"); code, f2 = run(["finalize", "--state", S2, "--spec", self.spec("s2a.json", t, "st2", block, call="c1")]); self.assertEqual(code, 3); self.assertFalse(f2["ok"]); self.assertTrue(f2["errors"])
        # the check of the OLD version carried over by its version_ref is refused before any report is written
        spec = json.load(open(self.spec("s2b.json", t, "st2", block))); v1 = versions.versions_of(t.log, t.note)[0][0]; spec["check_specs"][0]["version_ref"] = versions.version_ref(v1, "prefix"); json.dump(spec, open(os.path.join(self.d, "s2b.json"), "w"))
        before = set(os.listdir(os.path.join(t.d, ".handoff-verify", "s1")) if os.path.isdir(os.path.join(t.d, ".handoff-verify", "s1")) else [])
        code, f3 = run(["finalize", "--state", S2, "--spec", os.path.join(self.d, "s2b.json")]); self.assertEqual(code, 3); self.assertTrue([r for r in f3["reasons"] if "older version" in r or "another version" in r], f3)
        # fresh Jev call AFTER the Edit, then the final cycle
        self.record(t, [self.good_call("c2")]); code, f4 = run(["finalize", "--state", S2, "--spec", self.spec("s2c.json", t, "st2", block, call="c2")]); self.assertEqual(code, 0, f4)
        self.assertTrue(f4["success"]); self.assertEqual((f4["delivery"]["state"], f4["delivery"]["audited_status"], f4["audit"]["complete"]), ("verified_version", "PASS", True))
        final = json.load(open(f4["report"]["json"], encoding="utf-8")); self.assertEqual(final["delivery"]["current_sha256"], sha(self.note2)); self.assertEqual(final["delivery"]["latest_write_id"], "e1")
        code, g = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", f4["report"]["json"], "--cwd", t.d]); self.assertEqual((code, g["delivery_state"], g["audited_status"]), (0, "verified_version", "PASS"))
        self.assertNotEqual(f["report"]["sha256"], f4["report"]["sha256"])

class FailClosed(Base):
    def test_a_session_that_does_not_resolve_and_a_state_that_exists_are_refused(self):
        t = self.session("s", [self.good_call()]); code, o = run(["prepare", "--session", "no-such-session-id", "--file", t.note, "--cwd", t.d, "--state", os.path.join(self.d, "x")]); self.assertEqual((code, o["ok"]), (2, False))
        self.assertEqual(self.prep(t, "st")[0], 0); code, o = self.prep(t, "st"); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "fresh --state" in r])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): run(["prepare", "--file", t.note, "--cwd", t.d, "--state", os.path.join(self.d, "y")])      # the session is never guessed

    def test_bytes_on_disk_that_no_recorded_write_explains_are_not_certifiable(self):
        t = self.session("s", [self.good_call()]); open(t.note, "a", encoding="utf-8").write("one more line\n"); code, o = self.prep(t, "st"); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "differ from the last recorded write" in r], o)
        t = self.session("s2", [self.good_call()]); code, p = self.prep(t, "st2"); self.assertEqual(code, 0)
        open(t.note, "a", encoding="utf-8").write("changed after the preparation\n"); code, f = run(["finalize", "--state", os.path.join(self.d, "st2"), "--spec", self.spec("a.json", t, "st2", self.reviewed("st2"))]); self.assertEqual(code, 3); self.assertTrue([r for r in f["reasons"] if "differ" in r], f)
        code, o = run(["edit-preflight", "--state", os.path.join(self.d, "st2"), "--expected-sha256", sha(self.note), "--approved"]); self.assertEqual(code, 3); self.assertEqual([x for x in os.listdir(t.d) if ".bak-" in x], [])

    def test_an_edit_without_a_recorded_approval_step_is_not_accepted_as_the_continuation_of_a_state(self):
        t = self.session("s", [self.good_call()]); self.assertEqual(self.prep(t, "st")[0], 0); self.assertEqual(run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", self.spec("a.json", t, "st", self.reviewed("st"))])[0], 0)
        self.record(t, edit=True); code, o = self.prep(t, "st2", "--previous-state", os.path.join(self.d, "st")); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "no approved edit-preflight" in r], o)
        code, o = self.prep(t, "st3"); self.assertEqual(code, 0, o)      # without --previous-state it is a plain fresh cycle of the latest recorded write (the link to an approval is then simply not claimed)

    def test_a_missing_review_stays_missing_and_is_never_a_pass(self):
        t = self.session("s", [self.good_call()]); self.assertEqual(self.prep(t, "st")[0], 0)
        code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", self.spec("a.json", t, "st", self.reviewed("st", complete=False))]); self.assertEqual(code, 3)
        self.assertFalse(f["success"]); self.assertNotEqual(f["report"]["status"], "PASS"); self.assertFalse(f["audit"]["complete"]); self.assertGreaterEqual(f["audit"]["unfinished"]["chunks_unreviewed"], 1); self.assertEqual(f["delivery"]["state"], "verified_version")      # delivered but not a PASS
        spec = json.load(open(os.path.join(self.d, "a.json"))); spec.pop("audit_block"); json.dump(spec, open(os.path.join(self.d, "b.json"), "w")); code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", os.path.join(self.d, "b.json")]); self.assertEqual(code, 3); self.assertFalse(f["ok"])

    def test_the_strict_boundary_and_the_absent_auxiliary_fields_are_never_a_success(self):
        for what, call in (("0.95 exactly", self.good_call(conf=0.95)), ("no auxiliary fields", self.good_call(compat=False))):
            with self.subTest(what):
                t = self.session("s-" + what.split()[0], [call]); st = "st-" + what.split()[0]; self.assertEqual(self.prep(t, st)[0], 0)
                code, f = run(["finalize", "--state", os.path.join(self.d, st), "--spec", self.spec("c.json", t, st, self.reviewed(st))]); self.assertEqual(code, 3); self.assertFalse(f["success"]); self.assertEqual(f["report"]["status"], "UNRESOLVED")

    def test_a_forged_result_reference_is_refused_and_no_report_is_written(self):
        t = self.session("s", [self.good_call()]); self.assertEqual(self.prep(t, "st")[0], 0); spec = json.load(open(self.spec("a.json", t, "st", self.reviewed("st")))); spec["check_specs"][0]["tool_use_id"] = "forged"
        json.dump(spec, open(os.path.join(self.d, "f.json"), "w")); code, f = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", os.path.join(self.d, "f.json")]); self.assertEqual(code, 3); self.assertFalse(f["ok"]); self.assertTrue(f["errors"])
        self.assertEqual([f for r, _, fs in os.walk(os.path.join(t.d, ".handoff-verify")) for f in fs if f.endswith(".verify.json")], [])      # no report was written for a refused selection (preparation made its registry only)

    def test_a_second_finalize_gives_no_new_allowance(self):
        t = self.session("s", [self.good_call(conf=0.9)]); self.assertEqual(self.prep(t, "st")[0], 0); sp = self.spec("a.json", t, "st", self.reviewed("st"))
        a = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", sp]); b = run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", sp])
        self.assertEqual((a[0], b[0]), (3, 3)); self.assertEqual((a[1]["delivery"]["reasons"], a[1]["reasons"], a[1]["blockers"]), (b[1]["delivery"]["reasons"], b[1]["reasons"], b[1]["blockers"])); self.assertNotEqual(a[1]["report"]["json"], b[1]["report"]["json"])      # a new run, the same outcome

class Package(Base):
    def test_a_registered_candidate_is_prepared_like_the_direct_path_and_an_unregistered_one_is_refused(self):
        sec, blocks = E2E.example(2); user = re.search(r"\[u-\d+ [a-z_ ]+\] (.*)", blocks[0]).group(1); note = "".join(l + "\n" for l in blocks[1].splitlines() if l.strip() and not l.startswith("("))
        m = re.search(r'--detail "([^"]+)" --source-quote "([^"]+)"', sec); detail, quote = m.group(1), m.group(2)
        d = os.path.join(self.d, "p"); os.makedirs(d); t = RB.Tx(d); t.user(user); t.write("w1", note); t.run("sk1"); t.save(); open(t.note, "w", encoding="utf-8").write(note)
        self.assertEqual(self.prep(t, "st")[0], 0); sp = os.path.join(self.d, "pk.json"); json.dump(dict(omissions=[dict(detail=detail, source_quote=quote)]), open(sp, "w"))
        code, o = run(["package", "--state", os.path.join(self.d, "st"), "--spec", sp]); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "registered" in r], o)      # registration comes BEFORE any filtering
        code, r = cli("audit.py", ["register", "--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--detail", detail, "--category", "2", "--cwd", t.d]); self.assertEqual(code, 0, r)
        code, o = run(["package", "--state", os.path.join(self.d, "st"), "--spec", sp]); self.assertEqual(code, 0, o); res = json.load(open(o["batch"], encoding="utf-8")); self.assertEqual((o["candidates"], o["refused"]), (1, []))
        omissions._MEMO.clear(); import argparse; direct, c = omissions.prepare_one(argparse.Namespace(source=t.log, file=t.note, cwd=t.d, write_id="w1", evaluated_against="prefix", detail=detail, source_quote=quote, location=[], run=None)); self.assertEqual(c, 0)
        for k in ("absence_claim", "source_claim", "material", "source_passage"): self.assertEqual(res[0][k], direct[k], k)      # batch equals single

class ContextGuard(Base):
    def test_only_a_given_count_strictly_above_the_guard_shows_the_risk(self):
        t = self.session("s", [self.good_call()])
        for n, (tokens, risk) in enumerate(((None, None), (500000, None), (500001, True), (750000, True))):
            code, p = self.prep(t, "st%d" % n, *(["--context-tokens", str(tokens)] if tokens is not None else [])); self.assertEqual(code, 0, p); c = p["context"]
            self.assertEqual(c.get("high_context_risk"), risk, tokens)
            if tokens is None: self.assertEqual(c["state"], "unknown")      # nothing is guessed from usage records
            else: self.assertEqual((c["window"], c["guard"]), (1000000, 500000))

class Boundaries(unittest.TestCase):
    def test_the_orchestrator_calls_no_network_model_jev_approval_or_edit(self):
        src = open(os.path.join(HERE, "orchestrate.py"), encoding="utf-8").read(); tree = ast.parse(src)
        mods = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertEqual(mods - {"argparse", "datetime", "difflib", "hashlib", "json", "os", "subprocess", "sys", "tempfile", "audit", "discover", "report"}, set())      # no socket, urllib, http, ssl, requests
        fixed = {n.args[0].value for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "script" and n.args and isinstance(n.args[0], ast.Constant)}
        self.assertEqual(fixed, {"versions.py", "prepare.py", "audit.py", "omissions.py", "checks.py"})      # fixed local invocations of the skill's own scripts
        for forbidden in ("mcp__", "claude", "apply_patch", "WebFetch", "shell=True", "eval(", "exec("): self.assertNotIn(forbidden, src.replace("not apply_patch", "").replace("(not apply_patch)", ""), forbidden)
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "backup_only"]; self.assertEqual(len(calls), 1)      # the only thing that touches the note's directory is the backup half

    def test_orchestrate_py_is_a_verification_helper_for_the_session_end_cutoff(self):
        scripts = "/x/skills/handoff-verify/scripts"; self.assertIn("orchestrate.py", omissions.SKILL_SCRIPTS)
        for cmd in ("python3 -B %s/orchestrate.py prepare --session s" % scripts, "cd %s && python3 -c 'import orchestrate; orchestrate.main([])'" % scripts):
            recs = [dict(type="user", message=dict(role="user", content="Never run migrate.sh against prod.")), dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command=cmd))]))]
            self.assertEqual(omissions.verification_limit(recs), 1, cmd); recs[1]["message"]["content"][0]["input"]["command"] = "ls"; self.assertIsNone(omissions.verification_limit(recs))
        for cmd in ("python3 -B orchestrate.py prepare --session s", "python3 -c 'import orchestrate'"):      # the same name outside the skill's directory is an ordinary command
            recs = [dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command=cmd))]))]; self.assertIsNone(omissions.verification_limit(recs), cmd)

class Window(Base):
    def late(self, runs=1):
        """The note is written, the user adds a request, THEN the skill runs (once or twice, a user prompt between the runs)."""
        d = os.path.join(self.d, "w%d" % runs); os.makedirs(d); t = RB.Tx(d); t.user(self.user); t.write("w1", self.note); t.user("Never run migrate.sh against prod."); t.run("sk1"); t.tool(*self.good_call()[:1], "mcp__jev__jev_verify", *self.good_call()[1:])
        for k in range(2, runs + 1): t.user("verify once more"); t.run("sk%d" % k)
        t.save(); open(t.note, "w", encoding="utf-8").write(self.note); return t

    def test_prefix_is_said_to_leave_out_a_late_request_and_session_end_audits_it(self):
        t = self.late(); code, p = self.prep(t, "st-prefix"); self.assertEqual(code, 0, p); self.assertEqual(p["window"]["evaluated_against"], "prefix"); self.assertIn("NOT in this window", p["window"]["note"])
        code, q = self.prep(t, "st-end", "--evaluated-against", "session_end"); self.assertEqual(code, 0, q); self.assertEqual(q["version"]["version_ref"]["evaluated_against"], "session_end"); self.assertGreaterEqual(q["audit_chunks_expected"], p["audit_chunks_expected"])
        late_in = lambda st: "migrate.sh" in "".join(open(os.path.join(self.d, st, "work", "transcript", "chunk-%04d.txt" % c["index"]), encoding="utf-8").read() for c in json.load(open(os.path.join(self.d, st, "audit-template.json")))["block"]["chunks"])
        self.assertFalse(late_in("st-prefix")); self.assertTrue(late_in("st-end"))      # the request made after the write is in the audited window only under session_end
        code, f = run(["finalize", "--state", os.path.join(self.d, "st-end"), "--spec", self.spec("a.json", t, "st-end", self.reviewed("st-end"))]); self.assertEqual(code, 0, f); self.assertTrue(f["success"]); self.assertEqual(f["delivery"]["state"], "verified_version")

    def test_several_runs_after_the_write_need_a_named_run(self):
        t = self.late(runs=2); code, o = self.prep(t, "st", "--evaluated-against", "session_end"); self.assertEqual(code, 3); self.assertFalse(os.path.exists(os.path.join(self.d, "st", "state.json")))
        code, o = self.prep(t, "st2", "--evaluated-against", "session_end", "--run", "sk1"); self.assertEqual(code, 0, o); self.assertEqual(o["window"]["run"], "sk1")

class Continuation(Base):
    def verified(self, sub="s"):
        t = self.session(sub, [self.good_call()]); self.assertEqual(self.prep(t, "st")[0], 0); self.assertEqual(run(["finalize", "--state", os.path.join(self.d, "st"), "--spec", self.spec("a.json", t, "st", self.reviewed("st"))])[0], 0)
        self.assertEqual(run(["edit-preflight", "--state", os.path.join(self.d, "st"), "--expected-sha256", sha(self.note), "--approved"])[0], 0); return t

    def test_more_than_one_recorded_write_since_the_verified_base_is_not_the_approved_change(self):
        t = self.verified(); self.record(t, edit=True); t.tool("e2", "Edit", dict(file_path=t.note, old_string="duckdb", new_string="DuckDB"), "The file has been updated successfully"); open(t.note, "w", encoding="utf-8").write(self.note2.replace("duckdb", "DuckDB")); t.save()
        code, o = self.prep(t, "st2", "--previous-state", os.path.join(self.d, "st")); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "2 recorded writes since the verified base" in r], o)

    def test_a_state_of_another_note_is_not_a_previous_state(self):
        t = self.verified(); other = self.session("other", [self.good_call()]); self.record(other, edit=True)
        code, o = self.prep(other, "st-other", "--previous-state", os.path.join(self.d, "st")); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "another note or another session" in r], o)

    def test_a_second_preflight_never_overwrites_the_first_backup_and_a_tampered_state_is_refused(self):
        t = self.verified(); S = os.path.join(self.d, "st"); code, o = run(["edit-preflight", "--state", S, "--expected-sha256", sha(self.note), "--approved"]); self.assertEqual(code, 0, o)
        baks = sorted(x for x in os.listdir(t.d) if ".bak-" in x); self.assertEqual(len(baks), 2); self.assertEqual({open(os.path.join(t.d, b), encoding="utf-8").read() for b in baks}, {self.note})
        st = json.load(open(os.path.join(S, "state.json"))); st["version"]["sha256"] = sha("forged"); json.dump(st, open(os.path.join(S, "state.json"), "w"))
        code, o = run(["edit-preflight", "--state", S, "--expected-sha256", sha("forged"), "--approved"]); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "newer recorded write than this state" in r], o)      # the identities are re-derived, never trusted from the file

    def test_a_previous_state_that_names_another_session_is_refused_and_package_passes_the_locations_on(self):
        t = self.verified(); self.record(t, edit=True); S = os.path.join(self.d, "st"); st = json.load(open(os.path.join(S, "state.json"))); st["session"]["jsonl"] = os.path.join(self.d, "other.jsonl"); json.dump(st, open(os.path.join(S, "state.json"), "w"))
        code, o = self.prep(t, "st2", "--previous-state", S); self.assertEqual(code, 3); self.assertTrue([r for r in o["reasons"] if "another note or another session" in r], o)

class PackageMore(Base):
    def setUp(self):
        super().setUp(); sec, blocks = E2E.example(2); self.user2 = re.search(r"\[u-\d+ [a-z_ ]+\] (.*)", blocks[0]).group(1); self.note2_ = "".join(l + "\n" for l in blocks[1].splitlines() if l.strip() and not l.startswith("("))
        m = re.search(r'--detail "([^"]+)" --source-quote "([^"]+)"', sec); self.detail, self.quote = m.group(1), m.group(2)

    def test_a_candidate_whose_quote_is_not_in_the_source_is_refused_and_stays_refused_and_locations_are_kept(self):
        d = os.path.join(self.d, "p"); os.makedirs(d); loc = os.path.join(d, "loc"); os.makedirs(loc); t = RB.Tx(d); t.user(self.user2); t.write("w1", self.note2_); t.run("sk1"); t.save(); open(t.note, "w", encoding="utf-8").write(self.note2_)
        self.assertEqual(self.prep(t, "st", "--location", loc)[0], 0); self.assertEqual(json.load(open(os.path.join(self.d, "st", "state.json")))["locations"], [loc])
        self.assertEqual(cli("audit.py", ["register", "--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--detail", self.detail, "--category", "2", "--cwd", t.d])[0], 0)
        sp = os.path.join(self.d, "pk.json"); json.dump(dict(omissions=[dict(detail=self.detail, source_quote="a quote that is nowhere in the source")]), open(sp, "w"))
        seen = []; real = orchestrate.script
        def spy(name, args): seen.append((name, list(args))); return real(name, args)
        orchestrate.script = spy
        try: code, o = run(["package", "--state", os.path.join(self.d, "st"), "--spec", sp])
        finally: orchestrate.script = real
        self.assertEqual(code, 3); self.assertFalse(o["ok"]); self.assertEqual(len(o["refused"]), 1)
        batch = next(a for n, a in seen if n == "omissions.py"); self.assertIn("--location", batch); self.assertEqual(batch[batch.index("--location") + 1], loc)      # the user's work locations reach the preparation of the candidates

    def test_a_detail_registered_for_another_version_does_not_count_for_this_one(self):
        d = os.path.join(self.d, "q"); os.makedirs(d); t = RB.Tx(d); t.user(self.user2); t.write("w1", self.note2_); t.run("sk1"); t.save(); open(t.note, "w", encoding="utf-8").write(self.note2_); self.assertEqual(self.prep(t, "st")[0], 0)
        st = json.load(open(os.path.join(self.d, "st", "state.json"))); self.assertEqual(orchestrate.registered(st), set())
        self.assertEqual(cli("audit.py", ["register", "--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "session_end", "--detail", self.detail, "--category", "2", "--cwd", t.d])[0], 0)
        self.assertEqual(orchestrate.registered(st), set())      # registered for session_end, this state is prefix
        self.assertEqual(cli("audit.py", ["register", "--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--detail", self.detail, "--category", "2", "--cwd", t.d])[0], 0)
        self.assertEqual(len(orchestrate.registered(st)), 1)

class Documentation(unittest.TestCase):
    """The commands the documentation shows are parsed by the real argument parser; the root file points to the section and the section keeps the rules."""
    def test_the_documented_commands_parse_and_the_section_keeps_the_rules(self):
        import skilldocs
        prep = skilldocs.doc("reference/prepare.md"); root = skilldocs.doc("SKILL.md"); sec = prep[prep.index("## Orchestrated run"):]
        self.assertIn('"Orchestrated run"', root); self.assertIn('"Orchestrated run"', root[root.index("(R1)"):root.index("(R2)")])      # the root names the section and indexes it under the file that holds it
        shapes = re.findall(r"`((?:python3 -B <skill-dir>/scripts/orchestrate\.py )?(?:prepare|package|finalize|edit-preflight) [^`]*)`", sec); self.assertGreaterEqual(len(shapes), 4)
        for sh in shapes:
            argv = sh.replace("python3 -B <skill-dir>/scripts/orchestrate.py ", "")
            argv = re.sub(r"<[^>]+>", "X", argv).split(); a = orchestrate.build_parser().parse_args(argv); self.assertIn(a.cmd, ("prepare", "package", "finalize", "edit-preflight"), sh)
        for must in ("strictly above 500,000 of 1,000,000", "never estimate", "turns x context", "are not reduced", "first assigns it a literal absolute path", "no later version of the note can be verified", "EVERY chunk", "AND `verified_version`", "never `apply_patch`", "new Jev calls after the Edit", "never carried over", "no new allowance", "makes no model request, Jev call or network call", "grants no approval"):
            self.assertIn(must, sec, must)
        self.assertLessEqual(len(root.encode("utf-8")), 22000)

class BackupOnly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.p = os.path.join(os.path.realpath(self.tmp.name), "N.md"); open(self.p, "wb").write(b"verified\n"); self.h = sha("verified\n")

    def test_without_approval_or_with_another_hash_nothing_is_created(self):
        for approved, h, exc in ((None, self.h, PermissionError), (False, self.h, PermissionError), ("yes", self.h, PermissionError), (True, sha("other"), RuntimeError)):
            with self.assertRaises(exc): report.backup_only(self.p, h, approved)
            self.assertEqual(os.listdir(os.path.dirname(self.p)), ["N.md"])

    def test_the_backup_holds_the_verified_bytes_never_overwrites_and_leaves_the_note_alone(self):
        import datetime; now = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc); st0 = os.stat(self.p)
        b1 = report.backup_only(self.p, self.h, True, now); b2 = report.backup_only(self.p, self.h, True, now)
        self.assertEqual((os.path.basename(b1), os.path.basename(b2)), ("N.md.bak-20260102T030405Z", "N.md.bak-20260102T030405Z-1")); self.assertEqual((open(b1, "rb").read(), open(b2, "rb").read(), open(self.p, "rb").read()), (b"verified\n",) * 3)
        st1 = os.stat(self.p); self.assertEqual((st0.st_ino, st0.st_mtime_ns), (st1.st_ino, st1.st_mtime_ns))

    def test_a_change_between_the_hash_check_and_the_end_of_the_backup_is_refused_and_the_backup_stays(self):
        orig = report._exclusive_backup
        def racing(path, data, src):
            b = orig(path, data, src); open(self.p, "ab").write(b"changed by someone else\n"); return b
        report._exclusive_backup = racing
        try:
            with self.assertRaises(RuntimeError) as c: report.backup_only(self.p, self.h, True)
        finally: report._exclusive_backup = orig
        self.assertIn("changed during the backup", str(c.exception)); baks = [x for x in os.listdir(os.path.dirname(self.p)) if ".bak-" in x]; self.assertEqual(len(baks), 1)

if __name__ == "__main__": unittest.main()

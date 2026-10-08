#!/usr/bin/env python3
"""Offline test of the demonstrated verification run (council fixes 1 and 2; stdlib only, no Jev call, never reads .handoff-verify/):
 - `omissions.source_window` no longer picks the last run: the evaluated run is the one the check names (`version_ref.run` = the tool_use id that starts it); exactly one run after the write is a demonstrated
   selection; several runs without a selector, or a selector that is not a run after that write, give no source (ambiguous -> UNRESOLVED, `omissions.py prepare` exits 3 and lists the run ids);
   a check that names its run is not reinterpreted when a newer run appears on the same write, and one that names none becomes ambiguous (never silently moved to the new run);
 - the selector travels through `omissions.py prepare` / `prepare-batch` (`--run`, spec key `run`), `versions.py list`, `scope.py prepare`, `omissions.context`, `versions.bind_versions` and the pair validator;
 - the scope of an exclusion is re-derived in the evaluation the exclusion names (`evaluation` = {write_tool_use_id, evaluated_against[, run]}), also when the report holds several evaluations: a classification
   made on the context of the first write is still valid after a second write and run appear, and one made on the later context is not valid for an exclusion declared on the first.
All fixtures are invented.
usage: python3 -B test_run_selection.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover, jevref, omissions, report, scope, versions
from test_scope_filter import classify_result, payload

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SKILL = "/home/u/.claude/plugins/cache/jev/skills/handoff-verify"
SCRIPTS = SKILL + "/scripts"

class Tx:
    def __init__(self, cwd):
        self.cwd, self.n, self.recs = cwd, 0, []
    def rec(self, typ, content, **extra):
        self.n += 1
        self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.cwd, sessionId="s1", message=dict(role=typ, content=content), **extra))
    def user(self, text, **extra): self.rec("user", text, **extra)
    def say(self, text): self.rec("assistant", [dict(type="text", text=text)])
    def tool(self, tid, name, inp, result="ok"):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)]); self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result)])
    def run(self, tid): self.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded")
    def save(self, path):
        with open(path, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return path

def two_runs(note="/nope/HANDOFF.md"):
    t = Tx("/work"); t.user("first request"); t.tool("w1", "Write", dict(file_path=note, content="NOTE"), "created")
    t.run("run1"); t.say("RUN1-SUMMARY"); t.user("second request"); t.say("WORK-BETWEEN"); t.run("run2"); t.say("RUN2-SUMMARY"); t.user("late request")
    return t

class Selection(unittest.TestCase):
    def test_several_runs_without_a_selector_are_ambiguous_and_never_the_last(self):
        t = two_runs(); w = omissions.source_window(t.recs, "w1", "session_end")
        self.assertIn("run", w["ambiguous"]); self.assertIn("run1", w["ambiguous"]); self.assertIn("run2", w["ambiguous"]); self.assertEqual([r["id"] for r in w["runs"]], ["run1", "run2"])
        self.assertIsNone(w["run"])

    def test_each_run_can_be_selected_and_bounds_the_source(self):
        t = two_runs()
        w1 = omissions.source_window(t.recs, "w1", "session_end", "run1"); w2 = omissions.source_window(t.recs, "w1", "session_end", "run2")
        self.assertIsNone(w1["ambiguous"]); self.assertIsNone(w2["ambiguous"]); self.assertEqual((w1["run"], w2["run"]), ("run1", "run2")); self.assertLess(w1["limit"], w2["limit"])
        b1 = omissions.eligible_blocks(t.recs, "/nope/HANDOFF.md", w1["limit"], w1["excluded"]); b2 = omissions.eligible_blocks(t.recs, "/nope/HANDOFF.md", w2["limit"], w2["excluded"])
        self.assertIn("first request", b1); self.assertNotIn("second request", b1); self.assertNotIn("WORK-BETWEEN", b1)
        self.assertIn("second request", b2); self.assertIn("WORK-BETWEEN", b2); self.assertFalse([b for b in b2 if "RUN1" in b or "RUN2" in b]); self.assertNotIn("late request", b2)

    def test_one_run_is_a_demonstrated_selection_and_zero_runs_need_none(self):
        t = Tx("/work"); t.user("req"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created")
        self.assertIsNone(omissions.source_window(t.recs, "w1", "session_end")["ambiguous"]); self.assertIsNone(omissions.source_window(t.recs, "w1", "session_end")["limit"])
        t.run("run1"); w = omissions.source_window(t.recs, "w1", "session_end"); self.assertIsNone(w["ambiguous"]); self.assertEqual(w["run"], "run1"); self.assertIsNotNone(w["limit"])
        self.assertIsNone(omissions.source_window(t.recs, "w1", "session_end", "run1")["ambiguous"])

    def test_a_selector_that_is_not_a_run_after_this_write_is_ambiguous(self):
        t = two_runs()
        for bad in ("nope", "w1", "sk0"): self.assertIn("not a verification run", omissions.source_window(t.recs, "w1", "session_end", bad)["ambiguous"] or "", bad)
        t0 = Tx("/work"); t0.user("req"); t0.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created")
        self.assertIn("not a verification run", omissions.source_window(t0.recs, "w1", "session_end", "run1")["ambiguous"] or "")
        self.assertIn("prefix", omissions.source_window(t.recs, "w1", "prefix", "run1")["ambiguous"] or "")      # a run only exists for session_end

    def test_an_unknown_write_gives_no_window(self):
        t = two_runs()
        for ea in ("prefix", "session_end"): self.assertIn("write", omissions.source_window(t.recs, "nope", ea)["ambiguous"] or "", ea)

    def test_a_new_run_does_not_reinterpret_a_check_that_names_its_run(self):
        t = Tx("/work"); t.user("first request"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created"); t.run("run1"); t.say("S1"); t.user("second request")
        before = omissions.source_window(t.recs, "w1", "session_end", "run1"); before_unnamed = omissions.source_window(t.recs, "w1", "session_end")
        self.assertIsNone(before_unnamed["ambiguous"]); self.assertEqual(before_unnamed["limit"], before["limit"])
        t.run("run2"); t.say("S2")
        after = omissions.source_window(t.recs, "w1", "session_end", "run1")
        self.assertEqual((after["limit"], after["ambiguous"]), (before["limit"], None)); self.assertEqual(sorted(after["excluded"] & before["excluded"]), sorted(before["excluded"]))
        self.assertIn("run", omissions.source_window(t.recs, "w1", "session_end")["ambiguous"] or "")            # the unnamed check is ambiguous now, not moved to run2

    def test_an_unresolvable_event_outside_every_run_keeps_an_unnamed_selection_undemonstrated(self):
        t = Tx(None); t.user("req"); t.tool("w1", "Write", dict(file_path="/nope/HANDOFF.md", content="N"), "created"); t.run("run1"); t.user("later"); t.tool("b", "Bash", dict(command="python3 omissions.py prepare"))
        for r in t.recs: r.pop("cwd")
        self.assertIn("ambiguous", omissions.source_window(t.recs, "w1", "session_end")["ambiguous"] or "")
        self.assertIsNone(omissions.source_window(t.recs, "w1", "session_end", "run1")["ambiguous"])      # the named run ends before the unresolvable event

class Cli(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.text = "# Handoff\n- alpha\n"; open(self.note, "w").write(self.text); self.log = os.path.join(self.d, "session.jsonl")
        t = Tx(self.d); t.user("first request: keep it simple"); t.tool("w1", "Write", dict(file_path=self.note, content=self.text), "File created successfully")
        t.run("run1"); t.say("RUN1"); t.user("second request: also keep it fast"); t.run("run2"); t.say("RUN2"); t.user("late request")
        t.save(self.log); self.recs = discover.load_jsonl(self.log); scope._MEMO.clear(); omissions._MEMO.clear()

    def prepare(self, quote, *extra):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "session_end", "--detail", "d", "--source-quote", quote, *extra],
                           capture_output=True, text=True, env=ENV)
        return p.returncode, json.loads(p.stdout)

    def test_prepare_requires_the_run_when_several_exist_and_prints_it_in_the_version_ref(self):
        code, out = self.prepare("first request: keep it simple"); self.assertEqual(code, 3); self.assertIn("run1", " ".join(out["reasons"])); self.assertIn("--run", " ".join(out["reasons"]))
        self.assertEqual(out["runs"], ["run1", "run2"])
        code, out = self.prepare("first request: keep it simple", "--run", "run1"); self.assertEqual(code, 0, out); self.assertEqual(out["version_ref"]["run"], "run1")
        code, out = self.prepare("second request: also keep it fast", "--run", "run1"); self.assertEqual(code, 3)                      # that request comes after the start of run1
        code, out = self.prepare("second request: also keep it fast", "--run", "run2"); self.assertEqual(code, 0, out); self.assertEqual(out["version_ref"]["run"], "run2")
        code, out = self.prepare("first request: keep it simple", "--run", "zzz"); self.assertEqual(code, 3); self.assertIn("not a verification run", " ".join(out["reasons"]))

    def test_the_spec_key_run_reaches_prepare_batch(self):
        spec = os.path.join(self.d, "spec.json")
        json.dump([dict(detail="d1", source_quote="first request: keep it simple", run="run1"), dict(detail="d2", source_quote="second request: also keep it fast", run="run2"), dict(detail="d3", source_quote="first request: keep it simple")], open(spec, "w"))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare-batch", "--spec", spec, "--source", self.log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "session_end"], capture_output=True, text=True, env=ENV)
        out = json.loads(p.stdout); self.assertEqual(p.returncode, 3)
        self.assertEqual([o["ok"] for o in out], [True, True, False]); self.assertEqual([o.get("version_ref", {}).get("run") for o in out], ["run1", "run2", None])

    def test_versions_list_shows_the_run_choices_and_accepts_one(self):
        def lst(*extra):
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "list", "--source", self.log, "--file", self.note, "--evaluated-against", "session_end", *extra], capture_output=True, text=True, env=ENV)
            return p.returncode, json.loads(p.stdout)
        code, o = lst(); self.assertEqual(code, 0); row = o["versions"][0]
        self.assertEqual(row["runs"], ["run1", "run2"]); self.assertNotIn("run", row["version_ref"]); self.assertIn("--run", o["note"])
        code, o = lst("--run", "run2"); self.assertEqual(o["versions"][0]["version_ref"]["run"], "run2")
        code, o = lst("--run", "zzz"); self.assertEqual(code, 3)

    def test_context_bind_versions_and_the_pair_validator_carry_the_run(self):
        v = versions.versions_of(self.log, self.note)[0][0]
        self.assertIsNone(omissions.context(self.log, self.note, v, "session_end")["eligible_source"])
        c1 = omissions.context(self.log, self.note, v, "session_end", (), "run1"); c2 = omissions.context(self.log, self.note, v, "session_end", (), "run2")
        self.assertIn("first request: keep it simple", c1["eligible_source"]); self.assertNotIn("second request", c1["eligible_source"]); self.assertIn("second request: also keep it fast", c2["eligible_source"])
        refs = [dict(versions.version_ref(v, "session_end"), run="run1"), dict(versions.version_ref(v, "session_end"), run="run2"), versions.version_ref(v, "session_end")]
        rows = versions.bind_versions([dict(version_ref=r) for r in refs], [dict(bound=True, id="k%d" % i, tool_use_id="x") for i in range(3)], self.note, self.log, [], False)
        self.assertEqual([rows["k%d" % i]["omission"]["eligible_source"] is not None for i in range(2)], [True, True]); self.assertEqual([rows["k%d" % i]["run"] for i in range(2)], ["run1", "run2"])
        self.assertEqual((rows["k2"]["kind"], rows["k2"]["ok"]), ("run", False)); self.assertIn("run", rows["k2"]["reason"]); self.assertNotIn("omission", rows["k2"])      # no selector with several runs: the evaluation itself is invalid
        bs = versions.attach([dict(id="k0", bound=True, resolved=True, tool_use_id="x"), dict(id="k1", bound=True, resolved=True, tool_use_id="x")], {k: rows[k] for k in ("k0", "k1")})
        self.assertEqual([b["version"]["run"] for b in bs], ["run1", "run2"])

class ScopeWindows(unittest.TestCase):
    """Two writes, a run after each; the exclusion names its evaluation."""
    DET = ["The user's calendar has a dentist appointment on Friday."]
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup); scope._MEMO.clear(); omissions._MEMO.clear()
        self.note = os.path.join(self.d, "HANDOFF.md"); open(self.note, "w").write("N2")

    def session(self, with_w2=True):
        t = Tx(self.d); t.user("make the gate optional"); t.tool("w1", "Write", dict(file_path=self.note, content="N1"), "created"); t.run("r1"); t.say("S1")
        return t

    def classified(self, t, ctx, tid="k1"):
        t.tool(tid, "mcp__jev__jev_classify", payload(ctx, self.DET), classify_result([("d1", "out_of_scope", 1, "auto")]))

    def doc(self, log, ex, writes=None):
        d = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), status="PASS", findings=[], unresolved=[], checks=[], scope_exclusions=ex)
        return report.bind_report(d, log, self.d, (), False, None, None, "R04")

    def excl(self, wid, ea="prefix", run=None, tid="k1"):
        ev = dict(write_tool_use_id=wid, evaluated_against=ea); ev.update(dict(run=run) if run else {})
        return dict(detail=self.DET[0], jev_ref=dict(tool_use_id=tid, result_index=0, key="d1"), classification="out_of_scope", confidence=1, evaluation=ev)

    def test_a_classification_on_the_first_window_stays_valid_after_a_second_write_and_run(self):
        t = self.session(); ctx1 = scope.canonical_context(["make the gate optional"])
        t.user("now also keep the cache warm"); self.classified(t, ctx1); t.tool("w2", "Write", dict(file_path=self.note, content="N2"), "created"); t.run("r2"); t.say("S2")
        log = t.save(os.path.join(self.d, "s.jsonl"))
        calls = jevref.load_calls(log)
        w1 = scope.scope_of(log, "w1", "prefix"); w2 = scope.scope_of(log, "w2", "prefix")
        self.assertNotEqual(w1[0], w2[0]); self.assertEqual(w1[0], ctx1)
        self.assertEqual(scope.validate_exclusions([self.excl("w1")], calls, log)["valid"], 1)                      # the exclusion is judged in ITS evaluation, not in the latest one
        r = scope.validate_exclusions([self.excl("w2")], calls, log); self.assertEqual(r["invalid"], 1); self.assertIn("canonical scope", r["reasons"][0]["reason"])
        mixed = scope.validate_exclusions([self.excl("w1"), dict(self.excl("w2"), jev_ref=dict(tool_use_id="k1", result_index=0, key="d1"))], calls, log)
        self.assertEqual((mixed["valid"], mixed["invalid"]), (1, 1))                                                  # one report, two evaluations, each re-derived on its own

    def test_a_classification_on_the_later_context_is_not_valid_for_an_exclusion_declared_on_the_first(self):
        t = self.session(); t.user("now also keep the cache warm"); t.tool("w2", "Write", dict(file_path=self.note, content="N2"), "created")
        ctx2 = scope.canonical_context(["make the gate optional", "now also keep the cache warm"]); self.classified(t, ctx2); t.run("r2")
        log = t.save(os.path.join(self.d, "s.jsonl")); calls = jevref.load_calls(log)
        self.assertEqual(scope.validate_exclusions([self.excl("w2")], calls, log)["valid"], 1)
        r = scope.validate_exclusions([self.excl("w1")], calls, log); self.assertEqual(r["invalid"], 1)
        d = self.doc(log, [self.excl("w1")]); self.assertEqual(d["status"], "UNRESOLVED"); self.assertEqual(d["scope_audit"]["invalid"], 1)
        d = self.doc(log, [self.excl("w2")]); self.assertNotEqual(d["scope_audit"]["invalid"], 1)

    def test_report_rebinding_keeps_each_exclusion_in_its_own_window(self):
        t = self.session(); ctx1 = scope.canonical_context(["make the gate optional"]); self.classified(t, ctx1)
        log1 = t.save(os.path.join(self.d, "s1.jsonl")); scope._MEMO.clear()
        self.assertEqual(self.doc(log1, [self.excl("w1")])["scope_audit"]["invalid"], 0)
        t.user("now also keep the cache warm"); t.tool("w2", "Write", dict(file_path=self.note, content="N2"), "created"); t.run("r2")
        log2 = t.save(os.path.join(self.d, "s2.jsonl")); scope._MEMO.clear()
        self.assertEqual(self.doc(log2, [self.excl("w1")])["scope_audit"]["invalid"], 0)                              # a later write and run do not reinterpret it

    def test_the_run_selector_and_the_named_write_are_validated(self):
        t = self.session(); ctx1 = scope.canonical_context(["make the gate optional"]); self.classified(t, ctx1); t.user("more"); t.run("r2")
        log = t.save(os.path.join(self.d, "s.jsonl")); calls = jevref.load_calls(log)
        self.assertEqual(scope.validate_exclusions([self.excl("w1", "session_end")], calls, log)["invalid"], 1)       # two runs after w1 and no selector
        for bad in (self.excl("nope"), dict(self.excl("w1"), evaluation="w1"), dict(self.excl("w1"), evaluation=dict(write_tool_use_id="w1", evaluated_against="never"))):
            self.assertEqual(scope.validate_exclusions([bad], calls, log)["invalid"], 1)
        self.assertEqual(scope.validate_exclusions([self.excl("w1", "prefix")], calls, log, writes={"w9"})["invalid"], 1)      # not a version of the handoff
        self.assertEqual(scope.validate_exclusions([self.excl("w1", "prefix")], calls, log, writes={"w1"})["valid"], 1)

    def test_scope_prepare_selects_the_window_and_prints_the_evaluation_to_copy(self):
        t = self.session(); t.user("now also keep the cache warm"); t.tool("w2", "Write", dict(file_path=self.note, content="N2"), "created"); t.run("r2"); log = t.save(os.path.join(self.d, "s.jsonl"))
        def cli(*extra):
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare", "--source", log, "--detail", "x", *extra], capture_output=True, text=True, env=ENV); return p.returncode, json.loads(p.stdout)
        code, o = cli("--write-id", "w1", "--evaluated-against", "prefix"); self.assertEqual(code, 0, o); self.assertEqual(o["evaluation"], dict(write_tool_use_id="w1", evaluated_against="prefix")); self.assertEqual(o["requests"], 1)
        code, o2 = cli("--write-id", "w2", "--evaluated-against", "prefix"); self.assertEqual(o2["requests"], 2); self.assertNotEqual(o["payloads"][0]["context"], o2["payloads"][0]["context"])
        code, o3 = cli("--write-id", "w1", "--evaluated-against", "session_end"); self.assertEqual(code, 0, o3); self.assertEqual(o3["evaluation"]["run"], "r1")          # exactly one run after w1
        code, o4 = cli(); self.assertEqual(code, 3); self.assertIn("run", " ".join(o4["reasons"]))                                                              # two runs overall, no write given
        code, o5 = cli("--write-id", "w1"); self.assertEqual(code, 3)                                                                                          # a write needs its mode

class Identity(unittest.TestCase):
    """The run is part of the identity of an evaluation: validate_ref, the pair validator and the SOURCE planner."""
    PASSAGE = "Never run migrate.sh against prod."
    def pair(self, run_s, run_a):
        sc, ac = omissions.claims(self.PASSAGE, "R04")
        mk = lambda cid, claim, verdict, ev, run: dict(id=cid, bound=True, resolved=verdict == "verified", real_verdict=verdict, real_confidence=0.99, real_action="auto", tool="verify", check_error=False, claim_key=claim,
                                                       version=dict(ok=True, write_tool_use_id="w0", sha256="a" * 64, evaluated_against="session_end", run=run), eligible_blocks=[self.PASSAGE], call_evidence_raw=ev, omission_material="MAT", omission_material_reason=None)
        by = dict(s=mk("s", sc, "verified", [self.PASSAGE], run_s), a=mk("a", ac, "unsupported", ["MAT"], run_a))
        return dict(type="lost_detail", check_id="a", confidence=0.99, claim=ac, omission_ref=dict(detail=self.PASSAGE, source_check_id="s"), quote_source=self.PASSAGE, quote_handoff=None), by

    def test_the_two_checks_of_a_pair_must_name_the_same_run(self):
        f, by = self.pair("run1", "run1"); self.assertTrue(jevref._validate_omission(f, by["a"], by, "R04")[0])
        for rs, ra in (("run1", "run2"), ("run1", None), (None, "run1")):
            f, by = self.pair(rs, ra); ok, why = jevref._validate_omission(f, by["a"], by, "R04"); self.assertFalse(ok, (rs, ra)); self.assertIn("run", why)

    def test_validate_ref_checks_the_run_field(self):
        vs = [dict(write_tool_use_id="w1", status="ok", sha256="a" * 64, content="x", version=1, pos=1, result_pos=2, next_pos=None)]
        base = dict(write_tool_use_id="w1", sha256="a" * 64, evaluated_against="session_end")
        self.assertEqual(versions.validate_ref(dict(base, run="r1"), vs)[0], "ok"); self.assertEqual(versions.validate_ref(base, vs)[0], "ok")
        for bad in (dict(base, run=5), dict(base, run=""), dict(base, run=["r"]), dict(base, evaluated_against="prefix", run="r1")): self.assertEqual(versions.validate_ref(bad, vs)[0], "inconsistent", bad)

    def test_source_candidates_of_different_runs_never_share_a_call(self):
        def item(run): return dict(absence=dict(bound=True, verdict="unsupported", confidence=0.99, action="auto", version_ok=True, material_complete=True, aux_ok=True), source_claim="C " + str(run), source_passage="P", source="s.jsonl", file="N.md",
                                   version_ref=dict(write_tool_use_id="w1", sha256="a" * 64, evaluated_against="session_end", **({"run": run} if run else {})))
        self.assertEqual(omissions.plan_source([item("r1"), item("r1")])["planned_source_calls"], 1)
        p = omissions.plan_source([item("r1"), item("r2"), item(None)]); self.assertEqual(p["planned_source_calls"], 3); self.assertEqual([g["run"] for g in p["groups"]], ["r1", "r2", None])

if __name__ == "__main__": unittest.main()

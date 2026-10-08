#!/usr/bin/env python3
"""Offline test of the check constructor and of the documented command flags (stdlib only, no Jev call, never reads .handoff-verify/): `checks.py` builds report checks from deliberately selected REAL
(tool_use_id, result_index) pairs, copying tool, verdict, confidence and the exact `jev_ref.key` (long compare keys included) from the recorded result, deriving the input hash from the complete expected
input, refusing any mismatch, a version identity that versions.py does not demonstrate and any reuse of a (call, result) pair, all or nothing; `report.write_report` still rebinds every check. The command
examples in SKILL.md ("Command flags") must parse under the real argument parsers (parse only: nothing is prepared or written).
usage: python3 -B test_checks.py [-v]"""
import hashlib, json, os, re, shlex, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import checks, jevref, omissions, report, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SKILL_MD = os.path.join(os.path.dirname(HERE), "SKILL.md")
V1 = "# Handoff\n- alpha\n- beta\n"
CLAIM, CLAIM2 = "The note says the billing migration ships on Friday.", "The public API must not change."
LONG_A, LONG_B = "A " * 1500 + "tail-a", "B " * 1500 + "tail-b"

def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

class Session:
    """Write v1 (w1), then Jev calls: c1 verify (2 claims), k1 compare (long passages), g1 nested gate, f1 flat gate, lo verify at 0.9; then Edit (w2) and a call c2 after it."""
    def __init__(self, d):
        self.d, self.n, self.recs = d, 0, []
        self.handoff = os.path.join(os.path.realpath(d), "HANDOFF.md"); self.log = os.path.join(d, "session.jsonl")
        self.inputs = {}
    def _rec(self, typ, msg):
        self.n += 1; self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.d, sessionId="s1", message=msg))
    def tool(self, tid, name, inp, result):
        self._rec("assistant", dict(role="assistant", content=[dict(type="tool_use", id=tid, name=name, input=inp)]))
        self._rec("user", dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=result)]))
    def jev(self, tid, tool, inp, top):
        self.inputs[tid] = inp; self.tool(tid, "mcp__jev__jev_" + tool, inp, json.dumps(top))
    def build(self):
        self.tool("w1", "Write", dict(file_path=self.handoff, content=V1), "File created successfully")
        r = lambda c, v="verified", p=0.99: dict(claim=c, verdict=v, confidence=p, action="auto", same_subject=0.9)
        self.jev("c1", "verify", dict(claims=[CLAIM, CLAIM2], evidence=[dict(text="Friday is the date.")]), dict(subject_at=0.5, results=[r(CLAIM), r(CLAIM2)]))
        self.jev("k1", "compare", dict(passage_a=LONG_A, passage_b=LONG_B, aspects=["date"]), dict(overall=dict(relation="same_fact", confidence=0.99), aspects=[dict(aspect="date", relation="same_fact", confidence=0.99)]))
        self.jev("g1", "gate", dict(claims=[CLAIM], evidence="E", diff="D", request="R"), dict(tool="jev_gate", truncated=False, action="auto", review=dict(action="auto"), subject_at=0.5,
                 verification=dict(action="auto", results=[r(CLAIM)])))
        self.jev("f1", "gate", dict(claims=[CLAIM], evidence="E", diff="D", request="R"), dict(subject_at=0.5, results=[r(CLAIM)]))
        self.jev("lo", "verify", dict(claims=[CLAIM], evidence="low"), dict(subject_at=0.5, results=[r(CLAIM, "verified", 0.9)]))
        self.tool("w2", "Edit", dict(file_path=self.handoff, old_string="beta", new_string="gamma"), "The file has been updated successfully")
        self.jev("c2", "verify", dict(claims=[CLAIM], evidence="after"), dict(subject_at=0.5, results=[r(CLAIM)]))
        with open(self.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(x) + "\n" for x in self.recs))
        open(self.handoff, "w", encoding="utf-8").write(V1.replace("beta", "gamma"))
        return self
    def ref(self, version=1, ev="session_end"):
        v = next(x for x in versions.versions_of(self.log, self.handoff)[0] if x["version"] == version)
        return versions.version_ref(v, ev)
    def spec(self, cid, tid, idx, tool="jev_verify", ref=None, **kw):
        return dict(dict(id=cid, tool=tool, tool_use_id=tid, result_index=idx, input=self.inputs.get(tid, {"claims": ["x"]}), version_ref=ref or self.ref()), **kw)
    def kw(self, **extra):
        return dict(dict(calls=jevref.load_calls(self.log), source=self.log, file=self.handoff, calls_path=self.log), **extra)

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup); self.s = Session(os.path.realpath(self.t.name)).build()
    def refused(self, specs, *needles, **extra):
        with self.assertRaises(checks.CheckError) as cm: checks.build_checks(specs, **self.s.kw(**extra))
        text = str(cm.exception)
        for n in needles: self.assertIn(n, text)
        return cm.exception
    def rebind(self, built):
        doc = dict(session=dict(session_id="s1", jsonl=self.s.log, cwd=self.t.name), handoff=dict(path=self.s.handoff, versions=[]), checks=built, findings=[], unresolved=[], status="PASS")
        return report.bind_report(doc, self.s.log, self.t.name, (), True, self.s.handoff, None, "R04")

class Build(Base):
    def test_generated_verify_compare_flat_and_nested_gate_checks_bind(self):
        s = self.s; ref = s.ref()
        specs = [s.spec("a", "c1", 0), s.spec("b", "c1", 1), s.spec("c", "k1", 0, "compare"), s.spec("d", "g1", 0, "gate"), s.spec("e", "f1", 0, "jev_gate")]
        built = checks.build_checks(specs, **s.kw())
        self.assertEqual([c["id"] for c in built], list("abcde")); self.assertEqual([c["tool"] for c in built], ["jev_verify", "jev_verify", "jev_compare", "jev_gate", "jev_gate"])
        self.assertTrue(all(c["version_ref"] == ref and c["verdict"] and c["confidence"] is not None for c in built))
        doc = self.rebind(built)
        self.assertEqual([c["binding"]["bound"] for c in doc["checks"]], [True] * 5); self.assertEqual([c["binding"]["resolved"] for c in doc["checks"]], [True] * 5)   # final rebinding: strict, versioned
        self.assertEqual(doc["status"], "PASS")

    def test_long_compare_keys_are_copied_exactly_not_retyped(self):
        c = checks.build_checks([self.s.spec("c", "k1", 0, "compare")], **self.s.kw())[0]
        self.assertEqual(c["jev_ref"], dict(tool_use_id="k1", result_index=0, key=jevref.compare_key(self.s.inputs["k1"])))
        self.assertGreater(len(c["jev_ref"]["key"]), 6000); self.assertIn("tail-b", c["jev_ref"]["key"])
        d = checks.build_checks([self.s.spec("c", "k1", 1, "compare")], **self.s.kw())[0]
        self.assertEqual(d["jev_ref"]["key"], jevref.compare_key(self.s.inputs["k1"], 0))

    def test_verdict_and_confidence_are_the_real_ones(self):
        c = checks.build_checks([self.s.spec("c", "c1", 0)], **self.s.kw())[0]
        self.assertEqual((c["verdict"], c["confidence"], c["jev_ref"]["key"]), ("verified", 0.99, CLAIM))

    def test_a_legitimate_low_confidence_check_is_built_and_stays_unresolved(self):
        built = checks.build_checks([self.s.spec("l", "lo", 0)], **self.s.kw()); self.assertEqual(built[0]["confidence"], 0.9)
        doc = self.rebind(built); self.assertEqual((doc["checks"][0]["binding"]["bound"], doc["checks"][0]["binding"]["resolved"], doc["status"]), (True, False, "UNRESOLVED"))

    def test_the_input_hash_is_derived_and_a_supplied_one_must_agree(self):
        s = self.s; h = jevref.input_hash(s.inputs["c1"])
        checks.build_checks([s.spec("a", "c1", 0, input_hash=h)], **s.kw())
        self.refused([s.spec("a", "c1", 0, input_hash=jevref.input_hash({"claims": ["other"]}))], "input_hash differs")
        self.refused([s.spec("a", "c1", 0, input_hash="0" * 64)], "input_hash differs")

    def test_the_wrong_complete_input_is_refused(self):
        s = self.s
        self.refused([dict(s.spec("a", "c1", 0), input=dict(s.inputs["c1"], evidence=[dict(text="Friday is the date. ")]))], "expected input differs")
        self.refused([dict(s.spec("a", "c1", 0), input=dict(claims=[CLAIM, CLAIM2]))], "expected input differs")      # an incomplete input (evidence missing) is not the recorded call
        self.refused([dict(s.spec("a", "c1", 0), input="not an object")], "input")

    def test_tool_call_and_result_identity(self):
        s = self.s
        self.refused([s.spec("a", "c1", 0, "jev_gate")], "tool"); self.refused([s.spec("a", "nope", 0)], "not found")
        self.refused([s.spec("a", "c1", 5)], "result_index 5 does not exist"); self.refused([dict(s.spec("a", "c1", 0), result_index=True)], "result_index")
        calls = jevref.load_calls(s.log); twin = [dict(calls[0])] + calls
        with self.assertRaises(checks.CheckError) as cm: checks.build_checks([s.spec("a", "c1", 0)], **dict(s.kw(), calls=twin))
        self.assertIn("ambiguous call identity", str(cm.exception))
        err = dict(calls[0], is_error=True)
        with self.assertRaises(checks.CheckError): checks.build_checks([s.spec("a", "c1", 0)], **dict(s.kw(), calls=[err] + calls[1:]))

    def test_unknown_spec_keys_are_refused_and_nothing_is_typed_by_the_model(self):
        self.refused([dict(self.s.spec("a", "c1", 0), key=CLAIM)], "unknown key"); self.refused([dict(self.s.spec("a", "c1", 0), confidence=0.99)], "unknown key")
        self.refused([], "non-empty list")

    def test_duplicate_ids_and_duplicate_result_reuse_are_refused(self):
        s = self.s
        self.refused([s.spec("a", "c1", 0), s.spec("a", "c1", 1)], "duplicate check id")
        self.refused([s.spec("a", "c1", 0), s.spec("b", "c1", 0)], "already used")
        existing = [dict(id="old", tool="jev_verify", jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM))]
        self.refused([s.spec("a", "c1", 0)], "already used by the existing check old", existing=existing)
        self.refused([s.spec("old", "c1", 1)], "duplicate check id", existing=existing)
        checks.build_checks([s.spec("a", "c1", 1)], **s.kw(existing=existing))      # a different result of the same call is fine

    def test_an_invalid_version_identity_is_refused(self):
        s = self.s; ref = s.ref()
        self.refused([s.spec("a", "c1", 0, ref=dict(ref, write_tool_use_id="w9"))], "version_ref")
        self.refused([s.spec("a", "c1", 0, ref=dict(ref, sha256="0" * 64))], "sha256")
        self.refused([s.spec("a", "c1", 0, ref=dict(ref, evaluated_against="later"))], "malformed version_ref")
        self.refused([dict(s.spec("a", "c1", 0), version_ref=None)], "version_ref")
        self.refused([s.spec("a", "c1", 0, ref=dict(ref, sha256=sha("# Handoff\n- other\n")))], "sha256")

    def test_the_window_of_the_version_is_enforced_for_the_same_session(self):
        s = self.s
        self.refused([s.spec("a", "c2", 0, ref=s.ref(1))], "window")                      # the call is after the next edit: not a call about version 1
        self.refused([s.spec("a", "c1", 0, ref=s.ref(2))], "window")                      # the call is before version 2
        checks.build_checks([s.spec("a", "c2", 0, ref=s.ref(2))], **s.kw())

    def test_the_calls_session_context_must_be_demonstrated_not_defaulted_to_retrospective(self):
        s = self.s; spec = s.spec("a", "c2", 0, ref=s.ref(1))                              # a call after the next write: refused with the matching calls_path
        self.refused([spec], "window")
        unrelated = os.path.join(self.t.name, "unrelated.jsonl"); open(unrelated, "w", encoding="utf-8").write(json.dumps(dict(type="user", uuid="x", message=dict(role="user", content="hi"))) + "\n")
        for bad in (None, "", os.path.join(self.t.name, "missing.jsonl"), unrelated, s.handoff, 5, ["x"]):
            with self.assertRaises(checks.CheckError, msg=repr(bad)) as cm: checks.build_checks([spec], **s.kw(calls_path=bad))
            self.assertIn("calls session", str(cm.exception), repr(bad)); self.assertEqual(len(cm.exception.errors), 1)
            with self.assertRaises(checks.CheckError, msg=repr(bad)): checks.build_checks([s.spec("a", "c1", 0)], **s.kw(calls_path=bad))   # not even a valid batch is built without the context
        checks.build_checks([s.spec("a", "c2", 0, ref=s.ref(2))], **s.kw())                # the demonstrated same-session case still builds

    def test_a_retrospective_verification_needs_the_demonstrated_relocation(self):
        s = self.s; other = os.path.join(self.t.name, "copy"); os.makedirs(other); copy = os.path.join(other, "HANDOFF.md"); calls_log = os.path.join(self.t.name, "calls.jsonl")
        with open(calls_log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(dict(r, sessionId="s2")) + "\n" for r in s.recs[2:4]))   # only the c1 call, recorded by ANOTHER session
        call_kw = dict(calls=jevref.load_calls(calls_log), source=s.log, calls_path=calls_log)
        spec = s.spec("a", "c1", 0, ref=s.ref(1))
        open(copy, "w", encoding="utf-8").write(V1)
        with self.assertRaises(checks.CheckError): checks.build_checks([spec], file=copy, **call_kw)                                   # the copy is not a path written in the source session
        built = checks.build_checks([spec], file=copy, source_path=s.handoff, **call_kw); self.assertEqual(built[0]["id"], "a")      # relocated copy whose bytes are version 1
        open(copy, "w", encoding="utf-8").write(V1 + "- tampered\n")
        with self.assertRaises(checks.CheckError) as cm: checks.build_checks([spec], file=copy, source_path=s.handoff, **call_kw)
        self.assertIn("relocated copy", str(cm.exception))

    def test_all_or_nothing(self):
        s = self.s
        e = self.refused([s.spec("a", "c1", 0), s.spec("b", "c1", 1, ref=dict(s.ref(), sha256="0" * 64)), s.spec("c", "zz", 0)])
        self.assertEqual(sorted(x["id"] for x in e.errors), ["b", "c"])           # every problem of the batch is reported, nothing is returned
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "checks.py"), "build", "--session", s.log, "--source", s.log, "--file", s.handoff, "--spec", self.spec_file([s.spec("a", "c1", 0), s.spec("c", "zz", 0)])],
                             capture_output=True, text=True, env=ENV)
        o = json.loads(out.stdout); self.assertEqual(out.returncode, 3); self.assertFalse(o["ok"]); self.assertNotIn("checks", o); self.assertEqual([x["id"] for x in o["errors"]], ["c"])

    def spec_file(self, specs):
        p = os.path.join(self.t.name, "spec.json"); json.dump(specs, open(p, "w", encoding="utf-8")); return p

    def test_the_cli_builds_the_same_checks(self):
        s = self.s; specs = [s.spec("a", "c1", 0), s.spec("c", "k1", 0, "compare")]
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "checks.py"), "build", "--session", s.log, "--source", s.log, "--file", s.handoff, "--spec", self.spec_file(specs)], capture_output=True, text=True, env=ENV)
        o = json.loads(out.stdout); self.assertEqual(out.returncode, 0, out.stderr); self.assertTrue(o["ok"])
        self.assertEqual(o["checks"], checks.build_checks(specs, **s.kw()))
        self.assertEqual(self.rebind(o["checks"])["status"], "PASS")

class Cutoff(unittest.TestCase):
    SCRIPTS = "/x/skills/handoff-verify/scripts"      # recorded cwd / path of the skill's scripts: a verification helper is recognised by where it lives, not by its name alone

    def test_checks_py_is_a_verification_helper_for_the_session_end_cutoff(self):
        self.assertIn("checks.py", omissions.SKILL_SCRIPTS)
        for cmd in ("python3 -B %s/checks.py build --spec s.json" % self.SCRIPTS, "cd %s && python3 -c 'import checks; checks.build_checks([])'" % self.SCRIPTS, "cd %s && python3 -m checks build" % self.SCRIPTS):
            recs = [dict(type="user", message=dict(role="user", content="Never run migrate.sh against prod.")),
                    dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command=cmd))]))]
            self.assertEqual(omissions.verification_limit(recs), 1, cmd)
            recs[1]["message"]["content"][0]["input"]["command"] = "ls"; self.assertIsNone(omissions.verification_limit(recs))
        # the same names outside the skill's directory are ordinary commands
        for cmd in ("python3 -B checks.py build --spec s.json", "python3 -c 'import checks'", "python3 -m checks build"):
            recs = [dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command=cmd))]))]
            self.assertIsNone(omissions.verification_limit(recs), cmd)
        # the eligible source stops before the helper run
        recs = [dict(type="user", message=dict(role="user", content="before")),
                dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command="python3 %s/checks.py build --spec s.json" % self.SCRIPTS))])),
                dict(type="user", message=dict(role="user", content="after the helper"))]
        self.assertEqual(omissions.eligible_blocks(recs, "/nope", omissions.verification_limit(recs)), ["before"])

class Flags(unittest.TestCase):
    PLACEHOLDER = re.compile(r"<[^>]+>")
    def documented(self):
        t = open(SKILL_MD, encoding="utf-8").read(); i = t.index("## Command flags"); block = t[i:t.index("\n## ", i + 5)]
        fence = re.search(r"```\n(.*?)```", block, re.S); self.assertIsNotNone(fence, "no fenced example block under 'Command flags'")
        return [l.strip() for l in fence.group(1).splitlines() if l.strip().startswith("python3")]

    def test_every_documented_example_parses_under_the_real_parser(self):
        import advice, discover, prepare
        parsers = {"prepare.py": prepare, "versions.py": versions, "omissions.py": omissions, "jevref.py": jevref, "advice.py": advice, "checks.py": checks}
        lines = self.documented(); seen = set()
        self.assertGreaterEqual(len(lines), 8)
        for line in lines:
            toks = [self.PLACEHOLDER.sub("X", t) for t in shlex.split(line)]
            script = next(os.path.basename(t) for t in toks if t.endswith(".py")); i = next(k for k, t in enumerate(toks) if t.endswith(".py"))
            ns = parsers[script].build_parser().parse_args(toks[i + 1:])      # parse only: nothing runs
            seen.add((script, toks[i + 1] if script in ("versions.py", "omissions.py", "jevref.py", "checks.py") else None))
        self.assertTrue({("prepare.py", None), ("versions.py", "list"), ("versions.py", "status"), ("omissions.py", "prepare"), ("jevref.py", "list"), ("advice.py", None), ("checks.py", "build")} <= seen, seen)

    def test_the_real_flag_matrix(self):
        import advice, prepare
        self.assertEqual(prepare.build_parser().parse_args(["abc"]).session, "abc")
        with self.assertRaises(SystemExit): prepare.build_parser().parse_args(["--session", "abc"])                      # prepare takes the session positionally
        self.assertEqual(versions.build_parser().parse_args(["list", "--source", "S", "--file", "F", "--evaluated-against", "prefix"]).source, "S")
        self.assertEqual(versions.build_parser().parse_args(["status", "--session", "S", "--file", "F", "--report", "R"]).session, "S")
        self.assertEqual(omissions.build_parser().parse_args(["prepare", "--source", "S", "--file", "F", "--write-id", "w", "--evaluated-against", "prefix", "--detail", "d", "--source-quote", "q"]).source, "S")
        self.assertEqual(jevref.build_parser().parse_args(["list", "--session", "S"]).session, "S")
        self.assertEqual(advice.build_parser().parse_args(["--session", "S"]).session, "S")
        for bad in (["list", "--session", "S", "--file", "F", "--evaluated-against", "prefix"],):
            with self.assertRaises(SystemExit): versions.build_parser().parse_args(bad)                                   # versions list takes --source, not --session

    def test_the_documentation_does_not_assert_untested_macro_substitution(self):
        t = open(SKILL_MD, encoding="utf-8").read(); i = t.index("## Command flags"); block = t[i:t.index("\n## ", i + 5)]
        for forbidden in ("${CLAUDE_SESSION_ID}", "$CLAUDE_SESSION_ID", "${CLAUDE_SKILL_DIR}", "substitut"): self.assertNotIn(forbidden, block.replace("no macro substitution", ""))
        self.assertIn("CLAUDE_SESSION_ID", block); self.assertIn("checks.py", block); self.assertIn("exact", block)

if __name__ == "__main__": unittest.main()

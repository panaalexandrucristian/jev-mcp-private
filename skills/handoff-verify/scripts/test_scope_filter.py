#!/usr/bin/env python3
"""Offline test of the session scope filter (R05; stdlib only, no Jev call, never reads .handoff-verify/): the scope is the user's own requests before the verification activity; a candidate detail is
excluded only by a real jev_classify result out_of_scope with confidence strictly above 0.99 and decision auto on the canonical payload, and report.py turns a PASS into UNRESOLVED for any exclusion it cannot
re-derive. The classify result shape is the one returned by the live Jev server (id, classification, confidence, decision).
usage: python3 -B test_scope_filter.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover, jevref, report, scope

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
CLAIM = "The note says the gate switch is on by default."
REQUESTS = ["make the jev-control gate optional",
            "/jev:jev-control gate off",
            "Q: Which switch?\nA: A separate command"]

def classify_result(rows):
    return json.dumps(dict(tool="jev_classify", results=[dict(id=i, classification=c, confidence=p, decision=d, probabilities={c: p}) for i, c, p, d in rows]))

class Session:
    """A synthetic Claude Code transcript with user requests, harness notices, a verification start and Jev calls."""
    def __init__(self, d):
        self.d, self.n, self.recs = d, 0, []
        self.log = os.path.join(d, "session.jsonl")
    def rec(self, typ, content, **extra):
        self.n += 1
        self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.d, sessionId="s1", message=dict(role=typ, content=content), **extra))
    def tool(self, tid, name, inp, result):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)])
        self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result)])
    def save(self):
        with open(self.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return self.log

def build(d, calls=()):
    """Requests (with every kind of noise around them), then the verification start, a late request, the verify check call and the given classify calls."""
    s = Session(d)
    s.rec("user", "<local-command-caveat>Caveat: not a request</local-command-caveat>", isMeta=True)
    s.rec("user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>")
    s.rec("user", "make the jev-control gate optional")
    s.rec("user", "Base directory for this skill: /x", isMeta=True)
    s.rec("user", "<command-message>jev:jev-control</command-message>\n<command-name>/jev:jev-control</command-name>\n<command-args>gate off</command-args>")
    s.rec("user", "<task-notification>\n<task-id>b1</task-id></task-notification>")
    s.rec("user", [dict(type="text", text="[Request interrupted by user]")])
    s.tool("q1", "AskUserQuestion", dict(questions=[]), 'Your questions have been answered: "Which switch?"="A separate command". You can now continue with these answers in mind.')
    s.tool("q2", "AskUserQuestion", dict(questions=[]), "The user doesn't want to proceed with this tool use. Questions asked:\n- \"Which?\"\n  (No answer provided)")
    s.rec("user", "Summary of the earlier conversation", isCompactSummary=True)
    s.tool("sk", "Skill", dict(skill="jev:handoff-verify"), "loaded")
    s.rec("user", "a late request after the verification started")
    s.tool("c1", "mcp__jev__jev_verify", dict(claims=[CLAIM], evidence=[dict(text="gate on by default")]),
           json.dumps(dict(subject_at=0.5, results=[dict(claim=CLAIM, verdict="verified", confidence=0.99, same_subject=0.9, action="auto")])))
    for tid, inp, res in calls: s.tool(tid, "mcp__jev__jev_classify", inp, res)
    return s.save()

DETAILS = ["The user's calendar has a dentist appointment on Friday.", "OpenCode stores sessions in SQLite.", "The gate switch is a separate command.", "A coffee promo video needs a warmer grade."]
ROWS = [("d1", "out_of_scope", 1, "auto"), ("d2", "out_of_scope", 0.99, "auto"), ("d3", "in_scope", 0.97, "auto"), ("d4", "out_of_scope", 0.995, "review")]

def payload(ctx, details=DETAILS):
    return scope.payloads(ctx, details)[0]

def excl(i, conf=None, cls="out_of_scope", tid="k1"):
    return dict(detail=DETAILS[i], jev_ref=dict(tool_use_id=tid, result_index=i, key="d%d" % (i + 1)), classification=cls, confidence=ROWS[i][2] if conf is None else conf)

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); scope._MEMO.clear()
    def tearDown(self): self.t.cleanup()
    def session(self, extra=()):
        ctx = scope.canonical_context(REQUESTS)
        return build(self.d, [("k1", payload(ctx), classify_result(ROWS))] + list(extra)), ctx
    def validate(self, ex, log, findings=()):
        return scope.validate_exclusions(ex, jevref.load_calls(log), log, findings)

class Requests(Base):
    def test_scope_is_the_users_requests_before_the_verification_only(self):
        log, ctx = self.session()
        self.assertEqual(scope.user_requests(discover.load_jsonl(log)), REQUESTS)
        got, reqs, why = scope.scope_of(log)
        self.assertIsNone(why); self.assertEqual(got, ctx)
        self.assertNotIn("late request", got); self.assertNotIn("Caveat", got); self.assertNotIn("/clear", got); self.assertNotIn("No answer provided", got); self.assertNotIn("Summary", got)

    def test_a_skipped_record_still_counts_its_tool_results_on_the_timeline(self):
        s = Session(self.d)
        s.rec("user", "first request")
        s.rec("assistant", [dict(type="tool_use", id="r1", name="Read", input=dict(file_path="/x"))])
        s.rec("user", [dict(type="tool_result", tool_use_id="r1", content="x")], isMeta=True)
        s.tool("sk", "Skill", dict(skill="jev:handoff-verify"), "loaded")
        s.rec("user", "after the verification")
        recs = discover.load_jsonl(s.save())
        self.assertEqual(scope.user_requests(recs), ["first request"])

    def test_classify_results_bind_on_their_classification_and_decision(self):
        log, _ = self.session()
        call = next(c for c in jevref.load_calls(log) if c["tool"] == "classify")
        ents, why = jevref.results_of(call)
        self.assertIsNone(why)
        self.assertEqual([(e["key"], e["verdict"], e["confidence"], e["action"]) for e in ents], [(i, c, p, d) for i, c, p, d in ROWS])

class Exclusions(Base):
    def test_only_out_of_scope_strictly_above_099_with_auto_is_valid(self):
        log, _ = self.session()
        self.assertEqual(self.validate([excl(0)], log), dict(valid=1, invalid=0, reasons=[]))
        for ex, why in [(excl(1), "not strictly above"), (excl(2, cls="in_scope"), "not out_of_scope"), (excl(3), "not explicitly auto")]:
            r = self.validate([ex], log)
            self.assertEqual(r["invalid"], 1, ex); self.assertIn(why, r["reasons"][0]["reason"])

    def test_declared_values_and_reuse_must_match_the_real_result(self):
        log, _ = self.session()
        self.assertIn("differ from the real result", self.validate([excl(0, conf=0.999)], log)["reasons"][0]["reason"])
        self.assertIn("same number", self.validate([excl(0, conf=True)], log)["reasons"][0]["reason"])   # True == 1 in Python: a bool is never a confidence
        self.assertIn("same number", self.validate([excl(0, conf="1")], log)["reasons"][0]["reason"])
        self.assertIn("already used", self.validate([excl(0), excl(0)], log)["reasons"][0]["reason"])
        e = excl(0); e["detail"] = "another detail"
        self.assertIn("whitespace-normalized detail", self.validate([e], log)["reasons"][0]["reason"])
        e = excl(0); e["jev_ref"]["key"] = "d9"
        self.assertIn("key differs", self.validate([e], log)["reasons"][0]["reason"])
        e = excl(0); e["jev_ref"]["tool_use_id"] = "c1"
        self.assertIn("not jev_classify", self.validate([e], log)["reasons"][0]["reason"])
        e = excl(0); e["jev_ref"]["tool_use_id"] = "nope"
        self.assertIn("not found", self.validate([e], log)["reasons"][0]["reason"])
        lost = [dict(type="lost_detail", omission_ref=dict(detail=DETAILS[0], source_check_id="s"))]
        self.assertIn("lost_detail finding", self.validate([excl(0)], log, lost)["reasons"][0]["reason"])
        self.assertEqual(self.validate("x", log)["invalid"], 1)
        self.assertEqual(self.validate([], log), dict(valid=0, invalid=0, reasons=[]))

    def test_the_payload_must_be_the_canonical_one(self):
        ctx = scope.canonical_context(REQUESTS)
        other = dict(payload(ctx), context=scope.canonical_context(REQUESTS[:1]))
        loose = dict(payload(ctx), minimum_margin=0)
        typed = dict(payload(ctx), classes=scope.CLASSES[:2])
        log = build(self.d, [("k2", other, classify_result(ROWS)), ("k3", loose, classify_result(ROWS)), ("k4", typed, classify_result(ROWS))])
        self.assertIn("context is not the canonical scope", self.validate([excl(0, tid="k2")], log)["reasons"][0]["reason"])
        self.assertIn("other arguments (minimum_margin)", self.validate([excl(0, tid="k3")], log)["reasons"][0]["reason"])
        self.assertIn("purpose or classes", self.validate([excl(0, tid="k4")], log)["reasons"][0]["reason"])

class ReportStatus(Base):
    def doc(self, log, ex=None):
        d = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), status="PASS", findings=[], unresolved=[],
                 checks=[dict(id="k", tool="jev_verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="c1", result_index=0, key=CLAIM))])
        if ex is not None: d["scope_exclusions"] = ex
        return report.bind_report(d, log, self.d, (), False, None, None, "R04")

    def test_a_valid_exclusion_keeps_pass_and_an_invalid_one_makes_it_unresolved(self):
        log, _ = self.session()
        self.assertEqual(self.doc(log)["status"], "PASS")
        self.assertNotIn("scope_audit", self.doc(log))
        ok = self.doc(log, [excl(0)])
        self.assertEqual(ok["status"], "PASS"); self.assertEqual(ok["scope_audit"]["valid"], 1); self.assertEqual(ok["scope_audit"]["threshold"], 0.99)
        bad = self.doc(log, [excl(0), excl(1)])
        self.assertEqual(bad["status"], "UNRESOLVED"); self.assertEqual(bad["status_claimed"], "PASS")
        self.assertIn("invalid scope exclusions: 1", bad["binding_summary"]["reasons"])
        self.assertEqual(bad["scope_audit"]["invalid"], 1); self.assertIn("not strictly above", bad["scope_audit"]["reasons"][0]["reason"])

    def test_a_fail_stays_fail_with_an_invalid_exclusion(self):
        from unittest import mock
        log, _ = self.session()
        real = jevref.audited_status
        def failing(*a, **k): return dict(real(*a, **k), status="FAIL", reasons=[])
        with mock.patch.object(jevref, "audited_status", failing):
            d = self.doc(log, [excl(1)])
        self.assertEqual(d["status"], "FAIL"); self.assertEqual(d["scope_audit"]["invalid"], 1)

    def test_write_report_stores_the_scope_audit_and_the_final_status(self):
        log, _ = self.session()
        run = os.path.join(self.d, ".handoff-verify", "s1", "r1"); os.makedirs(run)
        hp = os.path.join(self.d, "HANDOFF.md")
        with open(hp, "w", encoding="utf-8") as f: f.write("# note\n")
        d = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), variant="txdiff", environment={}, handoff=dict(path=hp, versions=[]), status="PASS", checks=[], findings=[], unresolved=[],
                 kit={}, cost={}, patch=None, scope_exclusions=[excl(0), excl(3)])
        md, js = report.write_report(run, hp, d, "Stare: PASS\n", calls_jsonl=log)
        out = json.load(open(os.path.join(run, js), encoding="utf-8"))
        self.assertEqual((out["scope_audit"]["valid"], out["scope_audit"]["invalid"]), (1, 1))
        self.assertEqual(out["status"], "UNRESOLVED"); self.assertIn("invalid scope exclusions: 1", out["binding_summary"]["reasons"])
        self.assertIn("UNRESOLVED", open(os.path.join(run, md), encoding="utf-8").read())

class Cli(Base):
    def run_cli(self, *args):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare", *args], capture_output=True, text=True, env=ENV)
        return p.returncode, json.loads(p.stdout)

    def test_prepare_prints_canonical_batches_of_64(self):
        log, ctx = self.session()
        spec = os.path.join(self.d, "spec.json")
        with open(spec, "w", encoding="utf-8") as f: json.dump(["detail  %d" % i for i in range(65)], f)
        code, out = self.run_cli("--source", log, "--spec", spec)
        self.assertEqual(code, 0, out)
        self.assertEqual([len(p["items"]) for p in out["payloads"]], [64, 1])
        self.assertEqual(out["payloads"][1]["items"], [dict(id="d65", text="detail 64")])
        self.assertEqual(out["payloads"][0]["context"], ctx); self.assertEqual(out["payloads"][0]["classes"], scope.CLASSES); self.assertEqual(out["threshold"], 0.99)
        self.assertEqual(set(out["payloads"][0]), {"purpose", "classes", "context", "items"})

    def test_prepare_refuses_what_it_cannot_judge(self):
        log, _ = self.session()
        self.assertEqual(self.run_cli("--source", log, "--detail", "x" * 2001)[0], 3)
        self.assertEqual(self.run_cli("--source", log, "--detail", "   ")[0], 3)
        self.assertEqual(self.run_cli("--source", log)[0], 3)
        empty = os.path.join(self.d, "e"); os.mkdir(empty); s = Session(empty); s.tool("sk", "Skill", dict(skill="jev:handoff-verify"), "x"); s.save()
        code, out = self.run_cli("--source", s.log, "--detail", "x")
        self.assertEqual(code, 3); self.assertIn("no user request", out["reasons"][0])
        big = os.path.join(self.d, "b"); os.mkdir(big); s = Session(big); s.rec("user", "y" * (scope.MAX_CONTEXT + 1)); s.save()
        code, out = self.run_cli("--source", s.log, "--detail", "x")
        self.assertEqual(code, 3); self.assertIn("scope too large", out["reasons"][0]); self.assertNotIn("payloads", out)
        code, out = self.run_cli("--source", log, "--detail", "x" * 2000)
        self.assertEqual(code, 0); self.assertEqual(out["payloads"][0]["items"], [dict(id="d1", text="x" * 2000)])   # exactly 2000 characters is accepted

if __name__ == "__main__": unittest.main()

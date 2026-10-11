#!/usr/bin/env python3
"""Tests of delegation.py (offline, stdlib only, no model, no Jev call, never reads .handoff-verify/ or a real transcript). The session is invented: a request per chunk, a write of the note, a run of the skill and later records that lie OUTSIDE the window of a `prefix` evaluation.
Every negative test changes a good answer in one way and requires the exact problem code. usage: python3 -B test_delegation.py [-v]"""
import contextlib, copy, io, json, os, re, shutil, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, delegation as D, prepare
import test_run_binding as RB

MAXC = 700

class Case(unittest.TestCase):
    def setUp(self):
        self.d = os.path.realpath(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.d); t = RB.Tx(self.d)
        for i in range(12): t.user("request %d: the %s rule is that nobody touches item-%d without a review %s" % (i, ["billing", "export", "login"][i % 3], i, "pad " * 40))
        t.write("w1", RB.V1); t.run("r1"); t.user("LATE record after the write: never deploy on friday"); t.verify(); t.save(); open(t.note, "w").write(RB.V1); self.t = t
        self.work = os.path.join(self.d, "work"); os.makedirs(self.work); prepare.derive(t.log, None, [os.path.realpath(t.note)], MAXC, self.work)
        self.plan = A.plan_of(t.log, t.note, MAXC); self.k = next(k for k in [("w1", v["sha256"], "prefix", None) for h in self.plan["notes"] for v in h["versions"]])
        self.win, _ = A.window_of(self.plan, self.plan["source"], self.k)
    def assign(self, lo=0, hi=3, cap=None, **kw):
        a = dict(source=self.t.log, note=self.t.note, write_id="w1", mode="prefix", run=None, chunk_dir=self.work, lo=lo, hi=hi, cap=cap, max_chars=MAXC); a.update(kw); return D.assign(**a)
    def good(self, a):
        """A complete, valid answer for the assignment `a`, built from the real chunk files."""
        def quote(c, n=0):
            text = open(c["path"], encoding="utf-8", newline="").read(); u, s, e = [x for x in c["spans"] if text[x[1]:x[2]].strip()][n]; return {"uuid": u, "quote": text[s:e].strip()[:24]}
        ch = a["chunks"]; cats = [{"category": n, "outcome": "candidates", "candidates": ["c1"]} if n == 2 else {"category": n, "outcome": "no_candidate", "basis": quote(ch[0], n % 2)} for n in A.CATEGORIES]
        return {"schema": D.SCHEMA, "assignment_id": a["assignment_id"], "complete": True, "chunks": [{"index": c["index"], "sha256": c["sha256"], "categories": list(A.CATEGORIES), "basis": quote(c)} for c in ch], "categories": cats,
                "candidates": [dict(quote(ch[0]), ref="c1", category=2, detail="Nobody touches an item without a review", chunk=ch[0]["index"])], "blockers": []}
    def check(self, a, r, code=None, raw=None):
        v = D.validate(a, raw if raw is not None else json.dumps(r).encode()); codes = [p["code"] for p in v["problems"]]
        if code is None: self.assertEqual(v["problems"], []); self.assertTrue(v["valid"])
        else: self.assertFalse(v["valid"]); self.assertIn(code, codes, v)
        return v

class Assign(Case):
    def test_everything_comes_from_the_code_and_the_id_is_stable(self):
        a, b = self.assign(), self.assign(); self.assertEqual(a, b); self.assertEqual(a["evaluation"]["write_tool_use_id"], "w1"); self.assertEqual([c["index"] for c in a["chunks"]], [i for i in self.win["indexes"] if i <= 3])
        for c in a["chunks"]: self.assertEqual(c["sha256"], next(x for x in self.plan["chunks"] if x["index"] == c["index"])["sha256"]); self.assertEqual(c["spans"], [list(s) for s in self.win["spans"][c["index"]]])
        self.assertEqual(self.assign(lo=0, hi=2)["assignment_id"] != a["assignment_id"], True); self.assertIsNone(a["session_cap"])
    def test_only_the_expected_chunks_of_the_window_and_at_most_twenty(self):
        self.assertLessEqual(len(self.assign(lo=0, hi=99)["chunks"]), D.MAX_INTERVAL); last = max(self.win["indexes"])
        for lo, hi in ((last + 1, last + 5), (5, 2)):
            with self.subTest((lo, hi)), self.assertRaises(D.Refused) as e: self.assign(lo=lo, hi=hi)
            self.assertEqual(e.exception.code, "interval")
        with mock.patch.object(D, "MAX_INTERVAL", 1), self.assertRaises(D.Refused) as e: self.assign(lo=0, hi=3)
        self.assertEqual(e.exception.code, "interval")
    def test_a_stale_chunk_file_an_unknown_write_and_an_unproven_window_delegate_nothing(self):
        f = os.path.join(self.work, next(c["file"] for c in self.plan["chunks"] if c["index"] == 0)); open(f, "a").write("x")
        with self.assertRaises(D.Refused) as e: self.assign()
        self.assertEqual(e.exception.code, "chunk_file_stale"); open(f, "w").write(self.plan["texts"][0])
        with self.assertRaises(D.Refused) as e: self.assign(write_id="nope")
        self.assertEqual(e.exception.code, "write_not_found")
        with mock.patch.object(A, "window_of", lambda *x: (None, "ambiguous window")), self.assertRaises(D.Refused) as e: self.assign()
        self.assertEqual(e.exception.code, "window_unavailable")

class Prompt(Case):
    def test_rules_are_copied_verbatim_and_no_chunk_text_is_inlined(self):
        a = self.assign(); p = D.prompt(a); root = open(os.path.join(a["skill_dir"], "SKILL.md"), encoding="utf-8").read()
        self.assertIn(D.section(root, "## Hard rules"), p); self.assertIn(D.section(root, "## The nine categories"), p); self.assertIn(D.NEVER, p); self.assertIn(a["assignment_id"], p)
        for c in a["chunks"]: self.assertIn(c["path"], p); self.assertIn(c["sha256"], p)
        self.assertNotIn("pad pad pad", p); self.assertNotIn("LATE record", p); self.assertIn("untrusted", p); self.assertIn("do not call Jev", p)
    def test_the_capability_line_appears_only_with_a_real_capability_and_with_its_value(self):
        self.assertNotIn("Session capability", D.prompt(self.assign())); p = D.prompt(self.assign(cap="CAP-1a2b3c"))
        self.assertIn("Session capability: pass --session-cap CAP-1a2b3c to every cli.mjs call, also in subagent prompts", p); self.assertEqual(p.count("CAP-1a2b3c"), 1)
    def test_a_foreign_object_is_refused(self):
        with self.assertRaises(D.Refused): D.prompt({"schema": "x"})

class Validate(Case):
    def setUp(self): super().setUp(); self.a = self.assign(); self.r = self.good(self.a)
    def test_a_good_answer_is_valid_and_its_candidate_accepted(self):
        v = self.check(self.a, self.r); self.assertTrue(v["complete"]); self.assertEqual([c["ref"] for c in v["accepted_candidates"]], ["c1"]); self.assertEqual(v["missing_chunks"], [])
    def test_one_change_at_a_time_each_with_its_code(self):
        def mut(fn):
            r = copy.deepcopy(self.r); fn(r); return r
        quote = lambda r: r["chunks"][0]["basis"]
        for what, code, fn in (("another schema", "schema", lambda r: r.update(schema="x")), ("an extra key", "schema", lambda r: r.update(note="x")), ("a missing key", "schema", lambda r: r.pop("blockers")), ("another assignment", "foreign_assignment", lambda r: r.update(assignment_id="0" * 16)),
                               ("a stale hash", "chunk_stale", lambda r: r["chunks"][0].update(sha256="0" * 64)), ("eight categories in a chunk", "chunk_categories", lambda r: r["chunks"][0].update(categories=[1, 2, 3, 4, 5, 6, 7, 8])),
                               ("a basis that is not exact", "chunk_ungrounded", lambda r: quote(r).update(quote=quote(r)["quote"] + "Z")), ("a missing chunk record", "chunks_missing", lambda r: r["chunks"].pop()), ("a chunk twice", "chunk_duplicate", lambda r: r["chunks"].append(r["chunks"][0])),
                               ("a chunk that was not assigned", "chunk_record", lambda r: r["chunks"].append(dict(r["chunks"][0], index=999))), ("a category record missing", "category_records", lambda r: r["categories"].pop()), ("a category twice", "category_records", lambda r: r["categories"].append(r["categories"][0])),
                               ("no basis for no_candidate", "category_ungrounded", lambda r: r["categories"][0].pop("basis")), ("a category number alone", "category_ungrounded", lambda r: r["categories"][0].update(basis={"uuid": "u1", "quote": ""})),
                               ("an unknown outcome", "category_outcome", lambda r: r["categories"][0].update(outcome="maybe")), ("candidates listed for no_candidate", "category_candidates", lambda r: r["categories"][0].update(candidates=["c1"])),
                               ("candidates without a candidate", "category_candidates", lambda r: r["categories"][1].update(candidates=["zz"])), ("not complete", "incomplete", lambda r: r.update(complete=False)), ("complete as a string", "incomplete", lambda r: r.update(complete="yes")),
                               ("a candidate quote that is not exact", "candidate_rejected", lambda r: r["candidates"][0].update(quote="never deploy on thursday")), ("a candidate in an unassigned chunk", "candidate_rejected", lambda r: r["candidates"][0].update(chunk=999)),
                               ("a candidate without detail", "candidate_rejected", lambda r: r["candidates"][0].update(detail=" ")), ("a candidate of category 10", "candidate_rejected", lambda r: r["candidates"][0].update(category=10)), ("a secret in the answer", "result_not_sanitized", lambda r: r.update(blockers=["password=hunter2hunter2hunter2"])),
                               ("the capability returned", "capability_in_result", lambda r: r.update(blockers=["use --session-cap abc123"]))):
            with self.subTest(what): self.check(self.a, mut(fn), code)
    def test_a_record_outside_the_window_is_never_a_quote(self):
        late = next(r for r in self.t.recs if "LATE record" in json.dumps(r)); r = copy.deepcopy(self.r); r["candidates"][0].update(uuid=late["uuid"], quote="never deploy on friday"); v = self.check(self.a, r, "candidate_rejected"); self.assertEqual(v["accepted_candidates"], [])
    def test_other_valid_candidates_are_kept_when_one_is_rejected(self):
        r = copy.deepcopy(self.r); r["candidates"].append(dict(r["candidates"][0], ref="c2", quote="not in the record")); v = self.check(self.a, r, "candidate_rejected"); self.assertEqual([c["ref"] for c in v["accepted_candidates"]], ["c1"]); self.assertEqual(len(v["rejected_candidates"]), 1)
    def test_a_too_large_or_unreadable_answer_gives_the_parent_the_whole_interval(self):
        v = self.check(self.a, None, "result_too_large", raw=b" " * (D.RESULT_CAP + 1)); self.assertEqual(v["missing_chunks"], [c["index"] for c in self.a["chunks"]]); self.check(self.a, None, "invalid_json", raw=b"not json"); self.check(self.a, None, "schema", raw=b"[]")
        exact = json.dumps(self.r).encode(); self.assertLess(len(exact), D.RESULT_CAP); self.check(self.a, self.r)      # an answer within the cap is not refused for its size
    def test_a_changed_transcript_makes_the_assignment_stale_and_trusts_nothing_in_it(self):
        with open(self.t.log, "a") as f: f.write(json.dumps(dict(type="user", uuid="u99", timestamp="2026-01-01T00:09:00Z", cwd=self.d, sessionId="s1", message=dict(role="user", content="x" * 5000))) + "\n")
        A._PLANS.clear(); self.check(self.a, self.r)      # appended after the write: the window and the chunks before it are the same
        a2 = copy.deepcopy(self.a); a2["chunks"][0]["spans"][0][2] += 1; self.check(a2, self.r, "assignment_stale")      # a span that is not the re-derived one
        a3 = copy.deepcopy(self.a); a3["chunks"][0]["sha256"] = "0" * 64; self.check(a3, self.r, "assignment_stale")
    def test_the_capability_in_the_assignment_is_never_returned(self):
        a = self.assign(cap="CAP-1a2b3c"); r = self.good(a); self.check(a, r); r["blockers"] = ["token CAP-1a2b3c"]; self.check(a, r, "capability_in_result")

class Cli(Case):
    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): rc = D.main(list(argv))
        return rc, out.getvalue()
    def test_assign_prompt_validate_end_to_end(self):
        af = os.path.join(self.d, "a.json"); rc, out = self.run_cli("assign", "--source", self.t.log, "--note", self.t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--chunk-dir", self.work, "--from", "0", "--to", "3", "--max-chars", str(MAXC), "--out", af, "--session-cap", "CAP-x")
        self.assertEqual(rc, 0); a = json.load(open(af)); self.assertEqual(json.loads(out), a); rc, text = self.run_cli("prompt", "--assignment", af); self.assertEqual((rc, text), (0, D.prompt(a)))
        rf = os.path.join(self.d, "r.json"); r = self.good(a); json.dump(r, open(rf, "w")); rc, out = self.run_cli("validate", "--assignment", af, "--result", rf); self.assertEqual(rc, 0); self.assertTrue(json.loads(out)["valid"])
        r["complete"] = False; json.dump(r, open(rf, "w")); rc, out = self.run_cli("validate", "--assignment", af, "--result", rf); self.assertEqual(rc, 1); self.assertTrue(json.loads(out)["accepted_candidates"])
    def test_a_refusal_is_printed_and_exits_one(self):
        rc, out = self.run_cli("assign", "--source", self.t.log, "--note", self.t.note, "--write-id", "nope", "--evaluated-against", "prefix", "--chunk-dir", self.work, "--from", "0", "--to", "3", "--max-chars", str(MAXC)); self.assertEqual(rc, 1); self.assertEqual(json.loads(out)["refused"], "write_not_found")
    def test_it_starts_nothing_and_stays_small(self):
        src = open(os.path.join(HERE, "delegation.py"), "rb").read(); self.assertLessEqual(len(src), 24576); self.assertLessEqual(len(open(__file__, "rb").read()), 24576)
        self.assertIsNone(re.search(rb"subprocess|urllib|socket|jev_|anthropic|claude -p|os\.system|exec\(", src))      # no model, no Jev, no network, no process, nothing is executed

if __name__ == "__main__": unittest.main()

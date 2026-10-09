#!/usr/bin/env python3
"""Documentation-driven synthetic end-to-end fixture (item 19; stdlib only, offline, no Jev call, never reads .handoff-verify/). The stories are READ from SKILL.md (Example 02 and Example 06: the transcript excerpt, the handoff excerpt and the detail), the
transcript is a synthetic Claude Code log, and the procedure is the documented one: real preparation (prepare.py CLI, omissions.prepare_one, `audit.py register` / `audit.py template`), recorded Jev calls (invented responses), the bound report
(report.write_report) and the delivery gate (versions.gate and the `versions.py status` CLI). Four outcomes:
 - a qualifying omission (a valid R04 ABSENCE-first pair): FAIL, with a complete audit and also without one (FAIL keeps its precedence);
 - the old verified-absence variant (the absence call comes back `verified`): confirms nothing;
 - low-confidence or incomplete work: UNRESOLVED;
 - a genuinely complete PASS: bound checks, no defect and a reviewed audit (a good check alone, or `coverage.json` complete alone, is not a PASS).
The responses are invented: the SOURCE half carries compatible-synthetic subject fields (the inspected server emits none, so a realistic response leaves the pair UNRESOLVED: pinned below).
usage: python3 -B test_doc_end_to_end.py [-v]"""
import argparse, json, os, re, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, discover, jevref, omissions, report, scope, versions
import contract_fixtures as CF
import audit_fixtures as AF
import test_run_binding as RB

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SKILL = open(os.path.join(HERE, "..", "SKILL.md"), encoding="utf-8").read()

def example(n):
    """-> (section text, [fenced blocks]) of `### Example 0N` of SKILL.md."""
    i = SKILL.index("### Example %02d" % n); j = SKILL.find("\n### Example", i + 5); sec = SKILL[i:j if j > 0 else len(SKILL)]
    return sec, re.findall(r"```\n(.*?)```", sec, re.S)

def cli(script, args, cwd=None):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + args, cwd=cwd, capture_output=True, text=True, env=ENV); return p.returncode, p.stdout

class Doc(unittest.TestCase):
    """The facts of the examples, read from the documentation."""
    def test_example_02_is_the_absence_first_pair_and_names_every_condition_of_the_fixture(self):
        sec, blocks = example(2); self.assertEqual(len(blocks), 2)
        m = re.search(r'--detail "([^"]+)" --source-quote "([^"]+)"', sec); self.assertEqual(m.group(1), m.group(2))
        sc, ac = omissions.claims(m.group(1), "R04")
        self.assertIn('"claims": ["%s"]' % ac, sec); self.assertIn('"claims": ["%s"]' % sc, sec)      # the calls of the example use exactly the claims omissions.py prints
        for must in ("ABSENCE-first", "`unsupported` with confidence > 0.95", "`action` `auto`", "`same_subject` >= `subject_at`", "SAME `version_ref`", "`omission_ref`", "`quote_handoff` null", "protocol_fields_absent", "confirms nothing", "ILLUSTRATIVE shorthand"):
            self.assertIn(must, sec, must)
        self.assertIn('"evidence": [{"text":', sec)      # the evidence is a LIST of entries, not a bare string

    def test_example_06_requires_the_reviewed_audit_not_the_generated_coverage_alone(self):
        sec, blocks = example(6); self.assertIn("COMPLETE audit block", sec); self.assertIn("would not justify a PASS", sec); self.assertIn("audit complet", sec)

    def test_the_checklist_has_the_seven_steps_in_order_and_each_names_its_home(self):
        i = SKILL.index("## Current-run checklist"); sec = SKILL[i:SKILL.index("\n## ", i + 5)]
        order = ["**Provenance**", "**Locations**", "**Coverage and events**", "**Scope**", "**Prepared calls**", "**Bound report**", "**Delivery gate**"]
        pos = [sec.index(o) for o in order]; self.assertEqual(pos, sorted(pos))
        for home in ("Explicit targets and provenance", "Work locations", "Mandatory audit", "Scope filter (R05)", "Omissions (R04)", "Binding checks to Jev calls", "Hard rules"): self.assertIn(home, sec, home)
        self.assertLess(len(sec), 4500)      # short: the rules themselves live in their own sections

    def test_the_audit_section_documents_what_audit_py_enforces(self):
        i = SKILL.index("## Mandatory audit"); sec = SKILL[i:SKILL.index("\n## ", i + 5)]
        for o in A.OUTCOMES: self.assertIn("`%s`" % o, sec)
        for must in ("prefix_chunks", "scope_exclusions", "audit.max_chars", "audit.py register", "audit.py template", "`valid`", "`invalidated`", "`unavailable`", "`present`", "`excluded`", "`omission`", "editable files", "a hash binds a snapshot only", "certifying: false", "`verified_version` answers a different question"):
            self.assertIn(must, sec, must)
        for c in ("sha256", "reviewed", "categories", "basis", "uuid", "quote", "unresolved"): self.assertIn(c, sec)

    def test_the_historical_narratives_are_not_in_the_skill_body_but_in_the_on_demand_file(self):
        for gone in ("Measured on this Jev version", "Measured on the 9 real notes", "Measured once on this Jev version", "Backtest on this machine", "results/T2.md", "results/rounds", "results/evidence", "direct probes", "after the two R01 live sessions", "validates nothing"):
            self.assertNotIn(gone, SKILL, gone)
        hist = open(os.path.join(HERE, "HISTORY.md"), encoding="utf-8").read(); self.assertIn("scripts/HISTORY.md", SKILL)
        for kept in ("Measured on this Jev version", "Measured on the 9 real notes", "Measured once on this Jev version", "Backtest on this machine", "results/T2.md", "validates nothing", "examples/02-omission.md", "no `results/` directory"): self.assertIn(kept, hist, kept)
        self.assertEqual(os.path.basename(HERE), "scripts")      # a non-test file under scripts/ (the Python discovery pattern is test_*.py)

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name); omissions.reset_caches(); scope._MEMO.clear(); A._PLANS.clear()
        self.n = 0

    def story(self, n):
        """(user request text, handoff lines, detail, quote) of the Example n of SKILL.md."""
        sec, blocks = example(n); transcript, handoff = blocks[0], blocks[1]
        user = re.search(r"\[u-\d+ [a-z_ ]+\] (.*)", transcript).group(1)
        note = "".join(l + "\n" for l in handoff.splitlines() if l.strip() and not l.startswith("("))
        m = re.search(r'--detail "([^"]+)" --source-quote "([^"]+)"', sec)
        return user, note, (m.group(1), m.group(2)) if m else (None, None)

    def build(self, user, note, extra=()):
        """The synthetic session: the request, the Write of the note, the skill run and the recorded Jev calls ((tool_use id, input, body))."""
        self.t = t = RB.Tx(self.d); t.user(user); t.write("w1", note); t.run("sk1"); t.save(); open(t.note, "w", encoding="utf-8").write(note)
        for tid, inp, body in extra: t.tool(tid, "mcp__jev__jev_verify", inp, body)
        t.save(); return t

    def prepared(self, detail, quote, t=None):
        t = t or self.t; a = argparse.Namespace(source=t.log, file=t.note, cwd=self.d, write_id="w1", evaluated_against="prefix", detail=detail, source_quote=quote, location=[], run=None)
        omissions._MEMO.clear(); obj, code = omissions.prepare_one(a); self.assertEqual(code, 0, obj); return obj

    def register(self, detail, category=2):
        """`audit.py register`: the registry is the one of the SESSION (its location is derived from the source: the CLI prints it, a report cannot choose it)."""
        code, out = cli("audit.py", ["register", "--source", self.t.log, "--file", self.t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--detail", detail, "--category", str(category), "--cwd", self.d])
        self.assertEqual(code, 0, out); o = json.loads(out); return o["registry"], o["candidate"]

    def reviewed_basis(self, index, nth=0):
        """What the reviewer does: READ the chunk file that `prepare.py` wrote (work/transcript/chunk-NNNN.txt) and quote a record of it: -> {uuid, quote} (the exact text after the `[uuid role] ` header of a record)."""
        if not hasattr(self, "work"):
            self.work = os.path.join(self.d, "work"); code, out = cli("prepare.py", [self.t.log, "--cwd", self.d, "--out", self.work]); self.assertEqual(code, 0, out)
        text = open(os.path.join(self.work, "transcript", "chunk-%04d.txt" % index), encoding="utf-8").read()
        rec = [m for m in re.finditer(r"^\[([^ \]]+) (?:user|assistant)\] (.+)$", text, re.M) if m.group(2).strip()][nth]
        return dict(uuid=rec.group(1), quote=rec.group(2).strip()[:24])

    def audit_block(self, reg=None, cand=None, category=2, review=True):
        """The documented procedure: `audit.py template` establishes the evaluation in the session's registry and prints the UNREVIEWED block; the reviewer then reads every expected chunk, marks it reviewed for the nine categories with a basis (a uuid and an exact quote of a record
        of that chunk) and gives one source-grounded outcome per category (`candidates` = exactly the registered ones, or `no_candidate` with a basis)."""
        code, out = cli("audit.py", ["template", "--source", self.t.log, "--file", self.t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", self.d])
        self.assertEqual(code, 0, out); o = json.loads(out); b = o["block"]
        self.assertTrue(all(c["reviewed"] is False for c in b["chunks"])); self.assertTrue(all(c["outcome"] is None for c in b["categories"]))
        if review:
            for c in b["chunks"]: c.update(reviewed=True, categories=list(A.CATEGORIES), basis=self.reviewed_basis(c["index"]))
            for c in b["categories"]:
                if cand and c["category"] == category: c.update(outcome="candidates", candidates=[cand])
                else: c.update(outcome="no_candidate", basis=self.reviewed_basis(b["chunks"][0]["index"]))
        return b, o

    def checks_for(self, t, rows):
        v = versions.versions_of(t.log, t.note)[0][0]; ref = versions.version_ref(v, "prefix")
        return [dict(id=cid, tool="verify", verdict=verdict, confidence=conf, jev_ref=dict(tool_use_id=tid, result_index=0, key=key), version_ref=ref) for cid, tid, key, verdict, conf in rows]

    def report(self, t, doc):
        self.n += 1; rd = os.path.join(self.d, "run%d" % self.n); os.makedirs(rd)
        md, js = report.write_report(rd, t.note, doc, "Stare: **PASS**\n", calls_jsonl=t.log); path = os.path.join(rd, js); out = json.load(open(path, encoding="utf-8"))
        g = versions.gate(t.log, t.note, out, disk_path=t.note); return out, g, path

    def doc(self, t, checks, findings=(), block=None, reg=None, status="PASS"):
        d = AF.shell(dict(session=dict(session_id="s1", jsonl=t.log, cwd=self.d), handoff=dict(path=t.note, versions=[]), checks=checks, findings=list(findings), unresolved=[], status=status, scope_exclusions=[]))
        if block is not None: d["audit"] = dict(version=1, evaluations=[block], **({"registry": reg} if reg else {}))
        return d

class QualifyingOmission(Base):
    """Example 02: the constraint about the public API is missing from the note; the pair is made ABSENCE-first, on the same write."""
    def setUp(self):
        super().setUp(); self.user, self.note, (self.detail, self.quote) = self.story(2)
        self.build(self.user, self.note); self.p = self.prepared(self.detail, self.quote)

    def calls(self, abs_body, src_body=None):
        extra = [("a1", dict(claims=[self.p["absence_claim"]], evidence=[dict(text=self.p["material"])]), abs_body)]
        if src_body is not None: extra.append(("s1", dict(claims=[self.p["source_claim"]], evidence=[dict(text=self.p["source_passage"])]), src_body))
        return self.build(self.user, self.note, extra)

    def absence(self, verdict="unsupported", conf=0.98, action="auto", compat=True): return CF.verify_body([dict(claim=self.p["absence_claim"], verdict=verdict, confidence=conf, action=action)], compatible_synthetic=compat)
    def source(self, verdict="verified", conf=0.99, compat=True): return CF.verify_body([dict(claim=self.p["source_claim"], verdict=verdict, confidence=conf)], compatible_synthetic=compat)

    def pair_doc(self, t, block=None, reg=None, src_check=True):
        rows = [("abs", "a1", self.p["absence_claim"], "unsupported", 0.98)] + ([("src", "s1", self.p["source_claim"], "verified", 0.99)] if src_check else [])
        f = dict(type="lost_detail", check_id="abs", claim=self.p["absence_claim"], confidence=0.98, quote_source=self.quote, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=self.detail, source_check_id="src"))
        return self.doc(t, self.checks_for(t, rows), [f], block, reg, "FAIL")

    def test_preparation_prints_the_claims_and_the_material_the_example_documents(self):
        self.assertEqual(self.p["absence_claim"], self.detail); self.assertEqual(self.p["source_claim"], omissions.SOURCE_PREFIX + self.detail)
        self.assertEqual(self.p["source_passage"].count(self.quote), 1); self.assertEqual(self.p["version_ref"]["evaluated_against"], "prefix"); self.assertIn("public API", self.user)
        self.assertNotIn("public API", self.note)      # the constraint IS missing from the note

    def test_a_valid_pair_is_fail_with_a_complete_audit(self):
        t = self.calls(self.absence(), self.source()); reg, cand = self.register(self.detail); block, o = self.audit_block(reg, cand)
        self.assertIn(cand, [c["id"] for c in o["expected_candidates"]]); out, g, path = self.report(t, self.pair_doc(t, block, reg))
        self.assertEqual(out["status"], "FAIL", out["binding_summary"]["reasons"])
        au = out["binding_summary"]["audit"]; self.assertTrue(au["complete"], au); self.assertEqual(au["unfinished"], {})
        self.assertEqual((g["audited_status"], g["delivery_state"]), ("FAIL", "verified_version")); self.assertTrue(g["audit"]["complete"])
        code, text = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", path, "--cwd", self.d]); s = json.loads(text); self.assertEqual((code, s["audited_status"], s["delivery_state"]), (0, "FAIL", "verified_version"))

    def test_fail_keeps_its_precedence_when_the_review_was_never_done(self):
        t = self.calls(self.absence(), self.source()); reg, cand = self.register(self.detail); block, _ = self.audit_block(reg, cand, review=False)      # the template, untouched
        out, g, path = self.report(t, self.pair_doc(t, block, reg)); au = out["binding_summary"]["audit"]
        self.assertEqual(out["status"], "FAIL"); self.assertFalse(au["complete"]); self.assertGreaterEqual(au["unfinished"]["chunks_unreviewed"], 1); self.assertGreaterEqual(au["unfinished"]["categories"], 1)      # counted, exposed, not hidden
        self.assertEqual(g["audited_status"], "FAIL")
        bare = self.pair_doc(t); bare.pop("scope_exclusions"); out, g, path = self.report(t, bare); self.assertEqual(out["status"], "FAIL"); self.assertFalse(out["binding_summary"]["audit"]["complete"])

    def test_the_pair_stays_unresolved_when_the_server_emits_no_subject_fields(self):
        t = self.calls(self.absence(compat=False), self.source(compat=False)); out, g, path = self.report(t, self.pair_doc(t))
        self.assertNotEqual(out["status"], "FAIL"); self.assertEqual(out["status"], "UNRESOLVED")      # realistic responses (the inspected server) carry no same_subject / subject_at
        src = next(b for b in out["checks"] if b["id"] == "src"); self.assertFalse(src["binding"]["resolved"]); self.assertFalse(src["binding"]["aux_ok"])      # the strict auxiliary conditions cannot be met by that response

    def test_the_old_verified_absence_variant_confirms_nothing(self):
        """The retired example: the absence call came back `verified` and the finding was called confirmed. The note states the detail (or Jev says so): no omission, no source call, no FAIL."""
        for variant, src_call in (("without a source call", False), ("with a source call", True)):
            with self.subTest(variant):
                t = self.calls(self.absence(verdict="verified", conf=0.97), self.source() if src_call else None)
                rows = [("abs", "a1", self.p["absence_claim"], "verified", 0.97)] + ([("src", "s1", self.p["source_claim"], "verified", 0.99)] if src_call else [])
                f = dict(type="lost_detail", check_id="abs", claim=self.p["absence_claim"], confidence=0.97, quote_source=self.quote, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=self.detail, source_check_id="src"))
                out, g, path = self.report(t, self.doc(t, self.checks_for(t, rows), [f], None, None, "FAIL"))
                self.assertNotEqual(out["status"], "FAIL"); self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["status_claimed"], "FAIL")

class LowConfidence(Base):
    def setUp(self):
        super().setUp(); self.user, self.note, (self.detail, self.quote) = self.story(2); self.build(self.user, self.note); self.p = self.prepared(self.detail, self.quote)
    def call(self, body): return self.build(self.user, self.note, [("a1", dict(claims=[self.p["absence_claim"]], evidence=[dict(text=self.p["material"])]), body)])
    def absence_check(self, t, verdict, conf): return self.checks_for(t, [("abs", "a1", self.p["absence_claim"], verdict, conf)])

    def test_an_absence_result_at_or_below_the_threshold_or_for_review_stays_unresolved(self):
        for name, conf, action in (("0.95 exactly", 0.95, "auto"), ("0.75", 0.75, "auto"), ("review", 0.98, "review")):
            with self.subTest(name):
                t = self.call(CF.verify_body([dict(claim=self.p["absence_claim"], verdict="unsupported", confidence=conf, action=action)], compatible_synthetic=True))
                out, g, path = self.report(t, self.doc(t, self.absence_check(t, "unsupported", conf), [], None, None, "PASS"))
                self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(g["delivery_state"], "verified_version")      # the verification IS documented for this write; it is not a PASS
                self.assertFalse(out["binding_summary"]["audit"]["complete"]); self.assertEqual(out["findings"], [])

    def test_a_good_check_with_an_incomplete_audit_is_unresolved_and_a_stale_review_too(self):
        user, note, _ = self.story(6); t = self.build(user, note); sc = "The latest commit is e41a9c2 (migrate billing to duckdb)"
        t = self.build(user, note, [("c1", dict(claims=[sc], evidence=[dict(text="e41a9c2 migrate billing to duckdb")]), CF.verify_body([dict(claim=sc, verdict="verified", confidence=0.99)], compatible_synthetic=True))])
        chk = self.checks_for(t, [("p1", "c1", sc, "verified", 0.99)]); block, _ = self.audit_block()
        out, g, path = self.report(t, self.doc(t, chk, [], None))      # no audit data at all
        self.assertEqual((out["status"], g["audited_status"], g["delivery_state"]), ("UNRESOLVED", "UNRESOLVED", "verified_version"))
        block["chunks"][0]["sha256"] = "0" * 64
        out, g, path = self.report(t, self.doc(t, chk, [], block)); self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["binding_summary"]["audit"]["unfinished"]["chunks_stale"], 1)

class GenuinePass(Base):
    """Example 06: the commit is in the note exactly as in the transcript; the checks are bound and resolved, there is no defect and the reviewed audit is complete."""
    def test_a_clean_report_with_a_complete_audit_is_pass_and_the_example_is_what_runs(self):
        user, note, _ = self.story(6); sec, _ = example(6)
        m = re.search(r'"claims": \["([^"]+)"\]', sec); claim = m.group(1); self.assertIn("e41a9c2", claim); self.assertIn("e41a9c2", note); self.assertIn("e41a9c2", user)
        t = self.build(user, note, [("c1", dict(claims=[claim], evidence=[dict(text=user)]), CF.verify_body([dict(claim=claim, verdict="verified", confidence=0.99)], compatible_synthetic=True))])
        block, o = self.audit_block(); self.assertEqual(o["expected_candidates"], [])
        out, g, path = self.report(t, self.doc(t, self.checks_for(t, [("p1", "c1", claim, "verified", 0.99)]), [], block))
        self.assertEqual(out["status"], "PASS", out["binding_summary"]["reasons"]); self.assertTrue(out["binding_summary"]["audit"]["complete"]); self.assertEqual(out["findings"], [])
        self.assertEqual((g["audited_status"], g["delivery_state"]), ("PASS", "verified_version"))
        code, text = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", path, "--cwd", self.d]); s = json.loads(text); self.assertEqual((code, s["audited_status"], s["delivery_state"]), (0, "PASS", "verified_version"))
        self.assertIn("Stare: **PASS**", open(path.replace(".json", ".md"), encoding="utf-8").read())      # the Markdown follows the audited status

    def test_the_same_report_with_a_stale_or_shortlisted_review_is_not_a_pass(self):
        user, note, _ = self.story(6); claim = "The latest commit is e41a9c2 (migrate billing to duckdb)"
        t = self.build(user, note, [("c1", dict(claims=[claim], evidence=[dict(text=user)]), CF.verify_body([dict(claim=claim, verdict="verified", confidence=0.99)], compatible_synthetic=True))])
        for name, edit in (("shortlist of two categories", lambda b: [c.update(categories=[2, 9]) for c in b["chunks"]]), ("chunk never reviewed", lambda b: b["chunks"][0].update(reviewed=False)), ("one category without an outcome", lambda b: b["categories"][3].update(outcome=None))):
            with self.subTest(name):
                block, _ = self.audit_block(); edit(block); out, g, path = self.report(t, self.doc(t, self.checks_for(t, [("p1", "c1", claim, "verified", 0.99)]), [], block))
                self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(g["audited_status"], "UNRESOLVED"); self.assertEqual(g["delivery_state"], "verified_version")

if __name__ == "__main__": unittest.main()

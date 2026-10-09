#!/usr/bin/env python3
"""Offline regressions of the mandatory full-report audit (item 11; stdlib only, simulated transcripts, no Jev call, never reads .handoff-verify/). ONE audit (audit.py) judges whether the review behind a report is complete and the report writer
(report.write_report / bind_report), the delivery gate (versions.gate, `versions.py status`) and the per-version summaries (versions.per_version: the write summary and every prefix / session_end evaluation) all call it:
 - a lone good check without a COMPLETE audit is UNRESOLVED (verified_version, the delivery state, is a different thing and stays);
 - the expected chunks are re-derived from the real source: a missing / duplicate / stale / unreviewed chunk, a review of fewer than nine categories, a missing category outcome or a non-grounded `not_applicable` blocks the PASS;
 - every REGISTERED candidate (the registry written before the scope filter, plus every obligation of the omission ledger whatever its state) needs a derived disposition: a model-written label never clears it;
 - a confirmed defect keeps FAIL and the unfinished work stays counted; equal-byte writes, modes and runs share nothing; the writer and the gate compute the same audited status.
All fixtures are invented. The tests that expect a PASS carry audit data DERIVED from the fixture's real source (audit_fixtures.complete), never an exemption.
usage: python3 -B test_audit.py [-v]"""
import copy, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, discover, jevref, omissions, prepare, report, scope, versions
import ledger as L
import contract_fixtures as CF
import audit_fixtures as AF
import identity_world as IW
import test_run_binding as RB
import test_scope_filter as SF

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
V1, V2 = RB.V1, RB.V2
QUOTE = "ZZ-DETAIL: never deploy on friday"; DETAIL = "Never deploy on friday"
OTHER = "Always run the smoke tests before a release"
Q1, Q2 = "Do NOT change the public API of billing.", "Never run migrate.sh against prod."

def cli(script, args, cwd=None, stdin=None):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + args, cwd=cwd, capture_output=True, text=True, env=ENV, input=stdin); return p.returncode, p.stdout

class Base(RB.Base):
    """RB.Base (session helpers, `check`) plus the three questions every test asks: what does the writer say, what does the gate say, do they agree."""
    def setUp(self):
        super().setUp(); self.n = 0
    def at(self, t, wid, ea, call="c1", id="p1", **ref):
        """A good verify check of the write `wid` that rests on the (synthetic, subject-field compatible) verify call `call` of the session."""
        return dict(self.check(t, wid, ea, **ref), id=id, jev_ref=dict(tool_use_id=call, result_index=0, key=RB.CLAIM))
    def session(self, n=1, size=150, writes=(("w1", V1),), runs=("r1",), verify=True):
        t = RB.Tx(self.d)
        for i in range(n): t.user("request number %d %s" % (i, "x" * size))
        for tid, text in writes: t.write(tid, text)
        for r in runs: t.run(r)
        if verify: t.verify()
        t.save(); open(t.note, "w").write(writes[-1][1]); return t
    def raw(self, t, checks, **extra):
        return dict(AF.shell(dict(session=dict(session_id="s1", jsonl=t.log, cwd=self.d), handoff=dict(path=t.note, versions=[]), checks=checks, findings=[], unresolved=[], status="PASS", schema_version="1")), **extra)
    def full(self, t, checks=None, raw=None, **kw):
        return AF.complete(self.raw(t, checks if checks is not None else [self.check(t, t_last(t), "session_end")], **(raw or {})), **kw)
    def written(self, t, doc, calls=None):
        """-> (the persisted report, its path): the writer's own output."""
        self.n += 1; rd = os.path.join(self.d, "w%d" % self.n); os.makedirs(rd)
        md, js = report.write_report(rd, t.note, doc, "Stare: **PASS**\n", calls_jsonl=calls or t.log); return json.load(open(os.path.join(rd, js), encoding="utf-8")), os.path.join(rd, js)
    def gate(self, t, js, calls=None): return versions.gate(calls or t.log, t.note, js, disk_path=t.note)
    def reg(self, t): return A.registry_path_of(t.log)      # the registry of the SESSION (derived from the source; a report cannot choose it)
    def blocked(self, t, doc, counter, calls=None, status="UNRESOLVED"):
        """The writer does not PASS, counts the unfinished work, and the gate recomputes the same status and counters; the delivery (a different question) is still decided by the identity."""
        js, path = self.written(t, doc, calls); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], status, js["binding_summary"]["reasons"]); self.assertFalse(au["complete"], au); self.assertGreaterEqual(au["unfinished"].get(counter, 0), 1, au)
        if calls in (None, t.log):      # a retrospective report (its calls live in another session) can never certify a current delivery: only the writer judges it
            g = self.gate(t, js, calls)
            if g["audited_status"] is None:      # a structurally invalid persisted report: the gate recomputes nothing, certifies no delivery and exposes the structural work
                self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("not structurally valid", " ".join(g["reasons"])); self.assertGreaterEqual(g["audit"]["unfinished"]["structure"], 1); self.assertFalse(g["audit"]["complete"])
                return js, g
            self.assertEqual(g["audited_status"], status); self.assertEqual(g["audit"]["unfinished"], au["unfinished"]); self.assertNotIn("stored report status", " ".join(g["reasons"]))
            return js, g
        return js, None
    def passes_report_only(self, t, doc, calls=None):
        js, path = self.written(t, doc, calls); self.assertEqual(js["status"], "PASS", js["binding_summary"]["reasons"]); self.assertTrue(js["binding_summary"]["audit"]["complete"]); return js
    def passes(self, t, doc, calls=None):
        js, path = self.written(t, doc, calls); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "PASS", js["binding_summary"]["reasons"]); self.assertTrue(au["complete"], au); self.assertEqual(au["unfinished"], {})
        if calls in (None, t.log):
            g = self.gate(t, js, calls); self.assertEqual((g["audited_status"], g["delivery_state"]), ("PASS", "verified_version"), g); return js, g
        return js, None

def t_last(t): return versions.versions_of(t.log, t.note)[0][-1]["write_tool_use_id"]

def mutated(doc, fn):
    d = copy.deepcopy(doc); fn(d["audit"]["evaluations"][0]); return d

class LoneGoodCheck(Base):
    def test_without_audit_data_a_good_check_is_unresolved_but_the_version_is_still_verified(self):
        t = self.session(); doc = self.raw(t, [self.check(t, "w1", "session_end")])      # a good bound check, no audit object, no scope accounting
        js, path = self.written(t, doc); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "UNRESOLVED"); self.assertFalse(au["complete"]); self.assertIn("audit", " ".join(js["binding_summary"]["reasons"]))
        self.assertEqual(js["delivery"]["delivery_state"], "verified_version")      # verified_version is NOT PASS: the report documents a genuinely bound check of this very write
        g = self.gate(t, js); self.assertEqual((g["audited_status"], g["delivery_state"]), ("UNRESOLVED", "verified_version"))
        self.assertEqual(g["audit"]["complete"], False)

    def test_the_cli_status_reports_the_audited_status_and_the_delivery_separately(self):
        t = self.session(); js, path = self.written(t, self.raw(t, [self.check(t, "w1", "session_end")]))
        code, out = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", path, "--cwd", self.d]); o = json.loads(out)
        self.assertEqual((code, o["delivery_state"], o["audited_status"]), (0, "verified_version", "UNRESOLVED")); self.assertFalse(o["audit"]["complete"])
        t2 = self.session(); js, path = self.written(t2, self.full(t2))
        code, out = cli("versions.py", ["status", "--session", t2.log, "--file", t2.note, "--report", path, "--cwd", self.d]); o = json.loads(out)
        self.assertEqual((code, o["delivery_state"], o["audited_status"]), (0, "verified_version", "PASS")); self.assertTrue(o["audit"]["complete"])

    def test_a_genuinely_complete_audit_passes_on_every_surface(self):
        t = self.session(); js, g = self.passes(t, self.full(t))
        self.assertEqual(js["delivery"]["delivery_state"], "verified_version"); self.assertEqual(js["binding_summary"]["audit"]["evaluations"], 1)

    def test_the_audit_derived_from_the_source_is_the_one_that_passes_and_a_hand_edited_status_never_does(self):
        t = self.session(); js, path = self.written(t, self.raw(t, [self.check(t, "w1", "session_end")]))      # UNRESOLVED, audit incomplete
        forged = dict(js, status="PASS"); g = self.gate(t, forged)
        self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("stored report status 'PASS' differs from the recomputed 'UNRESOLVED'", " ".join(g["reasons"]))
        done = dict(js, audit=dict(version=1, evaluations=[], note="reviewed"), coverage=dict(complete=True), scope_audit=dict(valid=0, invalid=0), binding_summary=dict(js["binding_summary"], audit=dict(js["binding_summary"]["audit"], complete=True)))      # nothing the report says about itself is evidence
        self.assertEqual(self.gate(t, dict(done, status="PASS"))["audited_status"], "UNRESOLVED")

    def test_structural_failures_fail_closed_without_a_crash_and_the_writer_and_the_gate_agree(self):
        t = self.session(); base = self.full(t)
        for name, edit in (("audit is a string", lambda d: d.update(audit="done")), ("audit is a list", lambda d: d.update(audit=[])), ("audit has no version", lambda d: d["audit"].pop("version")),
                           ("audit.version is 2", lambda d: d["audit"].update(version=2)), ("evaluations is not a list", lambda d: d["audit"].update(evaluations={})), ("evaluations holds a string", lambda d: d["audit"].update(evaluations=["x"])),
                           ("audit.max_chars is bad", lambda d: d["audit"].update(max_chars="9000")), ("audit.max_chars is tiny", lambda d: d["audit"].update(max_chars=5)), ("audit.registry is a number", lambda d: d["audit"].update(registry=7)),
                           ("work_locations is a string", lambda d: d.update(work_locations="x")), ("no audit at all", lambda d: d.pop("audit"))):
            with self.subTest(name):
                d = copy.deepcopy(base); edit(d); js, g = self.blocked(t, d, "structure")
                self.assertTrue(js["binding_summary"]["audit"]["reasons"])

class ChunkReview(Base):
    """Six chunks (audit.max_chars 200): the expected set is derived from the source, the report's own list cannot redefine it."""
    def setUp(self):
        super().setUp(); self.t = self.session(n=6); self.base = self.full(self.t, max_chars=200)
    def test_the_control_review_passes(self):
        self.assertEqual(len(self.base["audit"]["evaluations"][0]["chunks"]), 6); self.passes(self.t, self.base)
    def test_a_missing_chunk_review_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"].pop(3)), "chunks_missing")
    def test_a_chunk_list_cut_to_the_first_chunk_does_not_redefine_the_expected_set(self): self.blocked(self.t, mutated(self.base, lambda e: e.update(chunks=e["chunks"][:1])), "chunks_missing")
    def test_a_duplicate_review_record_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"].append(dict(e["chunks"][2]))), "chunks_duplicate")
    def test_a_stale_sha256_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"][1].update(sha256="0" * 64)), "chunks_stale")
    def test_a_chunk_not_marked_reviewed_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"][4].update(reviewed=False)), "chunks_unreviewed")
    def test_reviewed_as_a_string_is_not_a_review(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"][4].update(reviewed="true")), "chunks_unreviewed")
    def test_a_review_of_two_categories_only_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: [c.update(categories=[2, 9]) for c in e["chunks"]]), "chunks_partial_categories")
    def test_nine_entries_that_are_not_the_nine_categories_block(self): self.blocked(self.t, mutated(self.base, lambda e: e["chunks"][0].update(categories=[1] * 9)), "chunks_partial_categories")
    def test_a_record_for_a_chunk_that_does_not_exist_blocks(self):
        js, g = self.blocked(self.t, mutated(self.base, lambda e: e["chunks"].append(dict(e["chunks"][0], index=99))), "structure")
    def test_complete_true_without_a_review_blocks(self):
        def edit(e): e["complete"] = True; [c.update(reviewed=False, categories=[]) for c in e["chunks"]]
        d = mutated(self.base, edit); d["coverage"] = dict(complete=True); d["audit"]["complete"] = True
        js, g = self.blocked(self.t, d, "chunks_unreviewed"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["chunks_unreviewed"], 6)
    def test_the_unreviewed_template_is_work_not_a_review(self):
        plan = A.plan_of(self.t.log, self.t.note, 200); k = A.key_from_dict(dict(write_tool_use_id="w1", sha256=versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"], evaluated_against="session_end"))
        tpl = A.block_template(plan, k); self.assertTrue(all(c["reviewed"] is False and c["categories"] == [] for c in tpl["chunks"])); self.assertTrue(all(c["outcome"] is None for c in tpl["categories"]))
        d = copy.deepcopy(self.base); d["audit"]["evaluations"] = [tpl]; self.blocked(self.t, d, "chunks_unreviewed")
    def test_another_max_chars_than_the_one_declared_makes_the_review_stale_and_fails_closed(self):
        d = copy.deepcopy(self.base); d["audit"]["max_chars"] = 9000; js, g = self.blocked(self.t, d, "chunks_stale")      # one chunk is expected at 9000: its text is not the one the 200-char record hashed
        self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["chunks_stale"], 1); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["structure"], 5)      # and five records describe chunks that do not exist
    def test_the_audit_chunk_hashes_are_the_ones_prepare_writes(self):
        """Independent of the fixture helper: the sha256 the audit expects for every chunk is the sha256 of the chunk file that the prepare.py CLI writes, and of the chunk_list of its coverage.json."""
        work = os.path.join(self.d, "work")
        code, out = cli("prepare.py", [self.t.log, "--cwd", self.d, "--out", work, "--max-chars", "200"]); self.assertEqual(code, 0, out)
        cov = json.load(open(os.path.join(work, "coverage.json"), encoding="utf-8")); plan = A.plan_of(self.t.log, self.t.note, 200)
        import hashlib
        self.assertEqual([(c["index"], c["sha256"]) for c in plan["chunks"]], [(c["index"], c["sha256"]) for c in cov["chunk_list"]])
        for c in cov["chunk_list"]: self.assertEqual(c["sha256"], hashlib.sha256(open(os.path.join(work, c["file"]), "rb").read()).hexdigest())
        self.assertNotIn(self.t.log, json.dumps(cov["chunk_list"]))

class Categories(Base):
    def setUp(self):
        super().setUp(); self.t = self.session(n=2); self.base = self.full(self.t)
    def cat(self, c, **kw): return lambda e: [r.update(kw) for r in e["categories"] if r["category"] == c]
    def test_a_missing_category_record_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["categories"].pop(4)), "categories")
    def test_a_shortlist_of_two_categories_blocks(self):
        js, g = self.blocked(self.t, mutated(self.base, lambda e: e.update(categories=[r for r in e["categories"] if r["category"] in (2, 9)])), "categories"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 7)
    def test_a_category_without_an_explicit_outcome_blocks(self): self.blocked(self.t, mutated(self.base, self.cat(3, outcome=None)), "categories")
    def test_a_reviewed_boolean_is_not_an_outcome(self): self.blocked(self.t, mutated(self.base, self.cat(3, outcome="reviewed")), "categories")
    def test_a_duplicate_category_record_blocks(self): self.blocked(self.t, mutated(self.base, lambda e: e["categories"].append(dict(e["categories"][0]))), "categories")
    def test_not_applicable_needs_a_basis_grounded_in_an_expected_chunk(self):
        for name, basis in (("no basis", None), ("a quote that is not in the chunk", dict(uuid="u1", quote="a sentence nobody wrote")), ("a uuid that does not exist", dict(uuid="u999", quote="request number 0")), ("a blank quote", dict(uuid="u1", quote=" "))):
            with self.subTest(name):
                def edit(ev, basis=basis):
                    for r in ev["categories"]:
                        if r["category"] == 6: r.pop("basis", None); r["outcome"] = "not_applicable"; r.update(basis=basis) if basis else None
                self.blocked(self.t, mutated(self.base, edit), "categories")
    def test_not_applicable_with_a_source_grounded_basis_is_accepted(self):
        self.passes(self.t, mutated(self.base, self.cat(6, outcome="not_applicable", basis=dict(uuid="u1", quote="request number 0"))))
    def test_no_candidate_is_accepted_when_nothing_is_registered(self): self.passes(self.t, mutated(self.base, self.cat(5, outcome="no_candidate")))
    def test_an_unknown_outcome_blocks(self): self.blocked(self.t, mutated(self.base, self.cat(5, outcome="done")), "categories")

class Registry(Base):
    """Candidates are registered BEFORE the scope filter (audit.py register); each one needs an independently derived disposition."""
    def retro(self, text=V1, verdict="verified"):
        """A source session that holds the user's QUOTE before the write w1, and a calls log of another session (ABSENCE-first pair or a present check) -> (t, calls log, ref)."""
        t = RB.Tx(self.d); t.user(QUOTE); t.write("w1", text); t.save(); open(t.note, "w").write(text)
        v = versions.versions_of(t.log, t.note)[0][0]; return t, os.path.join(self.d, "calls.jsonl"), versions.version_ref(v, "prefix")
    def calls(self, path, *calls):
        c = RB.Tx(self.d)
        for tid, claim, evidence, body in calls: c.tool(tid, "mcp__jev__jev_verify", dict(claims=[claim], evidence=[dict(text=evidence)]), body)
        for r in c.recs: r["sessionId"] = "calls-session"
        c.log = path; c.save()
    def present(self, t, calls, ref, text=V1):
        ac = omissions.claims(DETAIL, "R04")[1]
        self.calls(calls, ("a1", ac, omissions.material(text), CF.verify_body([dict(claim=ac, verdict="verified", confidence=0.99)], compatible_synthetic=True)))
        return [dict(id="abs", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="a1", result_index=0, key=ac), version_ref=ref)]
    def pair(self, t, calls, ref, text=V1):
        sc, ac = omissions.claims(DETAIL, "R04")
        self.calls(calls, ("a1", ac, omissions.material(text), json.dumps(dict(subject_at=0.5, results=[dict(claim=ac, verdict="unsupported", confidence=0.99, action="auto")]))),
                   ("s1", sc, QUOTE, CF.verify_body([dict(claim=sc, verdict="verified", confidence=0.99)], compatible_synthetic=True)))
        checks = [dict(id="abs", tool="verify", verdict="unsupported", confidence=0.99, jev_ref=dict(tool_use_id="a1", result_index=0, key=ac), version_ref=ref),
                  dict(id="src", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="s1", result_index=0, key=sc), version_ref=ref)]
        f = dict(type="lost_detail", check_id="abs", claim=ac, confidence=0.99, quote_source=QUOTE, quote_handoff=None, uuid="u1", category="omission", omission_ref=dict(detail=DETAIL, source_check_id="src"))
        return checks, [f]
    def doc(self, t, checks, findings=(), details=(DETAIL,), **kw):
        return AF.complete(dict(self.raw(t, checks), findings=list(findings)), details=list(details), **kw)

    def test_a_registered_candidate_without_a_disposition_blocks(self):
        t, calls, ref = self.retro()      # the present check is about DETAIL; the registered candidate is ANOTHER detail that nothing accounts for
        js, g = self.blocked(t, self.doc(t, self.present(t, calls, ref), details=[OTHER]), "candidates_unaccounted", calls=calls)
        self.assertIn("registered candidate", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_present_check_with_the_exact_material_accounts_for_the_candidate_and_the_report_passes(self):
        t, calls, ref = self.retro(); self.passes(t, self.doc(t, self.present(t, calls, ref)), calls)

    def test_a_present_check_with_other_material_does_not_account_for_it(self):
        t, calls, ref = self.retro(); checks = self.present(t, calls, ref, text="# Handoff\n- some other note\n")      # the material is the one of a DIFFERENT note
        self.blocked(t, self.doc(t, checks), "candidates_unaccounted", calls=calls)

    def test_a_present_check_below_the_threshold_does_not_account_for_it(self):
        t, calls, ref = self.retro(); ac = omissions.claims(DETAIL, "R04")[1]
        self.calls(calls, ("a1", ac, omissions.material(V1), CF.verify_body([dict(claim=ac, verdict="verified", confidence=0.9)], compatible_synthetic=True)))
        self.blocked(t, self.doc(t, [dict(id="abs", tool="verify", verdict="verified", confidence=0.9, jev_ref=dict(tool_use_id="a1", result_index=0, key=ac), version_ref=ref)]), "candidates_unaccounted", calls=calls)

    def test_a_model_written_disposition_label_never_clears_a_candidate(self):
        t, calls, ref = self.retro(); checks = self.present(t, calls, ref, text="# other\n"); doc = self.doc(t, checks)
        doc["audit"]["evaluations"][0]["dispositions"] = [dict(candidate=x["id"], disposition="present") for x in json.load(open(self.reg(t)))["candidates"]]
        doc["audit"]["evaluations"][0]["cleared"] = True; doc["checks"][0]["disposition"] = "present"; doc["unresolved"] = []
        self.blocked(t, doc, "candidates_unaccounted", calls=calls)

    def test_a_confirmed_omission_accounts_for_the_candidate_and_keeps_fail_with_a_complete_audit(self):
        t, calls, ref = self.retro(); checks, fs = self.pair(t, calls, ref); doc = self.doc(t, checks, fs, scope_exclusions=[])
        js, path = self.written(t, doc, calls); self.assertEqual(js["status"], "FAIL", js["binding_summary"]["reasons"]); self.assertTrue(js["binding_summary"]["audit"]["complete"])
        self.assertEqual(js["binding_summary"]["audit"]["unfinished"], {})

    def test_fail_keeps_its_precedence_while_the_unfinished_work_stays_counted(self):
        t, calls, ref = self.retro(); checks, fs = self.pair(t, calls, ref); doc = self.doc(t, checks, fs)
        A.register(self.reg(t), A.D.canon(t.log), A.key_from_dict(dict(write_tool_use_id="w1", sha256=ref["sha256"], evaluated_against="prefix")), "Another detail nobody accounted for", 4)
        doc["audit"]["evaluations"][0]["categories"][3] = dict(category=4, outcome="no_candidate")
        js, path = self.written(t, doc, calls); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "FAIL"); self.assertFalse(au["complete"]); self.assertEqual(au["unfinished"]["candidates_unaccounted"], 1); self.assertGreaterEqual(au["unfinished"]["categories"], 1)
        self.assertNotIn("audit incomplete", " ".join(js["binding_summary"]["reasons"]))      # nothing was downgraded: only a PASS is capped

    def test_a_dropped_candidate_in_a_category_that_says_no_candidate_blocks(self):
        t, calls, ref = self.retro(); doc = self.doc(t, self.present(t, calls, ref)); doc["audit"]["evaluations"][0]["categories"][1] = dict(category=2, outcome="no_candidate")      # the registered candidate belongs to category 2
        self.blocked(t, doc, "categories", calls=calls)

    def test_explicit_unresolved_work_is_counted_and_never_passes(self):
        t, calls, ref = self.retro(); doc = self.doc(t, self.present(t, calls, ref), details=[OTHER]); cid = json.load(open(self.reg(t)))["candidates"][0]["id"]
        doc["audit"]["evaluations"][0]["unresolved"] = [dict(candidate=cid)]
        js, g = self.blocked(t, doc, "candidates_unresolved", calls=calls); self.assertNotIn("candidates_unaccounted", js["binding_summary"]["audit"]["unfinished"])
        self.assertIn("declared unresolved work", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_malformed_or_foreign_registry_is_refused_not_repaired(self):
        t, calls, ref = self.retro(); doc = self.doc(t, self.present(t, calls, ref)); self.passes(t, doc, calls)
        p = self.reg(t); open(p, "w").write("{not json"); self.blocked(t, doc, "candidates_unaccounted", calls=calls)
        reg = A.empty_registry("/elsewhere/session.jsonl"); json.dump(reg, open(p, "w")); self.blocked(t, doc, "candidates_unaccounted", calls=calls)
        c = dict(id="0" * 16, evaluation=None, category=None, detail_sha256="a" * 64, detail=None, quote_sha256=None); json.dump(dict(A.empty_registry(A.D.canon(t.log)), candidates=[c]), open(p, "w")); self.blocked(t, doc, "candidates_unaccounted", calls=calls)

    def test_the_registry_never_drops_a_registered_candidate(self):
        t, calls, ref = self.retro(); k = A.key_from_dict(dict(write_tool_use_id="w1", sha256=ref["sha256"], evaluated_against="prefix")); src = A.D.canon(t.log); p = self.reg(t)
        c, added = A.register(p, src, k, DETAIL, 2); self.assertTrue(added); self.assertFalse(A.register(p, src, k, "  never   deploy on FRIDAY"[:0] + DETAIL, 2)[1])
        doc = json.load(open(p)); doc["candidates"] = []
        with self.assertRaises(ValueError): A.save_registry(p, doc)
        self.assertEqual([x["id"] for x in A.load_registry(p)[0]["candidates"]], [c["id"]])
        doc = json.load(open(p)); doc["established"] = []
        with self.assertRaises(ValueError): A.save_registry(p, doc)      # nor an established evaluation
        doc = json.load(open(p)); doc["ledgers"] = []; A.associate_ledger(p, src, os.path.join(self.d, "l.json"))
        with self.assertRaises(ValueError): A.save_registry(p, doc)      # nor a ledger association
        with self.assertRaises(ValueError): A.register(p, "/another/session.jsonl", k, "x y z", 1)

    def test_a_detail_with_a_secret_is_registered_by_hash_only_and_can_never_be_cleared(self):
        secret = "API_KEY=" + "Zq8fLm3Xv9" + "QpRt"; t, calls, ref = self.retro(); k = A.key_from_dict(dict(write_tool_use_id="w1", sha256=ref["sha256"], evaluated_against="prefix"))
        c, _ = A.register(self.reg(t), A.D.canon(t.log), k, "rotate " + secret, 3); self.assertIsNone(c["detail"]); self.assertNotIn(secret, open(self.reg(t)).read())
        doc = AF.complete(self.raw(t, self.present(t, calls, ref)))      # the present check is about another detail
        self.blocked(t, doc, "candidates_unaccounted", calls=calls)

class Exclusions(Base):
    """A candidate registered BEFORE the scope filter is accounted for only by an exclusion that scope.validate_exclusions re-derives from the real jev_classify call."""
    def scoped(self):
        t = RB.Tx(self.d); t.user("request A"); t.write("w1", V1); t.verify(); t.user("request B"); t.write("w2", V2); t.save()
        scope._MEMO.clear(); ctx = scope.scope_of(t.log, "w1", "prefix")[0]; self.assertIsNotNone(ctx)
        t.tool("k1", "mcp__jev__jev_classify", SF.payload(ctx), SF.classify_result(SF.ROWS)); t.save(); scope._MEMO.clear(); omissions._MEMO.clear(); open(t.note, "w").write(V2); return t
    def doc(self, t, exclusions, register=True, **kw):
        return AF.complete(self.raw(t, [self.check(t, "w1", "prefix")], raw=dict(scope_exclusions=exclusions)), details=[SF.DETAILS[0]] if register else (), scope_exclusions=exclusions, **kw)

    def test_a_valid_exclusion_accounts_for_the_registered_candidate(self):
        t = self.scoped(); doc = self.doc(t, [SF.excl(0)]); js, path = self.written(t, doc)
        self.assertEqual((js["scope_audit"]["valid"], js["scope_audit"]["invalid"]), (1, 0)); self.assertEqual(js["status"], "PASS", js["binding_summary"]["reasons"]); self.assertTrue(js["binding_summary"]["audit"]["complete"])
        self.assertNotIn("audit incomplete", " ".join(js["binding_summary"]["reasons"]))      # (the delivery gate judges the LATEST write, w2: this report is about w1, so only the writer certifies it)

    def test_the_same_candidate_with_no_exclusion_is_unaccounted(self):
        t = self.scoped(); js, path = self.written(t, self.doc(t, [])); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(au["unfinished"]["candidates_unaccounted"], 1)

    def test_an_invalid_exclusion_does_not_account_and_is_counted(self):
        t = self.scoped()
        for name, e in (("confidence below 0.99", SF.excl(0, conf=0.5)), ("wrong classification", SF.excl(0, cls="in_scope")), ("a call that does not exist", SF.excl(0, tid="nope"))):
            with self.subTest(name):
                js, path = self.written(t, self.doc(t, [e])); au = js["binding_summary"]["audit"]
                self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(js["scope_audit"]["invalid"], 1); self.assertEqual(au["unfinished"]["scope"], 1); self.assertGreaterEqual(au["unfinished"].get("candidates_unaccounted", 0), 1)
                self.assertIn("invalid scope exclusions: 1", " ".join(js["binding_summary"]["reasons"]))

    def test_missing_scope_exclusions_is_missing_accounting_but_an_empty_list_is_valid(self):
        t = self.session(); doc = self.full(t)
        missing = copy.deepcopy(doc); missing.pop("scope_exclusions"); js, g = self.blocked(t, missing, "scope"); self.assertIn("scope_exclusions is missing", " ".join(js["binding_summary"]["audit"]["reasons"]))
        for bad in (None, "none", {}, 0): d = copy.deepcopy(doc); d["scope_exclusions"] = bad; self.blocked(t, d, "scope")
        d = copy.deepcopy(doc); d["scope_exclusions"] = []; self.passes(t, d)

    def test_an_exclusion_of_a_detail_nobody_registered_does_not_hide_the_registered_one(self):
        t = self.scoped(); js, path = self.written(t, self.doc(t, [SF.excl(1)])); self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["candidates_unaccounted"], 1)

class LedgerObligations(Base):
    """The omission ledger's rows count whatever their state: a valid, an unavailable and an invalidated obligation are unfinished work until a derived disposition accounts for them (the ledger is not reduced to its `resume` rows that are valid)."""
    def setUp(self):
        super().setUp(); self.ledger = os.path.join(self.d, "ledger.json")
        self.t = RB.Tx(self.d); self.t.user("intro"); self.t.user(Q1); self.t.user(Q2); self.t.write("w1", V1); self.t.verify(); self.t.save(); open(self.t.note, "w").write(V1)
    def batch(self, *items):
        spec = [dict(dict(detail=q, source_quote=q, write_id="w1", evaluated_against="prefix"), **i) for q, i in items]
        code, out = cli("omissions.py", ["prepare-batch", "--source", self.t.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", self.ledger], self.d, json.dumps(spec)); return code, out
    def doc(self, **kw): return AF.complete(self.raw(self.t, [self.check(self.t, "w1", "prefix")]), ledger=self.ledger, **kw)

    def test_a_valid_prepared_obligation_is_unfinished_until_accounted(self):
        self.assertEqual(self.batch((Q1, {}))[0], 0); self.assertEqual([r["state"] for r in json.load(open(self.ledger))["obligations"]], ["prepared"])
        js, g = self.blocked(self.t, self.doc(), "candidates_unaccounted"); self.assertIn("ledger:prepared", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_an_unavailable_obligation_still_counts(self):
        self.assertEqual(self.batch((Q1, {}), ("a detail that is not in the transcript", {}))[0], 3); self.assertEqual([r["state"] for r in json.load(open(self.ledger))["obligations"]], ["prepared", "unavailable"])
        js, g = self.blocked(self.t, self.doc(), "candidates_unaccounted"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["candidates_unaccounted"], 2)
        self.assertIn("ledger:unavailable", " ".join(A.ledger_candidates(self.ledger, ("w1", versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"], "prefix", None), os.path.realpath(self.t.note))[0][i]["origin"] for i in (0, 1)))

    def test_an_invalidated_obligation_still_counts(self):
        self.assertEqual(self.batch((Q1, {}))[0], 0)
        s = open(self.t.log, "rb").read(); st = os.stat(self.t.log); open(self.t.log, "wb").write(s.replace(b"intro", b"INTRO")); os.utime(self.t.log, ns=(st.st_atime_ns, st.st_mtime_ns))
        code, out = cli("omissions.py", ["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual([r["state"] for r in json.loads(out)["obligations"]], ["invalidated"])
        rows = A.ledger_candidates(self.ledger, ("w1", versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"], "prefix", None), os.path.realpath(self.t.note))[0]; self.assertEqual(len(rows), 1)
        t = self.t; omissions.reset_caches(); A._PLANS.clear()
        js, g = self.blocked(t, self.doc(), "candidates_unaccounted")

    def test_a_ledger_row_of_another_write_mode_or_hash_is_isolated(self):
        self.assertEqual(self.batch((Q1, {}))[0], 0); k = lambda w, m, s=None: (w, s or versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"], m, None); n = os.path.realpath(self.t.note)
        self.assertEqual(len(A.ledger_candidates(self.ledger, k("w1", "prefix"), n)[0]), 1)
        self.assertEqual(A.ledger_candidates(self.ledger, k("w1", "session_end"), n)[0], []); self.assertEqual(A.ledger_candidates(self.ledger, k("w2", "prefix"), n)[0], []); self.assertEqual(A.ledger_candidates(self.ledger, k("w1", "prefix", "f" * 64), n)[0], [])
        self.assertEqual(A.ledger_candidates(self.ledger, A.GLOBAL, n)[0], [])

    def test_a_withheld_write_id_applies_to_every_evaluation(self):
        """An obligation whose write id is withheld (a secret-looking id kept by hash only) cannot be shown inapplicable: it counts for every evaluation."""
        self.assertEqual(self.batch((Q1, {}))[0], 0); d = json.load(open(self.ledger)); sha = versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"]; n = os.path.realpath(self.t.note)
        r = d["obligations"][0]; r["identity"]["write_id"] = L._withheld("secret-id-xxxxxxxx"); r["id"] = L.obligation_id(r["identity"]); json.dump(d, open(self.ledger, "w"))
        for k in (("w1", sha, "prefix", None), ("w1", sha, "session_end", None), ("w7", "f" * 64, "prefix", None)):
            rows, why = A.ledger_candidates(self.ledger, k, n); self.assertIsNone(why); self.assertEqual(len(rows), 1, k)

    def test_an_unusable_ledger_is_unfinished_work_not_a_pass(self):
        open(self.ledger, "w").write("{bad"); js, g = self.blocked(self.t, self.doc(), "candidates_unaccounted"); self.assertIn("ledger is unusable", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_the_progress_ledger_never_claims_coverage(self):
        self.assertEqual(self.batch((Q1, {}))[0], 0); self.assertFalse(json.load(open(self.ledger)).get("audit", {}).get("complete", False))

class Isolation(Base):
    """Equal-byte writes, the two modes and the runs of a write share no check, disposition or review."""
    def two_writes(self):
        """w1 and w2 write the SAME bytes; each has its own verify call (c1 follows w1, c2 follows w2)."""
        t = RB.Tx(self.d); t.user("req"); t.write("w1", V1); t.run("r1"); t.verify("c1"); t.write("w2", V1); t.run("r2"); t.verify("c2"); t.save(); open(t.note, "w").write(V1); return t
    def test_a_review_of_one_write_does_not_serve_an_equal_byte_write(self):
        t = self.two_writes(); self.assertEqual(versions.versions_of(t.log, t.note)[0][0]["sha256"], versions.versions_of(t.log, t.note)[0][1]["sha256"])
        for_w1 = self.full(t, [self.at(t, "w1", "prefix", "c1")]); self.passes_report_only(t, for_w1); for_w2 = copy.deepcopy(for_w1); for_w2["checks"] = [self.at(t, "w2", "prefix", "c2")]
        js, path = self.written(t, for_w2); self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["evaluations"], 1)      # the audit block names w1: w2 has none of its own
        self.assertIn("0 audit blocks", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_candidate_registered_for_one_equal_byte_write_does_not_block_the_other(self):
        t = self.two_writes(); reg = self.reg(t); sha = versions.versions_of(t.log, t.note)[0][0]["sha256"]
        A.register(reg, A.D.canon(t.log), ("w1", sha, "prefix", None), "Never deploy on friday", 2)
        w2 = AF.complete(self.raw(t, [self.at(t, "w2", "prefix", "c2")])); self.passes(t, w2)      # registered for w1 only: not applicable to w2
        w1 = AF.complete(self.raw(t, [self.at(t, "w1", "prefix", "c1")]))
        js, path = self.written(t, w1); self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["candidates_unaccounted"], 1)

    def test_a_candidate_of_one_mode_does_not_apply_to_the_other_mode(self):
        t = self.session(); t.verify("c2"); t.save(); reg = self.reg(t); sha = versions.versions_of(t.log, t.note)[0][0]["sha256"]; A.register(reg, A.D.canon(t.log), ("w1", sha, "prefix", None), "Never deploy on friday", 2)
        self.passes(t, AF.complete(self.raw(t, [self.check(t, "w1", "session_end")])))
        js, path = self.written(t, AF.complete(self.raw(t, [self.check(t, "w1", "prefix")]))); self.assertEqual(js["status"], "UNRESOLVED")
        both = AF.complete(self.raw(t, [self.at(t, "w1", "prefix"), self.at(t, "w1", "session_end", "c2", "p2")])); both["audit"]["evaluations"] = [e for e in both["audit"]["evaluations"] if e["evaluation"]["evaluated_against"] == "session_end"]
        js, path = self.written(t, both); self.assertEqual(js["status"], "UNRESOLVED"); self.assertIn("0 audit blocks", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_block_of_one_run_does_not_serve_another_run(self):
        t = RB.Tx(self.d); t.user("req"); t.write("w1", V1); t.run("r1"); t.user("again"); t.run("r2"); t.verify(); t.save(); open(t.note, "w").write(V1)
        r1 = self.full(t, [self.check(t, "w1", "session_end", run="r1")]); self.passes(t, r1)
        r2 = copy.deepcopy(r1); r2["checks"] = [self.check(t, "w1", "session_end", run="r2")]
        js, g = self.blocked(t, r2, "evaluations"); self.assertIn("0 audit blocks", " ".join(js["binding_summary"]["audit"]["reasons"]))
        reg = self.reg(t); sha = versions.versions_of(t.log, t.note)[0][0]["sha256"]; A.register(reg, A.D.canon(t.log), ("w1", sha, "session_end", "r1"), "Never deploy on friday", 2)
        self.passes(t, AF.complete(self.raw(t, [self.check(t, "w1", "session_end", run="r2")])))      # registered for run r1 only
        js, path = self.written(t, AF.complete(self.raw(t, [self.check(t, "w1", "session_end", run="r1")]))); self.assertEqual(js["status"], "UNRESOLVED")

class PerVersion(Base):
    """versions.per_version: the write-level summary and EVERY evaluation summary go through the same audit; without a context nothing can be audited."""
    def setUp(self):
        super().setUp(); self.t = self.session(); self.t.verify("c2"); self.t.save(); self.checks = [self.at(self.t, "w1", "prefix", "c1"), self.at(self.t, "w1", "session_end", "c2", "p2")]
    def declared(self): return IW.VROW(versions.versions_of(self.t.log, self.t.note)[0][0], 1, "prefix")      # a declared handoff.versions row as the schema requires it
    def doc(self, **kw):
        d = self.full(self.t, self.checks, **kw); d["handoff"]["versions"] = [self.declared()]; return d
    def entry(self, doc):
        js, path = self.written(self.t, doc); return js, js["handoff"]["versions"][0]

    def test_complete_audits_pass_at_every_level(self):
        js, v = self.entry(self.doc()); self.assertEqual(js["status"], "PASS")
        self.assertEqual((v["audited_status"], v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("PASS", "PASS", "PASS"))
        for e in (v, v["evaluations"]["prefix"], v["evaluations"]["session_end"]): self.assertTrue(e["binding_summary"]["audit"]["complete"])

    def test_a_missing_evaluation_block_caps_the_write_summary_and_only_that_evaluation(self):
        d = self.doc(); d["audit"]["evaluations"] = [e for e in d["audit"]["evaluations"] if e["evaluation"]["evaluated_against"] == "prefix"]
        js, v = self.entry(d)
        self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(v["audited_status"], "UNRESOLVED")
        self.assertEqual((v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("PASS", "UNRESOLVED"))      # the prefix evaluation is complete on its own
        self.assertFalse(v["evaluations"]["session_end"]["binding_summary"]["audit"]["complete"]); self.assertTrue(v["evaluations"]["prefix"]["binding_summary"]["audit"]["complete"])

    def test_a_stale_chunk_in_one_evaluation_caps_that_evaluation(self):
        d = self.doc()
        for e in d["audit"]["evaluations"]:
            if e["evaluation"]["evaluated_against"] == "session_end": e["chunks"][0]["sha256"] = "1" * 64
        js, v = self.entry(d); self.assertEqual((v["audited_status"], v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("UNRESOLVED", "PASS", "UNRESOLVED"))

    def test_a_confirmed_defect_keeps_fail_in_the_summaries(self):
        d = self.doc(); d["checks"][0] = dict(d["checks"][0], tool="verify", verdict="contradicted"); d["audit"]["evaluations"] = []
        js, v = self.entry(d); self.assertNotEqual(js["status"], "PASS"); self.assertNotEqual(v["audited_status"], "PASS")

    def test_without_an_audit_context_a_pass_is_capped_and_a_context_lifts_it_only_when_complete(self):
        calls = jevref.load_calls(self.t.log); bs = jevref.bind(self.checks, calls, "R04"); rows = versions.bind_versions(self.checks, bs, self.t.note, self.t.log, calls, True); bs = versions.attach(bs, rows)
        bs = jevref.finalize(bs, [], None, "R04"); pv = versions.per_version(self.checks, bs, [], [], [self.declared()], "R04")
        e = pv["w1"]; self.assertEqual(e["audited_status"], "UNRESOLVED"); self.assertFalse(e["binding_summary"]["audit"]["complete"]); self.assertIn("no audit context", e["binding_summary"]["audit"]["reasons"][0])
        self.assertTrue(all(x["audited_status"] == "UNRESOLVED" for x in e["evaluations"].values()))
        doc = self.doc(); ctx = A.Context(doc, self.checks, bs, calls, self.t.log, self.t.note, None, True, True, "R04")
        pv = versions.per_version(self.checks, bs, [], [], [self.declared()], "R04", ctx); self.assertEqual((pv["w1"]["audited_status"], pv["w1"]["evaluations"]["prefix"]["audited_status"]), ("PASS", "PASS"))

class NonCertifyingHelper(Base):
    def test_the_historical_low_level_status_is_marked_non_certifying(self):
        t = self.session(); doc = self.raw(t, [self.check(t, "w1", "session_end")]); checks = doc["checks"]
        calls = jevref.load_calls(t.log); bs = jevref.bind(checks, calls, "R04"); rows = versions.bind_versions(checks, bs, t.note, t.log, calls, True); bs = jevref.finalize(versions.attach(bs, rows), [], None, "R04")
        ev = jevref.audited_status(checks, bs, [], [], None, "R04"); self.assertEqual(ev["status"], "PASS"); self.assertIs(ev["certifying"], False)      # PASS here is a low-level answer: only audit.certify may turn it into a report status
        out = audit_cert(ev, A.Context(self.raw(t, checks), checks, bs, calls, t.log, t.note, None, True, True, "R04")); self.assertEqual(out["status"], "UNRESOLVED")
        self.assertEqual(A.no_context(ev)["status"], "UNRESOLVED"); self.assertEqual(A.no_context(dict(ev, status="FAIL"))["status"], "FAIL")

def audit_cert(ev, ctx): return A.certify(ev, ctx)

class Writers(Base):
    """The two recorded-transcript paths: the report names the very session whose calls log is used, or a retrospective report names a saved session and the calls live in another one."""
    def test_a_retrospective_report_is_audited_in_the_saved_session(self):
        r = Registry(); r.d = self.d
        t, calls, ref = r.retro(); doc = r.doc(t, r.present(t, calls, ref)); js, path = self.written(t, doc, calls)
        self.assertEqual(js["status"], "PASS"); self.assertFalse(js["binding_summary"]["version_identity"]["same_session"]); self.assertNotIn("delivery", js)      # a retrospective report never certifies a current delivery

    def test_a_calls_log_that_is_a_copy_of_the_same_session_is_audited_in_the_calls_log(self):
        t = self.session(n=2); copy_ = os.path.join(self.d, "copy.jsonl"); open(copy_, "w").write(open(t.log).read())
        doc = self.raw(t, [self.check(t, "w1", "session_end")]); doc["session"]["jsonl"] = copy_; doc = AF.complete(doc, source=copy_)
        js, path = self.written(t, doc, copy_); self.assertEqual(js["status"], "PASS", js["binding_summary"]["reasons"])

class SchemaMatchesRuntime(Base):
    """report.schema.json expresses the contract audit.py enforces (no jsonschema library: the constants and the shapes are compared)."""
    SCHEMA = json.load(open(os.path.join(HERE, "report.schema.json"), encoding="utf-8"))
    def test_audit_and_scope_exclusions_are_required_so_that_absence_means_never_pass(self):
        self.assertTrue({"audit", "scope_exclusions"} <= set(self.SCHEMA["required"])); self.assertIn("never PASS", self.SCHEMA["description"])
    def test_the_audit_block_has_the_runtime_constants(self):
        au = self.SCHEMA["properties"]["audit"]; ev = au["properties"]["evaluations"]["items"]["properties"]
        self.assertEqual(au["properties"]["version"]["const"], A.AUDIT_VERSION); self.assertEqual((au["properties"]["max_chars"]["minimum"], au["properties"]["max_chars"]["maximum"]), (200, 1000000))
        self.assertEqual({x for x in ev["categories"]["items"]["properties"]["outcome"]["enum"] if x}, set(A.OUTCOMES))
        self.assertEqual((ev["categories"]["minItems"], ev["categories"]["maxItems"], ev["chunks"]["items"]["properties"]["categories"]["maxItems"]), (len(A.CATEGORIES),) * 3)
        self.assertNotIn("minItems", ev["chunks"]["items"]["properties"]["categories"])      # an unreviewed template lists no category: the shorter list is unfinished work (chunks_partial_categories), not a malformed report
        self.assertEqual(set(ev["chunks"]["items"]["properties"]["basis"]["required"]), {"uuid", "quote"}); self.assertEqual(set(ev["categories"]["items"]["properties"]["basis"]["required"]), {"uuid", "quote"})
        self.assertEqual((ev["chunks"]["items"]["properties"]["categories"]["items"]["minimum"], ev["chunks"]["items"]["properties"]["categories"]["items"]["maximum"]), (min(A.CATEGORIES), max(A.CATEGORIES)))
        self.assertEqual(set(au["required"]), {"version", "evaluations"}); self.assertEqual(set(self.SCHEMA["properties"]["audit"]["properties"]["evaluations"]["items"]["required"]), {"evaluation", "chunks", "categories"})
    def test_a_derived_audit_block_only_uses_properties_the_schema_declares(self):
        t = self.session(n=2); doc = self.full(t); au = doc["audit"]; sch = self.SCHEMA["properties"]["audit"]
        self.assertLessEqual(set(au), set(sch["properties"])); self.assertTrue(set(sch["required"]) <= set(au))
        e, es = au["evaluations"][0], sch["properties"]["evaluations"]["items"]
        self.assertLessEqual(set(e), set(es["properties"])); self.assertTrue(set(es["required"]) <= set(e)); self.assertLessEqual(set(e["evaluation"]), set(es["properties"]["evaluation"]["properties"]))
        for c in e["chunks"]: self.assertLessEqual(set(c), set(es["properties"]["chunks"]["items"]["properties"])); self.assertTrue(set(es["properties"]["chunks"]["items"]["required"]) <= set(c))
        for c in e["categories"]: self.assertLessEqual(set(c), set(es["properties"]["categories"]["items"]["properties"])); self.assertTrue(set(es["properties"]["categories"]["items"]["required"]) <= set(c))
    def test_the_binding_summary_audit_matches_audit_summary(self):
        t = self.session(); js, path = self.written(t, self.full(t)); sm = self.SCHEMA["$defs"]["audit_summary"]; au = js["binding_summary"]["audit"]
        self.assertEqual(set(sm["required"]), set(au)); self.assertEqual(self.SCHEMA["properties"]["binding_summary"]["properties"]["audit"], {"$ref": "#/$defs/audit_summary"})
        js, path = self.written(t, self.raw(t, [self.check(t, "w1", "session_end")]))
        for k in js["binding_summary"]["audit"]["unfinished"]: self.assertIn(k, sm["properties"]["unfinished"]["description"])
        for k in dict(A.assess(A.Context({}, [], [], [], None, None, None, False, True, "R04"))["unfinished"]): self.assertIn(k, sm["properties"]["unfinished"]["description"])
    def test_the_gate_result_exposes_the_audit_beside_the_delivery_state(self):
        t = self.session(); js, path = self.written(t, self.full(t)); g = self.gate(t, js); self.assertIn("audit", g); self.assertEqual(set(g["audit"]), set(self.SCHEMA["$defs"]["audit_summary"]["required"]))
        g = versions.gate(t.log, t.note, None, disk_path=t.note); self.assertIn("audit", g); self.assertIsNone(g["audit"]); self.assertEqual(g["delivery_state"], "unresolved")      # an early exit exposes the key too

class VerificationHelper(Base):
    """audit.py is a script of the skill: running it is verification activity, never source (the same rule as checks.py / ledger.py), and its name outside the skill's directory is an ordinary command."""
    SCRIPTS = "/x/skills/handoff-verify/scripts"
    def recs(self, cmd):
        return [dict(type="user", message=dict(role="user", content="Never run migrate.sh against prod.")), dict(type="assistant", cwd="/work/proj", message=dict(role="assistant", content=[dict(type="tool_use", id="t1", name="Bash", input=dict(command=cmd))]))]
    def test_audit_py_is_a_verification_helper_for_the_session_end_cutoff(self):
        self.assertIn("audit.py", omissions.SKILL_SCRIPTS)
        for cmd in ("python3 -B %s/audit.py template --file n.md --write-id w1 --evaluated-against prefix" % self.SCRIPTS, "cd %s && python3 -c 'import audit; audit.plan_of(1, 2, 3)'" % self.SCRIPTS, "cd %s && python3 -m audit register" % self.SCRIPTS):
            self.assertEqual(omissions.verification_limit(self.recs(cmd)), 1, cmd)
        for cmd in ("python3 -B audit.py template", "python3 -c 'import audit'", "python3 -m audit register", "echo audit.py"):
            self.assertIsNone(omissions.verification_limit(self.recs(cmd)), cmd)

class Cli(Base):
    def test_register_and_template_print_the_work_and_never_a_review(self):
        t = self.session(n=3); reg = self.reg(t); base = ["--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", self.d]
        self.assertFalse(os.path.exists(reg))
        code, out = cli("audit.py", ["register", "--detail", "Never deploy on friday", "--category", "2", "--quote", QUOTE] + base); o = json.loads(out)
        self.assertEqual((code, o["ok"], o["registered"], o["category"], o["registry"]), (0, True, True, 2, reg)); cid = o["candidate"]
        code, out = cli("audit.py", ["register", "--detail", "never  deploy ON friday"] + base); self.assertEqual(json.loads(out)["registered"], True)      # another detail text (a different normalised string)
        code, out = cli("audit.py", ["register", "--detail", "Never deploy on friday"] + base); self.assertEqual((code, json.loads(out)["registered"]), (0, False))      # idempotent
        code, out = cli("audit.py", ["template"] + base); o = json.loads(out); self.assertEqual((code, o["ok"], o["registry"]), (0, True, reg))
        self.assertIn(cid, [c["id"] for c in o["expected_candidates"]]); self.assertTrue(all(c["reviewed"] is False for c in o["block"]["chunks"])); self.assertTrue(all(c["outcome"] is None for c in o["block"]["categories"]))
        self.assertEqual(o["block"]["evaluation"]["write_tool_use_id"], "w1"); self.assertIn("editable", o["limit"])
        d = self.full(t, [self.check(t, "w1", "prefix")]); d["audit"]["evaluations"] = [o["block"]]
        js, g = self.blocked(t, d, "chunks_unreviewed")      # the printed template, untouched, is unfinished work (and a valid report shape)
        self.assertEqual(g["delivery_state"], "verified_version")

    def test_template_associates_a_ledger_and_establishes_the_evaluation(self):
        t = self.session(); led = os.path.join(self.d, "ledger.json"); base = ["--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", self.d]
        code, out = cli("audit.py", ["template", "--ledger", led] + base); self.assertEqual(code, 0, out); reg = json.load(open(self.reg(t)))
        self.assertEqual(reg["ledgers"], [os.path.realpath(led)]); self.assertEqual(len(reg["established"]), 1); self.assertEqual(reg["established"][0]["write_tool_use_id"], "w1")

    def test_the_cli_refuses_what_it_cannot_demonstrate(self):
        t = self.session(); reg = self.reg(t); base = ["--source", t.log, "--file", t.note, "--evaluated-against", "prefix", "--cwd", self.d]
        code, out = cli("audit.py", ["register", "--write-id", "nope", "--detail", "x y"] + base); self.assertEqual((code, json.loads(out)["ok"]), (3, False)); self.assertFalse(os.path.exists(reg))
        code, out = cli("audit.py", ["register", "--write-id", "w1", "--detail", "   "] + base); self.assertEqual(code, 3)
        code, out = cli("audit.py", ["register", "--write-id", "w1", "--detail", "x y", "--registry", os.path.join(self.d, "mine.json")] + base); self.assertEqual(code, 3); self.assertIn("derived from the source", out)      # a registry path cannot be chosen
        self.assertFalse(os.path.exists(reg)); self.assertFalse(os.path.exists(os.path.join(self.d, "mine.json")))
        code, out = cli("audit.py", ["register", "--write-id", "w1", "--detail", "x y", "--registry", reg] + base); self.assertEqual((code, json.loads(out)["registry"]), (0, reg))      # naming the session's own is accepted
        open(reg, "w").write("{bad"); code, out = cli("audit.py", ["register", "--write-id", "w1", "--detail", "x z"] + base)
        self.assertEqual(code, 3); self.assertEqual(open(reg).read(), "{bad")      # nothing is written over a malformed registry

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline regressions of the council's fixes 1-4 and 6 on the mandatory audit (stdlib only, invented sessions, no Jev call, never reads .handoff-verify/). Each class names the bypass it closes and checks it on EVERY surface that certifies:
the report writer (report.write_report), the persisted report read back, the delivery gate (versions.gate), the CLI (`versions.py status`) and the per-version summaries (handoff.versions[]).
 - AccountingIsNotOptional: the registry and the ledgers of the SESSION are expected whatever the report names; omitting or substituting them, a missing / unestablished registry and an unreadable ledger never PASS, a genuinely established empty registry is a valid zero;
 - StructureComesFirst: a malformed report never crashes the writer, the gate or the CLI, certifies no delivery and keeps FAIL precedence; a tenth category record blocks the PASS; an authentic, structurally valid UNRESOLVED report still demonstrates verified_version;
 - TheWindowIsTheEvaluation: the expected chunks and the evidence are those of the window of THIS write / mode / run (omissions.source_window), a window boundary inside a chunk or a record is explicit;
 - ReviewIsGrounded: reviewed true + nine categories + ungrounded outcomes is not a review; a basis names a record and quotes THAT record; the category outcome lists exactly the registered candidates of the category;
 - EvaluationsAreCountedOnce: two checks of one evaluation are one evaluation at every level.
usage: python3 -B test_audit_fixes.py [-v]"""
import contextlib, copy, io, json, os, subprocess, sys, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, jevref, omissions, prepare, report, schema_check as SC, versions
import contract_fixtures as CF
import audit_fixtures as AF
import identity_world as IW
import test_audit as TA
import test_run_binding as RB

OTHER, DETAIL = TA.OTHER, TA.DETAIL

def cli(script, args, cwd=None, stdin=None): return TA.cli(script, args, cwd, stdin)

def inproc(module, argv, *args):
    """Run `module.main` IN THIS PROCESS with the given command line -> (exit code, stdout): the same code as the CLI, but visible to a profiler (test_caller_table's reach check)."""
    out = io.StringIO()
    with mock.patch.object(sys, "argv", [module.__name__ + ".py"] + list(argv)), contextlib.redirect_stdout(out): code = module.main(*args)
    return code, out.getvalue()

def hide(doc, category=2):
    """The review claims that `category` has no candidate (a grounded no_candidate copied from another category), although the registry holds one for it."""
    for e in doc["audit"]["evaluations"]:
        free = next(c for c in e["categories"] if c["category"] != category and c.get("basis"))
        for i, c in enumerate(e["categories"]):
            if c["category"] == category: e["categories"][i] = dict(free, category=category)
    return doc

class Surfaces(TA.Base):
    """The same report judged by the writer, the persisted file, the gate and the CLI."""
    def everywhere(self, t, doc, counter, status="UNRESOLVED", n=1, delivery="verified_version"):
        js, path = self.written(t, doc); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], status, js["binding_summary"]["reasons"]); self.assertFalse(au["complete"], au); self.assertGreaterEqual(au["unfinished"].get(counter, 0), n, au)
        again = json.load(open(path, encoding="utf-8")); self.assertEqual((again["status"], again["binding_summary"]["audit"]), (js["status"], au))      # the persisted report says the same
        g = self.gate(t, again); self.assertEqual(g["audited_status"], status, g["reasons"]); self.assertEqual(g["audit"]["unfinished"], au["unfinished"]); self.assertEqual(g["delivery_state"], delivery)
        code, out = cli("versions.py", ["status", "--session", t.log, "--file", t.note, "--report", path, "--cwd", self.d]); o = json.loads(out)
        self.assertEqual((o["audited_status"], o["delivery_state"]), (status, delivery)); self.assertEqual(o["audit"]["unfinished"], au["unfinished"]); self.assertEqual(code, 0 if delivery == "verified_version" else 3)
        return js, path

    def foreign(self, t, name="foreign", established=True):
        """A well-formed EMPTY registry of the very same source that is NOT the registry of the session."""
        p = os.path.join(self.d, name, "registry.json"); doc = A.empty_registry(A.D.canon(t.log))
        if established: doc["established"] = [A.dict_of(k) for k in AF.keys_of(self.base_doc)]
        A.save_registry(p, doc); return p

class AccountingIsNotOptional(Surfaces):
    def setUp(self):
        super().setUp(); self.t = self.session(); self.base_doc = self.raw(self.t, [self.check(self.t, "w1", "session_end")])
    def concealed(self, **kw): return hide(AF.complete(self.base_doc, details=[OTHER], **kw))

    def test_the_control_with_the_registry_named_is_unresolved_because_the_candidate_is_unaccounted(self):
        d = AF.complete(self.base_doc, details=[OTHER]); self.assertIn("registry", d["audit"]); self.everywhere(self.t, d, "candidates_unaccounted")

    def test_omitting_audit_registry_does_not_restore_the_pass(self):
        d = self.concealed(); d["audit"].pop("registry"); js, path = self.everywhere(self.t, d, "candidates_unaccounted")
        self.assertIn("registered candidate", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_an_empty_foreign_registry_does_not_replace_the_registry_of_the_session(self):
        d = self.concealed(); d["audit"]["registry"] = self.foreign(self.t); js, path = self.everywhere(self.t, d, "candidates_unaccounted")
        self.assertIn("substituted", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_an_unreadable_or_malformed_named_registry_is_substituted_accounting_too(self):
        for name, content in (("missing file", None), ("malformed", "{bad")):
            with self.subTest(name):
                d = self.concealed(); p = os.path.join(self.d, "x-" + name.replace(" ", "-")); d["audit"]["registry"] = p
                if content: open(p, "w").write(content)
                self.everywhere(self.t, d, "candidates_unaccounted")

    def test_the_session_registry_missing_or_unestablished_is_missing_accounting_not_a_zero(self):
        ok = AF.complete(self.base_doc); path = A.registry_path_of(self.t.log); self.assertTrue(os.path.exists(path)); self.assertEqual(self.passes(self.t, ok)[0]["status"], "PASS")      # established and empty: a valid zero
        os.unlink(path); js, _ = self.everywhere(self.t, copy.deepcopy(ok), "candidates_unaccounted"); self.assertIn("no candidate registry was established", " ".join(js["binding_summary"]["audit"]["reasons"]))
        A.save_registry(path, A.empty_registry(A.D.canon(self.t.log)))      # a registry that exists but never established this evaluation
        js, _ = self.everywhere(self.t, copy.deepcopy(ok), "candidates_unaccounted"); self.assertIn("never established", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_registry_of_another_source_or_a_malformed_one_never_counts_as_a_zero(self):
        ok = AF.complete(self.base_doc); path = A.registry_path_of(self.t.log)
        json.dump(dict(A.empty_registry("/elsewhere.jsonl"), established=[A.dict_of(k) for k in AF.keys_of(ok)]), open(path, "w")); self.everywhere(self.t, copy.deepcopy(ok), "candidates_unaccounted")
        open(path, "w").write("[]"); self.everywhere(self.t, copy.deepcopy(ok), "candidates_unaccounted")

    def test_a_session_whose_recorded_cwd_is_not_a_directory_has_no_registry_location_and_never_passes(self):
        t = RB.Tx(self.d); t.user("a request " + "x" * 100); t.write("w1", RB.V1); t.verify(); [r.update(cwd=os.path.join(self.d, "gone")) for r in t.recs]; t.save(); open(t.note, "w").write(RB.V1)
        self.assertIsNone(A.registry_path_of(t.log)); d = AF.complete(self.raw(t, [self.check(t, "w1", "session_end")]))
        js, path = self.written(t, d); self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(self.gate(t, js)["audited_status"], "UNRESOLVED")
        self.assertIn("no usable cwd", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_the_cli_status_of_the_concealed_report_is_unresolved(self):
        d = self.concealed(); d["audit"].pop("registry"); js, path = self.written(self.t, d)
        code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", path, "--cwd", self.d]); self.assertEqual(json.loads(out)["audited_status"], "UNRESOLVED")

    def test_preparation_establishes_the_registry_in_its_default_run_directory_only(self):
        reg = A.registry_path_of(self.t.log); self.assertFalse(os.path.exists(reg))
        code, out = cli("prepare.py", [self.t.log, "--cwd", self.d, "--out", os.path.join(self.d, "elsewhere")]); self.assertEqual(code, 0, out); self.assertFalse(os.path.exists(reg))      # --out writes nothing else
        code, out = cli("prepare.py", [self.t.log, "--cwd", self.d]); self.assertEqual(code, 0, out); self.assertTrue(os.path.exists(reg))
        doc = A.load_registry(reg)[0]; self.assertEqual((doc["candidates"], doc["established"], doc["ledgers"]), ([], [], []))      # created empty: an evaluation is established by `audit.py template` / `register`
        code, out = cli("audit.py", ["template", "--source", self.t.log, "--file", self.t.note, "--write-id", "w1", "--evaluated-against", "session_end", "--cwd", self.d]); self.assertEqual(code, 0, out)
        self.assertEqual(len(A.load_registry(reg)[0]["established"]), 1)

class LedgersAreExpected(Surfaces):
    def setUp(self):
        super().setUp(); self.ledger = os.path.join(self.d, "ledger.json"); self.t = RB.Tx(self.d)
        for x in ("intro", TA.Q1, TA.Q2): self.t.user(x)
        self.t.write("w1", RB.V1); self.t.verify(); self.t.save(); open(self.t.note, "w").write(RB.V1); self.base_doc = self.raw(self.t, [self.check(self.t, "w1", "prefix")])
    def batch(self, *items):
        spec = [dict(dict(detail=q, source_quote=q, write_id="w1", evaluated_against="prefix"), **i) for q, i in items]
        return cli("omissions.py", ["prepare-batch", "--source", self.t.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", self.ledger], self.d, json.dumps(spec))

    def test_prepare_batch_associates_the_ledger_with_the_session_so_the_report_cannot_drop_it(self):
        self.assertEqual(self.batch((TA.Q1, {}))[0], 0); self.assertEqual(A.load_registry(A.registry_path_of(self.t.log))[0]["ledgers"], [os.path.realpath(self.ledger)])
        d = AF.complete(self.base_doc); self.assertNotIn("ledger", d["audit"])      # the report names no ledger at all
        js, path = self.everywhere(self.t, d, "candidates_unaccounted"); self.assertIn("ledger:prepared", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_different_or_empty_named_ledger_does_not_replace_the_ledger_of_the_session(self):
        self.assertEqual(self.batch((TA.Q1, {}))[0], 0)
        for name in ("named elsewhere", "named and unusable"):
            with self.subTest(name):
                d = AF.complete(self.base_doc, ledger=os.path.join(self.d, "other-ledger.json"))
                if name == "named and unusable": open(os.path.join(self.d, "other-ledger.json"), "w").write("{bad")
                js, path = self.everywhere(self.t, d, "candidates_unaccounted"); self.assertIn("ledger:prepared", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_unavailable_and_invalidated_obligations_stay_unfinished_work_without_naming_the_ledger(self):
        self.assertEqual(self.batch((TA.Q1, {}), ("a detail that is not in the transcript", {}))[0], 3)
        js, path = self.everywhere(self.t, AF.complete(self.base_doc), "candidates_unaccounted", n=2); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["candidates_unaccounted"], 2)
        self.assertIn("ledger:unavailable", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_an_unreadable_ledger_of_the_session_is_unfinished_work(self):
        self.assertEqual(self.batch((TA.Q1, {}))[0], 0); open(self.ledger, "w").write("{bad")
        js, path = self.everywhere(self.t, AF.complete(self.base_doc), "candidates_unaccounted"); self.assertIn("ledger is unusable", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_ledger_of_another_session_does_not_leak_into_this_one(self):
        other = RB.Tx(os.path.join(self.d)); other.log = os.path.join(self.d, "other.jsonl"); other.recs = []; other.n = 0; other.user("intro"); other.user(TA.Q1); other.write("w1", RB.V1); other.save()
        self.assertEqual(A.registry_path_of(other.log) == A.registry_path_of(self.t.log), False)      # one registry per source session

class PerVersionAccounting(TA.Base):
    """A candidate registered for ONE evaluation of a write blocks that evaluation's summary and the write-level summary, and no other."""
    def setUp(self):
        super().setUp(); self.t = self.session(); self.t.verify("c2"); self.t.save(); self.sha = versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"]
        self.checks = [self.at(self.t, "w1", "prefix", "c1"), self.at(self.t, "w1", "session_end", "c2", "p2")]
    def doc(self, **kw):
        d = self.full(self.t, self.checks, **kw); d["handoff"]["versions"] = [IW.VROW(versions.versions_of(self.t.log, self.t.note)[0][0], 1, "prefix")]; return d
    def test_a_candidate_of_the_prefix_blocks_the_prefix_and_the_write_summary_whatever_registry_the_report_names(self):
        A.register(A.registry_path_of(self.t.log), A.D.canon(self.t.log), ("w1", self.sha, "prefix", None), OTHER, 2)
        foreign = os.path.join(self.d, "foreign", "registry.json"); A.save_registry(foreign, dict(A.empty_registry(A.D.canon(self.t.log)), established=[A.dict_of(("w1", self.sha, m, None)) for m in ("prefix", "session_end")]))
        for variant in ("named", "omitted", "substituted by an empty foreign registry"):
            with self.subTest(variant):
                d = self.doc(); d["audit"]["evaluations"] = [hide(dict(audit=dict(evaluations=[e])))["audit"]["evaluations"][0] if e["evaluation"]["evaluated_against"] == "prefix" else e for e in d["audit"]["evaluations"]]
                if variant == "omitted": d["audit"].pop("registry")
                if variant != "named" and variant != "omitted": d["audit"]["registry"] = foreign
                js, path = self.written(self.t, d); v = js["handoff"]["versions"][0]
                sub = variant.startswith("substituted")      # a substituted registry is a defect of the whole report: every summary counts it, the session_end evaluation too
                self.assertEqual((js["status"], v["audited_status"], v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "UNRESOLVED" if sub else "PASS"))
                self.assertEqual(v["evaluations"]["prefix"]["binding_summary"]["audit"]["unfinished"]["candidates_unaccounted"], 1 + sub); self.assertEqual(v["evaluations"]["session_end"]["binding_summary"]["audit"]["complete"], not sub)
                if sub: self.assertEqual(v["evaluations"]["session_end"]["binding_summary"]["audit"]["unfinished"], {"candidates_unaccounted": 1})
                if variant != "named": self.assertEqual(self.gate(self.t, js)["audited_status"], "UNRESOLVED")

class StructureComesFirst(Surfaces):
    def setUp(self):
        super().setUp(); self.t = self.session(); self.base_doc = self.raw(self.t, [self.check(self.t, "w1", "session_end")]); self.good = AF.complete(self.base_doc)
    def test_malformed_inputs_never_crash_the_writer_and_never_pass(self):
        for name, edit in (("checks has a null", lambda d: d.update(checks=[None])), ("checks has scalars", lambda d: d.update(checks=[1, "x", []])), ("checks is null", lambda d: d.update(checks=None)), ("findings is null", lambda d: d.update(findings=None)),
                           ("findings is a string", lambda d: d.update(findings="x")), ("findings has a null", lambda d: d.update(findings=[None])), ("unresolved is null", lambda d: d.update(unresolved=None)), ("session is a string", lambda d: d.update(session="invalid")),
                           ("session is a list", lambda d: d.update(session=[])), ("handoff is a string", lambda d: d.update(handoff="x")), ("handoff.versions is null", lambda d: d["handoff"].update(versions=None)), ("scope_exclusions has a null", lambda d: d.update(scope_exclusions=[None])),
                           ("audit.evaluations has a null", lambda d: d["audit"].update(evaluations=[None])), ("a chunk record is a string", lambda d: d["audit"]["evaluations"][0]["chunks"].append("x")), ("categories is a string", lambda d: d["audit"]["evaluations"][0].update(categories="x")),
                           ("work_locations is a number", lambda d: d.update(work_locations=7)), ("variant is null", lambda d: d.update(variant=None)), ("all of it", lambda d: d.update(checks=[None], findings=None, unresolved=None, session="invalid", handoff=None))):
            with self.subTest(name):
                d = copy.deepcopy(self.good); edit(d); js, path = self.written(self.t, d); au = js["binding_summary"]["audit"]
                self.assertNotEqual(js["status"], "PASS"); self.assertFalse(au["complete"]); self.assertGreaterEqual(au["unfinished"].get("structure", 0) + au["unfinished"].get("scope", 0), 1, au)
                self.assertNotEqual(js.get("delivery", {}).get("delivery_state"), "verified_version") if name in ("session is a string", "session is a list", "handoff is a string", "all of it", "variant is null") else None

    def test_a_document_that_is_not_an_object_never_crashes_the_writer(self):
        for bad in (None, [], "x", 7):
            with self.subTest(bad):
                js, path = self.written(self.t, bad); self.assertEqual(js["status"], "UNRESOLVED"); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["structure"], 1)

    def test_a_persisted_pass_without_the_required_properties_is_not_a_verified_version(self):
        js, path = self.written(self.t, self.good); self.assertEqual(js["status"], "PASS"); self.assertEqual(self.gate(self.t, js)["delivery_state"], "verified_version")
        for prop in ("variant", "environment", "kit", "cost", "patch", "scope_exclusions", "audit"):
            with self.subTest(prop):
                d = copy.deepcopy(js); d.pop(prop); g = self.gate(self.t, d); self.assertEqual(g["delivery_state"], "unresolved"); self.assertIsNone(g["audited_status"]); self.assertIn("not structurally valid", " ".join(g["reasons"]))
                self.assertGreaterEqual(g["audit"]["unfinished"]["structure"], 1); self.assertFalse(g["audit"]["complete"])
                p = os.path.join(self.d, "stripped-%s.json" % prop); json.dump(d, open(p, "w")); code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", p, "--cwd", self.d]); o = json.loads(out)
                self.assertEqual((code, o["delivery_state"]), (3, "unresolved")); self.assertIn("not structurally valid", " ".join(o["reasons"]))

    def test_a_malformed_persisted_report_never_crashes_the_gate_or_the_cli(self):
        js, path = self.written(self.t, self.good)
        for name, edit in (("checks has a null", lambda d: d.update(checks=[None])), ("findings is null", lambda d: d.update(findings=None)), ("session is a string", lambda d: d.update(session="invalid")), ("handoff is a list", lambda d: d.update(handoff=[])),
                           ("checks is a string", lambda d: d.update(checks="x")), ("audit is a string", lambda d: d.update(audit="x")), ("schema_version is 2", lambda d: d.update(schema_version="2")), ("status is a number", lambda d: d.update(status=1))):
            with self.subTest(name):
                d = copy.deepcopy(js); edit(d); g = self.gate(self.t, d); self.assertNotEqual(g["delivery_state"], "verified_version")
                p = os.path.join(self.d, "m-%s.json" % name.replace(" ", "-")); json.dump(d, open(p, "w")); code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", p, "--cwd", self.d]); self.assertEqual(code, 3); json.loads(out)

    def test_a_structurally_valid_authentic_unresolved_report_is_still_a_verified_version(self):
        d = copy.deepcopy(self.base_doc); js, path = self.written(self.t, d)      # a good bound check, an audit with no evaluation: UNRESOLVED and structurally valid
        self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(SC.validate_report(js), []); self.assertEqual(self.gate(self.t, js)["delivery_state"], "verified_version")

    def test_a_tenth_category_record_blocks_the_pass_everywhere(self):
        d = copy.deepcopy(self.good); e = d["audit"]["evaluations"][0]; e["categories"].append(dict(e["categories"][0], category=2))
        js, path = self.written(self.t, d); self.assertEqual(js["status"], "UNRESOLVED"); au = js["binding_summary"]["audit"]; self.assertGreaterEqual(au["unfinished"]["structure"], 1); self.assertGreaterEqual(au["unfinished"]["categories"], 1)
        g = self.gate(self.t, js); self.assertIsNone(g["audited_status"]); self.assertEqual(g["delivery_state"], "unresolved")
        d = copy.deepcopy(self.good); e = d["audit"]["evaluations"][0]; e["categories"].append(dict(category=10, outcome="no_candidate")); js, path = self.written(self.t, d); self.assertEqual(js["status"], "UNRESOLVED")

    def test_a_confirmed_defect_keeps_fail_while_the_structural_work_is_counted(self):
        r = TA.Registry(); r.d = self.d; r.n = 20; t, calls, ref = r.retro(); checks, fs = r.pair(t, calls, ref); doc = r.doc(t, checks, fs)
        e = doc["audit"]["evaluations"][0]; e["categories"].append(dict(category=10, outcome="no_candidate")); doc["variant"] = None
        js, path = r.written(t, doc, calls); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "FAIL"); self.assertFalse(au["complete"]); self.assertGreaterEqual(au["unfinished"]["structure"], 2); self.assertNotIn("audit incomplete", " ".join(js["binding_summary"]["reasons"]))

    def test_the_validator_implements_every_keyword_the_schema_uses_and_nothing_is_silently_ignored(self):
        def kw(x, out):
            if isinstance(x, dict):
                for k, v in x.items():
                    if k not in ("properties", "$defs"): out.add(k)
                    kw(v, out) if k not in ("properties", "$defs") else [kw(w, out) for w in v.values()]
            elif isinstance(x, list): [kw(w, out) for w in x]
            return out
        used = kw(SC.schema(), set()); self.assertLessEqual(used - {"properties", "$defs"}, SC.KNOWN, used - SC.KNOWN)
        self.assertTrue(SC.validate({"a": 1}, {"unknownKeyword": 1})); self.assertTrue(SC.validate(True, {"type": "integer"})); self.assertTrue(SC.validate(float("nan"), {"type": "number"})); self.assertEqual(SC.validate(1, {"type": "integer"}), [])
        self.assertTrue(SC.validate_report(None)); self.assertTrue(SC.validate_report([])); self.assertTrue(SC.validate_report({"schema_version": "1"}))

class UnusableRecordsAreNotEvaluated(Surfaces):
    """Round 3, fix 1: a record of the wrong kind (a check whose id is a list, a finding whose type is an object, a declared version whose tool_use_id is a list, ...) is never hashed, indexed or compared: the writer evaluates an empty record in its place,
    counts the structural problem of the INPUT (a PASS cannot survive it) and a validated defect among the usable records keeps FAIL. The writer owns its properties: a status claim that is not a status, and every other writer-owned value of the input, is never carried into the output."""
    FINDING = dict(type="lost_detail", category="omission", quote_handoff=None, quote_source=None, uuid=None, check_id="p1", confidence=0.99)
    def setUp(self):
        super().setUp(); self.t = self.session(); self.v = versions.versions_of(self.t.log, self.t.note)[0][0]
        d = self.raw(self.t, [self.check(self.t, "w1", "session_end")]); d["handoff"]["versions"] = [IW.VROW(self.v, 1, "session_end")]; self.good = AF.complete(d)

    def edits(self):
        """(name, edit) for every record kind of the report and a field of it that the code hashes, indexes or compares, for a list and for an object in its place."""
        out = []
        for val in ([], {}):
            kind = type(val).__name__
            out += [("checks[0].id=%s" % kind, lambda d, val=val: d["checks"][0].update(id=copy.deepcopy(val))), ("checks[0].tool=%s" % kind, lambda d, val=val: d["checks"][0].update(tool=copy.deepcopy(val))),
                    ("checks[0].jev_ref.tool_use_id=%s" % kind, lambda d, val=val: d["checks"][0]["jev_ref"].update(tool_use_id=copy.deepcopy(val))), ("checks[0].version_ref.write_tool_use_id=%s" % kind, lambda d, val=val: d["checks"][0]["version_ref"].update(write_tool_use_id=copy.deepcopy(val))),
                    ("findings[].type=%s" % kind, lambda d, val=val: d.update(findings=[dict(self.FINDING, type=copy.deepcopy(val))])), ("findings[].check_id=%s" % kind, lambda d, val=val: d.update(findings=[dict(self.FINDING, check_id=copy.deepcopy(val))])),
                    ("findings[].omission_ref.source_check_id=%s" % kind, lambda d, val=val: d.update(findings=[dict(self.FINDING, omission_ref=dict(detail="x", source_check_id=copy.deepcopy(val)))])), ("unresolved[].check_id=%s" % kind, lambda d, val=val: d.update(unresolved=[dict(check_id=copy.deepcopy(val), reason="r")])),
                    ("handoff.versions[].tool_use_id=%s" % kind, lambda d, val=val: d["handoff"]["versions"][0].update(tool_use_id=copy.deepcopy(val))), ("handoff.versions[].sha256=%s" % kind, lambda d, val=val: d["handoff"]["versions"][0].update(sha256=copy.deepcopy(val)))]
        return out

    def test_the_reproduced_inputs_never_crash_the_writer_the_gate_or_the_cli_and_never_pass(self):
        for name, edit in self.edits():
            with self.subTest(name):
                d = copy.deepcopy(self.good); edit(d); js, path = self.written(self.t, d); au = js["binding_summary"]["audit"]
                self.assertNotEqual(js["status"], "PASS", name); self.assertFalse(au["complete"]); self.assertGreaterEqual(au["unfinished"].get("structure", 0), 1, au)
                g = self.gate(self.t, json.load(open(path, encoding="utf-8"))); self.assertIsNone(g["audited_status"]); self.assertEqual(g["delivery_state"], "unresolved"); self.assertGreaterEqual(g["audit"]["unfinished"]["structure"], 1)
                code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", path, "--cwd", self.d]); self.assertEqual(code, 3); self.assertEqual(json.loads(out)["delivery_state"], "unresolved")

    def test_a_wrong_kind_of_value_anywhere_in_the_report_never_crashes_and_never_passes(self):
        """EVERY value of a complete report replaced by a list, an object and a number: the writer and the gate never raise, a structurally invalid input is never a PASS and `status_claimed` is never an invalid value."""
        paths = []
        def walk(x, pre):
            for k, v in (x.items() if isinstance(x, dict) else enumerate(x) if isinstance(x, list) else ()): paths.append(pre + [k]); walk(v, pre + [k])
        walk(self.good, []); runs = 0
        for pa in paths:
            if pa == ["schema_version"]: continue      # (the writer stamps it)
            for val in ([], {}, 7):
                d = copy.deepcopy(self.good); cur = d
                for k in pa[:-1]: cur = cur[k]
                cur[pa[-1]] = copy.deepcopy(val); runs += 1
                try: js, path = self.written(self.t, d); self.gate(self.t, js)
                except Exception as e: self.fail("%s = %r: %s: %s" % (".".join(map(str, pa)), val, e.__class__.__name__, e))
                if SC.validate_report(d, True): self.assertNotEqual(js["status"], "PASS", (pa, val))
                self.assertEqual(SC.validate(js.get("status_claimed"), SC.schema()["properties"]["status_claimed"]), [], (pa, val))
        self.assertGreater(runs, 300)

    def test_a_confirmed_defect_keeps_fail_next_to_every_kind_of_malformed_record(self):
        r = TA.Registry(); r.d = self.d; r.n = 60; t, calls, ref = r.retro(); checks, fs = r.pair(t, calls, ref); doc = r.doc(t, checks, fs); doc["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]
        js, path = r.written(t, copy.deepcopy(doc), calls); self.assertEqual(js["status"], "FAIL"); base = js["binding_summary"]["audit"]["unfinished"].get("structure", 0)
        d = copy.deepcopy(doc); d["checks"] += [dict(checks[0], id=[]), dict(checks[0], id={}), 5, None]; d["findings"] += [dict(fs[0], type=[]), dict(fs[0], check_id={}), "x"]; d["unresolved"] = [dict(check_id=[], reason="r"), 3]
        d["handoff"]["versions"].append(dict(d["handoff"]["versions"][0], tool_use_id=[])); js, path = r.written(t, d, calls); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], "FAIL", js["binding_summary"]["reasons"]); self.assertGreaterEqual(au["unfinished"]["structure"], base + 8); self.assertFalse(au["complete"]); self.assertEqual(js["binding_summary"]["checks"], 6)
        v = js["handoff"]["versions"]; self.assertEqual(v[0]["audited_status"], "FAIL"); self.assertEqual(v[1], d["handoff"]["versions"][1])      # the usable declared version is evaluated, the malformed one is kept as written and never looked up
        self.assertEqual([c["id"] for c in js["checks"][2:4]], [[], {}]); self.assertEqual(js["checks"][4:], [{"binding": js["checks"][4]["binding"]}] * 2)

    def test_a_declared_status_that_is_not_a_status_is_ignored_and_never_kept(self):
        for bad in ("not-a-status", "pass", "", [], {}, 7, True):
            with self.subTest(repr(bad)):
                d = copy.deepcopy(self.good); d["status"] = bad; js, path = self.written(self.t, d)
                self.assertEqual(js["status"], "PASS"); self.assertIn("status_claimed", js); self.assertIsNone(js["status_claimed"]); self.assertEqual(SC.validate_report(js), [])      # (a schema-valid output: the invalid claim is not in a schema-constrained field)
                self.assertIn("declared status is not PASS, FAIL or UNRESOLVED", " ".join(js["binding_summary"]["reasons"]))
                g = self.gate(self.t, json.load(open(path, encoding="utf-8"))); self.assertEqual((g["audited_status"], g["delivery_state"]), ("PASS", "verified_version"))
                code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", path, "--cwd", self.d]); self.assertEqual((code, json.loads(out)["audited_status"]), (0, "PASS"))
                md = open(path.replace(".verify.json", ".verify.md"), encoding="utf-8").read(); self.assertIn("declarată inițial: lipsă sau nevalidă", md); self.assertNotIn("None", md)
        d = copy.deepcopy(self.good); d["status"] = "FAIL"; js, _ = self.written(self.t, d); self.assertEqual((js["status"], js["status_claimed"]), ("PASS", "FAIL"))      # a claim that is a status is kept when the writer overrides it
        d = copy.deepcopy(self.good); d["status"] = "PASS"; js, _ = self.written(self.t, d); self.assertNotIn("status_claimed", js)

    def test_the_properties_the_writer_owns_are_never_carried_from_the_input(self):
        control, _ = self.written(self.t, copy.deepcopy(self.good))
        d = copy.deepcopy(self.good); d.update(status_claimed="garbage", delivery="x", binding_summary=5, scope_audit=[], jev_ref_version="9", omission_contract="R9"); js, path = self.written(self.t, d)
        self.assertEqual(SC.validate_report(js), []); self.assertEqual({k: js.get(k) for k in SC.WRITER_OWNED if k != "binding_summary"}, {k: control.get(k) for k in SC.WRITER_OWNED if k != "binding_summary"})
        self.assertEqual(js["binding_summary"]["audit"], control["binding_summary"]["audit"]); self.assertEqual(self.gate(self.t, js)["delivery_state"], "verified_version")
        d = copy.deepcopy(self.good); d["checks"][0]["binding"] = "x"; d["checks"][0]["advice"] = 5; js, _ = self.written(self.t, d); self.assertEqual(SC.validate_report(js), []); self.assertIs(js["checks"][0]["binding"]["bound"], True)      # the writer's per-record properties too
        self.assertEqual((js["status"], js["binding_summary"]["audit"]), ("PASS", control["binding_summary"]["audit"]))      # (and they change neither the status nor the audit)

    def record_edits(self):
        """(name, edit): every per-record property the writer owns, set to a value of the wrong kind in the author's input."""
        out = [("checks[0].advice", lambda d: d["checks"][0].update(advice="ignored")), ("checks[0].binding", lambda d: d["checks"][0].update(binding="ignored"))]
        out += [("handoff.versions[0].%s" % f, lambda d, f=f: d["handoff"]["versions"][0].update({f: "ignored"})) for f in SC.RECORD_WRITER_OWNED["versions"]]
        return out + [("all of them", lambda d: [e(d) for _, e in out])]

    def test_the_per_record_properties_the_writer_owns_neither_block_a_pass_nor_change_the_audit(self):
        """The council's round-4 fix 3: the writer replaces these properties, so the structural audit of the INPUT must not count them: the recomputed status and audit are those of the control, the writer and the gate agree and the report is delivered."""
        control, _ = self.written(self.t, copy.deepcopy(self.good)); self.assertEqual(control["status"], "PASS")
        for name, edit in self.record_edits():
            with self.subTest(name):
                d = copy.deepcopy(self.good); edit(d); self.assertEqual(SC.validate_report(d, True), [])
                if name.rsplit(".", 1)[-1] in ("advice", "binding", "audited_status", "binding_summary", "evaluations"): self.assertNotEqual(SC.validate_report(d), [], name)      # (strict for a persisted report, exempt for the writer's input)
                js, path = self.written(self.t, d); au = js["binding_summary"]["audit"]
                self.assertEqual((js["status"], au), ("PASS", control["binding_summary"]["audit"])); self.assertTrue(au["complete"]); self.assertEqual(au["unfinished"], {}); self.assertEqual(SC.validate_report(js), [])
                self.assertNotEqual(js["checks"][0]["advice"], "ignored") if "advice" in js["checks"][0] else None; self.assertIsInstance(js["checks"][0]["binding"], dict); self.assertEqual(js["handoff"]["versions"][0]["audited_status"], "PASS")
                for f in SC.RECORD_WRITER_OWNED["versions"]: self.assertNotEqual(js["handoff"]["versions"][0].get(f), "ignored", f)
                again = json.load(open(path, encoding="utf-8")); g = self.gate(self.t, again); self.assertEqual((g["audited_status"], g["delivery_state"]), ("PASS", "verified_version"), g["reasons"]); self.assertEqual(g["audit"], au)
                code, out = cli("versions.py", ["status", "--session", self.t.log, "--file", self.t.note, "--report", path, "--cwd", self.d]); o = json.loads(out); self.assertEqual((code, o["audited_status"], o["delivery_state"]), (0, "PASS", "verified_version"))
                self.assertEqual([v["audited_status"] for v in js["handoff"]["versions"]], ["PASS"])      # the per-version summary

    def test_the_same_edits_keep_a_confirmed_defect_fail_and_a_genuinely_malformed_author_field_still_counts(self):
        r = TA.Registry(); r.d = self.d; r.n = 60; t, calls, ref = r.retro(); checks, fs = r.pair(t, calls, ref); doc = r.doc(t, checks, fs); doc["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]
        base, _ = r.written(t, copy.deepcopy(doc), calls); self.assertEqual(base["status"], "FAIL"); base_n = base["binding_summary"]["audit"]["unfinished"].get("structure", 0)
        for name, edit in self.record_edits():
            with self.subTest("defect: " + name):
                d = copy.deepcopy(doc); edit(d); js, _ = r.written(t, d, calls); self.assertEqual(js["status"], "FAIL"); self.assertEqual(js["binding_summary"]["audit"], base["binding_summary"]["audit"])
        for name, edit in (("checks[0].tool", lambda d: d["checks"][0].update(tool=5)), ("handoff.versions[0].sha256", lambda d: d["handoff"]["versions"][0].update(sha256=5)), ("checks[0].id", lambda d: d["checks"][0].update(id=[]))):
            for extra_name, extra in self.record_edits():
                with self.subTest("%s + %s" % (name, extra_name)):
                    plain = copy.deepcopy(self.good); edit(plain); plain_js, _ = self.written(self.t, plain); with_extra = copy.deepcopy(plain); extra(with_extra); js, _ = self.written(self.t, with_extra)
                    self.assertNotEqual(plain_js["status"], "PASS"); self.assertGreaterEqual(plain_js["binding_summary"]["audit"]["unfinished"]["structure"], 1)
                    self.assertEqual((js["status"], js["binding_summary"]["audit"]["unfinished"]), (plain_js["status"], plain_js["binding_summary"]["audit"]["unfinished"]))      # the writer's property adds nothing to the genuine problem and hides nothing

    def test_the_last_check_of_the_writer_never_certifies_a_pass_that_is_not_valid_as_emitted(self):
        js, _ = self.written(self.t, copy.deepcopy(self.good)); self.assertEqual(report.seal(copy.deepcopy(js)), js)      # a valid PASS is untouched
        bad = copy.deepcopy(js); bad["kit"] = 5; out = report.seal(bad); self.assertEqual((out["status"], out["status_claimed"], out["delivery"]["delivery_state"]), ("UNRESOLVED", "PASS", "unresolved"))
        self.assertFalse(out["binding_summary"]["audit"]["complete"]); self.assertGreaterEqual(out["binding_summary"]["audit"]["unfinished"]["structure"], 1); self.assertIn("as emitted", " ".join(out["binding_summary"]["reasons"]))
        for status in ("FAIL", "UNRESOLVED"):      # only a PASS is capped
            other = copy.deepcopy(bad); other["status"] = status; self.assertEqual(report.seal(other)["status"], status)

    def test_the_binder_and_the_finding_validator_themselves_never_hash_a_value_of_the_wrong_kind(self):
        checks = [{"id": [], "jev_ref": None}, {"id": {}}, {"id": "a"}, {"id": "a"}, {"id": None}, 5]; rows = jevref.bind(checks, [], "R04")
        self.assertEqual([r["id"] for r in rows], [None, None, "a", "a", None, None]); self.assertEqual(jevref.duplicate_ids(checks), {"a", None}); self.assertEqual(jevref.check_id({"id": []}), None)
        for f in (dict(self.FINDING, type=[]), dict(self.FINDING, type={}), dict(self.FINDING, check_id=[]), dict(self.FINDING, check_id={})): self.assertEqual(jevref.validate_finding(f, {}, None, "R04")[0], False)
        report.attach_advice([{"id": []}, {"id": "a"}], [dict(bound=True, resolved=False, tool="verify", tool_use_id="x", result_index=0), dict(bound=False)], [], [dict(type="lost_detail", check_id=[], omission_ref=dict(source_check_id={}))])      # (no crash)

class TheWindowIsTheEvaluation(Surfaces):
    """Two verification runs with a user instruction between them: the evidence of run r1 ends where r1 starts; the later instruction belongs to the window of r2 only."""
    def setUp(self):
        super().setUp(); t = self.t = RB.Tx(self.d); t.user("FIRST request " + "x" * 120); t.write("w1", RB.V1); t.run("r1"); t.user("LATE instruction " + "q" * 120); t.run("r2"); t.verify(); t.save(); open(t.note, "w").write(RB.V1)
        self.sha = versions.versions_of(t.log, t.note)[0][0]["sha256"]; self.plan = A.plan_of(t.log, t.note, 200)
    def key(self, mode, run=None): return ("w1", self.sha, mode, run)
    def win(self, mode, run=None): return A.window_of(self.plan, self.t.log, self.key(mode, run))[0]
    def texts(self, i): return self.plan["texts"][i]
    def has(self, win, needle): return [i for i in win["indexes"] if needle in self.texts(i)]

    def test_each_run_has_its_own_expected_chunks_and_the_later_instruction_is_not_evidence_for_the_earlier_run(self):
        r1, r2, pre = self.win("session_end", "r1"), self.win("session_end", "r2"), self.win("prefix")
        self.assertEqual(self.has(r1, "LATE instruction"), []); self.assertTrue(self.has(r2, "LATE instruction")); self.assertTrue(self.has(r1, "FIRST request")); self.assertNotEqual(r1["indexes"], r2["indexes"])
        self.assertEqual(pre["indexes"], r1["indexes"]); self.assertEqual(A.expected_chunks(self.plan, self.key("session_end", "r1"), self.t.log)[0], r1["indexes"])

    def test_a_quote_of_the_later_instruction_does_not_ground_a_review_of_the_earlier_run(self):
        d = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end", run="r1")]), max_chars=200); self.assertEqual(self.passes(self.t, d)[0]["status"], "PASS")
        late = self.has(self.win("session_end", "r2"), "LATE instruction")[0]; u = next(x for x in self.plan["chunks"] if x["index"] == late)["entries"][0]["uuid"]
        for name, edit in (("a chunk review", lambda e: e["chunks"][0].update(basis=dict(uuid=u, quote="LATE instruction"))), ("a category outcome", lambda e: [c.update(basis=dict(uuid=u, quote="LATE instruction")) for c in e["categories"]])):
            with self.subTest(name):
                bad = copy.deepcopy(d); edit(bad["audit"]["evaluations"][0]); js, path = self.written(self.t, bad); self.assertEqual(js["status"], "UNRESOLVED")
                self.assertGreaterEqual(sum(js["binding_summary"]["audit"]["unfinished"].get(k, 0) for k in ("chunks_ungrounded", "categories")), 1)

    def test_the_report_of_the_later_run_must_review_the_later_instruction(self):
        d1 = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end", run="r1")]), max_chars=200); d2 = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end", run="r2")]), max_chars=200)
        self.assertGreater(len(d2["audit"]["evaluations"][0]["chunks"]), len(d1["audit"]["evaluations"][0]["chunks"])); self.assertEqual(self.passes(self.t, d2)[0]["status"], "PASS")
        mixed = copy.deepcopy(d2); mixed["audit"]["evaluations"][0]["chunks"] = d1["audit"]["evaluations"][0]["chunks"]      # the review of r1 offered for r2
        js, path = self.written(self.t, mixed); self.assertEqual(js["status"], "UNRESOLVED"); self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["chunks_missing"], len(d2["audit"]["evaluations"][0]["chunks"]) - len(d1["audit"]["evaluations"][0]["chunks"]))
        again = copy.deepcopy(d1); again["audit"]["evaluations"][0]["chunks"] = d2["audit"]["evaluations"][0]["chunks"]      # a review that also covers the later chunk does not harm r1: out-of-window records are ignored, never certified
        self.assertEqual(self.passes(self.t, again)[0]["status"], "PASS")

    def test_the_prefix_ends_at_the_write_and_the_session_end_at_the_run_in_the_gate_and_the_summaries(self):
        pv = TA.PerVersion.__new__(TA.PerVersion)      # (per-version summaries of both modes of the same write)
        t = self.t; t.verify("c2"); t.save(); open(t.note, "w").write(RB.V1)
        checks = [self.at(t, "w1", "prefix", "c1"), dict(self.at(t, "w1", "session_end", "c2", "p2"), version_ref=dict(self.check(t, "w1", "session_end", run="r2")["version_ref"]))]
        d = AF.complete(self.raw(t, checks), max_chars=200); d["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]
        js, path = self.written(t, d); v = js["handoff"]["versions"][0]; self.assertEqual((js["status"], v["audited_status"], v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("PASS",) * 4)
        self.assertEqual(self.gate(t, js)["audited_status"], "PASS")
        for mode in ("prefix", "session_end"):      # the review of the OTHER mode's window is not the review of this one
            bad = copy.deepcopy(d); [e.update(chunks=[c for c in e["chunks"] if "LATE" not in self.texts(c["index"])]) for e in bad["audit"]["evaluations"] if e["evaluation"]["evaluated_against"] == mode]
            js, path = self.written(t, bad); v = js["handoff"]["versions"][0]
            self.assertEqual((v["evaluations"]["prefix"]["audited_status"], v["evaluations"]["session_end"]["audited_status"]), ("PASS", "UNRESOLVED") if mode == "session_end" else ("PASS", "PASS"))

class WindowBoundaryInsideAChunk(Surfaces):
    """The stream is cut at the write only: a chunk after the write holds material before AND after the start of the selected run (record AFTER, then the verification run, then the later prompt LATER in the same chunk). The
    window of the run ends at its start, so the chunk is partial and only the span of the record inside the window is evidence."""
    def setUp(self):
        super().setUp(); t = self.t = RB.Tx(self.d); t.user("FIRST request " + "x" * 60)
        t.rec("assistant", [dict(type="text", text="BEFORE the write " + "y" * 40), dict(type="tool_use", id="w1", name="Write", input=dict(file_path=t.note, content=RB.V1)), dict(type="text", text="AFTER the write " + "z" * 40)])
        t.rec("user", [dict(type="tool_result", tool_use_id="w1", content="File created successfully", is_error=False)]); t.run("r1"); t.user("LATER instruction " + "q" * 60); t.verify(); t.save(); open(t.note, "w").write(RB.V1)
        self.sha = versions.versions_of(t.log, t.note)[0][0]["sha256"]; self.plan = A.plan_of(t.log, t.note, A.CHUNK_CHARS); self.kp = ("w1", self.sha, "prefix", None); self.ke = ("w1", self.sha, "session_end", "r1")
        self.text1 = self.plan["texts"][1]
    def uuid_of(self, chunk, needle): return next(e["uuid"] for e in self.plan["chunks"][chunk]["entries"] if needle in self.plan["texts"][chunk][e["start"]:e["end"]])

    def test_the_prefix_ends_at_the_write_so_the_chunk_after_it_is_not_expected(self):
        win = A.window_of(self.plan, self.t.log, self.kp)[0]; self.assertEqual((win["indexes"], win["partial"]), ([0], [])); self.assertEqual(len(self.plan["chunks"]), 2)
        self.assertTrue(any("AFTER the write" in self.text1[e["start"]:e["end"]] for e in self.plan["chunks"][1]["entries"])); self.assertIn("LATER instruction", self.text1)
    def test_the_chunk_that_holds_material_on_both_sides_of_the_run_start_is_partial_and_only_the_inside_spans_count(self):
        win = A.window_of(self.plan, self.t.log, self.ke)[0]; self.assertEqual((win["indexes"], win["partial"]), ([0, 1], [1]))
        inside = [self.text1[a:b] for u, a, b in win["spans"][1]]; self.assertTrue(any("AFTER the write" in x for x in inside)); self.assertFalse(any("LATER instruction" in x for x in inside))
        self.assertTrue(A.block_template(self.plan, self.ke, self.t.log)["chunks"][1]["window_partial"]); self.assertNotIn("window_partial", A.block_template(self.plan, self.ke, self.t.log)["chunks"][0])
    def test_a_quote_from_after_the_boundary_in_the_same_chunk_is_not_evidence(self):
        d = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end", run="r1")])); self.assertEqual(self.passes(self.t, d)[0]["status"], "PASS")
        u_after, u_late = self.uuid_of(1, "AFTER the write"), self.uuid_of(1, "LATER instruction"); self.assertNotEqual(u_after, u_late)
        for name, b, ok in (("inside the window", dict(uuid=u_after, quote="AFTER the write"), True), ("after the boundary, own uuid", dict(uuid=u_late, quote="LATER instruction"), False), ("after the boundary, the uuid of the record inside", dict(uuid=u_after, quote="LATER instruction"), False)):
            with self.subTest(name):
                bad = copy.deepcopy(d); bad["audit"]["evaluations"][0]["chunks"][1]["basis"] = b; js, path = self.written(self.t, bad); self.assertEqual(js["status"], "PASS" if ok else "UNRESOLVED", js["binding_summary"]["audit"]["reasons"])
                if not ok: self.assertEqual(js["binding_summary"]["audit"]["unfinished"]["chunks_ungrounded"], 1)
    def test_a_boundary_inside_one_record_cuts_it_at_the_sanitized_prefix_of_its_leading_blocks(self):
        e = dict(uuid="u1", role="user", start=0, end=40, eoff=0, entry_text="[u1 user] AAA BBB", parts=[(0, "AAA"), (1, "BBB")])
        self.assertEqual(A._prefix_end(e, {0}), len("[u1 user] AAA")); self.assertEqual(A._prefix_end(e, {0, 1}), len("[u1 user] AAA BBB")); self.assertEqual(A._prefix_end(e, set()), len("[u1 user] "))
        self.assertEqual(A._prefix_end(dict(e, entry_text="[u1 user] XXX"), {0}), 0)      # a prefix that is not a prefix of the entry as the chunk holds it: nothing of the record is evidence (fail closed)
        self.assertEqual(A._body_start(e), len("[u1 user] ")); self.assertEqual(A._body_start(dict(e, eoff=5)), 0)

class ReviewIsGrounded(Surfaces):
    def setUp(self):
        super().setUp(); self.t = self.session(n=3); self.good = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end")])); self.e0 = self.good["audit"]["evaluations"][0]
        self.plan = A.plan_of(self.t.log, self.t.note, A.CHUNK_CHARS)
    def edited(self, fn): d = copy.deepcopy(self.good); fn(d["audit"]["evaluations"][0]); return d

    def test_flags_only_completion_is_not_a_review(self):
        def flags(e):
            for c in e["chunks"]: c.pop("basis", None)
            for c in e["categories"]: c.pop("basis", None)
        js, path = self.everywhere(self.t, self.edited(flags), "chunks_ungrounded"); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 9)      # reviewed true, nine categories, nine bare outcomes
    def test_a_missing_no_candidate_grounding_blocks_each_category(self):
        for c in range(1, 10):
            with self.subTest(category=c): self.everywhere(self.t, self.edited(lambda e: [r.pop("basis", None) for r in e["categories"] if r["category"] == c]), "categories")
    def test_a_quote_of_record_two_under_the_uuid_of_record_one_is_not_grounded(self):
        u1, u2 = [e["uuid"] for e in self.plan["chunks"][0]["entries"][:2]]; self.assertNotEqual(u1, u2)
        q2 = "request number 1"; self.assertIn(q2, self.plan["texts"][0])
        for name, fn in (("chunk basis", lambda e: e["chunks"][0].update(basis=dict(uuid=u1, quote=q2))), ("category basis", lambda e: e["categories"][4].update(basis=dict(uuid=u1, quote=q2)))):
            with self.subTest(name): self.everywhere(self.t, self.edited(fn), "chunks_ungrounded" if "chunk" in name else "categories")
        ok = self.edited(lambda e: e["categories"][4].update(basis=dict(uuid=u2, quote=q2))); self.assertEqual(self.passes(self.t, ok)[0]["status"], "PASS")      # the same quote under its own uuid is fine
    def test_a_quote_that_is_no_substring_of_any_record_or_a_foreign_uuid_is_not_grounded(self):
        for name, b in (("invented quote", dict(uuid="u1", quote="a sentence nobody wrote")), ("foreign uuid", dict(uuid="u999", quote="request number 0")), ("blank quote", dict(uuid="u1", quote="  ")), ("empty uuid", dict(uuid="", quote="request"))):
            with self.subTest(name): self.everywhere(self.t, self.edited(lambda e: e["chunks"][0].update(basis=b)), "chunks_ungrounded")
    def test_a_legitimate_complete_review_passes_with_every_kind_of_outcome(self):
        def kinds(e):
            e["categories"][5] = dict(e["categories"][5], outcome="not_applicable"); e["categories"][6] = dict(e["categories"][6], outcome="no_candidate")
        js, g = self.passes(self.t, self.edited(kinds)); self.assertEqual(js["binding_summary"]["audit"]["unfinished"], {})

class CandidateMembership(TA.Base):
    """A category lists EXACTLY the registered candidates of the category: not a subset, not a foreign id, not a repeated id."""
    def setUp(self):
        super().setUp(); self.t = self.session(); self.reg = A.registry_path_of(self.t.log); self.sha = versions.versions_of(self.t.log, self.t.note)[0][0]["sha256"]; self.k = ("w1", self.sha, "session_end", None)
        self.c1 = A.register(self.reg, A.D.canon(self.t.log), self.k, OTHER, 2)[0]; self.c2 = A.register(self.reg, A.D.canon(self.t.log), self.k, "Keep the CSV export", 2)[0]; self.c3 = A.register(self.reg, A.D.canon(self.t.log), self.k, "Use port 8080", 3)[0]
        self.doc = AF.complete(self.raw(self.t, [self.check(self.t, "w1", "session_end")]), details=[OTHER, "Keep the CSV export"]); self.doc["audit"]["evaluations"][0]["categories"][2] = dict(category=3, outcome="candidates", candidates=[self.c3["id"]])
    def cats(self, d, c): return next(r for r in d["audit"]["evaluations"][0]["categories"] if r["category"] == c)
    def test_exact_membership_is_the_baseline_and_still_unresolved_because_the_candidates_are_unaccounted(self):
        js, path = self.written(self.t, self.doc); au = js["binding_summary"]["audit"]; self.assertNotIn("categories", au["unfinished"]); self.assertEqual(au["unfinished"]["candidates_unaccounted"], 3)
    def test_a_subset_a_foreign_id_a_repeated_id_or_another_category_s_id_blocks(self):
        ids = [self.c1["id"], self.c2["id"]]
        for name, lst in (("only one of two", ids[:1]), ("a foreign id added", ids + ["f" * 16]), ("a repeated id", ids + ids[:1]), ("the id of a candidate of category 3", ids + [self.c3["id"]]), ("an empty list", [])):
            with self.subTest(name):
                d = copy.deepcopy(self.doc); self.cats(d, 2).update(candidates=lst); js, path = self.written(self.t, d); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 1)
    def test_a_foreign_category_candidate_id_in_a_category_without_candidates_blocks(self):
        d = copy.deepcopy(self.doc); self.cats(d, 4).update(outcome="candidates", candidates=[self.c3["id"]]); js, path = self.written(self.t, d); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 1)
        d = copy.deepcopy(self.doc); self.cats(d, 4).update(outcome="no_candidate", candidates=[self.c1["id"]]); js, path = self.written(self.t, d); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 1)
    def test_malformed_or_extra_category_rows_block(self):
        for name, fn in (("a tenth row", lambda e: e["categories"].append(dict(category=2, outcome="no_candidate"))), ("category 0", lambda e: e["categories"][0].update(category=0)), ("category as a string", lambda e: e["categories"][0].update(category="1")), ("category as a bool", lambda e: e["categories"][0].update(category=True)),
                         ("a row that is a string", lambda e: e["categories"].__setitem__(0, "x")), ("two rows for one category", lambda e: e["categories"][1].update(category=1))):
            with self.subTest(name):
                d = copy.deepcopy(self.doc); fn(d["audit"]["evaluations"][0]); js, path = self.written(self.t, d); self.assertEqual(js["status"], "UNRESOLVED"); self.assertGreaterEqual(js["binding_summary"]["audit"]["unfinished"]["categories"], 1)

class EvaluationsAreCountedOnce(TA.Base):
    """Two checks of one evaluation are ONE evaluation: report level, write summary and evaluation summary count the unfinished work once per distinct write / hash / mode / run."""
    def decl(self, t): return [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]
    def counts(self, js):
        v = js["handoff"]["versions"][0]; f = lambda s: (s["binding_summary"]["audit"]["evaluations"], s["binding_summary"]["audit"]["unfinished"].get("chunks_missing", 0))
        return f(js), f(v), {m: f(e) for m, e in v["evaluations"].items()}

    def test_two_checks_of_one_evaluation_count_one_evaluation_and_one_missing_chunk_everywhere(self):
        t = self.session(n=6); t.verify("c2"); t.save(); checks = [self.at(t, "w1", "prefix", "c1", "p1"), self.at(t, "w1", "prefix", "c2", "p2")]
        d = AF.complete(self.raw(t, checks), max_chars=200); d["handoff"]["versions"] = self.decl(t); e = d["audit"]["evaluations"]; self.assertEqual(len(e), 1); e[0]["chunks"].pop(2)
        js, path = self.written(t, d); self.assertEqual(self.counts(js), ((1, 1), (1, 1), {"prefix": (1, 1)}))
    def test_two_runs_of_one_mode_are_two_evaluations_each_counted_once(self):
        t = RB.Tx(self.d)
        for i in range(2): t.user("request number %d %s" % (i, "x" * 120))
        t.write("w1", RB.V1); t.run("r1"); t.user("again " + "y" * 120); t.run("r2"); t.verify(); t.verify("c2"); t.save(); open(t.note, "w").write(RB.V1)
        checks = [self.at(t, "w1", "session_end", "c1", "p1", run="r1"), self.at(t, "w1", "session_end", "c2", "p2", run="r2"), self.at(t, "w1", "session_end", "c2", "p3", run="r2")]
        d = AF.complete(self.raw(t, checks), max_chars=200); d["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "session_end")]
        self.assertEqual(len(d["audit"]["evaluations"]), 2)
        for e in d["audit"]["evaluations"]: e["chunks"].pop(0)
        js, path = self.written(t, d); self.assertEqual(self.counts(js), ((2, 2), (2, 2), {"session_end": (2, 2)}))
    def test_a_fail_with_unfinished_work_counts_once_per_distinct_evaluation(self):
        r = TA.Registry(); r.d = self.d; r.n = 40; t, calls, ref = r.retro(); checks, fs = r.pair(t, calls, ref); doc = r.doc(t, checks, fs); doc["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]
        self.assertEqual({c["version_ref"]["evaluated_against"] for c in checks}, {"prefix"}); doc["audit"]["evaluations"][0]["chunks"][0]["reviewed"] = False
        js, path = r.written(t, doc, calls); self.assertEqual(js["status"], "FAIL"); v = js["handoff"]["versions"][0]
        self.assertEqual((js["binding_summary"]["audit"]["evaluations"], js["binding_summary"]["audit"]["unfinished"]["chunks_unreviewed"]), (1, 1))
        self.assertEqual((v["binding_summary"]["audit"]["evaluations"], v["binding_summary"]["audit"]["unfinished"]["chunks_unreviewed"]), (1, 1)); self.assertEqual(v["audited_status"], "FAIL")
        e = v["evaluations"]["prefix"]; self.assertEqual((e["audited_status"], e["binding_summary"]["audit"]["evaluations"], e["binding_summary"]["audit"]["unfinished"]["chunks_unreviewed"]), ("FAIL", 1, 1))
    def test_genuinely_different_evaluations_are_not_merged(self):
        t = self.session(n=6); t.verify("c2"); t.save(); checks = [self.at(t, "w1", "prefix", "c1", "p1"), self.at(t, "w1", "session_end", "c2", "p2")]
        d = AF.complete(self.raw(t, checks), max_chars=200); d["handoff"]["versions"] = self.decl(t)
        for e in d["audit"]["evaluations"]: e["chunks"].pop(1)
        js, path = self.written(t, d); self.assertEqual(self.counts(js), ((2, 2), (2, 2), {"prefix": (1, 1), "session_end": (1, 1)}))

class CallerLevel(TA.Base):
    """Regressions at the CALLER level (fix 7): the report writer and the delivery gate reach jevref.bind, so a verdict outside the contract of its tool is bound to a real call and never resolved on those surfaces; the CLI entry points run in-process."""
    def session(self, verdict):
        t = RB.Tx(self.d); t.user("a request " + "x" * 100); t.write("w1", RB.V1)
        t.tool("c1", "mcp__jev__jev_verify", dict(claims=[RB.CLAIM], evidence=[dict(text="Friday is the date.")]), CF.verify_body([dict(claim=RB.CLAIM, verdict=verdict, confidence=0.99)], compatible_synthetic=True, negative=verdict == "supported"))
        t.save(); open(t.note, "w").write(RB.V1); return t
    def report_for(self, verdict):
        t = self.session(verdict); doc = AF.complete(self.raw(t, [dict(self.check(t, "w1", "prefix"), verdict=verdict)])); js, path = self.written(t, doc); return t, js, path

    def test_a_verdict_outside_the_contract_binds_but_never_resolves_in_the_writer_and_the_gate(self):
        for verdict, resolved in (("verified", True), ("supported", False)):
            with self.subTest(verdict):
                t, js, path = self.report_for(verdict); b = js["checks"][0]["binding"]; self.assertEqual((b["bound"], b["resolved"]), (True, resolved)); self.assertEqual(js["binding_summary"]["resolved"], int(resolved))
                if not resolved: self.assertIn("contract_reason", b); self.assertEqual(js["status"], "UNRESOLVED")
                g = self.gate(t, js); self.assertEqual(g["bound_checks_for_version"], 1); self.assertEqual(g["audited_status"], js["status"], g["reasons"]); self.assertEqual(g["delivery_state"], "verified_version")
                self.assertNotEqual(g["audited_status"], "PASS") if not resolved else None

    def test_the_cli_status_entry_points_run_in_process(self):
        t, js, path = self.report_for("verified"); code, out = inproc(versions, ["status", "--session", t.log, "--file", t.note, "--report", path, "--cwd", self.d]); o = json.loads(out)
        self.assertEqual((code, o["delivery_state"], o["audited_status"]), (0, "verified_version", js["status"])); self.assertEqual(o["audit"]["unfinished"], js["binding_summary"]["audit"]["unfinished"])
        stripped = dict(js); stripped.pop("kit"); p = os.path.join(self.d, "stripped.json"); json.dump(stripped, open(p, "w"))
        code, out = inproc(versions, ["status", "--session", t.log, "--file", t.note, "--report", p, "--cwd", self.d]); self.assertEqual((code, json.loads(out)["delivery_state"]), (3, "unresolved"))

    def test_the_audit_template_prepare_and_prepare_batch_establish_and_associate_in_process(self):
        t = TA.Base.session(self, n=2); reg = A.registry_path_of(t.log); base = ["--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", self.d]
        code, out = inproc(prepare, [t.log, "--cwd", self.d]); self.assertEqual(code, 0, out); self.assertEqual(A.load_registry(reg)[0]["established"], [])      # prepare creates the empty registry
        led = os.path.join(self.d, "ledger.json"); code, out = inproc(A, ["template", "--ledger", led] + base); o = json.loads(out); self.assertEqual((code, o["ok"], o["registry"]), (0, True, reg))
        doc = A.load_registry(reg)[0]; self.assertEqual((len(doc["established"]), doc["ledgers"]), (1, [os.path.realpath(led)]))
        spec = os.path.join(self.d, "spec.json"); json.dump([dict(detail="request number 0", source_quote="request number 0", write_id="w1", evaluated_against="prefix")], open(spec, "w")); led2 = os.path.join(self.d, "ledger2.json")
        code, out = inproc(omissions, ["prepare-batch", "--source", t.log, "--file", t.note, "--spec", spec, "--cwd", self.d, "--ledger", led2]); self.assertIn(code, (0, 3), out)
        self.assertIn(os.path.realpath(led2), A.load_registry(reg)[0]["ledgers"])

if __name__ == "__main__": unittest.main()

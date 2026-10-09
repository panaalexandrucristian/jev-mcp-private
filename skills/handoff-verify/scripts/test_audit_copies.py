#!/usr/bin/env python3
"""Offline regressions of the council's fixes 2 and 3 of round 3 on the mandatory audit (stdlib only, invented sessions, no Jev call, never reads .handoff-verify/). Every case is judged on EVERY surface that certifies: the report writer
(report.write_report), the persisted report read back, the delivery gate (versions.gate), the CLI (`versions.py status`) and the per-version summaries (handoff.versions[]).
 - CopiesShareTheAccounting: the accounting of a session (its candidate registry, its ledger associations) does not depend on WHICH representation of the session an evaluation input names. A byte-identical copy of the transcript (versions.same_session) that
   is the calls log, or the transcript the report names, brings its own registry: the registries of the representations the inputs demonstrate are merged, so an established EMPTY registry of one never erases work registered against the other,
   in both directions; an unrelated session with the same write id and bytes is never merged in, and a malformed or foreign registry of a representation fails closed;
 - SharedLedgerIsolatesSessions: an omission ledger shared by several sessions (`omissions.py prepare-batch` over several sources) counts, for each session, only the obligations of THAT session (a row whose source is demonstrably another session is excluded
   before the merge); a row whose source is withheld, absent or unresolvable is not demonstrated unrelated and keeps counting; a row prepared against a representation of the same session counts.
usage: python3 -B test_audit_copies.py [-v]"""
import copy, json, os, shutil, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A, versions
import audit_fixtures as AF
import identity_world as IW
import ledger as L
import test_audit as TA
import test_audit_fixes as TF
import test_run_binding as RB

OTHER, Q1, Q2 = TA.OTHER, TA.Q1, TA.Q2
REQ = "request number 0"      # a sentence of the first user request of `TA.Base.session`

class Rep:
    """One representation of a session: the transcript path and the note."""
    def __init__(self, log, note): self.log, self.note = log, note

def cli(script, args, cwd=None, stdin=None): return TA.cli(script, args, cwd, stdin)

class Judged(TA.Base):
    """The same report judged by the writer, the persisted file, the gate, the CLI and the per-version summaries."""
    def judge(self, calls, doc, status, counter=None, n=1, exact=None, delivery="verified_version", mode="session_end"):
        js, path = self.written(calls, doc); au = js["binding_summary"]["audit"]
        self.assertEqual(js["status"], status, js["binding_summary"]["reasons"]); self.assertEqual(au["complete"], status == "PASS", au)
        if counter: self.assertGreaterEqual(au["unfinished"].get(counter, 0), n, au)
        if exact is not None: self.assertEqual(au["unfinished"].get(counter, 0), exact, au)
        again = json.load(open(path, encoding="utf-8")); self.assertEqual((again["status"], again["binding_summary"]["audit"]), (js["status"], au))      # the persisted report says the same
        g = self.gate(calls, again); self.assertEqual((g["audited_status"], g["delivery_state"]), (status, delivery), g["reasons"]); self.assertEqual(g["audit"]["unfinished"], au["unfinished"])
        code, out = cli("versions.py", ["status", "--session", calls.log, "--file", calls.note, "--report", path, "--cwd", self.d]); o = json.loads(out)
        self.assertEqual((o["audited_status"], o["delivery_state"]), (status, delivery)); self.assertEqual(o["audit"]["unfinished"], au["unfinished"]); self.assertEqual(code, 0 if delivery == "verified_version" else 3)
        for v in js["handoff"]["versions"]:      # the write summary and its evaluation (per-version surface)
            self.assertEqual(v["audited_status"], status, v["binding_summary"]); self.assertEqual(v["evaluations"][mode]["audited_status"], status)
            if counter and exact is not None: self.assertEqual(v["evaluations"][mode]["binding_summary"]["audit"]["unfinished"].get(counter, 0), exact)
        return js, path

class CopyWorld(Judged):
    """One session (`orig`), a byte-identical copy of it (`cp`) and the helpers that judge a report about it."""
    def setUp(self):
        super().setUp(); self.t = self.session(n=2); self.orig = self.t; self.copy = os.path.join(self.d, "copy", "session.jsonl"); os.makedirs(os.path.dirname(self.copy)); shutil.copyfile(self.t.log, self.copy)
        self.cp = Rep(self.copy, self.t.note); self.assertTrue(versions.same_session(self.t.log, self.copy)); self.assertNotEqual(A.registry_path_of(self.t.log), A.registry_path_of(self.copy))
        self.v = versions.versions_of(self.t.log, self.t.note)[0][0]; self.k = ("w1", self.v["sha256"], "session_end", None)
    def doc(self, named, source, run=None, **kw):
        """A COMPLETE report about the session: `named` = the transcript its session.jsonl names, `source` = the transcript the writer and the gate audit (the calls log). `run` = the verification run the evaluation names (a ledger row is about a run)."""
        d = self.raw(self.t, [self.check(self.t, "w1", "session_end", **({"run": run} if run else {}))]); d["session"]["jsonl"] = named.log; d["handoff"]["versions"] = [IW.VROW(self.v, 1, "session_end")]
        return AF.complete(d, source=source.log, **kw)
    def register(self, rep, detail=OTHER):
        return A.register(A.registry_path_of(rep.log), A.D.canon(rep.log), self.k, detail, 2)[0]

class CopiesShareTheAccounting(CopyWorld):
    def test_the_control_a_copy_with_no_registered_work_passes_in_both_directions(self):
        self.judge(self.cp, self.doc(self.orig, self.cp), "PASS"); self.judge(self.orig, self.doc(self.cp, self.orig), "PASS")

    def test_a_candidate_registered_against_the_original_is_not_hidden_by_the_empty_registry_of_the_copy(self):
        self.register(self.orig); d = self.doc(self.orig, self.cp)      # the calls log is the copy (its registry: established, empty); the report still names the original
        self.assertEqual(A.load_registry(A.registry_path_of(self.copy))[0]["candidates"], []); js, path = self.judge(self.cp, d, "UNRESOLVED", "candidates_unaccounted", exact=1)
        self.assertIn("registered candidate", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_a_candidate_registered_against_the_copy_is_not_hidden_by_the_empty_registry_of_the_original(self):
        self.register(self.cp); d = self.doc(self.cp, self.orig)      # the calls log is the original (its registry: established, empty); the report names the copy
        self.assertEqual(A.load_registry(A.registry_path_of(self.t.log))[0]["candidates"], []); self.judge(self.orig, d, "UNRESOLVED", "candidates_unaccounted", exact=1)

    def test_the_candidate_of_either_representation_counts_once_when_both_registered_it(self):
        self.register(self.orig); self.register(self.cp); self.judge(self.cp, self.doc(self.orig, self.cp), "UNRESOLVED", "candidates_unaccounted", exact=1)

    def test_the_writer_who_audits_the_original_alone_still_sees_the_original_work(self):
        self.register(self.orig); self.judge(self.orig, self.doc(self.orig, self.orig), "UNRESOLVED", "candidates_unaccounted", exact=1)      # (the original writer was never bypassed: the copies must agree with it)

    def test_the_ledger_associated_with_the_original_is_not_erased_by_the_copy(self):
        led = os.path.join(self.d, "ledger.json"); spec = json.dumps([dict(detail=REQ, source_quote=REQ, write_id="w1", evaluated_against="session_end", source=self.t.log)])
        self.assertEqual(cli("omissions.py", ["prepare-batch", "--source", self.t.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", led], self.d, spec)[0], 0)
        self.assertEqual(A.load_registry(A.registry_path_of(self.t.log))[0]["ledgers"], [os.path.realpath(led)]); self.assertEqual(A.load_registry(A.registry_path_of(self.copy)), (None, "the candidate registry is unreadable (FileNotFoundError)"))
        js, path = self.judge(self.cp, self.doc(self.orig, self.cp, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1); self.assertIn("ledger:prepared", " ".join(js["binding_summary"]["audit"]["reasons"]))
        again = self.doc(self.cp, self.orig, "r1"); self.judge(self.orig, again, "UNRESOLVED", "candidates_unaccounted", exact=1)      # the row's source is the original: it is the audited session itself

    def test_the_ledger_prepared_against_the_copy_counts_when_the_report_names_the_copy(self):
        led = os.path.join(self.d, "ledger.json"); spec = json.dumps([dict(detail=REQ, source_quote=REQ, write_id="w1", evaluated_against="session_end", source=self.copy)])
        self.assertEqual(cli("omissions.py", ["prepare-batch", "--source", self.copy, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", led], self.d, spec)[0], 0)
        self.judge(self.orig, self.doc(self.cp, self.orig, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1)      # the row's source is a representation of the audited session (same_session): not another session

    def test_a_registry_of_an_unrelated_session_with_the_same_write_id_and_bytes_is_never_merged_in(self):
        o = RB.Tx(self.d); o.log = os.path.join(self.d, "unrelated.jsonl"); o.user("another session " + "x" * 100); o.write("w1", RB.V1); o.verify("c9"); [r.update(sessionId="s9") for r in o.recs]; o.save()
        self.assertFalse(versions.same_session(o.log, self.t.log)); ov = versions.versions_of(o.log, o.note)[0][0]; self.assertEqual(ov["sha256"], self.v["sha256"])
        A.register(A.registry_path_of(o.log), A.D.canon(o.log), self.k, OTHER, 2)      # (the same write id and bytes: only the session differs)
        self.judge(self.cp, self.doc(self.orig, self.cp), "PASS"); self.judge(self.orig, self.doc(self.cp, self.orig), "PASS")

    def test_a_malformed_or_foreign_registry_of_a_representation_fails_closed(self):
        for kind in ("malformed", "foreign"):
            for bad, calls, named in (("original", self.cp, self.orig), ("copy", self.orig, self.cp)):      # the registry of the representation that the inputs demonstrate but the audit does not start from, and of the one it starts from
                for victim in (self.orig, self.cp):
                    with self.subTest(kind=kind, victim="original" if victim is self.orig else "copy", calls="copy" if calls is self.cp else "original"):
                        d = self.doc(named, calls); [A.establish(A.registry_path_of(r.log), A.D.canon(r.log), self.k) for r in (self.orig, self.cp)]      # both registries exist, established and empty
                        path = A.registry_path_of(victim.log); good = open(path, encoding="utf-8").read()
                        if kind == "malformed": open(path, "w").write("{bad")
                        else: json.dump(dict(A.empty_registry("/elsewhere.jsonl"), established=[A.dict_of(self.k)]), open(path, "w"))
                        try: self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", exact=1)
                        finally: open(path, "w").write(good)

    def test_naming_the_registry_of_a_representation_is_not_a_substitution_but_a_foreign_one_is(self):
        d = self.doc(self.orig, self.cp); d["audit"]["registry"] = A.registry_path_of(self.orig.log); js, path = self.judge(self.cp, d, "PASS")
        d = self.doc(self.orig, self.cp); foreign = os.path.join(self.d, "foreign", "registry.json"); A.save_registry(foreign, dict(A.empty_registry(A.D.canon(self.t.log)), established=[A.dict_of(self.k)])); d["audit"]["registry"] = foreign
        js, path = self.judge(self.cp, d, "UNRESOLVED", "candidates_unaccounted", exact=1); self.assertIn("substituted", " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_the_context_is_given_the_other_representation_by_the_writer_and_the_gate(self):
        seen = []; real = A.Context.__init__
        def spy(self, *a, **k): seen.append(self_also(a, k)); real(self, *a, **k)
        def self_also(a, k): return (list(a[11]) if len(a) > 11 else list(k.get("also", ())))
        A.Context.__init__ = spy
        try: self.judge(self.cp, self.doc(self.orig, self.cp), "PASS")
        finally: A.Context.__init__ = real
        self.assertTrue(seen and all(x == [self.orig.log] for x in seen), seen)      # report.bind_report and versions.gate (and the per-version summaries share the context) name the report's transcript as the other representation

    def prepare_ledger(self, source, ledger):
        spec = json.dumps([dict(detail=REQ, source_quote=REQ, write_id="w1", evaluated_against="session_end", source=source.log)])
        self.assertEqual(cli("omissions.py", ["prepare-batch", "--source", source.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", ledger], self.d, spec)[0], 0)

    def test_a_missing_registry_of_a_demonstrated_representation_is_missing_accounting_in_both_directions(self):
        """The council's round-4 fix 1: the candidate registered against one representation, an established EMPTY registry of the other, the registry of the first removed: nothing stands in for the lost accounting."""
        for calls, named in ((self.cp, self.orig), (self.orig, self.cp)):
            for lost in (self.orig, self.cp):
                with self.subTest(calls="copy" if calls is self.cp else "original", lost="original" if lost is self.orig else "copy"):
                    d = self.doc(named, calls); self.register(lost); self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", exact=1)      # before: the candidate blocks
                    path = A.registry_path_of(lost.log); good = open(path, encoding="utf-8").read(); os.unlink(path)
                    try:
                        js, _ = self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", n=1); self.assertIn("has no established candidate registry", " ".join(js["binding_summary"]["audit"]["reasons"]) + " ".join(js["binding_summary"]["reasons"]))
                    finally: open(path, "w", encoding="utf-8").write(good)
                    self.assertEqual(self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", exact=1)[0]["status"], "UNRESOLVED")

    def test_without_any_registered_work_a_missing_registry_of_a_representation_still_blocks_the_pass(self):
        for calls, named in ((self.cp, self.orig), (self.orig, self.cp)):
            for lost in (self.orig, self.cp):
                with self.subTest(calls="copy" if calls is self.cp else "original", lost="original" if lost is self.orig else "copy"):
                    d = self.doc(named, calls); path = A.registry_path_of(lost.log); good = open(path, encoding="utf-8").read(); os.unlink(path)
                    try: self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", n=1)
                    finally: open(path, "w", encoding="utf-8").write(good)
                    self.judge(calls, d, "PASS")      # both established again: a demonstrated empty accounting is a valid zero

    def test_a_ledger_association_lost_with_the_registry_of_a_representation_is_not_restored_by_the_other(self):
        led = os.path.join(self.d, "ledger.json"); self.prepare_ledger(self.orig, led)
        for calls, named in ((self.cp, self.orig), (self.orig, self.cp)):
            with self.subTest(calls="copy" if calls is self.cp else "original"):
                d = self.doc(named, calls, "r1"); path = A.registry_path_of(self.orig.log); good = open(path, encoding="utf-8").read(); os.unlink(path)      # the original's registry (and with it the ledger association) is gone; the other is established and empty
                try: js, _ = self.judge(calls, d, "UNRESOLVED", "candidates_unaccounted", n=1); self.assertIn("has no established candidate registry", " ".join(js["binding_summary"]["audit"]["reasons"]))
                finally: open(path, "w", encoding="utf-8").write(good)

    def test_the_helper_is_given_the_missing_registry_as_a_reason_next_to_the_merged_document(self):
        self.register(self.orig); d = self.doc(self.orig, self.cp); os.unlink(A.registry_path_of(self.orig.log))
        ctx = A.Context(d, [], [], [], self.cp.log, self.t.note, also=[self.orig.log]); reg, why = ctx.registry_state(A.plan_of(self.cp.log, self.t.note, A.CHUNK_CHARS))
        self.assertIsNotNone(reg); self.assertIn("has no established candidate registry", why)

class UndemonstratedSourcesStillCount(CopyWorld):
    """The council's round-4 fix 2: the failure of `versions.same_session` is not proof of ANOTHER session (it is also false when an identity cannot be shown). A ledger row whose source is empty, malformed, metadata-deficient or otherwise
    undemonstrated keeps counting; only a source that is positively another session is not this session's work."""
    def setUp(self):
        super().setUp(); self.led = os.path.join(self.d, "ledger.json"); self.prepare_ledger(self.cp, self.led); A.associate_session_ledger(self.orig.log, self.led); self.assertTrue(versions.same_session(self.copy, self.orig.log))      # the row is about the copy; the original's registry holds the association
    def prepare_ledger(self, source, ledger):
        spec = json.dumps([dict(detail=REQ, source_quote=REQ, write_id="w1", evaluated_against="session_end", source=source.log)])
        self.assertEqual(cli("omissions.py", ["prepare-batch", "--source", source.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d, "--ledger", ledger], self.d, spec)[0], 0)
    def replace_copy(self, text): open(self.copy, "w", encoding="utf-8").write(text)
    def key(self): return ("w1", self.v["sha256"], "session_end", "r1")
    def deficient(self):
        sid = json.loads(open(self.t.log, encoding="utf-8").readline()).get("sessionId") or "s1"
        return {"empty": "", "malformed": "{not json\n[1,\n", "no_metadata": json.dumps(dict(type="user", message=dict(content="hello"))) + "\n", "no_tool_uses": json.dumps(dict(type="user", sessionId=sid, message=dict(content="hello"))) + "\n",
                "blank_lines": "\n\n"}

    def test_the_control_the_valid_copy_is_the_session_and_its_row_counts(self):
        self.assertFalse(A.unrelated_source(A.D.canon(self.copy), [A.D.canon(self.orig.log)])); self.judge(self.orig, self.doc(self.orig, self.orig, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1)

    def test_an_empty_malformed_or_metadata_deficient_source_is_not_demonstrated_unrelated_and_counts_on_every_surface(self):
        for name, text in self.deficient().items():
            with self.subTest(name):
                self.replace_copy(text); self.assertFalse(versions.same_session(self.copy, self.orig.log)); self.assertFalse(versions.distinct_sessions(self.copy, self.orig.log))
                self.assertFalse(A.unrelated_source(A.D.canon(self.copy), [A.D.canon(self.orig.log)]))
                rows, _ = A.ledger_candidates(self.led, self.key(), os.path.realpath(self.t.note), [A.D.canon(self.orig.log)]); self.assertEqual(len(rows), 1)
                js, _ = self.judge(self.orig, self.doc(self.orig, self.orig, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1); self.assertIn("ledger:prepared", " ".join(js["binding_summary"]["audit"]["reasons"]))
                code, out = TF.inproc(A, ["template", "--source", self.orig.log, "--file", self.t.note, "--write-id", "w1", "--evaluated-against", "session_end", "--run", "r1", "--cwd", self.d]); self.assertEqual(code, 0, out); self.assertEqual(len(json.loads(out)["expected_candidates"]), 1, out)
                shutil.copyfile(self.orig.log, self.copy)

    def test_a_source_that_cannot_be_read_at_all_still_counts(self):
        os.unlink(self.copy); self.assertFalse(A.unrelated_source(A.D.canon(self.copy), [A.D.canon(self.orig.log)]))
        self.judge(self.orig, self.doc(self.orig, self.orig, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1)

    def test_a_copy_that_no_longer_matches_the_session_but_shares_its_id_is_not_demonstrated_unrelated(self):
        """A copy whose tool uses were altered (the stored identity of the row is invalidated by the content, not by another session id): same_session is false, but nothing shows another session."""
        recs = [json.loads(x) for x in open(self.orig.log, encoding="utf-8") if x.strip()]; changed = 0
        for r in recs:
            for b in (r.get("message") or {}).get("content", []) if isinstance((r.get("message") or {}).get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_use": b["input"] = dict(b.get("input") or {}, altered="x"); changed += 1
        self.assertTrue(changed); self.replace_copy("".join(json.dumps(r) + "\n" for r in recs))
        self.assertFalse(versions.same_session(self.copy, self.orig.log)); self.assertFalse(versions.distinct_sessions(self.copy, self.orig.log)); self.assertFalse(A.unrelated_source(A.D.canon(self.copy), [A.D.canon(self.orig.log)]))
        self.judge(self.orig, self.doc(self.orig, self.orig, "r1"), "UNRESOLVED", "candidates_unaccounted", exact=1)

    def test_the_distinct_session_control_is_demonstrated_and_its_row_does_not_count(self):
        o = RB.Tx(self.d); o.log = os.path.join(self.d, "distinct.jsonl"); o.user("another session " + "x" * 100); o.write("w1", RB.V1); o.verify("c9"); [r.update(sessionId="s9") for r in o.recs]; o.save()
        shutil.copyfile(o.log, self.copy); self.assertFalse(versions.same_session(self.copy, self.orig.log)); self.assertTrue(versions.distinct_sessions(self.copy, self.orig.log))
        self.assertTrue(A.unrelated_source(A.D.canon(self.copy), [A.D.canon(self.orig.log)])); self.judge(self.orig, self.doc(self.orig, self.orig, "r1"), "PASS")

    def test_distinct_sessions_needs_positive_evidence_on_both_sides(self):
        a, b = self.orig.log, self.copy
        self.assertFalse(versions.distinct_sessions(a, a)); self.assertFalse(versions.distinct_sessions(a, b)); self.assertFalse(versions.distinct_sessions(a, os.path.join(self.d, "nope.jsonl"))); self.assertFalse(versions.distinct_sessions(None, a)); self.assertFalse(versions.distinct_sessions(a, ""))
        self.assertFalse(A.unrelated_source(A.D.canon(a), [])); self.assertFalse(A.unrelated_source(None, [a])); self.assertFalse(A.unrelated_source("withheld:sha256:" + "0" * 64, [a]))

class SharedLedgerIsolatesSessions(Judged):
    """Two DISTINCT sessions with the same note path, write id w1, note bytes and prefix mode; one ledger prepared over both by a single `prepare-batch`."""
    def setUp(self):
        super().setUp(); self.ledger = os.path.join(self.d, "ledger.json")
        def build(name, quote, sid):
            t = RB.Tx(self.d); t.log = os.path.join(self.d, name + ".jsonl"); t.user("intro"); t.user(quote); t.write("w1", RB.V1); t.run("r1"); t.verify(); [r.update(sessionId=sid) for r in t.recs]; t.save(); return t
        self.t1, self.t2 = build("session-one", Q1, "s-one"), build("session-two", Q2, "s-two"); open(self.t1.note, "w").write(RB.V1)
        self.assertFalse(versions.same_session(self.t1.log, self.t2.log)); self.assertEqual(versions.versions_of(self.t1.log, self.t1.note)[0][0]["sha256"], versions.versions_of(self.t2.log, self.t2.note)[0][0]["sha256"])
    def item(self, source, quote, **kw): return dict(dict(detail=quote, source_quote=quote, write_id="w1", evaluated_against="prefix", source=source), **kw)
    def batch(self, *items):
        return cli("omissions.py", ["prepare-batch", "--source", self.t1.log, "--file", self.t1.note, "--spec", "-", "--cwd", self.d, "--ledger", self.ledger], self.d, json.dumps(list(items)))
    def doc(self, t):
        d = self.raw(t, [self.check(t, "w1", "prefix")]); d["handoff"]["versions"] = [IW.VROW(versions.versions_of(t.log, t.note)[0][0], 1, "prefix")]; return AF.complete(d)
    def judge_both(self, expected, reason="ledger:prepared"):
        for t in (self.t1, self.t2):
            js, path = self.judge(t, self.doc(t), "UNRESOLVED", "candidates_unaccounted", exact=expected, mode="prefix"); self.assertIn(reason, " ".join(js["binding_summary"]["audit"]["reasons"]))

    def test_each_session_counts_only_its_own_obligation_of_the_shared_ledger(self):
        code, out = self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2)); self.assertEqual(code, 0, out)
        rows = L.load(self.ledger)["obligations"]; self.assertEqual(len(rows), 2); self.assertEqual({r["state"] for r in rows}, {"prepared"}); self.assertEqual({r["identity"]["source"] for r in rows}, {A.D.canon(self.t1.log), A.D.canon(self.t2.log)})
        for t in (self.t1, self.t2): self.assertEqual(A.load_registry(A.registry_path_of(t.log))[0]["ledgers"], [os.path.realpath(self.ledger)])      # the ledger is associated with both sessions
        self.judge_both(1)

    def test_the_helper_applies_the_source_to_the_rows_directly(self):
        self.assertEqual(self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2))[0], 0); sha = versions.versions_of(self.t1.log, self.t1.note)[0][0]["sha256"]; k = ("w1", sha, "prefix", None); note = os.path.realpath(self.t1.note)
        both, why = A.ledger_candidates(self.ledger, k, note); self.assertEqual((len(both), why), (2, None))      # without a source nothing is excluded for it
        one, _ = A.ledger_candidates(self.ledger, k, note, [A.D.canon(self.t1.log)]); self.assertEqual(len(one), 1)
        two, _ = A.ledger_candidates(self.ledger, k, note, [A.D.canon(self.t2.log)]); self.assertEqual(len(two), 1); self.assertNotEqual(one[0]["id"], two[0]["id"])
        self.assertEqual(len(A.ledger_candidates(self.ledger, k, note, [A.D.canon(self.t1.log), A.D.canon(self.t2.log)])[0]), 2)      # a report that demonstrates both representations is about both

    def test_an_obligation_whose_source_cannot_be_resolved_is_not_demonstrated_unrelated_and_counts_for_every_session(self):
        code, out = self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2), self.item(os.path.join(self.d, "gone.jsonl"), "a detail of a session that is gone")); self.assertEqual(code, 3, out)
        rows = L.load(self.ledger)["obligations"]; self.assertEqual(sorted(r["state"] for r in rows), ["prepared", "prepared", "unavailable"])
        self.judge_both(2, "ledger:unavailable")      # its own prepared obligation + the unavailable one, never the other session's prepared one

    def test_a_withheld_source_is_not_demonstrated_unrelated_either(self):
        self.assertEqual(self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2), self.item(os.path.join(self.d, "gone.jsonl"), "a detail of a session that is gone"))[0], 3)
        doc = L.load(self.ledger); row = next(r for r in doc["obligations"] if r["state"] == "unavailable"); row["identity"]["source"] = L._withheld(row["identity"]["source"]); row["id"] = L.obligation_id(row["identity"])
        json.dump(doc, open(self.ledger, "w")); self.judge_both(2, "ledger:unavailable")

    def test_an_invalidated_obligation_of_the_session_still_counts_and_that_of_another_does_not(self):
        self.assertEqual(self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2))[0], 0)
        doc = L.load(self.ledger)
        for r in doc["obligations"]: r["state"] = "prepared"      # (a row is `invalidated` only when `resume` re-reads it; its identity stays: the audit counts every state of THIS session's rows)
        self.judge_both(1)

    def test_a_ledger_of_a_copy_of_the_session_is_the_session_s_own(self):
        copy_path = os.path.join(self.d, "copy-of-one.jsonl"); shutil.copyfile(self.t1.log, copy_path); self.assertTrue(versions.same_session(copy_path, self.t1.log))
        self.assertEqual(self.batch(self.item(copy_path, Q1), self.item(self.t2.log, Q2))[0], 0); sha = versions.versions_of(self.t1.log, self.t1.note)[0][0]["sha256"]; k = ("w1", sha, "prefix", None); note = os.path.realpath(self.t1.note)
        self.assertEqual(len(A.ledger_candidates(self.ledger, k, note, [A.D.canon(self.t1.log)])[0]), 1)      # the copy is the same session as t1: its row counts for t1 and the second session's does not
        self.assertEqual(len(A.ledger_candidates(self.ledger, k, note, [A.D.canon(self.t2.log)])[0]), 1)

    def test_the_audit_cli_template_lists_only_the_expected_work_of_its_own_session(self):
        self.assertEqual(self.batch(self.item(self.t1.log, Q1), self.item(self.t2.log, Q2))[0], 0)
        for t, quote in ((self.t1, Q1), (self.t2, Q2)):
            code, out = TF.inproc(A, ["template", "--source", t.log, "--file", t.note, "--write-id", "w1", "--evaluated-against", "prefix", "--cwd", self.d]); o = json.loads(out)      # (in this process: the caller table's reach check sees `audit.main`)
            self.assertEqual((code, o["ok"], len(o["expected_candidates"])), (0, True, 1), out)

if __name__ == "__main__": unittest.main()

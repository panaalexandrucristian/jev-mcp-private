#!/usr/bin/env python3
"""Offline test of the collection and the authorization for the two halves of an omission pair (R04; stdlib only, no Jev call, no network, never reads the real .handoff-verify/). The generic rule (keep every original evidence entry,
add the new ones) is the opposite of what the pair needs: the evidence of the SOURCE call must be EXACTLY one eligible record of the session (jevref.validate_finding: passage_matches) and the evidence of the ABSENCE call EXACTLY the
complete canonical material. So: an ABSENCE request is blocked and takes nothing; a SOURCE request takes ONE other eligible record of the session (a transcript_record, never a file, never a corrected claim), its payload is the
canonical SOURCE claim with that whole record as the only evidence (neighbours joined together, the old passage kept, a file or a changed claim are refused), and the user is not asked for a path (a path cannot be a record
of the session).
usage: python3 -B test_omission_evidence.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit as A, discover, evidence, jevref, omissions
import contract_fixtures as CF
import test_doc_end_to_end as E2E
import test_run_binding as RB

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SECRET = 'API_KEY="abcdefgh12345678"'

class Pair(E2E.Base):
    """Example 02 with a second user record that states the same constraint, before the write of the note: the window holds two eligible records, and the SOURCE call used the first one."""
    def setUp(self):
        super().setUp(); self.user, self.note, (self.detail, self.quote) = self.story(2)
        self.second = "Please remember, as a hard rule, " + self.quote + " and thank you."
        self.session()
    def session(self, extra_users=None, source_conf=0.9, absence_conf=0.98):
        t = RB.Tx(self.d); t.user(self.user)
        for u in (extra_users if extra_users is not None else [self.second]): t.user(u)
        t.write("w1", self.note); t.run("sk1"); t.save(); open(t.note, "w", encoding="utf-8").write(self.note); self.t = t
        self.p = self.prepared(self.detail, self.quote, t)
        t.tool("a1", "mcp__jev__jev_verify", dict(claims=[self.p["absence_claim"]], evidence=[dict(text=self.p["material"])]), CF.verify_body([dict(claim=self.p["absence_claim"], verdict="unsupported", confidence=absence_conf, action="auto")], compatible_synthetic=True))
        t.tool("s1", "mcp__jev__jev_verify", dict(claims=[self.p["source_claim"]], evidence=[dict(text=self.p["source_passage"])]), CF.verify_body([dict(claim=self.p["source_claim"], verdict="verified", confidence=source_conf)], compatible_synthetic=True))
        t.save(); self.register(self.detail); self.calls = jevref.load_calls(t.log); self.by = {c["tool_use_id"]: c for c in self.calls}
        self.rows = advice.session_advice(self.calls, history=(), version_ref=self.p["version_ref"])
    def request(self, tid="s1"): return next(r for r in self.rows if r["tool_use_id"] == tid)["advice"]["evidence_request"]
    def props(self, quote=None, uuid=None): return [dict(kind="transcript_record", quote=quote or self.second, **({"uuid": uuid} if uuid else {}))]
    def payload(self, text=None, claims=None): return dict(claims=claims or [self.p["source_claim"]], evidence=[dict(text=text if text is not None else self.second)])
    def authorize(self, payload=None, props=None, req=None):
        return evidence.authorize(req or self.request(), self.by["s1"], self.props() if props is None else props, payload or self.payload(), self.t.log)
    def history(self): return A.load_registry(A.registry_path_of(self.t.log))[0]["evidence_history"]

class Source(Pair):
    def test_the_request_is_a_source_request_for_another_record(self):
        r = self.request(); self.assertEqual((r["target"]["stage"], r["state"], r["allowed_sources"], r["target"]["version_ref"]), ("source", "collect_local", ["session_transcript"], self.p["version_ref"]))

    def test_another_eligible_record_is_collected_with_its_whole_passage(self):
        got = evidence.collect(self.request(), self.by["s1"], self.props(), self.t.log)
        self.assertEqual(got["rejected"], []); self.assertEqual(len(got["items"]), 1); it = got["items"][0]
        self.assertEqual((it["kind"], it["passage"], it["quote"]), ("transcript_record", self.second, self.second))
        self.assertEqual(evidence.advance(self.request(), got)["state"], "ready")

    def test_the_record_that_the_source_call_already_used_is_not_new(self):
        got = evidence.collect(self.request(), self.by["s1"], self.props(self.quote), self.t.log)
        self.assertEqual(got["items"], []); self.assertEqual([x["reason"] for x in got["rejected"]], ["not_new"])

    def test_files_and_a_corrected_claim_are_not_taken_for_a_source_request(self):
        f = os.path.join(self.d, "other.txt")
        with open(f, "w", encoding="utf-8") as h: h.write("a file that states: " + self.quote + "\n")
        got = evidence.collect(self.request(), self.by["s1"], [dict(kind="local_file", path=f), dict(kind="local_dir", path=self.d), dict(kind="corrected_claim", text="Something else.")], self.t.log)
        self.assertEqual(got["items"], []); self.assertIsNone(got["corrected_claim"])
        self.assertEqual([x["reason"] for x in got["rejected"]], ["source_stage_takes_transcript_records_only"] * 2 + ["source_stage_takes_no_corrected_claim"])

    def test_without_another_record_the_request_is_blocked_and_the_user_is_not_asked_for_a_path(self):
        for kw in ({}, {"headless": True}, {"asked": True}):
            got = evidence.collect(self.request(), self.by["s1"], [], self.t.log); r = evidence.advance(self.request(), got, **kw)
            self.assertEqual((r["state"], r["stop_reason"], r["question_ro"], r["retry_remaining"]), ("blocked", "no_other_eligible_record", None, 0)); self.assertEqual(r["rounds_used"], 0)
        self.assertIsNone(evidence.grouped_question([evidence.advance(self.request(), evidence.collect(self.request(), self.by["s1"], [], self.t.log))]))

    def test_a_record_that_holds_a_secret_is_ineligible_and_never_echoed(self):
        self.session([self.second + " " + SECRET]); got = evidence.collect(self.request(), self.by["s1"], self.props(self.second + " " + SECRET), self.t.log)
        self.assertEqual(got["items"], []); self.assertIn("redaction_dependent", [x["reason"] for x in got["rejected"]]); self.assertNotIn("abcdefgh12345678", json.dumps(got))

    def test_a_record_after_the_note_was_written_is_not_eligible(self):
        late = "Late reminder: " + self.quote + " (written after the note)"
        self.t.user(late); self.t.save(); self.calls = jevref.load_calls(self.t.log)
        got = evidence.collect(self.request(), self.by["s1"], self.props(late), self.t.log); self.assertEqual(got["items"], []); self.assertEqual([x["reason"] for x in got["rejected"]], ["not_in_eligible_source"])

class SourceAuthorize(Pair):
    def test_the_canonical_claim_with_the_whole_new_record_as_the_only_evidence_is_authorized(self):
        r = self.authorize(); self.assertEqual((r["authorized"], r["status"]), (True, "reserved"), r)
        self.assertEqual(self.history()[0]["input_hash"], jevref.input_hash(self.payload())); self.assertEqual(self.history()[0]["target"]["stage"], "source")
        self.assertEqual(evidence.check_authorization(self.request(), self.payload(), self.t.log), (True, None))

    def refused(self, why, **kw):
        r = self.authorize(**kw); self.assertEqual((r["authorized"], r["reason"]), (False, why), r); self.assertEqual(self.history(), [])

    def test_neighbouring_records_joined_together_are_refused(self):
        self.refused("source_evidence_not_one_eligible_record", payload=self.payload(self.p["source_passage"] + "\n" + self.second))
        self.refused("source_evidence_not_one_eligible_record", payload=self.payload(self.second + "\n" + self.user))

    def test_keeping_the_old_passage_next_to_the_new_one_is_refused(self):
        p = self.payload(); p["evidence"] = [dict(text=self.p["source_passage"]), dict(text=self.second)]
        self.refused("source_evidence_not_one_eligible_record", payload=p)

    def test_a_part_of_the_record_a_file_text_or_the_old_passage_alone_are_refused(self):
        for text in (self.second[:30], "text from a file that is not a record", self.p["source_passage"], self.second + " "):
            with self.subTest(text[:20]): self.refused("source_evidence_not_one_eligible_record", payload=self.payload(text))

    def test_the_claim_must_be_exactly_the_canonical_source_claim(self):
        self.refused("source_claim_not_canonical", payload=self.payload(claims=["The supplied source passage states this detail: Something else."]))
        self.refused("source_claim_not_canonical", payload=self.payload(claims=[self.p["source_claim"], "A second claim."]))
        r = self.authorize(payload=self.payload(claims=["  " + self.p["source_claim"].replace(" ", "  ") + " "])); self.assertTrue(r["authorized"], r)      # whitespace is not a different claim

    def test_a_used_up_source_request_is_exhausted_and_cannot_be_reset(self):
        self.assertTrue(self.authorize()["authorized"]); doc = A.load_registry(A.registry_path_of(self.t.log))[0]
        doc["evidence_history"][0].update(state="recorded", recorded_ref=dict(tool_use_id="s2", result_index=None, key=None)); A.save_registry(A.registry_path_of(self.t.log), doc)
        rows = advice.session_advice(self.calls, history=self.history(), version_ref=self.p["version_ref"]); req = next(r for r in rows if r["tool_use_id"] == "s1")["advice"]["evidence_request"]
        self.assertEqual((req["state"], req["stop_reason"]), ("exhausted", "reverification_used"))
        r = self.authorize(req=req); self.assertEqual((r["authorized"], r["reason"]), (False, "not_ready"))

class Absence(Pair):
    def test_the_absence_request_takes_nothing_and_cannot_be_authorized(self):
        self.session(absence_conf=0.9)                                              # an ABSENCE result that does not qualify
        e = jevref.results_of(self.by["a1"])[0][0]; a = advice.omission_advise("absence", e, self.by["a1"], True)     # the report knows the canonical material, the log alone does not
        req = advice.evidence_request(e, self.by["a1"], a, history=(), version_ref=self.p["version_ref"], stage="absence")
        self.assertEqual((req["state"], req["stop_reason"], req["allowed_sources"]), ("blocked", "absence_material_unchanged", []))
        got = evidence.collect(req, self.by["a1"], [dict(kind="transcript_record", quote=self.second), dict(kind="local_dir", path=self.d), dict(kind="corrected_claim", text="x")], self.t.log)
        self.assertEqual(got["items"], []); self.assertIsNone(got["corrected_claim"]); self.assertEqual({x["reason"] for x in got["rejected"]}, {"stage_takes_no_new_evidence"})
        r = evidence.authorize(req, self.by["a1"], self.props(), dict(claims=[self.p["absence_claim"]], evidence=[dict(text=self.p["material"]), dict(text=self.second)]), self.t.log)
        self.assertEqual((r["authorized"], r["reason"]), (False, "not_ready")); self.assertEqual(self.history(), [])

class EndToEnd(Pair):
    """The whole path: the SOURCE result did not qualify, the single re-verification is authorized with ANOTHER record, made, recorded, and the pair is confirmed; without the authorization the audit exposes the repeat."""
    def finish(self, authorize):
        if authorize:
            r = self.authorize(); self.assertTrue(r["authorized"], r)
        self.t.tool("s2", "mcp__jev__jev_verify", self.payload(), CF.verify_body([dict(claim=self.p["source_claim"], verdict="verified", confidence=0.99)], compatible_synthetic=True)); self.t.save()
        if authorize:
            call = next(c for c in jevref.load_calls(self.t.log) if c["tool_use_id"] == "s2"); rec = evidence.record(self.request()["request_id"], call, self.t.log); self.assertTrue(rec["recorded"], rec)
        rows = [("abs", "a1", self.p["absence_claim"], "unsupported", 0.98), ("src1", "s1", self.p["source_claim"], "verified", 0.9), ("src2", "s2", self.p["source_claim"], "verified", 0.99)]
        f = dict(type="lost_detail", check_id="abs", claim=self.p["absence_claim"], confidence=0.98, quote_source=self.second, quote_handoff=None, uuid="u2", category="omission", omission_ref=dict(detail=self.detail, source_check_id="src2"))
        return self.report(self.t, self.doc(self.t, self.checks_for(self.t, rows), [f], None, None, "FAIL"))[0]

    def test_an_authorized_other_record_confirms_the_pair(self):
        out = self.finish(True); self.assertEqual(out["status"], "FAIL", out["binding_summary"]["reasons"])
        self.assertEqual(out["findings"][0]["omission_ref"]["source_check_id"], "src2"); self.assertNotIn("reverifications", out["binding_summary"]["audit"]["unfinished"])

    def test_the_same_second_call_without_an_authorization_is_exposed_but_fail_keeps_its_precedence(self):
        out = self.finish(False); self.assertEqual(out["status"], "FAIL")
        self.assertEqual(out["binding_summary"]["audit"]["unfinished"].get("reverifications"), 1); self.assertFalse(out["binding_summary"]["audit"]["complete"])

class Cli(Pair):
    def run_cli(self, *args, rc=0):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), *args], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, rc, p.stderr + p.stdout); return json.loads(p.stdout) if p.stdout.strip() else None
    def files(self):
        out = {}
        for name, body in (("vr.json", self.p["version_ref"]), ("props.json", dict(proposals=[dict(kind="transcript_record", quote=self.second, request_id=self.request()["request_id"])])), ("payload.json", self.payload())):
            out[name] = os.path.join(self.d, name)
            with open(out[name], "w", encoding="utf-8") as f: json.dump(body, f)
        return out

    def test_collect_then_authorize_a_source_request_through_the_cli(self):
        f = self.files(); rid = self.request()["request_id"]
        r = self.run_cli("collect", "--session", self.t.log, "--proposals", f["props.json"], "--version-ref-file", f["vr.json"])
        row = next(x for x in r["requests"] if x["request"]["request_id"] == rid); self.assertEqual((row["request"]["state"], row["request"]["target"]["stage"]), ("ready", "source")); self.assertEqual(row["collected"]["items"][0]["passage"], self.second)
        a = self.run_cli("authorize", "--session", self.t.log, "--version-ref-file", f["vr.json"], "--request-id", rid, "--payload", f["payload.json"], "--proposals", f["props.json"])
        self.assertEqual((a["authorized"], a["status"]), (True, "reserved"))

if __name__ == "__main__": unittest.main()

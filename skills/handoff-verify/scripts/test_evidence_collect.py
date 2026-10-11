#!/usr/bin/env python3
"""Offline test of the collection of new evidence (stdlib only, no Jev call, no network, nothing executed, never reads .handoff-verify/): evidence.py admits only local paths, reads them read-only, applies the shared
sanitizing policy BEFORE anything is shown or stored, keeps only material that is NEW against what the original call received, and moves a request from collect_local to ready, ask_user or blocked. The one grouped
question carries the agreed Romanian text. A question is not a Jev call and does not consume the single re-verification. Authorizing and recording come later.
The positive responses are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at, which the inspected server does not emit; test_contract_fixtures pins the realistic bodies).
usage: python3 -B test_evidence_collect.py [-v]"""
import hashlib, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, evidence, jevref
import test_retry_advice as T
import test_evidence_request as E
import test_source_window as W

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
NEW_PASSAGE = "report_test.py: 41 passed, 0 failed in 3.2s"            # NOT in T.EVIDENCE
SECRET_LINE = 'API_KEY="abcdefgh12345678"'
TOKEN_LINE = "value Zx9Qw3Er7Ty1Ui5Op2As4Df6Gh8Jk0Lm end"              # an ambiguous high-entropy token
QUESTION = ("Nu am găsit dovezi locale eligibile pentru verificările enumerate. Indicați numai căile locale absolute ale fișierelor sau directoarelor care conțin materialul solicitat. "
            "Nu trimiteți conținut, explicații sau secrete. Răspunsul nu poate deveni dovadă retroactivă pentru versiunea istorică. Dacă nu aveți o cale disponibilă, verificările rămân UNRESOLVED.")

def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()

class Files(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
    def tearDown(self): self.t.cleanup()
    def write(self, name, text, mode="w"):
        p = os.path.join(self.d, name); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f: f.write(text)
        return p

class Admission(Files):
    def refused(self, path, reason):
        real, why = evidence.admit_path(path)
        self.assertIsNone(real, path); self.assertEqual(why, reason, path)

    def test_an_ordinary_file_and_a_directory_are_admitted(self):
        f = self.write("notes.txt", "x\n")
        self.assertEqual(evidence.admit_path(f), (f, None)); self.assertEqual(evidence.admit_path(self.d), (self.d, None))

    def test_only_absolute_local_paths(self):
        self.refused("notes.txt", "not_absolute"); self.refused("", "not_absolute"); self.refused(None, "not_absolute"); self.refused(7, "not_absolute")
        self.refused("/tmp/a\x00b", "not_absolute")
        self.refused("https://example.com/a.txt", "remote_url"); self.refused("file:///etc/hosts", "remote_url")

    def test_a_dot_env_file_or_alias_is_never_opened(self):
        for name in (".env", ".env.local", "prod.env"):
            self.refused(self.write(name, SECRET_LINE), "excluded_env")
        self.refused(self.write("sub/.env/notes.txt", "x\n"), "excluded_env")        # a .env component
        ok = self.write("fine.txt", "x\n"); link = os.path.join(self.d, "alias.txt"); os.symlink(self.write(".env", SECRET_LINE), link)
        self.refused(link, "symlink")                                                  # an alias of .env, refused as a symlink before any read
        os.symlink(ok, os.path.join(self.d, "alias2.txt")); self.refused(os.path.join(self.d, "alias2.txt"), "symlink")

    def test_a_missing_path_and_a_secret_looking_path(self):
        self.refused(os.path.join(self.d, "nope.txt"), "not_found")
        why = evidence.admit_path("/tmp/sk-abcdefghijklmnopqrstuvwx/notes.txt")[1]
        self.assertEqual(why, "path_redaction_dependent")                              # the path itself would be echoed to a user and to Jev: refused

    def test_binary_large_and_non_utf8_files_are_not_read_as_text(self):
        self.refused(self.write("b.bin", b"abc\x00def", "wb"), "not_text")
        self.refused(self.write("l1.txt", b"\xff\xfe\xfa", "wb"), "not_text")
        big = self.write("big.txt", "x" * 50)
        old = evidence.MAX_FILE_BYTES
        try:
            evidence.MAX_FILE_BYTES = 10; self.refused(big, "too_large")
        finally: evidence.MAX_FILE_BYTES = old

class Items(Files):
    def test_an_eligible_item_carries_its_identity_hashes_and_exact_quote(self):
        body = "line one\n%s\nline three\n" % NEW_PASSAGE
        p = self.write("run.log", body)
        it = evidence.read_item(p, [2, 2])
        self.assertTrue(it["eligible"], it); self.assertEqual((it["kind"], it["path"], it["lines"], it["quote"]), ("local_file", p, [2, 2], NEW_PASSAGE))
        self.assertEqual((it["file_sha256"], it["raw_sha256"], it["sanitized_sha256"]), (sha(body.encode()), sha(NEW_PASSAGE), sha(NEW_PASSAGE)))

    def test_a_whole_short_file_needs_no_line_range(self):
        p = self.write("short.txt", NEW_PASSAGE + "\n"); it = evidence.read_item(p)
        self.assertTrue(it["eligible"]); self.assertEqual(it["lines"], [1, 1])

    def test_a_secret_makes_the_item_ineligible_and_it_is_never_echoed(self):
        for line in (SECRET_LINE, TOKEN_LINE):
            p = self.write("s.txt", "ok\n%s\n" % line); it = evidence.read_item(p, [1, 2])
            self.assertFalse(it["eligible"]); self.assertEqual(it["reason"], "redaction_dependent")
            dumped = json.dumps(it); self.assertNotIn("abcdefgh12345678", dumped); self.assertNotIn("Zx9Qw3Er7Ty1", dumped); self.assertNotIn("quote", it)
        self.assertTrue(evidence.read_item(p, [1, 1])["eligible"])                    # the other line of the same file is fine

    def test_a_long_file_needs_a_line_range_and_a_bad_range_is_refused(self):
        p = self.write("long.txt", "\n".join("row %d" % k for k in range(1, 4000)) + "\n")
        self.assertEqual(evidence.read_item(p)["reason"], "too_long_select_lines")
        self.assertTrue(evidence.read_item(p, [10, 12])["eligible"])
        for bad in ([0, 3], [5, 2], [1, 99999], ["a", 2], [1], True):
            self.assertEqual(evidence.read_item(p, bad)["reason"], "bad_line_range", bad)

    def test_a_directory_is_expanded_one_level_without_env_or_symlinks(self):
        self.write("a.txt", "A\n"); self.write("b.txt", "B\n"); self.write(".env", SECRET_LINE); self.write("sub/c.txt", "C\n")
        os.symlink(os.path.join(self.d, "a.txt"), os.path.join(self.d, "link.txt"))
        names = [os.path.basename(p) for p in evidence.expand(self.d)]
        self.assertEqual(names, ["a.txt", "b.txt"])
        self.assertEqual(evidence.expand(os.path.join(self.d, "a.txt")), [os.path.join(self.d, "a.txt")])
        old = evidence.MAX_DIR_FILES
        try:
            evidence.MAX_DIR_FILES = 1; self.assertEqual(len(evidence.expand(self.d)), 1)
        finally: evidence.MAX_DIR_FILES = old

class Collect(Files):
    def setUp(self):
        super().setUp()
        _, self.call = T.call([E.SHORT]); self.req = advice.session_advice([self.call])[0]["advice"]["evidence_request"]

    def collect(self, proposals): return evidence.collect(self.req, self.call, proposals)

    def test_new_material_is_kept(self):
        p = self.write("run.log", NEW_PASSAGE + "\n")
        got = self.collect([dict(kind="local_file", path=p)])
        self.assertEqual([i["quote"] for i in got["items"]], [NEW_PASSAGE]); self.assertEqual(got["rejected"], []); self.assertEqual(got["searched"], [p])

    def test_material_the_call_already_had_is_not_new_whatever_its_case_or_spacing(self):
        p = self.write("again.txt", "RAN   69   tests\n  ok\n")
        got = self.collect([dict(kind="local_file", path=p)])
        self.assertEqual(got["items"], []); self.assertEqual([r["reason"] for r in got["rejected"]], ["not_new"])

    def test_the_same_passage_twice_counts_once(self):
        a, b = self.write("a.txt", NEW_PASSAGE + "\n"), self.write("b.txt", "  " + NEW_PASSAGE.upper() + "\n")
        got = self.collect([dict(kind="local_file", path=a), dict(kind="local_file", path=b)])
        self.assertEqual(len(got["items"]), 1); self.assertEqual([r["reason"] for r in got["rejected"]], ["duplicate"])

    def test_a_directory_proposal_collects_each_new_file(self):
        self.write("one.txt", NEW_PASSAGE + "\n"); self.write("two.txt", "another new line about the tests\n")
        got = self.collect([dict(kind="local_dir", path=self.d)])
        self.assertEqual(len(got["items"]), 2)

    def test_a_refused_path_is_listed_with_its_reason_and_nothing_else(self):
        got = self.collect([dict(kind="local_file", path=self.write(".env", SECRET_LINE)), dict(kind="local_file", path="relative.txt"), dict(kind="local_file", path="/tmp/sk-abcdefghijklmnopqrstuvwx/n.txt")])
        self.assertEqual(got["items"], []); self.assertEqual([r["reason"] for r in got["rejected"]], ["excluded_env", "not_absolute", "path_redaction_dependent"])
        dumped = json.dumps(got); self.assertNotIn("abcdefgh12345678", dumped); self.assertNotIn("sk-abcdefghijklmnopqrstuvwx", dumped)

    def test_a_malformed_or_unknown_proposal_is_rejected(self):
        got = self.collect(["x", dict(kind="chat_answer", text="trust me"), dict(kind="local_file")])
        self.assertEqual([r["reason"] for r in got["rejected"]], ["malformed_proposal", "unknown_kind", "not_absolute"])

    def test_a_corrected_claim_must_really_differ_and_be_clean(self):
        ok = self.collect([dict(kind="corrected_claim", text="Exactly 69 unit tests pass.")])
        self.assertEqual(ok["corrected_claim"]["text"], "Exactly 69 unit tests pass."); self.assertEqual(ok["corrected_claim"]["sha256"], sha("Exactly 69 unit tests pass."))
        for text, reason in (("  the UNIT tests   pass. ", "not_a_correction"), ("", "malformed_proposal"), (SECRET_LINE, "redaction_dependent")):
            got = self.collect([dict(kind="corrected_claim", text=text)])
            self.assertIsNone(got["corrected_claim"], text); self.assertEqual([r["reason"] for r in got["rejected"]], [reason], text)

    def test_an_answer_typed_in_the_chat_is_never_evidence(self):
        got = self.collect([dict(kind="evidence_text", text=NEW_PASSAGE), dict(kind="local_file", path=None, text=NEW_PASSAGE)])
        self.assertEqual(got["items"], []); self.assertTrue(all(r["reason"] in ("unknown_kind", "not_absolute") for r in got["rejected"]))

VREF = dict(write_tool_use_id="w1", sha256="a" * 64, evaluated_against="prefix")
LATE = "late_report.txt: 12 passed after the note was written"
JEV_ONLY = "jev_only_text: the verification inputs are not facts of the transcript"

class Transcript(Files):
    """Records of the SESSION itself: only blocks inside the shared source window of the evaluated write are eligible (never the note's own Write, never a Jev call, never what comes after the write)."""
    def setUp(self):
        super().setUp()
        tx = W.Tx(); tx.say("context line one"); tx.say("Ran 69 tests"); tx.say(NEW_PASSAGE); tx.say("config: " + SECRET_LINE)
        tx.tool("j0", "mcp__jev__jev_verify", dict(claims=["x"], evidence=JEV_ONLY), result="{}")
        tx.tool("w1", "Write", dict(file_path="/work/proj/HANDOFF.md", content="Note: the unit tests pass. NOTE_ONLY_TEXT"))
        tx.say(LATE); self.path = tx.save(os.path.join(self.d, "src.jsonl")); self.tx = tx
        self.u = {r["message"]["content"][0]["text"]: r["uuid"] for r in tx.recs if r["type"] == "assistant" and r["message"]["content"][0].get("type") == "text"}
        rec, self.call = T.call([E.SHORT])
        self.req = advice.session_advice([self.call], version_ref=VREF)[0]["advice"]["evidence_request"]

    def collect(self, items, req=None, source=True): return evidence.collect(req or self.req, self.call, items, self.path if source else None)
    def reasons(self, got): return [r["reason"] for r in got["rejected"]]

    def test_a_quote_before_the_write_is_an_eligible_new_item_with_its_provenance(self):
        got = self.collect([dict(kind="transcript_record", uuid=self.u[NEW_PASSAGE], quote=NEW_PASSAGE)])
        self.assertEqual(self.reasons(got), []); it = got["items"][0]
        self.assertEqual((it["kind"], it["uuid"], it["quote"], it["block_kind"], it["raw_sha256"], it["sanitized_sha256"]), ("transcript_record", self.u[NEW_PASSAGE], NEW_PASSAGE, "text", sha(NEW_PASSAGE), sha(NEW_PASSAGE)))
        self.assertEqual((it["window"]["write_tool_use_id"], it["window"]["evaluated_against"]), ("w1", "prefix")); self.assertEqual(len(it["source_sha256"]), 64)
        self.assertIn(self.path, got["searched"])

    def test_the_uuid_is_optional_but_when_given_it_must_be_the_record_of_the_quote(self):
        self.assertEqual(len(self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE)])["items"]), 1)
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", uuid=self.u["context line one"], quote=NEW_PASSAGE)])), ["quote_not_in_record"])

    def test_what_comes_after_the_write_the_note_itself_and_a_jev_call_are_not_eligible(self):
        for q in (LATE, "NOTE_ONLY_TEXT", JEV_ONLY):
            self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=q)])), ["not_in_eligible_source"], q)

    def test_a_secret_in_the_quote_is_refused_and_never_echoed(self):
        got = self.collect([dict(kind="transcript_record", quote=SECRET_LINE)])
        self.assertEqual(self.reasons(got), ["redaction_dependent"]); self.assertNotIn("abcdefgh12345678", json.dumps(got))

    def test_a_quote_the_call_already_had_is_not_new_and_one_passage_counts_once(self):
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote="Ran 69 tests")])), ["not_new"])          # already inside the evidence the original call received
        got = self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE), dict(kind="transcript_record", quote=NEW_PASSAGE)])
        self.assertEqual((len(got["items"]), self.reasons(got)), (1, ["duplicate"]))
        f = self.write("same.txt", NEW_PASSAGE + "\n")
        got = self.collect([dict(kind="local_file", path=f), dict(kind="transcript_record", quote=NEW_PASSAGE)])
        self.assertEqual((len(got["items"]), self.reasons(got)), (1, ["duplicate"]))

    def test_without_a_bound_version_or_a_transcript_nothing_is_eligible(self):
        unbound = advice.session_advice([self.call])[0]["advice"]["evidence_request"]
        self.assertIsNone(unbound["target"]["version_ref"])
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE)], req=unbound)), ["version_unbound"])
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE)], source=False)), ["transcript_unavailable"])

    def test_a_write_that_is_not_in_the_transcript_gives_an_ambiguous_window(self):
        other = advice.session_advice([self.call], version_ref=dict(VREF, write_tool_use_id="w9"))[0]["advice"]["evidence_request"]
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE)], req=other)), ["window_ambiguous"])

    def test_an_unreadable_transcript_is_refused(self):
        got = evidence.collect(self.req, self.call, [dict(kind="transcript_record", quote=NEW_PASSAGE)], os.path.join(self.d, "missing.jsonl"))
        self.assertEqual(self.reasons(got), ["transcript_unreadable"])

    def test_a_malformed_or_oversized_quote_is_refused(self):
        for q, why in ((None, "malformed_proposal"), ("   ", "malformed_proposal"), (7, "malformed_proposal"), ("x" * (evidence.MAX_QUOTE_CHARS + 1), "quote_too_long")):
            self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=q)])), [why], q)

    def test_the_quote_must_be_exact_and_case_sensitive(self):
        self.assertEqual(self.reasons(self.collect([dict(kind="transcript_record", quote=NEW_PASSAGE.upper())])), ["not_in_eligible_source"])

class States(unittest.TestCase):
    def setUp(self):
        _, self.call = T.call([E.SHORT]); self.req = advice.session_advice([self.call])[0]["advice"]["evidence_request"]
        self.item = dict(kind="local_file", path="/x/a.txt", lines=[1, 1], quote=NEW_PASSAGE, file_sha256="a" * 64, raw_sha256="b" * 64, sanitized_sha256="b" * 64, eligible=True, new=True)
        self.found, self.none = dict(items=[self.item], rejected=[], searched=["/x/a.txt"], corrected_claim=None), dict(items=[], rejected=[], searched=[], corrected_claim=None)

    def test_the_agreed_question_text(self):
        self.assertEqual(evidence.QUESTION_RO, QUESTION)

    def test_found_evidence_makes_the_request_ready_without_touching_the_rounds(self):
        r = evidence.advance(self.req, self.found)
        self.assertEqual((r["state"], r["question_ro"], r["stop_reason"]), ("ready", None, None))
        for k in ("request_id", "target", "remedy", "rounds_used", "rounds_limit", "retry_remaining", "reason_codes", "allowed_sources", "missing_artifacts"): self.assertEqual(r[k], self.req[k], k)

    def test_nothing_found_asks_the_user_once_and_the_question_is_not_a_reverification(self):
        r = evidence.advance(self.req, self.none)
        self.assertEqual((r["state"], r["question_ro"]), ("ask_user", QUESTION))
        self.assertEqual((r["rounds_used"], r["retry_remaining"]), (0, 1))

    def test_after_the_question_nothing_found_stops(self):
        r = evidence.advance(self.req, self.none, asked=True)
        self.assertEqual((r["state"], r["stop_reason"], r["retry_remaining"], r["question_ro"]), ("blocked", "no_local_evidence_after_question", 0, None))
        self.assertEqual(evidence.advance(self.req, self.found, asked=True)["state"], "ready")

    def test_headless_never_waits_for_an_answer(self):
        r = evidence.advance(self.req, self.none, headless=True)
        self.assertEqual((r["state"], r["stop_reason"], r["retry_remaining"], r["question_ro"]), ("blocked", "no_local_evidence_headless", 0, None))

    def test_a_claim_correction_waits_for_the_corrected_claim_and_never_asks_the_user(self):
        c = E.request_of(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9))
        self.assertEqual(c["remedy"], "claim_correction")
        r = evidence.advance(c, self.none); self.assertEqual((r["state"], r["question_ro"]), ("collect_local", None))
        self.assertEqual(evidence.advance(c, dict(self.none, corrected_claim=dict(text="HEAD is 54edd39.", sha256="c" * 64)))["state"], "ready")
        self.assertEqual(evidence.advance(c, self.found)["state"], "collect_local")      # files do not answer a wrong fact
        self.assertEqual(evidence.advance(c, self.none, headless=True)["state"], "collect_local")

    def test_blocked_and_exhausted_requests_are_left_alone(self):
        blocked = E.request_of(("HEAD is 54edd39.", "verified", 0.99, "auto", None)); exhausted = E.request_of(E.SHORT, history=[E.history_entry(self.req)])
        for r in (blocked, exhausted): self.assertEqual(evidence.advance(r, self.found), r); self.assertEqual(evidence.advance(r, self.none), r)

    def test_advance_does_not_change_its_input(self):
        before = json.dumps(self.req, sort_keys=True); evidence.advance(self.req, self.none); self.assertEqual(json.dumps(self.req, sort_keys=True), before)

    def test_one_grouped_question_lists_every_request_that_still_needs_a_path(self):
        a = evidence.advance(self.req, self.none)
        _, c2 = T.call([("The scope filter landed.", "unsupported", 0.9, "auto", 0.8)], tid="c2"); b = evidence.advance(advice.session_advice([c2])[0]["advice"]["evidence_request"], self.none)
        ready = evidence.advance(E.request_of(("HEAD is 54edd39.", "verified", 0.99, "review", 0.9)), self.found)
        g = evidence.grouped_question([a, b, ready], ["/x/dir"])
        self.assertTrue(g["text"].startswith(QUESTION)); self.assertEqual([x["request_id"] for x in g["requests"]], [a["request_id"], b["request_id"]])
        for x in (a, b): self.assertIn(x["request_id"], g["text"])
        self.assertIn("/x/dir", g["text"]); self.assertNotIn(ready["request_id"], g["text"])
        self.assertIsNone(evidence.grouped_question([ready], []))

class Cli(Files):
    def run_cli(self, *args, rc=0):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), *args], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, rc, p.stderr + p.stdout); return json.loads(p.stdout)

    def setUp(self):
        super().setUp()
        rec, self.call = T.call([E.SHORT]); self.log = self.write("s.jsonl", "".join(json.dumps(r) + "\n" for r in rec))
        self.req = advice.session_advice([self.call])[0]["advice"]["evidence_request"]

    def proposals(self, items, rid=None):
        return self.write("p.json", json.dumps(dict(proposals=[dict(i, request_id=rid or self.req["request_id"]) for i in items])))

    def only(self, out):
        self.assertEqual(len(out["requests"]), 1); return out["requests"][0]

    def test_a_proposed_local_file_makes_the_request_ready(self):
        f = self.write("run.log", NEW_PASSAGE + "\n")
        r = self.only(self.run_cli("collect", "--session", self.log, "--proposals", self.proposals([dict(kind="local_file", path=f)])))
        self.assertEqual(r["request"]["state"], "ready"); self.assertEqual([i["quote"] for i in r["collected"]["items"]], [NEW_PASSAGE]); self.assertIsNone(self.run_cli("collect", "--session", self.log, "--proposals", self.proposals([dict(kind="local_file", path=f)]))["question"])

    def test_no_proposals_asks_one_grouped_question(self):
        out = self.run_cli("collect", "--session", self.log)
        self.assertEqual(self.only(out)["request"]["state"], "ask_user"); self.assertTrue(out["question"]["text"].startswith(QUESTION)); self.assertIn(self.req["request_id"], out["question"]["text"])

    def test_headless_and_asked_never_ask(self):
        for flag, stop in (("--headless", "no_local_evidence_headless"), ("--asked", "no_local_evidence_after_question")):
            out = self.run_cli("collect", "--session", self.log, flag); r = self.only(out)
            self.assertEqual((r["request"]["state"], r["request"]["stop_reason"]), ("blocked", stop)); self.assertIsNone(out["question"])

    def test_a_proposal_for_an_unknown_request_is_reported_not_applied(self):
        f = self.write("run.log", NEW_PASSAGE + "\n")
        out = self.run_cli("collect", "--session", self.log, "--proposals", self.proposals([dict(kind="local_file", path=f)], rid="0" * 16))
        self.assertEqual(self.only(out)["request"]["state"], "ask_user"); self.assertEqual([u["request_id"] for u in out["unmatched_proposals"]], ["0" * 16])

    def test_a_registry_with_the_request_makes_it_exhausted_and_collection_leaves_it(self):
        reg = os.path.join(self.d, "reg.json"); import audit
        doc = audit.empty_registry(); doc["evidence_history"] = [E.history_entry(self.req)]
        with open(reg, "w", encoding="utf-8") as f: json.dump(doc, f)
        f = self.write("run.log", NEW_PASSAGE + "\n")
        r = self.only(self.run_cli("collect", "--session", self.log, "--registry", reg, "--proposals", self.proposals([dict(kind="local_file", path=f)])))
        self.assertEqual((r["request"]["state"], r["request"]["rounds_used"]), ("exhausted", 1))

    def test_a_malformed_proposals_file_is_an_error(self):
        bad = self.write("bad.json", "{not json")
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "collect", "--session", self.log, "--proposals", bad], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2); self.assertIn("error", json.loads(p.stdout))

    def test_a_missing_session_is_an_error(self):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "collect", "--session", os.path.join(self.d, "missing.jsonl")], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 2)

    def test_a_version_ref_file_binds_the_requests_and_enables_transcript_items(self):
        tx = W.Tx(); tx.say(NEW_PASSAGE); tx.tool("w1", "Write", dict(file_path="/work/proj/HANDOFF.md", content="Note: the unit tests pass."))
        rec, _ = T.call([E.SHORT]); j = [dict(r, uuid="j" + r["uuid"]) for r in rec]
        log = self.write("both.jsonl", "".join(json.dumps(r) + "\n" for r in tx.recs + j)); vr = self.write("vr.json", json.dumps(VREF))
        first = self.run_cli("collect", "--session", log, "--version-ref-file", vr); r1 = self.only(first)
        self.assertEqual(r1["request"]["target"]["version_ref"], VREF); self.assertEqual(r1["request"]["state"], "ask_user")
        props = self.write("tp.json", json.dumps(dict(proposals=[dict(request_id=r1["request"]["request_id"], kind="transcript_record", quote=NEW_PASSAGE)])))
        r2 = self.only(self.run_cli("collect", "--session", log, "--version-ref-file", vr, "--proposals", props))
        self.assertEqual((r2["request"]["state"], [i["kind"] for i in r2["collected"]["items"]]), ("ready", ["transcript_record"]))

    def test_a_bad_version_ref_file_is_an_error(self):
        for body in ("{not json", json.dumps(dict(write_tool_use_id="w")), json.dumps([1])):
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "evidence.py"), "collect", "--session", self.log, "--version-ref-file", self.write("badvr.json", body)], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 2, body); self.assertIn("error", json.loads(p.stdout))

if __name__ == "__main__": unittest.main()

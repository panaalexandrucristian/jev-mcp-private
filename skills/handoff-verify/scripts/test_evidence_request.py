#!/usr/bin/env python3
"""Offline test of the evidence request (stdlib only, no Jev call, never reads .handoff-verify/): for a verify/gate result that did not pass, advice.py says WHAT is missing before the single
re-verification (remedy, state, sources, rounds) in `advice.evidence_request`, derived from the recorded call and never from the check id or the bytes of an input. This step only describes the request;
collecting, asking, authorizing and recording come later. report.advise stays unchanged. The bodies are the COMPATIBLE SYNTHETIC ones of test_retry_advice.py.
usage: python3 -B test_evidence_request.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit, jevref, report
import test_retry_advice as T

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
KEYS = {"schema_version", "request_id", "reason_codes", "target", "state", "remedy", "allowed_sources", "missing_artifacts", "question_ro", "rounds_used", "rounds_limit", "retry_remaining", "stop_reason"}
SHORT = ("The unit tests pass.", "verified", 0.9, "auto", 0.9)                  # add_direct_evidence
DETAILS = ("Commit 54edd39 is plugin 0.7.8 and 71 tests pass in report_test.py.", "unsupported", 0.9, "auto", 0.8)   # remove_unsupported_detail
HASH = "a" * 64

def request_of(row, history=(), version_ref=None, **kw):
    _, c = T.call([row], **kw)
    e = jevref.results_of(c)[0][0]
    return advice.evidence_request(e, c, advice.advise(e, c), history=history, version_ref=version_ref)

def absent_call():
    """A usable response that lacks same_subject altogether (the real server's shape)."""
    rec, _ = T.call([("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9)])
    body = json.loads(rec[1]["message"]["content"][0]["content"]); body["results"][0].pop("same_subject")
    rec[1]["message"]["content"][0]["content"] = json.dumps(body)
    return jevref.calls_from_records(rec)[0]

def history_entry(request):
    return dict(request_id=request["request_id"], target=request["target"], input_hash=HASH, state="authorized")

class Shape(unittest.TestCase):
    def test_the_object_has_exactly_the_agreed_keys(self):
        r = request_of(SHORT)
        self.assertEqual(set(r), KEYS)
        self.assertEqual((r["schema_version"], r["rounds_limit"], r["rounds_used"], r["retry_remaining"], r["question_ro"], r["stop_reason"]), (1, 1, 0, 1, None, None))

    def test_the_target_is_the_call_result_and_the_stage_and_the_registry_accepts_it(self):
        r = request_of(SHORT)
        self.assertEqual(r["target"], dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=SHORT[0]), version_ref=None, stage="verify"))
        self.assertTrue(audit._target_ok(r["target"]))
        self.assertEqual(r["request_id"], audit.evidence_request_id(r["target"]))
        self.assertEqual(request_of(SHORT, tool="gate")["target"]["stage"], "gate")

    def test_the_id_follows_what_is_re_verified_and_not_the_evidence_or_the_check(self):
        base = request_of(SHORT)["request_id"]
        self.assertEqual(request_of(SHORT, evidence="completely different evidence text")["request_id"], base)   # bytes of the input are not the identity
        self.assertNotEqual(request_of(SHORT, tid="c2")["request_id"], base)                                      # another call
        self.assertNotEqual(request_of(("The unit tests all pass.",) + SHORT[1:])["request_id"], base)            # another claim
        self.assertNotEqual(request_of(SHORT, tool="gate")["request_id"], base)                                   # another stage

    def test_the_version_ref_is_part_of_the_target(self):
        vr = dict(write_tool_use_id="w1", sha256=HASH, evaluated_against="session_end")
        a, b = request_of(SHORT, version_ref=vr), request_of(SHORT)
        self.assertEqual(a["target"]["version_ref"], vr); self.assertNotEqual(a["request_id"], b["request_id"])
        self.assertTrue(audit._target_ok(a["target"]))

    def test_the_reason_codes_start_with_the_primary_code_and_keep_every_cause(self):
        r = request_of(("HEAD is 54edd39.", "verified", 0.9, "review", 0.3))
        self.assertEqual(r["reason_codes"][0], "evidence_off_subject")
        self.assertIn("confidence_not_above_threshold", r["reason_codes"]); self.assertIn("action_not_auto", r["reason_codes"])
        self.assertEqual(len(r["reason_codes"]), len(set(r["reason_codes"])))

class Remedies(unittest.TestCase):
    def check(self, row, remedy, state, **kw):
        r = request_of(row, **kw)
        self.assertEqual((r["remedy"], r["state"]), (remedy, state), r)
        return r

    def test_missing_evidence_is_collected_locally_first(self):
        r = self.check(SHORT, "semantic_evidence", "collect_local")
        self.assertEqual(r["retry_remaining"], 1); self.assertTrue(r["allowed_sources"]); self.assertTrue(r["missing_artifacts"])
        self.assertNotIn("chat", " ".join(r["allowed_sources"]))                                                 # an answer in the chat is never evidence
        self.check(("HEAD is 54edd39.", "verified", 0.9, "review", 0.3), "semantic_evidence", "collect_local")    # evidence_off_subject
        self.check(("The scope filter landed.", "unsupported", 0.9, "auto", 0.8), "semantic_evidence", "collect_local")   # add_source_passage
        self.check(("HEAD is 54edd39.", "verified", 0.99, "review", 0.9), "semantic_evidence", "collect_local")   # aux_condition_failed

    def test_a_wrong_or_unsupported_claim_is_corrected_not_padded(self):
        self.check(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9), "claim_correction", "collect_local")   # fix_fact
        self.check(("HEAD is 0000000.", "contradicted", 0.95, "auto", 0.9), "claim_correction", "collect_local")   # recheck_fact
        r = self.check(DETAILS, "claim_correction", "collect_local")
        self.assertEqual(r["missing_artifacts"], ["detail:71", "detail:report_test.py"])

    def test_a_fix_fact_does_not_ask_for_more_evidence_of_the_same_kind(self):
        self.assertEqual(request_of(("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9))["allowed_sources"], [])

    def test_absent_protocol_fields_block_whatever_the_evidence(self):
        c = absent_call(); e = jevref.results_of(c)[0][0]
        r = advice.evidence_request(e, c, advice.advise(e, c))
        self.assertEqual((r["remedy"], r["state"], r["retry_remaining"], r["stop_reason"]), ("protocol_blocker", "blocked", 0, "protocol_fields_absent"))
        self.assertEqual(r["reason_codes"][0], "protocol_fields_absent")

    def test_null_or_invalid_subject_fields_block_too(self):
        r = request_of(("HEAD is 54edd39.", "verified", 0.99, "auto", None))
        self.assertEqual((r["remedy"], r["state"], r["retry_remaining"], r["stop_reason"]), ("protocol_blocker", "blocked", 0, "subject_fields_null_or_invalid"))

    def test_a_result_for_another_claim_needs_a_corrected_call(self):
        r = request_of(("HEAD is 54edd39.", "contradicted", 0.99, "auto", 0.9), result_claims=["HEAD is 0000000."])
        self.assertEqual((r["remedy"], r["state"], r["reason_codes"][0]), ("claim_correction", "collect_local", "result_mismatch"))

    def test_no_usable_result_is_left_to_the_transport_rule(self):
        r = request_of(("HEAD is 54edd39.", "verified", None, "auto", 0.9))
        self.assertEqual((r["remedy"], r["state"], r["retry_remaining"], r["stop_reason"]), ("transport_retry", "blocked", 0, "no_usable_result"))

class Allowance(unittest.TestCase):
    def test_a_request_already_in_the_history_is_exhausted(self):
        first = request_of(SHORT)
        r = request_of(SHORT, history=[history_entry(first)])
        self.assertEqual((r["state"], r["rounds_used"], r["retry_remaining"], r["stop_reason"], r["remedy"]), ("exhausted", 1, 0, "reverification_used", "semantic_evidence"))
        self.assertEqual(r["request_id"], first["request_id"])

    def test_the_recorded_state_is_exhausted_as_well(self):
        first = request_of(SHORT); e = dict(history_entry(first), state="recorded")
        self.assertEqual(request_of(SHORT, history=[e])["state"], "exhausted")

    def test_another_request_in_the_history_changes_nothing(self):
        other = request_of(("The unit tests all pass.",) + SHORT[1:])
        r = request_of(SHORT, history=[history_entry(other)])
        self.assertEqual((r["state"], r["rounds_used"], r["retry_remaining"]), ("collect_local", 0, 1))

    def test_a_blocked_request_stays_blocked_but_reports_the_rounds_used(self):
        c = absent_call(); e = jevref.results_of(c)[0][0]; first = advice.evidence_request(e, c, advice.advise(e, c))
        r = advice.evidence_request(e, c, advice.advise(e, c), history=[history_entry(first)])
        self.assertEqual((r["state"], r["rounds_used"], r["retry_remaining"]), ("blocked", 1, 0))

    def test_a_lost_history_refuses_a_new_allowance(self):
        r = request_of(SHORT, history=None)
        self.assertEqual((r["state"], r["retry_remaining"], r["stop_reason"]), ("blocked", 0, "history_unavailable"))
        self.assertEqual(r["remedy"], "semantic_evidence")

    def test_the_number_of_rounds_never_exceeds_the_limit(self):
        first = request_of(SHORT)
        r = request_of(SHORT, history=[history_entry(first)])
        self.assertLessEqual(r["rounds_used"], r["rounds_limit"]); self.assertEqual(r["retry_remaining"], r["rounds_limit"] - r["rounds_used"])

class SessionAndCli(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = self.t.name
    def tearDown(self): self.t.cleanup()

    def session(self, rec):
        log = os.path.join(self.d, "s.jsonl")
        with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
        return log

    def run_cli(self, log, *extra):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", log, *extra], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 0, p.stderr); return json.loads(p.stdout)

    def registry(self, entries, name="reg.json"):
        doc = audit.empty_registry(); doc["evidence_history"] = list(entries)
        path = os.path.join(self.d, name)
        with open(path, "w", encoding="utf-8") as f: json.dump(doc, f)
        return path

    def test_every_result_that_did_not_pass_carries_its_request_inside_the_advice(self):
        rec, c = T.call([("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9), SHORT[:5]])
        out = advice.session_advice([c])
        self.assertEqual([r["result_index"] for r in out], [1])
        req = out[0]["advice"]["evidence_request"]
        self.assertEqual(set(req), KEYS); self.assertEqual(req["target"]["jev_ref"]["result_index"], 1)

    def test_the_report_path_is_unchanged(self):
        _, c = T.call([SHORT]); e = jevref.results_of(c)[0][0]
        self.assertNotIn("evidence_request", advice.advise(e, c))
        checks = [dict(id="k0", tool="jev_verify", verdict="verified", confidence=0.9, jev_ref=dict(tool_use_id="c1", result_index=0, key=SHORT[0]))]
        b = jevref.bind(checks, [c], True); report.attach_advice(checks, b, [c], [])
        self.assertNotIn("evidence_request", checks[0]["advice"])

    def test_a_call_without_a_usable_result_has_a_call_level_target(self):
        rec, _ = T.call([SHORT]); rec[1]["message"]["content"][0]["is_error"] = True; rec[1]["message"]["content"][0]["content"] = "boom"
        c = jevref.calls_from_records(rec)[0]
        out = advice.session_advice([c]); req = out[0]["advice"]["evidence_request"]
        self.assertIsNone(out[0]["result_index"])
        self.assertEqual(req["target"]["jev_ref"], dict(tool_use_id="c1", result_index=None, key=None)); self.assertTrue(audit._target_ok(req["target"]))
        self.assertEqual((req["state"], req["stop_reason"]), ("blocked", "no_usable_result"))

    def test_the_cli_without_a_registry_says_that_no_history_was_consulted(self):
        rec, _ = T.call([SHORT]); out = self.run_cli(self.session(rec))
        self.assertFalse(out["history_consulted"])
        req = out["results"][0]["advice"]["evidence_request"]
        self.assertEqual((req["state"], req["rounds_used"]), ("collect_local", 0))

    def test_the_cli_reads_the_history_of_a_valid_registry(self):
        rec, c = T.call([SHORT]); log = self.session(rec)
        first = advice.session_advice([c])[0]["advice"]["evidence_request"]
        out = self.run_cli(log, "--registry", self.registry([history_entry(first)]))
        self.assertTrue(out["history_consulted"])
        req = out["results"][0]["advice"]["evidence_request"]
        self.assertEqual((req["state"], req["rounds_used"], req["retry_remaining"]), ("exhausted", 1, 0))

    def test_a_v1_registry_is_read_as_an_empty_history(self):
        rec, _ = T.call([SHORT]); log = self.session(rec)
        doc = audit.empty_registry(); doc["version"] = 1; del doc["evidence_history"]
        path = os.path.join(self.d, "v1.json")
        with open(path, "w", encoding="utf-8") as f: json.dump(doc, f)
        out = self.run_cli(log, "--registry", path)
        self.assertEqual(out["results"][0]["advice"]["evidence_request"]["state"], "collect_local"); self.assertTrue(out["history_consulted"])

    def test_an_unreadable_or_malformed_registry_refuses_a_new_allowance(self):
        rec, _ = T.call([SHORT]); log = self.session(rec)
        bad = os.path.join(self.d, "bad.json")
        with open(bad, "w", encoding="utf-8") as f: f.write("{not json")
        for path in (bad, os.path.join(self.d, "missing.json")):
            out = self.run_cli(log, "--registry", path)
            req = out["results"][0]["advice"]["evidence_request"]
            self.assertEqual((req["state"], req["retry_remaining"], req["stop_reason"]), ("blocked", 0, "history_unavailable"), path)
            self.assertIn("history_error", out); self.assertFalse(out["history_consulted"])

    def test_the_cli_binds_the_requests_to_a_version_ref_file_and_refuses_a_bad_one(self):
        rec, _ = T.call([SHORT]); log = self.session(rec); vr = dict(write_tool_use_id="w1", sha256=HASH, evaluated_against="session_end")
        good = os.path.join(self.d, "vr.json")
        with open(good, "w", encoding="utf-8") as f: json.dump(vr, f)
        req = self.run_cli(log, "--version-ref-file", good)["results"][0]["advice"]["evidence_request"]
        self.assertEqual(req["target"]["version_ref"], vr); self.assertTrue(audit._target_ok(req["target"]))
        for body in ("{not json", json.dumps(dict(write_tool_use_id="w")), json.dumps([1])):
            bad = os.path.join(self.d, "bad_vr.json")
            with open(bad, "w", encoding="utf-8") as f: f.write(body)
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "advice.py"), "--session", log, "--version-ref-file", bad], capture_output=True, text=True, env=ENV)
            self.assertEqual(p.returncode, 2, body); self.assertIn("error", json.loads(p.stdout))

    def test_the_existing_cli_fields_are_kept(self):
        rec, _ = T.call([("HEAD is 0000000.", "contradicted", 0.99, "auto", 0.9)]); out = self.run_cli(self.session(rec))
        self.assertIn("never an identical call", out["rule"]); self.assertEqual(out["results"][0]["advice"]["code"], "fix_fact")
        for k in ("capabilities", "capability_note", "gate_summaries"): self.assertIn(k, out)

if __name__ == "__main__": unittest.main()

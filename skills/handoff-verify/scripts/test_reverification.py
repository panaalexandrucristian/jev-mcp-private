#!/usr/bin/env python3
"""The regression matrix of the re-verification evidence (plan 2, step 7; stdlib only, offline, no Jev call, no network, never reads the real .handoff-verify/).
`MATRIX` maps every scenario the plan requires to the tests that pin it: each row names existing tests (checked here, so a renamed or deleted test breaks the row) and says honestly what kind of coverage it is:
 COVERED = the behaviour is implemented and pinned;
 LIMIT = a limit of the mechanism that a test pins so that a future change shows (the documentation states it too);
 NOT_IMPLEMENTED = a family of the plan's taxonomy that has no request yet (the documentation says so).
The scenarios that no other test pinned are tested in this file: a repeat in a report that has no audit block at all, the same result in another report or under another check id, another run, the original and the copy of a session,
an invalid confidence, and the single identical transport retry. The positive responses of every module of the matrix are COMPATIBLE SYNTHETIC bodies (they carry same_subject / subject_at, which the inspected server does not emit;
test_contract_fixtures pins the realistic bodies); the matrix checks that each module says so.
usage: python3 -B test_reverification.py [-v]"""
import importlib, json, math, os, sys, tempfile, unittest
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import advice, audit, discover, jevref, report
import test_evidence_request as E
import test_evidence_report as ER
import test_reverification_audit as RA
import test_retry_advice as T

Row = namedtuple("Row", "scenario kind tests")
M = "test_"
MATRIX = [
 Row("every family of advice codes has its remedy, source and eligibility (add_direct_evidence, add_source_passage, evidence_off_subject, aux_condition_failed, fix_fact, recheck_fact, remove_unsupported_detail, result_mismatch, protocol_fields_absent, no_result)", "COVERED",
     ["test_evidence_request.Remedies.test_missing_evidence_is_collected_locally_first", "test_evidence_request.Remedies.test_a_wrong_or_unsupported_claim_is_corrected_not_padded", "test_evidence_request.Remedies.test_a_fix_fact_does_not_ask_for_more_evidence_of_the_same_kind",
      "test_evidence_request.Remedies.test_a_result_for_another_claim_needs_a_corrected_call", "test_evidence_request.Remedies.test_no_usable_result_is_left_to_the_transport_rule"]),
 Row("the families of identity and provenance, material and references, report and findings, audit completion and the other results have no request yet (stated in the documentation)", "NOT_IMPLEMENTED",
     ["test_reverification_docs.Flow.test_the_limits_are_written_next_to_what_the_mechanism_does"]),
 Row("absent versus null protocol fields", "COVERED", ["test_evidence_request.Remedies.test_absent_protocol_fields_block_whatever_the_evidence", "test_evidence_request.Remedies.test_null_or_invalid_subject_fields_block_too"]),
 Row("exactly 0.95 is not above the threshold (the advice and the omission halves)", "COVERED", ["test_retry_advice.Rules.test_contradicted_above_the_threshold_means_fix_the_fact_and_below_recheck", "test_omission_advice.Advice.test_an_absence_that_does_not_qualify_takes_no_new_evidence"]),
 Row("an invalid confidence is no result and no probability", "COVERED", ["test_reverification.Results.test_an_invalid_confidence_is_no_usable_result_and_gets_no_allowance"]),
 Row("a result for another claim than the one sent (mismatch)", "COVERED", ["test_evidence_request.Remedies.test_a_result_for_another_claim_needs_a_corrected_call"]),
 Row("a secret, a remote URL or a .env file is never opened, echoed or sent", "COVERED",
     ["test_evidence_collect.Admission.test_only_absolute_local_paths", "test_evidence_collect.Admission.test_a_dot_env_file_or_alias_is_never_opened", "test_evidence_collect.Items.test_a_secret_makes_the_item_ineligible_and_it_is_never_echoed",
      "test_evidence_authorize.Authorize.test_a_secret_in_the_payload_is_refused_and_never_echoed"]),
 Row("late user text and an answer typed in the chat are never evidence; a quote outside the source window is not eligible", "COVERED",
     ["test_evidence_collect.Collect.test_an_answer_typed_in_the_chat_is_never_evidence", "test_evidence_collect.Transcript.test_what_comes_after_the_write_the_note_itself_and_a_jev_call_are_not_eligible", "test_omission_evidence.Source.test_a_record_after_the_note_was_written_is_not_eligible"]),
 Row("a changed reference or changed bytes after the plan are not silently authorized", "COVERED", ["test_evidence_authorize.Authorize.test_changed_bytes_after_the_plan_are_not_silently_authorized"]),
 Row("no audit data at all: the repeat is still exposed", "COVERED", ["test_reverification.NoAudit.test_a_repeat_is_exposed_even_when_the_report_has_no_audit_review"]),
 Row("the same bytes under a new id, order or whitespace are not new evidence", "COVERED",
     ["test_evidence_collect.Collect.test_material_the_call_already_had_is_not_new_whatever_its_case_or_spacing", "test_evidence_collect.Collect.test_the_same_passage_twice_counts_once", "test_evidence_request.Shape.test_the_id_follows_what_is_re_verified_and_not_the_evidence_or_the_check"]),
 Row("another report or another check id does not reset the allowance", "COVERED", ["test_reverification.Reset.test_the_same_result_in_another_report_or_under_another_check_id_is_the_same_request"]),
 Row("another run, hash or write does not reset the allowance (an authorization about another version authorizes nothing)", "COVERED",
     ["test_reverification_audit.Repeats.test_a_record_must_be_about_this_claim_in_this_version_of_the_original_call", "test_reverification.Reset.test_an_authorization_about_another_run_authorizes_nothing"]),
 Row("a corrected claim must be carried exactly; a split of a compound claim spends the same authorization; the result of a recorded re-verification cannot be re-verified", "COVERED",
     ["test_evidence_authorize.Authorize.test_a_corrected_claim_needs_a_payload_that_carries_exactly_it", "test_evidence_authorize.Split.test_the_split_and_the_original_claim_are_one_allowance_not_two", "test_evidence_report.Chain.test_the_result_of_a_recorded_reverification_is_exhausted"]),
 Row("the original and its copy: the accounting of every demonstrated representation of the session counts", "COVERED",
     ["test_registry_format.Merge.test_the_more_advanced_state_of_the_same_entry_wins", "test_reverification.Copies.test_an_authorization_recorded_in_the_copy_of_the_session_counts", "test_reverification.Copies.test_two_different_recorded_calls_for_one_request_authorize_nothing"]),
 Row("a crash or a race at the reservation never gives a second allowance", "COVERED",
     ["test_evidence_authorize.Reserve.test_eight_racing_reservations_give_exactly_one_allowance", "test_evidence_authorize.Reserve.test_racing_processes_give_exactly_one_allowance", "test_evidence_authorize.Reserve.test_a_crash_while_writing_leaves_the_registry_whole_and_a_later_reservation_works",
      "test_evidence_authorize.Reserve.test_a_crash_after_the_reservation_does_not_give_the_allowance_back", "test_evidence_record.Record.test_six_racing_processes_record_exactly_one_call"]),
 Row("a direct Jev call made without an authorization is exposed by the audit (it cannot be prevented)", "COVERED", ["test_reverification_audit.Audit.test_a_repeat_without_a_record_cannot_be_a_pass_and_is_counted_and_explained"]),
 Row("an earlier attempt that no check cites, and a corrected claim as a repeat of a claim, are not seen", "LIMIT", ["test_reverification_docs.Flow.test_the_limits_are_written_next_to_what_the_mechanism_does", "test_omission_advice.Report.test_an_absence_call_that_nothing_identifies_keeps_the_generic_advice"]),
 Row("a transport or invalid_response error allows one identical retry, never two", "COVERED", ["test_absence_first.PlanAbsence.test_transport_error_allows_one_identical_retry_only", "test_reverification.Results.test_the_identical_transport_retry_is_one_and_gives_no_allowance"]),
 Row("an unchanged ABSENCE (same claim, same complete material) is not re-verified", "COVERED", ["test_omission_advice.Report.test_an_absence_that_does_not_qualify_with_the_canonical_material_takes_no_new_evidence", "test_omission_evidence.Absence.test_the_absence_request_takes_nothing_and_cannot_be_authorized"]),
 Row("neighbouring records joined together are not a SOURCE passage", "COVERED", ["test_omission_evidence.SourceAuthorize.test_neighbouring_records_joined_together_are_refused"]),
 Row("another legitimate SOURCE record confirms the pair", "COVERED", ["test_omission_evidence.EndToEnd.test_an_authorized_other_record_confirms_the_pair"]),
 Row("an ABSENCE that comes back verified means the detail is present: no finding, no SOURCE call", "COVERED", ["test_omission_advice.Report.test_an_absence_that_comes_back_verified_means_the_detail_is_present_and_needs_nothing"]),
 Row("a FAIL keeps its precedence with the unresolved counts exposed", "COVERED", ["test_omission_evidence.EndToEnd.test_the_same_second_call_without_an_authorization_is_exposed_but_fail_keeps_its_precedence"]),
 Row("one proposals file serves several requests, each authorized with its own proposals only (found by the live Haiku test)", "COVERED", ["test_evidence_flow.Proposals.test_each_request_is_authorized_with_its_own_proposals_from_one_shared_file", "test_evidence_flow.Proposals.test_the_proposals_of_another_request_are_not_the_evidence_of_this_one"]),
 Row("request ids made without a version are explained, not silently different (found by the live Haiku test)", "COVERED", ["test_evidence_flow.Versions.test_advice_and_collect_say_when_the_requests_are_not_bound_to_a_version", "test_evidence_flow.Versions.test_an_id_made_without_a_version_is_explained_and_the_known_ids_are_listed"]),
 Row("a proposal that lacks its field names it, and the file formats are in the help and the documentation (found by the live Haiku test)", "COVERED", ["test_evidence_flow.Format.test_a_proposal_that_lacks_its_field_names_the_field", "test_evidence_flow.Format.test_the_help_shows_the_three_file_formats"]),
 Row("the incomplete audit, the blocker of 5 of 5 live reports, is listed with the command to run and never completed for the agent (found by the live Haiku test)", "COVERED", ["test_audit_blockers.Report.test_a_report_without_the_audit_review_names_it_and_the_command", "test_audit_blockers.Report.test_blockers_never_change_the_status", "test_audit_blockers.Repeat.test_a_repeat_without_an_authorization_is_a_protocol_violation_not_a_task"]),
 Row("the pair exception: the checks of a finding-linked pair get no advice", "COVERED", ["test_omission_advice.Report.test_the_checks_of_a_finding_linked_pair_still_get_no_advice", "test_retry_advice.ReportAdvice.test_the_checks_of_an_omission_pair_get_no_advice"]),
]
MODULES = ["test_evidence_request", "test_evidence_collect", "test_evidence_authorize", "test_evidence_record", "test_evidence_report", "test_reverification_audit", "test_omission_advice", "test_omission_evidence", "test_reverification", "test_evidence_flow", "test_audit_blockers"]

class Matrix(unittest.TestCase):
    def test_every_row_names_existing_tests_and_a_known_kind(self):
        for r in MATRIX:
            self.assertIn(r.kind, ("COVERED", "LIMIT", "NOT_IMPLEMENTED"), r.scenario); self.assertTrue(r.tests, r.scenario)
            for t in r.tests:
                mod, cls, meth = t.split("."); c = getattr(importlib.import_module(mod), cls, None)
                self.assertTrue(c is not None and hasattr(c, meth), "%s: %s does not exist" % (r.scenario[:50], t))

    def test_the_scenarios_are_distinct(self):
        self.assertEqual(len({r.scenario for r in MATRIX}), len(MATRIX))

    def test_the_positive_fixtures_say_that_they_are_synthetic(self):
        for m in MODULES: self.assertIn("SYNTHETIC", (importlib.import_module(m).__doc__ or "").upper(), m)

class Results(unittest.TestCase):
    def test_an_invalid_confidence_is_no_usable_result_and_gets_no_allowance(self):
        for bad in ("0.99", float("nan"), 1.5, True, None):
            with self.subTest(bad):
                r = E.request_of(("HEAD is 54edd39.", "verified", bad, "auto", 0.9), version_ref=RA.VREF)
                self.assertEqual((r["remedy"], r["state"], r["stop_reason"], r["retry_remaining"]), ("transport_retry", "blocked", "no_usable_result", 0), r)

    def test_the_identical_transport_retry_is_one_and_gives_no_allowance(self):
        self.assertEqual(report.retry_decision("transport", 0), "retry_identical"); self.assertEqual(report.retry_decision("invalid_response", 0), "retry_identical")
        self.assertEqual(report.retry_decision("transport", 1), "stop_unresolved")
        rec, c = T.call([("HEAD is 54edd39.", "verified", 0.99, "auto", 0.9)]); c = dict(c, is_error=True, parsed=None)
        a = dict(code="no_result", hint=advice.HINTS["no_result"])
        r = advice.evidence_request(None, c, a, history=(), version_ref=RA.VREF)
        self.assertEqual((r["remedy"], r["state"], r["retry_remaining"]), ("transport_retry", "blocked", 0))            # the identical retry is the transport rule, never a spent re-verification

class NoAudit(RA.Story):
    def test_a_repeat_is_exposed_even_when_the_report_has_no_audit_review(self):
        t = self.build(self.user, self.note, [self.first, self.again])
        rows = [("p1", "c1", RA.CLAIM, "verified", 0.99), ("p2", "c2", RA.CLAIM, "verified", 0.99)]
        out, g, path = self.report(t, self.doc(t, self.checks_for(t, rows), [], None))           # block=None: an audit object without any evaluation
        self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["binding_summary"]["audit"]["unfinished"].get("reverifications"), 1)

class Reset(ER.Written):
    def test_the_same_result_in_another_report_or_under_another_check_id_is_the_same_request(self):
        t, (out, g, path) = self.write(); first = out["checks"][0]["advice"]["evidence_request"]
        block, _ = self.audit_block()
        out2, _, _ = self.report(t, self.doc(t, self.checks_for(t, [("another_id", "c1", RA.CLAIM, "verified", 0.9)]), [], block)); again = out2["checks"][0]["advice"]["evidence_request"]
        self.assertEqual(again["request_id"], first["request_id"]); self.assertEqual(out2["evidence_requests"][0]["check_id"], "another_id")
        reg, src = audit.registry_path_of(t.log), discover.canon(t.log)
        self.assertEqual(audit.reserve_evidence(reg, src, first["request_id"], first["target"], "5" * 64)[0], "reserved")
        out3, _, _ = self.report(t, self.doc(t, self.checks_for(t, [("a_third_id", "c1", RA.CLAIM, "verified", 0.9)]), [], block))
        self.assertEqual(out3["checks"][0]["advice"]["evidence_request"]["state"], "exhausted")                    # one allowance for the result, whatever the report or the check id

    def test_an_authorization_about_another_run_authorizes_nothing(self):
        calls = [RA.call("c1", 0, RA.H1), RA.call("c2", 1, RA.H2)]; b = [RA.binding("c1"), RA.binding("c2")]
        for other in (dict(RA.VREF, run="r9"), dict(RA.VREF, evaluated_against="session_end"), dict(RA.VREF, sha256="e" * 64)):
            t = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=RA.CLAIM), version_ref=other, stage="verify")
            self.assertEqual(len(audit.unauthorized_repeats(b, calls, [RA.rec("c2", RA.H2, t)], True)), 1, other)

class Copies(unittest.TestCase):
    """The original session and its copy: each has its own candidate registry; the accounting of both counts."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name)
        self.logs = []
        for k in ("orig", "copy"):
            d = os.path.join(self.d, k); os.makedirs(d); rec, _ = T.call([E.SHORT])
            for r in rec: r["cwd"] = d
            log = os.path.join(d, "s.jsonl")
            with open(log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in rec))
            audit.ensure_registry(audit.registry_path_of(log), discover.canon(log)); self.logs.append(log)
        self.target = dict(jev_ref=dict(tool_use_id="c1", result_index=0, key=E.SHORT[0]), version_ref=RA.VREF, stage="verify"); self.rid = audit.evidence_request_id(self.target)
    def record(self, log, tid, h="2" * 64):
        reg, src = audit.registry_path_of(log), discover.canon(log)
        self.assertEqual(audit.reserve_evidence(reg, src, self.rid, self.target, h)[0], "reserved"); self.assertEqual(audit.record_evidence(reg, src, self.rid, h, dict(tool_use_id=tid, result_index=None, key=None))[0], "recorded")
    def ctx(self): return audit.Context({}, [], [], [], self.logs[0], None, None, False, False, "R04", False, [self.logs[1]])

    def test_an_authorization_recorded_in_the_copy_of_the_session_counts(self):
        self.record(self.logs[1], "c2"); hist, why = self.ctx().evidence_history()
        self.assertEqual([(e["request_id"], e["state"], e["recorded_ref"]["tool_use_id"]) for e in hist], [(self.rid, "recorded", "c2")]); self.assertIsNone(why)

    def test_two_different_recorded_calls_for_one_request_authorize_nothing(self):
        self.record(self.logs[0], "c2"); self.record(self.logs[1], "c3")
        hist, why = self.ctx().evidence_history(); self.assertEqual(hist, []); self.assertIn("different", why)

if __name__ == "__main__": unittest.main()

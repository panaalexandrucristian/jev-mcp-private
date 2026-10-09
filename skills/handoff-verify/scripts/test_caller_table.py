#!/usr/bin/env python3
"""Caller-to-regression table of the changed contracts (items 9, 11, 15, 20; stdlib only, offline, never reads .handoff-verify/). The table is DATA checked against the code:
 - the call sites of the changed functions are enumerated from the AST of every non-test script (a docstring or a comment that names a function is not a call: `audit_run`, `audit_trigger` and `score` are words in comments of jevref.py, not functions);
   a new, moved or removed call site fails the test until the table is updated, so it cannot silently go unexercised;
 - every site names the regressions that exercise it (each must exist) or a precise reason why none applies (and a test for that reason where it is checkable);
 - the TEST callers of the writers (fixture callers) are classified: a test that expects a PASS derives its audit data from its real source (audit_fixtures) or runs the documented audit CLIs; the others never expect a PASS.
Callers outside skills/handoff-verify/scripts were searched for separately (commands/, hooks/, agents/, .claude-plugin/, private/, src/, scripts/, docs/, README, package.json, .github): see OUTSIDE.
usage: python3 -B test_caller_table.py [-v]"""
import ast, glob, json, os, re, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import checks, jevref, report, versions
import contract_fixtures as CF
import test_checks as TC

T = lambda *x: ".".join(x)
SITES = {
    # (file, callee, enclosing function): (disposition, regressions or the reason)
    ("report.py", "audited_status", "bind_report"): ("regression", ["test_audit.LoneGoodCheck.test_without_audit_data_a_good_check_is_unresolved_but_the_version_is_still_verified", "test_audit.ChunkReview.test_a_missing_chunk_review_blocks"]),
    ("report.py", "certify", "bind_report"): ("regression", ["test_audit.LoneGoodCheck.test_a_genuinely_complete_audit_passes_on_every_surface", "test_audit.ChunkReview.test_a_missing_chunk_review_blocks", "test_audit.Categories.test_a_shortlist_of_two_categories_blocks",
                                                            "test_audit.Registry.test_a_registered_candidate_without_a_disposition_blocks", "test_audit.Exclusions.test_an_invalid_exclusion_does_not_account_and_is_counted", "test_audit.Registry.test_fail_keeps_its_precedence_while_the_unfinished_work_stays_counted"]),
    ("report.py", "per_version", "bind_report"): ("regression", ["test_audit.PerVersion.test_complete_audits_pass_at_every_level", "test_audit.PerVersion.test_a_missing_evaluation_block_caps_the_write_summary_and_only_that_evaluation"]),
    ("report.py", "gate", "bind_report"): ("regression", ["test_audit.LoneGoodCheck.test_a_genuinely_complete_audit_passes_on_every_surface", "test_run_binding.RunInTheReport.test_a_named_run_stays_valid", "test_mixed_order.Copies.test_a_report_about_the_original_checked_against_the_copy_never_certifies"]),
    ("report.py", "bind", "bind_report"): ("regression", ["test_audit_fixes.CallerLevel.test_a_verdict_outside_the_contract_binds_but_never_resolves_in_the_writer_and_the_gate", "test_audit.LoneGoodCheck.test_a_genuinely_complete_audit_passes_on_every_surface"]),
    ("report.py", "rewrite_status_lines", "render_md"): ("regression", ["test_status_token.Token.test_the_main_token_is_rewritten_and_the_negation_that_follows_is_kept", "test_status_token.Token.test_a_fail_summary_keeps_its_conditional_unresolved", "test_status_token.Token.test_a_fenced_block_is_never_rewritten", "test_status_token.MainStatusOnly.test_the_direct_renderer_rewrites_exactly_the_main_status_among_all_contexts_together",
                                                                                       "test_status_token.QuotationsExamplesAndCode.test_every_quotation_example_and_code_context_before_the_summary_is_kept_and_only_the_summary_changes", "test_status_token.QuotationsExamplesAndCode.test_each_context_alone_is_never_the_main_status"]),
    ("report.py", "bind_report", "write_report"): ("regression", ["test_audit.LoneGoodCheck.test_without_audit_data_a_good_check_is_unresolved_but_the_version_is_still_verified", "test_audit.LoneGoodCheck.test_structural_failures_fail_closed_without_a_crash_and_the_writer_and_the_gate_agree",
                                                                                "test_audit_fixes.UnusableRecordsAreNotEvaluated.test_a_wrong_kind_of_value_anywhere_in_the_report_never_crashes_and_never_passes"]),
    ("report.py", "render_md", "write_report"): ("regression", ["test_status_token.Persisted.test_the_markdown_written_by_write_report_shows_the_status_of_the_audited_json", "test_doc_end_to_end.GenuinePass.test_a_clean_report_with_a_complete_audit_is_pass_and_the_example_is_what_runs"]),
    ("versions.py", "audited_status", "per_version.summary"): ("regression", ["test_audit.PerVersion.test_complete_audits_pass_at_every_level", "test_audit.PerVersion.test_a_stale_chunk_in_one_evaluation_caps_that_evaluation"]),
    ("versions.py", "certify", "per_version.summary"): ("regression", ["test_audit.PerVersion.test_a_missing_evaluation_block_caps_the_write_summary_and_only_that_evaluation", "test_audit.PerVersion.test_without_an_audit_context_a_pass_is_capped_and_a_context_lifts_it_only_when_complete"]),
    ("versions.py", "no_context", "per_version.summary"): ("regression", ["test_audit.PerVersion.test_without_an_audit_context_a_pass_is_capped_and_a_context_lifts_it_only_when_complete"]),
    ("versions.py", "bind", "gate"): ("regression", ["test_audit_fixes.CallerLevel.test_a_verdict_outside_the_contract_binds_but_never_resolves_in_the_writer_and_the_gate", "test_audit.LoneGoodCheck.test_the_audit_derived_from_the_source_is_the_one_that_passes_and_a_hand_edited_status_never_does"]),
    ("versions.py", "audited_status", "gate"): ("regression", ["test_audit.LoneGoodCheck.test_without_audit_data_a_good_check_is_unresolved_but_the_version_is_still_verified", "test_audit.LoneGoodCheck.test_the_audit_derived_from_the_source_is_the_one_that_passes_and_a_hand_edited_status_never_does"]),
    ("versions.py", "certify", "gate"): ("regression", ["test_audit.LoneGoodCheck.test_a_genuinely_complete_audit_passes_on_every_surface", "test_audit.ChunkReview.test_a_stale_sha256_blocks", "test_audit.Isolation.test_a_review_of_one_write_does_not_serve_an_equal_byte_write"]),
    ("versions.py", "gate", "cmd_status"): ("regression", ["test_audit_fixes.CallerLevel.test_the_cli_status_entry_points_run_in_process"]),      # (the subprocess CLI tests run the same code but a profiler cannot see them: this one runs `versions.main` in this process)
    ("versions.py", "cmd_status", "main"): ("regression", ["test_audit_fixes.CallerLevel.test_the_cli_status_entry_points_run_in_process"]),
    ("versions.py", "validate_report", "gate"): ("regression", ["test_audit_fixes.StructureComesFirst.test_a_persisted_pass_without_the_required_properties_is_not_a_verified_version", "test_audit_fixes.StructureComesFirst.test_a_malformed_persisted_report_never_crashes_the_gate_or_the_cli"]),
    ("audit.py", "validate_report", "structure"): ("regression", ["test_audit_fixes.StructureComesFirst.test_malformed_inputs_never_crash_the_writer_and_never_pass", "test_audit_fixes.StructureComesFirst.test_a_tenth_category_record_blocks_the_pass_everywhere", "test_audit_fixes.UnusableRecordsAreNotEvaluated.test_the_per_record_properties_the_writer_owns_neither_block_a_pass_nor_change_the_audit", "test_audit_fixes.UnusableRecordsAreNotEvaluated.test_the_same_edits_keep_a_confirmed_defect_fail_and_a_genuinely_malformed_author_field_still_counts"]),
    ("audit.py", "window_of", "assess"): ("regression", ["test_audit_fixes.TheWindowIsTheEvaluation.test_a_quote_of_the_later_instruction_does_not_ground_a_review_of_the_earlier_run", "test_audit_fixes.WindowBoundaryInsideAChunk.test_a_quote_from_after_the_boundary_in_the_same_chunk_is_not_evidence"]),
    ("audit.py", "window_of", "block_template"): ("regression", ["test_audit_fixes.WindowBoundaryInsideAChunk.test_the_chunk_that_holds_material_on_both_sides_of_the_run_start_is_partial_and_only_the_inside_spans_count"]),
    ("audit.py", "window_of", "expected_chunks"): ("regression", ["test_audit_fixes.TheWindowIsTheEvaluation.test_each_run_has_its_own_expected_chunks_and_the_later_instruction_is_not_evidence_for_the_earlier_run"]),
    ("audit.py", "establish", "main"): ("regression", ["test_audit_fixes.CallerLevel.test_the_audit_template_prepare_and_prepare_batch_establish_and_associate_in_process"]),
    ("prepare.py", "ensure_registry", "main"): ("regression", ["test_audit_fixes.CallerLevel.test_the_audit_template_prepare_and_prepare_batch_establish_and_associate_in_process"]),
    ("omissions.py", "associate_session_ledger", "cmd_prepare_batch"): ("regression", ["test_audit_fixes.CallerLevel.test_the_audit_template_prepare_and_prepare_batch_establish_and_associate_in_process"]),
    ("audit.py", "assess", "certify"): ("regression", ["test_audit.NonCertifyingHelper.test_the_historical_low_level_status_is_marked_non_certifying", "test_audit.ChunkReview.test_the_control_review_passes"]),
    ("report.py", "usable", "bind_report"): ("regression", ["test_audit_fixes.UnusableRecordsAreNotEvaluated.test_the_reproduced_inputs_never_crash_the_writer_the_gate_or_the_cli_and_never_pass", "test_audit_fixes.UnusableRecordsAreNotEvaluated.test_a_confirmed_defect_keeps_fail_next_to_every_kind_of_malformed_record"]),
    ("report.py", "seal", "bind_report"): ("regression", ["test_audit_fixes.UnusableRecordsAreNotEvaluated.test_the_last_check_of_the_writer_never_certifies_a_pass_that_is_not_valid_as_emitted", "test_audit_fixes.UnusableRecordsAreNotEvaluated.test_a_declared_status_that_is_not_a_status_is_ignored_and_never_kept"]),
    ("report.py", "validate_report", "seal"): ("regression", ["test_audit_fixes.UnusableRecordsAreNotEvaluated.test_the_last_check_of_the_writer_never_certifies_a_pass_that_is_not_valid_as_emitted"]),
    ("report.py", "Context", "bind_report"): ("regression", ["test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_original_is_not_hidden_by_the_empty_registry_of_the_copy", "test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_copy_is_not_hidden_by_the_empty_registry_of_the_original"]),
    ("versions.py", "Context", "gate"): ("regression", ["test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_original_is_not_hidden_by_the_empty_registry_of_the_copy", "test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_copy_is_not_hidden_by_the_empty_registry_of_the_original"]),
    ("audit.py", "representations", "registry_state"): ("regression", ["test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_original_is_not_hidden_by_the_empty_registry_of_the_copy", "test_audit_copies.CopiesShareTheAccounting.test_a_malformed_or_foreign_registry_of_a_representation_fails_closed", "test_audit_copies.CopiesShareTheAccounting.test_a_missing_registry_of_a_demonstrated_representation_is_missing_accounting_in_both_directions"]),
    ("audit.py", "representations", "registry_state.make"): ("regression", ["test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_original_is_not_hidden_by_the_empty_registry_of_the_copy", "test_audit_copies.CopiesShareTheAccounting.test_a_candidate_registered_against_the_copy_is_not_hidden_by_the_empty_registry_of_the_original"]),
    ("audit.py", "representations", "assess"): ("regression", ["test_audit_copies.CopiesShareTheAccounting.test_naming_the_registry_of_a_representation_is_not_a_substitution_but_a_foreign_one_is", "test_audit_copies.CopiesShareTheAccounting.test_the_ledger_associated_with_the_original_is_not_erased_by_the_copy"]),
    ("audit.py", "ledger_candidates", "assess"): ("regression", ["test_audit_copies.SharedLedgerIsolatesSessions.test_each_session_counts_only_its_own_obligation_of_the_shared_ledger", "test_audit_copies.SharedLedgerIsolatesSessions.test_an_obligation_whose_source_cannot_be_resolved_is_not_demonstrated_unrelated_and_counts_for_every_session"]),
    ("audit.py", "ledger_candidates", "main"): ("regression", ["test_audit_copies.SharedLedgerIsolatesSessions.test_the_audit_cli_template_lists_only_the_expected_work_of_its_own_session"]),      # (runs `audit.main` in this process)
    ("audit.py", "distinct_sessions", "unrelated_source"): ("regression", ["test_audit_copies.UndemonstratedSourcesStillCount.test_an_empty_malformed_or_metadata_deficient_source_is_not_demonstrated_unrelated_and_counts_on_every_surface", "test_audit_copies.UndemonstratedSourcesStillCount.test_the_distinct_session_control_is_demonstrated_and_its_row_does_not_count", "test_audit_copies.UndemonstratedSourcesStillCount.test_a_copy_that_no_longer_matches_the_session_but_shares_its_id_is_not_demonstrated_unrelated"]),
    ("audit.py", "unrelated_source", "ledger_candidates"): ("regression", ["test_audit_copies.SharedLedgerIsolatesSessions.test_each_session_counts_only_its_own_obligation_of_the_shared_ledger", "test_audit_copies.SharedLedgerIsolatesSessions.test_a_withheld_source_is_not_demonstrated_unrelated_either"]),
    ("identity_world.py", "write_report", "build_a"): ("regression", ["test_identity_matrix.Report.test_rp07_session_variant_environment_kit_cost_and_patch_are_persisted_exactly", "test_identity_matrix.Report.test_rp09_versions_and_source_ranges_keep_the_authors_values_beside_the_derived_ones"]),
    ("identity_world.py", "write_report", "build_rich"): ("regression", ["test_identity_matrix.Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema", "test_identity_matrix.Report.test_rp10_findings_and_unresolved_are_structured_and_persisted_exactly"]),
    ("identity_world.py", "write_report", "build_j"): ("regression", ["test_identity_matrix.Report.test_rp03_provenance_blocker_and_relocation"]),
    ("identity_world.py", "apply_patch", "build_rich"): ("regression", ["test_identity_matrix.Report.test_rp07_session_variant_environment_kit_cost_and_patch_are_persisted_exactly", "test_identity_matrix.Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema"]),      # (test_apply_patch pins the return value and the backup bytes the world depends on, but does not run the world)
    ("checks.py", "bind", "build_checks"): ("non-applicable", "build_checks calls jevref.bind only to read `bound` (is the call and result demonstrable) and never computes a status; the verdict domain changes `resolved`, never `bound`, so a check whose verdict is outside its tool's contract is still built (recorded faithfully) and the report writer then never resolves it: pinned below and by test_contract_fixtures.VerdictContractPerTool"),
    ("advice.py", "gate_summary", "main"): ("non-applicable", "an observation printed next to the advice (jevref.gate_summary: 'holds' is an observation, no version binding, no change of any report status); it is not a status function and the audit has nothing to say about it (test_contract_fixtures.VerdictContractPerTool.test_a_gate_with_a_non_contract_verdict_does_not_hold)"),
    ("jevref.py", "verdict_contract", "bind"): ("regression", ["test_contract_fixtures.VerdictContractPerTool.test_supported_and_unknown_never_resolve_for_verify_and_gate", "test_contract_fixtures.VerdictContractPerTool.test_compare_relations_and_classify_labels_keep_their_own_contracts"]),
    ("report.py", "apply_patch", "<definition>"): ("regression", ["test_apply_patch.Refusals.test_a_missing_or_non_true_approval_changes_nothing_and_makes_no_backup", "test_apply_patch.Failures.test_a_replace_failure_leaves_the_original_and_no_temporary_file"]),
}
NOTE = {"omissions.py": "bind: the AST binder of the shell classifier (unrelated to jevref.bind)"}
CALLEES = {"audited_status", "certify", "no_context", "bind_report", "write_report", "apply_patch", "render_md", "rewrite_status_lines", "per_version", "gate", "cmd_status", "bind", "gate_summary", "assess", "verdict_contract",
           "validate_report", "window_of", "associate_session_ledger", "ensure_registry", "establish", "seal", "usable", "ledger_candidates", "unrelated_source", "distinct_sessions", "representations", "Context"}
CALLEE_FILE = {"audited_status": "jevref.py", "certify": "audit.py", "no_context": "audit.py", "bind_report": "report.py", "write_report": "report.py", "apply_patch": "report.py", "render_md": "report.py", "rewrite_status_lines": "report.py", "per_version": "versions.py",
               "gate": "versions.py", "cmd_status": "versions.py", "bind": "jevref.py", "gate_summary": "jevref.py", "assess": "audit.py", "verdict_contract": "jevref.py", "validate_report": "schema_check.py", "window_of": "audit.py",
               "associate_session_ledger": "audit.py", "ensure_registry": "audit.py", "establish": "audit.py", "seal": "report.py", "usable": "schema_check.py", "ledger_candidates": "audit.py",
               "unrelated_source": "audit.py", "distinct_sessions": "versions.py", "representations": "audit.py", "Context": "audit.py"}      # (Context: the constructor frame `__init__` of the class)      # where each callee is DEFINED (a frame of that function called from the claimed site is a hit)
# call sites outside skills/handoff-verify/scripts (searched with a recursive grep that excludes node_modules, .git, dist, .handoff-verify and HANDOFF.md): none calls a changed function
OUTSIDE = {
    "scripts/handoff-verify-replay.py": "replays `omissions.py prepare` / `prepare-batch` output byte for byte; this task changes none of their printed fields (only SKILL_SCRIPTS gained audit.py, which affects the source window of a transcript that RUNS audit.py)",
    "private/jev-flow/test/gate-run.test.mjs": "a string `.handoff-verify/run-N/report.verify.json` in a path-limit fixture; it calls no Python function",
    "private/jev-control/test/manifest.test.mjs": "plugin-version pins (0.8.1) and the dirty-tree guard that the Node run skips by name; no changed contract",
    ".github/workflows/ci.yml": "runs `npm run test:py` (the exact discovery command); pinned by test_contract_fixtures.CiDiscovery",
    "package.json": "scripts only (`test:py`); version 0.10.1 untouched; pinned by test_contract_fixtures.CiDiscovery",
    "PRIVATE.md": "prose about the skill; carries the plugin version 0.8.1, untouched",
}
FIXTURE_CALLERS_PASS = {      # tests that expect a PASS: the audit data is DERIVED from the fixture's real source, never an exemption
    "test_audit.py": "audit_fixtures", "test_checks.py": "audit_fixtures", "test_contract_diagnostics.py": "audit_fixtures", "test_gate_envelope.py": "audit_fixtures", "test_mixed_order.py": "audit_fixtures", "test_opencode_adapter.py": "audit_fixtures",
    "test_run_binding.py": "audit_fixtures", "test_scope_filter.py": "audit_fixtures", "test_doc_end_to_end.py": "audit.py", "test_audit_fixes.py": "audit_fixtures", "test_audit_copies.py": "audit_fixtures"}
FIXTURE_CALLERS_NON_PASS = {  # tests that call a writer / the gate and assert a non-PASS status, a delivery state or the Markdown only
    "test_base_freshness.py": "asserts `status != PASS` and the delivery gate", "test_common_filter.py": "asserts FAIL/UNRESOLVED of omission pairs", "test_identity_matrix.py": "the matrix: declared fields of the outputs (statuses are UNRESOLVED or FAIL, or only checked to be a status)",
    "test_identity_places.py": "identity places; no PASS expectation", "test_opencode_diagnostics.py": "asserts `status != PASS`", "test_provenance.py": "asserts UNRESOLVED", "test_retry_advice.py": "advice codes; the status is not asserted as PASS",
    "test_run_selection.py": "asserts the run selection and exclusions; no PASS expectation", "test_status_token.py": "the Markdown token; the displayed status equals the audited JSON, whatever it is", "test_versions_gate.py": "asserts delivery states (verified_version is not PASS)",
    "test_work_locations.py": "material availability; no PASS expectation"}

def scan():
    """Every call site of a changed function in a non-test script: a call by name or attribute, a call through an import alias (`from versions import gate as g`) and `getattr(x, "gate")`. -> {(file, callee, enclosing function)}."""
    out = set()
    for f in sorted(glob.glob(os.path.join(HERE, "*.py"))):
        name = os.path.basename(f)
        if name.startswith("test_") or name == "audit_fixtures.py" or name == "contract_fixtures.py": continue
        tree = ast.parse(open(f, encoding="utf-8").read()); alias = {}
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom):
                for a in n.names:
                    if a.name in CALLEES and a.asname: alias[a.asname] = a.name
        def walk(node, enc):
            for ch in ast.iter_child_nodes(node):
                e = enc + [ch.name] if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) else enc
                if isinstance(ch, ast.Call):
                    fn = ch.func; nm = fn.attr if isinstance(fn, ast.Attribute) else alias.get(fn.id, fn.id) if isinstance(fn, ast.Name) else None
                    if nm == "getattr" and len(ch.args) >= 2 and isinstance(ch.args[1], ast.Constant) and ch.args[1].value in CALLEES: nm = ch.args[1].value
                    if nm in CALLEES and not (name == "omissions.py" and nm == "bind"): out.add((name, nm, ".".join(e) or "<module>"))
                walk(ch, e)
        walk(tree, [])
    return out

# ---------------------------------------------------------------- the reach check: does a mapped regression really EXECUTE the claimed call site?
_DEFS = {}
def def_paths(fname):
    """[(first line, last line, dotted path of enclosing functions)] of every function of a script (the path `scan` reports; classes are not part of it)."""
    if fname not in _DEFS:
        out = []
        def walk(node, enc):
            for ch in ast.iter_child_nodes(node):
                e = enc + [ch.name] if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) else enc
                if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)): out.append((ch.lineno, ch.end_lineno, ".".join(e)))
                walk(ch, e)
        walk(ast.parse(open(os.path.join(HERE, fname), encoding="utf-8").read()), []); _DEFS[fname] = out
    return _DEFS[fname]

def site_of(frame):
    """-> (script, dotted enclosing function) of the first frame at or above `frame` that runs code of a script of the skill; a lambda or a comprehension counts as the function that contains it."""
    while frame is not None:
        co = frame.f_code; path = os.path.abspath(co.co_filename)
        if os.path.dirname(path) == HERE and path.endswith(".py"):
            f = os.path.basename(path); inner = co.co_name in ("<lambda>", "<listcomp>", "<genexpr>", "<dictcomp>", "<setcomp>")
            if co.co_name == "<module>": return f, "<module>"
            rows = [(b - a, p) for a, b, p in def_paths(f) if (a <= co.co_firstlineno <= b if inner else a == co.co_firstlineno)]
            if rows: return f, min(rows)[1]
        frame = frame.f_back
    return None, None

def callee_of(frame):
    """The changed function whose frame this is (None for any other): the function itself, or the class whose constructor `__init__` runs (audit.Context)."""
    co = frame.f_code; nm = co.co_name; base = os.path.basename(co.co_filename)
    if nm == "__init__" and base == "audit.py": nm = type(frame.f_locals.get("self")).__name__
    return nm if nm in CALLEES and base == CALLEE_FILE.get(nm) else None

def run_under_spy(test_ids):
    """Run the tests in-process, one suite (consecutive tests of a class share its fixtures), with a profiler that records every EXECUTED call site of a changed function: a frame of the callee (CALLEE_FILE) whose caller is a function of a
    script of the skill (a lambda or a comprehension counts as its enclosing function). Aliases, getattr, `from x import y as z` and calls embedded in other helpers are all seen: the frame is what ran, not what the source spells.
    -> ({test id: set of (file, callee, enclosing function)}, {test id: result}). Hits during a class fixture (setUpClass: the worlds of identity_world) count for every test of that class."""
    hits, results, pending, fixture, state = {}, {}, set(), {}, {"cur": None}
    def prof(frame, event, arg):
        if event != "call": return
        nm = callee_of(frame)
        if nm is None: return
        f, enc = site_of(frame.f_back)
        if f is None or enc is None: return
        (hits.setdefault(state["cur"], set()) if state["cur"] else pending).add((f, nm, enc))
    class R(unittest.TestResult):
        def startTest(self, test):
            super().startTest(test); cls = type(test)
            if pending: fixture.setdefault(cls, set()).update(pending); pending.clear()
            state["cur"] = test.id(); state["cls"] = cls
        def stopTest(self, test): super().stopTest(test); state["cur"] = None
    def key(i): return i.rsplit(".", 1)[0]
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromNames(sorted(set(test_ids), key=key))); res = R(); classes = {t.id(): type(t) for t in iter_tests(suite)}; sys.setprofile(prof)
    try: suite.run(res)
    finally: sys.setprofile(None)
    for tid in test_ids: hits[tid] = hits.get(tid, set()) | fixture.get(classes.get(tid), set())
    bad = {t.id(): tb for t, tb in res.failures + res.errors}
    return hits, bad

def iter_tests(suite):
    for t in suite:
        if isinstance(t, unittest.TestSuite): yield from iter_tests(t)
        else: yield t

WRITERS = {"write_report", "bind_report", "gate", "cmd_status", "per_version"}
def calls_a_writer(path):
    """Does a test file call a writer or the gate? By name, attribute, import alias (`from versions import gate as g`, `import versions as V`; `V.gate`), getattr string, an embedded call in a helper it defines, a `main(` of the CLI modules
    and a CLI invocation of the gate (`cli("versions.py", ["status", ...])`)."""
    tree = ast.parse(open(path, encoding="utf-8").read()); alias = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                if a.name in WRITERS: alias[a.asname or a.name] = a.name
    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            fn = n.func; nm = fn.attr if isinstance(fn, ast.Attribute) else alias.get(fn.id) if isinstance(fn, ast.Name) else None
            if nm in WRITERS: return True
            if isinstance(fn, ast.Name) and fn.id == "getattr" and len(n.args) >= 2 and isinstance(n.args[1], ast.Constant) and n.args[1].value in WRITERS: return True
            if isinstance(fn, ast.Attribute) and fn.attr == "main" and isinstance(fn.value, ast.Name) and fn.value.id in ("versions", "V", "report", "R"): return True
        if isinstance(n, ast.Call):      # a CLI invocation of the gate: `cli("versions.py", ["status", ...])`, a subprocess list with both words
            words = {x.value for x in ast.walk(n) if isinstance(x, ast.Constant) and isinstance(x.value, str)}
            if "versions.py" in words and "status" in words: return True
    return False

class Table(unittest.TestCase):
    def test_the_call_sites_found_in_the_code_are_exactly_the_sites_of_the_table(self):
        found = scan(); declared = {k for k in SITES if k[2] != "<definition>"}
        self.assertEqual(found - declared, set(), "call sites with no regression and no reason: add them to SITES")
        self.assertEqual(declared - found, set(), "table rows whose call site no longer exists")

    def test_every_regression_of_the_table_really_executes_its_call_site(self):
        """The mapped tests are RUN (in this process, under a profiler): every one of them must execute the claimed call site (the callee entered from the claimed enclosing function). A test that merely exists, or that only calls the callee
        directly, or whose CLI runs in a subprocess, does not count. The sites of identity_world (class fixtures shared by the matrix) are checked by building the world under the profiler and by requiring the mapped tests to consume it."""
        rows = {k: v[1] for k, v in SITES.items() if v[0] == "regression" and k[2] != "<definition>" and k[0] != "identity_world.py"}
        hits, bad = run_under_spy(sorted({t for ts in rows.values() for t in ts})); self.assertEqual(bad, {}, "a mapped regression fails when it runs alone")
        for site, tests in rows.items():
            for t in tests: self.assertIn(site, hits[t], "%s does not execute the call site %s" % (t, site))
        import identity_world as IW, inspect
        sites = {k for k, v in SITES.items() if k[0] == "identity_world.py" and v[0] == "regression" and k[2] != "<definition>"}; seen = set(); state = {}
        def prof(frame, event, arg):
            nm = callee_of(frame) if event == "call" else None
            if nm:
                f, enc = site_of(frame.f_back)
                if f: seen.add((f, nm, enc))
        sys.setprofile(prof)
        try: w = IW.World()
        finally: sys.setprofile(None); w.close()
        self.assertEqual(sites - seen, set(), "the world does not execute these identity_world call sites")
        for site in sites:
            for tid in SITES[site][1]:
                mod, cls, name = tid.split("."); fn = getattr(getattr(sys.modules[mod] if mod in sys.modules else __import__(mod), cls), name)
                self.assertIn("world()", inspect.getsource(fn) + inspect.getsource(getattr(sys.modules[mod], cls)), "%s does not consume the world that executes %s" % (tid, site))

    def test_the_spy_distinguishes_a_test_that_reaches_the_caller_from_one_that_only_calls_the_callee(self):
        """The failure the reach check exists for: a test that calls jevref.bind itself passes without ever running bind_report or the gate."""
        class T(unittest.TestCase):
            def test_callee_only(self): jevref.bind([], [], "R04")
            def test_through_the_writer(self):
                with tempfile.TemporaryDirectory() as d: report.write_report(d, os.path.join(d, "n.md"), {}, "Stare: **PASS**\n", calls_jsonl=os.devnull)
        T.__qualname__ = "_SpyT"; sys.modules[__name__]._SpyT = T
        try: hits, bad = run_under_spy(["%s._SpyT.%s" % (__name__, n) for n in ("test_callee_only", "test_through_the_writer")])
        finally: del sys.modules[__name__]._SpyT
        self.assertEqual(bad, {}); only, writer = (hits["%s._SpyT.%s" % (__name__, n)] for n in ("test_callee_only", "test_through_the_writer"))
        self.assertEqual({h for h in only if not h[0].startswith("test_")}, set()); self.assertIn(("report.py", "bind", "bind_report"), writer); self.assertIn(("report.py", "bind_report", "write_report"), writer); self.assertIn(("audit.py", "validate_report", "structure"), writer)

    def test_the_definition_of_apply_patch_exists_and_the_comment_names_are_not_functions(self):
        self.assertTrue(callable(report.apply_patch))
        for name in ("audit_run", "audit_trigger", "score"):
            for mod in (jevref, report, versions): self.assertFalse(callable(getattr(mod, name, None)), "%s.%s" % (mod.__name__, name))
        txt = open(os.path.join(HERE, "jevref.py"), encoding="utf-8").read(); self.assertIn("audit_run, audit_trigger, score", txt)      # only a comment

    def test_every_regression_named_by_the_table_exists(self):
        import unittest as u
        for site, (disp, what) in SITES.items():
            self.assertIn(disp, ("regression", "non-applicable"), site)
            if disp == "non-applicable": self.assertTrue(isinstance(what, str) and len(what) > 40, site); continue
            self.assertTrue(what, site)
            for tid in what:
                try: suite = u.defaultTestLoader.loadTestsFromName(tid)
                except Exception as e: self.fail("%s -> %s: %s" % (site, tid, e))
                self.assertEqual(suite.countTestCases(), 1, "%s -> %s does not name exactly one test" % (site, tid))

    def test_every_test_that_calls_a_writer_or_the_gate_is_classified(self):
        callers = {os.path.basename(f) for f in glob.glob(os.path.join(HERE, "test_*.py")) if calls_a_writer(f)} - {"test_caller_table.py"}
        known = set(FIXTURE_CALLERS_PASS) | set(FIXTURE_CALLERS_NON_PASS)
        self.assertEqual(callers - known, set(), "classify these test files (derived audit data or no PASS expectation)")
        for f, need in FIXTURE_CALLERS_PASS.items(): self.assertIn(need, open(os.path.join(HERE, f), encoding="utf-8").read(), f)
        for f in FIXTURE_CALLERS_NON_PASS:
            t = open(os.path.join(HERE, f), encoding="utf-8").read(); self.assertNotIn("AF.complete(", t, f); self.assertNotIn("audit_fixtures.complete(", t, f)      # nothing to exempt: they do not build a complete audit because they do not rely on a PASS (audit_fixtures.shell only adds the required properties)

    def test_the_outside_sites_exist_and_the_other_directories_hold_no_caller(self):
        root = os.path.realpath(os.path.join(HERE, "..", "..", ".."))
        for rel in OUTSIDE: self.assertTrue(os.path.exists(os.path.join(root, rel)), rel)
        skip = {"node_modules", ".git", "dist", ".handoff-verify", "results"}; rx = re.compile(r"write_report|bind_report|apply_patch|render_md|per_version|audit\.certify|versions\.gate|audited_status|cmd_status")
        for d in ("commands", "hooks", "agents", ".claude-plugin", "src", "docs", "test", ".agents"):
            for base, dirs, files in os.walk(os.path.join(root, d)):
                dirs[:] = [x for x in dirs if x not in skip]
                for fn in files:
                    p = os.path.join(base, fn)
                    try: txt = open(p, encoding="utf-8").read()
                    except (OSError, UnicodeDecodeError): continue
                    self.assertIsNone(rx.search(txt), "%s names a changed function" % os.path.relpath(p, root))

class ChecksBuilder(unittest.TestCase):
    def test_a_check_with_a_verdict_outside_the_tool_contract_is_built_and_never_resolved(self):
        """The non-applicability of checks.build_checks, checked: `bound` is untouched by the verdict domain, the later rebinding does not resolve it, and no status can be PASS."""
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); s = TC.Session(d); s.tool("w1", "Write", dict(file_path=s.handoff, content=TC.V1), "File created successfully")
            body = CF.verify_body([dict(claim=TC.CLAIM, verdict="supported", confidence=0.99)], compatible_synthetic=True, negative=True)
            s.jev("su", "verify", dict(claims=[TC.CLAIM], evidence=[dict(text="Friday is the date.")]), json.loads(body))
            with open(s.log, "w", encoding="utf-8") as f: f.write("".join(json.dumps(x) + "\n" for x in s.recs))
            open(s.handoff, "w", encoding="utf-8").write(TC.V1)
            built = checks.build_checks([s.spec("a", "su", 0)], **s.kw()); self.assertEqual([(c["verdict"], c["confidence"]) for c in built], [("supported", 0.99)])
            doc = report.bind_report(dict(session=dict(session_id="s1", jsonl=s.log, cwd=d), handoff=dict(path=s.handoff, versions=[]), checks=built, findings=[], unresolved=[], status="PASS", schema_version="1"), s.log, d, (), True, s.handoff, None, "R04")
            b = doc["checks"][0]["binding"]; self.assertEqual((b["bound"], b["resolved"]), (True, False)); self.assertIn("contract_reason", b); self.assertNotEqual(doc["status"], "PASS")

if __name__ == "__main__": unittest.main()

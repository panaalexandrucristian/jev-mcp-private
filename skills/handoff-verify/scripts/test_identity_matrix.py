#!/usr/bin/env python3
"""The EXHAUSTIVE identity-output matrix (stdlib, offline, invented sessions in temporary directories; the real commands run, nothing is mocked): every place that PRINTS or PERSISTS an identity (a source / note / write / run /
stage / tool_use id, a resolved path, a work location, a file name) across prepare.py, omissions.py (prepare, prepare-batch, ledger), scope.py, versions.py (list, status, gate) and report.py (write_report: files, JSON, Markdown).

`ROWS` is the matrix (id, command, source location, the output fields it covers as `stream:/json/path`, the kind of treatment, boundary, policy or the specific reason why the strict policy is NOT applied, and the exact tests).
Kinds of treatment: ENFORCED = the shared identity policy decides before the identity leaves (an unsafe one is refused or withheld, never echoed, never replaced); SANITIZED = text under the shared sanitization policy (an id inside
prose is rendered by `omissions.id_text`: a refused one is a marker, never the id); CALLER = a value the caller GAVE is echoed only when the policy keeps it; COPY = a surface that prints the identity EXACTLY as the transcript or the
file system recorded it so that it can be copied (the bindings compare it byte-for-byte; a placeholder would not be the identity; every consumer above refuses an unsafe one); ECHO = the report document as the writer supplied it;
NONID = not an identity (content hash, enum, count, flag, fixed text).
`test_every_string_leaf_of_every_output_is_classified` is the exhaustiveness guard: every string leaf that the real commands print or persist on the invented sessions of `identity_world.py` must be named by a row (an EMPTY list is classified by
the element fields that the rows declare for it, and those are checked by the next guard). `test_every_declared_field_is_produced_or_its_absence_is_explained` is the converse guard: a declared field must be produced (non-empty) by the invented sessions,
or be listed in `UNPRODUCED` with the specific reason (an empty-container marker, a non-string value or a branch that cannot be reproduced offline): an empty list is NOT coverage of the fields it would contain. Coverage limit of the whole matrix:
it is exactly the fields that the invented sessions produce (A..K in identity_world.py) plus the `UNPRODUCED` list; a branch that no invented session reaches is not covered, and `OBSERVATIONS` lists the gaps found and not repaired.
OBSERVATIONS (OB*) are unrelated historical gaps that this work does not repair: each is identified and pinned by a characterization test, so a future change shows.
Retrospective evidence: the tests of this file were written after the implementation (several characterize existing behaviour); none of the behaviour tests was run red first. The only red evidence of this file is the completeness guard: it was run
against the previous declarations after the fixtures for the branches below were added, and listed the undeclared fields (see the council report). The rows RP07-RP10 classify EVERY string leaf of a rich report (all the standard fields of report.schema.json that an author can set, enum and content fields included, not only identities). The red evidence of the ambiguity fix is in test_identity_ambiguity.py.
usage: python3 -B test_identity_matrix.py [-v] | --matrix"""
import importlib, json, os, re, sys, unittest
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import identity_world as IW
import audit_fixtures as AF
from identity_world import BODY, Q, WID1, WID2, RID, STAGE_A, STAGE_S, JEV, B_WID, B_R1, B_R2, cli, leaves
from test_obligation_ledger import Tx, write, NOTE
import ledger as L, omissions as O, sanitize as S

Row = namedtuple("Row", "id cmd where fields kind boundary policy tests")
def F(stream, *paths): return [stream + ":" + p for p in paths]

T_ROLES, T_PLACES, T_AMB, T_SCOPE, T_MX = "test_identity_roles", "test_identity_places", "test_identity_ambiguity", "test_scope_identities", "test_identity_matrix"
ROWS = [
 Row("PR01", "prepare.py", "prepare.py main (error prints), omissions.check_locations, omissions.shown", F("prepare.err", "/error", "/arg", "/resolution"), "CALLER", "stdout (error)",
     "o --location nesigur e refuzat si nu e repetat; argumentul sesiunii dat de apelant e repetat doar daca politica il pastreaza (shown -> None); mesajele fixe nu poarta valori; /resolution = enum fix al discover.resolve_session_info (path | id | env:CLAUDE_SESSION_ID | heuristic_most_recent | none), "
     "produs de ramura 'mai multe sesiuni recente' (exit 3, heuristic_most_recent, fixtura L: CLAUDE_PROJECTS_DIR temporar, fara CLAUDE_SESSION_ID)", [T_MX + ".Prepare.test_pr01_given_values", T_MX + ".Prepare.test_pr01_several_recent_sessions_are_not_a_demonstrated_current_session"]),
 Row("PR02", "prepare.py", "prepare.py main (print final)", F("prepare.out", "/work", "/session_id", "/session_cwd", "/session_cwds[]", "/note_dirs[]", "/blockers[]", "/work_locations[]"), "COPY", "stdout",
     "cai locale afisate exact asa cum le-a inregistrat transcriptul / sistemul de fisiere (de copiat); work_locations au trecut deja prin check_locations; blockers[] = text cu calea notei si, dupa caz, id-urile apelurilor nepozitionate (OpenCode) sau numele fluxurilor "
     "(subagent) exact cum sunt inregistrate (COPY, OB6); consumatorii (omissions/scope/ledger) refuza o cale nesigura", [T_MX + ".Prepare.test_pr02_pr03_summary_and_session", T_MX + ".Prepare.test_pr05_reasons_carry_recorded_call_ids_and_stream_names", T_MX + ".Observations.test_ob1_prepare_prints_an_unsafe_recorded_path_raw", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),
 Row("PR03", "prepare.py", "prepare.py (inv: session)", F("prepare.inv", "/session/session_id", "/session/jsonl", "/session/cwd", "/session/work_locations[]", "/session/subagents[]", "/session/diagnostics[]", "/session/diagnostics[]/call_id", "/session/diagnostics[]/kind", "/session/diagnostics[]/path", "/session/diagnostics[]/reason", "/session/diagnostics[]/source_file"), "COPY", "inventory.json",
     "ca PR02; subagents = fisierele transcript din <sesiune>/subagents (cale exacta); diagnostics = mutarile REUSITE ale adaptorului OpenCode fara pozitie (opencode.diagnostics + source_file): call_id = id-ul apelului exact asa cum l-a inregistrat OpenCode, path = calea reala afectata, "
     "source_file = selectorul sesiunii, kind = enum (untimed / pathless), reason = text fix despre timp; nu devin legatura (versiunea cu unpositioned nu certifica), iar consumatorii refuza un id nesigur; goale pentru o sesiune Claude",
     [T_MX + ".Prepare.test_pr02_pr03_summary_and_session", T_MX + ".Prepare.test_pr03_opencode_diagnostics", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),
 Row("PR04", "prepare.py", "prepare.py (inv: handoffs, explicit_targets)", F("prepare.inv", "/handoffs[]/path", "/handoffs[]/aliases[]", "/handoffs[]/copies[]", "/handoffs[]/disposition", "/handoffs[]/provenance", "/handoffs[]/blockers[]", "/handoffs[]/disk_sha256",
     "/handoffs[]/streams[]/source_file", "/handoffs[]/streams[]/source_kind", "/handoffs[]/versions[]", "/handoffs[]/ordering/reason"), "COPY", "inventory.json",
     "calea canonica, alias-urile, copiile verificate si randul extern (--target) sunt cai locale exacte; hash-ul de pe disc nu e o identitate; ordering.reason = text fix (NONID: 'independent transcripts have no demonstrated common order', fara cale si fara id); blockers[] ca in PR02",
     [T_MX + ".Prepare.test_pr04_handoffs_aliases_copies_external", T_MX + ".Prepare.test_pr04_mixed_stream_ordering_reason_is_fixed_text"]),
 Row("PR05", "prepare.py", "prepare.py (inv: versions)", F("prepare.inv", "/handoffs[]/versions[]/tool_use_id", "/handoffs[]/versions[]/uuid", "/handoffs[]/versions[]/file", "/handoffs[]/versions[]/source_file", "/handoffs[]/versions[]/prefix_source_file",
     "/handoffs[]/versions[]/prefix_chunks[]", "/handoffs[]/versions[]/write_pos[]", "/handoffs[]/versions[]/timestamp", "/handoffs[]/versions[]/status", "/handoffs[]/versions[]/reason", "/handoffs[]/versions[]/op", "/handoffs[]/versions[]/mixed[]",
     "/handoffs[]/versions[]/unpositioned[]", "/handoffs[]/versions[]/evaluated_against", "/handoffs[]/versions[]/sha256", "/handoffs[]/versions[]/source_kind"), "COPY", "inventory.json",
     "ID-ul de scriere (rol tool_use_id) si ceilalti identificatori sunt afisati exact (legarea compara octet cu octet; un placeholder nu ar fi identitatea); numele artefactelor si ale chunk-urilor sunt cele de pe disc; reason (versiune 'content not recoverable') poate numi id-urile "
     "apelurilor nepozitionate si numele fluxurilor care scriu aceeasi cale, exact cum sunt inregistrate (COPY, OB6)", [T_MX + ".Prepare.test_pr05_versions_keep_clean_long_ids_exactly", T_MX + ".Prepare.test_pr05_reasons_carry_recorded_call_ids_and_stream_names", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),
 Row("PR06", "prepare.py", "prepare.py (inv: unplaced, classification, failed, unlinked, excluded, env)", F("prepare.inv", "/unplaced_writes[]/op", "/unplaced_writes[]/path", "/unplaced_writes[]/reason", "/unplaced_writes[]/source_file", "/unplaced_writes[]/tool_use_id",
     "/needs_jev_classify[]/excerpt_hint", "/needs_jev_classify[]/path", "/needs_jev_classify[]/tool_use_id", "/needs_jev_classify[]/uuid", "/failed_writes[]/op", "/failed_writes[]/path", "/failed_writes[]/tool_use_id",
     "/unlinked_bash[]/note", "/unlinked_bash[]/path", "/unlinked_bash[]/tool_use_id", "/excluded_non_text[]", "/env_excluded[]"), "COPY", "inventory.json",
     "liste informative ale fisierelor pe care sesiunea le-a scris; caile si id-urile sunt cele inregistrate (exact); nicio lista nu devine legatura fara a trece prin PR05/consumatori; un fisier .env e listat dar niciodata deschis", [T_MX + ".Prepare.test_pr06_other_lists"]),
 Row("PR07", "prepare.py", "prepare.py artifact(), flush() (fisiere pe disc)", F("prepare.files", "[]"), "COPY+SANITIZED", "nume de fisiere si continut",
     "numele: handoffs/<basename>-<hash8>.vN.md si transcript/chunk-NNNN.txt (basename-ul notei exact; hash din calea reala); CONTINUTUL artefactelor si al chunk-urilor trece prin sanitizarea generica (o valoare secreta DEMONSTRABILA nu ajunge in ele; un credential dupa un prefix de provider NU e vazut de ea, OB12); "
     "VERIFICAT doar atat: campurile structurale ale unui apel (id / tool_use_id) nu sunt serializate ca identitate de apel in chunk: antetul unui chunk e `[uuid rol]` (uuid-ul inregistrarii) iar un apel apare ca `[tool_use Nume] <input>` / `[tool_result] <iesire>`; "
     "textul unui input / rezultat POATE totusi mentiona o asemenea valoare (de ex. un id `call_...`) si trece prin sanitizarea generica (pastrat daca nu e un secret demonstrabil: caracterizat de OB12). Nu se afirma ca niciun credential sau niciun tool_use_id nu e in chunk-uri",
     [T_MX + ".Prepare.test_pr07_artifact_names_and_sanitized_contents", T_MX + ".Prepare.test_pr07_chunk_headers_are_record_uuids_and_structural_call_ids_are_not_serialized", T_MX + ".Observations.test_ob12_a_call_id_in_a_result_text_survives_in_the_chunk", T_MX + ".Observations.test_ob2_an_artifact_name_keeps_the_note_basename"]),
 Row("PR08", "prepare.py", "prepare.py (cov)", F("prepare.cov", "/continuation", "/merged_view", "/audit_note", "/audit_registry", "/chunk_list[]/file", "/chunk_list[]/sha256", "/sanitization/canary_leaks[]", "/sanitization/redactions{}"), "NONID", "coverage.json",
     "numaratori, rezumatul sanitizarii si texte fixe; provenienta chunk-urilor/acoperirii e in PR05 (prefix_chunks) si in numele din PR07; nicio cale si niciun id", [T_MX + ".Prepare.test_pr08_coverage_holds_no_identity"]),

 Row("OM01", "omissions.py prepare / prepare-batch", "omissions._prepare_one (write/run guards, ctx['run']), version_ref", F("omissions.prepare", "/version_ref/write_tool_use_id", "/version_ref/run", "/version_ref/evaluated_against", "/version_ref/sha256", "/handoff_source_path"),
     "ENFORCED", "stdout", "rol tool_use_id: un id inregistrat fara credentiale e pastrat octet cu octet (inclusiv sufixele ~n/#k), orice altceva care necesita redactare e refuzat (exit 3), nu e repetat si nu e inlocuit; handoff_source_path (reloc) trece prin politica stricta",
     [T_ROLES + ".Preparation.test_long_write_ids_are_prepared_and_kept", T_ROLES + ".Preparation.test_long_named_and_selected_run_ids_are_prepared_and_kept", T_ROLES + ".Preparation.test_the_single_prepare_command_keeps_long_ids_too",
      T_ROLES + ".Preparation.test_unsafe_write_ids_are_not_ready_and_never_echoed", T_ROLES + ".Preparation.test_unsafe_run_ids_are_not_ready_and_never_echoed", T_ROLES + ".Lifecycle.test_long_write_ids_complete_the_whole_lifecycle", T_MX + ".Omissions.test_om01_a_verified_copy_names_the_written_path"]),
 Row("OM02", "omissions.py prepare / prepare-batch", "omissions.check_locations, material_bases, _prepare_one fail()", F("omissions.prepare", "/work_locations[]") + F("omissions.prepare.fail", "/work_locations[]"), "ENFORCED", "stdout",
     "o locatie cu secret / marker e refuzata inainte (nu e repetata); cele curate sunt afisate exact; pe esec lista trece prin safe_list (politica stricta)", [T_MX + ".Omissions.test_om02_work_locations"]),
 Row("OM03", "omissions.py prepare", "omissions._build_material (manifest, missing_reference)", F("omissions.prepare", "/material_manifest[]/path", "/material_manifest[]/ref", "/material_manifest[]/resolution", "/material_manifest[]/sha256")
     + F("omissions.prepare.fail", "/missing_reference/ref", "/missing_reference/reason", "/missing_reference/searched[]", "/missing_reference/kind"), "ENFORCED+SANITIZED", "stdout",
     "calea rezolvata / rezolutia care necesita redactare face materialul indisponibil (kind=redaction, nimic nu e trimis); ref e textul din nota (nota cu secret e refuzata); pe esec campurile missing_reference trec prin sanitize / safe_list", [T_MX + ".Omissions.test_om03_manifest_and_missing_reference"]),
 Row("OM04", "omissions.py prepare", "omissions.build_hints", F("omissions.prepare", "/hints/source", "/hints/identifiers[]", "/hints/requests[]/identifier", "/hints/source_records[]/identifier", "/hints/source_records[]/kind", "/hints/source_records[]/uuid",
     "/hints/material_matches[]", "/hints/material_matches[]/identifier", "/hints/material_matches[]/ref", "/hints/material_matches[]/section", "/hints/limits", "/hints/note", "/hints/truncated{}"), "COPY+SANITIZED", "stdout",
     "doar navigare: sursa e calea canonica deja verificata (sp si canon(sp)), uuid-urile sunt ale inregistrarilor transcriptului, identificatorii vin din detaliul deja verificat (un detaliu cu secret e refuzat inainte); material_matches[]: identifier = acelasi identificator, "
     "section = enum (note | reference), ref = textul referintei directe asa cum e scris in nota (aceeasi valoare ca material_manifest[].ref, deja rezolvata de politica stricta; null pentru sectiunea nota), line/column numerice; truncated{} are chei = identificatori (navigare)",
     [T_MX + ".Omissions.test_om04_hints", T_MX + ".Omissions.test_om04_material_matches_name_the_note_and_the_reference"]),
 Row("OM05", "omissions.py prepare / prepare-batch", "omissions._prepare_one (detail, quote, passage, material)", F("omissions.prepare", "/absence_claim", "/source_claim", "/detail", "/material", "/source_passage", "/omission_ref_template/detail", "/omission_ref_template/source_check_id", "/contract", "/note"),
     "SANITIZED", "stdout", "continutul trimis la Jev: o redactare noua sau un marker in nota / detaliu / citat / pasaj il face indisponibil (exit 3, valoarea nu e repetata)", [T_MX + ".Omissions.test_om05_payloads_with_secrets_are_refused"]),
 Row("OM06", "omissions.py prepare / prepare-batch", "omissions._prepare_one fail(), source_window (id_text), safe_list", F("omissions.prepare.fail", "/reasons[]", "/runs[]") + F("omissions.prepare", "/reasons[]", "/runs[]"), "SANITIZED", "stdout",
     "motivele trec prin sanitize iar id-urile din proza ferestrei prin id_text (un id refuzat devine markerul [REDACTED:identity], niciodata id-ul); lista structurata runs pastreaza id-urile curate exact si arata markerul pentru cele refuzate (safe_list, rol tool_use_id)",
     [T_AMB + ".Outputs.test_prepare_and_prepare_batch_do_not_print_the_refused_id", T_AMB + ".Outputs.test_the_clean_run_ids_stay_in_the_runs_list_exactly", T_AMB + ".SafeList.test_a_refused_id_is_never_rendered_by_the_diagnostic_copy"]),
 Row("OM07", "omissions.py prepare / prepare-batch", "omissions.source_window / _prepare_one fail(), versions.mixed_reason (versiune mixed)", F("omissions.prepare.fail", "/reasons[]"), "SANITIZED", "stdout",
     "refuzul pentru o cale scrisa in mai multe fluxuri: textul numeste fluxurile prin basename (ex. agent-1.jsonl), fara id de scriere si fara cale; trece prin sanitize generic (nu prin id_text); un id de apel nepozitionat din OpenCode ar fi exact in proza unui motiv generat de versions (OB6: prepare / versions list / status o tiparesc exact)",
     [T_MX + ".OmissionsMixed.test_om07_a_mixed_stream_refusal_names_streams_by_basename", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),
 Row("LG01", "omissions.py prepare-batch --ledger", "ledger._guard, row_of (args)", F("ledger.file", "/obligations[]/args/source", "/obligations[]/args/file", "/obligations[]/args/cwd", "/obligations[]/args/location[]", "/obligations[]/args/write_id",
     "/obligations[]/args/run", "/obligations[]/args/evaluated_against", "/obligations[]/args/detail", "/obligations[]/args/quote", "/obligations[]/args/withheld[]"), "ENFORCED", "fisierul ledger (persistat)",
     "campurile de identitate nesigure sunt retinute (withheld:sha256:<hash>, nu o cale, nu se reia), randul devine unavailable; write_id/run au rolul tool_use_id; detaliul/citatul cu secret nu se stocheaza",
     [T_MX + ".Ledger.test_lg01_lg02_guard_every_identity_field", T_PLACES + ".Places.test_the_ledger_file_keeps_clean_long_ids_and_paths_and_withholds_an_unsafe_location", T_ROLES + ".Preparation.test_unsafe_write_ids_are_not_ready_and_never_echoed", T_MX + ".Ledger.test_lg01_a_real_ledger_file_withholds_a_credential_behind_a_prefix"]),
 Row("LG02", "omissions.py prepare-batch --ledger", "ledger._guard, identity_of (identity)", F("ledger.file", "/obligations[]/identity/source", "/obligations[]/identity/file", "/obligations[]/identity/write_id", "/obligations[]/identity/run", "/obligations[]/identity/evaluated_against",
     "/obligations[]/identity/references[]/ref", "/obligations[]/identity/references[]/path", "/obligations[]/identity/references[]/resolution", "/obligations[]/identity/references[]/sha256", "/obligations[]/id", "/obligations[]/state"), "ENFORCED", "fisierul ledger (persistat)",
     "ca LG01 (source, file, write_id, run, references[] ref/path/resolution); id-ul obligatiei e un hash al identitatii", [T_MX + ".Ledger.test_lg01_lg02_guard_every_identity_field", T_ROLES + ".Lifecycle.test_long_automatically_selected_run_ids_complete_the_whole_lifecycle"]),
 Row("LG03", "omissions.py ledger record / load", "ledger.record, load (validarea id-urilor de etapa)", F("ledger.file", "/obligations[]/stages/absence[]/tool_use_id", "/obligations[]/stages/source[]/tool_use_id", "/obligations[]/stages{}"), "ENFORCED", "fisierul ledger (persistat)",
     "rol tool_use_id la inregistrare si la incarcare: id-ul curat e pastrat exact, unul nesigur e refuzat fara echo si fisierul nu e atins", [T_ROLES + ".RecordLoadResume.test_long_stage_ids_are_recorded_loaded_and_resumed", T_ROLES + ".RecordLoadResume.test_unsafe_stage_ids_are_refused_without_echo_and_the_ledger_is_untouched",
      T_ROLES + ".RecordLoadResume.test_an_unsafe_stage_id_already_in_a_ledger_refuses_it_without_echo"]),
 Row("LG04", "omissions.py prepare-batch --ledger", "ledger.row_of (reasons), add_rows", F("ledger.file", "/obligations[]/reasons[]", "/audit/note", "/schema") , "SANITIZED", "fisierul ledger (persistat)",
     "motivele persistate sunt cele sanitizate ale prepare (inclusiv id_text in proza ambiguitatii) precedate de UNREPLAYABLE cand ceva a fost retinut", [T_AMB + ".Outputs.test_the_ledger_rows_and_the_resume_do_not_hold_the_refused_id"]),
 Row("LG05", "omissions.py ledger record", "omissions.cmd_ledger, ledger.record", F("ledger.record", "/id", "/note", "/stages/absence[]/tool_use_id", "/stages/source[]/tool_use_id") + F("ledger.err", "/reasons[]"), "ENFORCED+SANITIZED", "stdout",
     "id-ul de etapa se afiseaza doar dupa validare (rol tool_use_id); erorile (LedgerError, OSError) trec prin sanitize si nu repeta valoarea refuzata", [T_ROLES + ".RecordLoadResume.test_unsafe_stage_ids_are_refused_without_echo_and_the_ledger_is_untouched", T_MX + ".Ledger.test_lg05_lg06_record_resume_and_error_outputs"]),
 Row("LG06", "omissions.py ledger resume", "ledger.resume", F("ledger.resume", "/obligations[]/id", "/obligations[]/state", "/obligations[]/next", "/obligations[]/reasons[]", "/obligations[]/stages[]", "/obligations[]/stages[]/stage", "/obligations[]/stages[]/tool_use_id",
     "/obligations[]/stages[]/state", "/obligations[]/stages[]/reason", "/obligations[]/stages[]/observed/verdict", "/obligations[]/stages[]/observed/action", "/coverage/note"), "ENFORCED+SANITIZED", "stdout",
     "randurile se re-deriva din fisiere; ID-urile de etapa curate sunt afisate exact, motivele sunt sanitizate; un rand retinut ramane unavailable (hash)", [T_MX + ".Ledger.test_lg05_lg06_record_resume_and_error_outputs", T_ROLES + ".Lifecycle.test_long_named_run_ids_complete_the_whole_lifecycle"]),

 Row("SC01", "scope.py prepare", "scope.cmd_prepare (verificari inainte de readiness)", F("scope.ok", "/source", "/evaluation/write_tool_use_id", "/evaluation/run", "/evaluation/evaluated_against"), "ENFORCED", "stdout",
     "sursa (data si canonica), id-ul de scriere si run-ul dat/selectat trec prin politica (stricta pentru cai, rol tool_use_id pentru id-uri) inainte de orice ieșire; nesigur -> exit 3 fara payload",
     [T_SCOPE + ".CleanIdentities.test_long_recorded_write_ids_are_printed_exactly", T_SCOPE + ".CleanIdentities.test_long_recorded_run_ids_are_printed_exactly_selected_and_named", T_SCOPE + ".UnsafeIdentities.test_an_unsafe_write_id_is_not_ready",
      T_SCOPE + ".UnsafeIdentities.test_an_unsafe_selected_run_is_not_ready", T_SCOPE + ".UnsafeIdentities.test_an_unsafe_source_path_is_not_ready"]),
 Row("SC02", "scope.py prepare", "scope.payloads, scope_of", F("scope.ok", "/payloads[]/classes[]/description", "/payloads[]/classes[]/id", "/payloads[]/context", "/payloads[]/items[]/id", "/payloads[]/items[]/text", "/payloads[]/purpose", "/scope_sha256", "/note"),
     "SANITIZED", "stdout", "cererile utilizatorului si detaliile sunt sub politica de sanitizare: o cerere / un detaliu cu secret sau marker nu produce payload (nimic nu e exclus, valoarea nu e repetata)", [T_MX + ".Scope.test_sc02_requests_and_details_with_secrets_produce_no_payload"]),
 Row("SC03", "scope.py prepare", "scope.cmd_prepare fail(), omissions.source_window", F("scope.fail", "/reasons[]"), "SANITIZED", "stdout", "motive sanitizate; id-urile din proza ferestrei prin id_text (marker, nu id)",
     [T_AMB + ".Outputs.test_scope_prepare_does_not_print_the_refused_id", T_SCOPE + ".UnsafeIdentities.test_the_ambiguity_of_unsafe_runs_does_not_echo_them"]),

 Row("VR01", "versions.py list", "versions.cmd_list (succes)", F("versions.list", "/source_session_jsonl", "/resolution", "/path", "/path_match", "/handoff_source_path", "/evaluated_against", "/versions[]/write_tool_use_id", "/versions[]/uuid", "/versions[]/op",
     "/versions[]/state", "/versions[]/sha256", "/versions[]/mixed[]", "/versions[]/unpositioned[]", "/versions[]/reason", "/versions[]/version_ref/write_tool_use_id", "/versions[]/version_ref/run", "/versions[]/version_ref/evaluated_against",
     "/versions[]/version_ref/sha256", "/versions[]/runs[]", "/blockers[]", "/note"), "COPY", "stdout",
     "suprafata de copiere: id-urile (scriere, run), caile si version_ref sunt exact cele din transcript (legarea compara octet cu octet); consumatorii (omissions, scope, ledger) refuza un id nesigur; nu se inlocuieste nimic; reason (versiune nerecuperabila) si blockers[] sunt proza cu id-urile "
     "apelurilor nepozitionate / numele fluxurilor, exact ca in transcript (COPY, OB6); handoff_source_path = calea scrisa a notei cand fisierul dat e o copie verificata",
     [T_PLACES + ".Places.test_versions_list_keeps_clean_long_write_and_run_ids_and_accepts_a_named_run", T_MX + ".Versions.test_vr01_list_fields", T_MX + ".Versions.test_vr01_a_verified_copy_and_the_blockers", T_MX + ".Observations.test_ob3_versions_list_prints_an_unsafe_recorded_id_raw", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),
 Row("VR02", "versions.py list", "versions.cmd_list (window), omissions.source_window", F("versions.list", "/versions[]/window"), "SANITIZED", "stdout", "proza ambiguitatii: id-urile curate apar ca atare, un id refuzat apare ca marker (id_text); lista runs de langa ea e suprafata de copiere (VR01)",
     [T_MX + ".Versions.test_vr02_window_prose_withholds_a_refused_run"]),
 Row("VR03", "versions.py list", "versions.cmd_list (erori), versions.provenance", F("versions.list.err", "/error", "/resolution", "/source_session_jsonl", "/provenance", "/arg"), "CALLER+COPY", "stdout (eroare)",
     "valorile date de apelant GARDATE: --source (arg, doar cand sesiunea lipseste) si --run respins (in mesaj) sunt repetate doar daca politica le pastreaza (shown); NEGARDAT (OB4): mesajul de provenienta poarta calea --file ceruta, nesanitizata; resolution = enum fix",
     [T_PLACES + ".Places.test_versions_list_does_not_echo_an_unsafe_given_value", T_MX + ".Versions.test_vr03_the_missing_source_argument_is_echoed_when_clean", T_MX + ".Observations.test_ob4_versions_echo_an_unsafe_given_file"]),
 Row("VR04", "versions.py status (gate)", "versions.cmd_status, versions.gate, stale_notice", F("versions.status", "/audited_status", "/audit/reasons[]", "/current_sha256", "/delivery_state", "/latest_write_id", "/reasons[]", "/report_path", "/stale/newer_sha256", "/stale/report_sha256", "/stale_notice",
     "/bound_checks_for_version"), "CALLER+COPY", "stdout",
     "report_path dat de apelant: shown (nesigur -> null); latest_write_id e suprafata de copiere; motivele gate pot repeta calea ceruta (OB4), id-urile din proza ferestrei (id_text) si numele fluxurilor / id-urile apelurilor nepozitionate exact ca in transcript (OB6); "
     "bound_checks_for_version e un intreg (nu e sir)", [T_PLACES + ".Places.test_versions_status_keeps_the_latest_long_write_id_and_does_not_echo_an_unsafe_report_path", T_MX + ".Versions.test_vr04_status_and_stale", T_MX + ".Versions.test_vr04_mixed_stream_gate_reasons", T_MX + ".Observations.test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw"]),

 Row("RP01", "report.py write_report", "report.report_names, prepare/new_run_dir (director de rulare)", F("report.files", "[]"), "COPY", "nume de fisiere",
     "<basename nota>-<hash8>.verify.md/.json (nu se suprascriu); directorul in care se scrie e dat de apelant (vezi RP06 pentru directorul creat de report.new_run_dir); basename-ul e cel real al notei (OB2)", [T_MX + ".Report.test_rp01_file_names"]),
 Row("RP02", "report.py write_report", "report.bind_report (doc ca-l scrie autorul)", F("report.json", "/session/cwd", "/session/jsonl", "/session/session_id", "/handoff/path", "/work_locations[]", "/checks[]/id", "/checks[]/tool", "/checks[]/verdict", "/checks[]/jev_ref/key",
     "/checks[]/jev_ref/tool_use_id", "/checks[]/version_ref/write_tool_use_id", "/checks[]/version_ref/run", "/checks[]/version_ref/evaluated_against", "/checks[]/version_ref/sha256", "/handoff/versions[]/tool_use_id", "/handoff/source_path", "/scope_exclusions[]/classification", "/scope_exclusions[]/detail",
     "/scope_exclusions[]/evaluation/evaluated_against", "/scope_exclusions[]/evaluation/run", "/scope_exclusions[]/evaluation/write_tool_use_id", "/scope_exclusions[]/jev_ref/key", "/scope_exclusions[]/jev_ref/tool_use_id"),
     "ECHO", "raportul persistat", "campurile pe care autorul le-a pus in document sunt pastrate ca atare; identitatile lor sunt RE-DERIVATE din transcript (RP03), unele gresite / nesigure invalideaza verificarea; raportul nu le re-sanitizeaza (OB5)",
     [T_MX + ".Report.test_rp02_rp03_json_fields", T_MX + ".Report.test_rp02_the_author_key_tool_use_id_and_a_bound_prefix_evaluation", T_MX + ".Observations.test_ob5_the_report_echoes_an_unsafe_identity_the_writer_supplied"]),
 Row("RP03", "report.py write_report", "report.bind_report -> versions.bind_versions / provenance / gate / per_version, jevref.bind", F("report.json", "/binding_summary/reasons[]", "/binding_summary/audit/reasons[]", "/handoff/versions[]/binding_summary/audit/reasons[]", "/handoff/versions[]/evaluations/prefix/binding_summary/audit/reasons[]", "/handoff/versions[]/evaluations/session_end/binding_summary/audit/reasons[]", "/binding_summary/version_identity/provenance/path", "/binding_summary/version_identity/provenance/state",
     "/binding_summary/version_identity/provenance/via", "/binding_summary/version_identity/provenance/source_path", "/binding_summary/version_identity/provenance/blocker", "/binding_summary/version_identity/reasons[]", "/checks[]/binding/reason",
     "/handoff/versions[]/attribution", "/handoff/versions[]/audited_status", "/handoff/versions[]/binding_summary/reasons[]", "/handoff/versions[]/evaluations{}", "/handoff/versions[]/sha256",
     "/handoff/versions[]/attributed_write", "/handoff/versions[]/evaluations/session_end/audited_status", "/handoff/versions[]/evaluations/session_end/binding_summary/reasons[]", "/handoff/versions[]/evaluations/prefix/audited_status", "/handoff/versions[]/evaluations/prefix/binding_summary/reasons[]", "/delivery/current_sha256", "/delivery/delivery_state", "/delivery/latest_write_id", "/delivery/reasons[]", "/delivery/stale/newer_sha256", "/delivery/stale/report_sha256",
     "/scope_audit/reasons[]/detail", "/scope_audit/reasons[]/reason", "/jev_ref_version", "/omission_contract", "/schema_version", "/status", "/status_claimed"), "SANITIZED+COPY", "raportul persistat",
     "valorile re-derivate: proza de ambiguitate a ferestrei trece prin id_text (marker pentru un id refuzat); detail-ul unei excluderi respinse e sanitizat; id-ul de scriere atribuit / ultimul si caile sunt cele inregistrate (COPY)",
     [T_MX + ".Report.test_rp02_rp03_json_fields", T_MX + ".Report.test_rp02_the_author_key_tool_use_id_and_a_bound_prefix_evaluation", T_MX + ".Report.test_rp03_provenance_blocker_and_relocation", T_MX + ".Report.test_rp03_unsafe_run_prose_in_the_report", T_MX + ".Report.test_rp03_scope_audit_detail_is_sanitized"]),
 Row("RP04", "report.py render_md", "report.render_md, versions.stale_notice", F("report.md", "(text)"), "SANITIZED+COPY", "Markdown",
     "'Motiv:' reia binding_summary.reasons (aceleasi garantii ca RP03) iar notificarea de invechire e derivata din hash-uri", [T_MX + ".Report.test_rp04_markdown_reasons"]),
 Row("RP05", "report.py write_report", "report.bind_report (calls_log_note; discover.resolve_session_info)", F("report.json", "/binding_summary/calls_log_note"), "CALLER+COPY", "raportul persistat",
     "nota jurnalului de apeluri: null cand jurnalul s-a citit; text fix ('current session log not found' / 'current session not demonstrated (ambiguous)') cand sesiunea curenta nu e data; 'calls log unreadable: <eroarea sistemului>' cand jurnalul dat de apelant nu poate fi citit: textul eroarii poarta "
     "calea data de apelant EXACT si nesanitizata (OB7); jurnalul lipsa nu leaga nicio verificare (UNRESOLVED)", [T_MX + ".Report.test_rp05_calls_log_note", T_MX + ".Observations.test_ob7_an_unreadable_calls_log_path_is_echoed_by_the_report"]),
 Row("RP06", "report.new_run_dir (folosit de prepare.py fara --out)", "report.new_run_dir(session_cwd, session_id, now), prepare.py:84", F("prepare.out", "/work", "/session_id", "/session_cwd") + F("prepare.inv", "/session/session_id", "/session/cwd"), "CALLER+COPY", "directorul creat (intors si tiparit ca 'work') si fisierele din el",
     "<session_cwd>/.handoff-verify/<session_id>/<run_id>: session_cwd = cwd-ul dat (--cwd) sau al sesiunii, session_id vine din transcript (sau argument), run_id = UTC '%Y%m%dT%H%M%S%fZ' generat; componentele sunt folosite exact, FARA sanitizare (OB8); makedirs(exist_ok=False): o coliziune ridica "
     "FileExistsError si nu suprascrie nimic; directorul 'work' e tiparit in rezumat (PR02) si e radacina artefactelor (PR07)", [T_MX + ".Report.test_rp06_new_run_dir_names_collision_and_isolation", T_MX + ".Report.test_rp06_prepare_without_out_uses_the_run_directory", T_MX + ".Observations.test_ob8_new_run_dir_uses_the_session_id_raw"]),
 Row("RP07", "report.py write_report", "report.bind_report (doc ca-l scrie autorul; session / variant / environment / kit / cost / patch / audit)", F("report.json", "/audit/evaluations[]", "/session/line", "/session/continuations", "/session/subagents[]", "/variant/name", "/variant/commit",
     "/environment/model", "/environment/claude_code", "/environment/python", "/environment/jq", "/environment/git", "/environment/kit", "/environment/jev_model", "/kit/status", "/kit/section4", "/kit/skips[]", "/cost/tokens", "/cost/usd", "/cost/wall_s", "/patch/backup"),
     "ECHO", "raportul persistat",
     "campurile de metadate pe care autorul le pune in document sunt pastrate exact si NU sunt re-derivate / re-sanitizate (nicio verificare in write_report): session/subagents[] = caile fisierelor transcript ale subagentilor (COPY din prepare PR03, rol: cale locala), session/line si continuations = text liber al autorului (pozitie / mentiune), "
     "variant/commit = un sha git scris de autor (identificator de continut, nu secret, neverificat), environment/*, kit/* si cost/* = text de continut / versiune / stare (NONID, fara identitate), patch/backup = calea copiei de siguranta intoarsa de report.apply_patch (`<fisier>.bak-<UTC>`, cale locala, neverificata de raport); "
     "limita de persistenta = fisierul .verify.json (si nu Markdown-ul); nu exista politica de identitate aplicata aici (vezi OB10 pentru textul liber)",
     [T_MX + ".Report.test_rp07_session_variant_environment_kit_cost_and_patch_are_persisted_exactly", T_MX + ".Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema", T_MX + ".Observations.test_ob10_free_text_of_the_report_is_persisted_as_supplied"]),
 Row("RP08", "report.py write_report", "report.bind_report (doc: inventory[])", F("report.json", "/inventory[]/path", "/inventory[]/real", "/inventory[]/aliases[]", "/inventory[]/copies[]", "/inventory[]/disposition", "/inventory[]/classification/label", "/inventory[]/classification/reason"),
     "ECHO", "raportul persistat",
     "inventarul din raport e cel pe care autorul l-a copiat din inventory.json al prepare (PR04): path / real / aliases[] / copies[] = cai locale exacte (rol: cale locala), disposition = enum al prepare, classification/* = rezultatul jev_classify scris de autor (continut, NONID); "
     "bind_report NU le re-deriva si nu le sanitizeaza (ECHO); un camp lipsa nu se completeaza; doar [] gol / null ar fi un marker, nu acoperire",
     [T_MX + ".Report.test_rp08_the_inventory_is_persisted_exactly_and_matches_the_prepare_inventory", T_MX + ".Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema"]),
 Row("RP09", "report.py write_report", "report.bind_report -> versions.lookup / per_version (doc: handoff.versions[], source_ranges[])", F("report.json", "/handoff/versions[]/uuid", "/handoff/versions[]/timestamp", "/handoff/versions[]/evaluated_against", "/handoff/versions[]/status", "/source_ranges[]/id", "/source_ranges[]/uuids[]"),
     "ECHO", "raportul persistat",
     "intrarea de versiune pastreaza exact ce a scris autorul (uuid = uuid-ul inregistrarii de scriere, timestamp, evaluated_against = enum prefix | session_end, status = starea declarata de autor); atribuirea o decide DOAR cheia tool_use_id / write_tool_use_id (RP02/RP03) si audited_status / attribution sunt re-derivate si adaugate langa ele; "
     "uuid / timestamp / status NU sunt verificate fata de transcript (OB11); source_ranges[]/id = eticheta intervalului de transcript (de ex. chunk-ul), uuids[] = uuid-urile inregistrarilor din interval, pastrate ca atare (rol: uuid de inregistrare, nu tool_use_id)",
     [T_MX + ".Report.test_rp09_versions_and_source_ranges_keep_the_authors_values_beside_the_derived_ones", T_MX + ".Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema", T_MX + ".Observations.test_ob11_the_report_does_not_verify_the_uuid_timestamp_and_status_of_a_version"]),
 Row("RP10", "report.py write_report", "report.bind_report (doc: findings[], unresolved[]; jevref.validate_finding / audited_status le citesc)", F("report.json", "/findings[]/type", "/findings[]/category", "/findings[]/quote_source", "/findings[]/uuid", "/findings[]/check_id", "/findings[]/claim", "/findings[]/omission_ref/detail", "/findings[]/omission_ref/source_check_id",
     "/unresolved[]/check_id", "/unresolved[]/reason"), "ECHO", "raportul persistat",
     "findings[] si unresolved[] sunt OBIECTE STRUCTURATE conform report.schema.json (findings: type enum lost_detail | wrong_fact | dead_path | stale_state, category, quote_handoff, quote_source, uuid, check_id, confidence, claim, omission_ref{detail, source_check_id}; unresolved: check_id, reason), nu texte libere; "
     "ele sunt pastrate exact (ECHO) iar statusul se re-deriva din ele: uuid = uuid-ul inregistrarii-sursa (rol: uuid de inregistrare), check_id / omission_ref/source_check_id = id-ul unei verificari din acelasi document (legat de binding), quote_source / claim / detail / reason = text de continut; "
     "textul liber NU e re-sanitizat de raport (OB10: un finding cu secret e persistat ca atare); o lista goala nu acopera aceste campuri",
     [T_MX + ".Report.test_rp10_findings_and_unresolved_are_structured_and_persisted_exactly", T_MX + ".Report.test_the_rich_report_sets_every_author_settable_property_of_the_schema", T_MX + ".Observations.test_ob10_free_text_of_the_report_is_persisted_as_supplied"]),
]

CANON = {"b.ledger.file": "ledger.file", "ledger.file.recorded": "ledger.file", "b.ledger.resume": "ledger.resume", "b.omissions.batch": "omissions.prepare", "b.omissions.prepare": "omissions.prepare.fail", "b.scope.fail": "scope.fail",
         "b.versions.list": "versions.list", "c.omissions.prepare.fail": "omissions.prepare.fail", "report.stale.json": "report.json", "versions.status.stale": "versions.status", "versions.status.noreport": "versions.status",
         "versions.list.err2": "versions.list.err", "omissions.batch": "omissions.prepare", "ledger.file.recorded2": "ledger.file",
         "d.prepare.out": "prepare.out", "d.prepare.inv": "prepare.inv", "d.versions.list": "versions.list", "g.prepare.out": "prepare.out", "g.prepare.inv": "prepare.inv",
         "report.prefix.json": "report.json", "report.prefix.md": "report.md", "report.nolog.json": "report.json", "report.nolog.md": "report.md", "h.prepare.out": "prepare.out", "h.prepare.inv": "prepare.inv", "h.versions.list": "versions.list",
         "h.omissions.prepare": "omissions.prepare.fail", "h.versions.status": "versions.status",
         "ledger.record2": "ledger.record", "j.report.json": "report.json", "k.omissions.batch": "omissions.prepare", "k.ledger.file": "ledger.file", "k.ledger.resume": "ledger.resume", "report.ext.json": "report.json", "versions.list.err3": "versions.list.err",
         "j.versions.list.copy": "versions.list", "j.omissions.prepare.copy": "omissions.prepare", "i.omissions.prepare.redaction": "omissions.prepare.fail",
         "report.rich.json": "report.json", "l.prepare.err": "prepare.err"}
# non-identity string leaves of the invented sessions: content hashes of the ledger identity (identity/*_sha256) and the retry advice of a check (fixed texts and the names of numeric fields; advice.py)
NONIDENTITY = F("report.json", "/checks[]/advice/causes[]", "/checks[]/advice/code", "/checks[]/advice/fields/same_subject", "/checks[]/advice/fields/subject_at", "/checks[]/advice/hint") + F("ledger.file", "/obligations[]/identity/detail_sha256", "/obligations[]/identity/quote_sha256", "/obligations[]/identity/evaluated_sha256", "/obligations[]/identity/material_sha256", "/obligations[]/identity/passage_sha256",
                "/obligations[]/identity/version_sha256")

_W = None
def world():
    global _W
    if _W is None: _W = IW.World()
    return _W
def tearDownModule():
    global _W
    if _W is not None: _W.close(); _W = None

def j(stream): return json.loads(world().out[stream])
def norm(stream, path):
    s = CANON.get(stream, stream)
    if stream in ("b.omissions.batch", "omissions.batch", "k.omissions.batch") and path.startswith("[]/"): path = path[2:]
    return s, path

def declared():
    return {x for r in ROWS for x in r.fields} | set(NONIDENTITY)

def classified(field, dec):
    """A string leaf is classified when a row names it; an EMPTY list leaf (`x[]` with value "") also when a row names a field below it (`x[]/y`): its elements are checked by produced()."""
    if field in dec: return True
    return field.endswith("[]") and any(d.startswith(field + "/") for d in dec)

def produced():
    """{stream:path} of the NON-EMPTY string leaves that the invented sessions produce (an empty container is not a produced field)."""
    out = set()
    for stream, ls in world().streams().items():
        for path, v in ls:
            if v != "": s, p = norm(stream, path); out.add(s + ":" + p)
    return out

# declared fields that no invented session produces as a non-empty string leaf, each with the SPECIFIC reason (a precise coverage limit)
UNPRODUCED = {
 "report.json:/audit/evaluations[]": "the empty-list marker of a report whose author recorded no review (a structurally valid report with no audit block: its PASS is impossible); the reviewed blocks are the author's evaluation/chunk/category records, judged by audit.py and covered by test_audit",
 "versions.status:/bound_checks_for_version": "an integer (a count), never a string identity",
 "prepare.cov:/sanitization/canary_leaks[]": "a defect indicator of sanitize.sanitize ('must be 0'): empty on every successful preparation",
 "prepare.cov:/sanitization/redactions{}": "counts per redaction KIND (a fixed list of sanitizer kinds): no identity; non-empty only for a transcript that holds a secret (tested by the prepare tests of the sanitizer, not here)",
 "omissions.prepare:/hints/truncated{}": "keys are hint identifiers that exceeded the listing cap; non-empty only above HINT_CAP matches: navigation only (HINT_CAP is a listing bound, hints are never evidence)",
 "ledger.file:/obligations[]/stages{}": "the empty-dict marker of an obligation without recorded stages; the stage ids themselves are produced under stages/absence[] and stages/source[] (LG03)",
 "report.json:/handoff/versions[]/evaluations{}": "the empty-dict marker of a declared version without checks; the evaluations that exist are produced as evaluations/session_end/* and evaluations/prefix/*",
 "report.md:(text)": "Markdown is not JSON: the guard cannot list its leaves; RP04 asserts the text (reasons, stale notice) with Report.test_rp04_markdown_reasons",
}

class Guard(unittest.TestCase):
    def test_every_string_leaf_of_every_output_is_classified(self):
        dec = declared(); missing = set()
        for stream, ls in world().streams().items():
            for path, _ in ls:
                s, p = norm(stream, path)
                if not classified(s + ":" + p, dec): missing.add(s + ":" + p)
        self.assertEqual(sorted(missing), [], "output fields that no row of the identity matrix names")

    def test_every_declared_field_is_produced_or_its_absence_is_explained(self):
        prod = produced(); declared_fields = {x for r in ROWS for x in r.fields}; absent = {f for f in declared_fields if f not in prod and f not in NONIDENTITY}
        marker = {f for f in absent if f.endswith("[]") and any(d.startswith(f + "/") for d in declared_fields)}              # an empty-list marker whose element fields are declared (and checked here)
        self.assertEqual(sorted(absent - marker - set(UNPRODUCED)), [], "declared fields that no invented session produces and no reason explains")
        self.assertEqual(sorted(set(UNPRODUCED) - absent), [], "UNPRODUCED entries that are produced (or no longer declared): remove them")
        for f, why in UNPRODUCED.items(): self.assertTrue(why.strip(), f)

    def test_every_row_names_existing_tests_and_a_known_kind(self):
        for r in ROWS:
            self.assertTrue(r.tests, r.id); self.assertTrue(r.fields, r.id)
            self.assertIn(r.kind.split("+")[0], ("ENFORCED", "SANITIZED", "CALLER", "COPY", "ECHO", "NONID"), r.id)
            for t in r.tests:
                mod, cls, meth = t.split(".")
                m = getattr(importlib.import_module(mod), cls, None); self.assertTrue(m is not None and hasattr(m, meth), "%s: %s does not exist" % (r.id, t))

    def test_row_ids_are_unique(self):
        ids = [r.id for r in ROWS]; self.assertEqual(len(ids), len(set(ids)))

class Prepare(unittest.TestCase):
    def test_pr01_given_values(self):
        w = world(); c, o = w.code["prepare.err"], j("prepare.err"); self.assertEqual(c, 2); self.assertEqual(o["error"], "session not found"); self.assertIn("nope.jsonl", o["arg"])        # a clean given value is echoed
        bad = os.path.join(w.a, "API_KEY=" + "Zq8fLm3Xv9" + ".jsonl"); c, out = cli("prepare.py", bad, "--cwd", w.a, cwd=w.a); self.assertEqual(c, 2); self.assertNotIn("Zq8fLm3Xv9", out); self.assertIsNone(json.loads(out)["arg"])
        loc = os.path.join(w.a, "API_KEY=" + "Zq8fLm3Xv9"); os.makedirs(loc, exist_ok=True); c, out = cli("prepare.py", w.ta.log, "--cwd", w.a, "--out", os.path.join(w.a, "o2"), "--location", loc, cwd=w.a); self.assertEqual(c, 3); self.assertNotIn("Zq8fLm3Xv9", out)
        c, out = cli("prepare.py", w.ta.log, "--cwd", w.a, "--out", os.path.join(w.a, "o3"), "--location", "relative/dir", cwd=w.a); self.assertEqual(c, 3); self.assertIn("relative/dir", json.loads(out)["error"])

    def test_pr01_several_recent_sessions_are_not_a_demonstrated_current_session(self):
        w = world(); o = j("l.prepare.err"); self.assertEqual(w.code["l.prepare.err"], 3); self.assertEqual(o["resolution"], "heuristic_most_recent"); self.assertIn("current session not demonstrated", o["error"]); self.assertEqual(set(o), {"error", "resolution"})
        self.assertFalse(os.path.exists(w.lout)); self.assertTrue(w.lproj.startswith(w.root + os.sep)); self.assertNotIn(w.l, w.out["l.prepare.err"])             # nothing is prepared, nothing is echoed, and only the temporary projects directory was read

    def test_pr02_pr03_summary_and_session(self):
        w = world(); o = j("prepare.out"); inv = j("prepare.inv")
        self.assertEqual((o["work"], o["session_cwd"], o["session_cwds"], o["work_locations"], o["session_id"]), (w.prep, w.a, [w.a], [w.a], "session")); self.assertIn(w.a, o["note_dirs"])
        s = inv["session"]; self.assertEqual((s["jsonl"], s["cwd"], s["work_locations"], s["session_id"], s["diagnostics"]), (w.ta.log, w.a, [w.a], "session", []))
        self.assertEqual(s["subagents"], [os.path.join(os.path.splitext(w.ta.log)[0], "subagents", "agent-1.jsonl")]); self.assertNotIn("REDACTED", w.out["prepare.out"] + w.out["prepare.inv"])

    def test_pr04_handoffs_aliases_copies_external(self):
        w = world(); inv = j("prepare.inv"); by = {h["path"]: h for h in inv["handoffs"]}; h = by[w.ta.note]
        self.assertEqual((h["aliases"], h["copies"], h["disposition"], h["provenance"], h["linked"]), ([os.path.join(w.a, "alias.md")], [os.path.join(w.a, "copy", "HANDOFF.md")], "included_by_name", "recorded_write", True))
        ext = by[os.path.join(w.a, "ext.md")]; self.assertEqual((ext["linked"], ext["versions"], ext["provenance"], ext["disposition"]), (False, [], ext["provenance"], "external_unlinked")); self.assertTrue(ext["disk_sha256"])

    def test_pr03_opencode_diagnostics(self):
        w = world(); inv = j("d.prepare.inv"); s = inv["session"]; self.assertEqual(len(s["diagnostics"]), 1); d = s["diagnostics"][0]
        self.assertEqual((d["call_id"], d["path"], d["kind"], d["source_file"]), (IW.D_W2, os.path.realpath(w.dnote), "untimed", s["jsonl"])); self.assertEqual(s["jsonl"], w.dsel); self.assertIn("timing", d["reason"]); self.assertNotIn("REDACTED", w.out["d.prepare.inv"])
        self.assertEqual(j("d.prepare.out")["blockers"], inv["handoffs"][0]["blockers"]); self.assertIn(IW.D_W2, inv["handoffs"][0]["blockers"][0])            # the blockers of the summary name the same recorded call id
        self.assertEqual(j("prepare.inv")["session"]["diagnostics"], [])                                                                                      # a Claude session has none: the empty list is not coverage of these fields

    def test_pr04_mixed_stream_ordering_reason_is_fixed_text(self):
        w = world(); h = j("h.prepare.inv")["handoffs"][0]; self.assertEqual(h["ordering"], dict(demonstrated=False, reason="independent transcripts have no demonstrated common order")); self.assertEqual(j("prepare.inv")["handoffs"][0]["ordering"], dict(demonstrated=True, reason=None))

    def test_pr05_reasons_carry_recorded_call_ids_and_stream_names(self):
        w = world(); dv = {v["tool_use_id"]: v for v in j("d.prepare.inv")["handoffs"][0]["versions"]}; self.assertEqual(list(dv), [IW.D_W1, IW.D_E3])
        self.assertEqual((dv[IW.D_W1]["status"], dv[IW.D_W1]["reason"], dv[IW.D_W1]["unpositioned"]), ("ok", "", [IW.D_W2])); self.assertEqual(dv[IW.D_E3]["status"], "content not recoverable"); self.assertIn("(%s)" % IW.D_W2, dv[IW.D_E3]["reason"])
        hv = {v["tool_use_id"]: v for v in j("h.prepare.inv")["handoffs"][0]["versions"] if v["source_kind"] == "session"}; self.assertEqual(list(hv), [IW.H_W, IW.H_E]); self.assertEqual(hv[IW.H_W]["mixed"], [os.path.join(w.h, "s", "subagents", "agent-1.jsonl")])
        self.assertIn("(agent-1.jsonl)", hv[IW.H_E]["reason"]); self.assertEqual(hv[IW.H_W]["reason"], "")
        b = j("h.prepare.out")["blockers"]; self.assertEqual(len(b), 1); self.assertTrue(b[0].startswith(w.hnote) and "agent-1.jsonl" in b[0])

    def test_pr05_versions_keep_clean_long_ids_exactly(self):
        w = world(); h = next(x for x in j("prepare.inv")["handoffs"] if x["path"] == w.ta.note); vs = h["versions"]
        self.assertEqual([v["tool_use_id"] for v in vs], [WID1, WID2]); self.assertTrue(all(re.fullmatch(r"handoffs/HANDOFF\.md-[0-9a-f]{8}\.v[12]\.md", v["file"]) for v in vs))
        self.assertTrue(all(v["source_file"] == w.ta.log and v["prefix_source_file"] == w.ta.log and v["source_kind"] == "session" for v in vs)); self.assertTrue(all(c.startswith("transcript/chunk-") for v in vs for c in v["prefix_chunks"]))
        self.assertTrue(all(len(v["write_pos"]) == 3 for v in vs)); self.assertNotIn("REDACTED", w.out["prepare.inv"])

    def test_pr06_other_lists(self):
        w = world(); inv = j("prepare.inv")
        self.assertEqual([(x["path"], x["tool_use_id"], x["op"]) for x in inv["unplaced_writes"]], [("rel/HANDOFF-rel.md", "toolu_unplaced", "Write")]); self.assertEqual(inv["unplaced_writes"][0]["source_file"], w.ta.log)
        self.assertEqual({x["tool_use_id"] for x in inv["needs_jev_classify"]}, {"toolu_classify", WID2}); self.assertEqual([x["tool_use_id"] for x in inv["failed_writes"]], ["toolu_failed"])
        self.assertEqual([(x["path"], x["tool_use_id"]) for x in inv["unlinked_bash"]], [(os.path.join(w.a, "handoff-bash.md"), "toolu_bash")])
        self.assertEqual(sorted(inv["excluded_non_text"]), sorted([os.path.join(w.a, ".env"), os.path.join(w.a, "handoff.json")])); self.assertEqual(inv["env_excluded"], [os.path.join(w.a, ".env")]); self.assertFalse(any("A=1" in open(os.path.join(w.prep, "handoffs", f), encoding="utf-8").read() for f in os.listdir(os.path.join(w.prep, "handoffs"))))

    def test_pr07_artifact_names_and_sanitized_contents(self):
        w = world(); names = json.loads(w.out["prepare.files"]); self.assertTrue(all(re.fullmatch(r"(handoffs/[^/]+-[0-9a-f]{8}\.v\d+\.md|transcript/chunk-\d{4}\.txt)", n) for n in names), names)
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); secret = "Zq8fLm3Xv9"; write(t.note, NOTE + "API_KEY=%s\n" % secret); t.user("intro API_KEY=%s" % secret); t.write_note("w0", NOTE + "API_KEY=%s\n" % secret); t.save()
            out = os.path.join(d, "out"); c, o = cli("prepare.py", t.log, "--cwd", d, "--out", out, cwd=d); self.assertEqual(c, 0, o)
            for root, _, fs in os.walk(out):
                for f in fs: self.assertNotIn(secret, open(os.path.join(root, f), encoding="utf-8").read(), f)

    def test_pr07_chunk_headers_are_record_uuids_and_structural_call_ids_are_not_serialized(self):
        w = world(); tdir = os.path.join(w.prep, "transcript"); txt = "".join(open(os.path.join(tdir, f), encoding="utf-8").read() for f in sorted(os.listdir(tdir)))
        heads = re.findall(r"^\[(\S+) (user|assistant)\]", txt, re.M); self.assertTrue(heads); self.assertTrue(all(re.fullmatch(r"s?u\d+", h[0]) for h in heads))                                    # the header is the uuid of the record
        # VERIFIED only this: the structural id / tool_use_id fields of the calls of THIS session are not rendered (a call is `[tool_use Name] <input>` / `[tool_result] <output>`). It is NOT claimed that no id or credential is in a chunk: the TEXT of an input / result can
        # mention such a value (OB12)
        for tid in (WID1, WID2, RID, STAGE_A, STAGE_S, JEV, IW.JEV0): self.assertNotIn(tid, txt, tid)

    def test_pr08_coverage_holds_no_identity(self):
        cov = j("prepare.cov"); self.assertEqual(set(cov), {"records", "chunks", "uuids_in_chunks", "complete", "sanitization", "merged_view", "continuation", "chunk_list", "audit_registry", "audit_note"}); self.assertEqual(set(cov["sanitization"]), {"redactions", "ambiguous_redacted", "canary_leaks"})

class Omissions(unittest.TestCase):
    def test_om01_a_verified_copy_names_the_written_path(self):
        w = world(); o = j("j.omissions.prepare.copy"); self.assertEqual(w.code["j.omissions.prepare.copy"], 0); self.assertEqual(o["handoff_source_path"], w.jorig)
        self.assertEqual((o["version_ref"]["write_tool_use_id"], o["version_ref"]["evaluated_against"]), ("w1", "prefix")); self.assertIsNone(j("omissions.prepare")["handoff_source_path"])

    def test_om02_work_locations(self):
        w = world(); self.assertEqual(j("omissions.prepare")["work_locations"], [w.a]); self.assertEqual(j("omissions.prepare.fail")["work_locations"], [w.a])
        loc = os.path.join(w.a, "API_KEY=" + "Zq8fLm3Xv9"); os.makedirs(loc, exist_ok=True)
        c, out = cli("omissions.py", "prepare", *w.args, "--detail", Q, "--source-quote", Q, "--location", loc, cwd=w.a); self.assertEqual(c, 3, out); self.assertNotIn("Zq8fLm3Xv9", out)
        link = os.path.join(w.a, "okloc"); os.makedirs(link, exist_ok=True); self.assertEqual(O.safe_list([loc, link]), [S.sanitize(loc)[0], link]); self.assertNotIn("Zq8fLm3Xv9", O.safe_list([loc])[0])

    def test_om03_manifest_and_missing_reference(self):
        w = world(); m = j("omissions.prepare")["material_manifest"]; real = os.path.realpath(os.path.join(w.a, "ref.txt"))
        self.assertEqual([(x["ref"], x["path"]) for x in m], [("ref.txt", real)]); self.assertTrue(all(x["sha256"] and x["resolution"] for x in m))
        mr = j("c.omissions.prepare.fail")["missing_reference"]; self.assertEqual(mr["ref"], "missing.txt"); self.assertTrue(mr["reason"]); self.assertIsInstance(mr["searched"], list)
        import tempfile
        with tempfile.TemporaryDirectory() as td:         # a clean-looking reference whose RESOLVED path holds a secret
            d = os.path.realpath(td); sec = os.path.join(d, "API_KEY=" + "Zq8fLm3Xv9"); os.makedirs(sec); write(os.path.join(sec, "x.txt"), "x\n"); os.symlink(os.path.join(sec, "x.txt"), os.path.join(d, "link.txt"))
            t = Tx(d); note = "- see `link.txt`\n- the billing migration ships on Friday\n"; write(t.note, note); t.user("intro"); t.user(Q); t.write_note("w0", note); t.save()
            c, out = cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d)
            self.assertEqual(c, 3, out); self.assertNotIn("Zq8fLm3Xv9", out); o = json.loads(out); self.assertEqual(o["missing_reference"]["kind"], "redaction"); self.assertNotIn("material", o)

    def test_om04_hints(self):
        w = world(); h = j("omissions.prepare")["hints"]; self.assertEqual(h["source"], w.ta.log); self.assertTrue(h["navigation_only"])
        uuids = {r["uuid"] for r in w.ta.recs}; self.assertTrue(h["source_records"]); self.assertTrue(all(r["uuid"] in uuids for r in h["source_records"])); self.assertIn("migrate.sh", h["identifiers"])

    def test_om04_material_matches_name_the_note_and_the_reference(self):
        w = world(); o = j("omissions.prepare"); mm = o["hints"]["material_matches"]
        self.assertEqual([(m["identifier"], m["section"], m["ref"]) for m in mm], [(IW.MATCH, "note", None), (IW.MATCH, "reference", "ref.txt")]); self.assertTrue(all(m["identifier"] in o["hints"]["identifiers"] for m in mm))
        self.assertEqual([x["ref"] for x in o["material_manifest"]], ["ref.txt"]); self.assertFalse(any(os.path.isabs(m["ref"] or "") for m in mm)); self.assertEqual(set(mm[0]), {"identifier", "section", "ref", "line", "column", "case_sensitive", "count"})        # the ref is the text of the note, not a resolved path

    def test_om05_payloads_with_secrets_are_refused(self):
        w = world(); sec = "Zq8fLm3Xv9"
        for detail, quote in (("rotate API_KEY=%s now" % sec, Q), (Q, "API_KEY=%s" % sec)):
            c, out = cli("omissions.py", "prepare", *w.args, "--detail", detail, "--source-quote", quote, cwd=w.a); self.assertEqual(c, 3, out); self.assertNotIn(sec, out); self.assertFalse(json.loads(out)["ok"])
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); note = "- token API_KEY=%s\n" % sec; write(t.note, note); t.user("intro"); t.user(Q); t.write_note("w0", note); t.save()
            c, out = cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d); self.assertEqual(c, 3, out); self.assertNotIn(sec, out)

class OmissionsMixed(unittest.TestCase):
    def test_om07_a_mixed_stream_refusal_names_streams_by_basename(self):
        w = world(); c = w.code["h.omissions.prepare"]; o = j("h.omissions.prepare"); self.assertEqual(c, 3); self.assertFalse(o["ok"]); self.assertEqual(len(o["reasons"]), 1); self.assertIn("(also: agent-1.jsonl)", o["reasons"][0])
        self.assertNotIn(IW.H_W, w.out["h.omissions.prepare"]); self.assertNotIn(os.path.join(w.h, "s"), o["reasons"][0])

class Ledger(unittest.TestCase):
    def test_lg01_a_real_ledger_file_withholds_a_credential_behind_a_prefix(self):
        w = world(); key = "AKIA" + "IOSFODNN7EXAMPLE"; self.assertEqual(w.code["k.omissions.batch"], 3); doc = json.loads(w.out["k.ledger.file"]); ob = doc["obligations"][0]
        self.assertNotIn(key, w.out["k.ledger.file"] + w.out["k.omissions.batch"] + w.out["k.ledger.resume"])
        self.assertTrue(ob["args"]["write_id"].startswith("withheld:sha256:") and ob["identity"]["write_id"].startswith("withheld:sha256:")); self.assertEqual(ob["args"]["withheld"], ["args.write_id", "identity.write_id"]); self.assertEqual(ob["args"]["source"], w.tk.log)
        self.assertEqual(ob["state"], "unavailable"); self.assertEqual(j("k.ledger.resume")["obligations"][0]["state"], "unavailable"); self.assertEqual(json.loads(w.out["ledger.file"])["obligations"][0]["args"]["location"], [w.a])       # a clean --location is kept exactly
    def test_lg01_lg02_guard_every_identity_field(self):
        sec = "API_KEY=" + "Zq8fLm3Xv9"; bad_id = "call_" + "AKIA" + "IOSFODNN7EXAMPLE"
        args = dict(source=sec, file=sec, cwd=sec, location=[sec, "/ok"], write_id=bad_id, run=bad_id, evaluated_against="session_end", detail="d", quote="q")
        ident = dict(source=sec, file=sec, write_id=bad_id, run=bad_id, evaluated_against="session_end", available=True, references=[])
        a, i, held = L._guard(args, ident); text = json.dumps([a, i])
        self.assertNotIn("Zq8fLm3Xv9", text); self.assertNotIn("AKIA", text)
        for k in ("source", "file", "cwd", "write_id", "run"): self.assertTrue(a[k].startswith("withheld:sha256:"), k)
        self.assertEqual(a["location"][1], "/ok"); self.assertTrue(a["location"][0].startswith("withheld:sha256:"))
        for k in ("source", "file", "write_id", "run"): self.assertTrue(i[k].startswith("withheld:sha256:"), k)
        self.assertEqual(sorted(held), sorted(["args.source", "args.file", "args.cwd", "args.write_id", "args.run", "args.location[0]", "identity.source", "identity.file", "identity.write_id", "identity.run"]))
        ok_id = "toolu_bdrk_" + BODY + "~2#1"; a, i, held = L._guard(dict(args, source="/s", file="/f", cwd="/c", location=["/ok"], write_id=ok_id, run=ok_id), dict(ident, source="/s", file="/f", write_id=ok_id, run=ok_id)); self.assertEqual(held, []); self.assertEqual((a["write_id"], a["run"], i["write_id"], i["run"]), (ok_id,) * 4)
        for ref in (dict(path=sec, ref="r", resolution="x"), dict(path="/p", ref=sec, resolution="x"), dict(path="/p", ref="r", resolution=sec)):
            a, i, held = L._guard(dict(args, source="/s", file="/f", cwd="/c", location=[], write_id="w", run=None), dict(ident, source="/s", file="/f", write_id="w", run=None, references=[ref])); self.assertEqual(held, ["identity.references"])

    def test_lg05_lg06_record_resume_and_error_outputs(self):
        w = world(); rec = j("ledger.record"); self.assertEqual((rec["ok"], rec["id"], rec["stages"]), (True, w.oid, {"absence": [{"tool_use_id": STAGE_A}]}))
        r = j("ledger.resume"); o = r["obligations"][0]; self.assertEqual((o["id"], o["state"], o["next"]), (w.oid, "valid", "ready_for_the_report")); self.assertEqual([(s["stage"], s["tool_use_id"], s["state"]) for s in o["stages"]], [("absence", STAGE_A, "bound"), ("source", STAGE_S, "bound")])
        e = j("ledger.err"); self.assertEqual(w.code["ledger.err"], 3); self.assertFalse(e["ok"]) if "ok" in e else None
        sec = "API_KEY=" + "Zq8fLm3Xv9"; c, out = IW.cli("omissions.py", "ledger", "resume", "--ledger", os.path.join(w.a, sec, "nope.json"), "--cwd", w.a, cwd=w.a); self.assertEqual(c, 3); self.assertNotIn("Zq8fLm3Xv9", out)
        b = j("b.ledger.resume"); self.assertEqual(b["obligations"][0]["state"], "unavailable"); self.assertEqual(b["obligations"][0]["stages"], [])

class Scope(unittest.TestCase):
    def test_sc02_requests_and_details_with_secrets_produce_no_payload(self):
        w = world(); sec = "Zq8fLm3Xv9"
        c, out = IW.cli("scope.py", "prepare", "--source", w.ta.log, "--detail", "rotate API_KEY=%s" % sec, "--write-id", WID2, "--evaluated-against", "session_end", cwd=w.a); self.assertEqual(c, 3, out); self.assertNotIn(sec, out); self.assertNotIn("payloads", json.loads(out))
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user("please keep API_KEY=%s" % sec); t.write_note("w0"); t.save()
            c, out = IW.cli("scope.py", "prepare", "--source", t.log, "--detail", "the billing migration ships on Friday", "--write-id", "w0", "--evaluated-against", "prefix", cwd=d); self.assertEqual(c, 3, out); self.assertNotIn(sec, out); self.assertNotIn("payloads", json.loads(out))
        ok = j("scope.ok"); self.assertEqual(ok["evaluation"], dict(write_tool_use_id=WID2, evaluated_against="session_end", run=RID)); self.assertEqual(ok["source"], w.ta.log)

class Versions(unittest.TestCase):
    def test_vr01_list_fields(self):
        w = world(); o = j("versions.list"); self.assertEqual((o["source_session_jsonl"], o["path"], o["evaluated_against"], o["handoff_source_path"]), (w.ta.log, w.ta.note, "session_end", None))
        v = {x["write_tool_use_id"]: x for x in o["versions"]}; self.assertEqual(list(v), [WID1, WID2]); self.assertEqual(v[WID2]["version_ref"]["run"], RID); self.assertEqual(v[WID2]["version_ref"]["write_tool_use_id"], WID2); self.assertEqual(v[WID2]["runs"], [RID])
        self.assertTrue(v[WID1]["runs"] == [] and "run" not in v[WID1]["version_ref"]); self.assertNotIn("REDACTED", w.out["versions.list"])
        e = j("versions.list.err"); self.assertIn("--run no-such-run ", e["error"]); self.assertEqual(w.code["versions.list.err2"], 3)

    def test_vr01_a_verified_copy_and_the_blockers(self):
        w = world(); o = j("j.versions.list.copy"); self.assertEqual((o["path"], o["handoff_source_path"], o["path_match"]), (w.jorig, w.jorig, "relocated")); self.assertEqual([v["write_tool_use_id"] for v in o["versions"]], ["w1"])
        d = j("d.versions.list"); self.assertEqual(len(d["blockers"]), 1); self.assertIn("(unpositioned: %s;" % IW.D_W2, d["blockers"][0]); self.assertEqual([v["write_tool_use_id"] for v in d["versions"]], [IW.D_W1, IW.D_E3]); self.assertIn(IW.D_W2, d["versions"][1]["reason"])
        h = j("h.versions.list"); self.assertIn("(also: agent-1.jsonl)", h["blockers"][0]); self.assertEqual([v["write_tool_use_id"] for v in h["versions"]], [IW.H_W, IW.H_E]); self.assertIn("(agent-1.jsonl)", h["versions"][1]["reason"])

    def test_vr02_window_prose_withholds_a_refused_run(self):
        w = world(); win = j("b.versions.list")["versions"][0]["window"]; self.assertIn(B_R1, win); self.assertIn("2 verification runs", win)
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); key = "AKIA" + "IOSFODNN7EXAMPLE"; t.user("intro"); t.user(Q); t.write_note("w0")
            for r in ("call_" + key, "toolu_" + BODY): t.tool(r, "Skill", dict(skill="jev:handoff-verify"), "loaded"); t.user("next " + r[-4:])
            t.save(); c, out = cli("versions.py", "list", "--source", t.log, "--file", t.note, "--evaluated-against", "session_end", "--cwd", d, cwd=d); o = json.loads(out)["versions"][0]
            self.assertNotIn(key, o["window"]); self.assertIn(O.ID_WITHHELD, o["window"]); self.assertEqual(o["runs"], ["call_" + key, "toolu_" + BODY])        # the copy list keeps the real ids (OB3)

    def test_vr03_the_missing_source_argument_is_echoed_when_clean(self):
        w = world(); e = j("versions.list.err3"); self.assertEqual((w.code["versions.list.err3"], e["error"], e["arg"]), (3, "source session not found", os.path.join(w.a, "no-session.jsonl")))

    def test_vr04_mixed_stream_gate_reasons(self):
        w = world(); s = j("h.versions.status"); self.assertEqual((w.code["h.versions.status"], s["delivery_state"], s["latest_write_id"]), (3, "unresolved", IW.H_E)); self.assertEqual(len(s["reasons"]), 1); self.assertIn("(agent-1.jsonl)", s["reasons"][0])
        self.assertEqual(s["report_path"], os.path.join(w.h, "no-report.json"))

    def test_vr04_status_and_stale(self):
        w = world(); s = j("versions.status"); self.assertEqual((s["latest_write_id"], s["report_path"]), (WID2, os.path.join(w.rep, w.rep_names[1])))
        st = j("versions.status.stale"); self.assertEqual(st["latest_write_id"], WID2); self.assertIn("stale", st); self.assertTrue(st["stale_notice"])
        n = j("versions.status.noreport"); self.assertEqual(n["latest_write_id"], WID2); self.assertEqual(n["report_path"], os.path.join(w.a, "no-report.json"))

class Report(unittest.TestCase):
    def test_rp01_file_names(self):
        w = world(); names = json.loads(w.out["report.files"]); md, js = w.rep_names
        self.assertTrue(re.fullmatch(r"HANDOFF\.md-[0-9a-f]{8}\.verify\.(md|json)", md) or re.fullmatch(r"HANDOFF\.md-[0-9a-f]{8}\.verify\.(md|json)", js)); self.assertEqual(sorted(names), sorted([md, js]))

    def test_rp02_rp03_json_fields(self):
        w = world(); r = j("report.json"); c = r["checks"][0]
        self.assertEqual((c["version_ref"]["write_tool_use_id"], c["version_ref"]["run"], c["jev_ref"]["tool_use_id"]), (WID2, RID, JEV))
        self.assertEqual((r["session"]["jsonl"], r["session"]["cwd"], r["handoff"]["path"], r["work_locations"]), (w.ta.log, w.a, w.ta.note, [w.a]))
        self.assertEqual((r["delivery"]["latest_write_id"], r["binding_summary"]["version_identity"]["provenance"]["path"], r["binding_summary"]["version_identity"]["provenance"]["state"]), (WID2, os.path.realpath(w.ta.note), "recorded_write"))
        hv = r["handoff"]["versions"][0]; self.assertEqual((hv["tool_use_id"], hv["attributed_write"], hv["attribution"]), (WID2, WID2, "write id")); self.assertEqual(set(hv["evaluations"]), {"session_end"}); self.assertIn("status_claimed", r)
        st = j("report.stale.json"); self.assertIn("stale", st["delivery"]); self.assertEqual(st["delivery"]["latest_write_id"], WID2); self.assertNotIn("REDACTED", w.out["report.json"])

    def test_rp02_the_author_key_tool_use_id_and_a_bound_prefix_evaluation(self):
        w = world(); r = j("report.prefix.json"); c = r["checks"][0]; self.assertEqual((c["jev_ref"]["tool_use_id"], c["version_ref"]["write_tool_use_id"], c["version_ref"]["evaluated_against"]), (IW.JEV0, WID1, "prefix")); self.assertTrue(c["binding"]["bound"])
        vi = r["binding_summary"]["version_identity"]; self.assertEqual((vi["identity_ok"], vi["identity_failed"], vi["reasons"]), (1, 0, []))            # genuinely bound: the call lies inside the window of the first version
        hv = r["handoff"]["versions"][0]; self.assertEqual((hv["tool_use_id"], hv["attributed_write"], hv["attribution"]), (WID1, WID1, "write id")); self.assertNotIn("write_tool_use_id", hv)           # the author names the version with `tool_use_id`
        self.assertEqual(set(hv["evaluations"]), {"prefix"}); self.assertEqual(hv["evaluations"]["prefix"]["audited_status"], "UNRESOLVED"); self.assertTrue(hv["evaluations"]["prefix"]["binding_summary"]["reasons"]); self.assertEqual(hv["binding_summary"]["bound"], 1)
        st = j("report.stale.json"); self.assertEqual(st["binding_summary"]["version_identity"]["identity_failed"], 1); self.assertEqual(st["handoff"]["versions"][0]["evaluations"], {})                  # contrast: a call outside the window binds nothing to the version

    def test_rp03_provenance_blocker_and_relocation(self):
        w = world(); ext = os.path.join(w.a, "ext.md"); p = j("report.ext.json")["binding_summary"]["version_identity"]["provenance"]; self.assertEqual((p["state"], p["path"], p["via"], p["source_path"]), ("no_record", ext, None, None))
        self.assertTrue(p["blocker"].startswith(ext + " has no recorded supported Write/Edit")); self.assertTrue(any("no recorded supported Write/Edit" in x for x in j("report.ext.json")["binding_summary"]["reasons"]))
        r = j("j.report.json"); q = r["binding_summary"]["version_identity"]["provenance"]; self.assertEqual((q["state"], q["via"], q["path"], q["source_path"], q["blocker"]), ("recorded_write", "relocated", w.jcopy, w.jorig, None)); self.assertEqual((r["handoff"]["path"], r["handoff"]["source_path"]), (w.jcopy, w.jorig))

    SCHEMA = json.load(open(os.path.join(HERE, "report.schema.json"), encoding="utf-8"))

    def test_rp07_session_variant_environment_kit_cost_and_patch_are_persisted_exactly(self):
        w = world(); r, doc = j("report.rich.json"), w.rich_doc
        for k in ("session", "variant", "environment", "kit", "cost", "patch"): self.assertEqual(r[k], doc[k], k)               # write_report keeps the author's values exactly (no re-derivation, no sanitization)
        self.assertEqual(r["session"]["subagents"], j("prepare.inv")["session"]["subagents"])                                    # the same local paths that prepare printed (COPY)
        bak = r["patch"]["backup"]; self.assertEqual(bak, w.rich_backup); self.assertTrue(bak.endswith(".bak-20260101T000000Z") and os.path.isfile(bak)); self.assertEqual(open(bak, encoding="utf-8").read(), "old\n")   # the real result of report.apply_patch
        self.assertEqual(r["variant"]["commit"], "0123456789abcdef0123456789abcdef01234567")
        self.assertNotIn("REDACTED", w.out["report.rich.json"])

    def test_rp08_the_inventory_is_persisted_exactly_and_matches_the_prepare_inventory(self):
        w = world(); r, doc = j("report.rich.json"), w.rich_doc; self.assertEqual(r["inventory"], doc["inventory"])
        h = next(x for x in j("prepare.inv")["handoffs"] if x["path"] == w.ta.note); e = r["inventory"][0]
        self.assertEqual((e["path"], e["aliases"], e["copies"], e["disposition"], e["linked"]), (h["path"], h["aliases"], h["copies"], h["disposition"], h["linked"])); self.assertEqual(e["real"], os.path.realpath(h["path"]))      # the same local paths as prepare printed
        self.assertEqual(r["inventory"][1]["classification"], dict(label="handoff", reason="a note for the next session")); self.assertIsNone(e["classification"])

    def test_rp09_versions_and_source_ranges_keep_the_authors_values_beside_the_derived_ones(self):
        import versions
        w = world(); r, doc = j("report.rich.json"), w.rich_doc; vs = {x["write_tool_use_id"]: x for x in versions.versions_of(w.ta.log, w.ta.note)[0]}
        for got, sent in zip(r["handoff"]["versions"], doc["handoff"]["versions"]):
            self.assertEqual({k: got[k] for k in sent}, sent)                                                                  # every field the author wrote is kept exactly
            if sent["tool_use_id"] == WID2: self.assertEqual((got["attribution"], got["attributed_write"]), ("write id", WID2))      # derived, added beside the author's fields; the author's tool_use_id decides it (this version has a check of its own)
            else: self.assertNotIn("attributed_write", got); self.assertTrue(got["attribution"].startswith("no check of its own")); self.assertEqual(got["audited_status"], "UNRESOLVED")       # a version without a check of its own is attributed nothing
            self.assertEqual((got["uuid"], got["timestamp"]), (vs[sent["tool_use_id"]]["uuid"], vs[sent["tool_use_id"]]["timestamp"]))   # (here the author wrote the true values: see OB11)
        self.assertEqual([v["evaluated_against"] for v in r["handoff"]["versions"]], ["prefix", "session_end"]); self.assertIn(r["handoff"]["versions"][1]["audited_status"], ("PASS", "FAIL", "UNRESOLVED"))
        self.assertEqual(r["source_ranges"], doc["source_ranges"]); uuids = {x["uuid"] for x in w.ta.recs}; self.assertTrue(set(r["source_ranges"][0]["uuids"]) <= uuids)
        self.assertEqual(r["handoff"]["versions"][0]["evaluations"], {}); self.assertEqual(set(r["handoff"]["versions"][1]["evaluations"]), {"session_end"})        # an empty dict is a marker, not coverage

    def test_rp10_findings_and_unresolved_are_structured_and_persisted_exactly(self):
        w = world(); r, doc = j("report.rich.json"), w.rich_doc; self.assertEqual(r["findings"], doc["findings"]); self.assertEqual(r["unresolved"], doc["unresolved"])
        fi, un = self.SCHEMA["properties"]["findings"]["items"], self.SCHEMA["properties"]["unresolved"]["items"]
        for item, schema in ((r["findings"][0], fi), (r["unresolved"][0], un)): self.assertIsInstance(item, dict); self.assertTrue(set(schema["required"]) <= set(item), schema["required"])      # structured objects (report.schema.json:22-23), not free text
        f = r["findings"][0]; self.assertIn(f["type"], fi["properties"]["type"]["enum"]); ids = {c["id"] for c in r["checks"]}; self.assertIn(f["check_id"], ids); self.assertIn(f["omission_ref"]["source_check_id"], ids); self.assertIn(r["unresolved"][0]["check_id"], ids)
        rec = next(x for x in w.ta.recs if x["uuid"] == f["uuid"]); self.assertIn(f["quote_source"], json.dumps(rec)); self.assertEqual(r["status"], "UNRESOLVED")        # uuid is the record that holds the quoted source

    def test_the_rich_report_sets_every_author_settable_property_of_the_schema(self):
        w = world(); doc = w.rich_doc; props = self.SCHEMA["properties"]; derived = {"audited_status", "binding_summary", "evaluations", "attributed_write", "attribution"}
        def has(obj, schema, where):
            for k in schema["properties"]:
                if k not in derived: self.assertIn(k, obj, "%s: schema property %s is not set by the rich report" % (where, k))
        for sec in ("session", "variant", "environment", "kit", "cost", "patch"): has(doc[sec], props[sec], sec)
        for sec, sch in (("inventory", props["inventory"]["items"]), ("source_ranges", props["source_ranges"]["items"]), ("findings", props["findings"]["items"]), ("unresolved", props["unresolved"]["items"]), ("versions", props["handoff"]["properties"]["versions"]["items"])):
            arr = doc["handoff"]["versions"] if sec == "versions" else doc[sec]; self.assertTrue(arr, sec)
            for k in sch["properties"]:
                if k not in derived: self.assertTrue(any(k in x for x in arr), "%s: schema property %s is not set by the rich report" % (sec, k))
        for v in doc["handoff"]["versions"]: self.assertIn(v["evaluated_against"], props["handoff"]["properties"]["versions"]["items"]["properties"]["evaluated_against"]["enum"])

    def test_rp05_calls_log_note(self):
        import tempfile, report; from unittest import mock; import discover as D
        w = world(); r = j("report.nolog.json"); self.assertEqual(r["binding_summary"]["calls_log_note"], "calls log unreadable: [Errno 2] No such file or directory: %r" % w.missing_calls); self.assertFalse(r["checks"][0]["binding"]["bound"]); self.assertEqual(r["status"], "UNRESOLVED")
        self.assertIsNone(j("report.json")["binding_summary"]["calls_log_note"])
        with tempfile.TemporaryDirectory() as td:       # the two fixed texts (the current session is not given): the home projects directory is replaced by an empty temporary one
            d = os.path.realpath(td); proj = os.path.join(d, "projects"); os.makedirs(proj); rd = os.path.join(d, "s", ".handoff-verify", "sid", "run"); doc = dict(session=dict(session_id="s", jsonl=None, cwd=d), handoff=dict(path=os.path.join(d, "n.md"), versions=[]), checks=[], findings=[], unresolved=[], status="UNRESOLVED")
            with mock.patch.dict(os.environ, {"CLAUDE_PROJECTS_DIR": proj}):
                os.environ.pop("CLAUDE_SESSION_ID", None); self.assertEqual(report.bind_report(dict(doc), None, rd, [], False)["binding_summary"]["calls_log_note"], "current session log not found")
                slug = os.path.join(proj, __import__("re").sub(r"[^A-Za-z0-9]", "-", os.path.realpath(os.path.join(d, "s")))); os.makedirs(slug)
                for n in ("a", "b"): write(os.path.join(slug, n + ".jsonl"), "{}\n")
                self.assertEqual(report.bind_report(dict(doc), None, rd, [], False)["binding_summary"]["calls_log_note"], "current session not demonstrated (ambiguous)")

    def test_rp06_new_run_dir_names_collision_and_isolation(self):
        import datetime, tempfile, report as R
        repo = os.path.realpath(os.path.join(HERE, "..", "..", ".."))
        with tempfile.TemporaryDirectory() as td:
            cwd = os.path.realpath(td); self.assertFalse(cwd.startswith(repo + os.sep)); now = datetime.datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=datetime.timezone.utc)
            d, rid = R.new_run_dir(cwd, "sess-1", now); self.assertEqual(rid, "20260102T030405123456Z"); self.assertEqual(d, os.path.join(cwd, ".handoff-verify", "sess-1", rid)); self.assertTrue(os.path.isdir(d))
            write(os.path.join(d, "marker.txt"), "kept\n")
            with self.assertRaises(FileExistsError): R.new_run_dir(cwd, "sess-1", now)                                    # a collision never reuses or overwrites the directory
            self.assertEqual(open(os.path.join(d, "marker.txt"), encoding="utf-8").read(), "kept\n")
            d2, rid2 = R.new_run_dir(cwd, "sess-2"); self.assertTrue(re.fullmatch(r"\d{8}T\d{12}Z", rid2)); self.assertEqual(os.path.dirname(os.path.dirname(d2)), os.path.join(cwd, ".handoff-verify")); self.assertEqual(R.session_cwd_of(d2), cwd)
            self.assertEqual(sorted(os.listdir(os.path.join(cwd, ".handoff-verify"))), ["sess-1", "sess-2"])

    def test_rp06_prepare_without_out_uses_the_run_directory(self):
        w = world(); o = j("g.prepare.out"); self.assertEqual(w.code["g.prepare.out"], 0); m = re.fullmatch(re.escape(os.path.join(w.g, ".handoff-verify", o["session_id"])) + r"/(\d{8}T\d{12}Z)/work", o["work"]); self.assertTrue(m, o["work"])
        self.assertEqual((o["session_cwd"], j("g.prepare.inv")["session"]["cwd"], w.gwork), (w.g, w.g, o["work"])); self.assertTrue(os.path.isfile(os.path.join(o["work"], "inventory.json")) and os.path.isfile(os.path.join(o["work"], "coverage.json")))
        self.assertFalse(o["work"].startswith(os.path.realpath(os.path.join(HERE, "..", "..", "..")) + os.sep))      # the fixture lives in a temporary directory, never under the repository

    def test_rp03_unsafe_run_prose_in_the_report(self):
        import tempfile, report, versions
        key = "AKIA" + "IOSFODNN7EXAMPLE"
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0")
            for r in ("call_" + key + "~2", "toolu_" + BODY): t.tool(r, "Skill", dict(skill="jev:handoff-verify"), "loaded"); t.user("next " + r[-4:])
            t.tool(JEV, "mcp__jev__jev_verify", dict(claims=["c"], evidence=["e"]), json.dumps(dict(results=[dict(claim="c", verdict="verified", confidence=0.99, action="auto", same_subject=0.9)]))); t.save()
            v = versions.versions_of(t.log, t.note)[0][0]
            doc = AF.shell(dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[IW.VROW(v, 1, "session_end")]), status="PASS", findings=[], unresolved=[],
                       checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=JEV, result_index=0, key="k"), version_ref=versions.version_ref(v, "session_end"))]))      # (structurally valid: the gate reads nothing of an invalid report)
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **PASS**\n", calls_jsonl=t.log)
            raw = open(os.path.join(rd, js), encoding="utf-8").read(); mdt = open(os.path.join(rd, md), encoding="utf-8").read(); self.assertNotIn(key, raw); self.assertNotIn(key, mdt); self.assertIn(O.ID_WITHHELD, raw)
            c, out = cli("versions.py", "status", "--session", t.log, "--file", t.note, "--report", os.path.join(rd, js), "--cwd", d, cwd=d); self.assertNotIn(key, out)

    def test_rp03_scope_audit_detail_is_sanitized(self):
        import tempfile, report, versions
        sec = "Zq8fLm3Xv9"
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save()
            doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[]), status="UNRESOLVED", findings=[], unresolved=[], checks=[],
                       scope_exclusions=[dict(detail="rotate API_KEY=%s" % sec, jev_ref=dict(tool_use_id="nope", result_index=0, key="k"), classification="out_of_scope", confidence=0.995)])
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=t.log); r = json.load(open(os.path.join(rd, js), encoding="utf-8"))
            self.assertNotIn(sec, json.dumps(r["scope_audit"])); self.assertTrue(r["scope_audit"]["invalid"])

    def test_rp04_markdown_reasons(self):
        w = world(); md = w.out["report.md"]; self.assertTrue(md.startswith("> Stare finală")); self.assertIn("Motiv:", md); self.assertNotIn("REDACTED", md)
        self.assertIn("versiune", w.out["report.stale.md"].lower()); self.assertIn("stale", json.loads(w.out["report.stale.json"])["delivery"])

class Observations(unittest.TestCase):
    """Unrelated historical gaps, identified and PINNED (not repaired): a change of any of these shows."""
    SEC = "Zq8fLm3Xv9"

    def _unsafe_dir_session(self, td):
        d = os.path.realpath(td); sub = os.path.join(d, "API_KEY=" + self.SEC); os.makedirs(sub); t = Tx(d); t.note = os.path.join(sub, "HANDOFF.md"); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save(); return d, t

    def test_ob1_prepare_prints_an_unsafe_recorded_path_raw(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d, t = self._unsafe_dir_session(td); c, o = cli("prepare.py", t.log, "--cwd", d, "--out", os.path.join(d, "out"), cwd=d)
            self.assertEqual(c, 0); self.assertIn(self.SEC, o + open(os.path.join(d, "out", "inventory.json"), encoding="utf-8").read())                      # OB1: a copy surface (the file system name)
            c, o = cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d); self.assertEqual(c, 3); self.assertNotIn(self.SEC, o)     # the consumer refuses it

    def test_ob2_an_artifact_name_keeps_the_note_basename(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); t.note = os.path.join(d, "HANDOFF-API_KEY=%s.md" % self.SEC); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save()
            c, o = cli("prepare.py", t.log, "--cwd", d, "--out", os.path.join(d, "out"), cwd=d); self.assertEqual(c, 0)
            self.assertTrue(any(self.SEC in f for f in os.listdir(os.path.join(d, "out", "handoffs"))))                                          # OB2: the name is the real basename (a local file name)
            c, o = cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d); self.assertEqual(c, 3); self.assertNotIn(self.SEC, o)

    def test_ob3_versions_list_prints_an_unsafe_recorded_id_raw(self):
        import tempfile
        key = "AKIA" + "IOSFODNN7EXAMPLE"
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("call_" + key + "#1"); t.save()
            c, o = cli("versions.py", "list", "--source", t.log, "--file", t.note, "--evaluated-against", "prefix", "--cwd", d, cwd=d); self.assertEqual(c, 0); self.assertIn(key, o)                    # OB3: a copy surface
            c, o = cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "call_" + key + "#1", "--evaluated-against", "prefix", cwd=d); self.assertEqual(c, 3); self.assertNotIn(key, o)

    def test_ob4_versions_echo_an_unsafe_given_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save(); bad = os.path.join(d, "API_KEY=" + self.SEC, "x.md")
            c, o = cli("versions.py", "list", "--source", t.log, "--file", bad, "--evaluated-against", "prefix", "--cwd", d, cwd=d); self.assertEqual(c, 3); self.assertIn(self.SEC, o)                    # OB4: --file is echoed by the provenance blocker
            c, o = cli("versions.py", "status", "--session", t.log, "--file", bad, "--report", os.path.join(d, "r.json"), "--cwd", d, cwd=d); self.assertEqual(c, 3); self.assertIn(self.SEC, o)

    def test_ob6_prose_with_recorded_call_ids_and_stream_names_is_printed_raw(self):
        import tempfile
        key = "AKIA" + "IOSFODNN7EXAMPLE"
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); work = os.path.join(d, "work"); os.makedirs(work); note = os.path.join(work, "HANDOFF.md"); write(note, "# Handoff\n- beta\n"); fx = IW.Fixture(d)
            try:
                late = IW.oc_tool("call_" + key, "write", dict(filePath=note, content="# Handoff\n- beta\n"), IW.OC_T0 + 31, IW.OC_T0 + 32); late["time"] = dict(completed=IW.OC_T0 + 32)
                sel = fx.session("ses_d", work, [IW.oc_user("intro", IW.OC_T0), IW.oc_user(Q, IW.OC_T0 + 1), IW.oc_assistant([IW.oc_tool("call_ok1", "write", dict(filePath=note, content="# Handoff\n- alpha\n"), IW.OC_T0 + 10, IW.OC_T0 + 12)], IW.OC_T0 + 9), IW.oc_assistant([late], IW.OC_T0 + 30)])
                out = os.path.join(d, "out"); c, o = cli("prepare.py", sel, "--cwd", work, "--out", out, cwd=work); self.assertEqual(c, 0); self.assertIn(key, o); self.assertIn(key, open(os.path.join(out, "inventory.json"), encoding="utf-8").read())      # OB6: blockers[] and diagnostics[] (a copy surface)
                c, o = cli("versions.py", "list", "--source", sel, "--file", note, "--evaluated-against", "prefix", "--cwd", work, cwd=work); self.assertEqual(c, 0); self.assertIn(key, o)
                c, o = cli("versions.py", "status", "--session", sel, "--file", note, "--report", os.path.join(d, "r.json"), "--cwd", work, cwd=work); self.assertIn(key, o)
                c, o = cli("omissions.py", "prepare", "--source", sel, "--file", note, "--cwd", work, "--detail", Q, "--source-quote", Q, "--write-id", "call_ok1", "--evaluated-against", "prefix", cwd=work); self.assertNotIn(key, o)       # the consumer does not print it
            finally: fx.close()

    def test_ob7_an_unreadable_calls_log_path_is_echoed_by_the_report(self):
        import tempfile, report
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.write_note("w0"); t.save(); bad = os.path.join(d, "API_KEY=" + self.SEC, "calls.jsonl")
            doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[]), status="UNRESOLVED", findings=[], unresolved=[], checks=[])
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=bad); r = json.load(open(os.path.join(rd, js), encoding="utf-8"))
            self.assertIn(self.SEC, r["binding_summary"]["calls_log_note"])                                                                       # OB7: the system error text carries the caller's path, unsanitized

    def test_ob8_new_run_dir_uses_the_session_id_raw(self):
        import tempfile, report as R
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); run, rid = R.new_run_dir(d, "API_KEY=" + self.SEC); self.assertIn(self.SEC, run); self.assertTrue(os.path.isdir(run))                    # OB8: the session id is a path component as given

    def test_ob10_free_text_of_the_report_is_persisted_as_supplied(self):
        import tempfile, report
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user("keep API_KEY=%s" % self.SEC); t.write_note("w0"); t.save()
            doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[]), status="UNRESOLVED", checks=[], findings=[dict(type="lost_detail", category="c", quote_handoff=None, quote_source="keep API_KEY=%s" % self.SEC, uuid="u2", check_id="p1", confidence=0.9, claim="claim API_KEY=%s" % self.SEC)],
                       unresolved=[dict(check_id="p1", reason="reason API_KEY=%s" % self.SEC)])
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=t.log); r = json.load(open(os.path.join(rd, js), encoding="utf-8"))
            self.assertEqual((r["findings"][0]["quote_source"], r["findings"][0]["claim"], r["unresolved"][0]["reason"]), (doc["findings"][0]["quote_source"], doc["findings"][0]["claim"], doc["unresolved"][0]["reason"]))      # OB10: the writer's text is ECHOed, a secret in it included

    def test_ob11_the_report_does_not_verify_the_uuid_timestamp_and_status_of_a_version(self):
        import tempfile, report, versions
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save(); v = versions.versions_of(t.log, t.note)[0][0]
            doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[dict(version=1, sha256=v["sha256"], tool_use_id="w0", uuid="not-the-uuid", timestamp="not-a-time", evaluated_against="prefix", status="PASS")]), status="UNRESOLVED", checks=[], findings=[], unresolved=[])
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=t.log); hv = json.load(open(os.path.join(rd, js), encoding="utf-8"))["handoff"]["versions"][0]
            self.assertEqual((hv["uuid"], hv["timestamp"], hv["status"]), ("not-the-uuid", "not-a-time", "PASS")); self.assertEqual(hv["audited_status"], "UNRESOLVED"); self.assertTrue(hv["attribution"].startswith("no check of its own"))       # OB11: kept as written (a PASS status included); only the derived audited_status / attribution are computed

    def test_ob12_a_call_id_in_a_result_text_survives_in_the_chunk(self):
        import tempfile
        key = "AKIA" + "IOSFODNN7EXAMPLE"; mention = "call_" + key
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.tool("toolu_read1", "Read", dict(file_path=os.path.join(d, "x.txt")), "an earlier tool id was %s and then more text" % mention); t.write_note("w0"); t.save()
            out = os.path.join(d, "out"); c, o = cli("prepare.py", t.log, "--cwd", d, "--out", out, cwd=d); self.assertEqual(c, 0, o)
            tdir = os.path.join(out, "transcript"); txt = "".join(open(os.path.join(tdir, f), encoding="utf-8").read() for f in sorted(os.listdir(tdir)))
            self.assertIn(mention, txt); self.assertIn(key, txt)                                                                  # OB12: the text of a result is under the GENERIC sanitization, which does not see a credential behind a provider prefix: the value survives (characterization, not repaired)
            self.assertNotIn("toolu_read1", txt)                                                                                 # while the structural id of that call is still not serialized
            cov = json.load(open(os.path.join(out, "coverage.json"), encoding="utf-8")); self.assertEqual((cov["sanitization"]["redactions"], cov["sanitization"]["ambiguous_redacted"]), ({}, 0))

    def test_ob9_versions_list_of_a_copy_crashes_when_the_session_holds_an_unplaced_write(self):
        import subprocess
        w = world(); copy = os.path.join(w.a, "copy", "HANDOFF.md")
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "list", "--source", w.ta.log, "--file", copy, "--evaluated-against", "session_end", "--cwd", w.a], cwd=w.a, capture_output=True, text=True, env=IW.ENV)
        self.assertEqual(p.returncode, 1); self.assertEqual(p.stdout, ""); self.assertIn("TypeError", p.stderr)       # OB9: sorted() of the written paths of the session meets the unplaced write (None); not an identity leak, found while building the fixtures

    def test_ob5_the_report_echoes_an_unsafe_identity_the_writer_supplied(self):
        import tempfile, report, versions
        key = "AKIA" + "IOSFODNN7EXAMPLE"
        with tempfile.TemporaryDirectory() as td:
            d = os.path.realpath(td); t = Tx(d); write(t.note, NOTE); t.user("intro"); t.user(Q); t.write_note("w0"); t.save(); v = versions.versions_of(t.log, t.note)[0][0]
            ref = dict(versions.version_ref(v, "session_end"), run="call_" + key); doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[]), status="UNRESOLVED", findings=[], unresolved=[],
                                                                                         checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="nope", result_index=0, key="k"), version_ref=ref)])
            rd = os.path.join(d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=t.log); r = json.load(open(os.path.join(rd, js), encoding="utf-8"))
            self.assertEqual(r["checks"][0]["version_ref"]["run"], "call_" + key)                                                                 # OB5: the writer's own field is kept as supplied
            self.assertNotIn(key, json.dumps(r["binding_summary"]) + json.dumps(r.get("delivery")))                                           # while everything the report DERIVES holds no such id

def print_matrix():
    for r in ROWS:
        print("%s | %s | %s | %s | %s | %s | %s | %s" % (r.id, r.cmd, r.where, "; ".join(r.fields), r.kind, r.boundary, r.policy, ", ".join(r.tests)))

if __name__ == "__main__":
    if "--matrix" in sys.argv: print_matrix()
    else: unittest.main()

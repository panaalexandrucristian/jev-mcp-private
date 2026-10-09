#!/usr/bin/env python3
"""Offline regressions of the diagnostics of an AMBIGUOUS verification-run selection (stdlib, no Jev call; invented transcripts): two runs follow the evaluated write and one of them carries a recorded id with a credential
hidden behind a provider prefix (`call_AKIA...`, also with the adapter suffixes `~2` / `#1` / `~2#1`; the generic sanitizer does NOT see the credential inside the 29-character word, only the role-aware identity policy does).
That id is refused as an identity, so it must not survive in ANY rendering of the ambiguity: not in the `runs` list, not in the prose of the reason (`source window ambiguous: ... (candidates: ...)`) and not in anything derived from
them: `omissions.py prepare` / `prepare-batch`, `scope.py prepare`, the persisted ledger rows and `ledger resume`, the validator reason (`versions.run_problem`). It is replaced by a non-echoing marker for DISPLAY only; the selection
semantics (the window's `runs` hold the real ids) and the clean recorded ids (kept exactly in the `runs` list, with their suffixes) are unchanged. Retrospective: none (these were written first and fail on the previous code).
usage: python3 -B test_identity_ambiguity.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, omissions as O, sanitize as S, versions as V
from test_obligation_ledger import Base, ENV, Q1, run
from test_identity_roles import BODY

KEY = "AKIA" + "IOSFODNN7EXAMPLE"          # the credential body
UNSAFE_RUNS = ["call_" + KEY + s for s in ("", "~2", "#1", "~2#1")]
CLEAN = "toolu_" + BODY
CLEAN_SUFFIXED = [CLEAN, CLEAN + "~2", CLEAN + "#1", CLEAN + "~3#2"]
MARK = "[REDACTED:identity]"

def scope_cli(cwd, *args):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare"] + list(args), cwd=cwd, capture_output=True, text=True, env=ENV); return p.returncode, p.stdout

class Ambiguous(Base):
    def session(self, *runs):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0")
        for r in runs: self.t.tool(r, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.user("next " + r[-4:])
        self.t.save()

    def window(self, run=None):
        return O.source_window(D.load_jsonl(self.t.log), "w0", "session_end", run)

class SafeList(unittest.TestCase):
    def test_a_refused_id_is_never_rendered_by_the_diagnostic_copy(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                out = O.safe_list([bad, CLEAN], S.ID_ROLE); self.assertEqual(out, [MARK, CLEAN]); self.assertNotIn(KEY, json.dumps(out))

    def test_clean_recorded_ids_are_kept_exactly_with_every_suffix(self):
        self.assertEqual(O.safe_list(CLEAN_SUFFIXED, S.ID_ROLE), CLEAN_SUFFIXED)

    def test_the_marker_is_not_a_usable_identity(self):
        self.assertTrue(S.identity_altered(MARK, S.ID_ROLE)["redaction_dependent"]); self.assertTrue(O.identity_dependent(MARK, role=S.ID_ROLE))

    def test_the_path_role_is_unchanged(self):
        self.assertEqual(O.safe_list(["/a/b"]), ["/a/b"])
        out = O.safe_list(["/x/API_KEY=" + "Zq8fLm3Xv9"]); self.assertNotIn("Zq8fLm3Xv9", out[0]); self.assertIn("REDACTED", out[0])      # the strict policy renders the generic redaction, as before

class Window(Ambiguous):
    def test_the_reason_never_holds_the_refused_id_and_the_runs_keep_the_real_ids(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                self.setUp(); self.session(bad, CLEAN); w = self.window()
                self.assertTrue(w["ambiguous"]); self.assertEqual([r["id"] for r in w["runs"]], [bad, CLEAN])      # the selection semantics are unchanged
                self.assertNotIn(KEY, w["ambiguous"]); self.assertIn(MARK, w["ambiguous"]); self.tearDown()

    def test_a_wrong_name_lists_the_candidates_without_the_refused_id(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                self.setUp(); self.session(bad, CLEAN); w = self.window("nope"); self.assertTrue(w["ambiguous"]); self.assertNotIn(KEY, w["ambiguous"]); self.assertIn(CLEAN, w["ambiguous"]); self.tearDown()

    def test_clean_candidates_are_listed_as_before(self):
        self.session(*CLEAN_SUFFIXED[:2]); w = self.window(); self.assertIn(CLEAN, w["ambiguous"]); self.assertNotIn(MARK, w["ambiguous"])

    def test_the_validator_reason_does_not_hold_the_refused_id(self):
        self.session(UNSAFE_RUNS[0], CLEAN); kind, why = V.run_problem(self.t.log, dict(write_tool_use_id="w0", evaluated_against="session_end"))
        self.assertEqual(kind, "run"); self.assertNotIn(KEY, why); self.assertIn(MARK, why)

    def test_an_unsafe_given_write_id_is_not_echoed_by_the_window(self):
        self.session(CLEAN); w = O.source_window(D.load_jsonl(self.t.log), "call_" + KEY, "session_end"); self.assertTrue(w["ambiguous"]); self.assertNotIn(KEY, w["ambiguous"])

class Outputs(Ambiguous):
    def assertNoKey(self, *texts):
        for t in texts: self.assertNotIn(KEY, t)

    def test_prepare_and_prepare_batch_do_not_print_the_refused_id(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                self.setUp(); self.session(bad, CLEAN)
                for extra in ([], ["--run", "nope"]):
                    c, o = run(["prepare", "--source", self.t.log, "--file", self.t.note, "--cwd", self.d, "--detail", Q1, "--source-quote", Q1, "--write-id", "w0", "--evaluated-against", "session_end"] + extra, self.d)
                    self.assertEqual(c, 3, o); self.assertNoKey(o); out = json.loads(o); self.assertEqual(out["runs"], [MARK, CLEAN])
                    c, outs = self.batch([(Q1, dict(evaluated_against="session_end", **({"run": "nope"} if extra else {})))], ledger=False); self.assertEqual(c, 3, outs); self.assertNoKey(json.dumps(outs)); self.assertEqual(outs[0]["runs"], [MARK, CLEAN])
                self.tearDown()

    def test_the_clean_run_ids_stay_in_the_runs_list_exactly(self):
        self.session(*CLEAN_SUFFIXED); c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))], ledger=False); self.assertEqual(c, 3, outs); self.assertEqual(outs[0]["runs"], CLEAN_SUFFIXED)

    def test_scope_prepare_does_not_print_the_refused_id(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                self.setUp(); self.session(bad, CLEAN)
                for extra in ([], ["--run", "nope"]):
                    c, o = scope_cli(self.d, "--source", self.t.log, "--detail", "the billing migration ships on Friday", "--write-id", "w0", "--evaluated-against", "session_end", *extra)
                    self.assertEqual(c, 3, o); self.assertNoKey(o); self.assertNotIn("payloads", json.loads(o))
                self.tearDown()

    def test_the_ledger_rows_and_the_resume_do_not_hold_the_refused_id(self):
        for bad in UNSAFE_RUNS:
            with self.subTest(bad=bad):
                self.setUp(); self.session(bad, CLEAN); c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 3, outs)
                raw = open(self.ledger, encoding="utf-8").read(); self.assertNoKey(raw); row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertTrue(row["reasons"])
                c, r = self.resume(); self.assertNoKey(json.dumps(r)); self.assertEqual(r["obligations"][0]["state"], "unavailable")
                self.assertNoKey(open(self.ledger, encoding="utf-8").read()); self.tearDown()

if __name__ == "__main__": unittest.main()

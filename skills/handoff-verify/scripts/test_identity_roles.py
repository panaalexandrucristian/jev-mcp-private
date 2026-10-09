#!/usr/bin/env python3
"""Offline regressions of the role-aware recorded-identifier policy (stdlib, no Jev call; invented transcripts): the write / run / stage ids that a provider or the OpenCode adapter RECORDED
(`toolu_`, `toolu_bdrk_`, `toolu_vrtx_`, `srvtoolu_`, `call_`, optionally with the adapter suffixes `~n` / `#k` / `~n#k`) are credential-free identities: they are kept byte-for-byte and usable through preparation,
recording, loading and resume even when they are long and mixed-case (the generic ambiguous-token rule would redact them). Nothing else gets the exemption: a demonstrable credential, a redaction marker, an arbitrary
long token and an id-like string outside an id role are refused exactly as before, and an unsafe identity is never echoed nor replaced by an invented one.
usage: python3 -B test_identity_roles.py [-v]"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O, sanitize as S
from test_obligation_ledger import Base, NOTE, Q1, Q2, run, write

BODY = "01AbCdEfGhIjKlMnOpQrStUvWxYz"
FAMILIES = ("toolu_", "toolu_bdrk_", "toolu_vrtx_", "srvtoolu_", "call_")
SUFFIXES = ("", "#1", "~2", "~2#1")
LONG = [f + BODY + s for f in FAMILIES for s in SUFFIXES]
C = "Zq" + "8f" + "Lm3" + "Xv9"
UNSAFE = ["call_AKIA" + "IOSFODNN7EXAMPLE", "call_" + BODY + " Bearer " + "A" * 24, "toolu_bdrk_[REDACTED:ambiguous]", "toolu_" + BODY + "[REDACTED:openai_key]", "API_KEY=" + C, "sk-" + "A" * 24,
          "toolu_" + BODY + "~1", "toolu_" + BODY + "~0", "toolu_" + BODY + "#0", "toolu_" + BODY + "#1~2", "toolu_" + BODY + "!"]
NOT_IDS = ["foo_" + BODY, "id_" + BODY, "tool_" + BODY, "Toolu_" + BODY, BODY + BODY, "x" + "toolu_" + BODY, "toolu_", "call_"]
ROLE = "tool_use_id"

class Policy(unittest.TestCase):
    def test_recorded_ids_are_kept_in_the_id_role(self):
        for tid in LONG:
            self.assertGreaterEqual(len(tid), 32, tid)
            self.assertFalse(S.identity_altered(tid, ROLE)["redaction_dependent"], tid)
            self.assertFalse(O.identity_dependent(tid, role=ROLE), tid)

    def test_the_generic_policy_and_every_other_role_are_unchanged(self):
        for tid in LONG:
            self.assertTrue(S.altered(tid)["redaction_dependent"], tid)                       # the global ambiguous-secret rule is not disabled
            self.assertTrue(S.identity_altered(tid)["redaction_dependent"], tid)              # no role, no exemption
            self.assertTrue(S.identity_altered(tid, "path")["redaction_dependent"], tid)
            self.assertTrue(O.identity_dependent(tid), tid)

    def test_credentials_markers_and_malformed_forms_stay_refused_in_the_id_role(self):
        for tid in UNSAFE: self.assertTrue(S.identity_altered(tid, ROLE)["redaction_dependent"], tid)

    def test_arbitrary_long_tokens_get_no_exemption(self):
        for tid in NOT_IDS:
            if len(tid) >= 32: self.assertTrue(S.identity_altered(tid, ROLE)["redaction_dependent"], tid)
        self.assertTrue(S.altered("see toolu_" + BODY + " in the log")["redaction_dependent"])        # prose: the generic rule applies
        self.assertTrue(S.identity_altered("toolu_" + BODY + " tail", ROLE)["redaction_dependent"])

    def test_short_and_existing_clean_ids_are_unchanged(self):
        for tid in ("c1", "w0", "run1", "toolu_01XmEHE1sGzkjq8MPLm3vrBc", "k-2", "toolu_x~2"): self.assertFalse(S.identity_altered(tid, ROLE)["redaction_dependent"], tid)

    def test_sanitize_itself_is_unchanged(self):
        out, rep = S.sanitize("run toolu_bdrk_" + BODY + " done"); self.assertEqual(rep["ambiguous_redacted"], 1); self.assertNotIn(BODY, out)

class Preparation(Base):
    def test_long_write_ids_are_prepared_and_kept(self):
        for tid in LONG:
            with self.subTest(tid=tid):
                self.setUp(); self.t.user("intro"); self.t.user(Q1); self.t.write_note(tid); self.t.save()
                c, outs = self.batch([(Q1, dict(write_id=tid))]); self.assertEqual(c, 0, outs)
                self.assertEqual(outs[0]["version_ref"]["write_tool_use_id"], tid); self.assertIn(tid, json.dumps(outs))
                row = self.doc()["obligations"][0]; self.assertEqual((row["state"], row["args"]["write_id"], row["identity"]["write_id"]), ("prepared", tid, tid)); self.assertNotIn("withheld", json.dumps(row))
                self.tearDown()

    def test_long_named_and_selected_run_ids_are_prepared_and_kept(self):
        for tid in LONG:
            with self.subTest(tid=tid):
                self.setUp(); self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
                c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); self.assertEqual(outs[0]["version_ref"]["run"], tid)       # selected
                c, outs = self.batch([(Q1, dict(evaluated_against="session_end", run=tid))], ledger=False); self.assertEqual(c, 0, outs); self.assertEqual(outs[0]["version_ref"]["run"], tid)   # named
                row = self.doc()["obligations"][0]; self.assertEqual((row["state"], row["identity"]["run"]), ("prepared", tid)); self.assertNotIn("withheld", json.dumps(row))
                self.tearDown()

    def test_the_single_prepare_command_keeps_long_ids_too(self):
        tid = "call_" + BODY + "~2#1"; self.t.user("intro"); self.t.user(Q1); self.t.write_note(tid); self.t.tool("toolu_bdrk_" + BODY, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
        c, o = run(["prepare", "--source", self.t.log, "--file", self.t.note, "--cwd", self.d, "--detail", Q1, "--source-quote", Q1, "--write-id", tid, "--evaluated-against", "session_end"], self.d)
        out = json.loads(o); self.assertEqual(c, 0, out); self.assertEqual((out["version_ref"]["write_tool_use_id"], out["version_ref"]["run"]), (tid, "toolu_bdrk_" + BODY))

    def test_unsafe_write_ids_are_not_ready_and_never_echoed(self):
        for tid in UNSAFE[:6]:
            with self.subTest(tid=tid):
                self.setUp(); self.t.user("intro"); self.t.user(Q1); self.t.write_note(tid); self.t.save()
                c, outs = self.batch([(Q1, dict(write_id=tid))]); self.assertEqual(c, 3, outs); self.assertFalse(outs[0]["ok"]); self.assertNotIn(tid, json.dumps(outs)); self.assertNotIn(C, json.dumps(outs))
                raw = open(self.ledger, encoding="utf-8").read(); self.assertNotIn(tid, raw)
                row = self.doc()["obligations"][0]; self.assertEqual(row["state"], "unavailable"); self.assertTrue(row["args"]["withheld"]); self.assertTrue(row["args"]["write_id"].startswith("withheld:sha256:"))   # a hash, never an invented id
                self.tearDown()

    def test_unsafe_run_ids_are_not_ready_and_never_echoed(self):
        for tid in UNSAFE[:6]:
            with self.subTest(tid=tid):
                self.setUp(); self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.save()
                for kw in (dict(evaluated_against="session_end"), dict(evaluated_against="session_end", run=tid)):
                    c, outs = self.batch([(Q1, kw)], ledger=False); self.assertEqual(c, 3, outs); self.assertNotIn(tid, json.dumps(outs))
                self.tearDown()

    def test_a_long_id_outside_the_id_roles_is_still_redacted(self):
        self.session("intro", Q1); c, outs = self.batch([(Q1, dict(write_id="foo_" + BODY))]); self.assertEqual(c, 3, outs); self.assertNotIn(BODY, json.dumps(outs))

class RecordLoadResume(Base):
    def prepared(self, tid="w0"):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note(tid); self.t.save(); c, outs = self.batch([(Q1, dict(write_id=tid))]); self.assertEqual(c, 0, outs)
        return outs[0], self.doc()["obligations"][0]["id"]

    def test_long_stage_ids_are_recorded_loaded_and_resumed(self):
        for tid in LONG:
            with self.subTest(tid=tid):
                self.setUp(); out, oid = self.prepared(); self.call_absence(out, tid)
                c, o = self.record(oid, "absence", tid); self.assertEqual(c, 0, o)
                self.assertEqual(self.doc()["obligations"][0]["stages"]["absence"], [{"tool_use_id": tid}])      # byte-for-byte
                self.assertEqual(L.load(self.ledger)["obligations"][0]["stages"]["absence"][0]["tool_use_id"], tid)
                c, r = self.resume(); st = r["obligations"][0]["stages"][0]; self.assertEqual((c, st["tool_use_id"], st["state"]), (0, tid, "bound"), r)
                self.assertEqual(r["obligations"][0]["next"], "call_source")
                sid = "srvtoolu_Src" + BODY; self.call_source(out, sid); self.assertEqual(self.record(oid, "source", sid)[0], 0)
                c, r = self.resume(); self.assertEqual(r["obligations"][0]["next"], "ready_for_the_report")
                self.tearDown()

    def test_a_long_write_id_survives_a_second_batch_and_a_resume(self):
        tid = "toolu_bdrk_" + BODY; out, oid = self.prepared(tid); self.call_absence(out, "srvtoolu_" + BODY); self.record(oid, "absence", "srvtoolu_" + BODY)
        c, outs = self.batch([(Q1, dict(write_id=tid))]); self.assertEqual(c, 0, outs)
        row = self.doc()["obligations"][0]; self.assertEqual((row["id"], row["identity"]["write_id"], row["stages"]["absence"]), (oid, tid, [{"tool_use_id": "srvtoolu_" + BODY}]))
        c, r = self.resume(); o = r["obligations"][0]; self.assertEqual((o["state"], o["stages"][0]["state"]), ("valid", "bound"), r)

    def test_unsafe_stage_ids_are_refused_without_echo_and_the_ledger_is_untouched(self):
        out, oid = self.prepared(); before = open(self.ledger, encoding="utf-8").read()
        for tid in UNSAFE:
            c, o = self.record(oid, "absence", tid); self.assertEqual(c, 3, tid); self.assertFalse(json.loads(o)["ok"]); self.assertNotIn(tid, o); self.assertNotIn(C, o)
        self.assertEqual(open(self.ledger, encoding="utf-8").read(), before)

    def test_an_unsafe_stage_id_already_in_a_ledger_refuses_it_without_echo(self):
        out, oid = self.prepared(); self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        for tid in UNSAFE[:6]:
            d = self.doc(); d["obligations"][0]["stages"]["absence"][0]["tool_use_id"] = tid; write(self.ledger, json.dumps(d, indent=1)); raw = open(self.ledger, encoding="utf-8").read()
            c, o = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual(c, 3, tid); self.assertFalse(json.loads(o)["ok"]); self.assertNotIn(tid, o)
            with self.assertRaises(L.LedgerError) as cm: L.load(self.ledger)
            self.assertNotIn(tid, str(cm.exception)); self.assertEqual(open(self.ledger, encoding="utf-8").read(), raw)

    def test_a_marker_is_never_taken_for_a_recorded_id(self):
        out, oid = self.prepared(); self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        d = self.doc(); d["obligations"][0]["stages"]["absence"][0]["tool_use_id"] = "toolu_bdrk_[REDACTED:ambiguous]"; write(self.ledger, json.dumps(d, indent=1))
        c, o = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual(c, 3, o)

class Lifecycle(Base):
    """RETROSPECTIVE evidence (added after the implementation and already passing: no red run exists for it, none was manufactured): the whole life of an obligation whose WRITE id, or whose NAMED / AUTOMATICALLY SELECTED run id, is a long
    recorded id of every agreed family and suffix form: preparation (`prepare-batch --ledger`) -> persistence and loading -> `ledger record` of both stages -> `ledger resume`, against invented Jev calls that are really in the transcript
    with the canonical claim and evidence. The identities are exact at every step, the obligation id does not change, the resumed rows are valid with BOUND stages, and the binding is not vacuous (a call with other evidence is stale,
    an id that was never called is missing)."""
    ABS_SUFFIX, SRC_SUFFIX = "~2#1", "#1"

    def build(self, kind, tid):
        t = self.t; t.user("intro"); t.user(Q1)
        if kind == "write": t.write_note(tid)
        else:
            t.write_note("w0")
            if kind == "run_named": t.tool("srvtoolu_Earlier" + BODY, "Skill", dict(skill="jev:handoff-verify"), "loaded"); t.user("next")     # a second run: the name is what selects
            t.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded")
        t.save()
        spec = dict(write_id=tid) if kind == "write" else dict(evaluated_against="session_end", **(dict(run=tid) if kind == "run_named" else {}))
        return spec

    def check(self, kind, tid):
        spec = self.build(kind, tid)
        if kind == "run_named":
            c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))], ledger=False); self.assertEqual(c, 3, outs)       # unnamed: ambiguous, so the name is what makes it preparable
        c, outs = self.batch([(Q1, spec)]); self.assertEqual(c, 0, outs); out = outs[0]
        wid, run = (tid, None) if kind == "write" else ("w0", tid)
        self.assertEqual(out["version_ref"]["write_tool_use_id"], wid); self.assertEqual(out["version_ref"].get("run"), run)
        row = self.doc()["obligations"][0]; oid = row["id"]
        self.assertEqual((row["state"], row["identity"]["write_id"], row["identity"]["run"], row["args"]["write_id"], row["args"].get("run")), ("prepared", wid, run, wid, spec.get("run")))
        self.assertNotIn("withheld", json.dumps(row)); self.assertIn(json.dumps(tid), open(self.ledger, encoding="utf-8").read())
        a, s = "toolu_vrtx_Abs" + BODY + self.ABS_SUFFIX, "call_Src" + BODY + self.SRC_SUFFIX
        self.call_absence(out, a); self.assertEqual(self.record(oid, "absence", a)[0], 0)
        self.call_source(out, s); self.assertEqual(self.record(oid, "source", s)[0], 0)
        loaded = L.load(self.ledger)["obligations"][0]; self.assertEqual((loaded["id"], loaded["identity"]["write_id"], loaded["identity"]["run"], loaded["stages"]), (oid, wid, run, {"absence": [{"tool_use_id": a}], "source": [{"tool_use_id": s}]}))
        c, r = self.resume(); self.assertEqual(c, 0, r); o = r["obligations"][0]
        self.assertEqual((o["id"], o["state"], o["reasons"], o["next"]), (oid, "valid", [], "ready_for_the_report"))
        self.assertEqual([(x["stage"], x["tool_use_id"], x["state"], x["reason"]) for x in o["stages"]], [("absence", a, "bound", "bound"), ("source", s, "bound", "bound")])
        self.assertEqual([x["observed"]["verdict"] for x in o["stages"]], ["unsupported", "verified"]); self.assertEqual((r["coverage"]["obligations"], r["coverage"]["valid"]), (1, 1))
        c, outs = self.batch([(Q1, spec)]); self.assertEqual(c, 0, outs)                          # the same evaluation again: the same obligation, nothing reset
        d = self.doc(); self.assertEqual((len(d["obligations"]), d["obligations"][0]["id"], d["obligations"][0]["stages"]), (1, oid, {"absence": [{"tool_use_id": a}], "source": [{"tool_use_id": s}]}))
        return out, oid

    def test_long_write_ids_complete_the_whole_lifecycle(self):
        for tid in LONG:
            with self.subTest(tid=tid): self.setUp(); self.check("write", tid); self.tearDown()

    def test_long_automatically_selected_run_ids_complete_the_whole_lifecycle(self):
        for tid in LONG:
            with self.subTest(tid=tid): self.setUp(); self.check("run_selected", tid); self.tearDown()

    def test_long_named_run_ids_complete_the_whole_lifecycle(self):
        for tid in LONG:
            with self.subTest(tid=tid): self.setUp(); self.check("run_named", tid); self.tearDown()

    def test_the_binding_is_not_vacuous_for_long_identities(self):
        tid = "toolu_bdrk_" + BODY + "~2#1"; out, oid = self.check("write", tid)
        bad, ghost = "call_Bad" + BODY, "call_Ghost" + BODY
        self.t.verify(bad, out["absence_claim"], "other evidence", verdict="unsupported"); self.t.save()
        self.assertEqual(self.record(oid, "absence", bad)[0], 0); self.assertEqual(self.record(oid, "absence", ghost)[0], 0)
        c, r = self.resume(); st = {x["tool_use_id"]: x for x in r["obligations"][0]["stages"]}
        self.assertEqual((st[bad]["state"], st[ghost]["state"]), ("stale", "missing")); self.assertEqual(r["obligations"][0]["state"], "valid")
        self.assertEqual([x["state"] for x in r["obligations"][0]["stages"] if x["tool_use_id"] not in (bad, ghost)], ["bound", "bound"])

if __name__ == "__main__": unittest.main()

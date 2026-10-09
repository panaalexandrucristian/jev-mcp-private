#!/usr/bin/env python3
"""The identity-output matrix of the shared identity policy (stdlib, offline, invented transcripts, explicit temporary output locations): ONE test per place that prints or persists a source / note / write / run / stage / tool_use
identity or a resolved path. Three kinds of place:
 - CONSUMERS that make an identity part of a binding or of a payload (omissions prepare / prepare-batch, scope prepare, the ledger file and its record / load / resume): the corrected policy applies (a recorded credential-free id
   is kept byte-for-byte, anything that needs redaction is refused without echo and never replaced); tested in test_identity_roles.py and test_scope_identities.py, and here for the remaining fields (`runs`, paths, the ledger file);
 - COPY SOURCES (prepare.py inventory.json, versions.py list / status, the persisted report): they print the identity exactly as the transcript recorded it, because the binding compares it byte-for-byte (a placeholder would not be
   the identity); a clean long id must reach them unchanged and no placeholder may stand for an id; an unsafe id is refused by every consumer above (observation: these local surfaces still show it);
 - DIAGNOSTICS that echo a value the caller GAVE (a selector, a run, a report path): an unsafe value is not echoed, a clean one is, as before.
usage: python3 -B test_identity_places.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions as O, report, scope, versions
from test_obligation_ledger import Base, ENV, NOTE, Q1, Tx, run, write
from test_identity_roles import BODY, C

WID, RID, RID2 = "toolu_bdrk_" + BODY + "~2#1", "call_" + BODY, "srvtoolu_" + BODY
UNSAFE_ID = "API_KEY=" + C

def cli(script, *args, cwd):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + list(args), cwd=cwd, capture_output=True, text=True, env=ENV); return p.returncode, p.stdout

class Places(Base):
    def long_session(self, wid=WID, *runs):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note(wid)
        for r in runs: self.t.tool(r, "Skill", dict(skill="jev:handoff-verify"), "loaded"); self.t.user("next " + r[-4:])
        self.t.save()

    # ---- copy sources
    def test_prepare_inventory_keeps_a_clean_long_write_id_and_shows_no_placeholder(self):
        self.long_session(); out = os.path.join(self.d, "out"); c, o = cli("prepare.py", self.t.log, "--cwd", self.d, "--out", out, cwd=self.d); self.assertEqual(c, 0, o)
        inv = json.load(open(os.path.join(out, "inventory.json"), encoding="utf-8")); ids = [v["tool_use_id"] for h in inv["handoffs"] for v in h["versions"]] if "handoffs" in inv else None
        raw = open(os.path.join(out, "inventory.json"), encoding="utf-8").read(); self.assertIn(json.dumps(WID), raw); self.assertNotIn("REDACTED", raw); self.assertNotIn("REDACTED", o)

    def test_prepare_does_not_echo_an_unsafe_session_argument(self):
        c, o = cli("prepare.py", os.path.join(self.d, UNSAFE_ID + ".jsonl"), "--cwd", self.d, cwd=self.d); self.assertEqual(c, 2, o); self.assertNotIn(C, o)
        c, o = cli("prepare.py", os.path.join(self.d, "missing.jsonl"), "--cwd", self.d, cwd=self.d); self.assertEqual(c, 2); self.assertIn("missing.jsonl", json.loads(o)["arg"])      # a clean argument is echoed, as before

    def test_versions_list_keeps_clean_long_write_and_run_ids_and_accepts_a_named_run(self):
        self.long_session(WID, RID, RID2)
        c, o = cli("versions.py", "list", "--source", self.t.log, "--file", self.t.note, "--evaluated-against", "session_end", "--run", RID2, "--cwd", self.d, cwd=self.d); r = json.loads(o); self.assertEqual(c, 0, o)
        v = r["versions"][0]; self.assertEqual((v["write_tool_use_id"], v["version_ref"]["write_tool_use_id"], v["version_ref"]["run"], v["runs"]), (WID, WID, RID2, [RID, RID2])); self.assertNotIn("REDACTED", o)

    def test_versions_list_does_not_echo_an_unsafe_given_value(self):
        self.long_session(WID, RID)
        c, o = cli("versions.py", "list", "--source", os.path.join(self.d, UNSAFE_ID + ".jsonl"), "--file", self.t.note, "--evaluated-against", "prefix", cwd=self.d); self.assertEqual(c, 3, o); self.assertNotIn(C, o)
        c, o = cli("versions.py", "list", "--source", self.t.log, "--file", self.t.note, "--evaluated-against", "session_end", "--run", UNSAFE_ID, "--cwd", self.d, cwd=self.d); self.assertEqual(c, 3, o); self.assertNotIn(C, o)
        c, o = cli("versions.py", "list", "--source", self.t.log, "--file", self.t.note, "--evaluated-against", "session_end", "--run", "no-such-run", "--cwd", self.d, cwd=self.d); self.assertEqual(c, 3); self.assertIn("--run no-such-run ", json.loads(o)["error"])

    def test_versions_status_keeps_the_latest_long_write_id_and_does_not_echo_an_unsafe_report_path(self):
        self.long_session(); rep = os.path.join(self.d, "none.verify.json")
        c, o = cli("versions.py", "status", "--session", self.t.log, "--file", self.t.note, "--report", rep, "--cwd", self.d, cwd=self.d); r = json.loads(o); self.assertEqual((r["latest_write_id"], r["report_path"]), (WID, rep))
        c, o = cli("versions.py", "status", "--session", self.t.log, "--file", self.t.note, "--report", os.path.join(self.d, UNSAFE_ID + ".json"), "--cwd", self.d, cwd=self.d); self.assertNotIn(C, o)

    def test_the_persisted_report_keeps_clean_long_ids_in_the_binding_fields(self):
        self.long_session(WID, RID); open(self.t.note, "w").write(NOTE)
        v = next(x for x in versions.versions_of(self.t.log, self.t.note)[0] if x["write_tool_use_id"] == WID); ref = dict(versions.version_ref(v, "session_end"), run=RID)
        doc = dict(session=dict(session_id="s1", jsonl=self.t.log, cwd=self.d), handoff=dict(path=self.t.note, versions=[]), status="UNRESOLVED", findings=[], unresolved=[],
                   checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id="c1", result_index=0, key="k"), version_ref=ref)])
        rd = os.path.join(self.d, "rep"); os.makedirs(rd); md, js = report.write_report(rd, self.t.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=self.t.log)
        raw = open(os.path.join(rd, js), encoding="utf-8").read(); out = json.loads(raw)
        self.assertEqual(out["checks"][0]["version_ref"], ref); self.assertEqual(out["delivery"]["latest_write_id"], WID); self.assertNotIn("REDACTED", raw)

    # ---- consumers
    def test_the_listed_runs_of_an_ambiguous_selection_keep_clean_long_ids_and_sanitize_unsafe_ones(self):
        self.long_session(WID, RID, RID2, UNSAFE_ID)
        c, outs = self.batch([(Q1, dict(write_id=WID, evaluated_against="session_end"))]); self.assertEqual(c, 3, outs); self.assertNotIn(C, json.dumps(outs)); runs = outs[0]["runs"]
        self.assertEqual(runs[:2], [RID, RID2]); self.assertNotIn(UNSAFE_ID, runs)
        self.assertNotIn(C, open(self.ledger, encoding="utf-8").read())

    def test_the_omission_preparation_keeps_a_clean_long_source_and_note_path_exactly(self):
        d = os.path.join(self.d, "Proj" + BODY + BODY); os.makedirs(d); self.t = Tx(d); self.ledger = os.path.join(d, "ledger.json"); write(self.t.note, NOTE); self.t.user("intro"); self.t.user(Q1); self.t.write_note(WID); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id=WID, evaluated_against="prefix", cwd=d))]); self.assertEqual(c, 0, outs); self.assertEqual(outs[0]["version_ref"]["write_tool_use_id"], WID)
        row = self.doc()["obligations"][0]; self.assertEqual((row["identity"]["source"], row["identity"]["file"], row["state"]), (os.path.realpath(self.t.log), os.path.realpath(self.t.note), "prepared")); self.assertNotIn("withheld", json.dumps(row))

    def test_the_ledger_file_keeps_clean_long_ids_and_paths_and_withholds_an_unsafe_location(self):
        self.long_session(WID, RID); c, outs = self.batch([(Q1, dict(write_id=WID, evaluated_against="session_end"))]); self.assertEqual(c, 0, outs)
        row = self.doc()["obligations"][0]; self.assertEqual((row["args"]["write_id"], row["args"]["run"], row["identity"]["write_id"], row["identity"]["run"], row["args"]["file"]), (WID, None, WID, RID, self.t.note))
        loc = os.path.join(self.d, UNSAFE_ID); os.makedirs(loc)
        c, outs = self.batch([(Q1, dict(write_id=WID, evaluated_against="session_end"))], extra=["--location", loc]); self.assertNotEqual(c, 0); self.assertNotIn(C, json.dumps(outs)); self.assertNotIn(C, open(self.ledger, encoding="utf-8").read())

if __name__ == "__main__": unittest.main()

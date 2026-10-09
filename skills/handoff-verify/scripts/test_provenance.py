#!/usr/bin/env python3
"""Offline test of the provenance preflight (item 8; stdlib only, no Jev call, never reads .handoff-verify/): a note that the checked session never wrote with a supported Write/Edit has no write identity and
no window, so nothing version-dependent is scheduled for it. `versions.provenance` says recorded_write / failed_writes_only / bash_only / no_record with a precise blocker; `versions.py list` and
`omissions.py prepare` / `prepare-batch` stop with exit 3 and the same text; `prepare.py --target FILE` lists an explicit external note as `external_unlinked` (no versions, an informational disk hash);
`report.write_report` keeps the blocker and stays UNRESOLVED even without checks. A byte-identical assistant text block, equal paths or newline-normalised hashes never create a version. Invented fixtures.
usage: python3 -B test_provenance.py [-v]"""
import contextlib, hashlib, io, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, omissions, prepare, report, skilldocs, versions
from test_stream_reconstruction import Tx

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
NOTE_TEXT = "# Handoff\n- ship it on Friday\n"
def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "s.jsonl"); open(self.note, "w", newline="").write(NOTE_TEXT)
    def session(self, build):
        t = Tx(self.d, stamp=False); t.rec("user", "write the handoff"); build(t); return t.save(self.log)
    def cli(self, script, *argv):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script), *argv], capture_output=True, text=True, env=ENV); return p.returncode, json.loads(p.stdout)
    def external(self, t):           # the note exists on disk, the session only SAID its text
        t.rec("assistant", [dict(type="text", text=NOTE_TEXT)])
    def failed(self, t): t.tool("w1", "Write", dict(file_path=self.note, content=NOTE_TEXT), "denied", error=True)
    def bashed(self, t): t.tool("b1", "Bash", dict(command="printf 'x' > %s" % self.note), "")
    def written(self, t): t.write("w1", self.note, NOTE_TEXT)

class Provenance(Base):
    def test_states_and_blockers(self):
        for build, state in ((self.external, "no_record"), (self.failed, "failed_writes_only"), (self.bashed, "bash_only"), (self.written, "recorded_write")):
            with self.subTest(state):
                log = self.session(build); p = versions.provenance(log, self.note); self.assertEqual(p["state"], state); self.assertEqual(p["path"], self.note)
                if state == "recorded_write": self.assertIsNone(p["blocker"])
                else:
                    self.assertIn("no recorded supported Write/Edit", p["blocker"]); self.assertIn("no write identity or window", p["blocker"]); self.assertIn(self.note, p["blocker"])
                    for banned in ("assistant", "newline", "normali"): self.assertNotIn(banned, p["blocker"])
        self.assertIn("failed", versions.provenance(self.session(self.failed), self.note)["blocker"]); self.assertIn("Bash", versions.provenance(self.session(self.bashed), self.note)["blocker"])

    def test_a_demonstrated_relocation_of_a_written_note_is_recorded_provenance(self):
        os.makedirs(os.path.join(self.d, "orig")); orig = os.path.join(self.d, "orig", "HANDOFF.md"); copy = self.note
        log = self.session(lambda t: t.write("w1", orig, NOTE_TEXT)); p = versions.provenance(log, copy); self.assertEqual((p["state"], p["via"], p["source_path"]), ("recorded_write", "relocated", orig))
        open(copy, "w").write("something else\n"); self.assertEqual(versions.provenance(log, copy)["state"], "no_record")           # other bytes: not a relocation
        self.assertEqual(versions.provenance(log, copy, source_path=orig)["state"], "recorded_write")                               # the report names the written path explicitly

class Preflight(Base):
    def test_versions_list_and_omissions_prepare_stop_with_the_same_text_and_no_version_ref(self):
        for build in (self.external, self.failed, self.bashed):
            log = self.session(build); blocker = versions.provenance(log, self.note)["blocker"]
            code, o = self.cli("versions.py", "list", "--source", log, "--file", self.note, "--evaluated-against", "session_end"); self.assertEqual(code, 3); self.assertEqual(o["error"], blocker); self.assertNotIn("version_ref", json.dumps(o))
            code, o = self.cli("omissions.py", "prepare", "--source", log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "prefix", "--detail", "d", "--source-quote", "write the handoff"); self.assertEqual(code, 3); self.assertEqual(o["reasons"], [blocker])
            spec = os.path.join(self.d, "spec.json"); json.dump([dict(detail="d", source_quote="write the handoff")], open(spec, "w"))
            code, o = self.cli("omissions.py", "prepare-batch", "--source", log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "prefix", "--spec", spec); self.assertEqual(code, 3); self.assertEqual(o[0]["reasons"], [blocker])

    def test_a_recorded_write_and_a_legitimate_relocation_continue_normally(self):
        log = self.session(self.written)
        code, o = self.cli("versions.py", "list", "--source", log, "--file", self.note, "--evaluated-against", "session_end"); self.assertEqual(code, 0); self.assertIn("version_ref", o["versions"][0])
        code, o = self.cli("omissions.py", "prepare", "--source", log, "--file", self.note, "--write-id", "w1", "--evaluated-against", "session_end", "--detail", "d", "--source-quote", "write the handoff"); self.assertEqual(code, 0, o)
        os.makedirs(os.path.join(self.d, "elsewhere")); copy = os.path.join(self.d, "elsewhere", "HANDOFF.md"); open(copy, "w").write(NOTE_TEXT)
        code, o = self.cli("versions.py", "list", "--source", log, "--file", copy, "--evaluated-against", "session_end"); self.assertEqual(code, 0, o); self.assertEqual(o["handoff_source_path"], self.note)

class Target(Base):
    def prepare(self, log, *argv):
        out = io.StringIO(); work = os.path.join(self.d, "work%d" % len(os.listdir(self.d))); old = sys.argv; sys.argv = ["prepare.py", log, "--cwd", self.d, "--out", work, *argv]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        return code, json.loads(out.getvalue()), json.load(open(os.path.join(work, "inventory.json")))

    def test_an_explicit_external_target_is_listed_unlinked_with_no_version(self):
        log = self.session(self.external); alias = os.path.join(self.d, "alias.md"); os.symlink(self.note, alias)
        code, out, inv = self.prepare(log, "--target", self.note, "--target", alias); self.assertEqual(code, 0)
        rows = [h for h in inv["handoffs"] if h["path"] == self.note]; self.assertEqual(len(rows), 1)             # aliases of one canonical path are one row
        r = rows[0]; self.assertEqual((r["disposition"], r["linked"], r["versions"], r["provenance"]), ("external_unlinked", False, [], "no_record")); self.assertEqual(r["disk_sha256"], sha(NOTE_TEXT)); self.assertEqual(r["aliases"], [alias])
        self.assertIn("no recorded supported Write/Edit", r["blockers"][0]); self.assertEqual(out["blockers"], r["blockers"]); self.assertEqual(out["versions"], 0)
        self.assertNotIn("version_ref", json.dumps(inv)); self.assertNotIn("write_tool_use_id", json.dumps(r))
        code, out2, inv2 = self.prepare(log); self.assertEqual([h for h in inv2["handoffs"] if h["path"] == self.note], [])      # without --target the note is not even listed

    def test_a_recorded_target_is_a_normal_row_and_failed_or_bash_targets_are_unlinked(self):
        code, out, inv = self.prepare(self.session(self.written), "--target", self.note); h = inv["handoffs"][0]; self.assertEqual((h["linked"], len(h["versions"]), out["blockers"]), (True, 1, []))
        for build, state in ((self.failed, "failed_writes_only"), (self.bashed, "bash_only")):
            code, out, inv = self.prepare(self.session(build), "--target", self.note); self.assertEqual([h["provenance"] for h in inv["handoffs"] if h["path"] == self.note], [state])

    def test_a_relative_target_resolves_against_cwd_and_a_missing_one_has_no_disk_hash(self):
        code, out, inv = self.prepare(self.session(self.external), "--target", "HANDOFF.md", "--target", os.path.join(self.d, "ghost.md"))
        rows = {h["path"]: h for h in inv["handoffs"]}; self.assertEqual(rows[self.note]["disk_sha256"], sha(NOTE_TEXT)); self.assertIsNone(rows[os.path.join(self.d, "ghost.md")]["disk_sha256"]); self.assertEqual(len(out["blockers"]), 2)

class Report(Base):
    def test_the_report_keeps_the_blocker_and_stays_unresolved_without_checks(self):
        log = self.session(self.external); blocker = versions.provenance(log, self.note)["blocker"]
        rd = os.path.join(self.d, "run"); os.makedirs(rd)
        doc = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=[], findings=[], unresolved=[], status="UNRESOLVED")
        md, js = report.write_report(rd, self.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=log); out = json.load(open(os.path.join(rd, js)))
        self.assertEqual(out["status"], "UNRESOLVED"); self.assertEqual(out["checks"], []); self.assertEqual(out["binding_summary"]["version_identity"]["provenance"]["state"], "no_record")
        self.assertIn(blocker, out["binding_summary"]["reasons"]); self.assertNotEqual(out.get("delivery", {}).get("delivery_state"), "verified_version")
        # a claimed PASS cannot survive an unlinked note either
        doc["status"] = "PASS"; md, js = report.write_report(rd, self.note, doc, "Stare: **PASS**\n", existing=(), calls_jsonl=log); out2 = json.load(open(os.path.join(rd, js))); self.assertEqual(out2["status"], "UNRESOLVED")
        self.assertIn(blocker, out2["binding_summary"]["reasons"])

    def test_a_recorded_write_has_no_provenance_blocker_in_the_report(self):
        log = self.session(self.written); rd = os.path.join(self.d, "run"); os.makedirs(rd)
        doc = dict(session=dict(session_id="s1", jsonl=log, cwd=self.d), handoff=dict(path=self.note, versions=[]), checks=[], findings=[], unresolved=[], status="UNRESOLVED")
        md, js = report.write_report(rd, self.note, doc, "Stare: **UNRESOLVED**\n", calls_jsonl=log); out = json.load(open(os.path.join(rd, js)))
        self.assertEqual(out["binding_summary"]["version_identity"]["provenance"]["state"], "recorded_write"); self.assertFalse([r for r in out["binding_summary"]["reasons"] if "no recorded supported" in r])

class SkillText(unittest.TestCase):
    def test_skill_md_documents_targets_fail_fast_names_window_and_the_report(self):
        t = skilldocs.text()      # the active documentation: the rules live in SKILL.md, the preparation reference and the OpenCode reference (unpositioned, evidence only), the reporting ones in the report reference
        for needle in ("--target", "external_unlinked", "versions.provenance", "no recorded supported", "stays UNRESOLVED", "source_file", "<hash8 of the real path>", "Source window", "unpositioned", "evidence only"): self.assertIn(needle, t, needle)

if __name__ == "__main__": unittest.main()

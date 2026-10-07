#!/usr/bin/env python3
"""Offline test of the bases of the omission material (stdlib + git, no Jev call): `omissions.py prepare` and the report re-derivation (versions.bind_versions) build the SAME material from the cwd recorded
in the transcript for the write of the note plus the note directory, whatever the process cwd or --cwd; without a recorded cwd only the note directory and its git root count.
usage: python3 -B test_material_parity.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, versions

QUOTE = "Never run migrate.sh against prod."
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: f.write(text)

def session(path, note, text, write_cwd, first_cwd=None):
    recs = [dict(type="user", uuid="u1", timestamp="2026-01-01T00:00:00Z", **({"cwd": first_cwd} if first_cwd else {}), sessionId="s1", message=dict(role="user", content=QUOTE)),
            dict(type="assistant", uuid="a1", timestamp="2026-01-01T00:00:01Z", **({"cwd": write_cwd} if write_cwd else {}), sessionId="s1",
                 message=dict(role="assistant", content=[dict(type="tool_use", id="w0", name="Write", input=dict(file_path=note, content=text))])),
            dict(type="user", uuid="r1", timestamp="2026-01-01T00:00:02Z", **({"cwd": write_cwd} if write_cwd else {}), sessionId="s1",
                 message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w0", content="File created successfully at: " + note)]))]
    write(path, "".join(json.dumps(r) + "\n" for r in recs))

class Parity(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.sess_cwd, self.other, self.notedir, self.old = (os.path.join(self.d, x) for x in ("sess", "other", "notes", "old"))
        write(os.path.join(self.sess_cwd, "ref.md"), "reference from the session cwd\n")
        write(os.path.join(self.other, "ref.md"), "reference from the PROCESS cwd\n")
        write(os.path.join(self.old, "ref.md"), "reference from an earlier cwd\n")
        self.note = os.path.join(self.notedir, "HANDOFF.md"); self.text = "- see `ref.md`\n"
        write(self.note, self.text); self.log = os.path.join(self.d, "session.jsonl"); self.cwd0 = os.getcwd()
    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def prepare(self, run_cwd, extra=()):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix",
                            "--detail", QUOTE, "--source-quote", QUOTE] + list(extra), cwd=run_cwd, capture_output=True, text=True, env=ENV)
        return p.returncode, json.loads(p.stdout)

    def report_material(self, run_cwd):
        os.chdir(run_cwd)
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        ref = versions.version_ref(vs[0], "prefix")
        rows = versions.bind_versions([dict(version_ref=ref)], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        return rows["k"]["omission"]

    def test_prepare_and_report_same_material_other_cwd(self):
        session(self.log, self.note, self.text, self.sess_cwd)
        code, out = self.prepare(self.other, ["--cwd", self.other]); self.assertEqual(code, 0, out)
        om = self.report_material(self.other)
        self.assertIsNotNone(out["material"]); self.assertEqual(out["material"], om["material"])
        self.assertIn("reference from the session cwd", out["material"]); self.assertNotIn("PROCESS cwd", out["material"])

    def test_cwd_at_write_after_location_switch(self):
        session(self.log, self.note, self.text, self.sess_cwd, first_cwd=self.old)
        vs, _, _, _ = versions.versions_of(self.log, self.note)
        self.assertEqual(vs[0]["cwd"], self.sess_cwd)
        self.assertEqual(omissions.material_bases(self.note, vs[0]), [self.notedir, self.sess_cwd])
        code, out = self.prepare(self.other); self.assertEqual(code, 0, out)
        self.assertIn("session cwd", out["material"]); self.assertNotIn("earlier cwd", out["material"])

    def test_no_recorded_cwd_note_dir_and_git_root_only(self):
        session(self.log, self.note, self.text, None)
        vs, _, _, _ = versions.versions_of(self.log, self.note)
        self.assertIsNone(vs[0]["cwd"]); self.assertEqual(omissions.material_bases(self.note, vs[0]), [self.notedir])
        code, out = self.prepare(self.other, ["--cwd", self.other])      # ref.md exists in the process cwd and --cwd only: the reference stays unresolved
        self.assertEqual(code, 3); self.assertIn("cannot be resolved", out["reasons"][0])
        self.assertIsNone(self.report_material(self.other)["material"])
        write(os.path.join(self.notedir, "ref.md"), "reference next to the note\n")
        code, out = self.prepare(self.other); self.assertEqual(code, 0, out)
        self.assertEqual(out["material"], self.report_material(self.other)["material"])
        self.assertIn("next to the note", out["material"])

    def test_process_cwd_never_used(self):
        session(self.log, self.note, self.text, self.sess_cwd)
        os.remove(os.path.join(self.sess_cwd, "ref.md"))
        code, out = self.prepare(self.other, ["--cwd", self.other])
        self.assertEqual(code, 3); self.assertIsNone(self.report_material(self.other)["material"])

if __name__ == "__main__": unittest.main()

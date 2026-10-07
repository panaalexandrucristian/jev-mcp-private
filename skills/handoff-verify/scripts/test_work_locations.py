#!/usr/bin/env python3
"""Offline test of the work locations (stdlib + git, no Jev call): `--location DIR` of omissions.py prepare / prepare-batch / prepare.py, the ordered bases, `work_locations` and `missing_reference` in the prepare output,
and the report re-derivation (versions.bind_versions / versions.gate with doc["work_locations"]).
usage: python3 -B test_work_locations.py [-v]"""
import json, os, shutil, subprocess, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, versions, refs
from test_material_parity import QUOTE, ENV, write, session

class WorkLocations(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.sess_cwd, self.notedir, self.mem, self.mem2, self.other = (os.path.join(self.d, x) for x in ("sess", "notes", "mem", "mem2", "other"))
        for x in (self.sess_cwd, self.other): os.makedirs(x)
        write(os.path.join(self.mem, "elsewhere.md"), "reference that lives in a memory folder\n")
        self.note = os.path.join(self.notedir, "HANDOFF.md"); self.text = "- see `elsewhere.md`\n"
        write(self.note, self.text); self.log = os.path.join(self.d, "session.jsonl"); self.cwd0 = os.getcwd()
        session(self.log, self.note, self.text, self.sess_cwd)
    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def prepare(self, extra=(), script="prepare", pre=()):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), script] + list(pre) + list(extra), cwd=self.other, capture_output=True, text=True, env=ENV)
        return p.returncode, json.loads(p.stdout)

    def args(self, extra=()):
        return ["--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix", "--detail", QUOTE, "--source-quote", QUOTE] + list(extra)

    def version(self):
        vs, _, _, _ = versions.versions_of(self.log, self.note); return vs[0]

    def report_row(self, locs):
        ref = versions.version_ref(self.version(), "prefix")
        rows = versions.bind_versions([dict(version_ref=ref)], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False, None, locs)
        return rows["k"]["omission"]

    def test_location_resolves_blocked_ref(self):
        code, out = self.prepare(self.args()); self.assertEqual(code, 3); self.assertIn("cannot be resolved", out["reasons"][0])
        code, out = self.prepare(self.args(["--location", self.mem])); self.assertEqual(code, 0, out)
        self.assertIn("lives in a memory folder", out["material"]); self.assertEqual(out["material_manifest"][0]["path"], os.path.join(self.mem, "elsewhere.md"))

    def test_location_order_of_bases(self):
        v = self.version()
        self.assertEqual(omissions.material_bases(self.note, v, [self.mem, self.mem2]), [self.notedir, self.sess_cwd, self.mem, self.mem2])
        self.assertEqual(omissions.material_bases(self.note, v, [self.mem2, self.mem, self.mem2, self.notedir]), [self.notedir, self.sess_cwd, self.mem2, self.mem])
        os.makedirs(self.mem2); write(os.path.join(self.mem2, "elsewhere.md"), "second copy\n")
        code, out = self.prepare(self.args(["--location", self.mem2, "--location", self.mem])); self.assertEqual(code, 0, out)
        self.assertIn("second copy", out["material"]); self.assertNotIn("memory folder", out["material"])
        code, out = self.prepare(self.args(["--location", self.mem, "--location", self.mem2]))
        self.assertIn("memory folder", out["material"])

    def test_no_location_material_byte_identical(self):
        os.remove(os.path.join(self.mem, "elsewhere.md")); write(os.path.join(self.notedir, "elsewhere.md"), "next to the note\n")
        code, out = self.prepare(self.args()); self.assertEqual(code, 0, out)
        expect, _, why = omissions.build_material(self.text, omissions.material_bases(self.note, self.version()))
        self.assertIsNone(why); self.assertEqual(out["material"], expect); self.assertEqual(omissions.material_bases(self.note, self.version()), omissions.material_bases(self.note, self.version(), ()))
        code2, out2 = self.prepare(self.args(["--location", self.mem])); self.assertEqual(out2["material"], out["material"])   # an unrelated location does not change a complete material

    def test_relative_location_refused_exit3(self):
        code, out = self.prepare(self.args(["--location", "mem"])); self.assertEqual(code, 3); self.assertFalse(out["ok"]); self.assertIn("not an absolute path", out["reasons"][0])

    def test_nonexistent_location_refused_exit3(self):
        code, out = self.prepare(self.args(["--location", os.path.join(self.d, "nope")])); self.assertEqual(code, 3); self.assertIn("not an existing directory", out["reasons"][0])

    def test_file_as_location_refused(self):
        code, out = self.prepare(self.args(["--location", os.path.join(self.mem, "elsewhere.md")])); self.assertEqual(code, 3); self.assertIn("not an existing directory", out["reasons"][0])

    def test_prepare_batch_accepts_location(self):
        spec = os.path.join(self.d, "spec.json"); json.dump([dict(detail=QUOTE, source_quote=QUOTE)], open(spec, "w"))
        base = ["--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix", "--spec", spec]
        code, out = self.prepare(base, "prepare-batch"); self.assertEqual(code, 3); self.assertFalse(out[0]["ok"])
        code, out = self.prepare(base + ["--location", self.mem], "prepare-batch"); self.assertEqual(code, 0, out)
        code1, one = self.prepare(self.args(["--location", self.mem])); self.assertEqual(out[0], one)
        code, out = self.prepare(base + ["--location", "relative"], "prepare-batch"); self.assertEqual(code, 3); self.assertIn("not an absolute path", out[0]["reasons"][0])

    def test_prepare_py_records_location(self):
        out_dir = os.path.join(self.d, "work")
        def run(extra):
            p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), self.log, "--out", out_dir] + extra, cwd=self.other, capture_output=True, text=True, env=ENV)
            return p.returncode, json.loads(p.stdout)
        code, out = run(["--location", self.mem, "--location", self.other]); self.assertEqual(code, 0, out)
        self.assertEqual(out["work_locations"], [self.mem, self.other]); self.assertEqual(out["session_cwd"], self.sess_cwd); self.assertEqual(out["note_dirs"], [self.notedir])
        self.assertEqual(json.load(open(os.path.join(out_dir, "inventory.json")))["session"]["work_locations"], [self.mem, self.other])
        code, out = run(["--location", "relative"]); self.assertEqual(code, 3); self.assertIn("not an absolute path", out["error"])
        code, out = run([]); self.assertEqual(code, 0); self.assertEqual(out["work_locations"], [])

    def test_missing_reference_printed_with_ref_reason_searched(self):
        code, out = self.prepare(self.args()); self.assertEqual(code, 3)
        m = out["missing_reference"]; self.assertEqual(m["ref"], "elsewhere.md"); self.assertEqual(m["reason"], "not found from the bases")
        self.assertEqual(m["searched"], [self.notedir, self.sess_cwd]); self.assertEqual(out["work_locations"], m["searched"])
        code, out = self.prepare(self.args(["--location", self.mem2 if os.path.isdir(self.mem2) else self.other])); self.assertEqual(out["missing_reference"]["searched"][-1], self.mem2 if os.path.isdir(self.mem2) else self.other)

    def test_work_locations_printed_after_git_roots(self):
        repo = os.path.join(self.d, "repo"); os.makedirs(os.path.join(repo, ".git")); os.makedirs(os.path.join(repo, "sub")); write(os.path.join(repo, "sub", "elsewhere.md"), "in a repo\n")
        code, out = self.prepare(self.args(["--location", os.path.join(repo, "sub")])); self.assertEqual(code, 0, out)
        self.assertEqual(out["work_locations"], [self.notedir, self.sess_cwd, os.path.join(repo, "sub"), repo])

    def test_prepare_report_parity_with_work_locations(self):
        code, out = self.prepare(self.args(["--location", self.mem])); self.assertEqual(code, 0, out)
        row = self.report_row([self.mem]); self.assertEqual(out["material"], row["material"]); self.assertIsNone(row["material_reason"])
        self.assertIsNone(self.report_row([])["material"])   # without the stored location the report cannot re-derive the material

    def test_missing_location_at_report_time_unavailable_with_reason(self):
        shutil.rmtree(self.mem2, ignore_errors=True); gone = os.path.join(self.d, "gone"); os.makedirs(gone)
        self.assertIsNotNone(self.report_row([self.mem, gone])["material"]); shutil.rmtree(gone)
        row = self.report_row([self.mem, gone]); self.assertIsNone(row["material"]); self.assertIn("does not exist at report time", row["material_reason"]); self.assertIn(gone, row["material_reason"])
        row = self.report_row(["relative"]); self.assertIsNone(row["material"]); self.assertIn("not an absolute path", row["material_reason"])

    def test_invalid_work_locations_type_unavailable(self):
        for bad in ("/abs/string", {"a": 1}, [1], [self.mem, None]):
            row = self.report_row(bad); self.assertIsNone(row["material"], bad); self.assertIn("not a list of directory strings", row["material_reason"])

    def test_gate_uses_doc_work_locations(self):
        seen = []
        def spy(*a, **k): seen.append(a[7] if len(a) > 7 else k.get("work_locations")); return {}
        doc = dict(schema_version="1", checks=[], findings=[], handoff=dict(path=self.note, versions=[]), session=dict(jsonl=self.log), work_locations=[self.mem])
        with mock.patch.object(versions, "bind_versions", spy):
            try: versions.gate(self.log, self.note, doc, session_id="s1")
            except Exception: pass
        self.assertEqual(seen, [[self.mem]])

    def test_prepare_py_lists_session_cwds_in_order(self):
        recs = []
        for i, cwd in enumerate((self.sess_cwd, self.other)):
            recs += [dict(type="assistant", uuid="a%d" % i, timestamp="2026-01-01T00:00:0%dZ" % (2 * i), cwd=cwd, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="w%d" % i, name="Write", input=dict(file_path=self.note, content=self.text + "v%d\n" % i))])),
                     dict(type="user", uuid="r%d" % i, timestamp="2026-01-01T00:00:0%dZ" % (2 * i + 1), cwd=cwd, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w%d" % i, content="ok")]))]
        write(self.log, "".join(json.dumps(r) + "\n" for r in recs))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), self.log, "--out", os.path.join(self.d, "work2")], cwd=self.other, capture_output=True, text=True, env=ENV)
        out = json.loads(p.stdout); self.assertEqual(p.returncode, 0, out)
        self.assertEqual(out["session_cwds"], [self.sess_cwd, self.other]); self.assertEqual(out["session_cwd"], self.sess_cwd)

    def test_prepare_py_session_cwds_from_records_without_writes(self):
        recs = [json.loads(l) for l in open(self.log)]   # the write at self.sess_cwd, then a record with another cwd and no Write/Edit call
        recs.append(dict(type="user", uuid="u9", timestamp="2026-01-01T00:00:09Z", cwd=self.other, sessionId="s1", message=dict(role="user", content="moved on")))
        write(self.log, "".join(json.dumps(r) + "\n" for r in recs))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), self.log, "--out", os.path.join(self.d, "work3")], cwd=self.other, capture_output=True, text=True, env=ENV)
        out = json.loads(p.stdout); self.assertEqual(p.returncode, 0, out)
        self.assertEqual(out["session_cwds"], [self.sess_cwd, self.other]); self.assertEqual(out["session_cwd"], self.sess_cwd)

    def test_schema_work_locations_must_be_absolute(self):
        import re
        prop = json.load(open(os.path.join(HERE, "report.schema.json")))["properties"]["work_locations"]
        self.assertEqual(prop["type"], "array"); item = prop["items"]; self.assertEqual(item["type"], "string")
        self.assertTrue(re.search(item["pattern"], "/abs/dir")); self.assertFalse(re.search(item["pattern"], "relative/dir"))

    def test_every_prepare_failure_after_bases_prints_work_locations(self):
        loc = ["--location", self.mem]
        def run(**kw):
            a = dict(detail=QUOTE, quote=QUOTE); a.update(kw)
            return self.prepare(["--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix", "--detail", a["detail"], "--source-quote", a["quote"]] + loc)
        want = [self.notedir, self.sess_cwd, self.mem]
        for kw, why in ((dict(detail=" "), "empty detail"), (dict(detail=omissions.SOURCE_PREFIX + "x"), "bare detail"), (dict(quote="not in the transcript"), "source quote is not")):
            code, out = run(**kw); self.assertEqual(code, 3); self.assertIn(why, out["reasons"][0]); self.assertEqual(out["work_locations"], want)

if __name__ == "__main__": unittest.main()

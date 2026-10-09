#!/usr/bin/env python3
"""Offline test of the delivered-version gate against stale versions (stdlib only, no Jev call, never reads .handoff-verify/): a report about a handoff version that is not the latest write of
its path must never be `verified_version`, whether the report was valid when it was written and the note changed afterwards, or a strict-prefix copy of the same session transcript hides
the later write, or the bytes on disk differ from the latest recorded write; the exact Romanian stale notice is printed by `versions.py status` and prepended to the Markdown of a report that is
already stale when it is written.
usage: python3 -B test_versions_gate.py [-v]"""
import hashlib, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import report, versions
import contract_fixtures as CF
import audit_fixtures as AF

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
CLAIM = "The note says the billing migration ships on Friday."
V1 = "# Handoff\n- alpha\n- beta\n"
EDITS = [("beta", "gamma"), ("alpha", "delta")]   # v2, v3
NOTICE = ("Atenție: acest raport este despre versiunea %d (sha %s); nota are acum o versiune mai nouă, %d (sha %s), pe care acest raport nu o acoperă. "
          "Rulează verificarea din nou pe versiunea curentă.")

def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()
def contents():
    out = [V1]
    for old, new in EDITS: out.append(out[-1].replace(old, new))
    return out

class Session:
    """A synthetic Claude Code transcript: Write v1, a Jev verify call on it, then optional Edit v2/v3 (and unrelated writes)."""
    def __init__(self, d):
        self.d, self.n, self.recs = d, 0, []
        self.handoff = os.path.join(os.path.realpath(d), "HANDOFF.md"); self.log = os.path.join(d, "session.jsonl")
    def _rec(self, typ, msg):
        self.n += 1
        self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:00:%02dZ" % self.n, cwd=self.d, sessionId="s1", message=msg))
    def tool(self, tid, name, inp, result):
        self._rec("assistant", dict(role="assistant", content=[dict(type="tool_use", id=tid, name=name, input=inp)]))
        self._rec("user", dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=result)]))
    def write_v1(self, path=None): self.tool("w1", "Write", dict(file_path=path or self.handoff, content=V1), "File created successfully")
    def edit(self, k): self.tool("w%d" % (k + 2), "Edit", dict(file_path=self.handoff, old_string=EDITS[k][0], new_string=EDITS[k][1]), "The file has been updated successfully")
    def jev(self, tid="c1", compatible_synthetic=False):
        """REALISTIC verify response by default (flat, no same_subject / subject_at, as the inspected server): the check binds and evidences the delivered version (`verified_version`) but stays UNRESOLVED."""
        self.tool(tid, "mcp__jev__jev_verify", dict(claims=[CLAIM], evidence=[dict(text="Friday is the date.")]),
                  CF.verify_body([dict(claim=CLAIM, verdict="verified", confidence=0.99)], compatible_synthetic=compatible_synthetic))
    def save(self, path=None, upto=None):
        path = path or self.log
        with open(path, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs[:upto]))
        return path
    def disk(self, text): open(self.handoff, "w", encoding="utf-8").write(text)
    def doc(self, version, call="c1"):
        v = next(x for x in versions.versions_of(self.log, self.handoff)[0] if x["version"] == version)
        chk = dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=call, result_index=0, key=CLAIM), version_ref=versions.version_ref(v, "session_end"))
        return AF.shell(dict(session=dict(session_id="s1", jsonl=self.log, cwd=self.d), handoff=dict(path=self.handoff, versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS", scope_exclusions=[], audit=dict(version=1, evaluations=[])))   # (the required properties of the schema; a structurally invalid report certifies no delivery)
    def write_report(self, doc, calls=None, name="run"):
        rd = os.path.join(self.d, name); os.makedirs(rd)
        md, js = report.write_report(rd, self.handoff, doc, "Stare: **PASS**\n", calls_jsonl=calls or self.log)
        return open(os.path.join(rd, md), encoding="utf-8").read(), json.load(open(os.path.join(rd, js), encoding="utf-8")), os.path.join(rd, js)

class GateStale(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.s = Session(self.tmp.name); self.c = contents()
    def stale(self, n, m): return NOTICE % (n, sha(self.c[n - 1])[:8], m, sha(self.c[m - 1])[:8])
    def full(self):
        s = self.s; s.write_v1(); s.jev(); s.edit(0); s.edit(1); s.save(); return s

    def test_report_valid_when_written_becomes_stale_when_the_note_changes(self):
        s = self.s; s.write_v1(); s.jev(); s.save(); s.disk(V1)
        md, doc, rpath = s.write_report(s.doc(1))
        self.assertEqual(doc["delivery"]["delivery_state"], "verified_version")   # true at write time: v1 was the latest write
        self.assertNotIn("stale", doc["delivery"]); self.assertNotIn("Atenție", md)
        s.edit(0); s.edit(1); s.save(); s.disk(self.c[2])                           # the note changes afterwards; the stored report is never rewritten
        g = versions.gate(s.log, s.handoff, json.load(open(rpath)), disk_path=s.handoff)
        self.assertEqual(g["delivery_state"], "needs_reverification")
        self.assertEqual(g["stale"], dict(report_version=1, report_sha256=sha(V1), newer_version=3, newer_sha256=sha(self.c[2])))
        self.assertEqual(g["stale_notice"], self.stale(1, 3))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "status", "--session", s.log, "--file", s.handoff, "--report", rpath], capture_output=True, text=True, env=ENV)
        out = json.loads(p.stdout)
        self.assertEqual((p.returncode, out["delivery_state"], out["stale_notice"]), (2, "needs_reverification", self.stale(1, 3)))

    def test_report_written_about_an_older_version_is_stale_in_json_and_markdown(self):
        s = self.full(); s.disk(self.c[2])
        md, doc, _ = s.write_report(s.doc(1))
        self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        self.assertEqual(doc["delivery"]["stale"], dict(report_version=1, report_sha256=sha(V1), newer_version=3, newer_sha256=sha(self.c[2])))
        self.assertTrue(md.startswith(self.stale(1, 3) + "\n"), md[:200])

    def test_strict_prefix_calls_log_cannot_hide_a_later_write(self):
        s = self.full(); prefix = s.save(os.path.join(self.tmp.name, "prefix.jsonl"), upto=4)   # write + call, without v2/v3
        _, _, rpath = s.write_report(s.doc(1), name="full-run")
        rep = json.load(open(rpath))
        for disk, label in ((V1, "disk = v1"), (self.c[2], "disk = v3")):
            s.disk(disk)
            g = versions.gate(prefix, s.handoff, rep, disk_path=s.handoff)
            self.assertNotEqual(g["delivery_state"], "verified_version", label)
            self.assertEqual(g["latest_write_id"], "w3", label)
            self.assertEqual(g["stale"]["report_version"], 1, label); self.assertEqual(g["stale"]["newer_version"], 3, label)
            self.assertEqual(g["stale_notice"], self.stale(1, 3), label)

    def test_write_report_with_a_prefix_calls_log_never_writes_verified_version(self):
        s = self.full(); prefix = s.save(os.path.join(self.tmp.name, "prefix.jsonl"), upto=4); s.disk(V1)
        md, doc, _ = s.write_report(s.doc(1), calls=prefix)
        self.assertNotEqual(doc["delivery"]["delivery_state"], "verified_version")
        self.assertEqual(doc["delivery"]["latest_write_id"], "w3")
        self.assertEqual(doc["delivery"]["stale"]["newer_version"], 3)
        self.assertTrue(md.startswith(self.stale(1, 3)), md[:200])

    def test_bytes_on_disk_different_from_the_latest_write_are_unresolved(self):
        s = self.full(); s.disk(self.c[2] + "- tampered\n")
        g = versions.gate(s.log, s.handoff, s.write_report(s.doc(1))[1], disk_path=s.handoff)
        self.assertEqual(g["delivery_state"], "unresolved")

    def test_latest_version_with_matching_disk_stays_verified(self):
        s = self.s; s.write_v1(); s.edit(0); s.jev(); s.save(); s.disk(self.c[1])
        md, doc, rpath = s.write_report(s.doc(2))
        self.assertEqual(doc["delivery"]["delivery_state"], "verified_version"); self.assertNotIn("stale", doc["delivery"]); self.assertNotIn("Atenție", md)
        g = versions.gate(s.log, s.handoff, json.load(open(rpath)), disk_path=s.handoff)
        self.assertEqual((g["delivery_state"], g.get("stale"), g.get("stale_notice")), ("verified_version", None, None))

    def test_truncated_log_whose_omitted_records_do_not_write_the_handoff_stays_verified(self):
        s = self.s; s.write_v1(); s.jev(); s.tool("o1", "Write", dict(file_path=os.path.join(self.tmp.name, "other.txt"), content="x"), "File created successfully"); s.save(); s.disk(V1)
        prefix = s.save(os.path.join(self.tmp.name, "prefix.jsonl"), upto=4)
        _, _, rpath = s.write_report(s.doc(1))
        g = versions.gate(prefix, s.handoff, json.load(open(rpath)), disk_path=s.handoff)
        self.assertEqual((g["delivery_state"], g.get("stale")), ("verified_version", None))

if __name__ == "__main__": unittest.main()

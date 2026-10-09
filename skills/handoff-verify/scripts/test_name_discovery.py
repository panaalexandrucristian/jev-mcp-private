#!/usr/bin/env python3
"""Offline test of the automatic discovery of handoff notes by NAME (stdlib, no Jev call): the name rule counts only for an established text note (.md / .markdown / .txt, any case, or no extension); a code or data file whose
name matches (test_handoff_flow.py, handoff.json, scripts/handoff-verify-replay.py) is not discovered, stays visible in `excluded_non_text`, and an explicitly selected target of an unsupported kind (`--target`) stays a visible
row with an explanation. Invented fixtures in a temporary directory; the run directory is given with --out.
usage: python3 -B test_name_discovery.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
UNSUPPORTED = ("test_handoff_flow.py", "handoff.json", "scripts/handoff-verify-replay.py", "handover.yml", "HANDOFF.html")
SUPPORTED = ("HANDOFF.md", "handover.txt", "CONTINUE-HERE.markdown", "HANDOFF", "Session-Handoff.MD", "notes/my-handoff.TXT")

def item(path, ok=True): return dict(path=path, success=ok, op="Write", tool_use_id="t-" + path)

class Predicate(unittest.TestCase):
    def test_unsupported_kinds_are_not_discovered_by_name(self):
        c = D.classify_candidates([item("/p/" + n) for n in UNSUPPORTED])
        self.assertEqual(c["included_by_name"], []); self.assertEqual(c["needs_jev_classify"], []); self.assertEqual(sorted(i["path"] for i in c["excluded_non_text"]), sorted("/p/" + n for n in UNSUPPORTED))

    def test_established_text_notes_keep_their_inclusion(self):
        c = D.classify_candidates([item("/p/" + n) for n in SUPPORTED])
        self.assertEqual(sorted(i["path"] for i in c["included_by_name"]), sorted("/p/" + n for n in SUPPORTED)); self.assertEqual(c["excluded_non_text"], [])

    def test_other_dispositions_are_unchanged(self):
        c = D.classify_candidates([item("/p/plan.md"), item("/p/notes.txt"), item("/p/run.py"), item("/p/README"), item("/p/HANDOFF.md", ok=False)])
        self.assertEqual([i["path"] for i in c["needs_jev_classify"]], ["/p/plan.md", "/p/notes.txt"]); self.assertEqual([i["path"] for i in c["excluded_non_text"]], ["/p/run.py", "/p/README"]); self.assertEqual(len(c["failed"]), 1)

    def test_the_name_rule_itself_is_unchanged(self):
        self.assertTrue(D.name_matches("/p/handoff.json")); self.assertTrue(D.is_text_note("/p/HANDOFF")); self.assertTrue(D.is_text_note("/p/a.MD")); self.assertFalse(D.is_text_note("/p/a.py"))

class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.log = os.path.join(self.d, "session.jsonl")

    def tearDown(self): self.t.cleanup()

    def session(self, names):
        recs = [dict(type="user", uuid="u0", timestamp="2026-01-01T00:00:00Z", cwd=self.d, sessionId="s1", message=dict(role="user", content="hello"))]
        for i, n in enumerate(names):
            path = os.path.join(self.d, n); os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "w").write("note %d\n" % i)
            recs.append(dict(type="assistant", uuid="a%d" % i, timestamp="2026-01-01T00:01:%02dZ" % (2 * i), cwd=self.d, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="w%d" % i, name="Write", input=dict(file_path=path, content="note %d\n" % i))])))
            recs.append(dict(type="user", uuid="r%d" % i, timestamp="2026-01-01T00:01:%02dZ" % (2 * i + 1), cwd=self.d, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w%d" % i, content="File created successfully at: " + path)])))
        open(self.log, "w").write("".join(json.dumps(r) + "\n" for r in recs))

    def prepare(self, *extra):
        out = os.path.join(self.d, "work%d" % len(os.listdir(self.d)))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), self.log, "--cwd", self.d, "--out", out] + list(extra), capture_output=True, text=True, env=ENV)
        self.assertIn(p.returncode, (0,), p.stdout + p.stderr); return json.load(open(os.path.join(out, "inventory.json")))

    def test_inventory_excludes_the_code_and_data_files_but_lists_them(self):
        self.session(list(UNSUPPORTED) + list(SUPPORTED)); inv = self.prepare()
        self.assertEqual(sorted(os.path.relpath(h["path"], self.d) for h in inv["handoffs"]), sorted(SUPPORTED))
        self.assertTrue(all(h["disposition"] == "included_by_name" for h in inv["handoffs"]))
        self.assertEqual(sorted(os.path.relpath(p, self.d) for p in inv["excluded_non_text"]), sorted(UNSUPPORTED))
        self.assertEqual(inv["needs_jev_classify"], [])

    def test_an_explicit_target_of_an_unsupported_kind_stays_visible_with_an_explanation(self):
        self.session(["handoff.json", "HANDOFF.md"]); inv = self.prepare("--target", os.path.join(self.d, "handoff.json"))
        row = next(h for h in inv["handoffs"] if h["path"].endswith("handoff.json"))
        self.assertEqual(row["disposition"], "included_by_target"); self.assertTrue(row["versions"]); self.assertIn("established text-note", row["explanation"])
        self.assertNotIn("explanation", next(h for h in inv["handoffs"] if h["path"].endswith("HANDOFF.md")))

    def test_an_explicit_unlinked_target_of_an_unsupported_kind_is_visible_too(self):
        self.session(["HANDOFF.md"]); other = os.path.join(self.d, "elsewhere-handoff.json"); open(other, "w").write("{}\n"); inv = self.prepare("--target", other)
        row = next(h for h in inv["handoffs"] if h["path"].endswith("elsewhere-handoff.json"))
        self.assertEqual((row["disposition"], row["versions"]), ("external_unlinked", [])); self.assertIn("established text-note", row["explanation"]); self.assertTrue(row["blockers"])

    def test_a_supported_explicit_target_has_no_explanation(self):
        self.session(["plan.md"]); inv = self.prepare("--target", os.path.join(self.d, "plan.md"))
        row = next(h for h in inv["handoffs"] if h["path"].endswith("plan.md")); self.assertTrue(row["versions"]); self.assertNotIn("explanation", row)

if __name__ == "__main__": unittest.main()

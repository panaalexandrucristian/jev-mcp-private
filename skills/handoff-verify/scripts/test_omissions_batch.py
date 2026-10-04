#!/usr/bin/env python3
"""Offline test of `omissions.py prepare-batch` (stdlib only, no Jev call): on a synthetic session written to a temp dir, element i of one
batch must be byte-identical to what the single `prepare` prints for the same arguments (ok and error items, two handoffs and both
evaluation modes in ONE batch), the exit code must be 3 iff an element is not ok, and malformed specs must be refused.
usage: python3 -B test_omissions_batch.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "omissions.py")
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
USER_TEXT = "Goal: ship the billing migration by Friday. Do NOT change the public API of billing. Never run migrate.sh against prod."
NOTES = {"HANDOFF.md": "- Goal: ship the billing migration by Friday.\n", "HANDOVER-2.md": "- Never run migrate.sh against prod.\n"}

def run(args, cwd):
    p = subprocess.run([sys.executable, "-B", SCRIPT] + args, cwd=cwd, capture_output=True, text=True, env=ENV)
    return p.returncode, p.stdout

class PrepareBatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(); d = cls.dir = cls.tmp.name
        recs = [dict(type="user", uuid="u1", timestamp="2026-01-01T00:00:00Z", cwd=d, sessionId="s1", message=dict(role="user", content=USER_TEXT))]
        for i, (name, text) in enumerate(NOTES.items()):
            path = os.path.join(d, name); open(path, "w", encoding="utf-8").write(text)
            recs.append(dict(type="assistant", uuid="a%d" % i, timestamp="2026-01-01T00:00:%02dZ" % (2 * i + 1), cwd=d, sessionId="s1",
                             message=dict(role="assistant", content=[dict(type="tool_use", id="w%d" % i, name="Write", input=dict(file_path=path, content=text))])))
            recs.append(dict(type="user", uuid="r%d" % i, timestamp="2026-01-01T00:00:%02dZ" % (2 * i + 2), cwd=d, sessionId="s1",
                             message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w%d" % i, content="File created successfully at: " + path)])))
        open(os.path.join(d, "session.jsonl"), "w", encoding="utf-8").write("".join(json.dumps(r) + "\n" for r in recs))

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def batch(self, items, flags=()):
        spec = os.path.join(self.dir, "spec.json"); json.dump(items, open(spec, "w", encoding="utf-8"), ensure_ascii=False)
        try: return run(["prepare-batch", "--spec", spec] + list(flags), self.dir)
        finally: os.unlink(spec)

    def single(self, it):
        return run(["prepare", "--source", it["source"], "--file", it["file"], "--write-id", it["write_id"],
                    "--evaluated-against", it["evaluated_against"], "--detail", it["detail"], "--source-quote", it["source_quote"]], self.dir)

    def assert_equal_to_single(self, items):
        items = [dict(it, source=it.get("source", "session.jsonl")) for it in items]   # the same arguments as the single call
        code, out = self.batch(items); arr = json.loads(out)
        self.assertEqual(len(arr), len(items))
        codes = []
        for it, el in zip(items, arr):
            scode, sout = self.single(it); codes.append(scode)
            self.assertEqual(json.dumps(el, indent=1, ensure_ascii=False), sout.strip(), "element differs from single prepare for %r" % it["detail"])
            self.assertEqual(el.get("ok"), scode == 0)
        self.assertEqual(code, 3 if any(codes) else 0)
        return arr

    def test_ok_items_across_two_handoffs_and_both_modes(self):
        q = "Do NOT change the public API of billing."
        arr = self.assert_equal_to_single([
            dict(file="HANDOFF.md", write_id="w0", evaluated_against="prefix", detail=q, source_quote=q),
            dict(file="HANDOVER-2.md", write_id="w1", evaluated_against="prefix", detail=q, source_quote=q),
            dict(file="HANDOFF.md", write_id="w0", evaluated_against="session_end", detail=q, source_quote=q)])
        self.assertTrue(all(el["ok"] for el in arr))
        self.assertEqual({el["version_ref"]["write_tool_use_id"] for el in arr}, {"w0", "w1"})

    def test_error_items_match_single_and_exit_3(self):
        q = "Do NOT change the public API of billing."
        base = dict(file="HANDOFF.md", write_id="w0", evaluated_against="prefix")
        arr = self.assert_equal_to_single([
            dict(base, detail=q, source_quote=q),
            dict(base, write_id="w_missing", detail=q, source_quote=q),
            dict(base, detail=q, source_quote="This quote is not in the transcript."),
            dict(base, detail="   ", source_quote=q),
            dict(base, detail="The supplied source passage states this detail: " + q, source_quote=q),
            dict(base, file="NOPE.md", detail=q, source_quote=q)])
        self.assertEqual([el["ok"] for el in arr], [True, False, False, False, False, False])

    def test_command_line_flags_are_defaults(self):
        q = "Never run migrate.sh against prod."
        code, out = self.batch([dict(detail=q, source_quote=q), dict(detail=q, source_quote=q, file="HANDOFF.md", write_id="w0")],
                               ["--source", "session.jsonl", "--file", "HANDOVER-2.md", "--write-id", "w1", "--evaluated-against", "prefix"])
        arr = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual([el["version_ref"]["write_tool_use_id"] for el in arr], ["w1", "w0"])
        self.assertEqual(json.dumps(arr[0], indent=1, ensure_ascii=False),
                         self.single(dict(source="session.jsonl", file="HANDOVER-2.md", write_id="w1", evaluated_against="prefix", detail=q, source_quote=q))[1].strip())

    def test_malformed_specs_are_refused(self):
        full = dict(file="HANDOFF.md", write_id="w0", evaluated_against="prefix")
        for items, reason in [([], "non-empty list"), ({"candidates": []}, "non-empty list"),
                              ([dict(detail=1, source_quote="x")], "must be strings"),
                              ([dict(detail="a", source_quote="b")], "are required"),
                              ([dict(full, detail="a", source_quote="b", extra=1)], "unknown keys"),
                              ([dict(full, evaluated_against="later", detail="a", source_quote="b")], "evaluated_against must be one of")]:
            code, out = self.batch(items)
            self.assertEqual(code, 3, items); self.assertFalse(json.loads(out)["ok"]); self.assertIn(reason, json.loads(out)["reasons"][0])
        code, out = run(["prepare-batch", "--spec", os.path.join(self.dir, "missing.json")], self.dir)
        self.assertEqual(code, 3); self.assertIn("spec unreadable", json.loads(out)["reasons"][0])

if __name__ == "__main__": unittest.main()

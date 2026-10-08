#!/usr/bin/env python3
"""Offline test of the shared version reconstruction (item 13) and of the artifact names (item 7), stdlib only, no Jev call, never reads .handoff-verify/:
 - `versions.reconstruct_stream` is the ONE reconstruction behind `versions_of`, `replay_all` and `prepare.py`; a demonstrably complete Read refreshes the base of the NEXT mutation of the path (even when a base
   exists), never rewrites an earlier version, and only when its result came after the previous mutation's result and before the dependent mutation's tool_use; late, partial, offset/limit, error,
   unstructured and position-less Reads give no base;
 - a path written in more than one stream (session + subagents) has no demonstrated common order: bytes of full Writes stay, the combined history and the ordering-dependent windows are unresolved, per-stream
   prefixes never use a merged timestamp sort; child-only versions are the child's, not the parent's;
 - `prepare.py` names its artifacts `handoffs/<basename>-<hash8 of the real path>.v<N>.md` (report_names rule), never overwrites one, groups aliases, and keeps same-numbered versions of different streams apart.
All fixtures are invented.
usage: python3 -B test_stream_reconstruction.py [-v]"""
import contextlib, hashlib, io, json, os, re, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, prepare, report, slice as SL, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

class Tx:
    """A synthetic Claude Code transcript; `parallel` puts several tool_use blocks in one record before their results."""
    def __init__(self, cwd, stamp=True):
        self.cwd, self.n, self.recs, self.stamp = cwd, 0, [], stamp
    def rec(self, typ, content, **extra):
        self.n += 1; r = dict(type=typ, uuid="u%d" % self.n, cwd=self.cwd, sessionId="s1", message=dict(role=typ, content=content), **extra)
        if self.stamp: r["timestamp"] = "2026-01-01T00:00:%02dZ" % self.n
        self.recs.append(r)
    def use(self, tid, name, inp): self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)])
    def result(self, tid, text="ok", error=False, structured=None):
        extra = {"toolUseResult": structured} if structured is not None else {}
        self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=text, **({"is_error": True} if error else {}))], **extra)
    def tool(self, tid, name, inp, text="ok", **kw): self.use(tid, name, inp); self.result(tid, text, **kw)
    def write(self, tid, path, content): self.tool(tid, "Write", dict(file_path=path, content=content), "File created successfully")
    def edit(self, tid, path, old, new): self.tool(tid, "Edit", dict(file_path=path, old_string=old, new_string=new), "edited")
    def read(self, tid, path, content, **kw): self.tool(tid, "Read", dict(file_path=path), "cat -n", structured=full(path, content), **kw)
    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f: f.write("".join(json.dumps(r) + "\n" for r in self.recs))
        return path

def full(path, content):
    n = len(content.splitlines())
    return dict(type="text", file=dict(filePath=path, content=content, startLine=1, numLines=n, totalLines=n))

class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.addCleanup(self.t.cleanup)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "s.jsonl")
    def prepare(self, *argv, session=None):
        out = io.StringIO(); work = os.path.join(self.d, "work%d" % len(os.listdir(self.d)))
        old = sys.argv; sys.argv = ["prepare.py", session or self.log, "--cwd", self.d, "--out", work, *argv]
        try:
            with contextlib.redirect_stdout(out): code = prepare.main()
        finally: sys.argv = old
        return code, json.loads(out.getvalue()), work
    def inventory(self, work): return json.load(open(os.path.join(work, "inventory.json")))
    def vrows(self, inv, real=None): return next(h for h in inv["handoffs"] if real is None or h["path"] == real)["versions"]

class Reads(Base):
    A, B, X = "alpha beta", "alpha external beta", "alpha external gamma"
    def three(self, build):
        t = Tx(self.d); t.write("w1", self.note, self.A); build(t); t.edit("e1", self.note, "beta", "gamma"); t.save(self.log); return t
    def contents(self):
        vs = versions.versions_of(self.log, self.note)[0]; return [v["content"] for v in vs], vs
    def agree(self, expected):
        got, vs = self.contents(); self.assertEqual(got, expected)
        rep = versions.replay_all(self.log); self.assertEqual([rep[v["write_tool_use_id"]][0] for v in vs], expected)
        code, out, work = self.prepare(); self.assertEqual(code, 0)
        rows = self.vrows(self.inventory(work)); self.assertEqual([r["sha256"] for r in rows], [sha(c) if c is not None else None for c in expected])
        for r, c in zip(rows, expected):
            if c is not None: self.assertEqual(open(os.path.join(work, r["file"]), encoding="utf-8").read(), c)

    def test_a_complete_read_between_write_and_edit_refreshes_the_base_in_prepare_versions_of_and_replay_all(self):
        self.three(lambda t: t.read("r1", self.note, self.B)); self.agree([self.A, self.X])
        self.assertEqual(self.contents()[0][0], self.A)                       # v1 is not rewritten

    def test_reads_that_are_not_demonstrably_a_base_are_ignored(self):
        def late(t):          # the Read is issued before the edit but its RESULT comes after the edit's tool_use
            t.use("r1", "Read", dict(file_path=self.note)); t.use("e1", "Edit", dict(file_path=self.note, old_string="beta", new_string="gamma")); t.result("r1", "cat -n", structured=full(self.note, self.B)); t.result("e1", "edited")
        t = Tx(self.d); t.write("w1", self.note, self.A); late(t); t.save(self.log); self.agree([self.A, "alpha gamma"])
        cases = {"partial": lambda t: t.tool("r1", "Read", dict(file_path=self.note, offset=2), "cat -n", structured=full(self.note, self.B)),
                 "limit": lambda t: t.tool("r1", "Read", dict(file_path=self.note, limit=1), "cat -n", structured=full(self.note, self.B)),
                 "unstructured": lambda t: t.tool("r1", "Read", dict(file_path=self.note), "     1\t" + self.B),
                 "error": lambda t: t.tool("r1", "Read", dict(file_path=self.note), "boom", error=True, structured=full(self.note, self.B)),
                 "truncated structure": lambda t: t.tool("r1", "Read", dict(file_path=self.note), "cat -n", structured=dict(type="text", file=dict(filePath=self.note, content=self.B, startLine=1, numLines=1, totalLines=5))),
                 "another path": lambda t: t.read("r1", os.path.join(self.d, "other.md"), self.B)}
        for name, build in cases.items():
            with self.subTest(name): self.three(build); self.agree([self.A, "alpha gamma"])
        # a Read whose result came before the PREVIOUS mutation's result is stale for the next one
        t = Tx(self.d); t.use("w1", "Write", dict(file_path=self.note, content=self.A)); t.read("r1", self.note, self.B); t.result("w1", "File created successfully"); t.edit("e1", self.note, "beta", "gamma"); t.save(self.log)
        self.agree([self.A, "alpha gamma"])

    def test_position_less_reads_give_no_base_and_positioned_ones_do_in_slice_reconstruct(self):
        items = [dict(tool_use_id="w1", uuid="1", index=1, pos=1, result_pos=2, op="Write", content=self.A, success=True), dict(tool_use_id="e1", uuid="2", index=3, pos=5, result_pos=6, op="Edit", old_string="beta", new_string="gamma", replace_all=False, success=True)]
        rd = dict(index=2, path="/p", content=self.B, complete=True)
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [rd])], [self.A, "alpha gamma"])
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=3, result_pos=4)])], [self.A, self.X])
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=3, result_pos=5)])], [self.A, "alpha gamma"])      # result_pos == the edit's pos: not before it
        self.assertEqual([v["content"] for v in SL.reconstruct(items, [dict(rd, pos=3, result_pos=2)])], [self.A, "alpha gamma"])      # not after the previous mutation's result

    def test_a_read_before_any_write_is_the_base_of_the_first_edit(self):
        t = Tx(self.d); t.read("r1", self.note, self.B); t.edit("e1", self.note, "beta", "gamma"); t.save(self.log); self.agree([self.X])

    def test_complete_material_stays_byte_identical(self):
        t = Tx(self.d); t.write("w1", self.note, self.A); t.edit("e1", self.note, "beta", "gamma"); t.save(self.log); self.agree([self.A, "alpha gamma"])

class Streams(Base):
    def setUp(self):
        super().setUp(); self.sub = os.path.join(self.d, "s", "subagents", "agent-1.jsonl")
    def parent(self, content, stamp=False):
        t = Tx(self.d, stamp=stamp); t.write("pw1", self.note, content); t.save(self.log); return t
    def child(self, *writes, stamp=False):
        t = Tx(self.d, stamp=stamp)
        for tid, content in writes: t.write(tid, self.note, content)
        t.save(self.sub); return t

    def test_the_same_path_in_two_streams_has_no_common_order_but_keeps_each_full_write(self):
        self.parent("PARENT-CONTENT\n"); self.child(("cw1", "CHILD-CONTENT\n"))
        code, out, work = self.prepare(); self.assertEqual(code, 0)
        inv = self.inventory(work); h = inv["handoffs"][0]; rows = h["versions"]
        self.assertEqual(len(rows), 2); self.assertEqual({r["source_kind"] for r in rows}, {"session", "subagent"}); self.assertEqual({r["sha256"] for r in rows}, {sha("PARENT-CONTENT\n"), sha("CHILD-CONTENT\n")})
        self.assertEqual({r["source_file"] for r in rows}, {self.log, self.sub})
        for r in rows: self.assertEqual(r["status"], "ok"); self.assertIsNone(r["evaluated_against"]); self.assertEqual(open(os.path.join(work, r["file"]), encoding="utf-8").read(), "PARENT-CONTENT\n" if r["source_kind"] == "session" else "CHILD-CONTENT\n")
        self.assertEqual(len({r["file"] for r in rows}), 2)                     # same-numbered local versions, different artifacts
        self.assertIn("several streams", " ".join(h["blockers"])); self.assertFalse(h["ordering"]["demonstrated"]); self.assertTrue(out["blockers"])

    def test_an_edit_never_borrows_its_base_from_another_stream(self):
        self.parent("PARENT base\n"); t = Tx(self.d, stamp=False); t.edit("ce1", self.note, "base", "edited"); t.save(self.sub)
        code, out, work = self.prepare(); rows = self.vrows(self.inventory(work))
        child = [r for r in rows if r["source_kind"] == "subagent"]; self.assertEqual([r["status"] for r in child], ["content not recoverable"]); self.assertIsNone(child[0]["sha256"])
        parent = [r for r in rows if r["source_kind"] == "session"]; self.assertEqual(parent[0]["sha256"], sha("PARENT base\n"))
        self.assertTrue(all(r["evaluated_against"] is None for r in rows))

    def test_per_stream_prefix_ignores_the_other_stream_and_the_merged_timestamp_sort(self):
        t = Tx(self.d); t.n = 0
        for i in range(3): t.rec("user", "parent chatter %d" % i)
        t.write("pw1", self.note, "P\n"); t.save(self.log)
        c = Tx(self.d); c.n = 40                                                   # child timestamps later than every parent one
        c.rec("user", "child chatter"); c.write("cw1", self.note, "C\n"); c.save(self.sub)
        code, out, work = self.prepare(); rows = {r["source_kind"]: r for r in self.vrows(self.inventory(work))}
        self.assertEqual(rows["session"]["prefix_records"], 3); self.assertEqual(rows["subagent"]["prefix_records"], 1)

    def test_child_only_versions_belong_to_the_child_transcript(self):
        Tx(self.d, stamp=False).save(self.log); self.child(("cw1", "CHILD\n"))
        code, out, work = self.prepare(); h = self.inventory(work)["handoffs"][0]
        self.assertEqual([r["source_kind"] for r in h["versions"]], ["subagent"]); self.assertIn("subagent", " ".join(h["blockers"]))
        self.assertEqual(versions.versions_of(self.log, self.note)[0], [])        # not attributed to the parent session
        code2, out2, work2 = self.prepare(session=self.sub); h2 = self.inventory(work2)["handoffs"][0]
        self.assertEqual([(r["source_kind"], r["evaluated_against"]) for r in h2["versions"]], [("session", "session_end")]); self.assertFalse(h2.get("blockers"))
        self.assertEqual([v["content"] for v in versions.versions_of(self.sub, self.note)[0]], ["CHILD\n"])

    def test_different_paths_in_different_streams_stay_independent(self):
        other = os.path.join(self.d, "CONTINUE-HERE.md"); self.parent("P\n"); t = Tx(self.d, stamp=False); t.write("cw1", other, "C\n"); t.save(self.sub)
        code, out, work = self.prepare(); hs = {h["path"]: h for h in self.inventory(work)["handoffs"]}
        self.assertEqual([r["evaluated_against"] for r in hs[self.note]["versions"]], ["session_end"]); self.assertEqual([r["evaluated_against"] for r in hs[other]["versions"]], ["session_end"])
        self.assertFalse(hs[self.note].get("blockers"))

class Names(Base):
    PAT = r"^handoffs/%s-[0-9a-f]{8}\.v1\.md$"
    def test_two_notes_with_the_same_basename_get_distinct_artifacts_with_their_own_content(self):
        pa, pb = (os.path.join(self.d, x, "CONTINUE-HERE.md") for x in "ab"); t = Tx(self.d, stamp=False); t.write("w1", pa, "CONTENT-A\n"); t.write("w2", pb, "CONTENT-B\n"); t.save(self.log)
        code, out, work = self.prepare(); hs = {h["path"]: h for h in self.inventory(work)["handoffs"]}
        fa, fb = hs[pa]["versions"][0], hs[pb]["versions"][0]
        self.assertRegex(fa["file"], self.PAT % re.escape("CONTINUE-HERE.md")); self.assertNotEqual(fa["file"], fb["file"])
        self.assertEqual(fa["file"], "handoffs/CONTINUE-HERE.md-%s.v1.md" % report.short_hash(pa))
        self.assertEqual(open(os.path.join(work, fa["file"])).read(), "CONTENT-A\n"); self.assertEqual(open(os.path.join(work, fb["file"])).read(), "CONTENT-B\n")
        self.assertEqual((fa["sha256"], fb["sha256"]), (sha("CONTENT-A\n"), sha("CONTENT-B\n")))

    def test_aliases_of_one_real_path_share_one_group_and_one_name(self):
        os.makedirs(os.path.join(self.d, "a")); real = os.path.join(self.d, "a", "HANDOFF.md"); alias = os.path.join(self.d, "alias.md"); open(real, "w").write("x"); os.symlink(real, alias)
        t = Tx(self.d, stamp=False); t.write("w1", real, "ONE\n"); t.write("w2", alias, "TWO\n"); t.save(self.log)
        code, out, work = self.prepare(); inv = self.inventory(work); self.assertEqual(len(inv["handoffs"]), 1); rows = inv["handoffs"][0]["versions"]
        self.assertEqual(len(rows), 2); self.assertEqual([r["file"] for r in rows], ["handoffs/HANDOFF.md-%s.v1.md" % report.short_hash(real), "handoffs/HANDOFF.md-%s.v2.md" % report.short_hash(real)])
        self.assertEqual(inv["handoffs"][0]["aliases"], [alias])

    def test_a_forced_hash_prefix_collision_is_disambiguated_by_the_report_names_rule(self):
        pa, pb = (os.path.join(self.d, x, "CONTINUE-HERE.md") for x in "ab"); t = Tx(self.d, stamp=False); t.write("w1", pa, "A\n"); t.write("w2", pb, "B\n"); t.save(self.log)
        real = report.short_hash
        report.short_hash = lambda path, extra=0: "aaaaaaaa" + hashlib.sha256(os.path.realpath(path).encode()).hexdigest()[:extra]       # every 8-hex prefix collides
        try: code, out, work = self.prepare()
        finally: report.short_hash = real
        files = [r["file"] for h in self.inventory(work)["handoffs"] for r in h["versions"]]
        self.assertEqual(len(set(files)), 2); self.assertEqual(sorted(os.listdir(os.path.join(work, "handoffs"))), sorted(os.path.basename(f) for f in files))
        self.assertEqual(sorted(open(os.path.join(work, f)).read() for f in files), ["A\n", "B\n"])

    def test_the_name_ignores_the_working_directory_of_the_process(self):
        t = Tx(self.d, stamp=False); t.write("w1", self.note, "X\n"); t.save(self.log)
        old = os.getcwd(); os.chdir(tempfile.gettempdir())
        try: code, out, work = self.prepare()
        finally: os.chdir(old)
        self.assertEqual(self.vrows(self.inventory(work))[0]["file"], "handoffs/HANDOFF.md-%s.v1.md" % report.short_hash(self.note))

if __name__ == "__main__": unittest.main()

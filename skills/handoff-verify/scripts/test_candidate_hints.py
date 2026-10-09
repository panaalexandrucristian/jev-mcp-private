#!/usr/bin/env python3
"""Offline test of the candidate assistance of `omissions.py prepare` (stdlib + git, no Jev call): the occurrence hints point at exact ELIGIBLE records and exact material locations and are navigation only (a literal
match never clears a candidate: superseded, negated, quoted and case-different assertions keep the full ABSENCE-first plan), the per-version preparation is reused within a run with content-backed identities
(a changed transcript, version, reference or reference resolution invalidates exactly what depends on it, also when size and mtime are unchanged), cached results cannot be corrupted by a caller, and a batch can
come from stdin. Counts only: the number of reconstructions / source indexes is read from `omissions.STATS`.
usage: python3 -B test_candidate_hints.py [-v]"""
import argparse, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions as O, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
STALE = "Old, superseded assertion: The latest commit is abc1234"
NEG = "The latest commit is NOT abc1234, it was reverted"
QUOTATION = 'He said "abc1234" was the one'
UPPER = "see ABC1234 for the old build"

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f: f.write(text)

def rec(kind, uuid, content, i, cwd):
    return dict(type=kind, uuid=uuid, timestamp="2026-01-01T00:00:%02dZ" % i, cwd=cwd, sessionId="s1", message=dict(role=kind, content=content))

def tool(i, cwd, name, inp, result, ts=0):
    return [rec("assistant", "ta%d" % i, [dict(type="tool_use", id="t%d" % i, name=name, input=inp)], 10 + ts, cwd),
            rec("user", "tr%d" % i, [dict(type="tool_result", tool_use_id="t%d" % i, content=result)], 11 + ts, cwd)]

class Base(unittest.TestCase):
    NOTE_TEXT = "- the latest commit is abc1234\n"

    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); self.cwd0 = os.getcwd()
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "session.jsonl"); O.reset_caches()

    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def build(self, user_texts, note=None, after=(), extra_before=(), note_text=None):
        d = self.d; note_text = self.NOTE_TEXT if note_text is None else note_text; write(self.note, note_text)
        recs = [rec("user", "u%d" % i, t, i, d) for i, t in enumerate(user_texts)] + list(extra_before)
        recs += [rec("assistant", "aw", [dict(type="tool_use", id="w0", name="Write", input=dict(file_path=self.note, content=note_text))], 30, d),
                 rec("user", "rw", [dict(type="tool_result", tool_use_id="w0", content="File created successfully at: " + self.note)], 31, d)] + list(after)
        write(self.log, "".join(json.dumps(r) + "\n" for r in recs)); self.recs = recs

    def args(self, detail, quote, ea="prefix", **kw):
        return argparse.Namespace(source=self.log, file=self.note, write_id="w0", evaluated_against=ea, detail=detail, source_quote=quote, cwd=self.d, location=[], run=None, **kw)

    def prep(self, detail, quote, ea="prefix"):
        obj, code = O.prepare_one(self.args(detail, quote, ea)); return obj, code

class Hints(Base):
    def test_hints_point_at_exact_eligible_records_and_never_change_the_plan(self):
        self.build(["intro", STALE, NEG, QUOTATION, UPPER])
        o, code = self.prep("The latest commit is abc1234", STALE); self.assertEqual(code, 0, o)
        h = o["hints"]; self.assertTrue(h["navigation_only"]); self.assertIn("never clears", h["note"])
        self.assertIn("abc1234", h["identifiers"])
        exact = [r for r in h["source_records"] if r["identifier"] == "abc1234" and r["case_sensitive"]]
        lines = sorted(r["line"] for r in exact); self.assertEqual(lines, [2, 3, 4])                    # the stale, the negated and the quoted assertion: JSONL lines of the records
        folded = [r for r in h["source_records"] if r["identifier"] == "abc1234" and not r["case_sensitive"]]
        self.assertEqual([r["line"] for r in folded], [5])                                               # ABC1234: a case-insensitive navigation match, kept apart
        for r in exact + folded:
            self.assertEqual(r["kind"], "text"); self.assertIn(r["line"] - 1, range(len(self.recs))); self.assertEqual(r["uuid"], "u%d" % (r["line"] - 1)); self.assertTrue(r["offsets"])
        self.assertEqual(h["source"], os.path.realpath(self.log))
        self.assertEqual(O.plan_absence(None)["disposition"], "call_absence")                           # the plan is the full ABSENCE-first one, whatever the hints say
        self.assertEqual(o["source_passage"], STALE); self.assertEqual(o["absence_claim"], "The latest commit is abc1234"); self.assertTrue(o["ok"])
        self.assertEqual(h["quote_block_index"], next(r["block_index"] for r in exact if r["line"] == 2))

    def test_hints_change_nothing_else_in_the_output(self):
        self.build(["intro", STALE])
        o, _ = self.prep("The latest commit is abc1234", STALE); h = o.pop("hints")
        sc, ac = O.claims("The latest commit is abc1234")
        self.assertEqual((o["source_claim"], o["absence_claim"], o["material"]), (sc, ac, O.material(self.NOTE_TEXT)))

    def test_ineligible_records_get_no_hints(self):
        jev = tool(1, self.d, "mcp__jev__jev_verify", {"claims": ["abc1234 is current"], "evidence": ["abc1234"]}, "{\"results\": [\"abc1234\"]}")
        self.build(["intro", STALE], extra_before=jev, after=[rec("user", "late", "after the write abc1234", 40, self.d)])
        o, code = self.prep("The latest commit is abc1234", STALE); self.assertEqual(code, 0, o)
        lines = {r["line"] for r in o["hints"]["source_records"]}
        jev_lines = {i + 1 for i, r in enumerate(self.recs) if "jev_verify" in json.dumps(r) or r["uuid"] in ("tr1",)}
        late = {i + 1 for i, r in enumerate(self.recs) if r["uuid"] == "late"}; own_write = {i + 1 for i, r in enumerate(self.recs) if r["uuid"] in ("aw", "rw")}
        self.assertFalse(lines & (jev_lines | late | own_write), (lines, jev_lines, late, own_write))
        self.assertIn(2, lines)

    def test_material_matches_name_the_section_and_location(self):
        write(os.path.join(self.d, "ref.md"), "first line\nthe build abc1234 here\n")
        self.build(["intro", STALE], note_text="- the latest commit is abc1234\n- see `ref.md`\n")
        o, code = self.prep("The latest commit is abc1234", STALE); self.assertEqual(code, 0, o)
        mm = [m for m in o["hints"]["material_matches"] if m["identifier"] == "abc1234"]
        self.assertEqual([(m["section"], m["ref"], m["line"]) for m in mm], [("note", None, 1), ("reference", "ref.md", 2)])
        self.assertTrue(all(m["case_sensitive"] for m in mm)); self.assertEqual(mm[1]["column"], 11)

    def test_request_hints_keep_the_request_provenance(self):
        self.build(["intro", STALE])
        o, _ = self.prep("The latest commit is abc1234", STALE)
        rq = [r for r in o["hints"]["requests"] if r["identifier"] == "abc1234"]
        self.assertEqual([r["request_index"] for r in rq], [2])

    def test_caps_are_reported_as_truncation_never_as_completeness(self):
        self.build(["intro"] + ["abc1234 mention %d" % i for i in range(9)] + [STALE])
        o, _ = self.prep("The latest commit is abc1234", STALE); h = o["hints"]
        listed = [r for r in h["source_records"] if r["identifier"] == "abc1234" and r["case_sensitive"]]
        self.assertEqual(len(listed), O.HINT_CAP); self.assertEqual(h["truncated"]["abc1234"], 10 - O.HINT_CAP)
        self.assertIn("never", h["limits"])

class Reuse(Base):
    def test_one_version_is_prepared_once_for_many_candidates(self):
        self.build(["intro", STALE, NEG])
        for q in (STALE, NEG, STALE): self.assertEqual(self.prep("The latest commit is abc1234", q)[1], 0)
        self.assertEqual((O.STATS["session_prep_builds"], O.STATS["source_index_builds"]), (1, 1))
        self.assertEqual((O.STATS["session_prep_hits"], O.STATS["source_index_hits"]), (2, 2))

    def test_reused_output_is_byte_identical_to_a_cold_one(self):
        self.build(["intro", STALE, NEG])
        warm = [self.prep("The latest commit is abc1234", q)[0] for q in (STALE, NEG, STALE)]
        cold = []
        for q in (STALE, NEG, STALE): O.reset_caches(); cold.append(self.prep("The latest commit is abc1234", q)[0])
        self.assertEqual(json.dumps(warm, sort_keys=True), json.dumps(cold, sort_keys=True))

    def test_same_size_same_mtime_transcript_change_invalidates(self):
        self.build(["intro", "alpha one", STALE]); self.assertEqual(self.prep("alpha", "alpha one")[1], 0)
        st = os.stat(self.log); raw = open(self.log, "rb").read(); self.assertIn(b"alpha one", raw)
        open(self.log, "wb").write(raw.replace(b"alpha one", b"omega two")); os.utime(self.log, ns=(st.st_atime_ns, st.st_mtime_ns)); self.assertEqual(os.stat(self.log).st_size, st.st_size)
        o, code = self.prep("alpha", "alpha one"); self.assertEqual(code, 3); self.assertIn("quote", o["reasons"][0])
        self.assertEqual(self.prep("omega", "omega two")[1], 0); self.assertEqual(O.STATS["source_index_builds"], 2)

    def test_changed_reference_content_invalidates_the_material(self):
        ref = os.path.join(self.d, "ref.md"); write(ref, "version AAAA\n")
        self.build(["intro", STALE], note_text="- see `ref.md`\n")
        m1 = self.prep("The latest commit is abc1234", STALE)[0]["material"]
        st = os.stat(ref); write(ref, "version BBBB\n"); os.utime(ref, ns=(st.st_atime_ns, st.st_mtime_ns))
        m2 = self.prep("The latest commit is abc1234", STALE)[0]["material"]
        self.assertIn("AAAA", m1); self.assertIn("BBBB", m2); self.assertNotEqual(m1, m2)
        os.remove(ref); o, code = self.prep("The latest commit is abc1234", STALE); self.assertEqual(code, 3); self.assertIn("cannot be resolved", o["reasons"][0])
        write(ref, "version AAAA\n"); self.assertEqual(self.prep("The latest commit is abc1234", STALE)[0]["material"], m1)   # a previously unavailable reference becoming available

    def test_symlink_retargeting_invalidates(self):
        write(os.path.join(self.d, "one.md"), "target ONE\n"); write(os.path.join(self.d, "two.md"), "target TWO\n")
        link = os.path.join(self.d, "ref.md"); os.symlink("one.md", link)
        self.build(["intro", STALE], note_text="- see `ref.md`\n")
        self.assertIn("target ONE", self.prep("The latest commit is abc1234", STALE)[0]["material"])
        os.remove(link); os.symlink("two.md", link)
        self.assertIn("target TWO", self.prep("The latest commit is abc1234", STALE)[0]["material"])

    def test_competing_tracked_names_appear_and_disappear(self):
        repo = os.path.join(self.d, "repo"); write(os.path.join(repo, "a", "SKILL.md"), "skill A\n")
        run = lambda *c: subprocess.run(["git", "-C", repo] + list(c), capture_output=True, check=True, env=dict(ENV, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t"))
        run("init", "-q"); run("add", ".");
        self.note = os.path.join(repo, "HANDOFF.md"); self.build(["intro", STALE], note_text="- see `SKILL.md`\n")
        self.assertIn("skill A", self.prep("The latest commit is abc1234", STALE)[0]["material"])
        write(os.path.join(repo, "b", "SKILL.md"), "skill B\n"); run("add", ".")
        o, code = self.prep("The latest commit is abc1234", STALE); self.assertEqual(code, 3); self.assertIn("2 tracked files", o["reasons"][0])
        run("rm", "-q", "-f", "b/SKILL.md")
        self.assertIn("skill A", self.prep("The latest commit is abc1234", STALE)[0]["material"])

    def test_cached_results_cannot_be_corrupted_by_a_caller(self):
        self.build(["intro", STALE])
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        c1 = O.context(self.log, canon, vs[0], "prefix", [self.d]); n = len(c1["eligible_blocks"]); c1["eligible_blocks"].append("X"); c1["manifest"].append("Y"); c1["eligible_prov"].append("Z")
        c2 = O.context(self.log, canon, vs[0], "prefix", [self.d]); self.assertEqual(len(c2["eligible_blocks"]), n); self.assertNotIn("Y", c2["manifest"]); self.assertEqual(len(c2["eligible_prov"]), n)
        o, _ = self.prep("The latest commit is abc1234", STALE); o["hints"]["source_records"].clear()
        self.assertTrue(self.prep("The latest commit is abc1234", STALE)[0]["hints"]["source_records"])

class StdinBatch(Base):
    def run_cli(self, script, args, stdin):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + args, input=stdin, capture_output=True, text=True, env=ENV, cwd=self.d); return p.returncode, p.stdout

    def test_prepare_batch_reads_stdin_and_equals_the_file_form(self):
        self.build(["intro", STALE, NEG])
        spec = [dict(detail="The latest commit is abc1234", source_quote=STALE), dict(detail="The latest commit is abc1234", source_quote=NEG)]
        base = ["prepare-batch", "--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix"]
        c1, o1 = self.run_cli("omissions.py", base + ["--spec", "-"], json.dumps(spec))
        f = os.path.join(self.d, "spec.json"); write(f, json.dumps(spec)); c2, o2 = self.run_cli("omissions.py", base + ["--spec", f], "")
        self.assertEqual((c1, o1), (c2, o2)); self.assertEqual(c1, 0); self.assertEqual(len(json.loads(o1)), 2)
        self.assertEqual(sorted(os.listdir(self.d)), ["HANDOFF.md", "session.jsonl", "spec.json"])    # no temporary file

    def test_invalid_stdin_is_refused_safely(self):
        self.build(["intro", STALE])
        for bad in ("", "not json {", "{}", "[]"):
            c, o = self.run_cli("omissions.py", ["prepare-batch", "--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix", "--spec", "-"], bad)
            self.assertEqual(c, 3, bad); self.assertFalse(json.loads(o)["ok"])

    def test_scope_prepare_reads_stdin(self):
        self.build(["intro", STALE])
        c, o = self.run_cli("scope.py", ["prepare", "--source", self.log, "--spec", "-"], json.dumps(["a detail", "another detail"]))
        self.assertEqual(c, 0, o); self.assertEqual(len(json.loads(o)["payloads"][0]["items"]), 2)
        c, o = self.run_cli("scope.py", ["prepare", "--source", self.log, "--spec", "-"], "nope"); self.assertEqual(c, 3)

if __name__ == "__main__": unittest.main()

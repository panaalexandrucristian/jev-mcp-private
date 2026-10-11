#!/usr/bin/env python3
"""Tests of ctxplan.py (offline, stdlib only, no model, no Jev call, never reads .handoff-verify/ or a real transcript). Layouts are built in temporary directories from a small synthetic skill (its own baseline and manifest), and the real documentation is only read.
Every negative test applies a real mutation and requires REFUSED with the expected reason. usage: python3 -B test_ctxplan.py [-v]"""
import copy, io, json, os, random, shutil, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ctxplan as C, split_skill as S

PROSE = " ".join("word%d" % i for i in range(300))
BASE = ("---\nname: demo\n---\n# Demo\nIntro.\n## Steps\n1. " + PROSE + " `a b c` \"x y z\" [t u](v) end\n2. short\n## Hard rules\n- rule one\n## Details\nDetails " + PROSE + "\n## Flags\n- --flag one\n## Extra\nExtra text.\n").encode()
IDS = (("head", 1, 5), ("checklist", 6, 8), ("hard-rules", 9, 10), ("details", 11, 13), ("flags", 14, 15), ("extra", 16, 16))
HOMES = {"SKILL.md": ["head", "checklist", "hard-rules", "flags"], "reference/a.md": ["details"], "reference/b.md": ["extra"]}

def sha(b): return C.sha(b)

class Skill:
    """A synthetic skill in a temporary directory: its own frozen baseline, manifest and layout."""
    def __init__(self, test, contracts=False):
        self.d = os.path.realpath(tempfile.mkdtemp()); test.addCleanup(shutil.rmtree, self.d); self.base = os.path.join(self.d, "base.md"); open(self.base, "wb").write(BASE)
        self.m = {"format": 1, "original": {"path": self.base}, "blocks": [{"id": i, "lines": [a, b]} for i, a, b in IDS], "files": copy.deepcopy(HOMES)}
        if contracts: self.m["blocks"][4]["loading"] = {"needed_at": 5}; self.m["opens"] = {"reference/b.md": 4, "reference/a.md": 6}
        S.fill(self.m); self.root = os.path.join(self.d, "skill"); S.build(self.root, self.m); test.assertEqual(S.check(self.root, self.m), [])
    def read(self, n): return open(os.path.join(self.root, n), "rb").read()
    def write(self, n, b): open(os.path.join(self.root, n), "wb").write(b)
    def prop(self, ops):
        files, _ = C.load(self.root, self.m); return {"schema_version": 1, "snapshot": {n: sha(files[n]) for n in C.touched(ops, self.m) if n in files}, "operations": ops}
    def prove(self, ops=None, prop=None): return C.prove(self.root, prop or self.prop(ops), self.m)
    def reflow(self): return C.propose(self.root, self.m)

def codes(v): return [r["code"] for r in v["reasons"]]

class Reflow(unittest.TestCase):
    def test_the_proposal_is_proven_and_the_inverse_gives_the_original(self):
        k = Skill(self); res = k.reflow(); self.assertEqual({p["affected_files"][0] for p in res["proposals"]}, {"SKILL.md", "reference/a.md"})
        for p in res["proposals"]:
            v, after = k.prove(prop=p); self.assertEqual(v["verdict"], "PROVEN"); files, _ = C.load(k.root, k.m)
            self.assertEqual(C.inverse(after, p["operations"]), files); self.assertEqual(after[p["affected_files"][0]].decode().split(), files[p["affected_files"][0]].decode().split())
            self.assertEqual(v["added_bytes"], 0); self.assertTrue(v["requires_manifest_change"])      # the manifest holds the bytes of the blocks
    def test_a_list_item_gets_the_item_indent_and_a_paragraph_none(self):
        k = Skill(self); ops = {o["file"]: o for p in k.reflow()["proposals"] for o in p["operations"]}
        self.assertEqual(ops["SKILL.md"]["indent"], 3); self.assertEqual(ops["reference/a.md"]["indent"], 0)
        _, after = k.prove([ops["SKILL.md"]]); self.assertTrue(all(l.startswith("   ") for l in after["SKILL.md"].decode().split("\n")[6:9] if l.startswith("   ") or l.startswith("word")))
        self.assertTrue(all(len(l) <= C.WIDTH + 40 for l in after["SKILL.md"].decode().split("\n")))
    def test_random_lines_round_trip(self):
        rnd = random.Random(7); m = {"blocks": [], "files": {"f.md": []}}
        for n in range(60):
            toks = [rnd.choice(["a", "bb", "`c d`", "\"e f\"", "[g h](i)", "x-y", "1.", "-", "#", "(z)", "q"]) for _ in range(rnd.randint(180, 400))]; line = (rnd.choice(["", "- ", "3. "])) + " ".join(toks)
            r = C.reflow_line(line)
            if isinstance(r, str): continue
            b = C.plan_breaks(line, r[0]); files = {"f.md": ("para\n" + line + "\ntail\n").encode()}; ops = [{"kind": "reflow", "file": "f.md", "line": 2, "breaks": b, "indent": r[1]}] if b else []
            if not ops: continue
            after, _, why = C.forward(files, ops, m); self.assertEqual(why, [], line[:60]); self.assertEqual(C.inverse(after, ops), files); self.assertEqual(after["f.md"].decode().split(), files["f.md"].decode().split())
    def test_nothing_is_broken_inside_a_protected_span(self):
        line = "word `a b c` \"x y\" [t u](v w) <a b> «p q» end " * 40; r = C.reflow_line(line.strip())
        self.assertIsInstance(r, tuple); spans = [m.span() for m in C.SPANS.finditer(line.strip())]
        self.assertTrue(r[0] and all(not any(a <= j < b for a, b in spans) for j in r[0]))
    def test_a_token_that_could_start_a_block_is_never_after_a_break(self):
        line = "alpha - beta 1. gamma # delta > eps | zeta --- eta 22) theta + iota * end"; offs = C.reflow_line(line)[0]
        after = {line[j + 1:].split(" ")[0] for j in offs}; self.assertFalse({"-", "1.", "#", ">", "|", "---", "22)", "+", "*"} & after); self.assertEqual(after, {"beta", "gamma", "delta", "eps", "zeta", "eta", "theta", "iota", "end"} & after); self.assertTrue(offs)
    def test_lines_that_cannot_be_classified_are_refused(self):
        for what, line in (("hard break spaces", "text  "), ("hard break backslash", "text\\"), ("unbalanced backtick", "a `b c d"), ("unbalanced quote", "a \"b c d"), ("heading", "# a b"), ("table", "| a | b |"), ("quote", "> a b"), ("indented", "    a b"), ("nested list", "  - a b"), ("fence", "```a b"), ("html", "<p>a b</p>")):
            with self.subTest(what): self.assertEqual(C.reflow_line(line), "markdown_ambiguous")
    def test_code_fences_and_short_lines_are_left_alone(self):
        text = "```\n" + PROSE + "\n```\n" + "short line\n"; self.assertEqual(C.reflow_ops("f.md", text), ([], [])); self.assertEqual(C.reflow_ops("f.md", "# " + PROSE)[0], [])
    def test_every_changed_proposal_is_refused(self):
        k = Skill(self); op = next(o for p in k.reflow()["proposals"] for o in p["operations"] if o["file"] == "reference/a.md"); text = k.read("reference/a.md").decode().split("\n")[op["line"] - 1]
        non_space = next(j for j, ch in enumerate(text) if ch != " " and j not in op["breaks"]); in_span = text.find("`a b") if "`a b" in text else None
        for what, code, change in (("a break on a letter", "non_whitespace_edit", lambda o: o.update(breaks=[non_space])), ("unsorted breaks", "non_whitespace_edit", lambda o: o.update(breaks=o["breaks"][::-1])),
                                   ("wrong indent", "non_whitespace_edit", lambda o: o.update(indent=2)), ("an extra field", "unknown_operation", lambda o: o.update(note="x")), ("unknown kind", "unknown_operation", lambda o: o.update(kind="delete")),
                                   ("a missing line", "unknown_operation", lambda o: o.update(line=999)), ("an unknown file", "unreachable_reference", lambda o: o.update(file="reference/zzz.md"))):
            with self.subTest(what):
                o = dict(op); change(o); v, after = C.prove(k.root, {"schema_version": 1, "snapshot": {"reference/a.md": sha(k.read("reference/a.md"))}, "operations": [o]}, k.m); self.assertEqual(v["verdict"], "REFUSED"); self.assertIsNone(after); self.assertIn(code, codes(v))
        v, _ = k.prove([op, op]); self.assertIn("duplicate_mapping", codes(v))
    def test_a_break_inside_a_code_span_is_refused(self):
        k = Skill(self); text = BASE.decode().split("\n")[6]; j = text.index("`a b c`") + 2; ops = [{"kind": "reflow", "file": "SKILL.md", "line": 7, "breaks": [j], "indent": 3}]
        v, _ = k.prove(ops); self.assertEqual(v["verdict"], "REFUSED"); self.assertIn("non_whitespace_edit", codes(v))

    def test_a_forward_that_loses_a_word_is_refused_twice(self):
        k = Skill(self); p = next(p for p in k.reflow()["proposals"] if p["affected_files"] == ["reference/a.md"])
        with mock.patch.object(C, "wrap", lambda line, br, ind: line.replace("word5 ", "", 1)):
            v, after = C.prove(k.root, p, k.m)
        self.assertEqual(v["verdict"], "REFUSED"); self.assertIsNone(after); self.assertEqual(set(codes(v)), {"missing_block", "non_whitespace_edit"})      # the inverse fails, and so does the word comparison

class Before(unittest.TestCase):
    def refused(self, k, code):
        res = k.reflow(); self.assertEqual(res["proposals"], []); self.assertIn(code, [r["reason"] for r in res["refused_operations"]])
    def test_a_changed_word_in_the_active_documentation_refuses_everything(self):
        k = Skill(self); k.write("reference/a.md", k.read("reference/a.md").replace(b"word7 ", b"wurd7 ", 1)); self.refused(k, "baseline_changed")
    def test_encoding_and_layout_doubts_are_refused(self):
        for what, name, fn in (("crlf", "reference/b.md", lambda b: b.replace(b"\n", b"\r\n")), ("bom", "reference/b.md", lambda b: b"\xef\xbb\xbf" + b), ("not utf-8", "reference/b.md", lambda b: b + b"\xff"), ("missing", None, None), ("undeclared file", "reference/c.md", lambda b: b"x")):
            with self.subTest(what):
                k = Skill(self)
                if name is None: os.remove(os.path.join(k.root, "reference/b.md"))
                else: k.write(name, fn(k.read(name)) if os.path.exists(os.path.join(k.root, name)) else fn(b""))
                res = k.reflow(); self.assertEqual(res["proposals"], []); self.assertTrue(res["refused_operations"])
    def test_a_symlink_is_refused(self):
        k = Skill(self); p = os.path.join(k.root, "reference/b.md"); data = k.read("reference/b.md"); os.remove(p); alias = os.path.join(k.d, "elsewhere.md"); open(alias, "wb").write(data); os.symlink(alias, p)
        self.assertIn("markdown_ambiguous", [w["code"] for w in C.load(k.root, k.m)[1]])
    def test_the_frozen_baseline_is_never_a_source(self):
        k = Skill(self); k.write("reference/a.md", b"restored from handoff-verify-skill-0.9.0\n"); self.refused(k, "baseline_changed")
    def test_a_file_changed_after_the_proposal_was_made_is_refused(self):
        k = Skill(self); p = k.reflow()["proposals"][0]; f = p["affected_files"][0]; k.write(f, k.read(f) + b"")      # same bytes: still proven
        self.assertEqual(C.prove(k.root, p, k.m)[0]["verdict"], "PROVEN"); p["snapshot"][f] = "0" * 64; v, _ = C.prove(k.root, p, k.m); self.assertIn("baseline_changed", codes(v))

class Move(unittest.TestCase):
    def op(self, k, **kw):
        sp = C.spans_of(k.m); s, e = sp["flags"][1:]; o = {"kind": "move_block", "block": "flags", "to": "reference/b.md", "before_block": None, "from_offset": s, "to_offset": len(k.read("reference/b.md")), "length": e - s}; o.update(kw); return o
    def test_a_declared_contract_makes_the_move_provable_and_reversible(self):
        k = Skill(self, contracts=True); v, after = k.prove([self.op(k)]); self.assertEqual(v["verdict"], "PROVEN", v); files, _ = C.load(k.root, k.m); ptr = (C.POINTER % ("flags", "reference/b.md")).encode()
        self.assertEqual(v["added_bytes"], len(ptr)); self.assertIn(b"- --flag one\n", after["reference/b.md"]); self.assertIn(ptr, after["SKILL.md"]); self.assertEqual(C.inverse(after, [self.op(k)]), files)
        self.assertEqual(sum(len(d) for d in after.values()) - sum(len(d) for d in files.values()), len(ptr)); self.assertTrue(v["requires_manifest_change"])
    def test_propose_offers_it_only_with_a_contract(self):
        self.assertIn("unknown_loading_contract", [r["reason"] for r in Skill(self).reflow()["refused_operations"]])
        res = Skill(self, contracts=True).reflow(); self.assertIn("move_block", [p["operation"] for p in res["proposals"]])
    def test_missing_or_weak_contracts_are_refused(self):
        k = Skill(self); v, _ = k.prove([self.op(k)]); self.assertIn("unknown_loading_contract", codes(v))
        k = Skill(self, contracts=True); k.m["opens"]["reference/b.md"] = 9; v, _ = k.prove([self.op(k)]); self.assertIn("loading_contract_weakened", codes(v))
    def test_protected_blocks_and_bad_targets_are_refused(self):
        k = Skill(self, contracts=True); sp = C.spans_of(k.m)
        for what, code, o in (("hard rules", "protected_bytes_changed", self.op(k, block="hard-rules", from_offset=sp["hard-rules"][1], length=sp["hard-rules"][2] - sp["hard-rules"][1])), ("unknown block", "missing_block", self.op(k, block="nope")),
                              ("unknown file", "unreachable_reference", self.op(k, to="reference/zzz.md")), ("same file", "unreachable_reference", self.op(k, to="SKILL.md")), ("wrong offsets", "non_whitespace_edit", self.op(k, from_offset=0)), ("extra field", "unknown_operation", self.op(k, why="x"))):
            with self.subTest(what): v, _ = k.prove([o]); self.assertEqual(v["verdict"], "REFUSED"); self.assertIn(code, codes(v))
    def test_two_moves_or_a_move_with_a_reflow_in_its_files_are_refused(self):
        k = Skill(self, contracts=True); v, _ = k.prove([self.op(k), self.op(k)]); self.assertEqual(v["verdict"], "REFUSED")
        ref = {"kind": "reflow", "file": "SKILL.md", "line": 7, "breaks": [100], "indent": 3}; v, _ = k.prove([self.op(k), ref]); self.assertEqual(v["verdict"], "REFUSED")
    def test_the_root_cap_is_enforced(self):
        k = Skill(self, contracts=True); with_cap = mock.patch.object(C, "ROOT_CAP", 10)
        with with_cap: v, _ = k.prove([self.op(k)])
        self.assertIn("budget_exceeded", codes(v))

class Apply(unittest.TestCase):
    def setUp(self): self.k = Skill(self); self.p = next(p for p in self.k.reflow()["proposals"] if p["affected_files"] == ["reference/a.md"]); self.f = os.path.join(self.k.root, "reference/a.md"); self.snap = self.p["snapshot"]["reference/a.md"]
    def run_apply(self, **kw): a = dict(approved=[self.f], snapshot=self.snap); a.update(kw); return C.apply(self.k.root, self.p, a.pop("approved"), a.pop("snapshot"), m=self.k.m, **a)
    def test_apply_refuses_on_this_layout_because_the_manifest_would_change(self):
        r = self.run_apply(); self.assertFalse(r["applied"]); self.assertEqual(r["reasons"][0]["code"], "requires_manifest_change"); self.assertEqual(self.k.read("reference/a.md"), C.load(self.k.root, self.k.m)[0]["reference/a.md"])
        self.assertEqual([n for n in os.listdir(os.path.join(self.k.root, "reference")) if ".bak" in n], [])
    def test_each_guard_refuses_and_changes_nothing(self):
        before = self.k.read("reference/a.md")
        with mock.patch.object(C, "AFTER_CHECK", lambda root, m: []):
            for what, code, kw in (("headless", "headless_refused", dict(headless=True)), ("no approval", "not_approved", dict(approved=[os.path.join(self.k.root, "SKILL.md")])), ("wrong snapshot", "not_approved", dict(snapshot="1" * 64))):
                with self.subTest(what): r = self.run_apply(**kw); self.assertFalse(r["applied"]); self.assertEqual(r["reasons"][0]["code"], code); self.assertEqual(self.k.read("reference/a.md"), before)
            mv = {"schema_version": 1, "snapshot": {}, "operations": [{"kind": "move_block"}]}; self.assertFalse(C.apply(self.k.root, mv, [self.f], "x", m=self.k.m)["applied"])
        self.assertEqual(self.k.read("reference/a.md"), before)
    def test_with_approval_a_proven_single_file_reflow_is_written_with_a_backup(self):
        before = self.k.read("reference/a.md")
        with mock.patch.object(C, "AFTER_CHECK", lambda root, m: []):
            r = self.run_apply()
        self.assertTrue(r["applied"], r); now = self.k.read("reference/a.md"); self.assertNotEqual(now, before); self.assertEqual(r["sha256"], sha(now)); self.assertEqual(now.decode().split(), before.decode().split())
        baks = [n for n in os.listdir(os.path.join(self.k.root, "reference")) if ".bak-" in n]; self.assertEqual(len(baks), 1); self.assertEqual(open(os.path.join(self.k.root, "reference", baks[0]), "rb").read(), before)
    def test_a_file_changed_since_the_proposal_is_not_overwritten(self):
        with mock.patch.object(C, "AFTER_CHECK", lambda root, m: []):
            self.k.write("reference/a.md", self.k.read("reference/a.md") + b"more\n"); r = self.run_apply(); self.assertFalse(r["applied"])
    def test_the_real_documentation_is_proposed_proven_and_never_applied(self):
        res = C.propose(S.SKILL_DIR); self.assertTrue(res["proposals"]); real = {"SKILL.md": os.path.join(S.SKILL_DIR, "SKILL.md")}
        for p in res["proposals"]:
            self.assertEqual(p["proof"]["verdict"], "PROVEN"); self.assertTrue(p["proof"]["requires_manifest_change"]); self.assertEqual(p["proof"]["added_bytes"], 0)
        r = C.apply(S.SKILL_DIR, res["proposals"][0], [os.path.join(S.SKILL_DIR, res["proposals"][0]["affected_files"][0])], next(iter(res["proposals"][0]["snapshot"].values()))); self.assertFalse(r["applied"]); self.assertEqual(r["reasons"][0]["code"], "requires_manifest_change")

class Usage(unittest.TestCase):
    def setUp(self):
        self.top = os.path.realpath(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.top); self.s = os.path.join(self.top, "p", "a.jsonl"); os.makedirs(os.path.dirname(self.s)); self.other = os.path.join(self.top, "p", "other.jsonl")
        def tu(i, name, **inp): return {"message": {"content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}}
        recs = [tu("t1", "Skill", skill="jev:handoff-verify"), tu("t2", "Read", file_path="/x/skills/handoff-verify/reference/report.md"), tu("t3", "Bash", command="python3 /x/skills/handoff-verify/scripts/audit.py status password=hunter2hunter2"), {"message": {"content": [{"type": "tool_result", "tool_use_id": "t3", "is_error": True}]}}, tu("t4", "Read", file_path="/x/other/report.md")]
        open(self.s, "w").write("\n".join(json.dumps(r) for r in recs) + "\nnot json\n"); open(self.other, "w").write(json.dumps(tu("t9", "Skill", skill="handoff-verify")) + "\n")
    def test_counts_only_for_the_selected_sessions(self):
        u = C.usage([self.s], root=self.top); self.assertEqual((u["sessions"], u["skill_calls"], u["reads"]["reference/report.md"], u["script_runs"], u["errors_of_these_calls"]), (1, 1, 1, {"audit": 1}, 1)); self.assertEqual(u["read_order"], ["reference/report.md"])
        self.assertNotIn("hunter2", json.dumps(u)); self.assertNotIn("password", json.dumps(u)); self.assertEqual(C.usage([self.s, self.other], root=self.top)["skill_calls"], 2)
    def test_sessions_outside_the_projects_folder_or_not_jsonl_are_refused(self):
        outside = os.path.join(tempfile.mkdtemp(), "x.jsonl"); self.addCleanup(shutil.rmtree, os.path.dirname(outside)); open(outside, "w").write("{}\n"); alias = os.path.join(self.top, "p", "alias.jsonl"); os.symlink(self.s, alias); txt = os.path.join(self.top, "p", "n.txt"); open(txt, "w").write("{}")
        for p in (outside, alias, txt, os.path.join(self.top, "p", "missing.jsonl")):
            with self.subTest(p): self.assertRaises(ValueError, C.usage, [p], root=self.top)

class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        out = io.StringIO()
        with mock.patch("sys.stdout", out): rc = C.main(list(argv))
        return rc, out.getvalue()
    def test_propose_prints_a_romanian_summary_and_exports_on_request(self):
        k = Skill(self)
        with mock.patch.object(C.S, "load_manifest", lambda: k.m):
            rc, text = self.run_cli("propose", "--skill-dir", k.root, "--out", os.path.join(k.d, "all.json"))
        self.assertEqual(rc, 0); self.assertIn("Propuneri", text); self.assertLessEqual(len(text.encode()), C.SUMMARY_CAP); full = json.load(open(os.path.join(k.d, "all.json"))); self.assertTrue(full["proposals"])
        self.assertNotIn("OPTIMIZE", text)
    def test_an_oversized_export_is_refused_not_cut(self):
        k = Skill(self)
        with mock.patch.object(C.S, "load_manifest", lambda: k.m), mock.patch.object(C, "FULL_CAP", 50):
            rc, text = self.run_cli("propose", "--skill-dir", k.root, "--out", os.path.join(k.d, "all.json"))
        self.assertEqual(rc, 1); self.assertIn("REFUZAT", text); self.assertFalse(os.path.exists(os.path.join(k.d, "all.json")))
    def test_check_exit_codes(self):
        k = Skill(self); f = os.path.join(k.d, "p.json"); p = k.reflow()["proposals"][0]; json.dump(p, open(f, "w"))
        with mock.patch.object(C.S, "load_manifest", lambda: k.m):
            self.assertEqual(self.run_cli("check", "--skill-dir", k.root, "--proposal", f)[0], 0); p["snapshot"][p["affected_files"][0]] = "0" * 64; json.dump(p, open(f, "w")); rc, text = self.run_cli("check", "--skill-dir", k.root, "--proposal", f)
        self.assertEqual(rc, 1); self.assertIn("REFUSED", text)
    def test_the_capability_never_starts_by_itself_and_stays_small(self):
        import re
        src = open(os.path.join(HERE, "ctxplan.py"), "rb").read(); self.assertLessEqual(len(src), 24576); self.assertLessEqual(len(open(__file__, "rb").read()), 24576)
        self.assertIsNone(re.search(rb"subprocess|urllib|socket|jev_|anthropic|claude -p", src))      # no model, no Jev, no network, no process

if __name__ == "__main__": unittest.main()

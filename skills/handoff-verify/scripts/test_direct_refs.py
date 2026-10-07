#!/usr/bin/env python3
"""Offline test of the direct references of a note (stdlib + git, no Jev call, never reads .handoff-verify/): what counts as a reference (a command is not one, the files it names are;
a shorthand fragment is not one), how it resolves ('~', the git root of a base, the one tracked file of a bare name) and that an unresolved reference still blocks the material.
usage: python3 -B test_direct_refs.py [-v]"""
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, refs

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: f.write(text)

class Extraction(unittest.TestCase):
    def test_a_command_names_its_files_and_is_not_itself_a_reference(self):
        self.assertEqual(refs.direct_refs("run `PYTHONDONTWRITEBYTECODE=1 bash scripts/test-completion.sh` then `python3 -m x t.py`"), ["scripts/test-completion.sh", "t.py"])

    def test_shorthand_fragments_are_not_references(self):
        self.assertEqual(refs.direct_refs("answers in `council-answers-T1.md`, `-T1b.md`, `...-R08.json`"), ["council-answers-T1.md"])

    def test_plain_references_are_unchanged(self):
        self.assertEqual(refs.direct_refs("see `docs/a.md`, (notes.md) and `docs/a.md` again"), ["docs/a.md", "notes.md"])

class Resolution(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.repo = os.path.join(self.d, "repo")
        write(os.path.join(self.repo, ".claude-plugin", "plugin.json"), "{}\n")
        write(os.path.join(self.repo, "scripts", "run.sh"), "echo\n")
        write(os.path.join(self.repo, "a", "SKILL.md"), "a\n"); write(os.path.join(self.repo, "b", "SKILL.md"), "b\n")
        write(os.path.join(self.repo, "untracked.md"), "u\n")
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        subprocess.run(["git", "-C", self.repo, "add", ".claude-plugin", "scripts", "a", "b"], check=True)
        self.sub = os.path.join(self.repo, "deep", "cwd"); os.makedirs(self.sub)
    def tearDown(self): self.t.cleanup()

    def test_the_git_root_of_a_base_is_an_extra_base(self):
        bases = refs.with_git_roots([self.sub])
        self.assertEqual(bases, [self.sub, self.repo])
        self.assertEqual(refs.resolve_info("scripts/run.sh", bases), (os.path.join(self.repo, "scripts", "run.sh"), "path"))

    def test_a_bare_name_resolves_only_to_the_one_tracked_file_of_that_name(self):
        self.assertEqual(refs.resolve_info("plugin.json", [self.sub]), (os.path.join(self.repo, ".claude-plugin", "plugin.json"), "unique_tracked_name"))
        self.assertEqual(refs.resolve_info("SKILL.md", [self.sub]), (None, "2 tracked files have this name"))
        self.assertEqual(refs.resolve_info("untracked.md", [self.sub])[0], None)          # not tracked: never picked by name
        self.assertEqual(refs.resolve_info("x/plugin.json", [self.sub]), (None, "not found from the bases"))   # a path is never matched by name

    def test_tilde_is_expanded(self):
        home = os.path.join(self.d, "home"); write(os.path.join(home, ".claude", "n.md"), "n\n")
        old = os.environ.get("HOME"); os.environ["HOME"] = home
        try: self.assertEqual(refs.resolve_info("~/.claude/n.md", [self.sub]), (os.path.realpath(os.path.join(home, ".claude", "n.md")), "path"))
        finally:
            if old is None: os.environ.pop("HOME")
            else: os.environ["HOME"] = old

    def test_material_records_the_resolution_and_an_unresolved_reference_still_blocks(self):
        note = "# note\nedit `plugin.json`, run `bash scripts/run.sh`\n"
        mat, man, why = omissions.build_material(note, [self.sub])
        self.assertIsNone(why)
        self.assertEqual([(m["ref"], m["resolution"]) for m in man], [("plugin.json", "unique_tracked_name"), ("scripts/run.sh", "path")])
        self.assertIn("=== DIRECT REFERENCE plugin.json", mat)
        mat, man, why = omissions.build_material(note + "and `gone.md`\n", [self.sub])
        self.assertIsNone(mat); self.assertIn("'gone.md' cannot be resolved (not found from the bases)", why)
        mat, _, why = omissions.build_material("see `SKILL.md`\n", [self.sub])
        self.assertIsNone(mat); self.assertIn("2 tracked files have this name", why)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the direct references of a note (stdlib + git, no Jev call, never reads .handoff-verify/): what counts as a reference (a command is not one, the files it names are;
a shorthand fragment is not one), how it resolves ('~', the git root of a base, the one tracked file of a bare name) and that an unresolved reference still blocks the material.
usage: python3 -B test_direct_refs.py [-v]"""
import os, subprocess, sys, tempfile, unittest
from unittest import mock

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

    def test_existing_bash_command_still_extracts_path(self):
        self.assertEqual(refs.direct_refs("run `bash scripts/run.sh`"), ["scripts/run.sh"])

    def test_backtick_path_with_space_kept_whole(self):
        self.assertEqual(refs.direct_refs("see `My Notes.md` and `docs/My Plan.txt`"), ["My Notes.md", "docs/My Plan.txt"])

    def test_command_file_not_last_token(self):
        self.assertEqual(refs.direct_refs("`bash scripts/run.sh --verbose`"), ["scripts/run.sh"])

    def test_command_with_operator(self):
        self.assertEqual(refs.direct_refs("`bash scripts/run.sh && echo ok` and `cat a.md | grep x > b.txt`"), ["scripts/run.sh", "a.md", "b.txt"])

    def test_python_trailing_flag(self):
        self.assertEqual(refs.direct_refs("`python3 t.py -v` and `node tools/x.mjs --fast`"), ["t.py", "tools/x.mjs"])

    def test_command_skips_assignments_and_flags(self):
        self.assertEqual(refs.direct_refs("`CFG=a.json bash run.sh --config=b.yml -o c.toml`"), ["run.sh", "c.toml"])

    def test_quoted_tokens(self):
        self.assertEqual(refs.direct_refs("`python3 \"my script.py\" --flag` and `bash 'a b/run.sh'`"), ["my script.py", "a b/run.sh"])

    def test_a_command_without_a_file_names_nothing(self):
        self.assertEqual(refs.direct_refs("`git status --short` and `npm test`"), [])

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

    def test_space_path_resolves_as_file(self):
        write(os.path.join(self.sub, "My Notes.md"), "n\n")
        self.assertEqual(refs.direct_refs("`My Notes.md`", [self.sub]), ["My Notes.md"])
        self.assertEqual(refs.direct_refs("`cat My Notes.md`", [self.sub]), ["Notes.md"])
        mat, man, why = omissions.build_material("see `My Notes.md`\n", [self.sub])
        self.assertIsNone(why); self.assertEqual(man[0]["ref"], "My Notes.md")

    def test_unresolved_command_reference_blocks_material(self):
        mat, _, why = omissions.build_material("run `bash scripts/gone.sh --verbose`\n", [self.sub])
        self.assertIsNone(mat); self.assertIn("'scripts/gone.sh' cannot be resolved", why)
        mat, _, why = omissions.build_material("see `My Gone.md`\n", [self.sub])
        self.assertIsNone(mat); self.assertIn("'My Gone.md' cannot be resolved", why)

    def test_preexisting_complete_material_byte_identical(self):
        note = "# note\nsee `docs/a.md`, (b.md) and `scripts/run.sh`\n"
        write(os.path.join(self.sub, "docs", "a.md"), "A\n"); write(os.path.join(self.sub, "b.md"), "B\n")
        expected = omissions.material(note, [("docs/a.md", "A\n"), ("b.md", "B\n"), ("scripts/run.sh", "echo\n")])
        self.assertEqual(omissions.build_material(note, [self.sub])[0], expected)

    def test_unique_tracked_symlink_escape_not_resolved(self):
        outside = os.path.join(self.d, "outside.md"); write(outside, "secret\n")
        os.makedirs(os.path.join(self.repo, "docs")); os.symlink(outside, os.path.join(self.repo, "docs", "link-out.md"))
        os.makedirs(os.path.join(self.repo, "inner")); os.symlink(os.path.join(self.repo, "scripts", "run.sh"), os.path.join(self.repo, "inner", "in.sh"))
        subprocess.run(["git", "-C", self.repo, "add", "docs", "inner"], check=True)
        real, why = refs.resolve_info("link-out.md", [self.sub])
        self.assertIsNone(real); self.assertIn("outside the repository root", why)
        mat, _, why = omissions.build_material("see `link-out.md`\n", [self.sub])
        self.assertIsNone(mat); self.assertIn("outside the repository root", why)
        self.assertEqual(refs.resolve_info("in.sh", [self.sub]), (os.path.join(self.repo, "scripts", "run.sh"), "unique_tracked_name"))   # inside the root: still fine

    def test_tracked_cached_once_per_root(self):
        calls, real_run = [], subprocess.run
        def counting(*a, **k): calls.append(a[0]); return real_run(*a, **k)
        refs._TRACKED_CACHE.clear()
        with mock.patch.object(refs.subprocess, "run", counting):
            for name in ("plugin.json", "SKILL.md", "plugin.json"): refs.resolve_info(name, [self.sub])
        self.assertEqual(len(calls), 1)

    def test_tracked_sorted(self):
        refs._TRACKED_CACHE.clear()
        files, err = refs._tracked(self.repo)
        self.assertIsNone(err); self.assertEqual(files, sorted(files)); self.assertIn("scripts/run.sh", files)

    def test_git_failure_reason(self):
        refs._TRACKED_CACHE.clear()
        class P: returncode, stdout, stderr = 128, b"", b"fatal: not a git repository\n"
        with mock.patch.object(refs.subprocess, "run", lambda *a, **k: P):
            real, why = refs.resolve_info("plugin.json", [self.sub])
        self.assertIsNone(real); self.assertTrue(why.startswith("git ls-files failed: exit 128: fatal: not a git repository"), why)
        with mock.patch.object(refs.subprocess, "run", mock.Mock(side_effect=OSError("no git"))):
            real, why = refs.resolve_info("plugin.json", [self.sub])
        self.assertTrue(why.startswith("git ls-files failed: no git"), why)
        self.assertEqual(refs.resolve_info("plugin.json", [self.sub])[1], "unique_tracked_name")   # a failure is never cached

    def test_git_timeout_reason(self):
        refs._TRACKED_CACHE.clear()
        with mock.patch.object(refs.subprocess, "run", mock.Mock(side_effect=subprocess.TimeoutExpired("git", 30))):
            real, why = refs.resolve_info("plugin.json", [self.sub])
            mat, _, bwhy = omissions.build_material("see `plugin.json`\n", [self.sub])
        self.assertIsNone(real); self.assertTrue(why.startswith("git ls-files failed: timeout"), why)
        self.assertIsNone(mat); self.assertIn("git ls-files failed: timeout", bwhy)
        refs._TRACKED_CACHE.clear()

if __name__ == "__main__": unittest.main()

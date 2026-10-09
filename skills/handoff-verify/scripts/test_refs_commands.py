#!/usr/bin/env python3
"""Offline regressions of the council corrections to the reference forms (stdlib, no Jev call): a command operand is recognized with the same annotation-aware rule as a standalone path (`cat docs/design.md:7`,
`cat docs/design.md#decisions`) and keeps its exact spelling (a `#` inside a word is a fragment, a `#` that starts a word is a shell comment), a Markdown link to a REMOTE file of any known extension is a blocking
`remote_url` obligation (never fetched, no directory question), the whole file is included for the annotated forms, a literal annotation-looking file name wins, and the references of notes without these forms are unchanged.
usage: python3 -B test_refs_commands.py [-v]"""
import os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, refs
from test_refs_forms import write, DESIGN

class Commands(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name); write(os.path.join(self.d, "docs", "design.md"), DESIGN); write(os.path.join(self.d, "src", "a.py"), "x = 1\n")
    def tearDown(self): self.t.cleanup()

    def test_annotated_command_operands_are_references_with_their_exact_spelling(self):
        for cmd, want in (("cat docs/design.md:7", ["docs/design.md:7"]), ("cat docs/design.md#decisions", ["docs/design.md#decisions"]), ("sed -n 1,5p docs/design.md:10-20", ["docs/design.md:10-20"]),
                          ("less docs/design.md#L10-L20", ["docs/design.md#L10-L20"]), ("grep foo src/a.py:3:5 docs/design.md", ["src/a.py:3:5", "docs/design.md"]), ("head -3 docs/design.md#top", ["docs/design.md#top"])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

    def test_whole_file_is_included_for_annotated_command_operands(self):
        for cmd in ("cat docs/design.md:7", "cat docs/design.md#decisions"):
            m, man, why, miss = omissions.build_material_ex("see `%s`" % cmd, [self.d]); self.assertIsNone(why, cmd)
            self.assertEqual(man[0]["ref"], cmd.split()[1]); self.assertTrue(m.endswith(DESIGN + "\n=== END DIRECT REFERENCE ===\n"), cmd)

    def test_a_shell_comment_ends_the_command_but_a_fragment_does_not(self):
        self.assertEqual(refs.direct_refs("`cat docs/design.md # see other.md`"), ["docs/design.md"])
        self.assertEqual(refs.direct_refs("`cat docs/design.md#decisions # and other.md`"), ["docs/design.md#decisions"])

    def test_command_precedence_and_options_are_unchanged(self):
        self.assertEqual(refs.direct_refs("`python3 -B src/a.py --out=x.json`"), ["src/a.py"])
        self.assertEqual(refs.direct_refs("`VAR=1 node src/a.js`"), ["src/a.js"])
        self.assertEqual(refs.direct_refs("`git log -n 3`"), [])
        self.assertEqual(refs.direct_refs("`echo hello:7`"), [])

    def test_literal_annotation_looking_command_operand_wins_when_it_exists(self):
        write(os.path.join(self.d, "notes.md:7"), "literal line suffix\n"); write(os.path.join(self.d, "notes.md"), "the stripped one\n")
        m, man, why, _ = omissions.build_material_ex("see `cat notes.md:7`", [self.d]); self.assertIsNone(why); self.assertIn("literal line suffix", m); self.assertNotIn("the stripped one", m)

class Remote(unittest.TestCase):
    def test_remote_links_of_every_known_extension_are_blocking_obligations(self):
        for ext in refs.KNOWN_EXTS:
            url = "https://example.com/dir/main.%s" % ext
            self.assertEqual(refs.direct_refs("see [source](%s)" % url), [url], ext)
            m, man, why, miss = omissions.build_material_ex("see [source](%s)" % url, ["/nonexistent-base"])
            self.assertIsNone(m); self.assertEqual((miss or {}).get("kind"), "remote_url", ext); self.assertEqual(miss["searched"], []); self.assertEqual(miss["ref"], url); self.assertIn("not fetched", why)

    def test_remote_annotation_is_kept_in_the_spelling(self):
        url = "https://example.com/a/main.ts#L10-L20"
        self.assertEqual(refs.direct_refs("[x](%s)" % url), [url])

    def test_a_remote_link_is_never_a_local_file_and_never_a_directory_question(self):
        self.assertEqual(refs.resolve_info("https://example.com/main.ts", ["/"])[0], None)
        self.assertTrue(refs.is_remote("https://example.com/main.ts"))

    def test_unchanged_remote_forms(self):
        self.assertEqual(refs.direct_refs("(https://example.com/readme.md)"), ["https://example.com/readme.md"])    # md / txt counted before
        self.assertEqual(refs.direct_refs("(https://example.com/main.ts)"), [])                                       # without the Markdown link syntax a parenthesized non-text name is prose
        self.assertEqual(refs.direct_refs("see https://example.com/main.ts"), [])
        self.assertEqual(refs.direct_refs("[home](https://example.com/)"), [])
        self.assertEqual(refs.direct_refs("[img](https://example.com/logo.png)"), [])

if __name__ == "__main__": unittest.main()

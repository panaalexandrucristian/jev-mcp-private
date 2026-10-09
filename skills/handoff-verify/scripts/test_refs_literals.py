#!/usr/bin/env python3
"""Offline regressions of the literal-filename handling of command references (stdlib, no Jev call): a shell comment is recognized only in its original unquoted, unescaped context, so a quoted or escaped
file name that starts with `#` stays a reference (with the operands after it), a `#` inside a word stays a fragment, and the canonical material of a note that names such files is complete as before.
usage: python3 -B test_refs_literals.py [-v]"""
import os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, refs
from test_refs_forms import write

class Literals(unittest.TestCase):
    def test_quoted_and_escaped_hash_file_names_are_references(self):
        for cmd, want in (('cat "#notes.md" later.md', ["#notes.md", "later.md"]), (r"cat \#notes.md later.md", ["#notes.md", "later.md"]), ("cat '#notes.md' later.md", ["#notes.md", "later.md"]),
                          ('cat "#notes.md:7" later.md', ["#notes.md:7", "later.md"]), ('head -3 "#a b.md" c.md', ["#a b.md", "c.md"]), ('cat later.md "#notes.md"', ["later.md", "#notes.md"]),
                          ('cat "x # y.md" z.md', ["x # y.md", "z.md"])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

    def test_a_real_comment_still_ends_the_command(self):
        for cmd, want in (("cat a.md # see b.md", ["a.md"]), ("cat a.md #b.md", ["a.md"]), ("cat a.md; # b.md", ["a.md"]), ("cat a.md;#b.md", ["a.md"]), ("cat a.md|#b.md", ["a.md"]), ("cat a.md && cat c.md # d.md", ["a.md", "c.md"]),
                          ("cat #first.md", []), ('cat "a.md" # "b.md"', ["a.md"]), ("cat a.md#frag # b.md", ["a.md#frag"])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

    def test_a_hash_inside_a_word_is_a_fragment(self):
        self.assertEqual(refs.direct_refs("`cat docs/design.md#decisions later.md`"), ["docs/design.md#decisions", "later.md"])
        self.assertEqual(refs.direct_refs("`echo $# a.md`"), ["a.md"])      # `$#` is a word with a `#` inside, not a comment
        self.assertEqual(refs.direct_refs("`cat a\\ b#c.md`"), ["a b#c.md"])

class Material(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        write(os.path.join(self.d, "#notes.md"), "hash notes\n"); write(os.path.join(self.d, "later.md"), "later notes\n")
    def tearDown(self): self.t.cleanup()

    def test_the_material_holds_both_files(self):
        for cmd in ('cat "#notes.md" later.md', r"cat \#notes.md later.md"):
            m, man, why, miss = omissions.build_material_ex("see `%s`" % cmd, [self.d])
            self.assertIsNone(why, cmd); self.assertEqual([x["ref"] for x in man], ["#notes.md", "later.md"], cmd)
            self.assertIn("hash notes", m); self.assertIn("later notes", m)

    def test_a_missing_quoted_hash_file_blocks_as_before(self):
        os.remove(os.path.join(self.d, "#notes.md"))
        m, man, why, miss = omissions.build_material_ex('see `cat "#notes.md" later.md`', [self.d])
        self.assertIsNone(m); self.assertEqual(miss["ref"], "#notes.md")

if __name__ == "__main__": unittest.main()

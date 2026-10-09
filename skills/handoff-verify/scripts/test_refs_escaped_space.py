#!/usr/bin/env python3
"""Offline regressions of the shell-comment rule of command references (stdlib, no Jev call): a comment starts only at a `#` that begins a WORD in the original, unquoted, unescaped text. An escaped space (`a\\ #notes.md`)
belongs to the word, so the `#` after it is part of the file name, never a comment, and the operands after it stay references; genuine comments and quoted / escaped leading-`#` names behave as before.
usage: python3 -B test_refs_escaped_space.py [-v]"""
import os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, refs
from test_refs_forms import write

class Extraction(unittest.TestCase):
    def test_an_escaped_space_keeps_the_hash_inside_the_word(self):
        for cmd, want in ((r"cat a\ #notes.md later.md", ["a #notes.md", "later.md"]), (r"cat a\ \ #notes.md later.md", ["a  #notes.md", "later.md"]), (r"cat dir\ name/a\ #n.md b.md", ["dir name/a #n.md", "b.md"]),
                          (r"cat x.md a\ #n.md", ["x.md", "a #n.md"]), (r"cat a\ #n.md # b.md", ["a #n.md"]), (r"cat a\ #n.md; cat c.md", ["a #n.md", "c.md"])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

    def test_a_hash_after_a_closing_quote_is_part_of_the_word(self):
        for cmd, want in (('cat "a b"#c.md d.md', ["a b#c.md", "d.md"]), ("cat 'a b'#c.md d.md", ["a b#c.md", "d.md"]), (r"cat a\\ #b.md c.md", [])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

    def test_controls_real_comments_and_literal_names_are_unchanged(self):
        for cmd, want in (("cat a.md # see b.md", ["a.md"]), ("cat a.md;#b.md", ["a.md"]), ("cat #first.md", []), ('cat "#notes.md" later.md', ["#notes.md", "later.md"]), (r"cat \#notes.md later.md", ["#notes.md", "later.md"]),
                          ("cat docs/design.md#decisions later.md", ["docs/design.md#decisions", "later.md"]), ("cat a.md &&#b.md", ["a.md"])):
            self.assertEqual(refs.direct_refs("run `%s`" % cmd), want, cmd)

class Material(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        write(os.path.join(self.d, "a #notes.md"), "spaced hash notes\n"); write(os.path.join(self.d, "later.md"), "later notes\n")
    def tearDown(self): self.t.cleanup()

    def test_the_material_holds_both_files(self):
        m, man, why, miss = omissions.build_material_ex(r"see `cat a\ #notes.md later.md`", [self.d])
        self.assertIsNone(why); self.assertEqual([x["ref"] for x in man], ["a #notes.md", "later.md"])
        self.assertIn("spaced hash notes", m); self.assertIn("later notes", m)

    def test_a_missing_file_blocks_the_material(self):
        os.remove(os.path.join(self.d, "later.md"))
        m, man, why, miss = omissions.build_material_ex(r"see `cat a\ #notes.md later.md`", [self.d])
        self.assertIsNone(m); self.assertEqual(miss["ref"], "later.md")
        os.remove(os.path.join(self.d, "a #notes.md")); write(os.path.join(self.d, "later.md"), "later notes\n")
        m, man, why, miss = omissions.build_material_ex(r"see `cat a\ #notes.md later.md`", [self.d])
        self.assertIsNone(m); self.assertEqual(miss["ref"], "a #notes.md")

if __name__ == "__main__": unittest.main()

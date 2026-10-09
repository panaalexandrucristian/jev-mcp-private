#!/usr/bin/env python3
"""Offline test of the direct reference FORMS (stdlib, no Jev call): a standalone path and a path inside a command are recognized with the same known extensions (.js/.mjs/.ts too), a line / range /
fragment annotation or an anchored Markdown link names the whole file while the manifest keeps the reference as written, a genuine file name that looks annotated wins, a remote link is classified as
unavailable (blocking, no work-location question, never fetched), references stay one level, and the material of notes without these forms is unchanged.
usage: python3 -B test_refs_forms.py [-v]"""
import os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, refs

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f: f.write(text)

DESIGN = "# Design\n## decisions\nwe use duckdb\n"

class Forms(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        write(os.path.join(self.d, "docs", "design.md"), DESIGN)
        write(os.path.join(self.d, "src", "main.ts"), "export const a = 1\n"); write(os.path.join(self.d, "src", "a.js"), "var a\n"); write(os.path.join(self.d, "src", "b.mjs"), "export {}\n")
    def tearDown(self): self.t.cleanup()

    def mat(self, note): return omissions.build_material_ex(note, [self.d])

    def test_standalone_js_mjs_ts_are_references_like_in_a_command(self):
        self.assertEqual(refs.direct_refs("see `src/main.ts`, `src/a.js` and `src/b.mjs`"), ["src/main.ts", "src/a.js", "src/b.mjs"])
        self.assertEqual(refs.direct_refs("run `node src/b.mjs --x`"), ["src/b.mjs"])
        m, man, why, _ = self.mat("see `src/main.ts`")
        self.assertIsNone(why); self.assertIn("export const a = 1", m); self.assertEqual(man[0]["ref"], "src/main.ts")

    def test_one_known_extension_list(self):
        for e in refs.KNOWN_EXTS: self.assertEqual(refs.direct_refs("`x/y.%s`" % e), ["x/y.%s" % e])
        self.assertEqual(refs.direct_refs("`x/y.pyc` `x/y.tsx`"), [])

    def test_annotated_forms_include_the_identical_whole_file_and_keep_the_original_ref(self):
        forms = ["`docs/design.md`", "`docs/design.md:120`", "`docs/design.md:10-20`", "`docs/design.md:3:5`", "`docs/design.md#decisions`", "`docs/design.md#L10-L20`", "[d](docs/design.md#decisions)", "[d](docs/design.md)", "`cat docs/design.md`"]
        bodies = set()
        for f in forms:
            m, man, why, _ = self.mat("see " + f); self.assertIsNone(why, f)
            self.assertEqual(len(man), 1, f); self.assertTrue(m.endswith(DESIGN + "\n=== END DIRECT REFERENCE ===\n"), f)
            bodies.add(m.split("\n", 1)[1].split("=== DIRECT REFERENCE", 1)[1].split("\n", 1)[1]);
            ref = man[0]["ref"]; self.assertIn(ref, f)                  # the reference as written, not the stripped file
            self.assertIn("=== DIRECT REFERENCE %s (sha256:" % ref, m)
        self.assertEqual(len(bodies), 1)

    def test_distinct_spellings_stay_distinct_references(self):
        self.assertEqual(refs.direct_refs("`docs/design.md` `docs/design.md:120` `docs/design.md#decisions` `docs/design.md`"), ["docs/design.md", "docs/design.md:120", "docs/design.md#decisions"])
        m, man, why, _ = self.mat("`docs/design.md:1` `docs/design.md#x`")
        self.assertEqual([x["ref"] for x in man], ["docs/design.md:1", "docs/design.md#x"]); self.assertEqual(m.count("=== DIRECT REFERENCE "), 2)

    def test_literal_special_character_filenames_win(self):
        write(os.path.join(self.d, "notes#1.md"), "literal hash\n"); write(os.path.join(self.d, "a:b.md"), "literal colon\n"); write(os.path.join(self.d, "notes.md"), "the stripped one\n")
        write(os.path.join(self.d, "x.md:12"), "literal line suffix\n")
        m, man, why, _ = self.mat("`notes#1.md` `a:b.md`"); self.assertIsNone(why)
        self.assertIn("literal hash", m); self.assertIn("literal colon", m); self.assertNotIn("the stripped one", m)
        m, man, why, _ = self.mat("`x.md:12`"); self.assertIn("literal line suffix", m)       # the literal file exists: no stripping
        m, man, why, _ = self.mat("`notes.md#top`"); self.assertIn("the stripped one", m)     # no literal file: the annotation is stripped

    def test_missing_local_file_with_an_annotation_blocks_and_names_the_reference(self):
        m, man, why, miss = self.mat("`docs/nope.md:7`")
        self.assertIsNone(m); self.assertIn("'docs/nope.md:7'", why); self.assertEqual(miss["ref"], "docs/nope.md:7"); self.assertEqual(miss["searched"][0], self.d); self.assertNotIn("kind", miss)

    def test_remote_links_are_unavailable_not_missing_local_files(self):
        for note in ("see [readme](https://github.com/org/repo/blob/main/README.md)", "see [readme](https://github.com/org/repo/blob/main/README.md#install)", "see `https://example.com/docs/guide.md`", "see [d](http://example.com/a.txt)"):
            self.assertTrue(refs.direct_refs(note), note)
            m, man, why, miss = self.mat(note)
            self.assertIsNone(m, note); self.assertIn("remote link", why); self.assertIn("not fetched", why); self.assertNotIn("cannot be resolved", why)
            self.assertEqual(miss["kind"], "remote_url"); self.assertEqual(miss["searched"], [])
        self.assertEqual(refs.resolve_info("https://example.com/a.md", [self.d])[0], None)

    def test_remote_link_blocks_even_when_a_local_file_of_that_name_exists(self):
        write(os.path.join(self.d, "README.md"), "local readme\n")
        m, _, why, miss = self.mat("see [readme](https://github.com/org/repo/blob/main/README.md)")
        self.assertIsNone(m); self.assertEqual(miss["kind"], "remote_url")

    def test_a_remote_link_that_is_not_a_file_reference_is_not_one(self):
        self.assertEqual(refs.direct_refs("see [site](https://example.com/page.html) and https://example.com/x.md in prose"), [])

    def test_references_stay_one_level(self):
        write(os.path.join(self.d, "docs", "inner.md"), "see `nested.md` and `docs/design.md#x`\n")
        m, man, why, _ = self.mat("`docs/inner.md`"); self.assertIsNone(why); self.assertEqual([x["ref"] for x in man], ["docs/inner.md"])

    def test_a_non_markdown_parenthesized_name_needs_the_link_syntax(self):
        self.assertEqual(refs.direct_refs("the helper (utils.py) and a [link](src/main.ts#L3) and (notes.md)"), ["src/main.ts#L3", "notes.md"])

    def test_material_of_notes_without_these_forms_is_unchanged(self):
        note = "- see `docs/design.md`, (docs/design.md) and run `python3 -B src/x.py`\n"
        write(os.path.join(self.d, "src", "x.py"), "print(1)\n")
        m, man, why, _ = self.mat(note); self.assertIsNone(why)
        self.assertEqual(m, omissions.material(note, [("docs/design.md", DESIGN), ("src/x.py", "print(1)\n")]))

    def test_excluded_policy_looks_at_the_stripped_name_too(self):
        write(os.path.join(self.d, ".env.md"), "KEY=1\n")
        m, _, why, miss = self.mat("`.env.md:3`"); self.assertIsNone(m); self.assertEqual(miss["kind"], "excluded")

if __name__ == "__main__": unittest.main()

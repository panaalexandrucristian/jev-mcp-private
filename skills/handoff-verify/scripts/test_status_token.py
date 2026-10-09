#!/usr/bin/env python3
"""Offline test of the status token rewrite of report.render_md (item 15; stdlib only, synthetic temp directories, no Jev call, never reads .handoff-verify/): only the MAIN status token that directly follows the
label (Stare|Stat|Status|Estado), with markdown emphasis allowed, is rewritten to the audited status; a later warning, condition, quotation or example, a fenced block and every line without such a token are kept;
`Stare: **PASS**` stays byte-identical when the status agrees; the persisted Markdown of write_report shows the status of the audited JSON, and the override and stale notices still agree.
usage: python3 -B test_status_token.py [-v]"""
import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import report
from test_versions_gate import Session, V1, EDITS

def render(text, final, **extra): return report.render_md(text, dict(status=final, **extra))

class Token(unittest.TestCase):
    def test_an_agreeing_status_line_is_byte_identical(self):
        for t in ("Stare: **PASS**\n", "Stare: **UNRESOLVED**\n", "Stare: **FAIL**", "# Raport\n\nStare: **PASS**\n\nRest.\n"):
            final = "PASS" if "PASS" in t else ("FAIL" if "FAIL" in t else "UNRESOLVED")
            self.assertEqual(render(t, final), t)

    def test_the_main_token_is_rewritten_and_the_negation_that_follows_is_kept(self):
        self.assertEqual(render("Stare: UNRESOLVED. Nu este PASS.\n", "UNRESOLVED"), "Stare: UNRESOLVED. Nu este PASS.\n")
        self.assertEqual(render("Stare: PASS. Nu este UNRESOLVED.\n", "UNRESOLVED"), "Stare: UNRESOLVED. Nu este UNRESOLVED.\n")
        self.assertEqual(render("Stare: UNRESOLVED. Nu este PASS.\n", "FAIL"), "Stare: FAIL. Nu este PASS.\n")

    def test_a_fail_summary_keeps_its_conditional_unresolved(self):
        t = "Stare: **FAIL**. Dacă absența nu depășește 0.95: UNRESOLVED, nu PASS.\n"
        self.assertEqual(render(t, "FAIL"), t)
        self.assertEqual(render(t, "UNRESOLVED"), "Stare: **UNRESOLVED**. Dacă absența nu depășește 0.95: UNRESOLVED, nu PASS.\n")

    def test_only_the_first_of_repeated_words_changes(self):
        self.assertEqual(render("Stare: PASS PASS PASS\n", "FAIL"), "Stare: FAIL PASS PASS\n")
        self.assertEqual(render("Stare: **PASS** (sau PASS, sau FAIL)\n", "UNRESOLVED"), "Stare: **UNRESOLVED** (sau PASS, sau FAIL)\n")

    def test_formatting_variations(self):
        cases = {"**Stare:** PASS": "**Stare:** FAIL", "- Status: `PASS`": "- Status: `FAIL`", "Estado — PASS": "Estado — FAIL", "STARE: PASS": "STARE: FAIL",
                 "## Stat: __PASS__ acum": "## Stat: __FAIL__ acum", "Stare : PASS": "Stare : FAIL", "Status - PASS": "Status - FAIL", "  Stare:   PASS  ": "  Stare:   FAIL  ", "Stare=PASS": "Stare=FAIL", "* **Stare**: **PASS**": "* **Stare**: **FAIL**"}
        for before, after in cases.items(): self.assertEqual(render(before + "\n", "FAIL"), after + "\n", before)

    def test_a_line_without_the_main_token_is_left_unchanged(self):
        for t in ("Stare finală: PASS", "Stare\n", "Stare: necunoscută, dar nu PASS", "Statistici: PASS", "Versiunea 1 — Stare: PASS", "Stare v1: PASS", "Nota spune Stare: PASS", "Stare: pass", "Stare: PASSED", "Stare: **", "Starea: PASS"):
            self.assertEqual(render(t + "\n", "FAIL"), t + "\n", t)

    def test_a_fenced_block_is_never_rewritten(self):
        t = "Stare: **PASS**\n\n```\nStare: PASS\nStatus: UNRESOLVED\n```\n\n~~~md\nStare: PASS\n~~~\n\nStare: PASS\n"
        self.assertEqual(render(t, "FAIL"), "Stare: **FAIL**\n\n```\nStare: PASS\nStatus: UNRESOLVED\n```\n\n~~~md\nStare: PASS\n~~~\n\nStare: PASS\n")      # (only the first status line of the report is its main status)
        self.assertEqual(render("```\nStare: PASS\n```\nStare: PASS\n", "FAIL"), "```\nStare: PASS\n```\nStare: FAIL\n")      # a fence is skipped, the first status line outside it is the main one

    def test_the_trailing_newline_and_other_lines_are_kept(self):
        self.assertEqual(render("a\nStare: PASS\nb", "FAIL"), "a\nStare: FAIL\nb"); self.assertEqual(render("a\nStare: PASS\nb\n", "FAIL"), "a\nStare: FAIL\nb\n")

CONTEXTS = ("# Raport de verificare\n\n> Stare: **PASS** — exemplu citat din ghid (nu e starea raportului)\n\nStare: **PASS**\n\nUn exemplu în text: `Stare: PASS`, apoi Stare: PASS pe linia următoare.\n`Stare: PASS` deschis cu ghilimele inverse.\n\n"
            "```\nStare: PASS\n```\n\n## Versiunea 1 (w1)\n\nStare: **PASS**\n\n### Detalii\n\nStatus: PASS\n\n> Stare: PASS\n\n## Concluzii\n\nStare: PASS (rezumat repetat)\nAvertisment: dacă o verificare scade, Stare: UNRESOLVED.\n")

def only_main(final):
    """CONTEXTS with exactly the main report status (the first line outside every quotation, example and per-version section) rewritten."""
    return CONTEXTS.replace("\nStare: **PASS**\n\nUn exemplu", "\nStare: **%s**\n\nUn exemplu" % final, 1)

class MainStatusOnly(unittest.TestCase):
    """Fix 5: a blockquoted example, an inline-code quotation, a fenced block, a per-version section and every later repetition are preserved; only the report's own status line changes."""
    def test_the_direct_renderer_rewrites_exactly_the_main_status_among_all_contexts_together(self):
        for final in ("FAIL", "UNRESOLVED"):
            with self.subTest(final): self.assertEqual(render(CONTEXTS, final), only_main(final))
        self.assertEqual(render(CONTEXTS, "PASS"), CONTEXTS)      # agreeing: byte-identical
        self.assertEqual(only_main("FAIL").count("Stare: **PASS**"), 2)      # the blockquoted example and the per-version status are the two bold statuses that stay

    def test_each_context_alone_is_never_the_main_status(self):
        for name, t in (("blockquote", "> Stare: **PASS**\n"), ("nested blockquote", ">> Stare: PASS\n"), ("blockquote with a list marker", "> - Stare: PASS\n"), ("inline code, opening", "`Stare: PASS` este exemplul\n"), ("inline code after a marker", "- `Stare: PASS`\n"),
                        ("fence", "```\nStare: PASS\n```\n"), ("per-version section", "## Versiunea 2\nStare: PASS\n"), ("per-version section, English", "### Version 3\nStare: PASS\n"), ("the heading is itself a status of a version", "## Versiunea 1 — Stare: PASS\n")):
            with self.subTest(name): self.assertEqual(render(t, "FAIL"), t)
        self.assertEqual(render("## Versiunea 1\nStare: PASS\n\n# Concluzie\n\nStare: PASS\n", "FAIL"), "## Versiunea 1\nStare: PASS\n\n# Concluzie\n\nStare: FAIL\n")      # a heading of the same or a higher level ends the section

    def test_the_recalculated_and_stale_notices_and_the_exact_cases_survive(self):
        doc = dict(status="UNRESOLVED", status_claimed="PASS", binding_summary=dict(reasons=["audit incomplete"]), delivery=dict(stale=dict(report_version=1, report_sha256="a" * 64, newer_version=2, newer_sha256="b" * 64)))
        out = report.render_md(CONTEXTS, doc); self.assertTrue(out.startswith("Atenție: acest raport este despre versiunea 1")); self.assertIn("> Stare finală (recalculată de report.py din legăturile verificare→apel Jev): **UNRESOLVED**; declarată inițial: PASS. Motiv: audit incomplete.\n\n", out)
        self.assertTrue(out.endswith(only_main("UNRESOLVED"))); self.assertEqual(render("Stare: UNRESOLVED. Nu este PASS.\n", "UNRESOLVED"), "Stare: UNRESOLVED. Nu este PASS.\n")
        t = "Stare: **FAIL**. Dacă absența nu depășește 0.95: UNRESOLVED, nu PASS.\n"; self.assertEqual(render(t, "FAIL"), t)

QUOTED = ("# Raport de verificare\n\nCum arată o stare în ghid:\n\n\"Stare: **PASS**\"\n\n'Stare: PASS'\n\n\u201eStare: PASS\u201d, \u00abStare: PASS\u00bb, \u2018Stare: PASS\u2019\n\n    Stare: PASS\n\n\tStatus: PASS\n\n<!-- Stare: PASS -->\n\n| Stare: PASS |\n\n"
          "## Exemple\n\nStare: **PASS** (exemplu)\n\n### Exemplu de avertisment\n\nStatus: UNRESOLVED\n\n## Example\n\nStare: PASS\n\n## Rezumat\n\nStare: **PASS**\n\n   Stare: PASS (a doua linie, nu e starea principală)\n\n## Versiunea 1\n\nStare: **PASS**\n")

def only_quoted_main(final): return QUOTED.replace("## Rezumat\n\nStare: **PASS**", "## Rezumat\n\nStare: **%s**" % final, 1)

class QuotationsExamplesAndCode(unittest.TestCase):
    """Round 3, fix 4. THE RULE (reference/report.md "Output", report.rewrite_status_lines): the main status line is the first line whose label is at the start of the line, preceded by nothing but up to three spaces, a heading marker, a list marker and markdown emphasis,
    outside a fence, a blockquote, inline code, an indented code block, a table cell, an HTML comment, a quotation, and not under a per-version or an example heading. Quotations, examples and code are preserved byte for byte."""
    def test_every_quotation_example_and_code_context_before_the_summary_is_kept_and_only_the_summary_changes(self):
        for final in ("FAIL", "UNRESOLVED"):
            with self.subTest(final): self.assertEqual(render(QUOTED, final), only_quoted_main(final))
        self.assertEqual(render(QUOTED, "PASS"), QUOTED); self.assertEqual(only_quoted_main("FAIL").count("Stare: PASS"), QUOTED.count("Stare: PASS"))

    def test_each_context_alone_is_never_the_main_status(self):
        cases = (("double-quoted", '"Stare: **PASS**"\n'), ("single-quoted", "'Stare: PASS'\n"), ("curly quotes", "\u201eStare: PASS\u201d\n"), ("guillemets", "\u00abStare: PASS\u00bb\n"), ("curly single", "\u2018Stare: PASS\u2019\n"),
                 ("four spaces", "    Stare: PASS\n"), ("five spaces", "     Stare: **PASS**\n"), ("a tab", "\tStare: PASS\n"), ("four spaces after a paragraph", "text\n\n    Status: PASS\n"), ("an HTML comment", "<!-- Stare: PASS -->\n"), ("a table cell", "| Stare: PASS |\n"),
                 ("example heading", "## Exemplu\nStare: PASS\n"), ("example heading, English", "### Example output\nStare: PASS\n"), ("example heading, Spanish", "## Ejemplo\nEstado: PASS\n"), ("examples, plural", "## Exemple de stare\nStare: PASS\n"),
                 ("example under the summary heading", "# Raport\n## Exemplu\n### Detalii\nStare: PASS\n"))
        for name, t in cases:
            with self.subTest(name): self.assertEqual(render(t, "FAIL"), t)

    def test_what_still_is_the_main_status(self):
        for before, after in (("   Stare: PASS", "   Stare: FAIL"), ("  - Status: PASS", "  - Status: FAIL"), ("## Stare: PASS", "## Stare: FAIL"), ("* **Stare**: **PASS**", "* **Stare**: **FAIL**"), ("~~Stare: PASS~~", "~~Stare: FAIL~~")):
            with self.subTest(before): self.assertEqual(render(before + "\n", "FAIL"), after + "\n")
        self.assertEqual(render("## Exemplu\nStare: PASS\n\n## Rezumat\nStare: PASS\n", "FAIL"), "## Exemplu\nStare: PASS\n\n## Rezumat\nStare: FAIL\n")      # a heading of the same level ends the example section
        self.assertEqual(render("# Raport\n## Exemplu\nStare: PASS\n# Concluzie\nStare: PASS\n", "FAIL"), "# Raport\n## Exemplu\nStare: PASS\n# Concluzie\nStare: FAIL\n")      # so does a higher one
        self.assertEqual(render("## Versiunea 1\n### Exemplu\n#### Detalii\nStare: PASS\n### Alt\nStare: PASS\n## Concluzie\nStare: PASS\n", "FAIL"), "## Versiunea 1\n### Exemplu\n#### Detalii\nStare: PASS\n### Alt\nStare: PASS\n## Concluzie\nStare: FAIL\n")      # nested sections: the end of the inner one does not end the outer one

    def test_the_notices_and_the_exact_cases_survive_together_with_the_new_contexts(self):
        doc = dict(status="UNRESOLVED", status_claimed="PASS", binding_summary=dict(reasons=["audit incomplete"]), delivery=dict(stale=dict(report_version=1, report_sha256="a" * 64, newer_version=2, newer_sha256="b" * 64)))
        out = report.render_md(QUOTED, doc); self.assertTrue(out.startswith("Atenție: acest raport este despre versiunea 1")); self.assertTrue(out.endswith(only_quoted_main("UNRESOLVED"))); self.assertIn("declarată inițial: PASS. Motiv: audit incomplete.", out)
        self.assertEqual(render("Stare: UNRESOLVED. Nu este PASS.\n", "UNRESOLVED"), "Stare: UNRESOLVED. Nu este PASS.\n"); t = "Stare: **FAIL**. Dacă absența nu depășește 0.95: UNRESOLVED, nu PASS.\n"; self.assertEqual(render(t, "FAIL"), t)
        self.assertEqual(render("```\nStare: PASS\n```\n\"Stare: PASS\"\nStare: PASS\n", "FAIL"), "```\nStare: PASS\n```\n\"Stare: PASS\"\nStare: FAIL\n")

class Persisted(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.s = Session(self.tmp.name)

    def test_the_markdown_written_by_write_report_shows_the_status_of_the_audited_json(self):
        s = self.s; s.write_v1(); s.jev(); s.save(); s.disk(V1)
        md, doc, _ = s.write_report(s.doc(1))
        self.assertEqual(doc["status"], "UNRESOLVED"); self.assertEqual(doc["status_claimed"], "PASS")   # realistic response: the strict conditions cannot be met
        self.assertIn("\nStare: **UNRESOLVED**\n", "\n" + md.split("\n\n", 1)[1]); self.assertTrue(md.startswith("> Stare finală"))
        self.assertIn("**UNRESOLVED**; declarată inițial: PASS", md)

    def test_free_text_after_the_main_token_survives_the_persisted_rewrite(self):
        s = self.s; s.write_v1(); s.jev(); s.save(); s.disk(V1)
        rd = os.path.join(self.tmp.name, "r2"); os.makedirs(rd)
        import report as R
        md, js = R.write_report(rd, s.handoff, s.doc(1), "Stare: **PASS**. Dacă verificarea nu trece: UNRESOLVED, nu PASS.\n", calls_jsonl=s.log)
        text = open(os.path.join(rd, md), encoding="utf-8").read(); doc = json.load(open(os.path.join(rd, js)))
        self.assertIn("Stare: **UNRESOLVED**. Dacă verificarea nu trece: UNRESOLVED, nu PASS.\n", text); self.assertEqual(doc["status"], "UNRESOLVED")

    def test_write_report_rewrites_only_the_main_status_of_a_document_with_every_context(self):
        s = self.s; s.write_v1(); s.jev(); s.save(); s.disk(V1)
        rd = os.path.join(self.tmp.name, "r3"); os.makedirs(rd)
        md, js = report.write_report(rd, s.handoff, s.doc(1), CONTEXTS, calls_jsonl=s.log); text = open(os.path.join(rd, md), encoding="utf-8").read(); doc = json.load(open(os.path.join(rd, js)))
        self.assertEqual(doc["status"], "UNRESOLVED"); self.assertTrue(text.endswith(only_main("UNRESOLVED"))); self.assertTrue(text.startswith("> Stare finală (recalculată")); self.assertIn("> Stare: **PASS** — exemplu citat", text); self.assertIn("## Versiunea 1 (w1)\n\nStare: **PASS**", text)

    def test_write_report_keeps_every_quotation_example_and_code_context_and_rewrites_only_the_summary(self):
        s = self.s; s.write_v1(); s.jev(); s.save(); s.disk(V1)
        rd = os.path.join(self.tmp.name, "r4"); os.makedirs(rd)
        md, js = report.write_report(rd, s.handoff, s.doc(1), QUOTED, calls_jsonl=s.log); text = open(os.path.join(rd, md), encoding="utf-8").read(); doc = json.load(open(os.path.join(rd, js)))
        self.assertEqual(doc["status"], "UNRESOLVED"); self.assertTrue(text.startswith("> Stare finală (recalculată")); self.assertTrue(text.endswith(only_quoted_main("UNRESOLVED")))
        self.assertEqual([l for l in text.splitlines() if l.startswith("Stare: **UNRESOLVED**")], ["Stare: **UNRESOLVED**"])
        for kept in ('"Stare: **PASS**"', "'Stare: PASS'", "\n    Stare: PASS\n", "\n\tStatus: PASS\n", "<!-- Stare: PASS -->", "## Exemple\n\nStare: **PASS** (exemplu)"): self.assertIn(kept, text)

    def test_the_override_and_the_stale_notices_agree_with_the_status_line(self):
        s = self.s; s.write_v1(); s.jev(); s.edit(0); s.edit(1); s.save(); s.disk(V1 .replace("beta", "gamma").replace("alpha", "delta"))
        md, doc, _ = s.write_report(s.doc(1))
        final = doc["status"]; self.assertEqual(final, "UNRESOLVED")
        self.assertTrue(md.startswith("Atenție: acest raport este despre versiunea 1")); self.assertIn("> Stare finală (recalculată de report.py din legăturile verificare→apel Jev): **%s**; declarată inițial: PASS" % final, md)
        status_lines = [l for l in md.splitlines() if l.startswith("Stare:")]; self.assertEqual(status_lines, ["Stare: **%s**" % final])

if __name__ == "__main__": unittest.main()

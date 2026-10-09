#!/usr/bin/env python3
"""Offline regressions of the quoted-value boundary of the secret policy (stdlib + git, no Jev call): a quoted credential is redacted WHOLE however long it is and wherever it spans -- past 2000 characters, past a
literal newline, unterminated -- in the shared sanitizer, the preparation copies, the canonical omission payload, the validator re-derivation and the diagnostics; a quote that never closes redacts to the end of the text
(fail closed); ordinary clean text stays byte-identical and the policy stays idempotent and linear.
usage: python3 -B test_boundary_secrets.py [-v]"""
import json, os, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, prepare, sanitize as S, scope, versions
from test_sanitize_secrets import write, session, tool_pair

CANARY = "Zq" + "8f" + "Lm3" + "Xv9"
PAD = "a " * 1100                                                   # 2200 characters: the canary lies AFTER the old 2000-character bound
FORMS = [
    ("json padded value", json.dumps({"password": PAD + CANARY, "k": "v"}), CANARY),
    ("doubly encoded padded value", json.dumps(json.dumps({"password": PAD + CANARY})), CANARY),
    ("unterminated padded assignment", 'PASSWORD="' + PAD + CANARY, CANARY),
    ("unterminated single-quoted assignment", "DB_PASSWORD='" + PAD + CANARY, CANARY),
    ("multiline quoted value", 'PASSWORD="first line\n' + CANARY + ' more" tail', CANARY),
    ("multiline single-quoted value", "API_KEY='first line\n\n" + CANARY + "'\nnext", CANARY),
    ("canary right after a newline", 'PASSWORD="abcdefgh\n' + CANARY, CANARY),
    ("unterminated then a later line", 'PASSWORD="abcdefgh\nmore\n' + PAD + "\n" + CANARY, CANARY),
    ("command with a long value", json.dumps({"command": 'export DB_PASSWORD="' + PAD + CANARY + '" && run'}), CANARY),
]

class Sanitizer(unittest.TestCase):
    def test_the_value_is_redacted_whole(self):
        for name, text, secret in FORMS:
            out, rep = S.sanitize(text)
            self.assertNotIn(secret, out, name); self.assertNotIn("a a a a", out, name)
            self.assertTrue(rep["redactions"], name); self.assertEqual(S.sanitize(out)[0], out, name)              # idempotent
            self.assertTrue(S.sanitize_material(text)[1]["redaction_dependent"], name)

    def test_the_structure_around_a_terminated_value_survives(self):
        out = S.sanitize(json.dumps({"password": PAD + CANARY, "k": "v"}))[0]
        self.assertEqual(json.loads(out), {"password": "[REDACTED:assignment]", "k": "v"})
        self.assertEqual(S.sanitize('PASSWORD="first line\n' + CANARY + ' more" tail')[0], 'PASSWORD="[REDACTED:assignment]" tail')

    def test_an_unterminated_quote_redacts_to_the_end_and_keeps_the_head(self):
        out = S.sanitize('before\nPASSWORD="abcdefgh\nmore\n' + CANARY)[0]
        self.assertEqual(out, 'before\nPASSWORD="[REDACTED:assignment]')

    def test_clean_text_stays_byte_identical(self):
        for t in ('{"password": ""}', '{"password": "short"}', "TOKEN='abc' and more", "line one\nline two \"quoted\" and 'single'\n" * 400, "max_tokens: 4096\n" + "x " * 3000,
                  json.dumps({"description": PAD + CANARY}), 'the password policy says "rotate often" (see docs)'):
            self.assertEqual(S.sanitize(t)[0], t)

    def test_recognition_is_linear(self):
        t0 = time.time()
        for t in ("TOKEN='ab' " * 30000, 'PASSWORD="' * 30000, 'API_KEY="' + 'x' * 400000, '"password": "' + '\\"' * 100000):
            S.sanitize(t)
        self.assertLess(time.time() - t0, 20)

class Preparation(unittest.TestCase):
    def test_preparation_copies_redact_the_boundary_forms(self):
        for name, text, secret in FORMS:
            self.assertNotIn(secret, prepare.S.sanitize(text)[0], name)

class Payloads(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "session.jsonl"); self.cwd0 = os.getcwd()

    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def material(self):
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        return omissions.context(self.log, canon, vs[0], "prefix", omissions.material_bases(self.note, vs[0]))

    def test_note_with_the_boundary_forms_is_never_ready_and_rederivation_agrees(self):
        for name, secret_text, secret in FORMS:
            text = "- the migration is done\n%s\n" % secret_text
            write(self.note, text); session(self.log, self.note, text)
            ctx = self.material()
            self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)
            os.chdir(self.d)
            vs, _, _, _ = versions.versions_of(self.log, self.note)
            rows = versions.bind_versions([dict(version_ref=versions.version_ref(vs[0], "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
            self.assertIsNone(rows["k"]["omission"]["material"], name); self.assertNotIn(secret, json.dumps(rows["k"]["omission"]), name)

    def test_reference_with_the_boundary_forms_is_never_ready(self):
        for name, secret_text, secret in FORMS:
            text = "- the migration is done, see `ref.md`\n"
            write(self.note, text); write(os.path.join(self.d, "ref.md"), "notes\n%s\n" % secret_text); session(self.log, self.note, text)
            ctx = self.material(); self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)

    def test_source_records_with_the_boundary_forms_are_sanitized(self):
        write(self.note, "- done\n")
        for name, secret_text, secret in FORMS:
            session(self.log, self.note, "- done\n", extra=tool_pair(2, "run", secret_text))
            ctx = self.material(); self.assertNotIn(secret, json.dumps(ctx), name)

class Diagnostics(unittest.TestCase):
    def test_rejected_exclusion_detail_is_not_echoed(self):
        for name, text, secret in FORMS:
            e = dict(detail=text, jev_ref=dict(tool_use_id="c", result_index=0, key="d1"), classification="out_of_scope", confidence=0.999)
            r = scope.validate_exclusions([e], [], "/nonexistent.jsonl")
            self.assertEqual(r["invalid"], 1, name); self.assertNotIn(secret, json.dumps(r), name)

if __name__ == "__main__": unittest.main()

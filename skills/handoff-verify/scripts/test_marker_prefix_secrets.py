#!/usr/bin/env python3
"""Offline regressions of the marker-prefix gap of the secret policy (stdlib + git, no Jev call): an earlier redaction pass (or a marker already in the text) turns the head of a credential value into a `[REDACTED:...]`
marker; the assignment, the URL password and the bearer rules must not skip such a value, or the secret that follows the marker stays behind. The WHOLE value goes (multiline, encoded and unquoted forms included), in the
sanitizer, the preparation copies, the canonical omission payload, the validator re-derivation and the diagnostics; a value that is only a marker is kept (idempotent); clean text is byte-identical.
usage: python3 -B test_marker_prefix_secrets.py [-v]"""
import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, prepare, sanitize as S, scope, versions
from test_sanitize_secrets import write, session, tool_pair

CANARY = "Zq" + "8f" + "Lm3" + "Xv9"
SK = "sk-" + "A" * 24
GH = "ghp_" + "B" * 24
FORMS = [
    ("existing marker prefix", 'PASSWORD="[REDACTED:openai_key] ' + CANARY + ' more" tail', CANARY),
    ("existing assignment marker prefix", 'API_KEY="[REDACTED:assignment]' + CANARY + '"', CANARY),
    ("openai prefix then fake secret", 'API_KEY="' + SK + " " + CANARY + '" tail', CANARY),
    ("github prefix then fake secret", "TOKEN='" + GH + " " + CANARY + " more' tail", CANARY),
    ("multiline after a token prefix", 'PASSWORD="' + SK + "\nsecond line\n" + CANARY + '" tail', CANARY),
    ("multiline after an existing marker", 'SECRET_KEY="[REDACTED:github_token]\n' + CANARY + '"', CANARY),
    ("unterminated after a token prefix", 'PASSWORD="' + GH + " " + CANARY, CANARY),
    ("json encoded", json.dumps({"password": SK + " " + CANARY}), CANARY),
    ("json encoded multiline", json.dumps({"api_key": GH + "\n" + CANARY, "k": "v"}), CANARY),
    ("doubly encoded", json.dumps(json.dumps({"password": SK + " " + CANARY})), CANARY),
    ("command with an encoded value", json.dumps({"command": 'export DB_PASSWORD="' + SK + " " + CANARY + '" && run'}), CANARY),
    ("unquoted token then suffix", "API_KEY=" + SK + "." + CANARY, CANARY),
    ("unquoted marker then suffix", "TOKEN=[REDACTED:openai_key]." + CANARY, CANARY),
    ("url password token then suffix", "see https://user:" + SK + "." + CANARY + "@host/path", CANARY),
    ("url password marker then suffix", "see https://user:[REDACTED:openai_key]" + CANARY + "@host/path", CANARY),
    ("bearer token then suffix", "Authorization: Bearer " + SK + "." + CANARY, CANARY),
]

class Sanitizer(unittest.TestCase):
    def test_no_suffix_of_the_value_stays(self):
        for name, text, secret in FORMS:
            out, rep = S.sanitize(text)
            self.assertNotIn(secret, out, name); self.assertTrue(rep["redactions"], name); self.assertEqual(S.sanitize(out)[0], out, name)            # idempotent
            self.assertTrue(S.sanitize_material(text)[1]["redaction_dependent"], name)

    def test_the_structure_around_the_value_survives(self):
        self.assertEqual(S.sanitize('PASSWORD="' + SK + " " + CANARY + '" tail')[0], 'PASSWORD="[REDACTED:assignment]" tail')
        self.assertEqual(json.loads(S.sanitize(json.dumps({"api_key": GH + "\n" + CANARY, "k": "v"}))[0]), {"api_key": "[REDACTED:assignment]", "k": "v"})

    def test_a_value_that_is_only_a_marker_is_kept(self):
        for t in ('PASSWORD="[REDACTED:assignment]"', "API_KEY=[REDACTED:openai_key]", 'TOKEN="[REDACTED:github_token]" and more', "https://user:[REDACTED:url_userinfo]@host/", json.dumps({"password": "[REDACTED:ambiguous]"})):
            self.assertEqual(S.sanitize(t)[0], t, t)
        out = S.sanitize('PASSWORD="' + SK + '"')[0]; self.assertEqual(out, 'PASSWORD="[REDACTED:openai_key]"'); self.assertEqual(S.sanitize(out)[0], out)

    def test_clean_text_stays_byte_identical(self):
        for t in ('{"password": ""}', "TOKEN='abc' and more", 'the password policy says "rotate often"', "max_tokens: 4096", "https://user@host/path", "see https://host/a:b@c",
                  "line\n" * 500):
            self.assertEqual(S.sanitize(t)[0], t)

class Preparation(unittest.TestCase):
    def test_preparation_copies_redact_the_forms(self):
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

    def test_note_with_the_forms_is_never_ready_and_rederivation_agrees(self):
        for name, secret_text, secret in FORMS:
            text = "- the migration is done\n%s\n" % secret_text
            write(self.note, text); session(self.log, self.note, text)
            ctx = self.material(); self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)
            os.chdir(self.d)
            vs, _, _, _ = versions.versions_of(self.log, self.note)
            rows = versions.bind_versions([dict(version_ref=versions.version_ref(vs[0], "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
            self.assertIsNone(rows["k"]["omission"]["material"], name); self.assertNotIn(secret, json.dumps(rows["k"]["omission"]), name)

    def test_reference_with_the_forms_is_never_ready(self):
        for name, secret_text, secret in FORMS:
            text = "- the migration is done, see `ref.md`\n"
            write(self.note, text); write(os.path.join(self.d, "ref.md"), "notes\n%s\n" % secret_text); session(self.log, self.note, text)
            ctx = self.material(); self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)

    def test_source_records_with_the_forms_are_sanitized(self):
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

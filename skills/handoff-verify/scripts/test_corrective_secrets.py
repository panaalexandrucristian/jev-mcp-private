#!/usr/bin/env python3
"""Offline regressions of the council corrections to the secret policy (stdlib + git, no Jev call): short Basic credentials and bounded quoted / JSON-escaped assignment values (embedded spaces, escaped
quotes) are redacted whole -- in the shared sanitizer, the preparation copies, the canonical payloads and the validator re-derivation --; the diagnostics that leave the validators and the identity fields that
leave the preparation (resolved paths, locations) never carry a secret; clean output stays byte-identical.
usage: python3 -B test_corrective_secrets.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, prepare, sanitize as S, scope, versions
from test_sanitize_secrets import write, session, tool_pair, ENV, QUOTE, SHA, UUID

CANARY = "Zq" + "8f" + "Lm3" + "Xv9"
SECRET_FORMS = [
    ("basic short", 'Authorization: Basic dTpw', "dTpw"),
    ("basic short quoted", json.dumps({"Authorization": "Basic dTpw"}), "dTpw"),
    ("basic curl", 'curl -H "Authorization: Basic dTpw" https://x.example.com', "dTpw"),
    ("json escaped quote", json.dumps({"password": 'Ab"%s' % CANARY}), CANARY),
    ("json embedded space", json.dumps({"password": "Ab %s" % CANARY}), CANARY),
    ("json space and quote", json.dumps({"api_key": 'my "pass" %s end' % CANARY}), CANARY),
    ("doubly encoded quote", json.dumps(json.dumps({"password": 'Ab"%s' % CANARY})), CANARY),
    ("doubly encoded space", json.dumps(json.dumps({"password": "Ab %s" % CANARY})), CANARY),
    ("single quoted space", "DB_PASSWORD='Ab %s'" % CANARY, CANARY),
    ("env assignment in command", json.dumps({"command": 'export DB_PASSWORD="Ab %s" && run' % CANARY}), CANARY),
    ("escaped backslash end", json.dumps({"password": "Ab%s\\" % CANARY}), CANARY),
]

class Sanitizer(unittest.TestCase):
    def test_forms_are_redacted_whole(self):
        for name, text, secret in SECRET_FORMS:
            out, rep = S.sanitize(text)
            self.assertNotIn(secret, out, name); self.assertNotIn("Ab", out.replace("Authorization", "").replace("Basic", ""), name) if "Ab" in text else None
            self.assertTrue(rep["redactions"], name)
            self.assertEqual(S.sanitize(out)[0], out, name)                    # idempotent
            self.assertTrue(S.sanitize_material(text)[1]["redaction_dependent"], name)

    def test_the_structure_around_the_secret_survives(self):
        out = S.sanitize(json.dumps({"password": 'Ab"%s' % CANARY, "name": "x"}))[0]
        self.assertEqual(json.loads(out), {"password": "[REDACTED:assignment]", "name": "x"})
        out = S.sanitize(json.dumps({"command": 'export DB_PASSWORD="Ab %s" && run' % CANARY}))[0]
        self.assertEqual(json.loads(out)["command"], 'export DB_PASSWORD="[REDACTED:assignment]" && run')

    def test_near_misses_stay(self):
        for t in ("Authorization: Basic ab", "Authorization: Basic ab12", "the Basic idea", 'Authorization: Basic', '{"password": ""}', '{"password": "short"}',
                  "max_tokens: 4096", '{"token_count": 12}', "password policy: see docs", "commit %s %s" % (SHA, UUID),
                  json.dumps({"description": "Ab %s" % CANARY})):
            self.assertEqual(S.sanitize(t)[0], t, t)

    def test_two_secrets_on_one_line_do_not_merge(self):
        out = S.sanitize(json.dumps({"password": "Ab %s" % CANARY, "keep": "visible", "api_key": 'x"%s2' % CANARY}))[0]
        self.assertIn('"keep": "visible"', out); self.assertNotIn(CANARY, out)

    def test_unterminated_quote_does_not_hang_or_leak_the_head(self):
        out = S.sanitize('{"password": "Ab %s %s' % (CANARY, "x" * 5000))[0]
        self.assertNotIn(CANARY, out)

class Preparation(unittest.TestCase):
    def test_preparation_copies_redact_the_forms(self):
        for name, text, secret in SECRET_FORMS:
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
        for name, secret_text, secret in SECRET_FORMS:
            text = "- the migration is done\n%s\n" % secret_text
            write(self.note, text); session(self.log, self.note, text)
            ctx = self.material()
            self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)
            os.chdir(self.d)
            vs, _, _, _ = versions.versions_of(self.log, self.note)
            rows = versions.bind_versions([dict(version_ref=versions.version_ref(vs[0], "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
            self.assertIsNone(rows["k"]["omission"]["material"], name); self.assertNotIn(secret, json.dumps(rows["k"]["omission"]), name)

    def test_reference_with_the_forms_is_never_ready(self):
        for name, secret_text, secret in SECRET_FORMS:
            text = "- the migration is done, see `ref.md`\n"
            write(self.note, text); write(os.path.join(self.d, "ref.md"), "notes\n%s\n" % secret_text); session(self.log, self.note, text)
            ctx = self.material(); self.assertIsNone(ctx["material"], name); self.assertNotIn(secret, json.dumps(ctx), name)

    def test_source_records_with_the_forms_are_sanitized(self):
        write(self.note, "- done\n")
        for name, secret_text, secret in SECRET_FORMS:
            session(self.log, self.note, "- done\n", extra=tool_pair(2, "run", secret_text))
            ctx = self.material(); self.assertNotIn(secret, json.dumps(ctx), name)

class Diagnostics(unittest.TestCase):
    def test_rejected_exclusion_detail_is_not_echoed(self):
        detail = "rotate DB_PASSWORD=%s now" % CANARY
        e = dict(detail=detail, jev_ref=dict(tool_use_id="c", result_index=0, key="d1"), classification="out_of_scope", confidence=0.999)
        r = scope.validate_exclusions([e], [], "/nonexistent.jsonl")
        self.assertEqual(r["invalid"], 1); self.assertNotIn(CANARY, json.dumps(r))
        e["detail"] = json.dumps({"password": 'Ab"%s' % CANARY}); r = scope.validate_exclusions([e], [], "/nonexistent.jsonl"); self.assertNotIn(CANARY, json.dumps(r))

    def test_clean_exclusion_detail_is_echoed_unchanged(self):
        e = dict(detail="a  plain detail", jev_ref=dict(tool_use_id="c", result_index=0, key="d1"), classification="out_of_scope", confidence=0.999)
        r = scope.validate_exclusions([e], [], "/nonexistent.jsonl"); self.assertEqual(r["reasons"][0]["detail"], "a  plain detail")

class Identity(unittest.TestCase):
    """The identity fields that leave the preparation (resolved paths, locations) are checked as the payload is: no secret in them, else the material is not ready."""
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "session.jsonl"); self.cwd0 = os.getcwd()

    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def material(self):
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        return omissions.context(self.log, canon, vs[0], "prefix", omissions.material_bases(self.note, vs[0]))

    def test_reference_resolving_to_a_secret_bearing_path_is_not_ready(self):
        sub = os.path.join(self.d, "DB_PASSWORD=%s" % CANARY); os.makedirs(sub)
        write(os.path.join(sub, "real.md"), "safe content\n")
        os.symlink(os.path.join(sub, "real.md"), os.path.join(self.d, "safe.md"))
        text = "- the work is done, see `safe.md`\n"
        write(self.note, text); session(self.log, self.note, text)
        ctx = self.material()
        self.assertIsNone(ctx["material"]); self.assertNotIn(CANARY, json.dumps(ctx))
        self.assertEqual((ctx.get("missing_reference") or {}).get("kind"), "redaction")

    def test_symlink_target_with_the_forms_in_its_name(self):
        sub = os.path.join(self.d, json.dumps({"password": "Ab %s" % CANARY}).replace("/", "_")); os.makedirs(sub)
        write(os.path.join(sub, "real.md"), "safe content\n")
        os.symlink(os.path.join(sub, "real.md"), os.path.join(self.d, "safe.md"))
        text = "- the work is done, see `safe.md`\n"
        write(self.note, text); session(self.log, self.note, text)
        ctx = self.material(); self.assertIsNone(ctx["material"]); self.assertNotIn(CANARY, json.dumps(ctx))

    def test_clean_symlink_reference_is_ready_and_unchanged(self):
        write(os.path.join(self.d, "real.md"), "safe content\n"); os.symlink(os.path.join(self.d, "real.md"), os.path.join(self.d, "safe.md"))
        text = "- the work is done, see `safe.md`\n"
        write(self.note, text); session(self.log, self.note, text)
        ctx = self.material(); self.assertIsNotNone(ctx["material"]); self.assertIn("safe content", ctx["material"])

    def test_secret_bearing_location_is_not_echoed_by_the_cli(self):
        sub = os.path.join(self.d, "DB_PASSWORD=%s" % CANARY); os.makedirs(sub)
        text = "- done\n"; write(self.note, text); session(self.log, self.note, text)
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix",
                            "--detail", QUOTE, "--source-quote", QUOTE, "--location", sub], cwd=self.d, capture_output=True, text=True, env=ENV)
        self.assertNotEqual(p.returncode, 0); self.assertNotIn(CANARY, p.stdout); self.assertNotIn(CANARY, p.stderr)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline test of the shared sanitization policy (stdlib + git, no Jev call): the demonstrable credential forms (JSON-quoted and JSON-escaped assignments, URL userinfo, Basic authorization) are redacted, ordinary
identifiers are not, the policy is idempotent, and the canonical omission material / source passage / scope context are built from it: a canary never reaches a Jev-ready payload, an ambiguous or
redaction-dependent payload is UNRESOLVED (fail closed, never raw text), preparation and re-derivation agree, and clean material is unchanged.
usage: python3 -B test_sanitize_secrets.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, sanitize as S, scope, versions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
CANARY = "Zq" + "8f" + "Lm3" + "Xv9"                     # assembled at run time: a fake value, never a literal that looks like a real credential
CANARY2 = "Tr" + "5k" + "Wp2" + "Nd7"
SHA = "0123456789abcdef0123456789abcdef01234567"
UUID = "123e4567-e89b-12d3-a456-426614174000"

class Forms(unittest.TestCase):
    def clean(self, text): return S.sanitize(text)[0]

    def test_json_quoted_api_key(self):
        out = self.clean('{"API_KEY": "%s", "name": "x"}' % CANARY)
        self.assertNotIn(CANARY, out); self.assertIn('"API_KEY": "[REDACTED:assignment]"', out); self.assertIn('"name": "x"', out)

    def test_escaped_quoted_assignment_in_an_encoded_command(self):
        enc = json.dumps({"command": 'export API_KEY="%s" && run.sh' % CANARY})
        out = self.clean(enc)
        self.assertNotIn(CANARY, out); self.assertEqual(json.loads(out)["command"], 'export API_KEY="[REDACTED:assignment]" && run.sh')

    def test_doubly_escaped_json_key_and_value(self):
        enc = json.dumps(json.dumps({"password": CANARY}))
        out = self.clean(enc); self.assertNotIn(CANARY, out); self.assertIn("[REDACTED:assignment]", out)

    def test_value_with_a_backslash_is_redacted_whole(self):
        out = self.clean("DB_PASSWORD=%s\\%s end" % (CANARY, CANARY2)); self.assertNotIn(CANARY2, out); self.assertNotIn(CANARY, out)

    def test_url_userinfo_password_only(self):
        out = self.clean("clone https://deploy:%s@git.example.com/org/repo.git now" % CANARY)
        self.assertEqual(out, "clone https://deploy:[REDACTED:url_userinfo]@git.example.com/org/repo.git now")

    def test_url_without_a_password_is_untouched(self):
        for t in ("https://user@host.example.com/x", "https://host.example.com:8080/path@x", "git@github.com:org/repo.git", "user@example.com",
                  "https://github.com/org/repo/commit/abc1234", "http://localhost:3000/"):
            self.assertEqual(self.clean(t), t, t)

    def test_basic_authorization(self):
        for t in ('curl -H "Authorization: Basic %s" https://x.example.com', "authorization: basic %s", '{"Authorization": "Basic %s"}',
                  json.dumps({"command": 'curl -H "Authorization: Basic %s"'})):
            v = "dXNlcjpwYXNzd29yZA=="; out = self.clean(t % v)
            self.assertNotIn(v, out, t); self.assertIn("[REDACTED:basic_auth]", out)
        self.assertEqual(self.clean("the Basic idea is simple"), "the Basic idea is simple")
        self.assertEqual(self.clean("Authorization: Basic ab"), "Authorization: Basic ab")

    def test_ordinary_identifiers_are_not_redacted(self):
        text = ("commit %s and %s, file src/auth/token_store.py, https://github.com/org/repo/commit/%s, tokens: 4096, max_tokens: 4096, "
                "/Users/me/.config/secrets_manager/README.md, v1.2.3, 7f3a9c1e") % (SHA, UUID, SHA)
        self.assertEqual(self.clean(text), text)

    def test_idempotent(self):
        text = ('{"API_KEY": "%s"} https://u:%s@h.example.com Authorization: Basic dXNlcjpwYXNzd29yZA== Bearer %s%s' % (CANARY, CANARY2, "abcdefgh", "12345678"))
        once = self.clean(text); self.assertEqual(self.clean(once), once)

    def test_report_keys_only_for_fired_rules(self):
        self.assertEqual(S.sanitize("nothing here")[1]["redactions"], {})
        self.assertEqual(S.sanitize("https://u:%s@h.example.com" % CANARY)[1]["redactions"], {"url_userinfo": 1})

    def test_material_policy(self):
        clean, info = S.sanitize_material("plain text, commit %s" % SHA)
        self.assertEqual(clean, "plain text, commit %s" % SHA); self.assertFalse(info["changed"]); self.assertFalse(info["redaction_dependent"])
        clean, info = S.sanitize_material("API_KEY=%s" % CANARY)
        self.assertTrue(info["changed"]); self.assertTrue(info["redaction_dependent"]); self.assertEqual(info["redactions"], {"assignment": 1})
        self.assertTrue(S.sanitize_material("an old [REDACTED:ambiguous] marker")[1]["redaction_dependent"])    # an existing marker is a dependency too

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: f.write(text)

QUOTE = "Never run migrate.sh against prod."

def session(path, note, text, user=QUOTE, extra=()):
    d = os.path.dirname(note)
    recs = [dict(type="user", uuid="u1", timestamp="2026-01-01T00:00:00Z", cwd=d, sessionId="s1", message=dict(role="user", content=user))] + list(extra)
    recs += [dict(type="assistant", uuid="a1", timestamp="2026-01-01T00:00:09Z", cwd=d, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="w0", name="Write", input=dict(file_path=note, content=text))])),
             dict(type="user", uuid="r1", timestamp="2026-01-01T00:00:10Z", cwd=d, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w0", content="File created successfully at: " + note)]))]
    write(path, "".join(json.dumps(r) + "\n" for r in recs))

def tool_pair(i, command, result):
    return [dict(type="assistant", uuid="ta%d" % i, timestamp="2026-01-01T00:00:%02dZ" % (i + 1), sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="t%d" % i, name="Bash", input=dict(command=command))])),
            dict(type="user", uuid="tr%d" % i, timestamp="2026-01-01T00:00:%02dZ" % (i + 2), sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="t%d" % i, content=result)]))]

class Payloads(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.realpath(self.t.name)
        self.note = os.path.join(self.d, "HANDOFF.md"); self.log = os.path.join(self.d, "session.jsonl"); self.text = "- the migration is done\n"; self.cwd0 = os.getcwd()

    def tearDown(self): os.chdir(self.cwd0); self.t.cleanup()

    def prepare(self, detail=QUOTE, quote=QUOTE, extra=()):
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", self.log, "--file", self.note, "--write-id", "w0", "--evaluated-against", "prefix",
                            "--detail", detail, "--source-quote", quote] + list(extra), cwd=self.d, capture_output=True, text=True, env=ENV)
        return p.returncode, p.stdout

    def material(self):
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        return omissions.context(self.log, canon, vs[0], "prefix", omissions.material_bases(self.note, vs[0]))

    def test_clean_session_is_unchanged(self):
        write(self.note, self.text); session(self.log, self.note, self.text)
        code, out = self.prepare(); self.assertEqual(code, 0, out)
        o = json.loads(out); self.assertEqual(o["material"], omissions.material(self.text))
        self.assertEqual(o["source_passage"], QUOTE)

    def test_canary_in_prompt_tool_input_and_result_never_reaches_a_ready_payload(self):
        write(self.note, self.text)
        extra = tool_pair(2, 'export API_KEY="%s"; run.sh' % CANARY, '{"API_KEY": "%s"}' % CANARY2)
        session(self.log, self.note, self.text, user="%s API_KEY=%s" % (QUOTE, CANARY), extra=extra)
        ctx = self.material()
        blob = json.dumps(ctx)
        self.assertNotIn(CANARY, blob); self.assertNotIn(CANARY2, blob)
        code, out = self.prepare(); self.assertEqual(code, 3, out)                       # the passage holding the quote carries a redaction: UNRESOLVED, no raw text
        self.assertNotIn(CANARY, out); self.assertIn("redact", out)
        # the quote sits in a clean record: ready, and the secret records are sanitized
        session(self.log, self.note, self.text, user=QUOTE, extra=extra)
        code, out = self.prepare(); self.assertEqual(code, 0, out)
        self.assertNotIn(CANARY, out); self.assertNotIn(CANARY2, out)

    def test_detail_or_quote_that_is_secret_or_redacted_is_refused(self):
        write(self.note, self.text); session(self.log, self.note, self.text)
        code, out = self.prepare(detail="rotate API_KEY=%s" % CANARY); self.assertEqual(code, 3); self.assertNotIn(CANARY, out)
        code, out = self.prepare(detail="rotate API_KEY=[REDACTED:assignment]", quote=QUOTE); self.assertEqual(code, 3); self.assertIn("redact", out)
        code, out = self.prepare(quote="x [REDACTED:ambiguous]"); self.assertEqual(code, 3)

    def test_secret_in_the_note_blocks_the_material_without_raw_text(self):
        text = self.text + "API_KEY=%s\n" % CANARY
        write(self.note, text); session(self.log, self.note, text)
        code, out = self.prepare(); self.assertEqual(code, 3); self.assertNotIn(CANARY, out); self.assertIn("redact", out)
        self.assertIsNone(self.material()["material"])

    def test_secret_in_a_referenced_json_blocks_the_material_without_raw_text(self):
        text = self.text + "- see `ref.json`\n"
        write(self.note, text); write(os.path.join(self.d, "ref.json"), json.dumps({"password": CANARY}))
        session(self.log, self.note, text)
        code, out = self.prepare(); self.assertEqual(code, 3); self.assertNotIn(CANARY, out)
        ctx = self.material(); self.assertIsNone(ctx["material"]); self.assertNotIn(CANARY, json.dumps(ctx))

    def test_ambiguous_token_in_note_or_reference_is_unresolved(self):
        amb = "aB3" * 12
        for note_text, ref_text in ((self.text + "id %s\n" % amb, None), (self.text + "- see `ref.md`\n", "blob %s\n" % amb)):
            write(self.note, note_text)
            if ref_text: write(os.path.join(self.d, "ref.md"), ref_text)
            session(self.log, self.note, note_text)
            code, out = self.prepare(); self.assertEqual(code, 3, out); self.assertNotIn(amb, out)

    def test_excluded_file_reference_and_its_alias_block_before_reading(self):
        env = os.path.join(self.d, ".env.md"); write(env, "KEY=%s\n" % CANARY)
        os.symlink(env, os.path.join(self.d, "safe.md"))
        for name in (".env.md", "safe.md"):
            text = self.text + "- see `%s`\n" % name
            write(self.note, text); session(self.log, self.note, text)
            ctx = self.material(); self.assertIsNone(ctx["material"], name); self.assertIn("excluded", ctx["material_reason"]); self.assertNotIn(CANARY, json.dumps(ctx))

    def test_preparation_and_rederivation_agree(self):
        write(self.note, self.text); session(self.log, self.note, self.text, extra=tool_pair(2, "ls", "ok"))
        code, out = self.prepare(); self.assertEqual(code, 0, out)
        os.chdir(self.d)
        vs, _, _, _ = versions.versions_of(self.log, self.note)
        rows = versions.bind_versions([dict(version_ref=versions.version_ref(vs[0], "prefix"))], [dict(bound=True, id="k", tool_use_id="x")], self.note, self.log, [], False)
        self.assertEqual(json.loads(out)["material"], rows["k"]["omission"]["material"])

    def test_scope_context_with_a_secret_excludes_nothing(self):
        write(self.note, self.text); session(self.log, self.note, self.text, user="please fix it, API_KEY=%s" % CANARY)
        ctx, reqs, why = scope.scope_of(self.log); self.assertIsNone(ctx); self.assertIn("redact", why); self.assertNotIn(CANARY, why)
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare", "--source", self.log, "--detail", "something"], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 3); self.assertNotIn(CANARY, p.stdout)
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "scope.py"), "prepare", "--source", self.log, "--detail", "rotate API_KEY=%s" % CANARY], capture_output=True, text=True, env=ENV)
        self.assertEqual(p.returncode, 3); self.assertNotIn(CANARY, p.stdout)

    def test_clean_scope_is_unchanged(self):
        write(self.note, self.text); session(self.log, self.note, self.text)
        ctx, reqs, why = scope.scope_of(self.log); self.assertIsNone(why); self.assertEqual(ctx, scope.canonical_context([QUOTE]))

class Validation(unittest.TestCase):
    """A redaction-dependent detail, quote or passage never confirms a finding, whatever the (canned) results say."""
    def test_marker_in_detail_or_quote_is_not_confirmed(self):
        import jevref
        sc, ac = omissions.claims("rotate the [REDACTED:assignment] key")
        a = dict(id="a", tool="verify", bound=True, check_error=None, real_verdict="unsupported", real_confidence=0.99, real_action="auto", claim_key=ac, resolved=False,
                 version=dict(ok=True, write_tool_use_id="w0", sha256="s", evaluated_against="prefix", run=None), call_evidence_raw=["m"], omission_material="m")
        s = dict(id="s", tool="verify", bound=True, real_verdict="verified", real_confidence=0.99, resolved=True, claim_key=sc, eligible_blocks=["we must rotate the [REDACTED:assignment] key"],
                 version=dict(ok=True, write_tool_use_id="w0", sha256="s", evaluated_against="prefix", run=None), call_evidence_raw=["we must rotate the [REDACTED:assignment] key"])
        f = dict(type="lost_detail", check_id="a", claim=ac, omission_ref=dict(detail="rotate the [REDACTED:assignment] key", source_check_id="s"), quote_source="rotate the [REDACTED:assignment] key", quote_handoff=None)
        ok, why = jevref._validate_omission(f, a, dict(a=a, s=s), "R04")
        self.assertFalse(ok); self.assertIn("redact", why)

    def test_scope_exclusion_with_a_marker_detail_is_invalid(self):
        e = dict(detail="rotate the [REDACTED:assignment] key", jev_ref=dict(tool_use_id="c", result_index=0, key="d1"), classification="out_of_scope", confidence=0.999)
        r = scope.validate_exclusions([e], [dict(tool_use_id="c", tool="classify", input={})], "/nonexistent.jsonl")
        self.assertEqual(r["invalid"], 1); self.assertIn("redact", r["reasons"][0]["reason"])

if __name__ == "__main__": unittest.main()

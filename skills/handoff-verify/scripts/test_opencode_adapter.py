#!/usr/bin/env python3
"""Offline test of the OpenCode v2 adapter (stdlib only, no Jev call, no network, never writes anything outside temp dirs): an OpenCode session (SQLite `session_v2` + `session_message`)
selected explicitly as `opencode:<session-id>` or `opencode-db:<absolute-db-path>#<session-id>` is normalized IN MEMORY into the Claude-shaped record stream the skill already uses. The fixtures
are small invented sessions (same table schema as OpenCode v2, no real content). One class reads the real local OpenCode database when it exists (skipped otherwise), without printing session text.
usage: python3 -B test_opencode_adapter.py [-v]"""
import datetime, hashlib, json, os, re, sqlite3, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, jevref as J, report, slice as SL, versions

T0 = 1790000000000
CLAIM = "The note says the billing migration ships on Friday."
SESSION_DDL = """CREATE TABLE `session_v2` (
  `id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `fork_session_id` text, `fork_boundary` text, `slug` text NOT NULL, `directory` text NOT NULL,
  `path` text, `title` text, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text,
  `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL, `time_compacting` integer, `time_archived` integer, `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text)"""
MESSAGE_DDL = """CREATE TABLE "session_message" (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL)"""

def iso(ms): return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()

def user(text, t, **extra): return ("user", dict(text=text, time=dict(created=t), files=[], agents=[], **extra))
def assistant(blocks, t, done=None): return ("assistant", dict(agent="build", model=dict(id="m", providerID="p"), time=dict(created=t, completed=done if done is not None else t + 5), content=blocks))
def text(t): return dict(type="text", text=t)
def reasoning(t): return dict(type="reasoning", text=t, time=dict(created=1, completed=2))
def location(directory, t, previous="/prev"): return ("location-switched", dict(time=dict(created=t), location=dict(directory=directory), previous=dict(location=dict(directory=previous), projectID="p", subpath=""), projectID="q", subpath=""))
def tool(tid, name, inp, created, completed=None, status="completed", out="ok", metadata=None, **state):
    st = dict(status=status, input=inp)
    if status == "error": st["error"] = dict(type="tool.execution", message="boom")
    else: st["content"] = [dict(type="text", text=out)]
    if metadata is not None: st["metadata"] = metadata
    st.update(state)
    tm = dict(created=created)
    if completed is not None: tm["completed"] = completed
    return dict(type="tool", id=tid, name=name, state=st, time=tm)
def patch(pid, body, created, completed=None, **kw):
    return tool(pid, "patch", dict(patchText="*** Begin Patch\n" + body + "*** End Patch"), created, completed if completed is not None else created + 9, **kw)

def jev_json(tool_name="jev_verify", confidence=0.99):
    return json.dumps(dict(tool=tool_name, subject_at=0.5, results=[dict(claim=CLAIM, verdict="supported", confidence=confidence, same_subject=0.9)]))
def jev_input(): return dict(claims=[CLAIM], evidence=[dict(text="Friday is the date.")])
def execute_jev(tid, created, completed, inner_tool="jev.jev_verify", inner_status="completed", payload=None, where="content", truncated=False, error=None, calls=None, status="completed"):
    payload = payload if payload is not None else json.loads(jev_json())
    meta = dict(toolCalls=calls if calls is not None else [dict(tool=inner_tool, status=inner_status, input=jev_input())], truncated=truncated)
    if error is not None: meta["error"] = error
    st = {}
    if where == "structured": st["structured"] = payload
    elif where == "result": st["result"] = payload
    t = tool(tid, "execute", dict(code="return await tools.jev.jev_verify(...)"), created, completed, status=status, out=json.dumps(payload) if where == "content" else "", metadata=meta, **st)
    if where != "content": t["state"]["content"] = [dict(type="text", text="not json")]
    return t

class Fixture:
    """A temp OpenCode v2 database with the real table schema."""
    def __init__(self, base):
        self.dir = os.path.join(base, "oc"); os.makedirs(self.dir, exist_ok=True); self.db = os.path.join(self.dir, "opencode.db")
        self.con = sqlite3.connect(self.db); self.con.execute(SESSION_DDL); self.con.execute(MESSAGE_DDL)
    def session(self, sid, directory, msgs, raw=None):
        self.con.execute("INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)", (sid, "p1", "s", directory, "2.0.0", T0, T0))
        for i, (typ, data) in enumerate(msgs, 1):
            self.con.execute("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", ("msg_%s_%03d" % (sid, i), sid, typ, i, (data.get("time") or {}).get("created", T0), T0, json.dumps(data) if raw is None or i != raw[0] else raw[1]))
        self.con.commit(); return "opencode-db:%s#%s" % (self.db, sid)
    def close(self): self.con.close()

def uses(recs, name=None):
    return [(r["message"]["content"][0], r) for r in recs if r["type"] == "assistant" and r["message"]["content"][0].get("type") == "tool_use" and (name is None or r["message"]["content"][0]["name"] == name)]
def results(recs):
    return {r["message"]["content"][0]["tool_use_id"]: (r["message"]["content"][0], r) for r in recs if r["type"] == "user" and r["message"]["content"][0].get("type") == "tool_result"}

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.base = os.path.realpath(self.tmp.name)
        self.fx = Fixture(self.base); self.addCleanup(self.fx.close); self.cwd = os.path.join(self.base, "work"); os.makedirs(self.cwd)
        import opencode; self.O = opencode
    def sel(self, msgs, sid="ses_a1", directory=None, **kw): return self.fx.session(sid, directory or self.cwd, msgs, **kw)
    def recs(self, sel): return self.O.records(sel)
    def path(self, name="HANDOFF.md"): return os.path.join(self.cwd, name)

class Selectors(Base):
    def test_is_selector_only_for_the_two_explicit_prefixes(self):
        for s in ("opencode:ses_1", "opencode-db:/x/o.db#ses_1"): self.assertTrue(self.O.is_selector(s), s)
        for s in ("/tmp/a:b/x.jsonl", "a:b.jsonl", "opencode", "x opencode:ses_1", "", None, "OPENCODE:ses_1", "./opencode:ses_1.jsonl"): self.assertFalse(self.O.is_selector(s), s)

    def test_ordinary_path_with_colon_is_not_a_selector_for_discover(self):
        p = os.path.join(self.base, "weird:name.jsonl"); open(p, "w").write("")
        self.assertEqual(D.resolve_session_info(p), (p, "path", False)); self.assertFalse(D.is_selector(p)); self.assertTrue(D.source_exists(p))

    def test_opencode_selector_uses_the_default_database_and_db_selector_splits_at_the_final_hash(self):
        old = os.environ.get("HOME"); os.environ["HOME"] = self.base; self.addCleanup(lambda: os.environ.__setitem__("HOME", old) if old is not None else os.environ.pop("HOME"))
        self.assertEqual(self.O.parse("opencode:ses_x"), (os.path.join(self.base, ".local/share/opencode/opencode.db"), "ses_x"))
        self.assertEqual(self.O.parse("opencode-db:/a#b/o.db#ses_y"), ("/a#b/o.db", "ses_y"))

    def test_malformed_selectors_are_refused_with_a_clear_error(self):
        for s in ("opencode-db:relative/o.db#ses_1", "opencode-db:/x/o.db", "opencode-db:/x/o.db#", "opencode:", "opencode:a b", "opencode-db:#ses_1", "opencode:ses/../x"):
            with self.assertRaises(self.O.OpenCodeError, msg=s): self.O.parse(s)

    def test_canonical_identity_resolves_symlinks_and_selectors_never_equal_a_jsonl_path(self):
        sel = self.sel([user("hi", T0)]); link = os.path.join(self.base, "link.db"); os.symlink(self.fx.db, link)
        self.assertEqual(self.O.canonical("opencode-db:%s#ses_a1" % link), "opencode-db:%s#ses_a1" % os.path.realpath(self.fx.db))
        self.assertEqual(D.canon("opencode-db:%s#ses_a1" % link), D.canon(sel))
        self.assertEqual(D.resolve_session_info(sel), (self.O.canonical(sel), "opencode", False))
        self.assertNotEqual(D.canon(sel), os.path.realpath(self.fx.db))

    def test_errors_missing_database_unknown_session_malformed_data_legacy_only(self):
        sel = self.sel([user("hi", T0)])
        with self.assertRaisesRegex(self.O.OpenCodeError, "not found"): self.O.records("opencode-db:%s#ses_nope" % self.fx.db)
        with self.assertRaisesRegex(self.O.OpenCodeError, "database"): self.O.records("opencode-db:%s/nope.db#ses_a1" % self.base)
        self.assertFalse(D.source_exists("opencode-db:%s/nope.db#ses_a1" % self.base)); self.assertFalse(D.source_exists("opencode-db:%s#ses_nope" % self.fx.db)); self.assertTrue(D.source_exists(sel))
        bad = self.fx.session("ses_bad", self.cwd, [user("x", T0), user("y", T0 + 1)], raw=(2, "{not json"))
        with self.assertRaisesRegex(self.O.OpenCodeError, "malformed"): self.O.records(bad)
        legacy = os.path.join(self.base, "legacy.db"); c = sqlite3.connect(legacy); c.execute("CREATE TABLE session (id text primary key)"); c.execute("INSERT INTO session VALUES ('ses_old')"); c.commit(); c.close()
        with self.assertRaisesRegex(self.O.OpenCodeError, "unsupported|v2"): self.O.records("opencode-db:%s#ses_old" % legacy)

    def test_read_only_open_changes_nothing_and_quotes_the_uri(self):
        d = os.path.join(self.base, "dir #1 ?x%"); os.makedirs(d); db = os.path.join(d, "o.db")
        c = sqlite3.connect(db); c.execute(SESSION_DDL); c.execute(MESSAGE_DDL); c.execute("INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES ('ses_q','p','s',?, '2', 1, 1)", (self.cwd,))
        c.execute("INSERT INTO session_message VALUES ('m1','ses_q','user',1,?,1,?)", (T0, json.dumps(user("hello", T0)[1]))); c.commit(); c.close()
        before = (sorted(os.listdir(d)), open(db, "rb").read(), os.stat(db).st_mtime_ns)
        recs = self.O.records("opencode-db:%s#ses_q" % db)
        self.assertEqual([r["message"]["content"][0]["text"] for r in recs], ["hello"])
        self.assertEqual((sorted(os.listdir(d)), open(db, "rb").read(), os.stat(db).st_mtime_ns), before)
        self.assertIn("mode=ro", self.O.readonly_uri(db)); self.assertNotIn("#", self.O.readonly_uri(db)); self.assertNotIn(" ", self.O.readonly_uri(db))

class Text(Base):
    def test_text_session_id_cwd_timestamps_and_exclusions(self):
        sel = self.sel([user("goal: ship", T0), ("system", dict(time=dict(created=T0 + 1), text="SYSTEM-SECRET")), ("synthetic", dict(time=dict(created=T0 + 2), text="SYNTH-REMINDER")),
                        assistant([reasoning("REASONING-SECRET"), text("plan: A then B")], T0 + 10), ("idle", dict(time=dict(created=T0 + 20), outcome="ok")),
                        ("compaction", dict(time=dict(created=T0 + 30), status="completed", summary="COMPACTION-SUMMARY")), ("agent-switched", dict(time=dict(created=T0 + 31), agent="plan", previous="build")),
                        ("model-switched", dict(time=dict(created=T0 + 32), model=dict(id="x"), previous=dict(id="y")))])
        recs = self.recs(sel); blob = json.dumps(recs)
        for leak in ("SYSTEM-SECRET", "SYNTH-REMINDER", "REASONING-SECRET", "COMPACTION-SUMMARY"): self.assertNotIn(leak, blob)
        self.assertEqual([(r["type"], r["message"]["content"][0]["text"]) for r in recs], [("user", "goal: ship"), ("assistant", "plan: A then B")])
        self.assertEqual([r["_line"] for r in recs], [1, 2]); self.assertEqual({r["sessionId"] for r in recs}, {"ses_a1"}); self.assertEqual({r["cwd"] for r in recs}, {self.cwd})
        self.assertEqual([r["timestamp"] for r in recs], [iso(T0), iso(T0 + 10)]); self.assertEqual(len({r["uuid"] for r in recs}), 2)

    def test_location_switch_updates_cwd_only_from_structure(self):
        sel = self.sel([user("a", T0), location("/new/dir", T0 + 5, previous="/old/dir"), user("b", T0 + 9), user("mentions /fake/dir in prose", T0 + 10)], directory="/new/dir")
        self.assertEqual([r["cwd"] for r in self.recs(sel)], ["/old/dir", "/new/dir", "/new/dir"])

class Mutations(Base):
    def test_write_via_filePath_and_path_and_relative_paths_resolve_against_the_recorded_cwd(self):
        sel = self.sel([assistant([tool("w1", "write", dict(filePath=self.path(), content="v1\n"), T0 + 1, T0 + 2), tool("w2", "write", dict(path="rel.md", content="r\n"), T0 + 3, T0 + 4),
                                   tool("w3", "write", dict(path="a/../b.md", content="b\n"), T0 + 5, T0 + 6)], T0)])
        recs = self.recs(sel); u = {c["id"]: c for c, _ in uses(recs)}
        self.assertEqual({k: (v["name"], v["input"]) for k, v in u.items()}, {"w1": ("Write", dict(file_path=self.path(), content="v1\n")), "w2": ("Write", dict(file_path=self.path("rel.md"), content="r\n")),
                                                                                "w3": ("Write", dict(file_path=self.path("b.md"), content="b\n"))})
        res = results(recs); self.assertEqual({k: v[0]["is_error"] for k, v in res.items()}, {"w1": False, "w2": False, "w3": False})
        self.assertEqual([r["timestamp"] for _, r in uses(recs)], [iso(T0 + 1), iso(T0 + 3), iso(T0 + 5)])
        self.assertEqual(res["w1"][1]["timestamp"], iso(T0 + 2))

    def test_relative_path_after_location_switch_uses_the_new_cwd(self):
        sel = self.sel([location("/n", T0, previous=self.cwd), assistant([tool("w1", "write", dict(path="x.md", content="1"), T0 + 1, T0 + 2)], T0 + 1)], directory="/n")
        self.assertEqual(uses(self.recs(sel))[0][0]["input"]["file_path"], "/n/x.md")

    def test_contradictory_paths_are_explicit_unrecoverability_never_a_guess(self):
        a, b = self.path("a.md"), self.path("b.md")
        sel = self.sel([assistant([tool("w1", "write", dict(filePath=a, path=b, content="x"), T0 + 1, T0 + 2)], T0)])
        recs = self.recs(sel)
        self.assertEqual(sorted((c["input"]["file_path"], c["input"].get("content")) for c, _ in uses(recs)), [(a, None), (b, None)])
        for c, _ in uses(recs): self.assertIn("conflict", c["input"]["_unrecoverable"])
        vs = versions.versions_of(sel, a)[0]; self.assertEqual([v["status"] for v in vs], ["content not recoverable"]); self.assertIn("conflict", vs[0]["reason"])

    def test_failed_and_unfinished_tools(self):
        sel = self.sel([assistant([tool("w1", "write", dict(filePath=self.path(), content="x"), T0 + 1, T0 + 2, status="error"), tool("w2", "write", dict(filePath=self.path("b.md"), content="x"), T0 + 3, status="running"),
                                   tool("w3", "write", dict(filePath=self.path("c.md"), content="x"), T0 + 5, status="completed")], T0)])
        recs = self.recs(sel); res = results(recs)
        self.assertTrue(res["w1"][0]["is_error"]); self.assertNotIn("w2", res); self.assertNotIn("w3", res)   # w3: completed but no recorded completion time -> no successful result
        items, _ = D.inventory(sel); self.assertEqual({i["tool_use_id"]: i["success"] for i in items}, {"w1": False, "w2": False, "w3": False})

    def test_edit_exact_ambiguous_absent_and_replace_all(self):
        sel = self.sel([assistant([tool("w1", "write", dict(filePath=self.path(), content="alpha beta alpha\n"), T0 + 1, T0 + 2),
                                   tool("e1", "edit", dict(filePath=self.path(), oldString="beta", newString="gamma"), T0 + 3, T0 + 4),
                                   tool("e2", "edit", dict(filePath=self.path(), oldString="alpha", newString="delta"), T0 + 5, T0 + 6),
                                   tool("e3", "edit", dict(filePath=self.path(), oldString="alpha", newString="delta", replaceAll=True), T0 + 7, T0 + 8),
                                   tool("e4", "edit", dict(filePath=self.path(), oldString="zzz", newString="y"), T0 + 9, T0 + 10)], T0)])
        e = {c["id"]: c["input"] for c, _ in uses(self.recs(sel), "Edit")}
        self.assertEqual(e["e1"], dict(file_path=self.path(), old_string="beta", new_string="gamma", replace_all=False)); self.assertTrue(e["e3"]["replace_all"])
        vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["status"], v["content"]) for v in vs], [("ok", "alpha beta alpha\n"), ("ok", "alpha gamma alpha\n"), ("content not recoverable", None), ("content not recoverable", None), ("content not recoverable", None)])
        self.assertIn("ambiguous", vs[2]["reason"])

    def test_shell_and_bash_are_Bash(self):
        sel = self.sel([assistant([tool("s1", "shell", dict(command="echo a > notes.md", workdir="/x"), T0 + 1, T0 + 2), tool("b1", "bash", dict(command="ls"), T0 + 3, T0 + 4), tool("s2", "shell", dict(), T0 + 5, T0 + 6)], T0)])
        self.assertEqual([(c["id"], c["name"], c["input"]) for c, _ in uses(self.recs(sel))], [("s1", "Bash", dict(command="echo a > notes.md")), ("b1", "Bash", dict(command="ls"))])
        _, bash = D.inventory(sel); self.assertEqual([b["path"] for b in bash], ["notes.md"])

    def test_other_tools_are_not_emitted_and_no_read_records_exist(self):
        sel = self.sel([assistant([tool("r1", "read", dict(filePath=self.path()), T0 + 1, T0 + 2, out="CONTENT"), tool("g1", "grep", dict(pattern="x"), T0 + 3, T0 + 4)], T0)])
        self.assertEqual(self.recs(sel), []); self.assertEqual(D.reads(sel), [])

    def test_duplicate_ids_are_disambiguated(self):
        sel = self.sel([assistant([tool("dup", "write", dict(filePath=self.path("a.md"), content="1"), T0 + 1, T0 + 2)], T0), assistant([tool("dup", "write", dict(filePath=self.path("b.md"), content="2"), T0 + 3, T0 + 4)], T0 + 3),
                        assistant([tool("dup", "write", dict(filePath=self.path("c.md"), content="3"), T0 + 5, T0 + 6)], T0 + 5)])
        recs = self.recs(sel); self.assertEqual([c["id"] for c, _ in uses(recs)], ["dup", "dup~2", "dup~3"]); self.assertEqual(sorted(results(recs)), ["dup", "dup~2", "dup~3"])

class Patches(Base):
    def run_patch(self, *calls, base="alpha\nbeta\ngamma\n"):
        blocks = [tool("w0", "write", dict(filePath=self.path(), content=base), T0 + 1, T0 + 2)] + list(calls)
        return self.sel([assistant(blocks, T0)])

    def test_add_file_is_a_write_with_joined_plus_lines_and_a_final_newline(self):
        sel = self.sel([assistant([patch("p1", "*** Add File: %s\n+# T\n+\n+- a\n" % self.path(), T0 + 1)], T0)])
        (c, _), = uses(self.recs(sel)); self.assertEqual((c["id"], c["name"], c["input"]), ("p1#1", "Write", dict(file_path=self.path(), content="# T\n\n- a\n")))
        self.assertEqual([v["content"] for v in versions.versions_of(sel, self.path())[0]], ["# T\n\n- a\n"])

    def test_exact_multi_hunk_update_with_a_known_base_is_one_edit(self):
        body = "*** Update File: %s\n@@\n-alpha\n+ALPHA\n+extra\n@@ ignored hint\n beta\n-gamma\n+GAMMA\n" % self.path()
        sel = self.run_patch(patch("p1", body, T0 + 3))
        (e, _), = uses(self.recs(sel), "Edit"); self.assertEqual(e["id"], "p1#1")
        self.assertEqual(e["input"], dict(file_path=self.path(), old_string="alpha\nbeta\ngamma\n", new_string="ALPHA\nextra\nbeta\nGAMMA\n", replace_all=False))
        self.assertEqual([(v["status"], v["content"]) for v in versions.versions_of(sel, self.path())[0]], [("ok", "alpha\nbeta\ngamma\n"), ("ok", "ALPHA\nextra\nbeta\nGAMMA\n")])

    def test_two_sections_and_two_files_get_section_ids(self):
        a = self.path("a.md")
        body = "*** Add File: %s\n+one\n*** Update File: %s\n@@\n-one\n+two\n*** Update File: %s\n@@\n-alpha\n+A\n" % (a, a, self.path())
        sel = self.run_patch(patch("p1", body, T0 + 3))
        recs = self.recs(sel); self.assertEqual([c["id"] for c, _ in uses(recs) if c["id"] != "w0"], ["p1#1", "p1#2", "p1#3"]); self.assertEqual(sorted(k for k in results(recs) if k != "w0"), ["p1#1", "p1#2", "p1#3"])
        self.assertEqual([v["content"] for v in versions.versions_of(sel, a)[0]], ["one\n", "two\n"])

    def test_unrecoverable_patches_carry_a_reason_and_clear_the_base(self):
        cases = {
            "unknown base": ("*** Update File: %s\n@@\n-x\n+y\n" % self.path("nobase.md"), "nobase.md", "base"),
            "non-exact hunk": ("*** Update File: %s\n@@\n-NOT THERE\n+y\n" % self.path(), "HANDOFF.md", "exact"),
            "ambiguous hunk": ("*** Update File: %s\n@@\n-a\n+y\n" % self.path(), "HANDOFF.md", "exact"),
            "insert only hunk": ("*** Update File: %s\n@@\n+y\n" % self.path(), "HANDOFF.md", "old"),
            "overlap/out of order": ("*** Update File: %s\n@@\n-beta\n+B\n@@\n-alpha\n+A\n" % self.path(), "HANDOFF.md", "order"),
            "delete": ("*** Delete File: %s\n" % self.path(), "HANDOFF.md", "delete"),
            "malformed line": ("*** Update File: %s\n@@\n?bad\n" % self.path(), "HANDOFF.md", "malformed"),
        }
        for label, (body, name, word) in cases.items():
            with self.subTest(label):
                sid = "ses_" + re.sub(r"\W", "", label)
                sel = self.fx.session(sid, self.cwd, [assistant([tool("w0", "write", dict(filePath=self.path(), content="alpha\nbeta\ngamma\naa\n"), T0 + 1, T0 + 2), patch("p1", body, T0 + 3),
                                                                  tool("e1", "edit", dict(filePath=self.path(), oldString="beta", newString="B"), T0 + 20, T0 + 21)], T0)])
                vs = versions.versions_of(sel, self.path(name))[0]
                bad = [v for v in vs if v["status"] != "ok"]
                self.assertTrue(bad, label); self.assertIn(word, bad[0]["reason"].lower()); self.assertIsNone(bad[0]["content"])
                if name == "HANDOFF.md": self.assertEqual(vs[-1]["status"], "content not recoverable")   # the later exact Edit cannot use a stale base

    def test_move_marks_both_paths_and_failed_patch_creates_no_version(self):
        a, b = self.path("a.md"), self.path("b.md")
        sel = self.sel([assistant([tool("w0", "write", dict(filePath=a, content="x\n"), T0 + 1, T0 + 2), patch("p1", "*** Update File: %s\n*** Move to: %s\n@@\n-x\n+y\n" % (a, b), T0 + 3),
                                   patch("p2", "*** Add File: %s\n+z\n" % self.path("c.md"), T0 + 20, status="error")], T0)])
        recs = self.recs(sel); marks = {c["input"]["file_path"]: c["input"]["_unrecoverable"] for c, _ in uses(recs) if "_unrecoverable" in c["input"]}
        self.assertEqual(sorted(marks), [a, b]); self.assertTrue(all("move" in m.lower() for m in marks.values()))
        self.assertEqual([c["id"] for c, _ in uses(recs)], ["w0", "p1#1", "p1#2"]); self.assertFalse(any(c["id"].startswith("p2") for c, _ in uses(recs)))

    def test_malformed_patch_marks_header_paths_and_pathless_ones_are_reported(self):
        sel = self.sel([assistant([tool("p1", "patch", dict(patchText="*** Begin Patch\n*** Add File: %s\n+x\n" % self.path()), T0 + 1, T0 + 2), tool("p2", "patch", dict(patchText="garbage"), T0 + 3, T0 + 4)], T0)])
        recs, notes = self.O.load(sel)
        self.assertEqual([(c["id"], "malformed" in c["input"]["_unrecoverable"]) for c, _ in uses(recs)], [("p1#1", True)]); self.assertEqual([n["call_id"] for n in notes], ["p2"])

    def test_concurrent_mutations_of_one_path_are_ambiguous(self):
        sel = self.sel([assistant([tool("w1", "write", dict(filePath=self.path(), content="one\n"), T0 + 1, T0 + 50), tool("w2", "write", dict(filePath=self.path(), content="two\n"), T0 + 10, T0 + 20),
                                   tool("w3", "write", dict(filePath=self.path("o.md"), content="o\n"), T0 + 10, T0 + 20)], T0)])
        vs = versions.versions_of(sel, self.path())[0]; self.assertEqual([v["status"] for v in vs], ["content not recoverable"] * 2); self.assertIn("concurrent", vs[0]["reason"])
        self.assertEqual(versions.versions_of(sel, self.path("o.md"))[0][0]["status"], "ok")

class Ordering(Base):
    def test_events_are_ordered_by_recorded_time_not_by_message_order(self):
        sel = self.sel([assistant([tool("a", "write", dict(filePath=self.path("a.md"), content="a"), T0 + 100, T0 + 300), tool("b", "write", dict(filePath=self.path("b.md"), content="b"), T0 + 150, T0 + 160)], T0)])
        seq = [(("use" if r["type"] == "assistant" else "res"), (c.get("id") or c.get("tool_use_id"))) for r in self.recs(sel) for c in r["message"]["content"]]
        self.assertEqual(seq, [("use", "a"), ("use", "b"), ("res", "b"), ("res", "a")]); self.assertEqual([r["_line"] for r in self.recs(sel)], [1, 2, 3, 4])

    def test_use_precedes_result_on_equal_timestamps(self):
        sel = self.sel([assistant([tool("a", "write", dict(filePath=self.path("a.md"), content="a"), T0 + 5, T0 + 5)], T0)])
        self.assertEqual([r["type"] for r in self.recs(sel)], ["assistant", "user"])

    def test_state_time_is_not_read_and_missing_top_level_time_is_malformed(self):
        t = tool("a", "write", dict(filePath=self.path(), content="a"), T0 + 5, T0 + 6); t["state"]["time"] = dict(created=T0 + 1, completed=T0 + 2)
        sel = self.sel([assistant([t], T0)]); recs = self.recs(sel); self.assertEqual(uses(recs)[0][1]["timestamp"], iso(T0 + 5)); self.assertEqual(results(recs)["a"][1]["timestamp"], iso(T0 + 6))
        t2 = tool("b", "write", dict(filePath=self.path("b.md"), content="a"), T0 + 5); t2["time"] = {}; t2["state"]["time"] = dict(created=T0 + 1, completed=T0 + 2)
        recs = self.recs(self.sel([assistant([t2], T0)], sid="ses_b")); self.assertNotIn("b", results(recs)); self.assertEqual(uses(recs), [])

    def test_a_tool_without_top_level_created_has_no_event_binding_or_version_and_never_falls_back_to_the_message_time(self):
        w = tool("w", "write", dict(filePath=self.path(), content="a\n"), T0 + 5, T0 + 6); w["time"] = dict(completed=T0 + 6); w["state"]["time"] = dict(created=T0 + 1, completed=T0 + 2)
        j = tool("j", "jev:jev_verify", jev_input(), T0 + 7, T0 + 8, out=jev_json()); j["time"] = dict(completed=T0 + 8); j["state"]["time"] = dict(created=T0 + 1, completed=T0 + 2)
        b = tool("b", "bash", dict(command="ls"), T0 + 9, T0 + 10); b["time"] = {}
        sel = self.sel([user("hello", T0), assistant([w, j, b], T0 + 3)], sid="ses_nt"); recs = self.recs(sel)
        self.assertEqual([r["message"]["content"][0]["type"] for r in recs], ["text"]); self.assertEqual(uses(recs), []); self.assertEqual(results(recs), {})
        self.assertNotIn(iso(T0 + 3), [r["timestamp"] for r in recs if r["type"] == "assistant"])
        self.assertEqual(versions.versions_of(sel, self.path())[0], []); self.assertEqual(J.load_calls(sel), [])
        self.assertEqual([n["call_id"] for n in self.O.load(sel)[1]], ["w"])

    def test_tool_blocks_with_valid_top_level_time_are_kept_when_the_assistant_message_has_no_time(self):
        def untimed(blocks): return ("assistant", dict(agent="build", model=dict(id="m", providerID="p"), content=blocks))   # no data.time at all
        u = tool("u", "edit", dict(filePath=self.path(), oldString="beta", newString="BETA"), T0 + 20, T0 + 21); u["time"] = dict(completed=T0 + 21)   # completed, no created
        body = "*** Update File: %s\n@@\n-ALPHA\n+Alpha\n" % self.path()
        sel = self.sel([user("hello", T0), untimed([tool("w", "write", dict(filePath=self.path(), content="alpha\nbeta\n"), T0 + 1, T0 + 2), tool("e", "edit", dict(filePath=self.path(), oldString="alpha", newString="ALPHA"), T0 + 3, T0 + 4),
                                                    tool("b", "bash", dict(command="ls"), T0 + 5, T0 + 6), tool("j", "jev:jev_verify", jev_input(), T0 + 7, T0 + 8, out=jev_json())]),
                        untimed([u]), untimed([patch("p", body, T0 + 30)])], sid="ses_nomt")
        recs = self.recs(sel); us, rs = uses(recs), results(recs)
        self.assertEqual([(c["id"], c["name"]) for c, _ in us], [("w", "Write"), ("e", "Edit"), ("b", "Bash"), ("j", "mcp__jev__jev_verify"), ("p#1", "Edit")])
        self.assertEqual([r["timestamp"] for _, r in us], [iso(T0 + 1), iso(T0 + 3), iso(T0 + 5), iso(T0 + 7), iso(T0 + 30)])
        self.assertEqual({k: r["timestamp"] for k, (_, r) in rs.items()}, {"w": iso(T0 + 2), "e": iso(T0 + 4), "b": iso(T0 + 6), "j": iso(T0 + 8), "p#1": iso(T0 + 39)})
        self.assertNotIn("u", [c["id"] for c, _ in us]); self.assertNotIn("u", rs)   # the unpositioned edit is not invented as an event
        self.assertIn("_unrecoverable", us[4][0]["input"])   # ...but it still invalidated the base for the later patch Update
        self.assertEqual([(v["status"], v["content"]) for v in versions.versions_of(sel, self.path())[0]][:2], [("ok", "alpha\nbeta\n"), ("ok", "ALPHA\nbeta\n")])
        self.assertEqual([c["tool_use_id"] for c in J.load_calls(sel)], ["j"]); self.assertEqual([n["call_id"] for n in self.O.load(sel)[1]], ["u"])

    def test_a_completed_mutation_without_created_invalidates_the_base_of_its_path(self):
        e = tool("e", "edit", dict(filePath=self.path(), oldString="beta", newString="BETA"), T0 + 6, T0 + 7); e["time"] = dict(completed=T0 + 7)
        body = "*** Update File: %s\n@@\n-alpha\n+ALPHA\n" % self.path()
        sel = self.sel([assistant([tool("w0", "write", dict(filePath=self.path(), content="alpha\nbeta\n"), T0 + 1, T0 + 2)], T0), assistant([e], T0 + 3), assistant([patch("p1", body, T0 + 10)], T0 + 9)])
        recs = self.recs(sel); self.assertEqual([c["id"] for c, _ in uses(recs)], ["w0", "p1#1"]); self.assertIn("_unrecoverable", uses(recs)[1][0]["input"])
        self.assertEqual([v["status"] for v in versions.versions_of(sel, self.path())[0]], ["ok", "content not recoverable"])

    def test_a_jev_result_completing_after_the_next_handoff_write_does_not_satisfy_the_earlier_version(self):
        def build(jev_done):
            return self.sel([assistant([tool("w1", "write", dict(filePath=self.path(), content="v1\n"), T0 + 10, T0 + 12),
                                        tool("j1", "jev:jev_verify", jev_input(), T0 + 20, jev_done, out=jev_json()),
                                        tool("w2", "edit", dict(filePath=self.path(), oldString="v1", newString="v2"), T0 + 30, T0 + 32)], T0)], sid="ses_j%d" % jev_done)
        for done, expect in ((T0 + 50, "window"), (T0 + 25, "ok")):
            with self.subTest(done=done):
                sel = build(done); vs, _, _, _ = versions.versions_of(sel, self.path()); call = J.load_calls(sel)[0]
                ref = versions.version_ref(vs[0]); self.assertEqual(versions.validate_ref(ref, vs, call, same=True)[0], expect)

class JevBinding(Base):
    def calls(self, *blocks, sid="ses_jv"): return J.load_calls(self.sel([assistant(list(blocks), T0)], sid=sid))
    def test_direct_calls_bind_as_mcp_jev(self):
        calls = self.calls(tool("d1", "jev:jev_verify", jev_input(), T0 + 1, T0 + 2, out=jev_json()), tool("d2", "jev_verify", jev_input(), T0 + 3, T0 + 4, out=jev_json()))
        self.assertEqual([(c["tool_use_id"], c["tool"], c["is_error"], c["input"]) for c in calls], [("d1", "verify", False, jev_input()), ("d2", "verify", False, jev_input())])
        self.assertEqual([c["parsed"]["results"][0]["confidence"] for c in calls], [0.99, 0.99])

    def test_direct_error_call_is_an_error_call(self):
        calls = self.calls(tool("d1", "jev:jev_verify", jev_input(), T0 + 1, T0 + 2, status="error"))
        self.assertEqual([(c["tool_use_id"], c["has_result"], c["is_error"]) for c in calls], [("d1", True, True)])

    def test_execute_with_one_completed_inner_call_binds_with_payload_priority(self):
        for where in ("content", "structured", "result"):
            with self.subTest(where):
                calls = self.calls(execute_jev("x1", T0 + 1, T0 + 2, where=where), sid="ses_" + where)
                self.assertEqual([(c["tool_use_id"], c["tool"], c["is_error"], c["input"]) for c in calls], [("x1", "verify", False, jev_input())]); self.assertEqual(calls[0]["parsed"]["results"][0]["verdict"], "supported")
        both = execute_jev("x2", T0 + 1, T0 + 2, payload=json.loads(jev_json(confidence=0.99)), where="structured"); both["state"]["result"] = json.loads(jev_json(confidence=0.5)); both["state"]["content"] = [dict(type="text", text=jev_json(confidence=0.4))]
        self.assertEqual(self.calls(both, sid="ses_prio")[0]["parsed"]["results"][0]["confidence"], 0.99)
        res_over_content = execute_jev("x3", T0 + 1, T0 + 2, payload=json.loads(jev_json(confidence=0.97)), where="result"); res_over_content["state"]["content"] = [dict(type="text", text=jev_json(confidence=0.4))]
        self.assertEqual(self.calls(res_over_content, sid="ses_prio2")[0]["parsed"]["results"][0]["confidence"], 0.97)

    def test_content_payload_is_concatenated_across_parts(self):
        x = execute_jev("x1", T0 + 1, T0 + 2); js = jev_json(); x["state"]["content"] = [dict(type="text", text=js[:20]), dict(type="text", text=js[20:])]
        self.assertEqual(len(self.calls(x)), 1)

    def test_everything_else_stays_unbound(self):
        good = jev_input(); bad = {}
        bad["multiple inner calls"] = execute_jev("b1", T0 + 1, T0 + 2, calls=[dict(tool="jev.jev_verify", status="completed", input=good)] * 2)
        bad["zero inner calls"] = execute_jev("b2", T0 + 1, T0 + 2, calls=[])
        bad["inner non-jev call"] = execute_jev("b3", T0 + 1, T0 + 2, calls=[dict(tool="opencode.models", status="completed", input={})])
        bad["jev plus another call"] = execute_jev("b4", T0 + 1, T0 + 2, calls=[dict(tool="jev.jev_verify", status="completed", input=good), dict(tool="opencode.models", status="completed", input={})])
        bad["truncated"] = execute_jev("b5", T0 + 1, T0 + 2, truncated=True)
        bad["outer error flag"] = execute_jev("b6", T0 + 1, T0 + 2, error=True)
        bad["outer error status"] = execute_jev("b7", T0 + 1, T0 + 2, status="error")
        bad["inner error"] = execute_jev("b8", T0 + 1, T0 + 2, inner_status="error")
        bad["inner incomplete"] = execute_jev("b9", T0 + 1, T0 + 2, inner_status="running")
        bad["tool mismatch"] = execute_jev("b10", T0 + 1, T0 + 2, payload=json.loads(jev_json("jev_gate")))
        bad["wrapped result"] = execute_jev("b11", T0 + 1, T0 + 2, payload=dict(result=json.loads(jev_json())))
        bad["non-json"] = execute_jev("b12", T0 + 1, T0 + 2); bad["non-json"]["state"]["content"] = [dict(type="text", text="plain words")]
        bad["inner input not an object"] = execute_jev("b13", T0 + 1, T0 + 2, calls=[dict(tool="jev.jev_verify", status="completed", input="x")])
        bad["no truncated flag"] = execute_jev("b14", T0 + 1, T0 + 2); del bad["no truncated flag"]["state"]["metadata"]["truncated"]
        bad["inner not jev"] = execute_jev("b15", T0 + 1, T0 + 2, inner_tool="other.jev_verify")
        bad["incomplete outer"] = execute_jev("b16", T0 + 1, None)
        bad["non-completed direct"] = tool("b17", "jev:jev_verify", good, T0 + 1, None, status="running")
        for label, blk in bad.items():
            with self.subTest(label):
                recs = self.recs(self.sel([assistant([blk], T0)], sid="ses_" + re.sub(r"\W", "", label)))
                self.assertEqual([c for c in J.calls_from_records(recs) if not c["is_error"]], [], label)

    def test_the_code_text_of_an_execute_is_not_inspected(self):
        x = execute_jev("x1", T0 + 1, T0 + 2); x["state"]["input"]["code"] = "// tools.jev.jev_verify tools.jev.jev_verify twice in a comment\nreturn await tools.jev.jev_verify({})"
        self.assertEqual(len(self.calls(x)), 1)

class EndToEnd(Base):
    def oc_session(self, with_jev=True, sid="ses_e2e"):
        blocks = [tool("w1", "write", dict(filePath=self.path(), content="# Handoff\n- alpha\n"), T0 + 10, T0 + 12)]
        if with_jev: blocks.append(tool("j1", "jev:jev_verify", jev_input(), T0 + 20, T0 + 25, out=jev_json()))
        return self.sel([user("Goal: ship it.", T0), assistant(blocks, T0 + 9)], sid=sid)

    def doc(self, source, calls_ref="j1"):
        vs = versions.versions_of(source, self.path())[0]
        chk = dict(id="p1", tool="verify", verdict="supported", confidence=0.99, jev_ref=dict(tool_use_id=calls_ref, result_index=0, key=CLAIM), version_ref=versions.version_ref(vs[0], "session_end"))
        return dict(session=dict(session_id="ses_e2e", jsonl=source, cwd=self.cwd), handoff=dict(path=self.path(), versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS")

    def test_versions_and_gate_on_an_opencode_session(self):
        sel = self.oc_session(); open(self.path(), "w").write("# Handoff\n- alpha\n")
        vs, canon, how, _ = versions.versions_of(sel, self.path()); self.assertEqual((how, canon, [v["status"] for v in vs], vs[0]["sha256"]), ("realpath", self.path(), ["ok"], sha("# Handoff\n- alpha\n")))
        rd = os.path.join(self.base, "run"); os.makedirs(rd); md, js = report.write_report(rd, self.path(), self.doc(sel), "Stare: **PASS**\n", calls_jsonl=sel)
        doc = json.load(open(os.path.join(rd, js)))
        self.assertEqual(doc["delivery"]["delivery_state"], "verified_version"); self.assertEqual(doc["binding_summary"]["version_identity"]["same_session"], True)
        g = versions.gate(sel, self.path(), doc, disk_path=self.path()); self.assertEqual(g["delivery_state"], "verified_version")
        self.assertTrue(versions.same_session(sel, sel)); self.assertEqual(doc["session"]["jsonl"], sel)

    def test_opencode_source_with_a_claude_calls_session_is_a_retrospective_split(self):
        src = self.oc_session(with_jev=False); open(self.path(), "w").write("# Handoff\n- alpha\n")
        log = os.path.join(self.base, "claude.jsonl"); recs = [dict(type="assistant", uuid="u1", timestamp="2026-01-01T00:00:01Z", cwd=self.cwd, sessionId="claude1", message=dict(role="assistant", content=[dict(type="tool_use", id="j1", name="mcp__jev__jev_verify", input=jev_input())])),
                                                               dict(type="user", uuid="u2", timestamp="2026-01-01T00:00:02Z", cwd=self.cwd, sessionId="claude1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="j1", content=jev_json())]))]
        open(log, "w").write("".join(json.dumps(r) + "\n" for r in recs))
        self.assertFalse(versions.same_session(src, log)); self.assertFalse(versions.same_session(log, src))
        rd = os.path.join(self.base, "run"); os.makedirs(rd); md, js = report.write_report(rd, self.path(), self.doc(src), "Stare: **PASS**\n", calls_jsonl=log)
        doc = json.load(open(os.path.join(rd, js))); vi = doc["binding_summary"]["version_identity"]
        self.assertEqual((vi["same_session"], vi["identity_ok"], vi["identity_failed"]), (False, 1, 0)); self.assertEqual(doc["status"], "PASS")
        self.assertNotIn("delivery", doc)   # a retrospective report never certifies a current delivery
        p = versions.gate(log, self.path(), doc, disk_path=self.path()); self.assertEqual(p["delivery_state"], "unresolved")

    def test_an_opencode_selector_is_never_the_same_session_as_a_claude_jsonl(self):
        sel = self.oc_session(sid="ses_same"); log = os.path.join(self.base, "copy.jsonl")
        recs = self.O.records(sel); self.assertTrue(any(c.get("type") == "tool_use" for r in recs for c in r["message"]["content"]))
        open(log, "w").write("".join(json.dumps(r) + "\n" for r in recs))   # same session id, identical normalized tool ids/names/inputs
        self.assertEqual(sorted(versions._identity(log)[1]), sorted(versions._identity(sel)[1])); self.assertIn("ses_same", versions._identity(log)[0])
        for a, b in ((sel, log), (log, sel)):
            self.assertFalse(versions.same_session(a, b)); self.assertFalse(versions.same_session(a, b, "ses_same"))
        self.assertTrue(versions.same_session(sel, sel)); self.assertTrue(versions.same_session(log, log))

    def test_cli_dispatch_list_and_jevref_accept_the_selector_and_old_flags_still_work(self):
        import subprocess
        sel = self.oc_session(); env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "list", "--source", sel, "--file", self.path(), "--evaluated-against", "session_end"], capture_output=True, text=True, env=env)
        out = json.loads(p.stdout); self.assertEqual((p.returncode, out["source_session_jsonl"], out["versions"][0]["write_tool_use_id"]), (0, self.O.canonical(sel), "w1"))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "jevref.py"), "list", "--session", sel], capture_output=True, text=True, env=env)
        out = json.loads(p.stdout); self.assertEqual((p.returncode, [c["tool_use_id"] for c in out["calls"]]), (0, ["j1"]))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "list", "--source", "opencode-db:%s#ses_nope" % self.fx.db, "--file", self.path(), "--evaluated-against", "session_end"], capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 3)

    def test_prepare_on_an_opencode_session_writes_only_its_run_directory(self):
        import subprocess
        sel = self.oc_session(); work = os.path.join(self.base, "out"); before = sorted(os.listdir(self.fx.dir)); cwdfiles = sorted(os.listdir(self.cwd))
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), sel, "--out", work], capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout); out = json.loads(p.stdout); self.assertEqual((out["session_id"], out["handoff_files"], out["versions"]), ("ses_e2e", 1, 1))
        inv = json.load(open(os.path.join(work, "inventory.json"))); self.assertEqual(inv["session"]["jsonl"], self.O.canonical(sel))
        self.assertEqual(sorted(os.listdir(self.fx.dir)), before); self.assertEqual(sorted(os.listdir(self.cwd)), cwdfiles)

    def test_adapter_creates_no_files(self):
        sel = self.oc_session(); before = {d: sorted(os.listdir(d)) for d in (self.fx.dir, self.cwd, self.base)}
        self.O.records(sel); self.O.load(sel); D.inventory(sel); D.reads(sel); J.load_calls(sel); versions.versions_of(sel, self.path()); D.source_exists(sel)
        self.assertEqual({d: sorted(os.listdir(d)) for d in before}, before)
        self.assertFalse(os.path.exists(os.path.join(self.cwd, ".handoff-verify")))

class ClaudeUnchanged(unittest.TestCase):
    """A Claude Code JSONL is loaded, inventoried and bound exactly as before (the adapter is reachable only through an explicit selector)."""
    def test_jsonl_behaviour_is_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d); h = os.path.join(d, "HANDOFF.md"); log = os.path.join(d, "s.jsonl")
            recs = [dict(type="assistant", uuid="a1", timestamp="2026-01-01T00:00:01Z", cwd=d, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="w1", name="Write", input=dict(file_path=h, content="x\n"))])),
                    dict(type="user", uuid="u1", timestamp="2026-01-01T00:00:02Z", cwd=d, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w1", content="ok")])),
                    dict(type="assistant", uuid="a2", timestamp="2026-01-01T00:00:03Z", cwd=d, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="j1", name="mcp__jev__jev_verify", input=jev_input())])),
                    dict(type="user", uuid="u2", timestamp="2026-01-01T00:00:04Z", cwd=d, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="j1", content=jev_json())]))]
            open(log, "w").write("".join(json.dumps(r) + "\n" for r in recs))
            loaded = D.load_jsonl(log); self.assertEqual([r["_line"] for r in loaded], [1, 2, 3, 4]); self.assertTrue(all("_adapter" not in r for r in loaded))
            items, bash = D.inventory(log); self.assertEqual(([(i["tool_use_id"], i["op"], i["success"], i["pos"], i["result_pos"]) for i in items], bash), ([("w1", "Write", True, 1, 2)], []))
            self.assertNotIn("unrecoverable", items[0]); self.assertEqual([(c["tool_use_id"], c["tool"], c["pos"], c["result_pos"]) for c in J.load_calls(log)], [("j1", "verify", 3, 4)])
            self.assertEqual([(v["status"], v["content"]) for v in versions.versions_of(log, h)[0]], [("ok", "x\n")]); self.assertEqual(D.subagent_files(log), [])
            self.assertEqual(D.session_label(log), "s"); self.assertTrue(D.source_exists(log)); self.assertFalse(D.source_exists(os.path.join(d, "none.jsonl"))); self.assertEqual(D.canon(log), os.path.realpath(log))
    def test_a_claude_record_cannot_smuggle_the_adapter_marker(self):
        with tempfile.TemporaryDirectory() as d:
            h = os.path.join(d, "HANDOFF.md"); log = os.path.join(d, "s.jsonl")
            recs = [dict(type="assistant", uuid="a1", timestamp="t", cwd=d, message=dict(role="assistant", content=[dict(type="tool_use", id="w1", name="Write", input=dict(file_path=h, content="x\n", _unrecoverable="forged"))])),
                    dict(type="user", uuid="u1", timestamp="t", cwd=d, message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w1", content="ok")]))]
            open(log, "w").write("".join(json.dumps(r) + "\n" for r in recs))
            self.assertEqual([(v["status"], v["content"]) for v in versions.versions_of(log, h)[0]], [("ok", "x\n")])

REAL_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
NAMED = ("ses_ef5368f1cffeRFX881YJfngQ27", "ses_ef5368d6affe3oTBXKW3l8zxy2")

@unittest.skipUnless(os.path.isfile(REAL_DB), "no default OpenCode database at ~/.local/share/opencode/opencode.db")
class RealSessions(unittest.TestCase):
    """Runs the adapter on real local sessions (read-only, nothing printed from session text)."""
    @classmethod
    def setUpClass(cls):
        import opencode; cls.O = opencode
        cls.con = sqlite3.connect("file:%s?mode=ro" % REAL_DB, uri=True)
    @classmethod
    def tearDownClass(cls): cls.con.close()

    def has(self, sid): return self.con.execute("SELECT 1 FROM session_v2 WHERE id=?", (sid,)).fetchone() is not None
    def raw_mutations(self, sid):
        out = []
        for (d,) in self.con.execute("SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq", (sid,)):
            for b in json.loads(d).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool" and b.get("name") in ("write", "edit", "patch") and (b.get("state") or {}).get("status") == "completed": out.append(b["id"])
        return out
    def check(self, sid):
        sel = "opencode:" + sid; before = os.stat(REAL_DB).st_mtime_ns
        recs, notes = self.O.load(sel)
        ids = [c["id"] for c, _ in uses(recs)]; self.assertEqual(len(ids), len(set(ids)), "unique tool_use ids")
        res = results(recs); self.assertTrue(set(res) <= set(ids), "every result correlates to a tool_use"); self.assertEqual(len(res), len([r for r in recs if r["type"] == "user" and r["message"]["content"][0].get("type") == "tool_result"]), "one result per id")
        self.assertEqual([r["_line"] for r in recs], list(range(1, len(recs) + 1)))
        mut = [(c, r) for c, r in uses(recs) if c["name"] in ("Write", "Edit")]
        for c, r in mut:
            if c["id"] in res and not res[c["id"]][0]["is_error"]:
                i = c["input"]; self.assertTrue(isinstance(i.get("_unrecoverable"), str) and i["_unrecoverable"] or (c["name"] == "Write" and isinstance(i.get("content"), str)) or (c["name"] == "Edit" and isinstance(i.get("old_string"), str) and isinstance(i.get("new_string"), str)))
        covered = {re.sub(r"(~\d+)?(#\d+)?$", "", i) for i in ids} | {n["call_id"] for n in notes}
        for cid in self.raw_mutations(sid): self.assertIn(re.sub(r"~\d+$", "", cid), covered, "every successful write/edit/patch is mapped or explicitly unrecoverable")
        self.assertEqual(os.stat(REAL_DB).st_mtime_ns, before, "read-only")
        return recs, mut

    def test_named_sessions_have_valid_unique_pairs_and_no_mutations(self):
        for sid in NAMED:
            with self.subTest(sid):
                if not self.has(sid): self.skipTest("session %s is not in the local database" % sid)
                recs, mut = self.check(sid); self.assertEqual(mut, []); self.assertTrue(recs); self.assertTrue(uses(recs))
                self.assertEqual(D.inventory("opencode:" + sid)[0], [])

    def test_sessions_with_write_edit_patch_parts_map_or_are_marked_unrecoverable(self):
        sids = [r[0] for r in self.con.execute("""SELECT session_id FROM session_message WHERE type='assistant' AND (data LIKE '%"name":"write"%' OR data LIKE '%"name":"edit"%' OR data LIKE '%"name":"patch"%')
                                                  GROUP BY session_id ORDER BY MAX(time_created) DESC LIMIT 15""")]
        sids = [s for s in sids if self.has(s)]
        if not sids: self.skipTest("no v2 session with write/edit/patch tool parts in the local database")
        total = 0
        for sid in sids:
            with self.subTest(sid): self.check(sid); total += 1
        self.assertGreaterEqual(total, 1)

if __name__ == "__main__": unittest.main()

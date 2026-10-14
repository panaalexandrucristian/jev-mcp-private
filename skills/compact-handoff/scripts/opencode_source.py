#!/usr/bin/env python3
"""opencode_source.py: one OpenCode session (SQLite, tables session_v2 + session_message of OpenCode 2.0.x) as the Claude-shaped text that compact_context.py already processes.
Used by make_context.py (--opencode DB [--session ID], and --current, which also searches the OpenCode database). Stdlib only; the database is opened read-only (file: URI, mode=ro, PRAGMA query_only) and never written.

Every record is  [uuid role] text  with a uuid5 of the OpenCode message id and an index, so REC / kind_of / compact_text / the round trip work unchanged:
  user text and assistant text parts          whole, one record each
  a tool call                                 assistant record  [tool_use NAME] key: value lines  (raw strings: no JSON escaping; nested values as path[0].sub: value)
  its result                                  user record  [tool_result] text  /  [tool_result ERROR] type: message  /  (no output; status ...), then a last line  (exit N, truncated)  from state.metadata only
  an image / file block of a result           its own user record  [tool_result file] mime: / name: / uri:  (NOT sanitized; make_context forces it into a blob, whole)
  system, synthetic                           [opencode system] / [opencode synthetic] text, whole
  compaction                                  [opencode compaction summary] summary, whole; [opencode compaction recent] recent, forced into a blob
  idle, model/agent/location-switched, ...    one short line  [opencode <kind>] ...
  NOT rendered: reasoning text and reasoningEncryptedContent (dropped on purpose), JSON overhead, tokens, snapshots, times, providerState, the rest of state.metadata.
Everything but the file records passes through handoff-verify's sanitize.sanitize, exactly as its prepare.py does for the Claude records.

  opencode_source.py --selftest"""
import collections
import importlib.util
import json
import os
import sqlite3
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compact_context as cc

NS = uuid.UUID("0f1c8a52-6d0e-4c1b-9a77-5b3e2d41c0a9")   # fixed, so the same session always gives the same uuids
FIRST_CALLS = 4
EVENT_MAX = 300
LEGACY = "legacy OpenCode sessions are not supported (this database or session exists only in the legacy tables session/message/part; only session_v2/session_message are read)"


class OpenCodeError(Exception):
    """A message for the user: the database or the session cannot be used."""


# ---- the database --------------------------------------------------------------------------------------------------------------------------------
def default_db():
    """$XDG_DATA_HOME/opencode/opencode.db, else ~/.local/share/opencode/opencode.db (read now, so a test can set HOME and XDG_DATA_HOME)."""
    xdg = os.environ.get("XDG_DATA_HOME")
    return os.path.join(xdg if xdg else os.path.join(os.path.expanduser("~"), ".local", "share"), "opencode", "opencode.db")


def connect(path):
    """Read-only connection (mode=ro in the URI, and query_only). OpenCodeError when the file cannot be opened or is not a database."""
    uri = "file:" + os.path.abspath(path).replace("%", "%25").replace("?", "%3F").replace("#", "%23") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.execute("PRAGMA query_only=ON")
        conn.execute("select count(*) from sqlite_master").fetchone()   # a file that is not a database fails here
    except sqlite3.Error as e:
        raise OpenCodeError("the OpenCode database %s cannot be read (%s)" % (path, e))
    return conn


def tables(conn):
    return {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}


def session_ids(conn):
    """The ids in session_v2, oldest first. [] when the table is missing."""
    if "session_v2" not in tables(conn): return []
    return [r[0] for r in conn.execute("select id from session_v2 order by time_created, id")]


def legacy_has(conn, sid=None):
    """True when the legacy table `session` holds rows (or the row `sid`)."""
    if "session" not in tables(conn): return False
    try:
        if sid is None: return conn.execute("select count(*) from session").fetchone()[0] > 0
        return conn.execute("select count(*) from session where id = ?", (sid,)).fetchone()[0] > 0
    except sqlite3.Error:
        return False


def pick_session(conn, session=None, limit=20):
    """-> the session id to convert. Zero sessions, several without `session`, an unknown id and a legacy-only database or id are errors."""
    ids = session_ids(conn)
    if session is not None:
        if session in ids: return session
        if legacy_has(conn, session): raise OpenCodeError(LEGACY)
        raise OpenCodeError("--session %s: no such session in session_v2 (%d sessions in this database)" % (session, len(ids)))
    if len(ids) == 1: return ids[0]
    if not ids:
        if legacy_has(conn): raise OpenCodeError(LEGACY)
        raise OpenCodeError("no session in session_v2 of this database")
    shown = ", ".join(ids[:limit]) + (" … and %d more" % (len(ids) - limit) if len(ids) > limit else "")
    raise OpenCodeError("%d sessions in this database; pick one with --session ID: %s" % (len(ids), shown))


def find_current(marker, db, max_age=1800, now=None):
    """The ids of the sessions with a message row created in the last `max_age` seconds whose data holds `marker`. A missing file is skipped (-> []); a database without session_message gives []; an existing file that
    cannot be read raises OpenCodeError (the caller names --no-opencode). time_created is in milliseconds."""
    if not os.path.exists(db): return []
    conn = connect(db)
    try:
        if "session_message" not in tables(conn): return []
        cutoff = int(((time.time() if now is None else now) - max_age) * 1000)
        try:
            return sorted(r[0] for r in conn.execute("select distinct session_id from session_message where time_created >= ? and instr(data, ?) > 0", (cutoff, marker)))
        except sqlite3.Error as e:
            raise OpenCodeError("the OpenCode database %s cannot be searched (%s)" % (db, e))
    finally:
        conn.close()


# ---- the sanitizer of handoff-verify -------------------------------------------------------------------------------------------------------------
def _hv_scripts():
    """handoff-verify's scripts (the same lookup as prepare_all.py, which cannot be imported: it runs the whole of prepare.py): HV_SCRIPTS, else the sibling skill, else the newest installed copy of the jev plugin."""
    import glob
    cands = [os.environ.get("HV_SCRIPTS"), os.path.join(HERE, "..", "..", "handoff-verify", "scripts")]
    cands += sorted(glob.glob(os.path.expanduser("~/.claude/plugins/cache/*/jev/*/skills/handoff-verify/scripts")), reverse=True)
    for c in cands:
        if c and os.path.exists(os.path.join(c, "sanitize.py")): return os.path.abspath(c)
    sys.exit("handoff-verify's scripts (sanitize.py) not found: set HV_SCRIPTS to their folder")


_SANITIZE = []


def sanitize(text):
    """-> the text with the demonstrable secrets redacted (handoff-verify's sanitize.sanitize; the module is loaded from its file, so nothing else of that folder enters sys.path)."""
    if not _SANITIZE:
        spec = importlib.util.spec_from_file_location("hv_sanitize", os.path.join(_hv_scripts(), "sanitize.py"))
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); _SANITIZE.append(mod.sanitize)
    return _SANITIZE[0](text)[0]


# ---- rendering -----------------------------------------------------------------------------------------------------------------------------------
class Rec:
    """One rendered record: text (final, as written to the chunk), kind, the whole strings it was rendered from (`needs`), whether the sanitizer changed it, and for a file block its uri."""
    __slots__ = ("uuid", "role", "text", "needs", "changed", "uri")

    def __init__(self, uid, role, text, needs, changed, uri=None):
        self.uuid, self.role, self.text, self.needs, self.changed, self.uri = uid, role, text, needs, changed, uri


class Rendered:
    def __init__(self):
        self.recs = []; self.readonly = set(); self.forced = {}; self.first_calls = []; self.original = 0
        self.n_compaction_recent = 0; self.n_files = 0; self.dropped_reasoning = 0; self.dropped_encrypted = 0; self.sanitized = 0; self.skipped = collections.Counter()

    @property
    def text(self): return "".join(r.text for r in self.recs)


class Lit(str):
    """The text '{}' or '[]' standing for an empty container: not a string of the source."""


def flat(v, path=""):
    """-> [(path, leaf)]: nested dicts as path.sub, lists as path[0]; an empty container is the leaf '{}' / '[]'."""
    if isinstance(v, dict):
        if not v: return [(path, Lit("{}"))] if path else []
        return [p for k, x in v.items() for p in flat(x, "%s.%s" % (path, k) if path else str(k))]
    if isinstance(v, list):
        if not v: return [(path, Lit("[]"))]
        return [p for i, x in enumerate(v) for p in flat(x, "%s[%d]" % (path, i))]
    return [(path, v)]


def leaf_text(v): return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def input_lines(inp):
    """-> (text, [whole strings]) of a tool call input: 'key: value' lines with the raw strings (a multi-line value stays multi-line)."""
    pairs = flat(inp)
    lines = [("%s: %s" % (p, leaf_text(v))) if p else leaf_text(v) for p, v in pairs]
    return "\n".join(lines), [v for _, v in pairs if isinstance(v, str) and not isinstance(v, Lit)]


def event_line(kind, j):
    """One short line for a row that is not a message: its scalar fields (times left out), at most EVENT_MAX characters."""
    body = ", ".join("%s=%s" % (p, leaf_text(v)) for p, v in flat({k: x for k, x in j.items() if k != "time"}) if v not in ("", None)) if isinstance(j, dict) else leaf_text(j)
    body = body.replace("\n", "⏎")
    return "[opencode %s] %s" % (kind, body if len(body) <= EVENT_MAX else body[:EVENT_MAX] + "…")


def result_suffix(name, meta):
    """The only facts kept from state.metadata: a shell tool's exit code and the truncated flag; another tool only the truncated flag."""
    if not isinstance(meta, dict): return ""
    trunc = meta.get("truncated") is True
    if name.lower() in ("shell", "bash") and "exit" in meta: return "(exit %s%s)" % (leaf_text(meta["exit"]), ", truncated" if trunc else "")
    return "(truncated)" if trunc else ""


def render(conn, sid):
    """-> Rendered for the session `sid`: the records in seq order, the uuids of the read-only calls, the forced records {uuid: marker label}, the first tool calls (for the parent handoff), the original size."""
    R = Rendered()
    R.original = conn.execute("select coalesce(sum(length(data)), 0) from session_message where session_id = ?", (sid,)).fetchone()[0]
    count = collections.Counter()

    def add(mid, role, body, needs=(), sanitized=True, uri=None):
        n = count[mid]; count[mid] += 1
        uid = str(uuid.uuid5(NS, "%s/%s/%d" % (sid, mid, n)))
        raw = "[%s %s] %s\n" % (uid, role, body)
        text = sanitize(raw) if sanitized else raw
        changed = text != raw
        R.sanitized += changed
        R.recs.append(Rec(uid, role, text, [s for s in needs if s], changed, uri))
        return uid

    for mid, typ, data in conn.execute("select id, type, data from session_message where session_id = ? order by seq, rowid", (sid,)):
        try: j = json.loads(data)
        except (TypeError, ValueError): j = None
        if not isinstance(j, dict):
            add(mid, "user", "[opencode %s] (the data of this row is not a JSON object)" % typ); R.skipped["unreadable"] += 1; continue
        if typ == "user":
            t = j.get("text") if isinstance(j.get("text"), str) else ""
            add(mid, "user", t, [t])
        elif typ in ("system", "synthetic"):
            t = j.get("text") if isinstance(j.get("text"), str) else ""
            add(mid, "user", "[opencode %s] %s" % (typ, t))
        elif typ == "compaction":
            add(mid, "user", "[opencode compaction summary] %s" % (j["summary"] if isinstance(j.get("summary"), str) else ""))
            if isinstance(j.get("recent"), str) and j["recent"]:
                uid = add(mid, "user", "[opencode compaction recent] %s" % j["recent"]); R.forced[uid] = "[opencode compaction recent]"; R.n_compaction_recent += 1
        elif typ == "assistant":
            for part in j.get("content") or []:
                pt = part.get("type") if isinstance(part, dict) else None
                if pt == "text":
                    t = part.get("text") if isinstance(part.get("text"), str) else ""
                    add(mid, "assistant", t, [t])
                elif pt == "reasoning":
                    R.dropped_reasoning += len(part.get("text") or "")
                    st = part.get("state")
                    R.dropped_encrypted += len((st or {}).get("reasoningEncryptedContent") or "") if isinstance(st, dict) else 0
                elif pt == "tool":
                    render_tool(R, add, mid, part)
                else:
                    add(mid, "user", "[opencode assistant content %s omitted]" % (pt,)); R.skipped["content:%s" % (pt,)] += 1
            if isinstance(j.get("error"), dict):   # the message itself failed (for example an interrupted step)
                add(mid, "assistant", "[opencode assistant error] %s: %s" % (leaf_text(j["error"].get("type")), leaf_text(j["error"].get("message"))))
        else:   # idle, model-switched, agent-switched, location-switched, and any type this version does not know
            add(mid, "user", event_line(typ, j))
    return R


def render_tool(R, add, mid, part):
    name = part.get("name") if isinstance(part.get("name"), str) else "unknown"
    state = part.get("state") if isinstance(part.get("state"), dict) else {}
    inp = state.get("input")
    body, strings = input_lines(inp)
    uid = add(mid, "assistant", ("[tool_use %s] %s" % (name, body)) if body else "[tool_use %s]" % name, strings)
    if len(R.first_calls) < FIRST_CALLS: R.first_calls.append((name, inp))
    if name.lower() in ("read", "grep", "glob"): R.readonly.add(uid)
    elif name.lower() in ("shell", "bash") and isinstance(inp, dict) and isinstance(inp.get("command"), str) and cc.readonly_command(inp["command"]): R.readonly.add(uid)
    status = state.get("status"); err = state.get("error")
    texts, files = [], []
    for blk in state.get("content") or []:
        if not isinstance(blk, dict): continue
        if blk.get("type") == "text":
            if isinstance(blk.get("text"), str) and blk["text"]: texts.append(blk["text"])
        elif blk.get("type") == "file": files.append(blk)
        else: texts.append(json.dumps(blk, ensure_ascii=False))
    out = "\n".join(texts); suffix = result_suffix(name, state.get("metadata"))
    if isinstance(err, dict) or status == "error":
        head = "[tool_result ERROR] %s: %s" % (leaf_text(err.get("type")), leaf_text(err.get("message"))) if isinstance(err, dict) else "[tool_result ERROR] (no error recorded; status %s)" % status
        res = head + ("\n" + out if out else "")
    elif status != "completed":
        res = "[tool_result] (no result recorded; status %s)" % leaf_text(status) + ("\n" + out if out else "")
    elif out: res = "[tool_result] " + out
    elif not files or suffix: res = "[tool_result] (no output; status completed)"
    else: res = None
    if res is not None: add(mid, "user", res + ("\n" + suffix if suffix else ""))
    for blk in files:
        uri = blk["uri"] if isinstance(blk.get("uri"), str) else ""
        mime = leaf_text(blk.get("mime", "")); fname = leaf_text(blk.get("name", ""))
        fid = add(mid, "user", "[tool_result file]\nmime: %s\nname: %s\nuri: %s" % (mime, fname, uri), sanitized=False, uri=uri)
        R.forced[fid] = "[file %s %s, %d chars]" % (mime[:40], fname[:60], len(uri)); R.n_files += 1


def find_parents(first_calls, pattern):
    """The handoff files (paths matching `pattern`) that a `read` among the first tool calls opened, in order, without duplicates."""
    found = []
    for name, inp in first_calls:
        p = inp.get("path") if isinstance(inp, dict) and name.lower() == "read" else None
        if isinstance(p, str) and pattern.search(p) and p not in found: found.append(p)
    return found


# ---- the self-check ------------------------------------------------------------------------------------------------------------------------------
def selfcheck(R, expanded, blob_texts):
    """After the round trip: every record sits in the expanded output where it was rendered. A record that the sanitizer left unchanged holds every whole string it was rendered from (user text, assistant text part,
    tool-input string) at least as often as the source has it; records the sanitizer changed are not string-checked (its rules depend on the context, e.g. an input key `token`). For a file block the ORIGINAL uri
    from the database occurs unchanged in its place and in a blob. -> a list of problems (empty = fine)."""
    bad, pos = [], 0
    for r in R.recs:
        seg = expanded[pos:pos + len(r.text)]; pos += len(r.text)
        if seg != r.text: bad.append("record %s is not where it was rendered" % r.uuid); continue
        if r.uri is not None:
            if r.uri not in seg: bad.append("record %s: the uri of the file block is not unchanged in the output" % r.uuid)
            if r.text not in blob_texts: bad.append("record %s: the file block is not whole in a blob" % r.uuid)
        elif not r.changed:
            for s, k in collections.Counter(r.needs).items():
                if seg.count(s) < k: bad.append("record %s: a string of the source (%d chars) occurs %d times instead of %d" % (r.uuid, len(s), seg.count(s), k))
    if pos != len(expanded): bad.append("the output is %d characters longer than the rendered records" % (len(expanded) - pos))
    return bad[:5]


# ---- self test -----------------------------------------------------------------------------------------------------------------------------------
def make_db(path, sessions, legacy=None, now_ms=None):
    """A test database: `sessions` = {session id: [(type, data dict, age in seconds)]} (rows in the given order, seq 1, 2, ...); `legacy` = ids to put in a legacy `session` table. Times are in milliseconds."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    c = sqlite3.connect(path)
    c.execute("create table session_v2(id TEXT, time_created INT)")
    c.execute("create table session_message(id TEXT, session_id TEXT, type TEXT, seq INT, time_created INT, time_updated INT, data TEXT)")
    for i, (sid, rows) in enumerate(sessions.items()):
        c.execute("insert into session_v2 values (?, ?)", (sid, now - 1000 * 1000 + i))
        for seq, (typ, data, age) in enumerate(rows, 1):
            c.execute("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", ("msg_%s_%d" % (sid[-6:], seq), sid, typ, seq, now - int(age * 1000), now - int(age * 1000), json.dumps(data, ensure_ascii=False)))
    if legacy:
        c.execute("create table session(id TEXT)"); c.execute("create table message(id TEXT)"); c.execute("create table part(id TEXT)")
        for sid in legacy: c.execute("insert into session values (?)", (sid,))
    c.commit(); c.close()
    return path


def synthetic_rows(secret="API_TOKEN=abcd1234efgh5678", uri_tail="aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY" * 8):
    """One session with every message type and every content kind (used by the tests of make_context.py too)."""
    uri = "data:image/png;base64,iVBORw0KGgo" + uri_tail + "=="
    tool = lambda name, inp, status="completed", content=None, error=None, meta=None, **kw: {"type": "tool", "name": name, "executed": False, "state": dict({"status": status, "input": inp}, **({"content": content} if content is not None else {}),
                                                                                                                                                           **({"error": error} if error else {}), **({"metadata": meta} if meta else {})), **kw}
    txt = lambda s: [{"type": "text", "text": s}]
    return [
        ("user", {"time": {"created": 1}, "text": "Salut! Fă un plan pentru fișierul „raport” – cu diacritice: ăâîșț, 日本語 și emoji 🙂."}, 90),
        ("system", {"description": "Instructions updated: core/x", "text": "SYSTEM TEXT one two three"}, 89),
        ("synthetic", {"text": "SYNTHETIC TEXT four five"}, 88),
        ("model-switched", {"time": {"created": 1}, "model": {"id": "m-two", "providerID": "prov"}}, 87),
        ("agent-switched", {"agent": "build"}, 86),
        ("location-switched", {"location": "/work/dir"}, 85),
        ("assistant", {"agent": "build", "model": {"id": "m-two", "providerID": "prov", "variant": "high"}, "cost": 0, "tokens": {"input": 1}, "finish": "tool-calls", "snapshot": "abc", "time": {"created": 2}, "providerState": {}, "content": [
            {"type": "reasoning", "text": "REASONING SECRET WORDS", "state": {"itemId": "i1", "reasoningEncryptedContent": "ENCRYPTEDBLOB" * 50}},
            {"type": "text", "text": "I will look at the files first.", "state": {"itemId": "i2", "phase": "commentary"}},
            tool("shell", {"command": "ls -la /work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker", "workdir": "/work/dir", "timeout": 5000}, content=txt("total 0\nfile-a\nfile-b"), meta={"exit": 0, "truncated": False, "shellID": "s1"}),
            tool("shell", {"command": "git commit -m 'x'"}, content=txt("[main abc] x"), meta={"exit": 1, "truncated": True}),
            tool("read", {"path": "/work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker/big.txt", "offset": 1, "limit": 20}, content=txt("1\tline one\n2\tline two\n" + "payload " * 80), meta={"truncated": True}),
            tool("patch", {"patchText": "*** Begin Patch\n*** Update File: a.txt\n@@\n-old line\n+new line é\n*** End Patch"}, content=txt("patched"), meta={"files": ["a.txt"], "truncated": False}),
            tool("custom", {"nested": {"list": ["alpha", {"deep": "beta"}], "n": 3, "flag": True, "empty": {}}, "token": "s3cretValue99xyz"}, content=txt("ok " + secret + " and more text after it"), meta={"truncated": False}),
            tool("patch", {"patchText": "*** Begin Patch\n*** End Patch"}, status="error", error={"type": "tool.execution", "message": "patch verification failed: no lines"}),
            tool("grep", {"pattern": "needle", "path": "/work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker"}, content=[], meta={"matches": 0, "truncated": False}),
            tool("webfetch", {"url": "https://example.com/x"}, status="running"),
            tool("read", {"path": "/work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker/shot.png"}, content=[{"type": "text", "text": "Image read successfully. Token=TOKENabcdefgh12345 near the image"}, {"type": "file", "mime": "image/png", "name": "shots/one.png", "uri": uri}], meta={"truncated": False}),
        ]}, 80),
        ("compaction", {"time": {"created": 3}, "status": "done", "reason": "overflow", "model": {"id": "m"}, "providerState": {}, "summary": "COMPACTION SUMMARY: goal and decisions so far", "recent": "RECENT TEXT " + "of the recent turns " * 30, "cost": 0, "tokens": {}}, 70),
        ("assistant", {"agent": "build", "model": {"id": "m-two"}, "cost": 0, "tokens": {}, "finish": "error", "providerState": {}, "error": {"type": "aborted", "message": "Step interrupted"}, "content": [{"type": "text", "text": "Final answer text."}]}, 60),
        ("idle", {"time": {"created": 4}, "outcome": "succeeded"}, 50),
    ]


def selftest():
    import io
    import shutil
    import tempfile
    n = 0
    d = tempfile.mkdtemp()
    try:
        # the default path: XDG_DATA_HOME first, then HOME
        keep = {k: os.environ.get(k) for k in ("XDG_DATA_HOME", "HOME")}
        try:
            os.environ["XDG_DATA_HOME"] = "/x/xdg"; os.environ["HOME"] = "/x/home"
            assert default_db() == "/x/xdg/opencode/opencode.db"
            os.environ["XDG_DATA_HOME"] = ""
            assert default_db() == "/x/home/.local/share/opencode/opencode.db"
            del os.environ["XDG_DATA_HOME"]
            assert default_db() == "/x/home/.local/share/opencode/opencode.db"; n += 3
        finally:
            for k, v in keep.items():
                if v is None: os.environ.pop(k, None)
                else: os.environ[k] = v
        # the flattening of an input
        text, strings = input_lines({"command": "ls", "n": 3, "t": True, "x": None, "o": {"a": ["p", {"q": "r"}], "e": {}, "l": []}, "ml": "one\ntwo"})
        assert text == "command: ls\nn: 3\nt: true\nx: null\no.a[0]: p\no.a[1].q: r\no.e: {}\no.l: []\nml: one\ntwo" and strings == ["ls", "p", "r", "one\ntwo"], text; n += 1
        assert input_lines(None) == ("null", []) and input_lines({}) == ("", []); n += 1
        # the suffix: shell exit always, truncated only when true; another tool only truncated; nothing else of the metadata
        for name, meta, want in (("shell", {"exit": 0, "truncated": False}, "(exit 0)"), ("shell", {"exit": 1, "truncated": True, "shellID": "s"}, "(exit 1, truncated)"), ("bash", {"exit": 2}, "(exit 2)"),
                                 ("read", {"truncated": True}, "(truncated)"), ("read", {"truncated": False}, ""), ("grep", {"matches": 3}, ""), ("shell", {"truncated": True}, "(truncated)"), ("shell", None, ""), ("patch", {"files": ["a"]}, "")):
            assert result_suffix(name, meta) == want, (name, meta, want); n += 1
        # a session with every message type and content kind
        db = make_db(os.path.join(d, "one.sqlite"), {"ses_0123456789abcdefAAAAAA": synthetic_rows()})
        conn = connect(db); sid = pick_session(conn); R = render(conn, sid)
        assert sid == "ses_0123456789abcdefAAAAAA" and R.original == conn.execute("select sum(length(data)) from session_message").fetchone()[0]; n += 1
        t = R.text
        for must in ("Fă un plan pentru fișierul „raport” – cu diacritice: ăâîșț, 日本語 și emoji 🙂.", "[opencode system] SYSTEM TEXT one two three", "[opencode synthetic] SYNTHETIC TEXT four five", "[opencode model-switched] model.id=m-two, model.providerID=prov",
                     "[opencode agent-switched] agent=build", "[opencode location-switched] location=/work/dir", "I will look at the files first.", "[tool_use shell] command: ls -la /work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker\nworkdir: /work/dir\ntimeout: 5000",
                     "[tool_result] total 0\nfile-a\nfile-b\n(exit 0)", "(exit 1, truncated)", "[tool_use read] path: /work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker/big.txt\noffset: 1\nlimit: 20", "(truncated)", "patchText: *** Begin Patch\n*** Update File: a.txt\n@@\n-old line\n+new line é\n*** End Patch",
                     "nested.list[0]: alpha\nnested.list[1].deep: beta\nnested.n: 3\nnested.flag: true\nnested.empty: {}", "[tool_result ERROR] tool.execution: patch verification failed: no lines", "[tool_result] (no output; status completed)",
                     "[tool_result] (no result recorded; status running)", "[opencode compaction summary] COMPACTION SUMMARY", "[opencode compaction recent] RECENT TEXT", "[opencode assistant error] aborted: Step interrupted", "Final answer text.",
                     "[opencode idle] outcome=succeeded", "[tool_result file]\nmime: image/png\nname: shots/one.png\nuri: data:image/png;base64,iVBORw0KGgoaB3dE5fG7hJ9kL1m"):
            assert must in t, must; n += 1
        assert "REASONING SECRET" not in t and "ENCRYPTEDBLOB" not in t and R.dropped_reasoning == len("REASONING SECRET WORDS") and R.dropped_encrypted == len("ENCRYPTEDBLOB") * 50; n += 3
        assert "shellID" not in t and "snapshot" not in t and "providerState" not in t and "cost" not in t; n += 1
        assert "API_TOKEN=abcd1234efgh5678" not in t and "[REDACTED:" in t and "s3cretValue99xyz" not in t and "TOKENabcdefgh12345" not in t; n += 1   # the sanitizer ran on a text output and on a tool input
        files = [r for r in R.recs if r.uri is not None]
        assert sanitize(files[0].uri) != files[0].uri; n += 1   # the sanitizer WOULD change this uri (so leaving it alone is a decision the test proves)
        assert len(files) == 1 and files[0].uri in t and files[0].text.count("[REDACTED") == 0 and R.n_files == 1 and R.n_compaction_recent == 1 and len(R.forced) == 2; n += 1   # the image is not sanitized
        assert R.sanitized >= 2; n += 1
        ro = {r.uuid for r in R.recs if r.uuid in R.readonly}
        tu = lambda s: next(r.uuid for r in R.recs if s in r.text.split("\n")[0] and "[tool_use" in r.text)
        assert tu("[tool_use shell] command: ls") in ro and tu("[tool_use read] path: /work/dir/with/a/rather/long/path/name/to/pass/the/preview/threshold/of/the/marker/big.txt") in ro and tu("[tool_use grep]") in ro; n += 3
        assert tu("[tool_use shell] command: git commit") not in ro and tu("[tool_use patch]") not in ro and tu("[tool_use custom]") not in ro and tu("[tool_use webfetch]") not in ro; n += 4
        assert [c[0] for c in R.first_calls] == ["shell", "shell", "read", "patch"]; n += 1
        import re
        hp = re.compile(r"/handoff-[0-9a-f]{8}-\d{8}-[^/\s\"]+(?:\.md|/HANDOFF\.md)$")
        assert find_parents([("shell", {"command": "x"}), ("read", {"path": "/tmp/handoff-0123abcd-20260101-aa/HANDOFF.md"}), ("read", {"path": "/tmp/handoff-0123abcd-20260101-aa/HANDOFF.md"}), ("read", {"path": "/tmp/other.md"}), ("Read", {"file_path": "/tmp/handoff-0123abcd-20260101-bb.md"}), ("read", {"path": 3})], hp) == ["/tmp/handoff-0123abcd-20260101-aa/HANDOFF.md"]; n += 1
        # uuids are valid for the record parser and stable
        assert all(cc.REC.match(r.text) for r in R.recs) and R.recs[0].uuid == render(conn, sid).recs[0].uuid and len({r.uuid for r in R.recs}) == len(R.recs); n += 1
        # the self-check: a good output passes; a lost string, a changed uri and a wrong order are found; a record the sanitizer changed is not string-checked
        blobs = {r.text for r in R.recs if r.uuid in R.forced}
        assert selfcheck(R, t, blobs) == []; n += 1
        assert selfcheck(R, t.replace("Final answer text.", "Final answer tex"), blobs) and selfcheck(R, t.replace(files[0].uri, files[0].uri[:-6] + "X" + files[0].uri[-5:]), blobs) and selfcheck(R, t, set()) and selfcheck(R, t + "x", blobs); n += 4
        changed = [r for r in R.recs if r.changed and r.needs]
        assert changed and selfcheck(R, t, blobs) == []; n += 1   # the tool input {"token": ...} record is changed by the sanitizer and does not fail
        # sessions: one, several, unknown, none, legacy
        conn.close()
        two = make_db(os.path.join(d, "two.sqlite"), {"ses_aaaaaaaaaaaaAAAAAAAA": [("user", {"text": "a"}, 5)], "ses_bbbbbbbbbbbbBBBBBBBB": [("user", {"text": "b"}, 5)]})
        c2 = connect(two)
        for sess, want in ((None, "2 sessions"), ("ses_nope", "no such session")):
            try: pick_session(c2, sess); raise SystemExit("not refused: %r" % sess)
            except OpenCodeError as e: assert want in str(e), str(e); n += 1
        assert pick_session(c2, "ses_bbbbbbbbbbbbBBBBBBBB") == "ses_bbbbbbbbbbbbBBBBBBBB"; n += 1
        assert "ses_aaaaaaaaaaaaAAAAAAAA, ses_bbbbbbbbbbbbBBBBBBBB" in str(next(e for e in [_catch(lambda: pick_session(c2))])); n += 1
        c2.close()
        empty = make_db(os.path.join(d, "empty.sqlite"), {}); leg = make_db(os.path.join(d, "legacy.sqlite"), {}, legacy=["ses_old1"]); mix = make_db(os.path.join(d, "mix.sqlite"), {"ses_new": [("user", {"text": "n"}, 5)]}, legacy=["ses_old1"])
        for path, sess, want in ((empty, None, "no session in session_v2"), (leg, None, "legacy"), (leg, "ses_old1", "legacy"), (mix, "ses_old1", "legacy"), (leg, "ses_zzz", "no such session")):
            c = connect(path)
            try: pick_session(c, sess); raise SystemExit("not refused: %s %s" % (path, sess))
            except OpenCodeError as e: assert want in str(e), (path, sess, str(e)); n += 1
            c.close()
        # read-only: a write through the connection fails
        c = connect(two)
        try: c.execute("insert into session_v2 values ('x', 1)"); raise SystemExit("a write succeeded on a read-only connection")
        except sqlite3.Error: n += 1
        c.close()
        # the search for a marker: ids of the sessions with a recent row that holds it; times in milliseconds
        mk = "handoff-marker-1-aaaaaaaaaaaa"
        db3 = make_db(os.path.join(d, "find.sqlite"), {"ses_one": [("user", {"text": "x"}, 5), ("assistant", {"content": [{"type": "tool", "name": "shell", "state": {"status": "completed", "input": {"command": "echo " + mk}}}]}, 3)],
                                                      "ses_two": [("user", {"text": "no marker here"}, 3)], "ses_old": [("user", {"text": mk}, 7200)]})
        assert find_current(mk, db3) == ["ses_one"] and find_current("handoff-marker-9-bbbbbbbbbbbb", db3) == [] and find_current(mk, db3, max_age=10 ** 6) == ["ses_old", "ses_one"]; n += 3
        assert find_current(mk, os.path.join(d, "missing.sqlite")) == [] and find_current(mk, leg) == []; n += 2
        junk = os.path.join(d, "junk.sqlite"); open(junk, "wb").write(b"this is not a database " * 100)
        try: find_current(mk, junk); raise SystemExit("an unreadable database was not reported")
        except OpenCodeError as e: assert "cannot be read" in str(e) or "cannot be searched" in str(e); n += 1
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("opencode_source selftest OK: %d cases (rendering of every message type and content kind, the sanitizer on texts and inputs but not on the image, the read-only set, the self-check, session picking, legacy, the marker search)" % n)


def _catch(fn):
    try: fn()
    except OpenCodeError as e: return e
    raise SystemExit("no error raised")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: print(__doc__); sys.exit(2)

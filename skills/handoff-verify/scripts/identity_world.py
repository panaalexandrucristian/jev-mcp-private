"""Test support (stdlib, offline): invented sessions in temporary directories and the real commands run on them, for the identity-output matrix (test_identity_matrix.py). Not a test module and not part of the skill's runtime.

`World` builds two sessions once and keeps every output the commands print or persist (text), under a stream name:
  A = a clean session with long recorded ids (every kind of file the preparation lists: an alias, a failed write, an unplaced write, a classification candidate, a `.env` file, a non-text file, a Bash-created file, a subagent
      transcript, an external --target, a --location, a direct reference), one write evaluated against ONE verification run, a real ledger flow and a real report;
  B = a session with TWO verification runs after the write (an ambiguous selection);
  C = a note with a missing reference; D = an OpenCode session (selector) with a SUCCESSFUL write that cannot be placed in time (a preparation diagnostic with a long call id);
  E = a prefix check genuinely bound (its Jev call lies inside the window of the first version) in a report whose `handoff.versions` entry names the write as the author does (`tool_use_id`); F = a report written with an unreadable calls log;
  G = `prepare.py` without `--out` (the run directory chosen by `report.new_run_dir`, in a temporary session cwd); H = a path written in the session and in a subagent transcript (mixed streams: reasons that name stream files);
  I = a reference whose resolved path holds a secret (`missing_reference.kind` redaction); J = a verified copy of a note written elsewhere (relocation: `handoff_source_path`, provenance `via` relocated, a report with `source_path`);
  K = a recorded write id that holds a credential behind the provider prefix (a ledger that withholds the field); L = `prepare.py` without a session argument and with two recent sessions (exit 3, resolution `heuristic_most_recent`).
  A also holds a RICH report (every standard field of report.schema.json that an author can set), see build_rich. A also holds a report for a note the session never wrote (provenance blocker) and a missing --source for `versions.py list`.
`leaves(obj)` lists the string leaves of a JSON value as paths (`/a[]/b`; an empty list/dict is a leaf `/a[]` / `/a{}`)."""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from test_obligation_ledger import ENV, Tx, write
import audit_fixtures as AF
from test_stream_reconstruction import Tx as STx
from test_opencode_adapter import Fixture, user as oc_user, assistant as oc_assistant, tool as oc_tool, T0 as OC_T0

BODY = "01AbCdEfGhIjKlMnOpQrStUvWxYz"
Q = "Never run migrate.sh against prod."
NOTE_A = "- see `ref.txt` for the billing migration\n- the billing migration ships on Friday\n- the script migrate.sh is only for staging\n"
WID1, WID2, RID, STAGE_A, STAGE_S, JEV = ("toolu_bdrk_" + BODY + "~2#1", "call_" + BODY + "#1", "srvtoolu_" + BODY, "toolu_vrtx_Abs" + BODY, "call_Src" + BODY + "~3", "srvtoolu_Jev" + BODY)
B_WID, B_R1, B_R2 = "toolu_" + BODY, "call_" + BODY, "srvtoolu_" + BODY + "~2"
JEV0 = "toolu_vrtx_Pre" + BODY                       # a Jev call inside the window of the FIRST version (between its write and the next write of the path): the evidence of a genuinely bound `prefix` check
D_W1, D_W2, D_E3 = "call_Ocw1" + BODY, "call_Ocw2" + BODY, "call_Oce3" + BODY      # OpenCode call ids: a placed write, a successful write without a valid tool time (a diagnostic) and a later edit whose base that write may have changed
H_W, H_E, H_C = "srvtoolu_Mxw" + BODY, "call_Mxe" + BODY + "~2", "toolu_Mxc" + BODY      # H: a write and an edit in the session, a write of the same path in a subagent transcript
MATCH = "migrate.sh"                                    # an identifier of the detail that the note and its direct reference both contain (hints.material_matches)

def cli(script, *args, cwd, stdin=None):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)] + list(args), cwd=cwd, capture_output=True, text=True, env=ENV, input=stdin); return p.returncode, p.stdout

def leaves(o, path=""):
    if isinstance(o, dict):
        if not o: yield path + "{}", ""
        for k, v in o.items(): yield from leaves(v, path + "/" + str(k))
    elif isinstance(o, list):
        if not o: yield path + "[]", ""
        for v in o: yield from leaves(v, path + "[]")
    elif isinstance(o, str): yield path, o

def VROW(v, n, mode):
    """A declared handoff.versions row as the schema requires it (version, sha256, tool_use_id, uuid, timestamp, evaluated_against), copied from the inventory row of the write."""
    return dict(version=n, sha256=v["sha256"], tool_use_id=v["write_tool_use_id"], uuid=v["uuid"], timestamp=v["timestamp"], evaluated_against=mode)

class World:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = os.path.realpath(self.tmp.name); self.out = {}; self.code = {}
        self.build_a(); self.build_b(); self.build_c(); self.build_d(); self.build_g(); self.build_h(); self.build_i(); self.build_j(); self.build_k(); self.build_l()

    def close(self): self.tmp.cleanup()

    def put(self, stream, code, text): self.out[stream] = text; self.code[stream] = code

    def build_a(self):
        import report, versions
        d = self.a = os.path.join(self.root, "A"); os.makedirs(d); t = self.ta = Tx(d)
        write(t.note, NOTE_A); write(os.path.join(d, "ref.txt"), "ref content: migrate.sh is described here\n"); write(os.path.join(d, "ext.md"), "an external note\n"); write(os.path.join(d, "copy", "HANDOFF.md"), NOTE_A)
        t.user("intro"); t.user(Q); t.write_note(WID1, NOTE_A)
        t.tool(JEV0, "mcp__jev__jev_verify", dict(claims=["c"], evidence=["e"]), json.dumps(dict(results=[dict(claim="c", verdict="verified", confidence=0.99, action="auto", same_subject=0.9)])))      # inside the window of the FIRST version (after its write, its result before the next write of the path)
        alias = os.path.join(d, "alias.md"); os.symlink(t.note, alias); t.tool(WID2, "Write", dict(file_path=alias, content=NOTE_A), "File created successfully at: " + alias)
        t.rec("assistant", [dict(type="tool_use", id="toolu_failed", name="Write", input=dict(file_path=os.path.join(d, "HANDOFF-failed.md"), content="x"))]); t.rec("user", [dict(type="tool_result", tool_use_id="toolu_failed", is_error=True, content="denied")])
        t.tool("toolu_classify", "Write", dict(file_path=os.path.join(d, "notes.md"), content="n\n"), "File created successfully")
        t.tool("toolu_env", "Write", dict(file_path=os.path.join(d, ".env"), content="A=1\n"), "File created successfully")
        t.tool("toolu_json", "Write", dict(file_path=os.path.join(d, "handoff.json"), content="{}"), "File created successfully")
        t.tool("toolu_bash", "Bash", dict(command="echo hi > %s/handoff-bash.md" % d), "")
        t.rec("assistant", [dict(type="tool_use", id="toolu_unplaced", name="Write", input=dict(file_path="rel/HANDOFF-rel.md", content="x"))]); t.recs[-1].pop("cwd")
        t.rec("user", [dict(type="tool_result", tool_use_id="toolu_unplaced", content="File created successfully")]); t.recs[-1].pop("cwd")
        t.tool(RID, "Skill", dict(skill="jev:handoff-verify"), "loaded"); t.save()
        sub = os.path.splitext(t.log)[0] + os.sep + "subagents"; os.makedirs(sub)
        write(os.path.join(sub, "agent-1.jsonl"), json.dumps(dict(type="user", uuid="su1", timestamp="2026-01-01T01:00:00Z", cwd=d, sessionId="s1", message=dict(role="user", content="sub hello"))) + "\n")
        pdir = os.path.join(d, "out"); self.prep = pdir
        self.put("prepare.out", *cli("prepare.py", t.log, "--cwd", d, "--out", pdir, "--location", d, "--target", os.path.join(d, "ext.md"), "--target", os.path.join(d, "copy", "HANDOFF.md"), cwd=d))
        for n, f in (("prepare.inv", "inventory.json"), ("prepare.cov", "coverage.json")): self.put(n, 0, open(os.path.join(pdir, f), encoding="utf-8").read())
        self.put("prepare.files", 0, json.dumps(["handoffs/" + x for x in sorted(os.listdir(pdir + "/handoffs"))] + ["transcript/" + x for x in sorted(os.listdir(pdir + "/transcript"))]))
        self.put("prepare.err", *cli("prepare.py", os.path.join(d, "nope.jsonl"), "--cwd", d, cwd=d))
        args = ["--source", t.log, "--file", t.note, "--cwd", d, "--write-id", WID2, "--evaluated-against", "session_end"]
        self.args = args
        self.put("omissions.prepare", *cli("omissions.py", "prepare", *args, "--detail", Q, "--source-quote", Q, "--location", d, cwd=d))
        self.put("omissions.prepare.fail", *cli("omissions.py", "prepare", *args, "--detail", "a detail that is nowhere", "--source-quote", "nowhere", cwd=d))
        spec = json.dumps([dict(detail=Q, source_quote=Q, write_id=WID2, evaluated_against="session_end", run=RID)])
        self.ledger = os.path.join(d, "ledger.json")
        self.put("omissions.batch", *cli("omissions.py", "prepare-batch", "--source", t.log, "--file", t.note, "--spec", "-", "--cwd", d, "--location", d, "--ledger", self.ledger, cwd=d, stdin=spec))
        self.put("ledger.file", 0, open(self.ledger, encoding="utf-8").read())
        self.prepared = json.loads(self.out["omissions.batch"])[0]; self.oid = json.loads(self.out["ledger.file"])["obligations"][0]["id"]
        t.verify(STAGE_A, self.prepared["absence_claim"], self.prepared["material"]); t.verify(STAGE_S, self.prepared["source_claim"], self.prepared["source_passage"], verdict="verified"); t.save()
        self.put("ledger.record", *cli("omissions.py", "ledger", "record", "--ledger", self.ledger, "--id", self.oid, "--stage", "absence", "--tool-use-id", STAGE_A, cwd=d))
        self.put("ledger.record2", *cli("omissions.py", "ledger", "record", "--ledger", self.ledger, "--id", self.oid, "--stage", "source", "--tool-use-id", STAGE_S, cwd=d))
        self.put("ledger.file.recorded", 0, open(self.ledger, encoding="utf-8").read())
        self.put("ledger.resume", *cli("omissions.py", "ledger", "resume", "--ledger", self.ledger, "--cwd", d, cwd=d))
        self.put("ledger.err", *cli("omissions.py", "ledger", "resume", "--ledger", os.path.join(d, "missing-ledger.json"), "--cwd", d, cwd=d))
        self.put("scope.ok", *cli("scope.py", "prepare", "--source", t.log, "--detail", "the billing migration ships on Friday", "--write-id", WID2, "--evaluated-against", "session_end", cwd=d))
        self.put("scope.fail", *cli("scope.py", "prepare", "--source", t.log, "--detail", "x", "--write-id", WID2, cwd=d))
        self.put("versions.list", *cli("versions.py", "list", "--source", t.log, "--file", t.note, "--evaluated-against", "session_end", "--run", RID, "--cwd", d, cwd=d))
        self.put("versions.list.err", *cli("versions.py", "list", "--source", t.log, "--file", t.note, "--evaluated-against", "session_end", "--run", "no-such-run", "--cwd", d, cwd=d))
        self.put("versions.list.err3", *cli("versions.py", "list", "--source", os.path.join(d, "no-session.jsonl"), "--file", t.note, "--evaluated-against", "session_end", "--cwd", d, cwd=d))
        self.put("versions.list.err2", *cli("versions.py", "list", "--source", t.log, "--file", os.path.join(d, "never-written.md"), "--evaluated-against", "session_end", "--cwd", d, cwd=d))
        v = next(x for x in versions.versions_of(t.log, t.note)[0] if x["write_tool_use_id"] == WID2)
        t.tool(JEV, "mcp__jev__jev_verify", dict(claims=["c"], evidence=["e"]), json.dumps(dict(results=[dict(claim="c", verdict="verified", confidence=0.99, action="auto", same_subject=0.9)]))); t.save()
        ref = dict(versions.version_ref(v, "session_end"), run=RID)
        doc = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[VROW(v, 2, "session_end")]), status="PASS", findings=[], unresolved=[], work_locations=[d],
                   checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=JEV, result_index=0, key="c"), version_ref=ref)],
                   scope_exclusions=[dict(detail="x", jev_ref=dict(tool_use_id="nope", result_index=0, key="k"), classification="out_of_scope", confidence=0.995, evaluation=dict(write_tool_use_id=WID2, evaluated_against="session_end", run=RID))])
        self.rep = os.path.join(d, "rep"); os.makedirs(self.rep); md, js = report.write_report(self.rep, t.note, AF.shell(doc), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log); self.rep_names = (md, js)
        self.put("report.json", 0, open(os.path.join(self.rep, js), encoding="utf-8").read()); self.put("report.md", 0, open(os.path.join(self.rep, md), encoding="utf-8").read())
        self.put("report.files", 0, json.dumps(sorted(os.listdir(self.rep))))
        v1 = next(x for x in versions.versions_of(t.log, t.note)[0] if x["write_tool_use_id"] == WID1)
        doc1 = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[VROW(v1, 1, "prefix")]), status="UNRESOLVED", findings=[], unresolved=[],
                    checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=JEV, result_index=0, key="c"), version_ref=versions.version_ref(v1, "prefix"))])
        self.rep1 = os.path.join(d, "rep1"); os.makedirs(self.rep1); md1, js1 = report.write_report(self.rep1, t.note, AF.shell(doc1), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log)
        self.put("report.stale.json", 0, open(os.path.join(self.rep1, js1), encoding="utf-8").read()); self.put("report.stale.md", 0, open(os.path.join(self.rep1, md1), encoding="utf-8").read())
        ref0 = versions.version_ref(v1, "prefix")       # E: a prefix check genuinely bound: its Jev call (JEV0) lies AFTER the write of the first version and before the next write of the path (inside that version's window); the author names the version in `handoff.versions` with `tool_use_id`
        doc2 = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=t.note, versions=[VROW(v1, 1, "prefix")]), status="UNRESOLVED", findings=[], unresolved=[],
                    checks=[dict(id="p0", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=JEV0, result_index=0, key="c"), version_ref=ref0)])
        self.rep2 = os.path.join(d, "rep2"); os.makedirs(self.rep2); md2, js2 = report.write_report(self.rep2, t.note, AF.shell(doc2), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log)
        self.put("report.prefix.json", 0, open(os.path.join(self.rep2, js2), encoding="utf-8").read()); self.put("report.prefix.md", 0, open(os.path.join(self.rep2, md2), encoding="utf-8").read())
        self.missing_calls = os.path.join(d, "missing-calls.jsonl")      # F: the same report with a calls log that cannot be read
        self.rep3 = os.path.join(d, "rep3"); os.makedirs(self.rep3); md3, js3 = report.write_report(self.rep3, t.note, AF.shell(doc2), "Stare: **UNRESOLVED**\n", calls_jsonl=self.missing_calls)
        self.put("report.nolog.json", 0, open(os.path.join(self.rep3, js3), encoding="utf-8").read()); self.put("report.nolog.md", 0, open(os.path.join(self.rep3, md3), encoding="utf-8").read())
        ext = os.path.join(d, "ext.md")                  # a note that the session did not write: the provenance blocker of the report
        docx = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=ext, versions=[]), status="UNRESOLVED", findings=[], unresolved=[], checks=[])
        self.rep4 = os.path.join(d, "rep4"); os.makedirs(self.rep4); mdx, jsx = report.write_report(self.rep4, ext, AF.shell(docx), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log)
        self.put("report.ext.json", 0, open(os.path.join(self.rep4, jsx), encoding="utf-8").read())
        self.build_rich(t, d, alias, versions, report)
        self.put("versions.status.stale", *cli("versions.py", "status", "--session", t.log, "--file", t.note, "--report", os.path.join(self.rep1, js1), "--cwd", d, cwd=d))
        self.put("versions.status", *cli("versions.py", "status", "--session", t.log, "--file", t.note, "--report", os.path.join(self.rep, js), "--cwd", d, cwd=d))
        self.put("versions.status.noreport", *cli("versions.py", "status", "--session", t.log, "--file", t.note, "--report", os.path.join(d, "no-report.json"), "--cwd", d, cwd=d))

    def build_rich(self, t, d, alias, versions, report):
        """A report whose document sets every standard field of report.schema.json that an author can set (session, variant, environment, inventory, handoff.versions, source_ranges, findings, unresolved, kit, cost, patch), so that
        write_report persists them and the matrix classifies each string leaf. The values are invented; `patch.backup` is the real result of report.apply_patch on a file of a temporary directory."""
        import datetime
        sub = os.path.join(os.path.splitext(t.log)[0], "subagents", "agent-1.jsonl"); vs = {x["write_tool_use_id"]: x for x in versions.versions_of(t.log, t.note)[0]}; v1, v2 = vs[WID1], vs[WID2]
        pd = os.path.join(d, "patch"); os.makedirs(pd); pf = os.path.join(pd, "p.md"); write(pf, "old\n"); bak = report.apply_patch(pf, report.sha256_file(pf), "new\n", True, datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        qu = next(r["uuid"] for r in t.recs if r.get("message", {}).get("content") == Q)
        ref = dict(versions.version_ref(v2, "session_end"), run=RID)
        doc = dict(session=dict(session_id="s1", jsonl=t.log, line="1-14", cwd=d, subagents=[sub], continuations="none"),
                   variant=dict(name="A-rich", commit="0123456789abcdef0123456789abcdef01234567"),
                   environment=dict(model="invented-model", claude_code="0.0.0", python="3.x", jq="n/a", git="n/a", kit="handoff-verify", jev_model="invented-jev"),
                   inventory=[dict(path=t.note, real=os.path.realpath(t.note), aliases=[alias], copies=[os.path.join(d, "copy", "HANDOFF.md")], disposition="included_by_name", classification=None, linked=True),
                              dict(path=os.path.join(d, "notes.md"), disposition="needs_jev_classify", classification=dict(label="handoff", reason="a note for the next session"), linked=True)],
                   handoff=dict(path=t.note, versions=[dict(version=1, sha256=v1["sha256"], tool_use_id=WID1, uuid=v1["uuid"], timestamp=v1["timestamp"], evaluated_against="prefix", status="UNRESOLVED"),
                                                       dict(version=2, sha256=v2["sha256"], tool_use_id=WID2, uuid=v2["uuid"], timestamp=v2["timestamp"], evaluated_against="session_end", status="UNRESOLVED")]),
                   source_ranges=[dict(id="transcript/chunk-0001.txt", complete=True, chunks=1, uuids=[r["uuid"] for r in t.recs[:4]])], status="UNRESOLVED",
                   findings=[dict(type="lost_detail", category="constraint", quote_handoff=None, quote_source=Q, uuid=qu, check_id="p1", confidence=0.99, claim="the note omits the constraint", omission_ref=dict(detail=Q, source_check_id="p1"))],
                   unresolved=[dict(check_id="p1", reason="the single re-verification is pending")],
                   checks=[dict(id="p1", tool="verify", verdict="verified", confidence=0.99, jev_ref=dict(tool_use_id=JEV, result_index=0, key="c"), version_ref=ref)],
                   kit=dict(status="ok", exit=0, section4="n/a", skips=["invented skip"]), cost=dict(tokens="unmeasured", usd="unmeasured", wall_s="unmeasured", jev_calls=1),
                   patch=dict(proposed=True, gate_confidence=0.99, approved=True, applied=True, backup=bak))
        self.rich_doc = json.loads(json.dumps(doc)); self.rich_backup = bak
        self.rep5 = os.path.join(d, "rep5"); os.makedirs(self.rep5); md5, js5 = report.write_report(self.rep5, t.note, AF.shell(doc), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log)
        self.put("report.rich.json", 0, open(os.path.join(self.rep5, js5), encoding="utf-8").read())

    def build_b(self):
        d = self.b = os.path.join(self.root, "B"); os.makedirs(d); t = self.tb = Tx(d); write(t.note, "- the billing migration ships on Friday\n")
        t.user("intro"); t.user(Q); t.write_note(B_WID, "- the billing migration ships on Friday\n")
        for r in (B_R1, B_R2): t.tool(r, "Skill", dict(skill="jev:handoff-verify"), "loaded"); t.user("next " + r[-4:])
        t.save(); args = ["--source", t.log, "--file", t.note, "--cwd", d, "--write-id", B_WID, "--evaluated-against", "session_end"]
        self.put("b.omissions.prepare", *cli("omissions.py", "prepare", *args, "--detail", Q, "--source-quote", Q, cwd=d))
        spec = json.dumps([dict(detail=Q, source_quote=Q, write_id=B_WID, evaluated_against="session_end")]); self.bledger = os.path.join(d, "ledger.json")
        self.put("b.omissions.batch", *cli("omissions.py", "prepare-batch", "--source", t.log, "--file", t.note, "--spec", "-", "--cwd", d, "--ledger", self.bledger, cwd=d, stdin=spec))
        self.put("b.ledger.file", 0, open(self.bledger, encoding="utf-8").read())
        self.put("b.ledger.resume", *cli("omissions.py", "ledger", "resume", "--ledger", self.bledger, "--cwd", d, cwd=d))
        self.put("b.scope.fail", *cli("scope.py", "prepare", "--source", t.log, "--detail", "the billing migration ships on Friday", "--write-id", B_WID, "--evaluated-against", "session_end", cwd=d))
        self.put("b.versions.list", *cli("versions.py", "list", "--source", t.log, "--file", t.note, "--evaluated-against", "session_end", "--cwd", d, cwd=d))

    def build_c(self):
        d = self.c = os.path.join(self.root, "C"); os.makedirs(d); t = self.tc = Tx(d); note = "- see `missing.txt`\n- the billing migration ships on Friday\n"; write(t.note, note)
        t.user("intro"); t.user(Q); t.write_note("w0", note); t.save()
        self.put("c.omissions.prepare.fail", *cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d))

    def build_d(self):
        """D = an OpenCode session: a placed write and a SUCCESSFUL write whose tool time is missing (opencode.diagnostics; its call id is long)."""
        d = self.d = os.path.join(self.root, "D"); self.dwork = os.path.join(d, "work"); os.makedirs(self.dwork); self.dnote = os.path.join(self.dwork, "HANDOFF.md"); write(self.dnote, "# Handoff\n- beta\n")
        self.fx = Fixture(d); late = oc_tool(D_W2, "write", dict(filePath=self.dnote, content="# Handoff\n- beta\n"), OC_T0 + 31, OC_T0 + 32); late["time"] = dict(completed=OC_T0 + 32)       # no created time: not placeable
        self.dsel = self.fx.session("ses_d", self.dwork, [oc_user("intro", OC_T0), oc_assistant([oc_tool(D_W1, "write", dict(filePath=self.dnote, content="# Handoff\n- alpha\n"), OC_T0 + 10, OC_T0 + 12)], OC_T0 + 9), oc_assistant([late], OC_T0 + 30),
                                                                       oc_assistant([oc_tool(D_E3, "edit", dict(filePath=self.dnote, oldString="beta", newString="gamma", replaceAll=False), OC_T0 + 40, OC_T0 + 42)], OC_T0 + 39)])
        self.dout = os.path.join(d, "out"); self.put("d.prepare.out", *cli("prepare.py", self.dsel, "--cwd", self.dwork, "--out", self.dout, cwd=self.dwork))
        self.put("d.prepare.inv", 0, open(os.path.join(self.dout, "inventory.json"), encoding="utf-8").read())
        self.put("d.versions.list", *cli("versions.py", "list", "--source", self.dsel, "--file", self.dnote, "--evaluated-against", "session_end", "--cwd", self.dwork, cwd=self.dwork))

    def build_g(self):
        """G = `prepare.py` WITHOUT --out: the run directory comes from report.new_run_dir(<session cwd>, <session id>) in a temporary session cwd."""
        d = self.g = os.path.join(self.root, "G"); os.makedirs(d); t = self.tg = Tx(d); write(t.note, NOTE_A); t.user("intro"); t.user(Q); t.write_note("w0", NOTE_A); t.save()
        self.put("g.prepare.out", *cli("prepare.py", t.log, "--cwd", d, cwd=d))
        try: self.gwork = json.loads(self.out["g.prepare.out"])["work"]
        except ValueError: self.gwork = None
        if self.gwork: self.put("g.prepare.inv", 0, open(os.path.join(self.gwork, "inventory.json"), encoding="utf-8").read())

    def build_h(self):
        """H = a path written in the session AND in a subagent transcript (mixed streams): the reasons of the versions and the blockers name the recorded ids and the stream files."""
        d = self.h = os.path.join(self.root, "H"); os.makedirs(d); self.hnote = os.path.join(d, "HANDOFF.md"); self.hlog = os.path.join(d, "s.jsonl"); write(self.hnote, "alpha gamma\n")
        t = STx(d); t.write(H_W, self.hnote, "alpha beta\n"); t.edit(H_E, self.hnote, "beta", "gamma"); t.save(self.hlog)
        c = STx(d); c.write(H_C, self.hnote, "CHILD\n"); c.save(os.path.join(d, "s", "subagents", "agent-1.jsonl"))
        self.hout = os.path.join(d, "out"); self.put("h.prepare.out", *cli("prepare.py", self.hlog, "--cwd", d, "--out", self.hout, cwd=d))
        self.put("h.prepare.inv", 0, open(os.path.join(self.hout, "inventory.json"), encoding="utf-8").read())
        self.put("h.versions.list", *cli("versions.py", "list", "--source", self.hlog, "--file", self.hnote, "--evaluated-against", "session_end", "--cwd", d, cwd=d))
        self.put("h.omissions.prepare", *cli("omissions.py", "prepare", "--source", self.hlog, "--file", self.hnote, "--cwd", d, "--detail", "x", "--source-quote", "x", "--write-id", H_W, "--evaluated-against", "prefix", cwd=d))
        self.put("h.versions.status", *cli("versions.py", "status", "--session", self.hlog, "--file", self.hnote, "--report", os.path.join(d, "no-report.json"), "--cwd", d, cwd=d))

    def build_i(self):
        """I = a clean-looking reference whose RESOLVED path holds a secret (a link into a directory named like an assignment): the material is refused with kind `redaction`."""
        d = self.i = os.path.join(self.root, "I"); os.makedirs(d); sec = os.path.join(d, "API_KEY=" + "Zq8fLm3Xv9"); os.makedirs(sec); write(os.path.join(sec, "x.txt"), "x\n"); os.symlink(os.path.join(sec, "x.txt"), os.path.join(d, "link.txt"))
        t = self.ti = Tx(d); note = "- see `link.txt`\n- the billing migration ships on Friday\n"; write(t.note, note); t.user("intro"); t.user(Q); t.write_note("w0", note); t.save()
        self.put("i.omissions.prepare.redaction", *cli("omissions.py", "prepare", "--source", t.log, "--file", t.note, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w0", "--evaluated-against", "prefix", cwd=d))

    def build_j(self):
        """J = the note was written at one path and the file given is a verified COPY of it elsewhere (relocation): handoff_source_path is the written path."""
        d = self.j = os.path.join(self.root, "J"); os.makedirs(os.path.join(d, "orig")); self.jorig = os.path.join(d, "orig", "HANDOFF.md"); self.jcopy = os.path.join(d, "HANDOFF.md"); write(self.jorig, NOTE_A); write(self.jcopy, NOTE_A); write(os.path.join(d, "ref.txt"), "ref content\n")
        t = self.tj = Tx(d); t.user("intro"); t.user(Q); t.tool("w1", "Write", dict(file_path=self.jorig, content=NOTE_A), "File created successfully at: " + self.jorig); t.save()
        self.put("j.versions.list.copy", *cli("versions.py", "list", "--source", t.log, "--file", self.jcopy, "--evaluated-against", "prefix", "--cwd", d, cwd=d))
        import report
        docj = dict(session=dict(session_id="s1", jsonl=t.log, cwd=d), handoff=dict(path=self.jcopy, source_path=self.jorig, versions=[]), status="UNRESOLVED", findings=[], unresolved=[], checks=[])
        self.repj = os.path.join(d, "rep"); os.makedirs(self.repj); mdj, jsj = report.write_report(self.repj, self.jcopy, AF.shell(docj), "Stare: **UNRESOLVED**\n", calls_jsonl=t.log)
        self.put("j.report.json", 0, open(os.path.join(self.repj, jsj), encoding="utf-8").read())
        self.put("j.omissions.prepare.copy", *cli("omissions.py", "prepare", "--source", t.log, "--file", self.jcopy, "--cwd", d, "--detail", Q, "--source-quote", Q, "--write-id", "w1", "--evaluated-against", "prefix", cwd=d))

    def build_k(self):
        """K = a recorded write id that holds a credential behind the provider prefix: the batch is refused and the ledger keeps the field only as a hash (`withheld`)."""
        d = self.k = os.path.join(self.root, "K"); os.makedirs(d); t = self.tk = Tx(d); write(t.note, NOTE_A); wid = "call_" + "AKIA" + "IOSFODNN7EXAMPLE" + "#1"
        t.user("intro"); t.user(Q); t.write_note(wid, NOTE_A); t.save(); self.kledger = os.path.join(d, "ledger.json")
        spec = json.dumps([dict(detail=Q, source_quote=Q, write_id=wid, evaluated_against="prefix")])
        self.put("k.omissions.batch", *cli("omissions.py", "prepare-batch", "--source", t.log, "--file", t.note, "--spec", "-", "--cwd", d, "--ledger", self.kledger, cwd=d, stdin=spec))
        self.put("k.ledger.file", 0, open(self.kledger, encoding="utf-8").read())
        self.put("k.ledger.resume", *cli("omissions.py", "ledger", "resume", "--ledger", self.kledger, "--cwd", d, cwd=d))

    def build_l(self):
        """L = `prepare.py` WITHOUT a session argument, with SEVERAL recently modified sessions in the project directory: the current session is not demonstrated (exit 3, resolution heuristic_most_recent). The home projects directory is replaced by a
        temporary one (CLAUDE_PROJECTS_DIR) and CLAUDE_SESSION_ID is removed from the environment, so nothing real is read."""
        d = self.l = os.path.join(self.root, "L"); os.makedirs(d); proj = self.lproj = os.path.join(self.root, "L-projects"); slug = os.path.join(proj, re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(d))); os.makedirs(slug)
        for n in ("a", "b"): write(os.path.join(slug, n + ".jsonl"), "{}\n")
        env = {k: v for k, v in ENV.items() if k != "CLAUDE_SESSION_ID"}; env["CLAUDE_PROJECTS_DIR"] = proj
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), "--cwd", d, "--out", os.path.join(d, "out")], cwd=d, capture_output=True, text=True, env=env)
        self.put("l.prepare.err", p.returncode, p.stdout); self.lout = os.path.join(d, "out")

    def streams(self):
        """-> {stream: [(path, string)]} for every stored output that is JSON (a stream that is not JSON is skipped)."""
        res = {}
        for s, text in self.out.items():
            try: res[s] = list(leaves(json.loads(text)))
            except ValueError: pass
        return res

if __name__ == "__main__":
    w = World()
    try:
        for s, ls in sorted(w.streams().items()):
            print("##", s, w.code[s])
            for p in sorted({p for p, _ in ls}): print("   ", p)
    finally: w.close()

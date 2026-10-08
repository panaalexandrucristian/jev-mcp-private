#!/usr/bin/env python3
"""Offline test of the untimed OpenCode mutations (item 6; stdlib only, no Jev call, never reads .handoff-verify/): a SUCCESSFUL write/edit/patch that has no valid top-level tool time (or no path) is not
turned into an event, a time or a version, but it is no longer dropped either: `opencode.load` keeps it as a diagnostic (affected realpath or null, call id, message seq/ci/sub, reason, the real top-level
times), `discover.diagnostics` hands it to the versions, and every version of an affected path carries `unpositioned=[call ids]`, which blocks the current-delivery certificate (also for identical bytes)
until a demonstrated temporal order re-establishes the target (a valid completion time of the uncertain mutation followed STRICTLY by a recoverable full Write with valid tool timing; message order,
message time and equal bytes are not enough). The chain is adapter -> discover -> versions -> report -> gate. All fixtures are invented.
usage: python3 -B test_opencode_diagnostics.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, jevref as J, report, versions
from test_opencode_adapter import Base, T0, CLAIM, assistant, user, tool, patch, jev_input, jev_json, sha, uses

C1 = "# Handoff\n- alpha\n"
C2 = "# Handoff\n- beta\n"
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

def untimed(t, created=None, completed=None):
    """The same block with its top-level times replaced (None = absent)."""
    t = dict(t); t["time"] = {k: v for k, v in (("created", created), ("completed", completed)) if v is not None}; return t

class Chain(Base):
    def path_for(self, name): return os.path.join(self.cwd, name)
    def build(self, *later, sid="ses_d", first=None):
        """w1 (timed) -> check j1 -> the later assistant messages."""
        blocks = [first or tool("w1", "write", dict(filePath=self.path(), content=C1), T0 + 10, T0 + 12), tool("j1", "jev:jev_verify", jev_input(), T0 + 20, T0 + 25, out=jev_json())]
        return self.sel([user("Goal: ship it.", T0), assistant(blocks, T0 + 9)] + [assistant(b, T0 + 30 + 10 * k) for k, b in enumerate(later)], sid=sid)

    def doc(self, sel, which=0, call="j1"):
        v = versions.versions_of(sel, self.path())[0][which]
        chk = dict(id="p1", tool="verify", verdict="supported", confidence=0.99, jev_ref=dict(tool_use_id=call, result_index=0, key=CLAIM), version_ref=versions.version_ref(v, "session_end"))
        return dict(session=dict(session_id="ses_d", jsonl=sel, cwd=self.cwd), handoff=dict(path=self.path(), versions=[]), checks=[chk], findings=[], unresolved=[], status="PASS")

    def certify(self, sel, content, which=0, call="j1"):
        """Write the report for the check bound to version `which`, then run the gate against the disk file. -> (report doc, gate result)."""
        open(self.path(), "w").write(content)
        rd = os.path.join(self.base, "run%d" % len(os.listdir(self.base))); os.makedirs(rd)
        md, js = report.write_report(rd, self.path(), self.doc(sel, which, call), "Stare: **PASS**\n", calls_jsonl=sel)
        doc = json.load(open(os.path.join(rd, js))); return doc, versions.gate(sel, self.path(), doc, disk_path=self.path())

    def late_write(self, content=C1, name="w2", completed=T0 + 32, created=None, **kw):
        return untimed(tool(name, "write", dict(filePath=self.path(), content=content), T0 + 31, T0 + 32, **kw), created, completed)

class Diagnostics(Chain):
    def test_the_adapter_keeps_the_untimed_successful_mutation_as_a_diagnostic_and_invents_nothing(self):
        sel = self.build([self.late_write(C2)]); recs = self.O.records(sel)
        self.assertEqual([c["id"] for c, _ in uses(recs)], ["w1", "j1"])           # no event, no timestamp, no result for w2
        notes = self.O.diagnostics(sel); self.assertEqual(len(notes), 1); n = notes[0]
        self.assertEqual((n["call_id"], n["path"], n["seq"], n["ci"], n["sub"], n["created"], n["completed"]), ("w2", self.path(), 3, 0, 1, None, T0 + 32)); self.assertIn("timing", n["reason"])
        self.assertEqual(D.diagnostics(sel), notes)
        self.assertEqual(D.diagnostics(__file__), [])                              # a Claude transcript has none
        self.assertEqual(versions.versions_of(sel, self.path())[0][0]["content"], C1)

    def test_a_failed_untimed_mutation_is_not_a_diagnostic(self):
        sel = self.build([untimed(tool("w2", "write", dict(filePath=self.path(), content=C2), T0 + 31, status="error"), None, T0 + 32)])
        self.assertEqual(self.O.diagnostics(sel), []); self.assertEqual(versions.versions_of(sel, self.path())[0][0]["unpositioned"], [])

class Gate(Chain):
    def test_a_completed_untimed_rewrite_with_the_same_bytes_blocks_the_certificate(self):
        sel = self.build([self.late_write(C1)])
        vs = versions.versions_of(sel, self.path())[0]; self.assertEqual([v["unpositioned"] for v in vs], [["w2"]])
        kind, why, _ = versions.validate_ref(versions.version_ref(vs[0]), vs, J.load_calls(sel)[0], same=True); self.assertEqual(kind, "unpositioned"); self.assertIn("w2", why)
        doc, g = self.certify(sel, C1)
        self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("unpositioned", " ".join(g["reasons"])); self.assertEqual(doc["delivery"]["delivery_state"], "unresolved")
        self.assertNotEqual(doc["status"], "PASS"); self.assertEqual(g["bound_checks_for_version"], 0)
        self.assertEqual(versions.validate_ref(versions.version_ref(vs[0]), vs)[0], "ok")      # retrospectively (no same-session claim) the historical snapshot is still available

    def test_a_completed_untimed_rewrite_with_different_bytes_is_unresolved_too(self):
        sel = self.build([self.late_write(C2)]); doc, g = self.certify(sel, C2)
        self.assertEqual(g["delivery_state"], "unresolved"); self.assertEqual([v["unpositioned"] for v in versions.versions_of(sel, self.path())[0]], [["w2"]])

    def test_an_unrelated_path_does_not_affect_the_target(self):
        sel = self.build([untimed(tool("w2", "write", dict(filePath=self.path_for("other.md"), content=C2), T0 + 31, T0 + 32), None, T0 + 32)])
        self.assertEqual(len(self.O.diagnostics(sel)), 1); self.assertEqual(versions.versions_of(sel, self.path())[0][0]["unpositioned"], [])
        doc, g = self.certify(sel, C1); self.assertEqual(g["delivery_state"], "verified_version")

    def test_an_alias_of_the_target_is_the_target(self):
        open(self.path(), "w").write(C1); alias = self.path_for("alias.md"); os.symlink(self.path(), alias)
        w2 = untimed(tool("w2", "write", dict(filePath=alias, content=C2), T0 + 31, T0 + 32), None, T0 + 32)
        sel = self.build([w2]); self.assertEqual(self.O.diagnostics(sel)[0]["path"], self.path())
        self.assertEqual(versions.versions_of(sel, self.path())[0][0]["unpositioned"], ["w2"])
        doc, g = self.certify(sel, C1); self.assertEqual(g["delivery_state"], "unresolved")

    def test_absent_and_malformed_times_all_block(self):
        base = tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32)
        variants = {"no times": untimed(base), "no completed": untimed(base, T0 + 31, None), "completed before created": untimed(base, T0 + 35, T0 + 31), "non-integer completed": untimed(base, T0 + 31, "later"),
                    "negative created": untimed(base, -5, T0 + 32), "bool created": untimed(base, True, T0 + 32)}
        for name, blk in variants.items():
            with self.subTest(name):
                sel = self.build([blk], sid="ses_" + name.replace(" ", "_").replace("-", "_")); vs = versions.versions_of(sel, self.path())[0]
                self.assertEqual([v["unpositioned"] for v in vs], [["w2"]], name); doc, g = self.certify(sel, C1); self.assertEqual(g["delivery_state"], "unresolved", name)

    def test_a_pathless_successful_note_blocks_the_target_conservatively(self):
        for k, blk in enumerate((tool("w2", "write", dict(content=C2), T0 + 31, T0 + 32), untimed(tool("w3", "edit", dict(oldString="a", newString="b"), T0 + 31, T0 + 32), None, None))):
            sel = self.build([blk], sid="ses_pl%d" % k); n = self.O.diagnostics(sel)[0]; self.assertIsNone(n["path"])
            vs = versions.versions_of(sel, self.path())[0]; self.assertEqual(len(vs[0]["unpositioned"]), 1)
            doc, g = self.certify(sel, C1); self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("target impact unknown", " ".join(g["reasons"]))
        failed = self.build([tool("w9", "write", dict(content=C2), T0 + 31, status="error")], sid="ses_plf")                  # a failed pathless operation is not a mutation
        self.assertEqual(self.O.diagnostics(failed), []); self.assertEqual(self.certify(failed, C1)[1]["delivery_state"], "verified_version")

    def test_a_full_write_with_a_demonstrated_order_and_its_own_check_restores_certification(self):
        w3 = tool("w3", "write", dict(filePath=self.path(), content=C2), T0 + 40, T0 + 42); j2 = tool("j2", "jev:jev_verify", jev_input(), T0 + 50, T0 + 55, out=jev_json())
        sel = self.build([self.late_write(C1)], [w3, j2]); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["unpositioned"]) for v in vs], [("w1", ["w2"]), ("w3", [])])
        doc, g = self.certify(sel, C2, which=1, call="j2"); self.assertEqual(g["delivery_state"], "verified_version"); self.assertEqual(g["bound_checks_for_version"], 1)
        old, g_old = self.certify(sel, C2, which=0, call="j1")                                                          # the historical snapshot is not the certified delivery
        self.assertEqual(g_old["delivery_state"], "unresolved")

    def test_a_restoring_write_must_follow_the_completion_time_strictly(self):
        for k, (use_at, done) in enumerate(((T0 + 32, T0 + 33), (T0 + 31, T0 + 33), (T0 + 20, T0 + 22))):
            w3 = tool("w3", "write", dict(filePath=self.path(), content=C2), use_at, done); sel = self.build([self.late_write(C1)], [w3], sid="ses_eq%d" % k)
            vs = versions.versions_of(sel, self.path())[0]; self.assertIn("w2", vs[-1]["unpositioned"], (use_at, done))

    def test_message_order_and_a_missing_completion_time_do_not_re_establish(self):
        # message order says w2 (seq 3) then w3 (seq 4), the recorded times say w3 (T0+40) completed before w2 did (T0+60): the time wins
        w3 = tool("w3", "write", dict(filePath=self.path(), content=C2), T0 + 40, T0 + 42)
        sel = self.build([self.late_write(C1, completed=T0 + 60)], [w3], sid="ses_rev"); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["unpositioned"]) for v in vs], [("w1", ["w2"]), ("w3", ["w2"])])
        # no valid completion time for the uncertain mutation: a later write is only an assumed restoration
        sel2 = self.build([untimed(self.late_write(C1), None, None)], [w3], sid="ses_asm"); vs2 = versions.versions_of(sel2, self.path())[0]
        self.assertEqual([v["unpositioned"] for v in vs2], [["w2"], ["w2"]])
        doc, g = self.certify(sel2, C2, which=1, call="j1"); self.assertEqual(g["delivery_state"], "unresolved")

class Historical(Chain):
    """An uncertain mutation taints the Edits it may have preceded, not the ones that were demonstrably complete before it was created; the blocker of the CURRENT delivery stays."""
    def edit(self, created=T0 + 20, completed=T0 + 22): return tool("e1", "edit", dict(filePath=self.path(), oldString="alpha", newString="beta"), created, completed)

    def test_an_edit_completed_before_the_uncertain_mutation_was_created_stays_recoverable(self):
        late = untimed(tool("w3", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), T0 + 30, None)       # created 30 > the Edit's completion 22; no completion time
        sel = self.build([self.edit()], [late]); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["status"]) for v in vs], [("w1", "ok"), ("e1", "ok")]); self.assertEqual(vs[1]["content"], C2)
        self.assertEqual([v["unpositioned"] for v in vs], [["w3"], ["w3"]])                                              # the current-delivery blocker is untouched
        doc, g = self.certify(sel, C2, which=1); self.assertEqual(g["delivery_state"], "unresolved"); self.assertIn("unpositioned", " ".join(g["reasons"]))
        self.assertEqual(versions.replay_all(sel)["e1"][1], sha(C2))

    def test_without_positive_evidence_the_edit_stays_tainted(self):
        for k, (made, done) in enumerate(((T0 + 21, None), (T0 + 22, None), (None, None), (None, T0 + 40))):      # created before / at the Edit's completion, no times, a completion without a creation
            late = untimed(tool("w3", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), made, done)
            sel = self.build([self.edit()], [late], sid="ses_h%d" % k); vs = versions.versions_of(sel, self.path())[0]
            self.assertEqual(vs[1]["status"], "content not recoverable", (made, done))

    def test_an_edit_before_a_pathless_mutation_is_judged_the_same_way(self):
        late = untimed(tool("w3", "write", dict(content=C2), T0 + 31, T0 + 32), T0 + 30, T0 + 32)
        sel = self.build([self.edit()], [late], sid="ses_pl"); self.assertIsNone(self.O.diagnostics(sel)[0]["path"])
        self.assertEqual([v["status"] for v in versions.versions_of(sel, self.path())[0]], ["ok", "ok"])

class AdapterBase(Chain):
    """The adapter restores its own base by the same positive evidence as the versions: a full write strictly after the uncertain mutation's completion, never by message order."""
    PATCH = "*** Update File: %s\n@@\n # Handoff\n-- beta\n+- gamma\n"
    def patch(self, created=T0 + 60): return patch("p1", self.PATCH % self.path(), created, created + 2)

    def test_a_patch_after_a_full_write_that_follows_the_uncertain_completion_has_a_known_base(self):
        blind = untimed(tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), None, T0 + 32)       # no created, completed 32; its MESSAGE is recorded after the next two
        w3 = tool("w3", "write", dict(filePath=self.path(), content=C2), T0 + 50, T0 + 52)
        sel = self.build([w3, self.patch()], [blind]); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual([(v["write_tool_use_id"], v["status"], v["unpositioned"]) for v in vs], [("w1", "ok", ["w2"]), ("w3", "ok", []), ("p1#1", "ok", [])])
        self.assertEqual(vs[2]["content"], "# Handoff\n- gamma\n")

    def test_without_that_evidence_the_base_stays_unknown(self):
        w3 = lambda created: tool("w3", "write", dict(filePath=self.path(), content=C2), created, created + 2)
        for k, (blind, written) in enumerate(((untimed(tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), None, T0 + 32), T0 + 31),      # the write is not strictly after
                                              (untimed(tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), None, T0 + 90), T0 + 50),     # the uncertain mutation completed later
                                              (untimed(tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), None, None), T0 + 50))):       # no completion time at all
            sel = self.build([w3(written), self.patch()], [blind], sid="ses_ab%d" % k); vs = versions.versions_of(sel, self.path())[0]
            self.assertEqual(vs[-1]["status"], "content not recoverable", k); self.assertIn("without a known base", vs[-1]["reason"])

    def test_the_message_order_alone_never_restores_the_base(self):
        blind = untimed(tool("w2", "write", dict(filePath=self.path(), content=C1), T0 + 31, T0 + 32), None, T0 + 90)       # the uncertain mutation's message comes FIRST, the write after it by message order only
        w3 = tool("w3", "write", dict(filePath=self.path(), content=C2), T0 + 50, T0 + 52)
        sel = self.build([blind], [w3, self.patch()], sid="ses_mo"); vs = versions.versions_of(sel, self.path())[0]
        self.assertEqual(vs[-1]["status"], "content not recoverable")

class Rows(Chain):
    def test_versions_list_and_prepare_show_the_field(self):
        sel = self.build([self.late_write(C1)]); open(self.path(), "w").write(C1)
        out = subprocess.run([sys.executable, "-B", os.path.join(HERE, "versions.py"), "list", "--source", sel, "--file", self.path(), "--evaluated-against", "session_end"], capture_output=True, text=True, env=ENV)
        o = json.loads(out.stdout); self.assertEqual(out.returncode, 0, out.stdout); self.assertEqual(o["versions"][0]["unpositioned"], ["w2"]); self.assertIn("unpositioned", o["note"])
        work = os.path.join(self.base, "work_out")
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "prepare.py"), sel, "--cwd", self.cwd, "--out", work], capture_output=True, text=True, env=ENV); self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        inv = json.load(open(os.path.join(work, "inventory.json"))); self.assertEqual(inv["handoffs"][0]["versions"][0]["unpositioned"], ["w2"])
        self.assertEqual(len(inv["session"]["diagnostics"]), 1)

if __name__ == "__main__": unittest.main()

#!/usr/bin/env python3
"""Offline regressions of the council corrections to the obligation ledger (stdlib, no Jev call; the calls are simulated in invented transcripts):
 - a stage is usable only when the REAL result is the one of the canonical claim (jevref.results_of: the right claim at the right index, an identifiable shape, a usable verdict), and `next` asks for the
   report only when the SOURCE result itself is strict (verified, confidence > 0.95, explicit auto, same_subject >= subject_at);
 - a stage is judged in every representation of the session (a shorter source never hides a second verification run, a next mutation or a subagent write) and on the timeline of the transcript that holds the call;
 - a malformed ledger (missing or mistyped fields, an incomplete identity) is refused with exit 3 and a safe diagnostic, and the file is left untouched.
usage: python3 -B test_ledger_corrective.py [-v]"""
import copy, json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O, versions as V
from test_obligation_ledger import Base, Tx, write, run, NOTE, Q1, Q2

def raw_result(t, tid, claim, evidence, body, name="mcp__jev__jev_verify"):
    t.tool(tid, name, dict(claims=[claim], evidence=evidence if isinstance(evidence, list) else [evidence]), body if isinstance(body, str) else json.dumps(body))

def good(claim, verdict="unsupported", conf=0.99, action="auto", same=0.9, subject_at=0.5, **kw):
    r = dict(claim=claim, verdict=verdict, confidence=conf, same_subject=same, **kw)
    if action is not None: r["action"] = action
    return dict(subject_at=subject_at, results=[r])

class Binding(Base):
    def prepared(self):
        self.session("intro", Q1, Q2); c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); return outs[0], self.doc()["obligations"][0]["id"]

    def stage(self, oid, tid, stage="absence"):
        self.assertEqual(self.record(oid, stage, tid)[0], 0); r = self.resume()[1]["obligations"][0]
        return r, next(s for s in r["stages"] if s["tool_use_id"] == tid)

    def test_a_verified_result_for_another_detail_is_not_a_bound_absence(self):
        out, oid = self.prepared()
        raw_result(self.t, "m1", out["absence_claim"], out["material"], good("some OTHER detail", verdict="verified")); self.t.save()
        r, s = self.stage(oid, "m1"); self.assertNotEqual(s["state"], "bound"); self.assertIn("result", s["reason"]); self.assertEqual(r["next"], "call_absence")

    def test_a_result_for_another_claim_is_not_a_bound_source(self):
        out, oid = self.prepared()
        self.call_absence(out, "c1"); self.record(oid, "absence", "c1")
        raw_result(self.t, "m2", out["source_claim"], out["source_passage"], good("OTHER claim", verdict="verified")); self.t.save()
        r, s = self.stage(oid, "m2", "source"); self.assertNotEqual(s["state"], "bound"); self.assertEqual(r["next"], "call_source")

    def test_empty_unknown_and_unusable_responses_are_not_bound(self):
        out, oid = self.prepared(); cl = out["absence_claim"]
        bodies = {"e1": dict(results=[]), "e2": dict(foo=1), "e3": dict(results="x"), "e4": dict(results=["x"]), "e5": "not json", "e6": dict(results=[dict(claim=cl)]),
                  "e7": dict(results=[dict(claim=cl, verdict=5, confidence=0.99, action="auto")]), "e8": dict(results=[good(cl)["results"][0], good(cl)["results"][0]])}
        for tid, b in bodies.items(): raw_result(self.t, tid, cl, out["material"], b)
        self.t.save()
        for tid in bodies: self.record(oid, "absence", tid)
        r = self.resume()[1]["obligations"][0]
        for s in r["stages"]: self.assertNotEqual(s["state"], "bound", s["tool_use_id"]); self.assertTrue(s["reason"], s["tool_use_id"])
        self.assertEqual(r["next"], "call_absence")

    def test_a_call_without_a_result_yet_is_pending_not_bound(self):
        out, oid = self.prepared()
        self.t.rec("assistant", [dict(type="tool_use", id="np", name="mcp__jev__jev_verify", input=dict(claims=[out["absence_claim"]], evidence=[out["material"]]))]); self.t.save()
        r, s = self.stage(oid, "np"); self.assertNotEqual(s["state"], "bound")

    def source_next(self, **kw):
        out, oid = self.prepared(); self.call_absence(out, "c1"); self.record(oid, "absence", "c1")
        raw_result(self.t, "s1", out["source_claim"], out["source_passage"], good(out["source_claim"], **dict(dict(verdict="verified"), **kw))); self.t.save()
        r, s = self.stage(oid, "s1", "source"); return r, s

    def test_a_strict_source_result_is_ready_for_the_report(self):
        r, s = self.source_next(); self.assertEqual((s["state"], r["next"]), ("bound", "ready_for_the_report"))

    def test_weak_source_results_do_not_make_the_obligation_ready(self):
        for name, kw in (("confidence 0.95", dict(conf=0.95)), ("confidence 0.9", dict(conf=0.9)), ("action review", dict(action="review")), ("same_subject below subject_at", dict(same=0.3)),
                         ("unsupported verdict", dict(verdict="unsupported")), ("contradicted verdict", dict(verdict="contradicted"))):
            self.setUp(); r, s = self.source_next(**kw)
            self.assertNotEqual(r["next"], "ready_for_the_report", name); self.assertEqual(r["next"], "unresolved", name)

    def test_failed_auxiliary_conditions_of_the_absence_stage_do_not_clear_or_advance(self):
        out, oid = self.prepared()
        raw_result(self.t, "a1", out["absence_claim"], out["material"], good(out["absence_claim"], verdict="verified", same=0.3)); self.t.save()   # present, but same_subject < subject_at
        r, s = self.stage(oid, "a1"); self.assertEqual(r["next"], "unresolved")
        self.setUp(); out, oid = self.prepared()
        raw_result(self.t, "a2", out["absence_claim"], out["material"], good(out["absence_claim"], action="review")); self.t.save()
        r, s = self.stage(oid, "a2"); self.assertEqual(r["next"], "unresolved")

class Chronology(Base):
    """A shorter source and a fuller representation of the same session."""
    def setUp(self):
        super().setUp(); self.full = os.path.join(self.d, "full.jsonl")

    def save_split(self, k):
        write(self.t.log, "".join(json.dumps(r) + "\n" for r in self.t.recs[:k])); write(self.full, "".join(json.dumps(r) + "\n" for r in self.t.recs))

    def skill(self, tid): self.t.tool(tid, "Skill", dict(skill="jev:handoff-verify"), "loaded")

    def stage_in_full(self, oid, tid="c1"):
        self.assertEqual(self.record(oid, "absence", tid)[0], 0); r = self.resume("--session", self.full)[1]["obligations"][0]; return r, r["stages"][0]

    def test_a_shorter_source_does_not_hide_a_second_verification_run(self):
        t = self.t; t.user("intro"); t.user(Q1); t.write_note("w0"); t.save(); k = len(t.recs)
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); out = outs[0]; oid = self.doc()["obligations"][0]["id"]
        self.assertNotIn("run", out["version_ref"])
        self.skill("run1"); t.verify("c1", out["absence_claim"], out["material"]); t.user("second request"); self.skill("run2"); self.save_split(k)
        self.assertEqual(V.run_problem(t.log, out["version_ref"], also=[self.full])[0], "run")                    # the shared rule: judged in every representation
        r, s = self.stage_in_full(oid); self.assertEqual(r["state"], "valid"); self.assertNotEqual(s["state"], "bound"); self.assertIn("run", s["reason"])

    def test_a_named_run_stays_valid_when_the_fuller_representation_has_more_runs(self):
        t = self.t; t.user("intro"); t.user(Q1); t.write_note("w0"); self.skill("run1"); t.save(); k = len(t.recs)
        c, outs = self.batch([(Q1, dict(evaluated_against="session_end"))]); self.assertEqual(c, 0, outs); out = outs[0]; oid = self.doc()["obligations"][0]["id"]
        self.assertEqual(out["version_ref"]["run"], "run1")
        t.verify("c1", out["absence_claim"], out["material"]); t.user("second request"); self.skill("run2"); self.save_split(k)
        r, s = self.stage_in_full(oid); self.assertEqual(s["state"], "bound", s)

    def test_a_next_mutation_in_the_fuller_representation_closes_the_window(self):
        t = self.t; t.user("intro"); t.user(Q1); t.write_note("w0"); t.save(); k = len(t.recs)
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); out = outs[0]; oid = self.doc()["obligations"][0]["id"]
        t.write_note("w1", NOTE + "- a later edit\n"); t.verify("c1", out["absence_claim"], out["material"]); self.save_split(k)
        r, s = self.stage_in_full(oid); self.assertNotEqual(s["state"], "bound"); self.assertIn("window", s["reason"])

    def test_a_call_inside_the_window_of_the_fuller_representation_is_bound(self):
        t = self.t; t.user("intro"); t.user(Q1); t.write_note("w0"); t.save(); k = len(t.recs)
        c, outs = self.batch([(Q1, {})]); out = outs[0]; oid = self.doc()["obligations"][0]["id"]
        t.verify("c1", out["absence_claim"], out["material"]); t.write_note("w1", NOTE + "- a later edit\n"); self.save_split(k)
        r, s = self.stage_in_full(oid); self.assertEqual(s["state"], "bound", s)

    def test_a_subagent_write_in_the_fuller_representation_leaves_the_order_undemonstrated(self):
        t = self.t; t.user("intro"); t.user(Q1); t.write_note("w0"); t.save(); k = len(t.recs)
        c, outs = self.batch([(Q1, {})]); out = outs[0]; oid = self.doc()["obligations"][0]["id"]
        t.verify("c1", out["absence_claim"], out["material"]); self.save_split(k)
        sub = Tx(self.d); sub.write_note("sw0", NOTE + "- written by a subagent\n")
        write(os.path.join(self.d, "full", "subagents", "agent-1.jsonl"), "".join(json.dumps(r) + "\n" for r in sub.recs))
        r, s = self.stage_in_full(oid); self.assertNotEqual(s["state"], "bound"); self.assertTrue(s["reason"])

class Malformed(Base):
    def prepared_doc(self):
        self.session("intro", Q1); c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); return self.doc()

    def check(self, doc, name):
        text = json.dumps(doc, indent=1) + "\n"; write(self.ledger, text)
        for label, args in (("resume", ["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d]), ("record", ["ledger", "record", "--ledger", self.ledger, "--id", "x", "--stage", "absence", "--tool-use-id", "c1"])):
            c, o = run(args, self.d); self.assertEqual(c, 3, (name, label, o)); j = json.loads(o); self.assertFalse(j["ok"], (name, label)); self.assertTrue(j.get("reasons"), (name, label))
            self.assertEqual(open(self.ledger, encoding="utf-8").read(), text, (name, label))
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 3, (name, outs)); self.assertEqual(open(self.ledger, encoding="utf-8").read(), text, name)

    def test_missing_and_incomplete_fields_are_refused(self):
        d = self.prepared_doc(); row = d["obligations"][0]
        cases = {}
        c = copy.deepcopy(d); c["obligations"][0].update(args=dict(detail="a", quote="a"), identity={}, stages={}); cases["empty identity and bare args"] = c
        for k in list(row["args"]):
            if k in ("cwd", "run", "location", "detail", "quote"): continue
            c = copy.deepcopy(d); del c["obligations"][0]["args"][k]; cases["args without %s" % k] = c
        for k in list(row["identity"]):
            c = copy.deepcopy(d); del c["obligations"][0]["identity"][k]; cases["identity without %s" % k] = c
        c = copy.deepcopy(d); del c["obligations"][0]["reasons"]; cases["no reasons"] = c
        c = copy.deepcopy(d); del c["obligations"][0]["state"]; cases["no state"] = c
        for name, doc in cases.items(): self.check(doc, name)

    def test_mistyped_fields_are_refused(self):
        d = self.prepared_doc(); cases = {}
        for path, val in (("args.write_id", 5), ("args.source", 5), ("args.file", ["x"]), ("args.evaluated_against", "later"), ("args.run", 3), ("args.cwd", 7), ("args.location", "x"), ("args.location", [1]), ("args.detail", 4), ("args.quote", {}),
                          ("identity.write_id", 5), ("identity.available", "yes"), ("identity.references", "x"), ("identity.references", [1]), ("identity.references", [dict(ref="a")]), ("identity.material_sha256", 5), ("identity.evaluated_sha256", None),
                          ("reasons", "x"), ("reasons", [1]), ("stages", []), ("stages", dict(absence="c1")), ("stages", dict(absence=[1])), ("stages", dict(absence=[dict(tool_use_id=5)])), ("id", "not-the-identity-hash")):
            c = copy.deepcopy(d); o = c["obligations"][0]
            if "." in path: a, b = path.split("."); o[a][b] = val
            else: o[path] = val
            cases["%s=%r" % (path, val)] = c
        c = copy.deepcopy(d); c["obligations"] = {}; cases["obligations a dict"] = c
        c = copy.deepcopy(d); c["audit"] = []; cases["audit a list"] = c
        for name, doc in cases.items(): self.check(doc, name)

    def test_diagnostics_are_safe_json_without_a_traceback(self):
        d = self.prepared_doc(); d["obligations"][0].update(args=dict(detail="a", quote="a"), identity={}, stages={}); write(self.ledger, json.dumps(d))
        p = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d], self.d); self.assertEqual(p[0], 3); self.assertNotIn("Traceback", p[1]); self.assertNotIn("KeyError", p[1])

    def test_a_well_formed_ledger_still_loads_and_unavailable_rows_are_valid_shapes(self):
        self.session("intro", Q1); c, outs = self.batch([(Q1, {}), ("a detail that is not in the transcript", {})]); self.assertEqual(c, 3)
        doc = L.load(self.ledger); self.assertEqual(len(doc["obligations"]), 2); self.assertEqual(self.resume()[0], 0)

    def test_save_validates_the_document_it_writes(self):
        d = self.prepared_doc(); bad = copy.deepcopy(d); bad["obligations"][0]["identity"] = {}
        before = open(self.ledger, encoding="utf-8").read()
        with self.assertRaises(L.LedgerError): L.save(self.ledger, bad)
        self.assertEqual(open(self.ledger, encoding="utf-8").read(), before)

if __name__ == "__main__": unittest.main()

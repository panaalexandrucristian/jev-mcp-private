#!/usr/bin/env python3
"""Offline test of the resumable obligation ledger (stdlib, no Jev call; the Jev calls are simulated in an invented transcript): `omissions.py prepare-batch --ledger` records one obligation per candidate and never drops
a row; `ledger record` stores only the tool_use id of a call; `ledger resume` re-derives every obligation from the files as they are and re-reads every recorded call: an obligation stays valid only while the identity
it was prepared with holds, a stage is bound only for a real, canonical call inside the window of its OWN write (two writes with the same hash never share a call), a changed source / version / reference invalidates what depends
on it (history kept, nothing reused), a forged, missing or out-of-window call is never usable, a malformed ledger is refused, and the ledger never claims completeness.
usage: python3 -B test_obligation_ledger.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ledger as L, omissions as O

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
Q1, Q2 = "Do NOT change the public API of billing.", "Never run migrate.sh against prod."
NOTE = "- the billing migration ships on Friday\n"
CANARY = "Zq" + "8f" + "Lm3" + "Xv9"

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f: f.write(text)

class Tx:
    """An invented transcript, written to disk after every change."""
    def __init__(self, d):
        self.d, self.n, self.recs = d, 0, []; self.note = os.path.join(d, "HANDOFF.md"); self.log = os.path.join(d, "session.jsonl")
    def rec(self, typ, content, **extra):
        self.n += 1; self.recs.append(dict(type=typ, uuid="u%d" % self.n, timestamp="2026-01-01T00:%02d:%02dZ" % (self.n // 60, self.n % 60), cwd=self.d, sessionId="s1", message=dict(role=typ, content=content), **extra))
    def user(self, text): self.rec("user", text)
    def tool(self, tid, name, inp, result="ok"):
        self.rec("assistant", [dict(type="tool_use", id=tid, name=name, input=inp)]); self.rec("user", [dict(type="tool_result", tool_use_id=tid, content=result)])
    def write_note(self, tid, text=NOTE): self.tool(tid, "Write", dict(file_path=self.note, content=text), "File created successfully at: " + self.note)
    def verify(self, tid, claim, evidence, verdict="unsupported", conf=0.99, action="auto"):
        self.tool(tid, "mcp__jev__jev_verify", dict(claims=[claim], evidence=evidence if isinstance(evidence, list) else [evidence]), json.dumps(dict(subject_at=0.5, results=[dict(claim=claim, verdict=verdict, confidence=conf, action=action, same_subject=0.9)])))
    def save(self):
        write(self.log, "".join(json.dumps(r) + "\n" for r in self.recs))

def run(args, cwd, stdin=None):
    p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py")] + args, cwd=cwd, capture_output=True, text=True, env=ENV, input=stdin); return p.returncode, p.stdout

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name); self.cwd0 = os.getcwd()
        self.t = Tx(self.d); self.ledger = os.path.join(self.d, "ledger.json"); write(self.t.note, NOTE); O.reset_caches()

    def tearDown(self): os.chdir(self.cwd0)

    def session(self, *users, writes=("w0",)):
        t = self.t
        for u in users: t.user(u)
        for w in writes: t.write_note(w)
        t.save()

    def batch(self, items, extra=(), ledger=True):
        spec = [dict(dict(detail=q, source_quote=q, write_id="w0", evaluated_against="prefix"), **i) for q, i in items]
        args = ["prepare-batch", "--source", self.t.log, "--file", self.t.note, "--spec", "-", "--cwd", self.d] + (["--ledger", self.ledger] if ledger else []) + list(extra)
        c, o = run(args, self.d, json.dumps(spec)); return c, json.loads(o)

    def doc(self): return json.load(open(self.ledger, encoding="utf-8"))
    def resume(self, *extra):
        c, o = run(["ledger", "resume", "--ledger", self.ledger, "--cwd", self.d] + list(extra), self.d); return c, json.loads(o)
    def record(self, oid, stage, tid):
        return run(["ledger", "record", "--ledger", self.ledger, "--id", oid, "--stage", stage, "--tool-use-id", tid], self.d)

    def call_absence(self, out, tid, **kw):
        self.t.verify(tid, out["absence_claim"], out["material"], **kw); self.t.save()
    def call_source(self, out, tid, **kw):
        self.t.verify(tid, out["source_claim"], out["source_passage"], verdict="verified", **kw); self.t.save()

class Writing(Base):
    def test_batch_records_one_obligation_per_candidate_and_prints_the_same_array(self):
        self.session("intro", Q1, Q2)
        c, out = self.batch([(Q1, {}), (Q2, {})]); self.assertEqual(c, 0)
        c2, out2 = self.batch([(Q1, {}), (Q2, {})], ledger=False); self.assertEqual(out, out2)         # stdout is the batch, ledger or not
        d = self.doc(); self.assertEqual((d["schema"], d["version"], d["audit"]["categories_required"]), (L.SCHEMA, 1, 9))
        self.assertEqual(len(d["obligations"]), 2); self.assertEqual(len({r["id"] for r in d["obligations"]}), 2)
        self.assertTrue(all(r["state"] == "prepared" and r["stages"] == {} for r in d["obligations"]))

    def test_a_second_batch_adds_and_never_drops_or_resets(self):
        self.session("intro", Q1, Q2)
        self.batch([(Q1, {})]); oid = self.doc()["obligations"][0]["id"]; self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        self.batch([(Q1, {}), (Q2, {})]); d = self.doc(); self.assertEqual(len(d["obligations"]), 2)
        self.assertEqual(d["obligations"][0]["stages"], {"absence": [{"tool_use_id": "c1"}]})            # the existing row kept its stage
        self.batch([(Q2, {})]); self.assertEqual(len(self.doc()["obligations"]), 2)
        with self.assertRaises(L.LedgerError): L.save(self.ledger, dict(self.doc(), obligations=self.doc()["obligations"][:1]))

    def test_unavailable_candidates_are_kept_and_listed(self):
        self.session("intro", Q1)
        c, out = self.batch([(Q1, {}), ("a detail that is not in the transcript", {})]); self.assertEqual(c, 3)
        d = self.doc(); self.assertEqual([r["state"] for r in d["obligations"]], ["prepared", "unavailable"]); self.assertTrue(d["obligations"][1]["reasons"])
        c, r = self.resume(); self.assertEqual([x["state"] for x in r["obligations"]], ["valid", "unavailable"])
        self.assertEqual(self.record(d["obligations"][1]["id"], "absence", "c1")[0], 3)

    def test_a_secret_dependent_candidate_is_never_stored_in_clear(self):
        self.session("intro", Q1, "set API_KEY=%s" % CANARY)
        c, out = self.batch([("rotate API_KEY=%s" % CANARY, dict(source_quote="API_KEY=%s" % CANARY)), (Q1, {})]); self.assertEqual(c, 3)
        raw = open(self.ledger, encoding="utf-8").read(); self.assertNotIn(CANARY, raw)
        d = self.doc(); self.assertIsNone(d["obligations"][0]["args"]["detail"]); self.assertEqual(d["obligations"][0]["state"], "unavailable")
        c, r = self.resume(); self.assertEqual(r["obligations"][0]["state"], "unavailable"); self.assertNotIn(CANARY, json.dumps(r))

    def test_a_malformed_ledger_is_refused_and_left_alone(self):
        self.session("intro", Q1)
        for bad in ("not json", "{}", json.dumps(dict(schema=L.SCHEMA, version=1, obligations=[{"id": 1}])), '{"schema": "handoff-verify-ledger", "version": 1, "obligat'):
            write(self.ledger, bad)
            c, out = self.batch([(Q1, {})]); self.assertEqual(c, 3); self.assertFalse(out["ok"]); self.assertEqual(open(self.ledger).read(), bad)
            c, r = self.resume(); self.assertEqual(c, 3); self.assertFalse(r["ok"])
            self.assertEqual(self.record("x", "absence", "c1")[0], 3)

    def test_the_ledger_never_claims_completeness(self):
        self.session("intro", Q1); self.batch([(Q1, {})]); c, r = self.resume()
        self.assertFalse(r["coverage"]["complete"]); self.assertEqual(r["coverage"]["categories_required"], 9); self.assertIn("nine categories", r["coverage"]["note"])

class Resuming(Base):
    def prepared(self, *items):
        self.session("intro", Q1, Q2, writes=("w0",)); c, outs = self.batch(list(items) or [(Q1, {})]); self.assertEqual(c, 0, outs); return outs

    def test_bound_stages_and_the_next_step(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]
        c, r = self.resume(); self.assertEqual((r["obligations"][0]["state"], r["obligations"][0]["next"]), ("valid", "call_absence"))
        self.call_absence(out, "c1"); self.assertEqual(self.record(oid, "absence", "c1")[0], 0)
        c, r = self.resume(); o = r["obligations"][0]
        self.assertEqual((o["state"], o["stages"][0]["state"], o["next"]), ("valid", "bound", "call_source")); self.assertEqual(o["stages"][0]["observed"]["verdict"], "unsupported")
        self.call_source(out, "c2"); self.record(oid, "source", "c2"); c, r = self.resume(); self.assertEqual(r["obligations"][0]["next"], "ready_for_the_report")
        self.assertEqual(r["coverage"]["valid"], 1); self.assertFalse(r["coverage"]["complete"])

    def test_a_present_note_needs_no_source_call_and_a_weak_result_stays_unresolved(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]
        self.call_absence(out, "c1", verdict="verified"); self.record(oid, "absence", "c1"); self.assertEqual(self.resume()[1]["obligations"][0]["next"], "no_source_call")
        self.call_absence(out, "c3", conf=0.9); self.record(oid, "absence", "c3")                                      # the first bound stage is the one read; add a fresh ledger row to look at c3 alone
        d = self.doc(); d["obligations"][0]["stages"]["absence"] = [{"tool_use_id": "c3"}]; L.save(self.ledger, d)
        self.assertEqual(self.resume()[1]["obligations"][0]["next"], "unresolved")

    def test_forged_missing_wrong_claim_wrong_evidence_and_out_of_window_calls_are_not_usable(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]
        t = self.t; t.verify("bad1", "some other claim", out["material"]); t.verify("bad2", out["absence_claim"], out["material"] + " extra")
        t.tool("notjev", "Bash", dict(command="echo"), "ok"); t.save()
        for tid in ("ghost", "bad1", "bad2", "notjev"): self.record(oid, "absence", tid)
        c, r = self.resume(); st = {s["tool_use_id"]: s for s in r["obligations"][0]["stages"]}
        for tid in ("ghost", "notjev"): self.assertEqual(st[tid]["state"], "missing", tid)     # not a Jev call of the session at all
        for tid in ("bad1", "bad2"): self.assertEqual(st[tid]["state"], "stale", tid)
        self.assertEqual(r["obligations"][0]["next"], "call_absence")

    def test_a_call_before_the_write_is_outside_the_window(self):
        sc, ac = O.claims(Q1); t = self.t
        t.user("intro"); t.user(Q1); t.verify("early", ac, O.material(NOTE)); t.write_note("w0"); t.save()
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); oid = self.doc()["obligations"][0]["id"]; self.record(oid, "absence", "early")
        o = self.resume()[1]["obligations"][0]; self.assertEqual(o["state"], "valid"); self.assertEqual(o["stages"][0]["state"], "stale"); self.assertIn("window", o["stages"][0]["reason"]); self.assertEqual(o["next"], "call_absence")

    def test_two_writes_with_the_same_hash_never_share_a_call(self):
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0"); self.t.write_note("w1"); self.t.save()
        c, outs = self.batch([(Q1, dict(write_id="w0")), (Q1, dict(write_id="w1"))]); self.assertEqual(c, 0, outs)
        rows = self.doc()["obligations"]; self.assertEqual(len(rows), 2); self.assertNotEqual(rows[0]["id"], rows[1]["id"])
        self.assertEqual(outs[0]["version_ref"]["sha256"], outs[1]["version_ref"]["sha256"])
        # a call that lies between the two writes belongs to the window of w0 only
        t = self.t; t.recs = t.recs[:-2]; t.verify("c1", outs[0]["absence_claim"], outs[0]["material"]); t.write_note("w1"); t.save()
        for r in rows: self.record(r["id"], "absence", "c1")
        c, r = self.resume(); by = {o["id"]: o for o in r["obligations"]}
        self.assertEqual(by[rows[0]["id"]]["stages"][0]["state"], "bound"); self.assertEqual(by[rows[1]["id"]]["stages"][0]["state"], "stale")

    def test_appending_after_the_evaluated_window_keeps_the_progress(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]; self.call_absence(out, "c1"); self.record(oid, "absence", "c1")
        self.t.user("a later request"); self.t.tool("later", "Bash", dict(command="ls"), "x"); self.t.save()
        o = self.resume()[1]["obligations"][0]; self.assertEqual((o["state"], o["stages"][0]["state"]), ("valid", "bound"))

    def test_a_changed_evaluated_source_invalidates_and_marks_the_recorded_stage_stale(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]; self.call_absence(out, "c1"); self.record(oid, "absence", "c1")
        self.assertEqual(self.resume()[1]["obligations"][0]["state"], "valid")
        s = open(self.t.log, "rb").read(); st = os.stat(self.t.log)
        open(self.t.log, "wb").write(s.replace(b"intro", b"INTRO")); os.utime(self.t.log, ns=(st.st_atime_ns, st.st_mtime_ns))   # same size, same mtime
        c, r = self.resume(); o = r["obligations"][0]
        self.assertEqual(o["state"], "invalidated"); self.assertTrue(any("evaluated source" in x for x in o["reasons"])); self.assertEqual(o["stages"][0]["state"], "stale")
        self.assertEqual(len(self.doc()["obligations"]), 1)                                                 # history kept

    def test_a_changed_reference_invalidates(self):
        write(os.path.join(self.d, "ref.md"), "reference AAAA\n"); write(self.t.note, "- see `ref.md`\n")
        self.t.user("intro"); self.t.user(Q1); self.t.write_note("w0", "- see `ref.md`\n"); self.t.save()
        c, outs = self.batch([(Q1, {})]); self.assertEqual(c, 0, outs); self.assertEqual(self.resume()[1]["obligations"][0]["state"], "valid")
        write(os.path.join(self.d, "ref.md"), "reference BBBB\n"); o = self.resume()[1]["obligations"][0]
        self.assertEqual(o["state"], "invalidated"); self.assertTrue(any("complete material" in x or "reference" in x for x in o["reasons"]))
        os.remove(os.path.join(self.d, "ref.md")); o = self.resume()[1]["obligations"][0]; self.assertEqual(o["state"], "invalidated"); self.assertIn("no longer preparable", o["reasons"][0])
        write(os.path.join(self.d, "ref.md"), "reference AAAA\n"); self.assertEqual(self.resume()[1]["obligations"][0]["state"], "valid")      # restored: the very same identity

    def test_a_changed_run_or_version_invalidates(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]
        d = self.doc(); d["obligations"][0]["args"]["write_id"] = "nope"; L.save(self.ledger, d)
        self.assertEqual(self.resume()[1]["obligations"][0]["state"], "invalidated")

    def test_a_second_session_can_hold_the_calls(self):
        out = self.prepared()[0]; oid = self.doc()["obligations"][0]["id"]
        t2 = Tx(self.d); t2.log = os.path.join(self.d, "calls.jsonl"); t2.user("verification"); t2.verify("k1", out["absence_claim"], out["material"]); t2.save(); self.record(oid, "absence", "k1")
        o = self.resume("--session", t2.log)[1]["obligations"][0]; self.assertEqual((o["state"], o["stages"][0]["state"]), ("valid", "bound"))

if __name__ == "__main__": unittest.main()

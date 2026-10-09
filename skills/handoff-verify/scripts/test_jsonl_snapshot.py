#!/usr/bin/env python3
"""Offline regressions of the JSONL snapshot (stdlib, no Jev call): inside `discover.fingerprint_scope` a transcript is read ONCE -- its digest, its records (`load_jsonl`), its Jev calls (`jevref.load_calls`) and the
reconstruction of the note versions all come from the same captured bytes, so a file that changes meanwhile never gives a digest of old bytes with records of new ones; every load returns its own mutable copy; nested
scopes share the capture; outside a scope the next operation sees the bytes as they are; across the rows of a ledger resume every row is judged against the same bytes.
usage: python3 -B test_jsonl_snapshot.py [-v]"""
import hashlib, json, os, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, jevref as J, ledger as L, omissions as O, versions as V
from test_obligation_ledger import Base, Tx, write, NOTE, Q1, Q2

def sha(b): return hashlib.sha256(b).hexdigest()

class Capture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name)
        self.t = Tx(self.d); self.t.user("first request"); self.t.write_note("w0"); self.t.tool("c1", "mcp__jev__jev_verify", dict(claims=["x"], evidence=["y"]), json.dumps(dict(results=[dict(claim="x", verdict="verified", confidence=0.99)]))); self.t.save()
        self.old = open(self.t.log, "rb").read(); O.reset_caches()

    def change(self, same_size=False):
        new = self.old.replace(b"first request", b"FIRST REQUEST") if same_size else self.old + (json.dumps(dict(type="user", uuid="zz", message=dict(role="user", content="added later"))) + "\n").encode()
        open(self.t.log, "wb").write(new); return new

    def test_digest_and_records_come_from_the_same_bytes(self):
        for same_size in (False, True):
            self.t.save(); O.reset_caches()
            with D.fingerprint_scope():
                fp = D.content_fingerprint(self.t.log); new = self.change(same_size); recs = D.load_jsonl(self.t.log)
            self.assertEqual(fp[2], sha(self.old)); self.assertEqual([r.get("uuid") for r in recs], [json.loads(l)["uuid"] for l in self.old.decode().splitlines()], same_size)
            self.assertNotIn("zz", [r.get("uuid") for r in recs]); self.assertFalse(any(r.get("message", {}).get("content") == "FIRST REQUEST" for r in recs))

    def test_calls_and_records_are_one_snapshot(self):
        with D.fingerprint_scope():
            calls = J.load_calls(self.t.log); self.change()
            calls2 = J.load_calls(self.t.log); recs = D.load_jsonl(self.t.log)
        self.assertEqual([c["tool_use_id"] for c in calls], [c["tool_use_id"] for c in calls2]); self.assertEqual(len(recs), 5)

    def test_reconstruction_and_call_loading_do_not_straddle_a_change(self):
        with D.fingerprint_scope():
            vs, canon, _, _ = V.versions_of(self.t.log, self.t.note); n0 = len(vs)
            # the transcript now holds one more verification call and one more write
            more = Tx(self.d); more.recs = [json.loads(l) for l in self.old.decode().splitlines()]; more.n = len(more.recs); more.tool("c2", "mcp__jev__jev_verify", dict(claims=["x"], evidence=["y"]), json.dumps(dict(results=[dict(claim="x", verdict="verified", confidence=0.99)]))); more.write_note("w1", NOTE + "- more\n"); more.save()
            calls = J.load_calls(self.t.log); vs2, _, _, _ = V.versions_of(self.t.log, self.t.note)
        self.assertEqual([c["tool_use_id"] for c in calls], ["c1"]); self.assertEqual((n0, len(vs2)), (1, 1))
        O.reset_caches(); self.assertEqual([c["tool_use_id"] for c in J.load_calls(self.t.log)], ["c1", "c2"]); self.assertEqual(len(V.versions_of(self.t.log, self.t.note)[0]), 2)     # outside the scope the next operation sees the change

    def test_outside_a_scope_every_operation_reads_the_bytes_as_they_are(self):
        fp0 = D.content_fingerprint(self.t.log); n0 = len(D.load_jsonl(self.t.log)); self.change()
        self.assertNotEqual(D.content_fingerprint(self.t.log), fp0); self.assertEqual(len(D.load_jsonl(self.t.log)), n0 + 1)
        with D.fingerprint_scope(): self.assertEqual(len(D.load_jsonl(self.t.log)), n0 + 1)
        self.t.save(); self.assertEqual(len(D.load_jsonl(self.t.log)), n0)

    def test_a_scope_ends_with_its_block(self):
        with D.fingerprint_scope(): D.load_jsonl(self.t.log); J.load_calls(self.t.log)
        self.change(); self.assertEqual(len(D.load_jsonl(self.t.log)), 6)

    def test_every_load_returns_an_independent_mutable_copy(self):
        with D.fingerprint_scope():
            a = D.load_jsonl(self.t.log); b = D.load_jsonl(self.t.log); self.assertIsNot(a, b); self.assertIsNot(a[0], b[0])
            a[0]["type"] = "mutated"; a.clear(); self.assertEqual(D.load_jsonl(self.t.log)[0]["type"], "user")
            c = J.load_calls(self.t.log); c[0]["parsed"] = None; c.clear(); self.assertEqual(len(J.load_calls(self.t.log)), 1)

    def test_nested_scopes_share_the_capture(self):
        with D.fingerprint_scope():
            fp = D.content_fingerprint(self.t.log); self.change()
            with D.fingerprint_scope(): self.assertEqual(D.content_fingerprint(self.t.log), fp); self.assertEqual(len(D.load_jsonl(self.t.log)), 5)
            self.assertEqual(D.content_fingerprint(self.t.log), fp); self.assertEqual(len(D.load_jsonl(self.t.log)), 5)
        self.assertEqual(len(D.load_jsonl(self.t.log)), 6)

    def test_a_failed_read_is_not_captured(self):
        gone = os.path.join(self.d, "gone.jsonl")
        with D.fingerprint_scope():
            with self.assertRaises(OSError): D.load_jsonl(gone)
            write(gone, '{"type": "user"}\n'); self.assertEqual(len(D.load_jsonl(gone)), 1)

class Resume(Base):
    def test_every_row_of_a_resume_is_judged_against_the_same_bytes(self):
        self.session("intro", Q1, Q2); c, outs = self.batch([(Q1, {}), (Q2, {})]); self.assertEqual(c, 0, outs)
        doc = L.load(self.ledger); O.reset_caches(); base = L.resume(doc, cwd=self.d); self.assertEqual([r["state"] for r in base["obligations"]], ["valid", "valid"])
        real = O.prepare_one; calls = []
        def mutating(ns, extra=None):
            out = real(ns, extra)
            if not calls:    # after the first row has been judged, the transcript loses the second request (and the reuse caches are evicted, as the bounded caches are when full)
                O._MEMO.clear(); O._SRC.clear(); O._PREP.clear()
                data = open(self.t.log, encoding="utf-8").read().replace(Q2, "Something else entirely."); open(self.t.log, "w", encoding="utf-8").write(data)
            calls.append(1); return out
        O.reset_caches()
        with mock.patch.object(O, "prepare_one", mutating): got = L.resume(doc, cwd=self.d)
        self.assertEqual(got, base)
        O.reset_caches(); self.assertNotEqual(L.resume(doc, cwd=self.d), base)    # the next resume sees the change

if __name__ == "__main__": unittest.main()

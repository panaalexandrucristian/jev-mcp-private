#!/usr/bin/env python3
"""Offline regressions of the council correction on OpenCode identities (stdlib, SQLite fixtures, no Jev call): the identity of an OpenCode selector is derived from the CONTENT of the stored session (read-only), not from the
size and mtime of the database and its WAL: a same-size change with restored timestamps changes the identity and invalidates the reconstruction, the source index, the scope and the ledger resume, a change in ANOTHER session of
the same database does not, and identity and parsing of one candidate come from ONE snapshot (`discover.fingerprint_scope`). The database is only ever opened read-only by the adapter.
usage: python3 -B test_opencode_identity.py [-v]"""
import json, os, sqlite3, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import discover as D, ledger as L, omissions as O, scope, versions
from test_opencode_adapter import Base, user, assistant, tool, T0

import argparse
Q = "Never run migrate.sh against prod."

class Identity(Base):
    def setUp(self):
        super().setUp(); O.reset_caches()
        self.note = self.path()
        self.sel_a = self.sel([user("intro request", T0), user(Q, T0 + 1), assistant([tool("w1", "write", dict(filePath=self.note, content="- ships Friday\n"), T0 + 5, T0 + 6)], T0 + 5)], sid="ses_a")
        self.fx.con.commit()

    def tearDown(self): O.reset_caches()

    def mutate(self, old, new, sid=None):
        """A same-size change of the stored text with the timestamps of the database and its WAL restored."""
        assert len(old) == len(new)
        paths = [p for p in (self.fx.db, self.fx.db + "-wal", self.fx.db + "-shm") if os.path.exists(p)]; times = {p: os.stat(p) for p in paths}
        c = sqlite3.connect(self.fx.db)
        c.execute("UPDATE session_message SET data = replace(data, ?, ?)" + (" WHERE session_id = ?" if sid else ""), (old, new) + ((sid,) if sid else ())); c.commit(); c.close()
        for p, st in times.items():
            if os.path.exists(p): os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))

    def test_same_size_change_with_restored_timestamps_changes_the_identity(self):
        before = D.content_fingerprint(self.sel_a); self.assertEqual(D.content_fingerprint(self.sel_a), before)
        st = os.stat(self.fx.db); self.mutate("intro request", "INTRO REQUEST")
        after = os.stat(self.fx.db); self.assertEqual((st.st_size, st.st_mtime_ns), (after.st_size, after.st_mtime_ns))     # the metadata did not move
        self.assertNotEqual(D.content_fingerprint(self.sel_a), before)

    def test_a_change_in_another_session_of_the_database_does_not_change_the_identity(self):
        sel_b = self.fx.session("ses_b", self.cwd, [user("other session text", T0)])
        before_a, before_b = D.content_fingerprint(self.sel_a), D.content_fingerprint(sel_b)
        self.mutate("other session", "OTHER SESSION", sid="ses_b")
        self.assertEqual(D.content_fingerprint(self.sel_a), before_a); self.assertNotEqual(D.content_fingerprint(sel_b), before_b)

    def test_identity_names_no_database_metadata_and_stays_read_only(self):
        fp = D.content_fingerprint(self.sel_a); self.assertEqual(fp[0], "sha256"); self.assertEqual(len(fp[2]), 64)
        st = os.stat(self.fx.db); D.content_fingerprint(self.sel_a); D.load_jsonl(self.sel_a)
        self.assertEqual((st.st_size, st.st_mtime_ns), (os.stat(self.fx.db).st_size, os.stat(self.fx.db).st_mtime_ns))

    def test_reconstruction_is_not_reused_after_a_same_size_change(self):
        vs = O._session_prep(self.sel_a, self.note)[1]; self.assertEqual(vs[0]["content"], "- ships Friday\n")
        self.mutate("ships Friday", "ships Monday")
        vs = O._session_prep(self.sel_a, self.note)[1]; self.assertEqual(vs[0]["content"], "- ships Monday\n")

    def test_source_index_is_not_reused_after_a_same_size_change(self):
        vs, canon, _, _ = versions.versions_of(self.sel_a, self.note)
        c1 = O.context(self.sel_a, canon, vs[0], "prefix", [self.cwd]); self.assertIn("intro request", c1["eligible_source"])
        self.mutate("intro request", "INTRO REQUEST")
        c2 = O.context(self.sel_a, canon, versions.versions_of(self.sel_a, self.note)[0][0], "prefix", [self.cwd]); self.assertIn("INTRO REQUEST", c2["eligible_source"]); self.assertNotIn("intro request", c2["eligible_source"])

    def test_scope_is_not_reused_after_a_same_size_change(self):
        ctx1 = scope.scope_of(self.sel_a)[0]; self.assertIn("intro request", ctx1)
        self.mutate("intro request", "INTRO REQUEST"); ctx2 = scope.scope_of(self.sel_a)[0]; self.assertIn("INTRO REQUEST", ctx2)

    def ns(self):
        return argparse.Namespace(source=self.sel_a, file=self.note, write_id="w1", evaluated_against="prefix", run=None, cwd=self.cwd, location=[], detail=Q, source_quote=Q)

    def test_ledger_resume_sees_a_same_size_change(self):
        doc = L.empty(); extra = {}; obj, code = O.prepare_one(self.ns(), extra); self.assertEqual(code, 0, obj)
        L.add_rows(doc, [L.row_of(self.ns(), obj, extra)])
        self.assertEqual(L.resume(doc, cwd=self.cwd)["obligations"][0]["state"], "valid")
        self.mutate("intro request", "INTRO REQUEST")
        r = L.resume(doc, cwd=self.cwd)["obligations"][0]; self.assertEqual(r["state"], "invalidated"); self.assertTrue(any("evaluated source" in x for x in r["reasons"]))

    def test_identity_and_parsing_of_one_candidate_come_from_one_snapshot(self):
        with D.fingerprint_scope():
            fp = D.content_fingerprint(self.sel_a); self.mutate("intro request", "INTRO REQUEST")
            recs = D.load_jsonl(self.sel_a); self.assertEqual(D.content_fingerprint(self.sel_a), fp)
            self.assertTrue(any("intro request" in json.dumps(r) for r in recs)); self.assertFalse(any("INTRO REQUEST" in json.dumps(r) for r in recs))
        self.assertTrue(any("INTRO REQUEST" in json.dumps(r) for r in D.load_jsonl(self.sel_a)))                    # outside the scope the next candidate reads the stored session again

    def test_records_returned_inside_a_scope_are_independent_copies(self):
        with D.fingerprint_scope():
            r1 = D.load_jsonl(self.sel_a); r1[0]["message"]["content"] = "TAMPERED"; r2 = D.load_jsonl(self.sel_a)
            self.assertNotIn("TAMPERED", json.dumps(r2))

if __name__ == "__main__": unittest.main()

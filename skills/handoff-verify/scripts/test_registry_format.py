#!/usr/bin/env python3
"""Offline regressions of step 1 of the evidence plan: the candidate registry is format v2 (stdlib only, invented documents, no Jev call, never reads .handoff-verify/). v2 adds `evidence_history`, the record of the re-verifications that were authorized for a session; this step only defines,
validates, migrates and protects that record, nothing authorizes yet.
 - Migration: a v1 registry is still read (its candidates, established evaluations and ledgers come out unchanged, `evidence_history` empty) and is written as v2 the next time the registry grows; reading never rewrites the file;
 - Fail closed: any other version, a v2 without a list `evidence_history`, a v1 that already holds one, and any malformed, foreign-id or duplicate entry is refused with a reason, never repaired;
 - Only grows: a save cannot drop an entry, change one, or move its state backwards; the one allowed change is authorized -> recorded;
 - Merge: the registries of several representations of a session are merged with their histories united by request_id; two different entries under one id refuse the merge.
usage: python3 -B test_registry_format.py [-v]"""
import copy, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import audit as A

SRC = "/invented/source-session.jsonl"
KEY = ("toolu_write_1", "a" * 64, "prefix", None)      # an evaluation key: (write id, sha256, mode, run)
CAND = dict(id=A.candidate_id(KEY, "b" * 64), evaluation=A.dict_of(KEY), category=2, detail_sha256="b" * 64, detail="the invented detail", quote_sha256=None)
VREF = A.dict_of(KEY)

def target(stage="verify", jev_ref=None, version_ref=VREF):
    return dict(jev_ref=jev_ref if jev_ref is not None else dict(tool_use_id="toolu_jev_1", result_index=0, key="The invented claim."), version_ref=version_ref, stage=stage)

def entry(state="authorized", input_hash="c" * 64, **kw):
    t = target(**kw); return dict(request_id=A.evidence_request_id(t), target=t, input_hash=input_hash, state=state)

def v1_doc(candidates=(CAND,)):
    """A registry exactly as format v1 wrote it (no evidence_history)."""
    return dict(schema=A.REGISTRY_SCHEMA, version=1, source=SRC, limit=A.LIMIT, established=[A.dict_of(KEY)], ledgers=["/invented/ledger.json"], candidates=list(candidates))

def v2_doc(history=(), candidates=(CAND,)):
    return dict(v1_doc(candidates), version=2, evidence_history=list(history))

class Registry(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory(); self.addCleanup(self._t.cleanup); self.path = os.path.join(self._t.name, "audit-registry-test.json")

    def put(self, doc):
        with open(self.path, "w", encoding="utf-8") as f: json.dump(doc, f)

    def raw(self):
        with open(self.path, encoding="utf-8") as f: return json.load(f)

    def refused(self, doc, fragment=None):
        self.put(doc); loaded, why = A.load_registry(self.path)
        self.assertIsNone(loaded, "must be refused: %r" % (doc.get("evidence_history"),)); self.assertTrue(why)
        if fragment: self.assertIn(fragment, why)

class Format(Registry):
    def test_the_format_is_v2_and_both_versions_are_readable(self):
        self.assertEqual((A.REGISTRY_VERSION, tuple(A.READABLE_VERSIONS)), (2, (1, 2)))

    def test_a_new_registry_is_v2_with_an_empty_history(self):
        d = A.empty_registry(SRC); self.assertEqual((d["version"], d["evidence_history"]), (2, []))

    def test_a_v2_registry_with_history_loads_unchanged(self):
        h = [entry(), entry(stage="gate", state="recorded", input_hash="d" * 64)]; self.put(v2_doc(h)); d, why = A.load_registry(self.path)
        self.assertIsNone(why); self.assertEqual((d["version"], d["evidence_history"], d["candidates"]), (2, h, [CAND]))

    def test_the_request_id_derives_from_the_target_not_from_the_hash_of_the_input(self):
        a, b = entry(input_hash="c" * 64), entry(input_hash="e" * 64)
        self.assertEqual(a["request_id"], b["request_id"]); self.assertEqual(len(a["request_id"]), 16)
        self.assertNotEqual(a["request_id"], entry(stage="gate")["request_id"])
        self.assertNotEqual(a["request_id"], entry(jev_ref=dict(tool_use_id="toolu_jev_2", result_index=0, key="The invented claim."))["request_id"])

    def test_the_request_id_accepts_a_target_without_a_call(self):
        t = dict(jev_ref=None, version_ref=None, stage="audit"); e = dict(request_id=A.evidence_request_id(t), target=t, input_hash="c" * 64, state="authorized")
        self.put(v2_doc([e])); d, why = A.load_registry(self.path); self.assertIsNone(why); self.assertEqual(d["evidence_history"], [e])

class Migration(Registry):
    def test_v1_is_read_as_v2_with_every_part_unchanged(self):
        old = v1_doc(); self.put(old); d, why = A.load_registry(self.path); self.assertIsNone(why)
        self.assertEqual(d["version"], 2); self.assertEqual(d["evidence_history"], [])
        for k in ("schema", "source", "limit", "established", "ledgers", "candidates"): self.assertEqual(d[k], old[k], k)

    def test_reading_never_rewrites_the_file(self):
        old = v1_doc(); self.put(old); A.load_registry(self.path); self.assertEqual(self.raw(), old)

    def test_migrate_registry_is_explicit_and_lossless(self):
        old = v1_doc(); new, why = A.migrate_registry(copy.deepcopy(old)); self.assertIsNone(why)
        self.assertEqual({k: v for k, v in new.items() if k not in ("version", "evidence_history")}, {k: v for k, v in old.items() if k != "version"})
        self.assertEqual((new["version"], new["evidence_history"]), (2, []))
        again, _ = A.migrate_registry(copy.deepcopy(new)); self.assertEqual(again, new)       # v2 passes through unchanged

    def test_migrate_registry_refuses_other_versions(self):
        for v in (0, 3, "2", None, True): new, why = A.migrate_registry(dict(v1_doc(), version=v)); self.assertIsNone(new, v); self.assertTrue(why)

    def test_growing_a_v1_registry_writes_v2_and_keeps_everything(self):
        self.put(v1_doc()); other = ("toolu_write_2", "f" * 64, "session_end", None)
        c, added = A.register(self.path, SRC, other, "a second invented detail"); self.assertTrue(added)
        d = self.raw(); self.assertEqual((d["version"], d["evidence_history"]), (2, []))
        self.assertEqual([x["id"] for x in d["candidates"]], [CAND["id"], c["id"]]); self.assertEqual(d["ledgers"], ["/invented/ledger.json"])
        self.assertEqual(sorted(json.dumps(x, sort_keys=True) for x in d["established"]), sorted(json.dumps(A.dict_of(k), sort_keys=True) for k in (KEY, other)))

class FailClosed(Registry):
    def test_other_versions_are_refused(self):
        for v in (0, 3, "2", None, 2.5, True): self.refused(dict(v2_doc(), version=v))

    def test_v2_needs_a_list_history(self):
        d = v2_doc(); del d["evidence_history"]; self.refused(d, "evidence_history")
        for bad in (None, {}, "x", 0): self.refused(dict(v2_doc(), evidence_history=bad), "evidence_history")

    def test_v1_with_a_history_is_inconsistent(self):
        self.refused(dict(v1_doc(), evidence_history=[]), "evidence_history")

    def test_malformed_entries_are_refused(self):
        good = entry(); cases = {"not a dict": "x", "extra key": dict(good, note="free text"), "missing state": {k: v for k, v in good.items() if k != "state"},
            "missing target": {k: v for k, v in good.items() if k != "target"}, "wrong id": dict(good, request_id="0" * 16), "id of another length": dict(good, request_id=good["request_id"][:8]),
            "short hash": dict(good, input_hash="c" * 63), "non-hex hash": dict(good, input_hash="z" * 64), "upper-case hash": dict(good, input_hash="C" * 64), "unknown state": dict(good, state="done"), "no hash": dict(good, input_hash=None)}
        for name, e in cases.items():
            with self.subTest(name): self.refused(v2_doc([e]))

    def test_a_call_without_a_usable_result_is_a_valid_target_only_with_both_index_and_key_null(self):
        ok = target(jev_ref=dict(tool_use_id="toolu_jev_1", result_index=None, key=None)); e = dict(request_id=A.evidence_request_id(ok), target=ok, input_hash="c" * 64, state="authorized")
        self.put(v2_doc([e])); d, why = A.load_registry(self.path); self.assertIsNone(why); self.assertEqual(d["evidence_history"], [e])
        for name, r in {"index only": dict(tool_use_id="t", result_index=0, key=None), "key only": dict(tool_use_id="t", result_index=None, key="k"), "no call id": dict(tool_use_id="", result_index=None, key=None)}.items():
            with self.subTest(name):
                t = target(jev_ref=r); self.refused(v2_doc([dict(request_id=A.evidence_request_id(t), target=t, input_hash="c" * 64, state="authorized")]))

    def test_malformed_targets_are_refused(self):
        for name, t in {"unknown stage": target(stage="improvised"), "bool index": target(jev_ref=dict(tool_use_id="t", result_index=True, key="k")), "negative index": target(jev_ref=dict(tool_use_id="t", result_index=-1, key="k")),
                "empty tool_use_id": target(jev_ref=dict(tool_use_id="", result_index=0, key="k")), "extra jev_ref key": target(jev_ref=dict(tool_use_id="t", result_index=0, key="k", x=1)),
                "malformed version_ref": target(version_ref=dict(write_tool_use_id="w")), "version_ref of the wrong type": target(version_ref="w")}.items():
            with self.subTest(name):
                e = dict(request_id=A.evidence_request_id(t), target=t, input_hash="c" * 64, state="authorized"); self.refused(v2_doc([e]))     # the id is right for the target, so only the target can be the reason

    def test_a_duplicate_request_id_is_refused(self):
        self.refused(v2_doc([entry(), entry(input_hash="e" * 64)]), "duplicate")

    def test_a_malformed_candidate_still_fails_closed(self):
        self.refused(v2_doc([], candidates=[dict(CAND, id="0" * 16)]))

class OnlyGrows(Registry):
    def saved(self, history): d, _ = A.load_registry(self.path); A.save_registry(self.path, dict(d, evidence_history=history))

    def test_adding_an_entry_is_allowed(self):
        self.put(v2_doc([entry()])); self.saved([entry(), entry(stage="gate")]); self.assertEqual(len(self.raw()["evidence_history"]), 2)

    def test_dropping_an_entry_is_refused(self):
        self.put(v2_doc([entry(), entry(stage="gate")]))
        with self.assertRaises(ValueError): self.saved([entry()])
        with self.assertRaises(ValueError): self.saved([])
        self.assertEqual(len(self.raw()["evidence_history"]), 2)

    def test_changing_an_entry_is_refused(self):
        self.put(v2_doc([entry()]))
        with self.assertRaises(ValueError): self.saved([entry(input_hash="e" * 64)])

    def test_authorized_becomes_recorded_and_never_goes_back(self):
        self.put(v2_doc([entry()])); self.saved([entry(state="recorded")]); self.assertEqual(self.raw()["evidence_history"][0]["state"], "recorded")
        with self.assertRaises(ValueError): self.saved([entry(state="authorized")])

    def test_a_save_that_adds_a_malformed_entry_is_refused(self):
        self.put(v2_doc([entry()]))
        with self.assertRaises(ValueError): self.saved([entry(), dict(entry(stage="gate"), state="done")])

    def test_a_v1_file_may_be_saved_only_with_an_empty_or_valid_history(self):
        self.put(v1_doc()); self.saved([entry()]); self.assertEqual(self.raw()["version"], 2)

class Merge(unittest.TestCase):
    def test_the_histories_of_the_representations_are_united_by_request_id(self):
        a, b = entry(), entry(stage="gate"); merged, why = A.merge_registries([v2_doc([a]), v2_doc([a, b])], SRC)
        self.assertIsNone(why); self.assertEqual([e["request_id"] for e in merged["evidence_history"]], [a["request_id"], b["request_id"]])

    def test_a_v1_registry_merges_with_a_v2_one(self):
        a = entry(); merged, why = A.merge_registries([A.migrate_registry(v1_doc())[0], v2_doc([a])], SRC)
        self.assertIsNone(why); self.assertEqual(merged["evidence_history"], [a]); self.assertEqual(len(merged["candidates"]), 1)

    def test_two_entries_under_one_id_refuse_the_merge(self):
        merged, why = A.merge_registries([v2_doc([entry(input_hash="c" * 64)]), v2_doc([entry(input_hash="e" * 64)])], SRC)
        self.assertIsNone(merged); self.assertIn("evidence_history", why)

    def test_the_more_advanced_state_of_the_same_entry_wins(self):
        merged, why = A.merge_registries([v2_doc([entry()]), v2_doc([entry(state="recorded")])], SRC)
        self.assertIsNone(why); self.assertEqual([e["state"] for e in merged["evidence_history"]], ["recorded"])

    def test_the_merge_keeps_candidates_established_and_ledgers_as_before(self):
        merged, _ = A.merge_registries([v2_doc(), v2_doc()], SRC)
        self.assertEqual((len(merged["candidates"]), len(merged["established"]), merged["ledgers"]), (1, 1, ["/invented/ledger.json"]))

if __name__ == "__main__": unittest.main()

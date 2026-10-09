#!/usr/bin/env python3
"""Offline regressions of the council correction on canonical-material reuse (stdlib + git, no Jev call): the canonical material of a note version is constructed ONCE for an unchanged multi-candidate batch, after the
ordered references have been re-resolved, re-checked (exclusions, availability) and re-read on every call; a changed reference content (same size and mtime), a retargeted symlink, a competing tracked name or a
missing reference changes what is constructed, and a restored availability gives the very same material again; callers get independent copies; `reset_caches` forgets every cache of a run.
Counts only: read from `omissions.STATS`.
usage: python3 -B test_material_reuse.py [-v]"""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions as O, refs, scope, versions
from test_candidate_hints import Base, write

Q1, Q2, Q3 = "Never run migrate.sh against prod.", "Do NOT change the public API.", "Rotate keys on Friday."

def same_size_edit(path, old, new):
    st = os.stat(path); data = open(path, "rb").read().replace(old.encode(), new.encode()); assert len(old) == len(new)
    open(path, "wb").write(data); os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))

class Reuse(Base):
    NOTE_TEXT = "- see `ref.md` for the plan\n"

    def setUp(self):
        super().setUp(); write(os.path.join(self.d, "ref.md"), "the plan is AAAA\n")
        self.build([Q1, Q2, Q3])

    def batch(self):
        return [self.prep(q, q) for q in (Q1, Q2, Q3)]

    def test_one_construction_for_an_unchanged_multi_candidate_batch(self):
        outs = self.batch(); self.assertTrue(all(c == 0 for _, c in outs), outs)
        self.assertEqual(O.STATS["material_builds"], 1); self.assertEqual(O.STATS["material_hits"], 2)
        self.assertEqual(len({o["material"] for o, _ in outs}), 1)

    def test_warm_output_is_byte_identical_to_the_cold_output(self):
        warm = json.dumps(self.batch(), sort_keys=True)
        cold = []
        for q in (Q1, Q2, Q3): O.reset_caches(); cold.append(self.prep(q, q))
        self.assertEqual(warm, json.dumps(cold, sort_keys=True))

    def test_reference_content_changed_with_same_size_and_mtime_is_constructed_again(self):
        o1 = self.prep(Q1, Q1)[0]; same_size_edit(os.path.join(self.d, "ref.md"), "AAAA", "BBBB"); o2 = self.prep(Q2, Q2)[0]
        self.assertEqual(O.STATS["material_builds"], 2); self.assertIn("AAAA", o1["material"]); self.assertIn("BBBB", o2["material"]); self.assertNotIn("AAAA", o2["material"])
        self.assertNotEqual(o1["material_manifest"][0]["sha256"], o2["material_manifest"][0]["sha256"])

    def test_retargeted_symlink_is_constructed_again(self):
        write(os.path.join(self.d, "a.md"), "same size 1\n"); write(os.path.join(self.d, "b.md"), "same size 2\n"); link = os.path.join(self.d, "ref.md"); os.remove(link); os.symlink(os.path.join(self.d, "a.md"), link)
        o1 = self.prep(Q1, Q1)[0]; os.remove(link); os.symlink(os.path.join(self.d, "b.md"), link); o2 = self.prep(Q2, Q2)[0]
        self.assertEqual(O.STATS["material_builds"], 2); self.assertIn("same size 1", o1["material"]); self.assertIn("same size 2", o2["material"])
        self.assertTrue(o1["material_manifest"][0]["path"].endswith("a.md")); self.assertTrue(o2["material_manifest"][0]["path"].endswith("b.md"))

    def test_missing_reference_blocks_and_restored_availability_gives_the_same_material(self):
        o1 = self.prep(Q1, Q1)[0]; ref = os.path.join(self.d, "ref.md"); text = open(ref).read(); os.remove(ref)
        o2, code = self.prep(Q2, Q2); self.assertEqual(code, 3); self.assertIn("missing_reference", o2)
        write(ref, text); o3, code = self.prep(Q3, Q3); self.assertEqual(code, 0)
        self.assertEqual(o3["material"], o1["material"]); self.assertEqual(o3["material_manifest"], o1["material_manifest"]); self.assertEqual(O.STATS["material_builds"], 1)    # the restored bytes are the very same identity

    def test_excluded_reference_is_rechecked_on_every_call(self):
        o1 = self.prep(Q1, Q1)[0]; self.assertIn("plan is AAAA", o1["material"])
        os.remove(os.path.join(self.d, "ref.md")); write(os.path.join(self.d, ".env.md"), "SECRET\n"); os.symlink(os.path.join(self.d, ".env.md"), os.path.join(self.d, "ref.md"))
        o2, code = self.prep(Q2, Q2); self.assertEqual(code, 3); self.assertEqual(o2["missing_reference"]["kind"], "excluded"); self.assertNotIn("SECRET", json.dumps(o2))

    def test_results_are_independent_copies(self):
        vs, canon, _, _ = versions.versions_of(self.log, self.note)
        c1 = O.context(self.log, canon, vs[0], "prefix", [self.d]); c1["manifest"][0]["ref"] = "TAMPERED"; c1["references"].append(("x", "y")); c1["manifest"].append({})
        c2 = O.context(self.log, canon, vs[0], "prefix", [self.d]); self.assertEqual(c2["manifest"][0]["ref"], "ref.md"); self.assertEqual(len(c2["manifest"]), 1); self.assertEqual(len(c2["references"]), 1)
        self.assertEqual(O.STATS["material_builds"], 1)
        b1 = O.build_material_ex(self.NOTE_TEXT, [self.d]); b1[1][0]["ref"] = "TAMPERED"; b2 = O.build_material_ex(self.NOTE_TEXT, [self.d]); self.assertEqual(b2[1][0]["ref"], "ref.md")

class Tracked(Base):
    NOTE_TEXT = "- see `plan.md` for the plan\n"

    def git(self, *a): return subprocess.run(["git", "-C", self.d] + list(a), capture_output=True, text=True, env=dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null"))

    def test_competing_tracked_names_appear_and_disappear(self):
        self.assertEqual(self.git("init", "-q").returncode, 0)
        write(os.path.join(self.d, "docs", "plan.md"), "the one plan\n"); self.build([Q1, Q2, Q3]); self.git("add", "docs/plan.md")
        o1, c1 = self.prep(Q1, Q1); self.assertEqual(c1, 0, o1); self.assertEqual(o1["material_manifest"][0]["resolution"], "unique_tracked_name")
        write(os.path.join(self.d, "other", "plan.md"), "a competing plan\n"); self.git("add", "other/plan.md")
        o2, c2 = self.prep(Q2, Q2); self.assertEqual(c2, 3); self.assertIn("2 tracked files", json.dumps(o2["missing_reference"]))
        self.git("rm", "-q", "--cached", "other/plan.md")
        o3, c3 = self.prep(Q3, Q3); self.assertEqual(c3, 0, o3); self.assertEqual(o3["material"], o1["material"])

class Resetting(Base):
    def test_reset_caches_clears_every_cache_it_promises_to_reset(self):
        versions._STREAMS["k"] = {"x"}; refs._TRACKED_CACHE["r"] = ("i", []); scope._MEMO["m"] = (None, [], "why"); O._MAT["m"] = ("m", [], [])
        O._PREP["p"] = 1; O._SRC["s"] = 1; O._MEMO["x"] = 1; O._CLEAN["c"] = "c"; O.STATS["material_builds"] += 1
        O.reset_caches()
        self.assertEqual((versions._STREAMS, refs._TRACKED_CACHE, scope._MEMO, O._MAT, O._PREP, O._SRC, O._MEMO, O._CLEAN, dict(O.STATS)), ({}, {}, {}, {}, {}, {}, {}, {}, {}))

if __name__ == "__main__": unittest.main()

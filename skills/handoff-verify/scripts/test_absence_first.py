#!/usr/bin/env python3
"""Offline test of the absence-first scheduling of omission checks (stdlib only, no Jev call, never reads .handoff-verify/): after `omissions.py prepare` the ABSENCE call goes first and the SOURCE call is
requested only for a bound, error-free `unsupported` > 0.95 with an explicit `auto` (omissions.plan_absence); SOURCE claims that share exactly one eligible passage of one write can share one call
(omissions.plan_source) and each pair is still validated on its own by jevref. The planners return scheduling dispositions, never a status.
usage: python3 -B test_absence_first.py [-v]"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import jevref, omissions

ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
SKILL_MD = os.path.join(os.path.dirname(HERE), "SKILL.md")

def out(**kw):
    """A recorded ABSENCE result, bound, error-free, with a demonstrated version and complete material, unless a key says otherwise."""
    return dict(dict(bound=True, error=False, verdict="unsupported", confidence=0.98, action="auto", aux_ok=True, version_ok=True, material_complete=True), **kw)

def item(detail, passage="P1", wid="w0", sha="a" * 64, ev="prefix", source="s.jsonl", file="HANDOFF.md", **kw):
    return dict(absence=out(**kw), source_claim=omissions.SOURCE_PREFIX + detail, source_passage=passage, source=source, file=file,
                version_ref=dict(write_tool_use_id=wid, sha256=sha, evaluated_against=ev))

class PlanAbsence(unittest.TestCase):
    def test_the_first_step_is_the_absence_call_and_never_a_source_call(self):
        p = omissions.plan_absence(None)
        self.assertEqual((p["disposition"], p["source"]), ("call_absence", False))

    def test_resolved_present_or_contradicted_schedules_no_source_and_no_finding(self):
        for verdict in ("verified", "contradicted"):
            p = omissions.plan_absence(out(verdict=verdict, confidence=0.99))
            self.assertEqual((p["disposition"], p["source"], p["finding"]), ("present_resolved", False, False), verdict)

    def test_unresolved_present_or_contradicted_stays_unresolved_not_cleared(self):
        for verdict in ("verified", "contradicted"):
            for kw in (dict(confidence=0.9), dict(confidence=0.95), dict(aux_ok=False), dict(action="review", aux_ok=False), dict(confidence=None)):
                p = omissions.plan_absence(out(verdict=verdict, **kw))
                self.assertEqual((p["disposition"], p["source"]), ("unresolved", False), (verdict, kw))

    def test_only_a_qualifying_unsupported_requests_source(self):
        self.assertEqual(omissions.plan_absence(out())["disposition"], "request_source")
        self.assertTrue(omissions.plan_absence(out())["source"])
        self.assertFalse(omissions.plan_absence(out())["finding"])   # a qualifying unsupported alone confirms nothing
        for kw in (dict(confidence=0.95), dict(confidence=0.9), dict(action="review"), dict(action=None), dict(confidence=None), dict(verdict="other"), dict(verdict=None)):
            p = omissions.plan_absence(out(**kw))
            self.assertEqual((p["disposition"], p["source"]), ("unresolved", False), kw)

    def test_error_unbound_invalid_version_and_incomplete_material_stay_unresolved(self):
        for kw in (dict(error=True), dict(bound=False), dict(version_ok=False), dict(material_complete=False)):
            p = omissions.plan_absence(out(**kw))
            self.assertEqual((p["disposition"], p["source"]), ("unresolved", False), kw)
        self.assertEqual(omissions.plan_absence({})["disposition"], "unresolved")   # nothing demonstrated: never a SOURCE call

    def test_transport_error_allows_one_identical_retry_only(self):
        self.assertEqual(omissions.plan_absence(out(error=True, error_kind="transport"))["disposition"], "retry_identical")
        self.assertEqual(omissions.plan_absence(out(error=True, error_kind="invalid_response", attempts_identical=0))["disposition"], "retry_identical")
        self.assertEqual(omissions.plan_absence(out(error=True, error_kind="transport", attempts_identical=1))["disposition"], "unresolved")
        self.assertEqual(omissions.plan_absence(out(error=True, error_kind="timeout"))["disposition"], "unresolved")

    def test_the_planner_returns_dispositions_not_statuses(self):
        for o in (None, out(), out(verdict="verified"), out(error=True)):
            self.assertNotIn(omissions.plan_absence(o)["disposition"], ("PASS", "FAIL", "UNRESOLVED"))

    def test_a_qualifying_unsupported_cannot_confirm_without_the_source_check(self):
        a = dict(id="a", bound=True, resolved=False, real_verdict="unsupported", real_confidence=0.99, real_action="auto", tool="verify", check_error=False, claim_key="X")
        f = dict(type="lost_detail", check_id="a", confidence=0.99, claim="X", omission_ref=dict(detail="X", source_check_id="missing"), quote_source="X", quote_handoff=None)
        ok, why = jevref.validate_finding(f, {"a": a}, None, "R04")
        self.assertFalse(ok); self.assertIn("source_check_id", why)

class PlanSource(unittest.TestCase):
    def test_claims_sharing_one_passage_and_write_share_one_call(self):
        p = omissions.plan_source([item("A"), item("B")])
        self.assertEqual(p["planned_source_calls"], 1)
        g = p["groups"][0]
        self.assertEqual(g["claims"], [omissions.SOURCE_PREFIX + "A", omissions.SOURCE_PREFIX + "B"]); self.assertEqual(g["passage"], "P1"); self.assertEqual(g["items"], [0, 1])
        self.assertEqual([(d["disposition"], d["group"], d["claim_index"]) for d in p["dispositions"]], [("request_source", 0, 0), ("request_source", 0, 1)])

    def test_different_passage_write_hash_evaluation_file_or_source_never_merge(self):
        for kw in (dict(passage="P2"), dict(wid="w1"), dict(sha="b" * 64), dict(ev="session_end"), dict(file="OTHER.md"), dict(source="t.jsonl")):
            p = omissions.plan_source([item("A"), item("B", **kw)])
            self.assertEqual(p["planned_source_calls"], 2, kw)
            self.assertEqual([len(g["claims"]) for g in p["groups"]], [1, 1], kw)

    def test_identity_that_is_missing_is_never_merged(self):
        a, b = item("A"), item("B"); del a["source"]; del b["source"]
        self.assertEqual(omissions.plan_source([a, b])["planned_source_calls"], 2)

    def test_only_candidates_whose_absence_requests_source_are_planned(self):
        p = omissions.plan_source([item("A"), item("B", verdict="verified"), item("C", confidence=0.9), item("D", action="review"), item("E", error=True), item("F")])
        self.assertEqual(p["planned_source_calls"], 1); self.assertEqual(p["groups"][0]["items"], [0, 5])
        self.assertEqual([d["disposition"] for d in p["dispositions"]], ["request_source", "no_source", "unresolved", "unresolved", "unresolved", "request_source"])

    def test_the_same_claim_twice_is_one_claim_of_the_call(self):
        p = omissions.plan_source([item("A"), item("A")])
        self.assertEqual(p["groups"][0]["claims"], [omissions.SOURCE_PREFIX + "A"]); self.assertEqual([d["claim_index"] for d in p["dispositions"]], [0, 0])

    def test_nothing_to_plan(self):
        self.assertEqual(omissions.plan_source([]), dict(dispositions=[], groups=[], planned_source_calls=0))

class SharedPassagePairs(unittest.TestCase):
    """One SOURCE call with two canonical claims over one eligible passage: each pair validates on its own (individually bound result indices)."""
    PASSAGE = "Goal: ship it. Do NOT change the public API. Never run migrate.sh against prod."
    VER = dict(ok=True, write_tool_use_id="w0", sha256="a" * 64, evaluated_against="prefix")

    def binding(self, cid, claim, verdict, conf, action, evidence):
        return dict(id=cid, bound=True, resolved=verdict == "verified", real_verdict=verdict, real_confidence=conf, real_action=action, tool="verify", check_error=False, claim_key=claim,
                    version=dict(self.VER), eligible_blocks=[self.PASSAGE, "other record"], call_evidence_raw=evidence, omission_material="MAT", omission_material_reason=None)

    def bindings(self, source_evidence=None):
        sev = [self.PASSAGE] if source_evidence is None else source_evidence
        by = {}
        for k, d in enumerate(("Do NOT change the public API.", "Never run migrate.sh against prod.")):
            sc, ac = omissions.claims(d, "R04")
            by["s%d" % k] = self.binding("s%d" % k, sc, "verified", 0.99, "auto", sev)   # same call, result_index k
            by["a%d" % k] = self.binding("a%d" % k, ac, "unsupported", 0.98, "auto", ["MAT"])
        return by

    def finding(self, k):
        d = ("Do NOT change the public API.", "Never run migrate.sh against prod.")[k]
        return dict(type="lost_detail", check_id="a%d" % k, confidence=0.98, claim=omissions.claims(d, "R04")[1], omission_ref=dict(detail=d, source_check_id="s%d" % k), quote_source=d, quote_handoff=None)

    def test_each_pair_confirms_on_its_own(self):
        by = self.bindings()
        for k in (0, 1): self.assertEqual(jevref._validate_omission(self.finding(k), by["a%d" % k], by, "R04"), (True, "confirmed"), k)

    def test_a_pair_is_refused_when_its_own_source_evidence_is_not_the_passage(self):
        by = self.bindings(source_evidence=[self.PASSAGE, " extra"])
        for k in (0, 1): self.assertFalse(jevref._validate_omission(self.finding(k), by["a%d" % k], by, "R04")[0])

    def test_one_failing_pair_does_not_spoil_the_other(self):
        by = self.bindings(); by["a1"] = dict(by["a1"], real_verdict="verified")
        self.assertTrue(jevref._validate_omission(self.finding(0), by["a0"], by, "R04")[0])
        self.assertFalse(jevref._validate_omission(self.finding(1), by["a1"], by, "R04")[0])

class PreparedInstructions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(); d = cls.dir = os.path.realpath(cls.tmp.name)
        text = "- Goal: ship the billing migration by Friday.\n"; path = os.path.join(d, "HANDOFF.md"); open(path, "w", encoding="utf-8").write(text)
        recs = [dict(type="user", uuid="u1", timestamp="2026-01-01T00:00:00Z", cwd=d, sessionId="s1", message=dict(role="user", content="Do NOT change the public API of billing.")),
                dict(type="assistant", uuid="a1", timestamp="2026-01-01T00:00:01Z", cwd=d, sessionId="s1", message=dict(role="assistant", content=[dict(type="tool_use", id="w0", name="Write", input=dict(file_path=path, content=text))])),
                dict(type="user", uuid="r1", timestamp="2026-01-01T00:00:02Z", cwd=d, sessionId="s1", message=dict(role="user", content=[dict(type="tool_result", tool_use_id="w0", content="File created successfully at: " + path)]))]
        open(os.path.join(d, "session.jsonl"), "w", encoding="utf-8").write("".join(json.dumps(r) + "\n" for r in recs))
        q = "Do NOT change the public API of billing."
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "omissions.py"), "prepare", "--source", "session.jsonl", "--file", "HANDOFF.md", "--write-id", "w0", "--evaluated-against", "prefix", "--detail", q, "--source-quote", q],
                           cwd=d, capture_output=True, text=True, env=ENV)
        cls.code, cls.obj, cls.text = p.returncode, json.loads(p.stdout), text

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def test_prepare_still_prints_the_same_values_and_the_byte_identical_material(self):
        o = self.obj
        self.assertEqual(self.code, 0); self.assertTrue(o["ok"])
        self.assertEqual(o["material"], omissions.material(self.text)); self.assertEqual(o["absence_claim"], o["detail"])
        self.assertEqual(o["source_claim"], omissions.SOURCE_PREFIX + o["detail"])
        self.assertEqual(sorted(o), sorted(["ok", "contract", "work_locations", "detail", "source_claim", "absence_claim", "source_passage", "material", "material_manifest", "version_ref", "handoff_source_path", "omission_ref_template", "note"]))

    def test_the_printed_note_schedules_absence_first_and_source_conditionally(self):
        n = self.obj["note"]
        self.assertLess(n.index("ABSENCE"), n.index("SOURCE")); self.assertIn("only if", n)
        for must in ("unsupported", "0.95", "auto", "UNRESOLVED", "verified or contradicted", "NO finding"): self.assertIn(must, n)
        self.assertNotIn("twice", n)

class SkillText(unittest.TestCase):
    def test_skill_md_describes_the_absence_first_order(self):
        t = open(SKILL_MD, encoding="utf-8").read()
        self.assertIn("ABSENCE-first", t)
        for must in ("plan_absence", "plan_source", "never combine", "no SOURCE call"): self.assertIn(must, t)
        self.assertNotIn("Make the two `jev_verify` calls it describes", t)
        self.assertNotIn("Then call `jev_verify` twice", t)

if __name__ == "__main__": unittest.main()

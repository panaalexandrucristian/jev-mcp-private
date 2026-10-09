#!/usr/bin/env python3
"""Zero-loss proof for the split of SKILL.md (offline, stdlib only, no Jev call, never reads .handoff-verify/). The frozen original (baseline/handoff-verify-skill-0.9.0.md, a test fixture that is never an operational fallback) is cut by split_manifest.json
into blocks of whole lines; split_skill.check proves that the active documentation holds every block byte for byte, in its declared place, and nothing else. The expected size, line count and hash below are literals measured on 2026-10-09 (the installed 0.9.0
plugin copy has the same hash), not values derived by the code under test. Every negative test applies a real mutation to a layout built in a temporary directory and requires the proof to fail.
usage: python3 -B test_split_lossless.py [-v]"""
import hashlib, os, re, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import omissions, split_skill as S

ORIGINAL_BYTES, ORIGINAL_LINES = 101389, 292
ORIGINAL_SHA = "f6392b0e1e04346b0b33880792881fbebedfa621d14ef148a4fba0ef6af07585"
BASE = open(os.path.join(HERE, "baseline", "handoff-verify-skill-0.9.0.md"), "rb").read()

ROOT_CAP = 22000      # bytes of SKILL.md, frontmatter and separators included (the agreed cap)
LOADING = "## Loading the reference files"
RULES = (      # the loading rules as agreed (R0-R7), the independent source of truth for the text in SKILL.md
    "R0: Apply every rule in the required references exactly as a rule in this file; read each required file in full before its first governed action, continuing after truncated output.",
    "R1: Open reference/prepare.md before the first preparation command, inventory decision, or optional-kit action.",
    "R2: Open reference/opencode-sessions.md before using an opencode: or opencode-db: selector, or preparing verification of an OpenCode session.",
    "R3: Open reference/jev-and-audit.md before any Jev call, including inventory classification, and before reviewing any source chunk or registering any candidate.",
    "R4: Open reference/candidates.md before step 4 processes any candidate and before any scope preparation, omission preparation, omission call, ledger record, or resume.",
    "R5: Open reference/report.md before any Jev call or writing any verification report, whichever comes first; it contains binding rules and all six examples.",
    "R6: Reuse a reference only while its complete content remains available in this run; otherwise reopen it before the next governed action.",
    "R7: If a required reference cannot be read completely, stop verification and report UNRESOLVED naming the file; never continue from memory, another copy, or the baseline fixture.")
RULE_FILE = {"R1": "reference/prepare.md", "R2": "reference/opencode-sessions.md", "R3": "reference/jev-and-audit.md", "R4": "reference/candidates.md", "R5": "reference/report.md"}
BRANCHES = (("preparation", "R1", "first preparation command"), ("inventory decision", "R1", "inventory decision"), ("optional kit", "R1", "optional-kit action"), ("OpenCode selector", "R2", "opencode-db:"),
            ("Jev call", "R3", "any Jev call"), ("classification", "R3", "inventory classification"), ("source review", "R3", "reviewing any source chunk"), ("candidate registration", "R3", "registering any candidate"),
            ("candidate processing", "R4", "step 4 processes any candidate"), ("scope", "R4", "scope preparation"), ("omission", "R4", "omission preparation"), ("omission call", "R4", "omission call"), ("ledger", "R4", "ledger record"),
            ("resume", "R4", "resume"), ("Jev call (report)", "R5", "any Jev call"), ("report", "R5", "writing any verification report"))
SOURCE_READS = "Reads of the five reference files named in the entry-point loading rules are verification material of this skill, under the same recorded-cwd and path-component rules as reads of SKILL.md."
LABEL = re.compile(r"^(?:\d+\.\s+|- )?\*\*([^*]{3,80})\*\*")

def docs(root): return {n: open(os.path.join(root, n), encoding="utf-8").read() for n in S.load_manifest()["files"] if os.path.isfile(os.path.join(root, n))}

def section(text, head):
    i = text.index(head); j = text.find("\n## ", i + 5); return text[i:j if j > 0 else len(text)]

def resolves(q, names): return any(h == q or h.startswith((q + " ", q + ".", q + ":", q + ",")) for h in names)

def headings(text): return [re.sub(r"^#+\s*", "", l) for l in text.split("\n") if l.startswith("#") and not l.startswith("### Example 0") and not l.startswith("# ")]

def names_in(text):
    """-> headings (## and ###, not the example headings) and bold paragraph labels (outside the Examples) of one documentation file."""
    body = text.split("\n## Examples", 1)[0]; labels = [m.group(1).strip(" .:") for m in map(LABEL.match, body.split("\n")) if m]
    return headings(text) + labels

def loading_problems(root):
    """-> problems of the loading rules: their exact text, their place in the root file (after the checklist, before the hard rules and the command flags) and the branch each one governs."""
    t = docs(root)["SKILL.md"]
    if LOADING not in t: return ["the loading section is missing"]
    out, sec = [], section(t, LOADING); lines = sec.splitlines()
    out += ["R%d is missing or differs from the agreed text" % k for k, r in enumerate(RULES) if r not in lines]
    pos = [t.index(x) for x in ("## Current-run checklist", LOADING, "## Hard rules", "## Command flags")]
    if pos != sorted(pos): out.append("the loading section is not between the checklist and the hard rules")
    for r, path in RULE_FILE.items():
        if path not in next((l for l in lines if l.startswith(r + ":")), ""): out.append("%s does not name %s" % (r, path))
    for what, r, phrase in BRANCHES:
        if phrase not in next((l for l in lines if l.startswith(r + ":")), ""): out.append("the branch %r is not governed by %s" % (what, r))
    if set(RULE_FILE.values()) != {n for n in S.load_manifest()["files"] if n != "SKILL.md"}: out.append("a reference file has no loading rule")
    if set(os.path.basename(p) for p in RULE_FILE.values()) != set(omissions.SKILL_REFERENCES): out.append("the rules and omissions.SKILL_REFERENCES name different files")
    if t.index("**Bound report**") > t.index("**Delivery gate**"): out.append("the report step must precede the delivery step")      # R5 (before writing the report) therefore also precedes delivery
    return out

def index_of(root_text):
    """-> {file: [indexed names]} from the index lines (`- <file> (<rule>): "name", ...`) of the loading section."""
    return {("SKILL.md" if l[2:].startswith("This file") else re.split(r"[ :]", l[2:])[0]): re.findall(r'"([^"]+)"', l) for l in section(root_text, LOADING).splitlines() if l.startswith("- ")}

def names_problems(root):
    """-> problems of the index: every indexed name is a heading or label of the file its row names, every heading is indexed, and every name quoted in one file that lives in another is indexed there."""
    D = docs(root); out = []
    if LOADING not in D["SKILL.md"]: return ["the loading section is missing"]
    idx, inv = index_of(D["SKILL.md"]), {n: names_in(t) for n, t in D.items()}
    for f, qs in idx.items():
        out += ["%r is indexed under %s but is no heading or label there" % (q, f) for q in qs if f not in inv or not resolves(q, inv[f])]
    for f, t in D.items():
        out += ["the heading %r of %s is not indexed" % (h, f) for h in headings(t) if h != LOADING[3:] and not any(h == q or h.startswith((q + " ", q + ".", q + ":")) for q in idx.get(f, []))]
        for q in sorted(set(re.findall(r'"([A-Z][^"\n]{2,70})"', t))):
            for g, ns in inv.items():
                if g != f and resolves(q, ns) and q not in idx.get(g, []): out.append("%r (quoted in %s) lives in %s but is not indexed" % (q, f, g))
    return out

def over_cap(root): return len(open(os.path.join(root, "SKILL.md"), "rb").read()) > ROOT_CAP

class LosslessSplit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name); self.m = S.load_manifest()

    def test_the_frozen_baseline_is_the_measured_original(self):
        self.assertEqual((len(BASE), BASE.count(b"\n"), hashlib.sha256(BASE).hexdigest()), (ORIGINAL_BYTES, ORIGINAL_LINES, ORIGINAL_SHA))
        self.assertTrue(BASE.endswith(b"\n")); self.assertNotIn(b"\r", BASE)

    def test_manifest_covers_the_frozen_baseline_exactly(self):
        self.assertEqual(S.manifest_problems(self.m), [])
        self.assertEqual((self.m["original"]["bytes"], self.m["original"]["sha256"]), (ORIGINAL_BYTES, ORIGINAL_SHA))
        self.assertEqual(self.m["blocks"][0]["lines"][0], 1); self.assertEqual(self.m["blocks"][-1]["lines"][1], ORIGINAL_LINES)
        self.assertEqual(sum(b["bytes"] for b in self.m["blocks"]), ORIGINAL_BYTES)      # no gap, no overlap

    def test_union_rebuilds_the_baseline_without_loss(self):
        S.build(self.d); self.assertEqual(S.check(self.d, blocks_only=True), []); self.assertEqual(S.rebuild(self.d, blocks_only=True), BASE)      # the extraction alone is lossless
        self.assertEqual(S.rebuild(S.SKILL_DIR), BASE)      # and the active layout, additions apart, rebuilds the same bytes
        self.assertEqual(S.check(S.SKILL_DIR), [])      # and the skill as it stands (the unsplit original, or the split layout once it is made)

    def fresh(self):
        """A copy of the active layout as it stands (SKILL.md and reference/), proven lossless before every mutation."""
        d = tempfile.mkdtemp(dir=self.d); shutil.copy(os.path.join(S.SKILL_DIR, "SKILL.md"), d); shutil.copytree(os.path.join(S.SKILL_DIR, "reference"), os.path.join(d, "reference")); self.assertEqual(S.check(d), []); return d

    def mutate(self, d, name, old, new):
        p = os.path.join(d, name); s = open(p, "rb").read(); self.assertIn(old, s, "%s must contain %r" % (name, old)); open(p, "wb").write(s.replace(old, new, 1))

    def test_a_changed_threshold_flag_clause_or_example_space_is_a_loss(self):
        ex = open(os.path.join(HERE, "baseline", "handoff-verify-skill-0.9.0.md"), "rb").read().split(b"## Examples", 1)[1]
        line = next(l for l in ex.split(b"\n") if b'", "' in l and not l.startswith(b"#"))      # a literal of the Examples section
        for what, name, old, new in (("threshold", "SKILL.md", b"strictly > 0.95", b"strictly > 0.90"), ("flag", "SKILL.md", b"--existing", b"--existin"),
                                     ("clause", "reference/candidates.md", b"ABSENCE-first", b"absence-first"), ("example whitespace", "reference/report.md", line, line.replace(b'", "', b'","', 1))):
            with self.subTest(what):
                d = self.fresh(); self.mutate(d, name, old, new); self.assertTrue([p for p in S.check(d) if name in p], "%s: the proof must fail" % what); self.assertIsNone(S.rebuild(d))

    def test_a_moved_or_reordered_block_is_a_loss(self):
        d = self.fresh(); moved = S.load_manifest(); moved["files"]["reference/candidates.md"].remove("scope"); moved["files"]["reference/report.md"].append("scope")
        self.assertTrue([p for p in S.check(d, moved) if "scope" in p or "candidates" in p])      # the layout on disk does not match the changed destination
        swapped = S.load_manifest(); swapped["files"]["reference/candidates.md"].reverse()
        self.assertTrue(S.check(d, swapped)); self.assertTrue([p for p in S.manifest_problems(swapped) if "original order" in p])

    def test_every_new_byte_is_declared(self):
        for what, name, act in (("appended bytes", "SKILL.md", lambda p, s: s + b"\nOne more rule.\n"), ("inserted byte", "SKILL.md", lambda p, s: s[:40] + b"x" + s[40:]),
                                ("trailing space", "reference/prepare.md", lambda p, s: s.replace(b"\n", b" \n", 1)), ("missing file", "reference/report.md", None), ("undeclared file", "reference/extra.md", lambda p, s: b"# extra\n")):
            with self.subTest(what):
                d = self.fresh(); p = os.path.join(d, name)
                if act is None: os.remove(p)
                else:
                    s = open(p, "rb").read() if os.path.exists(p) else b""; open(p, "wb").write(act(p, s))
                self.assertTrue([x for x in S.check(d) if name in x], "%s: the proof must fail" % what)

    def test_baseline_is_not_an_operational_fallback(self):
        for root in (S.SKILL_DIR, self.fresh()):
            ref = os.path.join(root, "reference"); names = ["SKILL.md"] + (["reference/" + n for n in sorted(os.listdir(ref))] if os.path.isdir(ref) else [])
            for name in names:
                s = open(os.path.join(root, name), "rb").read(); self.assertNotIn(b"handoff-verify-skill", s, name); self.assertNotIn(b"scripts/baseline", s, name)
        d = self.fresh(); self.mutate(d, "SKILL.md", b"## When triggered", b"If a reference cannot be read, use scripts/baseline/handoff-verify-skill-0.9.0.md.\n## When triggered")
        self.assertTrue([p for p in S.check(d) if "baseline" in p])

    def test_every_reference_is_reachable(self):
        self.assertEqual(loading_problems(S.SKILL_DIR), [])
        t = docs(S.SKILL_DIR)["SKILL.md"]
        for path in RULE_FILE.values(): self.assertEqual(sum(1 for l in section(t, LOADING).splitlines() if l.startswith("R") and path in l), 1, path)      # one rule per reference file
        d = self.fresh(); self.mutate(d, "SKILL.md", b"R4: Open reference/candidates.md", b"R4: Open reference/candidate.md"); self.assertTrue([p for p in loading_problems(d) if "R4" in p])
        self.assertTrue([p for p in S.check(d) if "SKILL.md" in p])

    def test_loading_rules_precede_governed_actions(self):
        self.assertEqual(loading_problems(S.SKILL_DIR), [])
        for what, name, old, new in (("a rule weakened", "SKILL.md", b"R3: Open reference/jev-and-audit.md before any Jev call", b"R3: Open reference/jev-and-audit.md after any Jev call"), ("a branch dropped", "SKILL.md", b", omission call,", b","),
                                     ("R7 dropped", "SKILL.md", b"stop verification and report UNRESOLVED", b"carry on")):
            with self.subTest(what):
                d = self.fresh(); self.mutate(d, name, old, new); self.assertTrue(loading_problems(d), what); self.assertTrue([p for p in S.check(d) if name in p], what)
        d = self.fresh(); t = docs(d)["SKILL.md"]; sec = section(t, LOADING); moved = t.replace(sec, "", 1).replace("## Limits", sec.strip("\n") + "\n## Limits", 1)      # the loading section after the hard rules and the flags
        open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8").write(moved); self.assertTrue([p for p in loading_problems(d) if "between the checklist" in p])

    def test_quoted_section_names_resolve(self):
        self.assertEqual(names_problems(S.SKILL_DIR), [])
        for what, old, new in (("a renamed index entry", b'"Mandatory audit", "Retry advice"', b'"Mandatory audit", "Retry advise"'), ("an entry under the wrong file", b'(R2): "OpenCode sessions"', b'(R2): "Optional kit"'), ("a dropped entry", b'"Work locations", ', b"")):      # each mutation hits the index row (the first quote of a name is elsewhere)
            with self.subTest(what):
                d = self.fresh(); self.mutate(d, "SKILL.md", old, new); self.assertTrue(names_problems(d), what); self.assertTrue([p for p in S.check(d) if "SKILL.md" in p])
        d = self.fresh(); self.mutate(d, "reference/candidates.md", b"## Scope filter (R05)", b"## Scope filter (R06)"); self.assertTrue(names_problems(d))      # a heading renamed in its own file

    def test_skill_md_within_byte_cap(self):
        self.assertFalse(over_cap(S.SKILL_DIR)); self.assertLessEqual(len(docs(S.SKILL_DIR)["SKILL.md"].encode("utf-8")), ROOT_CAP)
        d = self.fresh(); open(os.path.join(d, "SKILL.md"), "ab").write(b"x" * 3000); self.assertTrue(over_cap(d)); self.assertTrue(S.check(d))

    def test_the_additions_are_declared_and_within_their_budgets(self):
        m = self.m; adds = {a["id"]: a for a in m["additions"]}; self.assertEqual(sorted(adds), ["loading", "source-reads"])
        self.assertLessEqual(adds["loading"]["bytes"], 2782); self.assertLessEqual(adds["source-reads"]["bytes"], 250)      # the budgets of the agreed layout
        self.assertEqual(sum(b["bytes"] for b in m["blocks"]) + sum(a["bytes"] for a in adds.values()), sum(len(t.encode("utf-8")) for t in docs(S.SKILL_DIR).values()))
        bad = S.load_manifest(); del bad["additions"][0]["sha256"]; self.assertTrue([p for p in S.manifest_problems(bad) if "not declared" in p])      # an addition without its hash
        bad = S.load_manifest(); bad["files"]["reference/report.md"].append("loading"); self.assertTrue([p for p in S.manifest_problems(bad) if "exactly one home" in p])      # an addition in two places
        self.assertIn(SOURCE_READS + "\n", docs(S.SKILL_DIR)["reference/prepare.md"]); self.assertIn(SOURCE_READS.split(" are ")[0], section(docs(S.SKILL_DIR)["reference/prepare.md"], "## Step 0"))

class ActiveDocs(unittest.TestCase):
    """skilldocs: the one reader of the active documentation (SKILL.md and the declared references); the baseline and any undeclared file are never read."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name)

    def put(self, name, data):
        p = os.path.join(self.d, name); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(data)

    def test_an_unsplit_skill_is_the_single_file(self):
        import skilldocs; self.put("SKILL.md", BASE); self.assertEqual(skilldocs.names(self.d), ["SKILL.md"]); self.assertEqual(skilldocs.text(self.d), BASE.decode("utf-8"))

    def test_a_split_skill_is_read_from_the_declared_files_only(self):
        import skilldocs; S.build(self.d); self.put("baseline/handoff-verify-skill-0.9.0.md", BASE); self.put("reference/extra.md", b"# extra\nDecoy rule: never read.\n"); self.put("scripts/notes.md", b"Decoy.\n")
        self.assertEqual(skilldocs.names(self.d), list(S.load_manifest()["files"])); self.assertEqual(skilldocs.names(self.d)[0], "SKILL.md")
        t = skilldocs.text(self.d); self.assertNotIn("Decoy", t); self.assertEqual(len(t.encode("utf-8")), len(BASE))      # every byte once, none twice (the baseline is not read)
        self.assertEqual(skilldocs.read("reference/report.md", self.d), open(os.path.join(self.d, "reference", "report.md"), encoding="utf-8").read())

    def test_doc_reads_the_named_file_and_while_the_skill_is_unsplit_every_name_is_the_one_skill_md(self):
        import skilldocs; self.put("SKILL.md", BASE)
        for name in S.load_manifest()["files"]: self.assertEqual(skilldocs.doc(name, self.d), BASE.decode("utf-8"), name)      # unsplit: the one file holds every rule
        S.build(self.d)
        for name in S.load_manifest()["files"]: self.assertEqual(skilldocs.doc(name, self.d), skilldocs.read(name, self.d), name)
        self.assertNotIn("## Output", skilldocs.doc("SKILL.md", self.d)); self.assertIn("## Output", skilldocs.doc("reference/report.md", self.d))      # split: each name is its own file, not the whole

    def test_doc_never_falls_back_once_the_skill_is_split_and_refuses_undeclared_names(self):
        import skilldocs; S.build(self.d); os.remove(os.path.join(self.d, "reference", "report.md"))
        with self.assertRaises(OSError): skilldocs.doc("reference/report.md", self.d)      # a missing reference is an error, not SKILL.md or the baseline
        for name in ("reference/README.md", "../SKILL.md", "baseline/handoff-verify-skill-0.9.0.md", "scripts/split_skill.py", "report.md"):
            with self.assertRaises(KeyError, msg=name): skilldocs.doc(name, self.d)

if __name__ == "__main__": unittest.main()

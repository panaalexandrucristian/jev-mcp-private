#!/usr/bin/env python3
"""The active documentation of the skill (stdlib only, offline): SKILL.md and the reference files that split_manifest.json declares, in the manifest's order (SKILL.md first), for the tests that read the rules from the documentation. Only files that exist are listed, so
the same call reads the unsplit SKILL.md today and the split layout later. The frozen baseline (scripts/baseline/) and any undeclared file are never part of it. `root` defaults to SKILL_DIR, looked up at each call (a test may point SKILL_DIR at another layout).
-> names(root): relative paths; read(name, root): one file as text; text(root): all of them, one after the other (each file once); doc(name, root): the declared file `name` (while the skill is unsplit, i.e. has no reference/ directory, every declared name is the one SKILL.md that then holds everything; once it is split a missing file is an error, never a fallback)."""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import split_skill as S

SKILL_DIR = S.SKILL_DIR

def names(root=None):
    root = root or SKILL_DIR; return [n for n in S.load_manifest()["files"] if os.path.isfile(os.path.join(root, n))]

def read(name, root=None):
    with open(os.path.join(root or SKILL_DIR, name), encoding="utf-8") as f: return f.read()

def text(root=None): return "".join(read(n, root) for n in names(root))

def doc(name, root=None):
    root = root or SKILL_DIR
    if name not in S.load_manifest()["files"]: raise KeyError("%s is not a declared documentation file" % name)
    return read(name if os.path.isdir(os.path.join(root, "reference")) else "SKILL.md", root)

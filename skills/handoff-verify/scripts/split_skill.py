#!/usr/bin/env python3
"""Zero-loss proof for the split of SKILL.md (offline, stdlib only, no Jev call). baseline/handoff-verify-skill-0.9.0.md is the frozen original: a test fixture, never read at run time and never an operational fallback. split_manifest.json (format 1) cuts it into ordered
blocks of whole lines (id, lines, bytes, sha256) and says which file holds which blocks, in which order (`files`). The only text that is not a block is a declared addition (`additions`: id, bytes, sha256), written by hand in the active files. `check` proves that the
active documentation holds every block byte for byte, in its declared place, every addition as declared, and nothing else.
usage: python3 -B split_skill.py fill [--root DIR] | check [--root DIR] [--blocks-only] | build --out DIR      (fill: bytes and sha256 of the blocks from the baseline, and of the additions from the active files under --root; build: the mechanical extraction of the blocks, no sentence is rewritten)"""
import argparse, hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__)); SKILL_DIR = os.path.dirname(HERE); MANIFEST = os.path.join(HERE, "split_manifest.json")

def sha(b): return hashlib.sha256(b).hexdigest()

def _read(path):
    try:
        with open(path, "rb") as f: return f.read()
    except OSError: return None

def load_manifest(path=MANIFEST):
    with open(path, encoding="utf-8") as f: return json.load(f)

def baseline(m): return _read(os.path.join(HERE, m["original"]["path"]))

def cut(data, m):
    """-> {id: bytes}: block `id` is the whole lines [first, last] (1-based, inclusive) of `data`, newline included."""
    parts = data.split(b"\n"); lines = [p + b"\n" for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])
    return {b["id"]: b"".join(lines[b["lines"][0] - 1:b["lines"][1]]) for b in m["blocks"]}

def manifest_problems(m):
    """-> problems of the manifest against the frozen baseline (empty = the blocks cover it exactly and every block has exactly one home)."""
    data = baseline(m); out = []
    if data is None: return ["the baseline file is missing"]
    if (len(data), sha(data)) != (m["original"].get("bytes"), m["original"].get("sha256")): out.append("the baseline is not the original the manifest describes")
    end = 0
    for b in m["blocks"]:
        if b["lines"][0] != end + 1 or b["lines"][1] < b["lines"][0]: out.append("block %s: lines %s do not continue the previous block" % (b["id"], b["lines"]))
        end = b["lines"][1]
    if end != data.count(b"\n"): out.append("the blocks end at line %d, the baseline has %d lines" % (end, data.count(b"\n")))
    for i, c in cut(data, m).items():
        b = next(x for x in m["blocks"] if x["id"] == i)
        if (len(c), sha(c)) != (b.get("bytes"), b.get("sha256")): out.append("block %s: bytes or sha256 differ from the baseline" % i)
    homes = [i for ids in m["files"].values() for i in ids]; ids = [b["id"] for b in m["blocks"]]; adds = m.get("additions", []); every = ids + [a["id"] for a in adds]
    if sorted(homes) != sorted(every) or len(set(every)) != len(every): out.append("every block and every addition must have exactly one home in `files`")
    out += ["addition %s: bytes or sha256 not declared" % a["id"] for a in adds if not (a.get("bytes") and a.get("sha256"))]
    for n, h in m["files"].items():
        own = [i for i in h if i in ids]
        if own != sorted(own, key=ids.index): out.append("%s: blocks are not in their original order" % n)
    return out

def build(out, m=None):
    """Writes the blocks of the split layout under `out` by cutting the baseline (the additions are not part of it: `check(..., blocks_only=True)` is its proof)."""
    m = m or load_manifest(); blocks = cut(baseline(m), m)
    for name, ids in m["files"].items():
        p = os.path.join(out, name); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f: f.write(b"".join(blocks[i] for i in ids if i in blocks))

def _found(root, m, blocks_only=False):
    """-> ({id: bytes found in its declared place}, problems): each file is walked part after part (blocks and additions), so the offsets and the hashes decide, not a search."""
    blocks = {b["id"]: b for b in m["blocks"] + ([] if blocks_only else m.get("additions", []))}; found, out = {}, []
    for name, ids in m["files"].items():
        ids = [i for i in ids if i in blocks]
        data = _read(os.path.join(root, name))
        if data is None: out.append("%s: missing" % name); continue
        off = 0
        for i in ids:
            chunk = data[off:off + blocks[i]["bytes"]]
            if sha(chunk) != blocks[i]["sha256"]: out.append("%s: block %s differs or is not at its declared place (offset %d)" % (name, i, off)); break
            found[i] = chunk; off += len(chunk)
        else:
            if off != len(data): out.append("%s: %d bytes after the last block are not declared" % (name, len(data) - off))
    return found, out

def check(root=SKILL_DIR, m=None, blocks_only=False):
    """-> problems of the active documentation under `root` (empty = lossless). An unsplit original (SKILL.md equal to the baseline, no reference/) is lossless by definition. blocks_only: the layout of `build` (no additions yet)."""
    m = m or load_manifest(); top = _read(os.path.join(root, "SKILL.md"))
    if top is not None and sha(top) == m["original"]["sha256"] and not os.path.isdir(os.path.join(root, "reference")): return []
    found, out = _found(root, m, blocks_only)
    for n in sorted(os.listdir(os.path.join(root, "reference"))) if os.path.isdir(os.path.join(root, "reference")) else []:
        if "reference/" + n not in m["files"]: out.append("reference/%s: not declared in the manifest" % n)
    for n in m["files"]:
        if b"handoff-verify-skill" in (_read(os.path.join(root, n)) or b""): out.append("%s: names the baseline fixture (it is never a fallback)" % n)
    if not out and sha(b"".join(found[b["id"]] for b in m["blocks"])) != m["original"]["sha256"]: out.append("the blocks do not rebuild the original")
    return out

def rebuild(root=SKILL_DIR, m=None, blocks_only=False):
    """-> the original bytes rebuilt from the active documentation under `root` (None when `check` finds a problem)."""
    m = m or load_manifest(); top = _read(os.path.join(root, "SKILL.md"))
    if not check(root, m, blocks_only): return top if not os.path.isdir(os.path.join(root, "reference")) else b"".join(_found(root, m, blocks_only)[0][b["id"]] for b in m["blocks"])

def fill(m, root=None):
    """Computes bytes and sha256 of the original and of every block from the baseline (the data come from the frozen source, never typed). With `root`, also those of the additions, read from the active files: a file holds at most one addition, which is
    what is left of the file after its blocks (its place comes from `files`)."""
    data = baseline(m); m["original"].update(bytes=len(data), sha256=sha(data)); size = {}
    for i, c in cut(data, m).items(): next(b for b in m["blocks"] if b["id"] == i).update(bytes=len(c), sha256=sha(c)); size[i] = len(c)
    for name, ids in m["files"].items() if root else ():
        mine = [a for a in m.get("additions", []) if a["id"] in ids]; assert len(mine) <= 1, "%s: more than one addition" % name
        if mine:
            raw = _read(os.path.join(root, name)); start = sum(size[i] for i in ids[:ids.index(mine[0]["id"])]); n = len(raw) - sum(size[i] for i in ids if i in size); mine[0].update(bytes=n, sha256=sha(raw[start:start + n]))
    return m

def dump(m, path=MANIFEST):
    blocks = ",\n".join("  " + json.dumps(b) for b in m["blocks"]); adds = ",\n".join("  " + json.dumps(a) for a in m.get("additions", [])); files = ",\n".join("  %s: %s" % (json.dumps(n), json.dumps(h)) for n, h in m["files"].items())
    with open(path, "w", encoding="utf-8") as f: f.write('{"format": %d,\n "original": %s,\n "blocks": [\n%s],\n%s "files": {\n%s}}\n' % (m["format"], json.dumps(m["original"]), blocks, (' "additions": [\n%s],\n' % adds) if adds else "", files))

def build_parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0]); s = p.add_subparsers(dest="cmd", required=True)
    f = s.add_parser("fill"); f.add_argument("--root"); c = s.add_parser("check"); c.add_argument("--root", default=SKILL_DIR); c.add_argument("--blocks-only", action="store_true"); b = s.add_parser("build"); b.add_argument("--out", required=True)
    return p

def main(argv=None):
    a = build_parser().parse_args(argv)
    if a.cmd == "fill": dump(fill(load_manifest(), a.root)); return 0
    if a.cmd == "build": build(a.out); return 0
    out = manifest_problems(load_manifest()) + check(a.root, blocks_only=a.blocks_only)
    for line in out: print(line)
    print("OK: lossless" if not out else "FAIL: %d problem(s)" % len(out)); return 1 if out else 0

if __name__ == "__main__": sys.exit(main())

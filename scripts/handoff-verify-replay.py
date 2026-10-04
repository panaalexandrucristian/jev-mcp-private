#!/usr/bin/env python3
"""Maintainer tool: replay every recorded `omissions.py prepare` call of the saved Claude Code sessions (~/.claude/projects/*/*.jsonl) through
three versions of the handoff-verify scripts and compare the printed output byte for byte:

  recorded  the tool_result saved in the transcript (the harness permission line removed);
  base      skills/handoff-verify/scripts at the git revision --base (copied with `git show` into a temp dir);
  new       the working tree: the single `prepare`, and `prepare-batch` with every case of one session in ONE call
            (each element is printed into the original command in place of the script, so pipes and filters apply unchanged).

A case is kept only when the run's own script still reproduces its recorded output today (otherwise the command depended on other
state and is not an exact oracle). For every kept case: new single == base and new batch == base are required; when base != recorded,
the run's own script copy must differ from the base script (sha256), i.e. the recording came from another script version.
Read-only: nothing is written outside a temp dir; no Jev call. Exit 0 only when every requirement holds.
usage: python3 -B scripts/handoff-verify-replay.py --base <git rev> [--projects ~/.claude/projects]"""
import argparse, glob, hashlib, json, os, re, shlex, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = "skills/handoff-verify/scripts"
NOISE = "Part of this command (a variable) cannot be checked in advance"
INVOCATION = re.compile(r"(\S*scripts/omissions\.py)(?=\s+prepare\b)")
CAPTURE = "import sys, json, os\njson.dump(sys.argv[1:], open(os.environ['REPLAY_CAPTURE'], 'w'))\n"
EMIT = "import sys, os\nsys.stdout.write(open(os.environ['REPLAY_EMIT']).read()); sys.exit(int(os.environ['REPLAY_CODE']))\n"
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

def sh(cmd, cwd, **env): return subprocess.run(["bash", "-c", cmd], cwd=cwd, capture_output=True, text=True, env=dict(ENV, **env)).stdout.strip()
def sha(path): return hashlib.sha256(open(path, "rb").read()).hexdigest()
def tag(jsonl):
    d = os.path.basename(os.path.dirname(jsonl)); m = re.search(r"runs-(.+)-proj$", d)
    return m.group(1) if m else re.sub(r"^-Users-[^-]+-(Dev-)?", "", d)

def recorded_calls(projects):
    for f in sorted(glob.glob(os.path.join(os.path.expanduser(projects), "*", "*.jsonl"))):
        if "omissions.py prepare" not in open(f, errors="ignore").read(): continue
        pending = {}
        for line in open(f, errors="ignore"):
            try: r = json.loads(line)
            except ValueError: continue
            content = (r.get("message") or {}).get("content")
            if not isinstance(content, list): continue
            for b in content:
                if b.get("type") == "tool_use" and b.get("name") == "Bash" and re.search(r"scripts/omissions\.py prepare", b["input"].get("command", "")):
                    pending[b["id"]] = (b["input"]["command"], r.get("cwd"))
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    cmd, cwd = pending.pop(b["tool_use_id"]); out = b.get("content")
                    out = "".join(x.get("text", "") for x in out) if isinstance(out, list) else (out or "")
                    yield f, cmd, cwd, re.sub(r"\n?Exit code \d+\s*$", "", out.replace(NOISE, "").strip()).strip()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", required=True); ap.add_argument("--projects", default="~/.claude/projects"); a = ap.parse_args()
    tmp = tempfile.TemporaryDirectory(); t = tmp.name
    base_dir = os.path.join(t, "base"); os.mkdir(base_dir)
    names = subprocess.run(["git", "ls-tree", "--name-only", "%s:%s" % (a.base, SKILL)], cwd=REPO, capture_output=True, text=True, check=True).stdout.split()
    for n in names:
        if n.endswith(".py"): open(os.path.join(base_dir, n), "wb").write(subprocess.run(["git", "show", "%s:%s/%s" % (a.base, SKILL, n)], cwd=REPO, capture_output=True, check=True).stdout)
    base = os.path.join(base_dir, "omissions.py"); new = os.path.join(REPO, SKILL, "omissions.py")
    capture = os.path.join(t, "capture.py"); emit = os.path.join(t, "emit.py"); open(capture, "w").write(CAPTURE); open(emit, "w").write(EMIT)

    cases, skipped = [], {}
    def skip(why): skipped[why] = skipped.get(why, 0) + 1
    for f, cmd, cwd, rec in recorded_calls(a.projects):
        if not cwd or not os.path.isdir(cwd): skip("cwd gone"); continue
        found = INVOCATION.findall(cmd)
        if len(found) != 1: skip("not exactly one prepare invocation"); continue
        script = found[0]
        if sh(cmd, cwd) != rec: skip("run's own script no longer reproduces the recording"); continue
        cap = os.path.join(t, "argv.json")
        sh(cmd.replace(script, shlex.quote(capture), 1), cwd, REPLAY_CAPTURE=cap)
        try: argv = json.load(open(cap)); os.unlink(cap)
        except (OSError, ValueError): skip("argv not captured"); continue
        if argv[:1] != ["prepare"] or len(argv) % 2 == 0 or "--detail" not in argv: skip("not a prepare call with a detail"); continue
        args = dict(zip(argv[1::2], argv[2::2]))
        m = re.match(r"^\s*cd\s+(\S+)\s*(?:;|&&)", cmd); eff = os.path.expanduser(m.group(1)) if m else cwd
        run_script = os.path.normpath(os.path.join(eff, os.path.expanduser(script)))
        cases.append(dict(src=f, cmd=cmd, cwd=cwd, eff=eff, script=script, args=args, rec=rec,
                          run_sha=sha(run_script) if os.path.isfile(run_script) else None))

    base_sha = sha(base)
    for c in cases:
        c["base"] = sh(c["cmd"].replace(c["script"], shlex.quote(base), 1), c["cwd"])
        c["single"] = sh(c["cmd"].replace(c["script"], shlex.quote(new), 1), c["cwd"])
    by_session = {}
    for i, c in enumerate(cases): by_session.setdefault(c["src"], []).append(i)
    batches = 0
    for src, idx in by_session.items():
        spec = []
        for i in idx:
            g = cases[i]["args"]; item = dict(detail=g["--detail"], source_quote=g["--source-quote"])
            for flag, key in (("--source", "source"), ("--file", "file"), ("--write-id", "write_id"), ("--evaluated-against", "evaluated_against"), ("--cwd", "cwd")):
                if flag in g: item[key] = g[flag]
            item.setdefault("cwd", cases[i]["eff"]); spec.append(item)
        sp = os.path.join(t, "spec.json"); json.dump(spec, open(sp, "w"), ensure_ascii=False)
        out = sh("cd %s && python3 -B %s" % (shlex.quote(cases[idx[0]]["eff"]), shlex.join([new, "prepare-batch", "--spec", sp])), cases[idx[0]]["cwd"])
        batches += 1
        try: arr = json.loads(out)
        except ValueError: arr = []
        for k, i in enumerate(idx):
            el = arr[k] if k < len(arr) and len(arr) == len(idx) else None
            if el is None: cases[i]["batch"] = None; continue
            ef = os.path.join(t, "element.json"); open(ef, "w").write(json.dumps(el, indent=1, ensure_ascii=False) + "\n")
            cases[i]["batch"] = sh(cases[i]["cmd"].replace(cases[i]["script"], shlex.quote(emit), 1), cases[i]["cwd"], REPLAY_EMIT=ef, REPLAY_CODE="0" if el.get("ok") else "3")

    failures = 0
    print("base %s omissions.py sha256 %s; cases %d in %d sessions; skipped %s" % (a.base, base_sha[:12], len(cases), len(by_session), json.dumps(skipped, sort_keys=True)))
    for n, c in enumerate(cases, 1):
        single_ok, batch_ok = c["single"] == c["base"], c["batch"] == c["base"]
        base_rec = c["base"] == c["rec"]
        explained = base_rec or (c["run_sha"] is not None and c["run_sha"] != base_sha)
        ok = single_ok and batch_ok and explained; failures += not ok
        print("case %02d %s %s %s | new_single==base %s | new_batch==base %s | base==recorded %s%s | %s" % (
            n, tag(c["src"]), c["args"].get("--write-id"), c["args"].get("--evaluated-against"), single_ok, batch_ok, base_rec,
            "" if base_rec else " (recorded by the run's own script sha256 %s, base %s)" % ((c["run_sha"] or "missing")[:12], base_sha[:12]),
            "OK" if ok else "FAIL"))
    eq = lambda k: sum(c[k] == c["base"] for c in cases)
    print("RESULT %s cases=%d sessions=%d batches=%d new_single==base=%d new_batch==base=%d base==recorded=%d recorded_by_other_script_version=%d" % (
        "PASS" if not failures and cases else "FAIL", len(cases), len(by_session), batches, eq("single"), eq("batch"),
        sum(c["base"] == c["rec"] for c in cases), sum(c["base"] != c["rec"] for c in cases)))
    return 0 if not failures and cases else 1

if __name__ == "__main__": sys.exit(main())

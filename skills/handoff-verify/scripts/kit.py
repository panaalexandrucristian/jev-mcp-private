"""Optional handoff-test-kit integration: copy without python blocks, no --fix, no remote refresh, section 4 SKIPPED, config from demonstrated cwds."""
import json, os, re, shutil, subprocess, tempfile

PY_BLOCK = re.compile(r"python3 - <<'PY'\n.*?\nPY[ \t]*(?:\n|$)", re.S)

def find_kit():
    for c in (os.environ.get("HANDOFF_TEST_KIT"), os.path.expanduser("~/Dev/handoff-test-kit")):
        if c and os.path.isfile(os.path.join(c, "handoff-test.sh")): return c
    return None

def strip_python_blocks(text):
    return PY_BLOCK.sub("", text)

def git_root(path):
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while d and d != os.path.dirname(d):
        if os.path.isdir(os.path.join(d, ".git")) or os.path.isfile(os.path.join(d, ".git")): return d
        d = os.path.dirname(d)
    return None

def make_config(cwds, branch=None):
    """repo_root = verified Git root of the first demonstrated cwd that has one; path_bases = demonstrated cwds.
    A branch with an `origin/` prefix is refused: the kit would `git fetch` (network)."""
    roots = [r for r in (git_root(c) for c in cwds if c and os.path.isdir(c)) if r]
    cfg = {"repo_root": roots[0] if roots else (cwds[0] if cwds else "."), "path_bases": [c for c in cwds if c and os.path.isdir(c)],
           "topics": [], "verify_cwd": "/nonexistent-verify-cwd-skip"}
    if branch:
        if branch.startswith("origin/"): raise ValueError("origin/ refs trigger a remote fetch; use a local ref or skip")
        cfg["external"] = {"branch": branch}
    return cfg

def run_kit(handoff_path, cwds, kit_dir=None, timeout=60):
    kit = kit_dir or find_kit()
    if not kit:
        return {"status": "kit not found, deterministic checks skipped", "exit": None}
    tmp = tempfile.mkdtemp(prefix="kitcopy-")
    try:
        copy = os.path.join(tmp, os.path.basename(handoff_path))
        text = open(handoff_path, encoding="utf-8", errors="replace").read()
        stripped = strip_python_blocks(text)
        open(copy, "w", encoding="utf-8").write(stripped)
        cfg = os.path.join(tmp, "cfg.json"); json.dump(make_config(cwds), open(cfg, "w"))
        p = subprocess.run([os.path.join(kit, "handoff-test.sh"), "--config", cfg, copy], capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
        return {"status": "ran", "exit": p.returncode, "section4": "SKIPPED (python blocks removed from copy; GAP ignored)",
                "python_blocks_removed": len(PY_BLOCK.findall(text)), "stdout": p.stdout, "stderr": p.stderr[-500:],
                "note": "signals are context-dependent hints; each must be confirmed by Jev; current state is not historical truth"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

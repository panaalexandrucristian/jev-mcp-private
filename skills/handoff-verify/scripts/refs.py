"""Direct references only: one level, file must exist, passage must contain the detail; recursive references never count.
0.7.10 (measured on the 9 real notes verified on this machine, 8 of them blocked by an unresolved reference): a backticked command is not itself a reference, its path tokens are;
a shorthand fragment ('-T1b.md', '...-R08.json') is not a reference; '~' is expanded; the git root of each base is an extra base; a bare name (no '/') not found from the bases resolves to
the one tracked file of that name in those repositories, only when exactly one exists (`resolution` says how). A reference that still cannot be resolved blocks the material, as before."""
import os, re, subprocess

EXT = r"\.(?:md|txt|json|py|sh|yml|yaml|toml)"
PATH_RX = re.compile(r"`([^`\n]+%s)`|\(([^)\s]+\.(?:md|txt))\)" % EXT)
TOKEN_RX = re.compile(r"^[^\s=]+%s$" % EXT)

def direct_refs(handoff_text):
    refs = []
    def add(p):
        if p and not p.startswith(("-", "...")) and not re.search(r"[\t<>|;&$*?{}\\]", p) and p not in refs: refs.append(p)
    for m in PATH_RX.finditer(handoff_text):
        p = m.group(1) or m.group(2)
        if re.search(r"\s", p):   # a command (`bash scripts/x.sh`, `VAR=1 python3 t.py`): the files it names are the references, the command line is not one
            for tok in p.split():
                if TOKEN_RX.match(tok): add(tok)
        else: add(p)
    return refs

def git_root(path):
    d = os.path.realpath(path if os.path.isdir(path) else os.path.dirname(path) or ".")
    while True:
        if os.path.exists(os.path.join(d, ".git")): return d
        up = os.path.dirname(d)
        if up == d: return None
        d = up

def with_git_roots(bases):
    """The bases, then the git root of each (in order, without repeats)."""
    out = []
    for b in list(bases) + [git_root(b) for b in bases if b]:
        if b and b not in out: out.append(b)
    return out

def _tracked(root):
    try: p = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError): return []
    return [x.decode("utf-8", "replace") for x in p.stdout.split(b"\0") if x] if p.returncode == 0 else []

def resolve_info(ref, bases):
    """-> (real path | None, resolution): 'path' (found from a base), 'unique_tracked_name' (bare name, exactly one tracked file of that name), or the reason it is not resolved."""
    ref_x = os.path.expanduser(ref)
    for b in bases:
        p = ref_x if os.path.isabs(ref_x) else os.path.join(b, ref_x)
        if os.path.isfile(p): return os.path.realpath(p), "path"
    if "/" in ref or os.sep in ref: return None, "not found from the bases"
    hits = set()
    for r in {git_root(b) for b in bases if b} - {None}:
        hits |= {os.path.realpath(os.path.join(r, x)) for x in _tracked(r) if os.path.basename(x) == ref and os.path.isfile(os.path.join(r, x))}
    if len(hits) == 1: return hits.pop(), "unique_tracked_name"
    return None, "not found from the bases" if not hits else "%d tracked files have this name" % len(hits)

def resolve(ref, bases):
    return resolve_info(ref, bases)[0]

def covers(handoff_path, handoff_text, detail_regex, bases):
    """Coverage from referenced files: only level-1 refs of THIS handoff; never recursive; passage returned for citation."""
    out = []
    for ref in direct_refs(handoff_text):
        real = resolve(ref, bases)
        if real is None:
            out.append({"ref": ref, "exists": False, "covers": False}); continue
        if os.path.realpath(real) == os.path.realpath(handoff_path):
            continue
        try: txt = open(real, encoding="utf-8", errors="replace").read()
        except OSError:
            out.append({"ref": ref, "exists": False, "covers": False}); continue
        m = re.search(detail_regex, txt)
        out.append({"ref": ref, "exists": True, "real": real, "covers": bool(m), "passage": txt[max(0, m.start() - 80):m.end() + 80] if m else None})
    return out

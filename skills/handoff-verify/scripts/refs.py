"""Direct references only: one level, file must exist, passage must contain the detail; recursive references never count.
Current rules: a backticked path with spaces stays whole; a command names its files anywhere in it (wider extension list); a tracked-name target must lie inside its repository root; `git ls-files` runs once per root and its failure is the reason.
0.7.10 (measured on the 9 real notes verified on this machine, 8 of them blocked by an unresolved reference): a backticked command is not itself a reference, its path tokens are;
a shorthand fragment ('-T1b.md', '...-R08.json') is not a reference; '~' is expanded; the git root of each base is an extra base; a bare name (no '/') not found from the bases resolves to
the one tracked file of that name in those repositories, only when exactly one exists (`resolution` says how). A reference that still cannot be resolved blocks the material, as before."""
import os, re, shlex, subprocess

EXT = r"\.(?:md|txt|json|py|sh|yml|yaml|toml)"   # whole backticked paths (unchanged since before 0.7.10: the material of a note that was complete then stays byte-identical)
CMD_EXT = r"\.(?:md|txt|json|py|sh|yml|yaml|toml|js|mjs|ts)$"   # a file named inside a command: the wider list of known extensions
SPAN_RX = re.compile(r"`([^`\n]+)`|\(([^)\s]+\.(?:md|txt))\)")
SHELL_RX = re.compile(r"[<>|;&$*?{}\\]")
ASSIGN_RX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
COMMAND_WORDS = frozenset("sh bash zsh dash ksh fish python python2 python3 node nodejs deno bun ruby perl php npx npm yarn pnpm uv uvx pip make env sudo time nohup source cd cat less more head tail cp mv rm ls vi vim nano code open git grep rg sed awk diff chmod mkdir touch xargs".split())

def _is_command(p):
    first = p.split()[0]
    return bool(SHELL_RX.search(p) or ASSIGN_RX.match(first) or first in COMMAND_WORDS or re.fullmatch(r"python[\d.]+", first))

def _command_tokens(p):
    try:
        lex = shlex.shlex(p, posix=True, punctuation_chars=True); lex.whitespace_split = True; return list(lex)
    except ValueError: return [t.strip("\"'") for t in p.split()]

def direct_refs(handoff_text, bases=()):
    """The direct references of a note, in order of appearance, without repeats. A backticked text without whitespace is a path when it ends in EXT; with whitespace it is, in this order: an existing file (found from `bases`), a command (shell syntax,
    a VAR=value prefix or a known command word first: the files it names, anywhere in it, are the references), a path with spaces (it ends in EXT; kept whole even if it does not exist, so it blocks the material)."""
    refs = []
    def add(p):
        if p and not p.startswith(("-", "...")) and not re.search(r"[\t<>|;&$*?{}\\]", p) and p not in refs: refs.append(p)
    for m in SPAN_RX.finditer(handoff_text):
        p = m.group(1) or m.group(2)
        if m.group(2) or not re.search(r"\s", p):
            if m.group(2) or re.search(EXT + "$", p): add(p)
            continue
        if bases and resolve(p, bases) is not None and p not in refs: refs.append(p)
        elif not _is_command(p) and re.search(EXT + "$", p): add(p)
        else:
            for tok in _command_tokens(p):
                if not tok.startswith("-") and "=" not in tok and re.search(CMD_EXT, tok): add(tok)
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

_TRACKED_CACHE = {}   # canonical repository root -> sorted tracked paths (one `git ls-files` per root per process; a failure is never cached)

def _tracked(root):
    """-> (sorted tracked paths, None) or ([], 'git ls-files failed: <why>'): a failure is reported, never read as 'no files'."""
    key = os.path.realpath(root)
    if key in _TRACKED_CACHE: return _TRACKED_CACHE[key], None
    try: p = subprocess.run(["git", "-C", key, "ls-files", "-z"], capture_output=True, timeout=30)
    except subprocess.TimeoutExpired: return [], "git ls-files failed: timeout after 30s in %s" % key
    except (OSError, subprocess.SubprocessError) as e: return [], "git ls-files failed: %s in %s" % (e, key)
    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        return [], "git ls-files failed: exit %d%s in %s" % (p.returncode, ": " + err[0] if err else "", key)
    _TRACKED_CACHE[key] = sorted(x.decode("utf-8", "replace") for x in p.stdout.split(b"\0") if x)
    return _TRACKED_CACHE[key], None

def _inside(real, root):
    try: return os.path.commonpath([real, os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError: return False

def resolve_info(ref, bases):
    """-> (real path | None, resolution): 'path' (found from a base), 'unique_tracked_name' (bare name, exactly one tracked file of that name, whose realpath is inside its repository root), or the reason it is not resolved."""
    ref_x = os.path.expanduser(ref)
    for b in bases:
        p = ref_x if os.path.isabs(ref_x) else os.path.join(b, ref_x)
        if os.path.isfile(p): return os.path.realpath(p), "path"
    if "/" in ref or os.sep in ref: return None, "not found from the bases"
    cands, errs = {}, []
    for r in sorted({git_root(b) for b in bases if b} - {None}):
        files, err = _tracked(r)
        if err: errs.append(err)
        for x in files:
            if os.path.basename(x) == ref and os.path.isfile(os.path.join(r, x)):
                real = os.path.realpath(os.path.join(r, x)); cands[real] = (r, _inside(real, r))
    if errs and len(cands) <= 1: return None, "; ".join(errs)   # a failed listing can hide a second file of this name: not resolved
    if len(cands) == 1:
        (real, (r, inside)), = cands.items()
        if inside: return real, "unique_tracked_name"
        return None, "the tracked file of this name resolves outside the repository root (%s)" % r
    return None, "not found from the bases" if not cands else "%d tracked files have this name" % len(cands)

def resolve(ref, bases):
    return resolve_info(ref, bases)[0]

def covers(handoff_path, handoff_text, detail_regex, bases):
    """Coverage from referenced files: only level-1 refs of THIS handoff; never recursive; passage returned for citation."""
    out = []
    for ref in direct_refs(handoff_text, bases):
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

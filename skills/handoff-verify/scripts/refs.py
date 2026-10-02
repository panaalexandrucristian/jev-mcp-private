"""Direct references only: one level, file must exist, passage must contain the detail; recursive references never count."""
import os, re

PATH_RX = re.compile(r"`([^`\n]+\.(?:md|txt|json|py|sh|yml|yaml|toml))`|\(([^)\s]+\.(?:md|txt))\)")

def direct_refs(handoff_text):
    refs = []
    for m in PATH_RX.finditer(handoff_text):
        p = m.group(1) or m.group(2)
        if p and not re.search(r"[\t<>|;&$*?{}\\]", p) and p not in refs: refs.append(p)
    return refs

def resolve(ref, bases):
    for b in bases:
        p = ref if os.path.isabs(ref) else os.path.join(b, ref)
        if os.path.isfile(p): return os.path.realpath(p)
    return None

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

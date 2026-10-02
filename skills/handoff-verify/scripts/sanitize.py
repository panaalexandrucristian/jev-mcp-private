"""Sanitize BEFORE any Jev call: exclude .env, redact demonstrable secrets, keep SHAs/ids. Ambiguous high-entropy values -> redacted + dependent check UNRESOLVED."""
import os, re

REDACTED = "[REDACTED:%s]"
DEMONSTRABLE = [
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("bearer", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")),
    ("assignment", re.compile(r"(?i)\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[:=]\s*[\"']?([^\s\"']{8,})")),
]
SHA = re.compile(r"\b[0-9a-f]{7,40}\b")
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
AMBIGUOUS = re.compile(r"(?<![/\w.-])(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{32,}(?![/\w.-])")  # path segments are facts, not secrets

def is_excluded_file(path):
    b = os.path.basename(path).lower()
    return b == ".env" or b.startswith(".env.") or b.endswith(".env")

def sanitize(text, canaries=()):
    """returns (clean_text, report) ; report: redactions [{kind,count}], ambiguous count, canary_leaks (must be 0)."""
    redactions, out = {}, text
    def sub(kind, rx, repl=None):
        nonlocal out
        def f(m):
            redactions[kind] = redactions.get(kind, 0) + 1
            if kind == "assignment":
                return m.group(0).replace(m.group(2), REDACTED % kind)
            return REDACTED % kind
        out = rx.sub(f, out)
    for kind, rx in DEMONSTRABLE:
        sub(kind, rx)
    # keep uuids and git SHAs: protect them from the ambiguous-secret rule
    protected = {}
    def protect(m):
        k = "\x00P%d\x00" % len(protected); protected[k] = m.group(0); return k
    out = UUID.sub(protect, out); out = SHA.sub(protect, out)
    amb = 0
    def amb_sub(m):
        nonlocal amb; amb += 1; return REDACTED % "ambiguous"
    out = AMBIGUOUS.sub(amb_sub, out)
    for k, v in protected.items():
        out = out.replace(k, v)
    leaks = [c for c in canaries if c and c in out]
    return out, {"redactions": redactions, "ambiguous_redacted": amb, "canary_leaks": leaks,
                 "dependent_checks_unresolved": amb > 0}

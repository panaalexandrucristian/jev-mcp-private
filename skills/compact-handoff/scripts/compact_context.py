#!/usr/bin/env python3
"""compact_context.py: a smaller start context for a new session, with a byte-for-byte way back.

  compact_context.py compact CHUNK_DIR OUT_DIR [--limit KIND=N|none ...] [--preview N] [--no-readonly] [--with-blobs] [--intro FILE] [--name NAME]
  compact_context.py check   CHUNK_DIR OUT_DIR [same options]   (compact + expand + compare sha256; exit 0 only when identical)
  compact_context.py expand  OUT_DIR                            (prints the original text to stdout)
  compact_context.py selftest
  KIND: tool_use, tool_result, assistant_text, user_text. Defaults: tool_use=800 tool_result=300, texts whole, preview 100, read-only rule on.
  By default a record that is too long is CUT to its first characters (`[…N caractere omise]`) and the rest is not kept; check = users' and assistant's messages identical, every cut exactly the prefix of the original.
  --with-blobs keeps the cut text in OUT_DIR/blobs/Rnnnn.txt instead, and check proves expand(compact(x)) == x.
  --intro FILE puts that text before the transcript in the output file; --name sets the file name (default CONTEXT.md; make_context.py uses HANDOFF.md).

CHUNK_DIR is the --out directory of prepare.py / prepare_all.py (it holds transcript/chunk-*.txt); the chunk texts are joined in order. User and assistant text stay whole.
A record is replaced by ONE marker line with a short preview, and its full text goes to OUT_DIR/blobs/Rnnnn.txt, when
  (1) it is a tool_use or tool_result longer than the limit of its kind, or
  (2) it is a tool call that only READS (Read, Grep, Glob, ToolSearch, a Bash made only of read-only commands: ls, cat, grep, sed -n, git log/status/diff, ...) and is longer than its marker.
A command that may change state (rm, git commit/push, redirects into files, sed -i, service restarts, API calls ...) is never moved by rule (2); neither is a message of the user.
expand() puts every blob back. Nothing is summarised, translated or cut: the marker only points at the full text, and `check` proves expand(compact(x)) == x."""
import glob, hashlib, itertools, json, os, re, sys, tempfile

REC = re.compile(r"(?m)^\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (?:user|assistant)\]")
UUID = re.compile(r"^\[[0-9a-f-]{36} (user|assistant)\] ")
KIND = re.compile(r"^\[[0-9a-f-]{36} (user|assistant)\] (?:\[tool_(use|result)\b)?")
PAIRS = (("⟦", "⟧"), ("⟪", "⟫"), ("【", "】"), ("〔", "〕"), ("⌜", "⌝"), ("⸢", "⸣"), ("❬", "❭"), ("❨", "❩"), ("⦅", "⦆"), ("⧼", "⧽"),
         ("⦇", "⦈"), ("⦉", "⦊"), ("⦋", "⦌"), ("⦍", "⦎"), ("⦏", "⦐"), ("⦑", "⦒"), ("⦓", "⦔"), ("⦕", "⦖"), ("⦗", "⦘"), ("⧘", "⧙"), ("⧚", "⧛"), ("❮", "❯"), ("❰", "❱"), ("❲", "❳"),
         ("❴", "❵"), ("⟅", "⟆"), ("⟨", "⟩"), ("⟬", "⟭"), ("⟮", "⟯"), ("⸤", "⸥"), ("⸦", "⸧"), ("⸨", "⸩"))   # the first pair whose opener+"R" is not in the text is used
KINDS = ("tool_use", "tool_result", "assistant_text", "user_text")
DEFAULT_LIMITS = {"tool_use": 800, "tool_result": 300, "assistant_text": None, "user_text": None}   # None = always kept whole
DEFAULT_PREVIEW = 100
SEP = "----- transcript (compact) -----\n"
FILE_NAMES = ("HANDOFF.md", "CONTEXT.md")   # read_out takes the first one that exists
HEADER = ("This is a session transcript made smaller for a new session. A line `%sRnnnn|chars|preview%s` stands for ONE record that was longer than the limit of its kind (%s)%s: "
          "its full text is in `blobs/Rnnnn.txt` next to this file (open it only when you need the detail). Every other record is complete. Nothing was cut or summarised.\n")


# ---- the rule: a tool call that only reads -------------------------------------------------------------------------------------------------------
READ_TOOLS = {"Read", "Grep", "Glob", "ToolSearch", "ListAgents", "TaskOutput", "WebFetch", "WebSearch", "mcp__playwright__browser_navigate", "mcp__playwright__browser_snapshot", "mcp__playwright__browser_take_screenshot"}
READ_VERBS = {"ls", "cat", "head", "tail", "grep", "egrep", "rg", "find", "wc", "echo", "printf", "sleep", "pwd", "which", "stat", "date", "jq", "cut", "sort", "uniq", "tr", "awk", "diff", "file", "du", "df",
              "ps", "pgrep", "test", "[", "true", "env", "uname", "type", "basename", "dirname", "realpath", "readlink", "column", "xargs", "tree", "shasum", "md5", "sha256sum", "nl", "less", "more", "lsof",
              "id", "whoami", "hostname", "cd", "export"}
GIT_READ = {"log", "status", "diff", "show", "fetch", "rev-parse", "branch", "ls-remote", "merge-base", "cat-file", "remote", "grep", "ls-files", "blame", "describe", "config", "shortlog", "rev-list",
            "show-ref", "for-each-ref"}
SHELL_KEYWORDS = {"for", "do", "done", "while", "if", "then", "else", "elif", "fi", "case", "esac", "in", "{", "}", "!", "time"}
WRITES_IN_SCRIPT = re.compile(r"open\([^)]*['\"][wax+]|\.write|write_text|write_bytes|shutil|os\.(remove|unlink|rename|replace|makedirs|mkdir|system)|subprocess|urllib|requests|socket|"
                              r"fs\.(write|append|unlink|rm|mkdir|rename)|child_process|json\.dump\(")
MUTATING = re.compile(r"|".join([   # a command that may change state: never moved by rule; when in doubt it is protected
    r"\brm -rf?\b", r"\bgit (push|commit|tag|add|branch -[dD]|worktree remove|reset|checkout|merge|rebase|stash)\b", r"\bplugin (update|install|uninstall)", r"marketplace (update|add)",
    r"\bcp \b", r"\bmv \b", r"\bnohup\b", r"\bcaffeinate\b", r"\b(kill|pkill|killall)\b", r"\bmkdir\b", r"\bnpm (install|publish)\b", r"\bpip install\b", r"\bbrew (install|uninstall)\b",
    r"\[tool_use (Edit|Write|NotebookEdit)\b", r"\bsed -i\b", r"\btee\b", r"\bopencode (service|serve|run)\b", r"\blaunchctl (setenv|load|unload|bootstrap|bootout|kickstart)\b",
    r"mcp__playwright__browser_(evaluate|click|type|fill_form|select_option|press_key|file_upload|handle_dialog|drag)", r"\b(glab|gh) api\b", r"\b(glab|gh) (mr|pr|issue) (create|update|merge|note|comment|close|reopen)\b",
    r"\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)", r"\bacli\b.*\b(create|edit|transition|delete|assign|comment)\b",
    r"(?<![0-9&>=-])>{1,2}\s*(?!&|/dev/null)[~/\w.$\"'{]",   # a redirect into a real file; 2>&1 and >/dev/null do not count
]))


def strip_quotes(c): return re.sub(r'"(?:[^"\\]|\\.)*"', "Q", re.sub(r"'[^']*'", "Q", c))
def split_segments(cmd): return [s.strip() for s in re.split(r"&&|\|\||;|\||\n", cmd) if s.strip()]


def first_word(seg):
    toks = seg.split()
    while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] in SHELL_KEYWORDS): toks = toks[1:]
    return toks[0].lstrip("(!{") if toks else ""


def command_of(rec):
    m = re.search(r"\[tool_use Bash\] (\{.*)", rec, re.S)
    if not m: return None
    line = m.group(1).split("\n")[0]
    try: return json.loads(line)["command"]
    except Exception:
        mm = re.search(r'"command": "((?:[^"\\]|\\.)*)', line)
        return mm.group(1).encode().decode("unicode_escape", "ignore") if mm else None


def readonly_command(cmd):
    """True when every command of the line only reads: known read verbs, git/glab/gh read subcommands, sed -n, and python/node only as an inline script that writes nothing."""
    if MUTATING.search(cmd): return False
    for s in split_segments(strip_quotes(cmd).split("<<")[0]):
        if re.match(r"^(for|select|case)\b", s): continue   # `for x in a b` names a list, not a command
        w = first_word(s)
        if w == "": continue
        if w == "git":
            sub = [t for t in s.split()[1:] if not t.startswith("-")][:1]
            if not sub or sub[0] not in GIT_READ: return False
        elif w in ("glab", "gh"):
            if not re.search(r"\b(view|list|diff|status|show|checks)\b", s): return False
        elif w == "sed":
            if " -n" not in s: return False
        elif w in ("python3", "python", "node"):
            inline = "<<" in cmd or re.search(r"\s-[cpe]\s", s) or re.search(r"\s-\s*$", s) or " - " in s   # an inline script; a script FILE is unknown
            if not inline or WRITES_IN_SCRIPT.search(cmd): return False
        elif w == "opencode":
            if "--help" not in s: return False
        elif w == "claude":
            if not re.search(r"claude (plugin|mcp) list", s): return False
        elif w.startswith(("$", "./", "/")): return False
        elif w not in READ_VERBS: return False
    return True


def is_readonly_call(rec):
    m = re.match(r"^\[[0-9a-f-]{36} assistant\] \[tool_use (\S+?)\]", rec)
    if not m or MUTATING.search(rec): return False
    if m.group(1) in READ_TOOLS: return True
    if m.group(1) == "Bash":
        c = command_of(rec)
        return c is not None and readonly_command(c)
    return False


# ---- compaction ----------------------------------------------------------------------------------------------------------------------------------
def mark_re(pair): return re.compile(re.escape(pair[0]) + r"R(\d{4})\|(\d+)\|[^\n]*?" + re.escape(pair[1]) + r"\n?")


def pick_pair(text):
    for o, c in PAIRS:
        if o + "R" not in text: return (o, c)
    raise ValueError("every marker pair already occurs in the text; refusing to compact")


def describe(limits): return ", ".join("%s > %s" % (k, limits[k]) for k in KINDS if limits.get(k) is not None) or "none"


def header(pair, limits, moved=0):
    extra = ", or that is a tool call that only reads (Read, search, listing, git log/status/diff; %d records, never a command that may change state)" % moved if moved else ""
    return "MARKER-PAIR: %s%s\n" % pair + HEADER % (pair[0], pair[1], describe(limits), extra)


def read_chunks(chunk_dir):
    files = sorted(glob.glob(os.path.join(chunk_dir, "transcript", "chunk-*.txt")))
    return "".join(open(f, encoding="utf-8", newline="").read() for f in files)


def split_records(text):
    pos = [m.start() for m in REC.finditer(text)]
    if not pos: return text, []
    return text[:pos[0]], [text[a:b] for a, b in zip(pos, pos[1:] + [len(text)])]


def kind_of(rec):
    """The kind of a record from what it starts with. A record that starts with text and holds a tool call later counts as text."""
    m = KIND.match(rec)
    if m is None: return None
    if m.group(2): return "tool_" + m.group(2)
    return "assistant_text" if m.group(1) == "assistant" else "user_text"


CUT_NOTE = " […%d caractere omise]"
CUT_RE = re.compile(r" \[…(\d+) caractere omise\]\n?$")
HEADER_CUT = ("This is a session transcript made smaller for a new session. Messages of the user and of the assistant are complete. A tool call or tool result that was longer than the limit of its kind (%s)%s "
              "was cut to its first characters and ends with `[…K caractere omise]`; the omitted text is not in this file.\n")


def header_cut(limits, moved=0):
    extra = ", or a tool call that only reads (Read, search, listing, git log/status/diff; %d records, never a command that may change state)," % moved if moved else ","
    return HEADER_CUT % (describe(limits), extra)


def cut_record(r, preview):
    """The record cut to its uuid header plus `preview` characters (line breaks shown as ⏎), then the note with the number of omitted characters; a record that is not longer than that is returned as it is."""
    m = UUID.match(r); keep = (m.end() if m else 0) + preview
    if len(r.rstrip("\n")) <= keep: return r
    return r[:keep].replace("\n", "⏎") + CUT_NOTE % (len(r.rstrip("\n")) - keep) + ("\n" if r.endswith("\n") else "")


def compact_text(text, limits, preview, readonly=False, stats=None, blobs=True):
    """-> (compact text without header, {blob name: full record text}, marker pair or None). A record that is too long for its kind, or (readonly) a tool call that only reads, is replaced by a marker line pointing at blobs/Rnnnn.txt
    (blobs=True; raises ValueError when no marker pair is free) or is cut to its first characters (blobs=False: the rest is not kept). `stats["readonly"]` counts the records moved only by the read-only rule."""
    pair = pick_pair(text) if blobs else None
    head, recs = split_records(text); out, blob_map = [head], {}
    for r in recs:
        k = kind_of(r); lim = limits.get(k)
        by_length = lim is not None and len(r) > lim
        by_rule = readonly and k == "tool_use" and len(r) > preview + 25 and is_readonly_call(r)   # shorter than its marker: moving it would save nothing
        if not (by_length or by_rule): out.append(r); continue
        if not blobs:
            c = cut_record(r, preview); out.append(c)
            if c != r and stats is not None and not by_length: stats["readonly"] = stats.get("readonly", 0) + 1
            continue
        if stats is not None and not by_length: stats["readonly"] = stats.get("readonly", 0) + 1
        name = "R%04d" % len(blob_map); blob_map[name] = r
        p = UUID.sub(r"[\1] ", r, count=1)[:preview].replace("\n", "⏎").replace(pair[1], "·")   # the uuid is no use in a preview
        out.append("%s%s|%d|%s%s%s" % (pair[0], name, len(r), p, pair[1], "\n" if r.endswith("\n") else ""))
    return "".join(out), blob_map, pair


def verify_cut(text, compact, preview):
    """-> (ok, records cut, omitted characters, user/assistant records intact, user/assistant records). ok = same records in the same order; a user or assistant text record is identical; any other record is
    identical or exactly cut_record(original) with a correct count of omitted characters."""
    h1, r1 = split_records(text); h2, r2 = split_records(compact)
    if h1 != h2 or len(r1) != len(r2): return False, 0, 0, 0, 0
    cut = omitted = intact = texts = 0
    for a, b in zip(r1, r2):
        is_text = kind_of(a) in ("assistant_text", "user_text"); texts += is_text
        if a == b: intact += is_text; continue
        m = CUT_RE.search(b)
        if is_text or kind_of(a) is None or b != cut_record(a, preview) or not m: return False, cut, omitted, intact, texts
        cut += 1; omitted += int(m.group(1))
    return True, cut, omitted, intact, texts


def expand_text(compact, blobs, pair):
    return mark_re(pair).sub(lambda m: blobs["R" + m.group(1)], compact)


def write_out(out_dir, compact, blobs, limits, pair, moved=0, intro="", name="CONTEXT.md"):
    os.makedirs(os.path.join(out_dir, "blobs"), exist_ok=True)
    for blob, body in blobs.items(): open(os.path.join(out_dir, "blobs", blob + ".txt"), "w", encoding="utf-8", newline="").write(body)
    open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="").write(intro + header(pair, limits, moved) + SEP + compact)


def read_out(out_dir):
    path = next(os.path.join(out_dir, n) for n in FILE_NAMES if os.path.exists(os.path.join(out_dir, n)))
    ctx = open(path, encoding="utf-8", newline="").read()
    m = re.search(r"(?m)^MARKER-PAIR: (.)(.)$", ctx); assert m, "no marker pair line"
    pair = (m.group(1), m.group(2))
    compact = ctx.split(SEP, 1)[1]
    blobs = {}
    for f in glob.glob(os.path.join(out_dir, "blobs", "R*.txt")):
        blobs[os.path.basename(f)[:-4]] = open(f, encoding="utf-8", newline="").read()
    return compact, blobs, pair


def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()


def cmd_compact(chunk_dir, out_dir, limits, preview, readonly=True, intro="", name="CONTEXT.md", blobs=False):
    text = read_chunks(chunk_dir); stats = {}
    compact, blob_map, pair = compact_text(text, limits, preview, readonly, stats, blobs)
    if blobs: write_out(out_dir, compact, blob_map, limits, pair, stats.get("readonly", 0), intro, name)
    else:
        os.makedirs(out_dir, exist_ok=True)
        open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="").write(intro + header_cut(limits, stats.get("readonly", 0)) + SEP + compact)
    return text, compact, blob_map, stats.get("readonly", 0)


def cmd_check(chunk_dir, out_dir, limits, preview=DEFAULT_PREVIEW, readonly=True, intro="", name="CONTEXT.md", blobs=False):
    text, compact, blob_map, moved = cmd_compact(chunk_dir, out_dir, limits, preview, readonly, intro, name, blobs)
    size = len(open(os.path.join(out_dir, name), encoding="utf-8", newline="").read()); label = describe(limits) + (" + read-only rule" if readonly else "")
    if blobs:
        c2, b2, p2 = read_out(out_dir); ok = sha(expand_text(c2, b2, p2)) == sha(text)
        print("%s | original %7d chars | %s %7d chars (%.1f%% of original) | blobs %3d (%d chars, %d by the read-only rule) | roundtrip %s" % (
            label, len(text), name, size, 100 * size / len(text), len(blob_map), sum(map(len, blob_map.values())), moved, "IDENTICAL" if ok else "DIFFERENT"))
        return ok
    ok, cut, omitted, intact, texts = verify_cut(text, compact, preview)
    print("%s | original %7d chars | %s %7d chars (%.1f%% of original) | %d records cut (%d chars omitted, %d by the read-only rule) | user and assistant text intact %d of %d | check %s" % (
        label, len(text), name, size, 100 * size / len(text), cut, omitted, moved, intact, texts, "PASSED" if ok and intact == texts else "FAILED"))
    return ok and intact == texts


# ---- self test -----------------------------------------------------------------------------------------------------------------------------------
def selftest():
    uid = "3d00dfee-901a-4db7-9c77-640674aac909"; L, n = 40, 0
    heads = {"user_text": "user] ", "assistant_text": "assistant] ", "tool_use": "assistant] [tool_use Bash] ", "tool_result": "user] [tool_result] "}
    def record(kind, size, multi, nl):
        header = "[%s %s" % (uid, heads[kind]); room = max(0, size - len(header) - 1)
        body = ("x" * (room // 2) + ("\nline two" if multi else "") + "y" * (room - room // 2))[:room]
        return header + body + ("\n" if nl else "")
    # (1) the length limits: kind x limit set or none x size around the limit x single/multi-line x ending newline  (readonly off)
    for kind, limit, size, multi, nl in itertools.product(KINDS, (None, L), (L - 1, L, L + 1), (False, True), (True, False)):
        rec = record(kind, size, multi, nl)
        nb = "assistant" if kind == "user_text" else "user"   # neighbours of a kind whose limit is None in this case, so only the tested record can be replaced
        text = "[%s %s] first\n" % (uid, nb) + rec + ("" if not nl else "[%s %s] last\n" % (uid, nb))   # the tested record is last and has no newline when nl is False
        lims = {k: None for k in KINDS}; lims[kind] = limit
        c, b, pr = compact_text(text, lims, 20); n += 1
        assert expand_text(c, b, pr) == text, (kind, limit, size, multi, nl)
        assert len(b) == (1 if (limit is not None and len(rec) > limit) else 0), (kind, limit, size, multi, nl, len(rec), len(b))
    mixed = "".join(record(k, 100, False, True) for k in KINDS)   # one of each kind, all 100 chars: only the two tool kinds may go
    c, b, pr = compact_text(mixed, {"tool_use": 40, "tool_result": 40, "assistant_text": None, "user_text": None}, 20); n += 1
    assert expand_text(c, b, pr) == mixed and len(b) == 2 and all(kind_of(v) in ("tool_use", "tool_result") for v in b.values())
    c, b, pr = compact_text(mixed, {k: 40 for k in KINDS}, 20); n += 1
    assert expand_text(c, b, pr) == mixed and len(b) == 4 and pr == PAIRS[0]
    # (2) marker pairs
    clash = "[%s user] mentions ⟦R0000|1|x⟧ and 〔R1 here\n" % uid + record("tool_result", 100, False, True)   # the first and the last pair are taken: the second must be used
    c, b, pr = compact_text(clash, {"tool_result": 40}, 20); n += 1
    assert pr == PAIRS[1] and len(b) == 1 and expand_text(c, b, pr) == clash
    alln = "".join("[%s user] has %sR0 %s\n" % (uid, o, cl) for o, cl in PAIRS)
    try: compact_text(alln, DEFAULT_LIMITS, 20); raise SystemExit("clash with every pair not refused")
    except ValueError: n += 1
    c, b, pr = compact_text("no records at all\n", DEFAULT_LIMITS, 20); assert (c, b) == ("no records at all\n", {}); n += 1
    d = tempfile.mkdtemp(); write_out(d, c, b, DEFAULT_LIMITS, pr); assert read_out(d)[2] == pr; n += 1   # the pair survives the file
    d2 = tempfile.mkdtemp(); txt = "[%s user] a\n" % uid + record("tool_result", 100, False, True)   # an intro before the transcript and another file name
    c, b, pr = compact_text(txt, {"tool_result": 40}, 20); write_out(d2, c, b, DEFAULT_LIMITS, pr, 0, "# Handoff\n\nread this first\nMARKER-PAIR is explained below\n\n", "HANDOFF.md"); n += 1
    c2, b2, p2 = read_out(d2); assert p2 == pr and expand_text(c2, b2, p2) == txt and os.path.exists(os.path.join(d2, "HANDOFF.md")) and not os.path.exists(os.path.join(d2, "CONTEXT.md"))
    # (3) the read-only rule as a table: commands that must count as reading, and commands that must not
    reading = ["ls -la", "cat a.txt | head -5", "grep -n x f", "git log --oneline -3 && git status --short", "cd /x && git grep -n \"a|b\" f | head", "sed -n 1,5p f", "echo hi 2>&1", "grep x f >/dev/null",
               "for m in a b; do echo $m; ls $m; done", "glab mr view 12", "python3 - <<'EOF'\nprint(1)\nEOF", "node -p \"1+1\"", "opencode models --help", "claude plugin list", "ps aux | grep foo | grep -v grep | wc -l",
               "VAR=1 ls /x", "find . -name x | sort -u"]
    mutating = ["rm -rf /tmp/x", "git commit -m x", "git push origin main", "git stash", "sed -i s/a/b/ f", "echo hi >> notes.txt", "python3 x.py > run.log", "cp a b", "mkdir d", "curl -X POST http://x",
                "glab api projects/1", "glab mr note 1 -m x", "opencode service restart", "kill 123", "P=/x; $P/run.sh", "./run.sh", "python3 script.py", "python3 - <<'EOF'\nopen('f','w').write('x')\nEOF",
                "node -e \"require('fs').writeFileSync('f','x')\"", "launchctl setenv A b", "unknown_tool --flag", "nohup sleep 9 &"]
    for cmd in reading: assert readonly_command(cmd), ("should read", cmd); n += 1
    for cmd in mutating: assert not readonly_command(cmd), ("should not count as reading", cmd); n += 1
    # (4) the rule inside the compaction: category x size around the threshold (preview + 25) x ending newline  (limits off, rule on)
    PV = 100; T = PV + 25
    def call(cat, size, nl):
        if cat == "read_tool": pre, suf = "[%s assistant] [tool_use Read] {\"file_path\": \"/" % uid, "\"}"
        elif cat == "edit": pre, suf = "[%s assistant] [tool_use Edit] {\"file_path\": \"/" % uid, "\"}"
        elif cat == "tool_result": pre, suf = "[%s user] [tool_result] " % uid, ""
        elif cat == "assistant_text": pre, suf = "[%s assistant] " % uid, ""
        else:
            word = {"bash_read": "ls /", "bash_write": "rm -rf /", "bash_unknown": "./run.sh /"}[cat]
            pre, suf = "[%s assistant] [tool_use Bash] {\"command\": \"%s" % (uid, word), "\"}"
        pad = size - len(pre) - len(suf) - (1 if nl else 0); assert pad >= 0, (cat, size)
        return pre + "x" * pad + suf + ("\n" if nl else "")
    CATS = ("read_tool", "bash_read", "bash_write", "bash_unknown", "edit", "tool_result", "assistant_text")
    for cat, size, nl in itertools.product(CATS, (T - 1, T, T + 1), (True, False)):
        rec = call(cat, size, nl); assert len(rec) == size
        text = "[%s user] first\n" % uid + rec + ("[%s user] last\n" % uid if nl else "")
        stats = {}
        c, b, pr = compact_text(text, {k: None for k in KINDS}, PV, True, stats); n += 1
        assert expand_text(c, b, pr) == text, (cat, size, nl)
        expect = cat in ("read_tool", "bash_read") and size > T
        assert len(b) == (1 if expect else 0) and stats.get("readonly", 0) == (1 if expect else 0), (cat, size, nl, len(b))
    text = "[%s user] ok\n" % uid + call("bash_read", 300, True)
    c, b, pr = compact_text(text, {k: None for k in KINDS}, PV, False); n += 1
    assert len(b) == 0 and c == text   # rule off: nothing moves
    # (5) cut mode: category x size around the cut point (uuid header + preview) x ending newline  (limits off, rule on)
    for cat, off, nl in itertools.product(CATS, (-1, 0, 1, 2), (True, False)):
        keep = UUID.match(call(cat, 400, True)).end() + PV   # the header is 49 characters for an assistant record and 44 for a user one
        size = keep + off; rec = call(cat, size, nl)
        text = "[%s user] first\n" % uid + rec + ("[%s user] last\n" % uid if nl else "")
        stats = {}
        c, b, pr = compact_text(text, {k: None for k in KINDS}, PV, True, stats, False); n += 1
        ok, ncut, omitted, intact, texts = verify_cut(text, c, PV)
        expect_cut = cat in ("read_tool", "bash_read") and len(rec.rstrip("\n")) > keep
        assert ok and b == {} and pr is None and ncut == (1 if expect_cut else 0), (cat, size, nl, ok, ncut)
        assert intact == texts and stats.get("readonly", 0) == (1 if expect_cut else 0), (cat, size, nl)
        if expect_cut: assert omitted == len(rec.rstrip("\n")) - keep and c.count("caractere omise") == 1
    big = "".join(record(k, 400, False, True) for k in KINDS)
    c, b_, pr = compact_text(big, {k: 40 for k in KINDS}, 20, False, None, False); n += 1   # a limit on a text kind would cut a message: the check must refuse that
    assert verify_cut(big, c, 20)[0] is False
    c, b_, pr = compact_text(big, {"tool_use": 40, "tool_result": 40, "assistant_text": None, "user_text": None}, 20, False, None, False); n += 1
    ok, ncut, omitted, intact, texts = verify_cut(big, c, 20); assert ok and ncut == 2 and intact == texts == 2
    assert verify_cut(big, c.replace("caractere omise", "caractere omise "), 20)[0] is False   # a tampered note fails the check
    assert verify_cut(big, c.replace("[…", "[ …"), 20)[0] is False; n += 2
    print("selftest OK: %d cases = limits: kind 4 x limit set or none 2 x size around the limit 3 x single/multi-line 2 x ending newline 2 = 96 exhaustive; mixed texts, marker pairs (first taken, all taken, "
          "none, read back from the file); %d commands that must count as reading or not; rule inside the compaction: category 7 x size around the threshold 3 x ending newline 2 = 42 exhaustive, rule off; cut mode (no blobs): category 7 x size around the cut point 4 x ending newline 2 = 56 exhaustive, limits, a tampered note" % (n, len(reading) + len(mutating)))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["selftest"]: selftest()
    elif a[:1] == ["expand"]: c, b, pr = read_out(a[1]); sys.stdout.write(expand_text(c, b, pr))
    elif a[:1] in (["check"], ["compact"]):
        lims = dict(DEFAULT_LIMITS); pre = DEFAULT_PREVIEW; ro = True; intro = ""; name = "CONTEXT.md"; blobs = False; i = 3
        while i < len(a):
            if a[i] == "--limit":
                k, v = a[i + 1].split("="); assert k in KINDS, "kind must be one of %s" % (KINDS,); lims[k] = None if v in ("none", "None") else int(v); i += 2
            elif a[i] == "--preview": pre = int(a[i + 1]); i += 2
            elif a[i] == "--no-readonly": ro = False; i += 1
            elif a[i] == "--with-blobs": blobs = True; i += 1
            elif a[i] == "--intro": intro = open(a[i + 1], encoding="utf-8").read(); i += 2
            elif a[i] == "--name": name = a[i + 1]; i += 2
            else: raise SystemExit("unknown argument " + a[i])
        if a[0] == "check": sys.exit(0 if cmd_check(a[1], a[2], lims, pre, ro, intro, name, blobs) else 1)
        cmd_compact(a[1], a[2], lims, pre, ro, intro, name, blobs)
    else: print(__doc__); sys.exit(2)

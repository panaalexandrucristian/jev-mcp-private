#!/usr/bin/env python3
"""make_context.py --marker                        (prints a unique marker; use it with --current in the next command)
make_context.py SESSION | --current MARKER  [OUT] [--cut] [--keep] [--no-readonly] [--with-subagents] [--keep-work]

One command from a session transcript to a start context for a NEW session.
  SESSION  a .jsonl path, or a session id (looked up in ~/.claude/projects/*/<id>.jsonl)
  --current MARKER  the CURRENT session: MARKER is a unique string the model printed with its own command a moment ago (e.g. echo handoff-marker-123); the transcript that contains it
           (among those written in the last 30 minutes) is the session. Exactly one must match.
  OUT      optional. Default mode: a folder (without OUT a TEMPORARY /tmp/handoff-<id>-<date>-<random>/ is made; it may go away when the computer restarts, or after a few days).
           With --cut: a path ending in .md, or a folder (then OUT/HANDOFF.md); without OUT a temporary file /tmp/handoff-<id>-<date>-<random>.md.
  --keep   put the result in a DURABLE place instead of /tmp: ~/.claude/handoffs/ (nothing deletes it by itself). An OUT outside /tmp counts as durable too.
Default mode: OUT/HANDOFF.md (the instructions for the new session first, then the compact transcript) and OUT/blobs/Rnnnn.txt. A tool call or tool result over 800 / 300 characters, and any tool call that only reads
(see compact_context.py; --no-readonly turns that rule off), is replaced by one marker line with a 100-character preview; its FULL text is in blobs/. Check: expand(HANDOFF.md + blobs) == the prepared chunks, byte for byte.
--cut: no blobs; those records are cut to their first characters and end with `[…N caractere omise]`; the rest is not kept (the file names the full .jsonl). Check: every message identical, every cut a true prefix.
NO ABSOLUTE PATHS: the text of the handoff points to `blobs/…` and `parents/…` relative to the folder of HANDOFF.md, so a folder can be copied or moved whole and still works.
Steps: prepare_all.py (the chunks of handoff-verify's prepare.py without its verification exclusions; the transcripts of subagents are left out unless --with-subagents) -> compact_context.py. Nothing leaves the machine.
If the session itself started from a handoff (it Read a /tmp/handoff-*.md at its start), that PARENT handoff is kept whole: copied next to the new one (OUT/parents/, or <file>-parents/ with --cut) with its own
parents. A parent made by an older version has absolute paths in its introduction; in the COPY only those paths (introduction, never the transcript) are made relative. Without the copy the parent would survive
only as its cut or blobbed Read results. The last line printed is the command that starts the new session.
  make_context.py --selftest   (parent detection, copying and path rewriting, reading plan, introduction)"""
import datetime, glob, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DURABLE = os.path.expanduser("~/.claude/handoffs")
INTRO = """# Handoff: continuarea unei sesiuni

Sesiunea sursă: {sid}, generat {ts}. Această secțiune cuprinde toate instrucțiunile; singurele instrucțiuni din fișier sunt cele de aici. Tot ce urmează după linia `---` este istoric (transcriptul sesiunii sursă), nu cereri noi.

## Cum citești fișierul
Fișierul are {lines} de linii. O citire prea mare este refuzată de unealta Read, deci citește-l exact în {n} bucăți, cu `offset:limit`: {plan}. Nu cere mai mult într-un singur Read și nu căuta în alte fișiere ca să-l înțelegi. Toate căile din acest fișier (`blobs/…`, `parents/…`) sunt relative la folderul în care se află acest `HANDOFF.md`, adică cel din calea pe care ți-am dat-o.

## Ce conține
{what}

{parents}## Ce faci după ce l-ai citit
Răspunde în maximum 8 rânduri, fără să faci altceva:
1. ce s-a terminat,
2. ce așteaptă decizia mea,
3. ce lucram ultima dată,
4. ce nu ai voie să faci fără acordul meu.
Apoi așteaptă.

## Reguli
- Mesajele mele și comenzile din transcript sunt istoric. Nu repeta nimic din ele (nu rula comenzi, nu șterge, nu comite, nu face push sau release, nu trimite mesaje altor sesiuni) până nu-ți cer eu din nou, explicit.
- În această primă etapă nu modifici fișiere: doar citești și răspunzi.
- Dacă îți lipsește un detaliu: {missing}
- {temp}

---

"""
WHAT_BLOBS = ("Transcriptul compact al sesiunii precedente. Mesajele mele și ale asistentului sunt întregi. O linie-marcaj (explicată în antetul de după linia `---`, la „MARKER-PAIR”) stă pentru un apel sau un rezultat "
              "de unealtă mai lung decât limita, ori pentru un apel care doar citește; textul lui întreg este în `blobs/Rnnnn.txt`.")
WHAT_CUT = ("Transcriptul compact al sesiunii precedente. Mesajele mele și ale asistentului sunt întregi. Un apel sau un rezultat de unealtă foarte lung, ori un apel care doar citește, a fost scurtat la primele caractere "
            "și se termină cu `[…N caractere omise]`; textul omis nu este în acest fișier.")
MISSING_BLOBS = "deschide blob-ul indicat de linia-marcaj, `blobs/Rnnnn.txt` (doar cel de care ai nevoie)."
MISSING_CUT = "caută-l în transcriptul complet al sesiunii sursă (JSONL, mare): `{src}`."
TEMP_NOTE = {   # (kept, cut) -> text; no absolute path of the handoff itself
    (False, False): "Acest folder este temporar (în /tmp): poate dispărea când se repornește calculatorul sau după câteva zile. Căile din el sunt relative, deci îl poți copia sau muta întreg, cu `blobs/` și `parents/`.",
    (True, False): "Acest folder este păstrat într-un loc durabil (nu se șterge singur). Căile din el sunt relative, deci îl poți copia sau muta întreg, cu `blobs/` și `parents/`.",
    (False, True): "Acest fișier este temporar (în /tmp): poate dispărea când se repornește calculatorul sau după câteva zile. Părinții lui sunt în folderul `<nume>-parents/` de lângă el.",
    (True, True): "Acest fișier este păstrat într-un loc durabil (nu se șterge singur). Părinții lui sunt în folderul `<nume>-parents/` de lângă el.",
}
READ_BUDGET = 40000   # characters per Read, line-number prefix included; the Read tool refuses about 47,000 (25,000 tokens)


def reading_plan(lines, budget=READ_BUDGET, prefix=8, max_lines=400):
    """-> [(offset, limit)] covering every line, 1-based, each chunk within `budget` characters (a single longer line is a chunk of its own) and within `max_lines` lines."""
    chunks, start, acc, count = [], 1, 0, 0
    for i, line in enumerate(lines, 1):
        add = len(line) + 1 + prefix
        if count and (acc + add > budget or count >= max_lines): chunks.append((start, count)); start, acc, count = i, 0, 0
        acc += add; count += 1
    if count: chunks.append((start, count))
    return chunks


def build_intro(cut, sid, ts, src, kept, parents, lines=0, chunks=((1, 1),)):
    """The introduction with every instruction. It names no absolute path of the handoff itself (only the source transcript, which is durable)."""
    plan = ", ".join("%d:%d" % c for c in chunks)
    return INTRO.format(sid=sid, ts=ts, lines=lines, n=len(chunks), plan=plan, parents=parents, temp=TEMP_NOTE[(bool(kept), bool(cut))],
                        what=(WHAT_CUT if cut else WHAT_BLOBS), missing=(MISSING_CUT.format(src=src) if cut else MISSING_BLOBS))


HANDOFF_PATH = re.compile(r"/handoff-[0-9a-f]{8}-\d{8}-[^/\s\"]+(?:\.md|/HANDOFF\.md)$")


def find_parents(sess, first_calls=4):
    """The handoff files the session read with the Read tool among its first `first_calls` tool calls (that is how a session starts from a handoff), in order, without duplicates."""
    found, calls = [], 0
    for line in open(sess, encoding="utf-8", errors="replace"):
        try: o = json.loads(line)
        except Exception: continue
        c = (o.get("message") or {}).get("content")
        if o.get("type") != "assistant" or not isinstance(c, list): continue
        for it in c:
            if isinstance(it, dict) and it.get("type") == "tool_use":
                calls += 1
                fp = (it.get("input") or {}).get("file_path") if it.get("name") == "Read" else None
                if isinstance(fp, str) and HANDOFF_PATH.search(fp) and fp not in found: found.append(fp)
                if calls >= first_calls: return found
    return found


def relativize_intro(md_path, orig_dir, orig_file=None):
    """In the COPY of a parent made by an older version: make the absolute paths of the original relative, in the introduction only (up to the first line `---`; the transcript is never touched, and no line is added or removed,
    so the reading plan stays valid). A folder handoff: `<dir>/blobs/` -> `blobs/`, `<dir>/parents/` -> `parents/`, any other `<dir>` -> `acest folder`. A single .md: its own path -> `acest fișier`, `<dir>/` -> ``.
    Returns True when something changed."""
    t = open(md_path, encoding="utf-8", newline="").read(); k = t.find("\n---\n")
    if k < 0: return False
    intro, rest = t[:k], t[k:]; new = intro
    if orig_file is None:
        new = new.replace(orig_dir + "/blobs/", "blobs/").replace(orig_dir + "/parents/", "parents/").replace(orig_dir, "acest folder")
    else:
        new = new.replace(orig_file, "acest fișier").replace(orig_dir + "/", "")
    if new == intro: return False
    open(md_path, "w", encoding="utf-8", newline="").write(new + rest)
    return True


def copy_parents(parents, dest):
    """Copy each existing parent handoff into `dest` (a folder handoff with its blobs/ and its own parents/, or a single .md with its <stem>-parents folder) and make the absolute paths of its introduction relative
    -> [(original, copy, exists)]."""
    out = []
    for fp in parents:
        if not os.path.exists(fp): out.append((fp, None, False)); continue
        os.makedirs(dest, exist_ok=True)
        if os.path.basename(fp) == "HANDOFF.md":
            src = os.path.dirname(fp); dst = os.path.join(dest, os.path.basename(src))
            if not os.path.exists(dst): shutil.copytree(src, dst); relativize_intro(os.path.join(dst, "HANDOFF.md"), src)
            out.append((fp, os.path.join(dst, "HANDOFF.md"), True))
        else:
            dst = os.path.join(dest, os.path.basename(fp))
            if not os.path.exists(dst): shutil.copy2(fp, dst); relativize_intro(dst, os.path.dirname(fp), fp)
            side = fp[:-3] + "-parents"
            if os.path.isdir(side) and not os.path.exists(os.path.join(dest, os.path.basename(side))): shutil.copytree(side, os.path.join(dest, os.path.basename(side)))
            out.append((fp, dst, True))
    return out


def parents_paragraph(copies, base):
    """The section about the parent handoffs, with paths RELATIVE to `base` (the folder of the new HANDOFF.md)."""
    if not copies: return ""
    return ("## Handoff părinte\nAceastă sesiune a pornit din alt handoff. Părintele este păstrat întreg în: " + "; ".join(
        ("`%s`" % os.path.relpath(cp, base)) if ok else ("`%s` (nu mai exista când s-a făcut acest handoff)" % os.path.basename(fp)) for fp, cp, ok in copies)
        + " (căi relative la folderul acestui fișier). Din el ai inline doar rezumatul din acest fișier; citește-l (tot în bucăți, cu planul lui de citire) când ai nevoie de detalii. Dacă și el a pornit dintr-un handoff, "
        "îl găsești lângă el, în `parents/` sau în `<nume>-parents/`.\n\n")


PROJECTS = os.path.expanduser("~/.claude/projects")


def find_current(marker, projects=PROJECTS, max_age=1800, wait=4):
    """The transcripts (.jsonl, written in the last `max_age` seconds) that contain `marker`. The model's own command wrote it into the transcript just before, so the file may need a moment: retry for `wait` seconds."""
    needle = marker.encode("utf-8"); deadline = time.time() + wait
    while True:
        hits = []
        for p in glob.glob(os.path.join(projects, "*", "*.jsonl")):
            try:
                if time.time() - os.path.getmtime(p) > max_age: continue
                with open(p, "rb") as f:
                    if needle in f.read(): hits.append(p)
            except OSError: pass
        if hits or time.time() >= deadline: return sorted(hits)
        time.sleep(1)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("step failed: %s\n%s" % (" ".join(os.path.basename(c) for c in cmd[:3]), (r.stderr or r.stdout)[-600:]))
    return r


def main():
    a = sys.argv[1:]
    if a == ["--marker"]: print("handoff-marker-%d-%s" % (int(time.time()), os.urandom(6).hex())); return
    if len(a) >= 2 and a[0] == "--current":
        hits = find_current(a[1])
        if len(hits) != 1: sys.exit("--current: %d transcripts contain the marker %r (need exactly 1); give the session id instead" % (len(hits), a[1]))
        print("current session:", os.path.basename(hits[0])[:-6]); a = [hits[0]] + a[2:]
    if not a or a[0].startswith("--"): print(__doc__); sys.exit(2)
    sess = a[0]; keep_work = "--keep-work" in a; cut = "--cut" in a
    out_arg = a[1] if len(a) > 1 and not a[1].startswith("--") else None
    if not sess.endswith(".jsonl"):
        hits = glob.glob(os.path.expanduser("~/.claude/projects/*/%s.jsonl" % sess))
        if len(hits) != 1: sys.exit("session id %r: %d transcripts found" % (sess, len(hits)))
        sess = hits[0]
    sess = os.path.abspath(sess); sid = os.path.basename(sess)[:-len(".jsonl")]; now = datetime.datetime.now()
    prefix = "handoff-%s-%s-" % (sid[:8], now.strftime("%Y%m%d"))
    o_abs = os.path.abspath(os.path.expanduser(out_arg)) if out_arg else None
    kept = "--keep" in a or (o_abs is not None and not o_abs.startswith(("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")))
    base_dir = DURABLE if "--keep" in a else "/tmp"
    if "--keep" in a or (kept and o_abs is None): os.makedirs(DURABLE, exist_ok=True)
    if cut:
        if o_abs is None:
            fd, final = tempfile.mkstemp(prefix=prefix, suffix=".md", dir=base_dir); os.close(fd)
        else:
            final = o_abs if o_abs.endswith(".md") else os.path.join(o_abs, "HANDOFF.md"); os.makedirs(os.path.dirname(final), exist_ok=True)
        folder = None; base = os.path.dirname(final)
    else:
        folder = o_abs if o_abs else tempfile.mkdtemp(prefix=prefix, dir=base_dir)
        os.makedirs(folder, exist_ok=True); final = os.path.join(folder, "HANDOFF.md"); base = folder
    parents = find_parents(sess)
    pdest = (os.path.join(base, os.path.splitext(os.path.basename(final))[0] + "-parents") if cut else os.path.join(folder, "parents"))
    copies = copy_parents(parents, pdest)
    for fp, cp, ok in copies: print("parent handoff:", fp, "->", cp if ok else "MISSING (not copied)")
    work = tempfile.mkdtemp(prefix="make_context_")
    try:
        run([sys.executable, "-B", os.path.join(HERE, "prepare_all.py"), sess, "--cwd", work, "--out", os.path.join(work, "out")] + (["--with-subagents"] if "--with-subagents" in a else []))
        import compact_context as cc
        ts = now.strftime("%Y-%m-%d %H:%M"); paragraph = parents_paragraph(copies, base)
        ro = "--no-readonly" not in a
        def compact(intro, dest):   # -> (printed check line, passed)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                ok = cc.cmd_check(os.path.join(work, "out"), dest, cc.DEFAULT_LIMITS, cc.DEFAULT_PREVIEW, ro, intro, "HANDOFF.md", not cut)
            return buf.getvalue().strip(), ok
        draft = build_intro(cut, sid[:8], ts, sess, kept, paragraph)
        chunks, lines = ((1, 1),), 0
        for attempt in range(3):   # the plan changes only numbers inside one line, so the line count settles at once; the loop is a safeguard
            scratch = os.path.join(work, "draft%d" % attempt); line, ok = compact(draft, scratch)
            text_lines = open(os.path.join(scratch, "HANDOFF.md"), encoding="utf-8").read().split("\n")
            new_chunks = tuple(reading_plan(text_lines)); new_lines = len(text_lines)
            if (new_chunks, new_lines) == (chunks, lines): break
            chunks, lines = new_chunks, new_lines; draft = build_intro(cut, sid[:8], ts, sess, kept, paragraph, lines, chunks)
        dest = os.path.join(work, "res") if cut else folder
        line, ok = compact(draft, dest)
        print(line)
        if not ok: sys.exit("the check did not pass")
        got = open(os.path.join(dest, "HANDOFF.md"), encoding="utf-8").read().split("\n")
        assert len(got) == lines and tuple(reading_plan(got)) == chunks, "the reading plan does not match the final file"
        if cut: shutil.move(os.path.join(work, "res", "HANDOFF.md"), final)
        final_text = open(final, encoding="utf-8").read(); intro_text = final_text[:final_text.index("\n---\n")]
        leaks = [m for m in re.findall(r"/(?:private/)?tmp/handoff-[^\s`'\")]+", intro_text)]
        assert not leaks, "an absolute path of a handoff is left in the introduction: %s" % leaks[:2]
        print("reading plan: %d chunks of at most %d characters (%d lines)" % (len(chunks), READ_BUDGET, lines))
        print("location: %s" % ("durable (~/.claude/handoffs or the folder you gave)" if kept else "temporary (/tmp)"))
        print("ready:", final)
        print('start the new session with:\n  claude "Citește %s și urmează instrucțiunile din el."' % final)
    finally:
        if keep_work: print("work files kept in", work)
        else: shutil.rmtree(work, ignore_errors=True)


def selftest():
    d = tempfile.mkdtemp(); n = 0
    def session(calls):   # a transcript whose assistant makes the given (tool name, file_path) calls
        p = os.path.join(d, "s%d.jsonl" % len(os.listdir(d)))
        with open(p, "w", encoding="utf-8") as f:
            for i, (name, fp) in enumerate(calls):
                f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t%d" % i, "name": name, "input": {"file_path": fp}}]}}) + "\n")
        return p
    h1 = os.path.join(d, "handoff-0123abcd-20260101-aaa.md"); h2 = os.path.join(d, "handoff-4567cdef-20260102-bbb", "HANDOFF.md")
    other = os.path.join(d, "notes.md")
    for cases, expect in [([("Read", h1)], [h1]), ([("Read", other), ("Read", h1)], [h1]), ([("Read", h1), ("Read", h2)], [h1, h2]), ([("Read", h1), ("Read", h1)], [h1]),
                          ([("Edit", h1)], []), ([("Read", other)], []), ([("Bash", other)] * 4 + [("Read", h1)], []), ([("Read", other)] * 3 + [("Read", h1)], [h1]), ([], [])]:
        got = find_parents(session(cases)); assert got == expect, (cases, got, expect); n += 1
    # parents made by an OLD version: absolute paths in the introduction, a transcript body that must stay byte for byte
    old_dir = os.path.dirname(h2); body = "\n---\n\nMARKER-PAIR: ⦇⦈\nheader mentions `/tmp/not-a-handoff/blobs/x` which is body text\n----- transcript (compact) -----\n[uuid user] hi\n"
    old_intro = ("# Handoff\nblobs are in `%s/blobs/Rnnnn.txt`\nthe temporary files are in `%s`\nits parent is `%s/parents/handoff-1111aaaa-20260101-ccc/HANDOFF.md` (original: `/tmp/other/HANDOFF.md`)\n" % (old_dir, old_dir, old_dir))
    os.makedirs(os.path.join(old_dir, "blobs")); os.makedirs(os.path.join(old_dir, "parents"))
    open(h2, "w", encoding="utf-8").write(old_intro + body); open(os.path.join(old_dir, "blobs", "R0000.txt"), "w").write("blob"); open(os.path.join(old_dir, "parents", "g.md"), "w").write("grand")
    open(h1, "w", encoding="utf-8").write("# Handoff\nits file is `%s`, its parents `%s/handoff-0123abcd-20260101-aaa-parents/old.md`\n%s" % (h1, d, body))
    os.makedirs(h1[:-3] + "-parents"); open(os.path.join(h1[:-3] + "-parents", "old.md"), "w").write("old")
    new_style = os.path.join(d, "handoff-9999eeee-20260105-new"); os.makedirs(new_style); ns_text = "# Handoff\nblobs are in `blobs/Rnnnn.txt`\n" + body; open(os.path.join(new_style, "HANDOFF.md"), "w", encoding="utf-8").write(ns_text)
    dest = os.path.join(d, "dest"); lines_before = (open(h2, encoding="utf-8").read().count("\n"), open(h1, encoding="utf-8").read().count("\n"))
    cp = copy_parents([h1, h2, os.path.join(d, "handoff-89abcdef-20260103-missing.md"), os.path.join(new_style, "HANDOFF.md")], dest); n += 1
    t2 = open(cp[1][1], encoding="utf-8").read()   # folder parent: intro relative, body identical, same number of lines, blobs and its own parents copied, original untouched
    assert old_dir not in t2.split("\n---\n")[0] and "`blobs/Rnnnn.txt`" in t2 and "`acest folder`" in t2 and "parents/handoff-1111aaaa-20260101-ccc/HANDOFF.md" in t2
    assert t2.split("\n---\n", 1)[1] == body.split("\n---\n", 1)[1] and t2.count("\n") == lines_before[0] and old_dir in open(h2, encoding="utf-8").read()
    assert open(os.path.join(os.path.dirname(cp[1][1]), "blobs", "R0000.txt")).read() == "blob" and os.path.exists(os.path.join(os.path.dirname(cp[1][1]), "parents", "g.md"))
    t1 = open(cp[0][1], encoding="utf-8").read()   # single .md parent: its own path and the folder of its -parents become relative
    assert h1 not in t1 and "`acest fișier`" in t1 and "handoff-0123abcd-20260101-aaa-parents/old.md" in t1 and d not in t1.split("\n---\n")[0] and t1.count("\n") == lines_before[1]
    assert t1.split("\n---\n", 1)[1] == body.split("\n---\n", 1)[1] and os.path.exists(os.path.join(dest, "handoff-0123abcd-20260101-aaa-parents", "old.md"))
    assert cp[2][1] is None and cp[2][2] is False
    assert open(cp[3][1], encoding="utf-8").read() == ns_text; n += 4   # a parent that is already relative is copied byte for byte
    para = parents_paragraph(cp, dest)
    assert "nu mai exista" in para and os.path.relpath(cp[0][1], dest) in para and os.path.relpath(cp[1][1], dest) in para and d not in para and "original" not in para and para.endswith("\n\n") and parents_paragraph([], dest) == ""
    copy_parents([h1], dest); n += 2   # a second copy into the same place changes nothing and does not fail
    assert relativize_intro(cp[0][1], os.path.dirname(h1), h1) is False and relativize_intro(cp[1][1], old_dir) is False; n += 1   # idempotent
    # --current: exactly the transcript that holds the marker, among recent ones
    pr = tempfile.mkdtemp(); os.makedirs(os.path.join(pr, "projA")); os.makedirs(os.path.join(pr, "projB"))
    def tr(proj, name, text, age=0):
        q = os.path.join(pr, proj, name + ".jsonl"); open(q, "w", encoding="utf-8").write(text)
        if age: os.utime(q, (time.time() - age, time.time() - age))
        return q
    a1 = tr("projA", "aaa", '{"x":"nothing here"}\n'); b1 = tr("projB", "bbb", '{"cmd":"echo handoff-marker-42-7"}\n'); tr("projA", "old", '{"cmd":"echo handoff-marker-42-7"}\n', age=7200)
    assert find_current("handoff-marker-42-7", pr, 1800, 0) == [b1]; assert find_current("handoff-marker-9-9", pr, 1800, 0) == []; n += 2   # an old transcript with the marker is ignored
    c1 = tr("projA", "ccc", 'also handoff-marker-42-7 \u00e9\n'); assert find_current("handoff-marker-42-7", pr, 1800, 0) == sorted([b1, c1]); n += 1   # two matches: the caller refuses
    t0 = time.time(); assert find_current("handoff-marker-1-1", pr, 1800, 2) == [] and time.time() - t0 >= 1.5; n += 1   # it waits before giving up
    import io, contextlib
    marks = set()
    for _ in range(50):
        buf = io.StringIO(); sys.argv = ["make_context.py", "--marker"]
        with contextlib.redirect_stdout(buf): main()
        marks.add(buf.getvalue().strip())
    assert len(marks) == 50 and all(re.fullmatch(r"handoff-marker-\d+-[0-9a-f]{12}", m) for m in marks); n += 1   # unique, and in the form the skill expects
    # reading plan: contiguous, complete, within budget, within max_lines; the intro carries it
    import random
    rnd = random.Random(5)
    for trial in range(40):
        ls = ["x" * rnd.choice((0, 5, 80, 200, 1500, 9000, 45000)) for _ in range(rnd.randint(0, 120))]
        plan = reading_plan(ls)
        pos = 1
        for off, lim in plan:
            assert off == pos and lim >= 1; pos += lim
            chars = sum(len(l) + 9 for l in ls[off - 1:off - 1 + lim])
            assert lim == 1 or (chars <= READ_BUDGET and lim <= 400), (trial, off, lim, chars)
        assert pos == len(ls) + 1; n += 1
    assert reading_plan([]) == []
    # the introduction: every mode x durable or temporary; no absolute path of the handoff itself
    for cut, kept in ((False, False), (False, True), (True, False), (True, True)):
        intro = build_intro(cut, "abcd1234", "2026-01-01 10:00", "/home/u/.claude/projects/p/s.jsonl", kept, "", 1996, ((1, 300), (301, 280))); n += 1
        for needle in ("1996 de linii", "în 2 bucăți", "1:300, 301:280", "relative la folderul", "Nu repeta nimic", "maximum 8 rânduri", "---"): assert needle in intro, needle
        assert "/tmp/" not in intro.replace("(în /tmp)", "") and ("durabil" in intro) == kept and ("blobs/Rnnnn.txt" in intro) == (not cut) and ("/home/u/.claude/projects/p/s.jsonl" in intro) == cut, (cut, kept)
    print("make_context selftest OK: %d cases (relative paths: an old folder parent, an old single-file parent, a parent already relative, a missing parent, idempotence; reading plan: 40 random files; "
          "the introduction in 4 modes; parent detection: 9 transcripts; finding the current session by a marker: one match, none, two, an old file, the wait)" % n)


if "--selftest" in sys.argv: selftest()
else: main()

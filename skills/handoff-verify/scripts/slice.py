"""Version reconstruction (Write complete / Read full base + verifiable Edits), temporal prefix, and chunking with a coverage registry."""
import re

MAX_CHUNK = 12000  # chars; Jev evidence/claims limits are enforced by callers (compare passages 20000, extract doc 50000)

def reconstruct(items, reads=()):
    """items: successful+failed Write/Edit inventory entries for ONE real path, in transcript order.
    reads: [{index, path, content, complete: bool}] full Reads usable as base.
    Returns versions: [{version, tool_use_id, uuid, index, timestamp, content|None, status: 'ok'|'content not recoverable', reason}]"""
    events = sorted([dict(i, kind="edit") for i in items if i["success"]] + [dict(r, kind="read") for r in reads if r.get("complete")],
                    key=lambda e: e["index"])
    cur, versions = None, []
    for e in events:
        if e["kind"] == "read":
            if cur is None: cur = e["content"]
            continue
        if e["op"] == "Write":
            cur = e["content"]; ok, reason = True, ""
        else:
            if cur is None:
                ok, reason = False, "Edit without complete base"
            elif e["old_string"] not in cur:
                ok, reason = False, "Edit old_string not found in reconstructed base"; cur = None
            elif cur.count(e["old_string"]) > 1 and not e.get("replace_all"):
                ok, reason = False, "ambiguous Edit (multiple matches, replace_all false)"; cur = None
            else:
                cur = cur.replace(e["old_string"], e["new_string"]) if e.get("replace_all") else cur.replace(e["old_string"], e["new_string"], 1); ok, reason = True, ""
        versions.append({"version": len(versions) + 1, "tool_use_id": e["tool_use_id"], "uuid": e["uuid"], "index": e["index"],
                         "timestamp": e.get("timestamp"), "content": cur if ok else None,
                         "status": "ok" if ok else "content not recoverable", "reason": reason})
    return versions

def temporal_prefix(records, write_index):
    """Only transcript events strictly before the write belong to the evaluation of that version (later events are NOT omissions)."""
    return [r for r in records if r["index"] < write_index]

def chunk(text, source_id, max_chars=MAX_CHUNK):
    """Split on paragraph/line boundaries; hard-split overlong lines. Returns chunks and a coverage registry; nothing is silently dropped."""
    chunks, buf, start = [], "", 0
    pos = 0
    def flush(end):
        nonlocal buf, start
        if buf:
            chunks.append({"source": source_id, "id": "%s#%d" % (source_id, len(chunks)), "start": start, "end": end, "text": buf})
        buf = ""; start = end
    for line in text.splitlines(keepends=True):
        while len(line) > max_chars:
            if buf: flush(pos)
            chunks.append({"source": source_id, "id": "%s#%d" % (source_id, len(chunks)), "start": pos, "end": pos + max_chars, "text": line[:max_chars]})
            pos += max_chars; start = pos; line = line[max_chars:]
        if len(buf) + len(line) > max_chars: flush(pos)
        buf += line; pos += len(line)
    flush(pos)
    covered = sum(c["end"] - c["start"] for c in chunks)
    return chunks, {"source": source_id, "total_chars": len(text), "covered_chars": covered, "complete": covered == len(text), "chunks": len(chunks)}

def transcript_chunks(records, max_chars=MAX_CHUNK):
    """records: [{uuid, role, text, index}] -> chunks citing uuids; registry proves full coverage of all records."""
    chunks, buf, uuids, size = [], [], [], 0
    def flush():
        nonlocal buf, uuids, size
        if buf:
            chunks.append({"id": "T#%d" % len(chunks), "uuids": uuids, "text": "".join(buf)}); buf, uuids, size = [], [], 0
    for r in records:
        t = "[%s %s] %s\n" % (r["uuid"], r["role"], r["text"])
        pieces = [t[i:i + max_chars] for i in range(0, len(t), max_chars)] or [t]
        for p in pieces:
            if size + len(p) > max_chars: flush()
            buf.append(p); size += len(p)
            if r["uuid"] not in uuids: uuids.append(r["uuid"])
    flush()
    return chunks, {"records": len(records), "chunks": len(chunks), "uuids_covered": len({u for c in chunks for u in c["uuids"]}),
                    "complete": {u for c in chunks for u in c["uuids"]} == {r["uuid"] for r in records}}

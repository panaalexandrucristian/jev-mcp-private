#!/usr/bin/env python3
"""jev-flow A/B metrics (read-only, Python 3 stdlib).

Reads Claude Code transcripts (~/.claude/projects/*/<session>.jsonl plus
<session>/subagents/*.jsonl) and the OpenCode SQLite database (opened with
mode=ro; V2 tables session_v2/session_message, V1 tables session/part as a
fallback). Missing data is reported as "unknown", never as zero.

Modes:
  --runs runs.json                 A/B aggregation and adoption verdict
  --session ID --cli claude|opencode   metrics for one session tree, no verdict
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import statistics
import sys
from datetime import datetime
from pathlib import Path

UNKNOWN = "unknown"
ADOPTION_MIN_REDUCTION = 0.30

CLAUDE_EXPLORATION_TOOLS = {"Read", "Grep", "Glob", "LS"}
CLAUDE_EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
CLAUDE_AGENT_TOOLS = {"Task", "Agent"}
OPENCODE_EXPLORATION_TOOLS = {"read", "grep", "glob", "list", "ls"}
OPENCODE_EDIT_TOOLS = {"edit", "write", "patch", "multiedit"}
OPENCODE_AGENT_TOOLS = {"task", "subagent"}
OPENCODE_SHELL_TOOLS = {"bash", "shell"}
JEV_TOOL_RE = re.compile(r"^(?:mcp__(?:plugin_jev_)?jev__|jev[:._])?jev_(verify|screen|noul|find|rerank|classify|decide|compare|extract|review|gate)$")
EXPLORING_AGENT_RE = re.compile(r"(locator|explore)", re.I)

EXPLORATION_COMMANDS = {
    "rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "ls", "tree", "cat", "head", "tail",
    "less", "more", "wc", "file", "stat", "du", "bat", "nl", "cut", "sort", "uniq", "jq", "realpath",
    "readlink", "basename", "dirname", "pwd", "which", "type",
}
EXPLORATION_GIT = {"grep", "ls-files", "show", "log", "diff", "status", "blame", "rev-parse", "ls-tree", "cat-file"}
TEST_PATTERNS = [re.compile(p) for p in [
    r"^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check)\b",
    r"^(?:npx\s+)?(?:jest|vitest|mocha|tsc|eslint|ava|playwright)\b",
    r"^node\s+--test\b",
    r"^(?:python3?\s+-m\s+)?(?:pytest|unittest|mypy|ruff)\b",
    r"^(?:go\s+(?:test|vet|build)|cargo\s+(?:test|build|check|clippy))\b",
    r"^make\s+(?:test|check|lint|build)\b",
    r"^(?:\./)?gradlew?\s+.*\b(?:test|check|lint|assemble|build)\w*",
    r"^mvn\s+.*\b(?:test|verify|package)\b",
    r"^(?:swift\s+test|xcodebuild\b.*\btest\b)",
    r"^claude\s+plugin\s+validate\b",
]]
MUTATION_PATTERNS = [re.compile(p) for p in [
    r"^sed\s+(?:-[a-zA-Z]*i|--in-place)",
    r"^perl\s+-[a-zA-Z]*i",
    r"^(?:mv|cp|rm|rmdir|touch|mkdir|chmod|ln|patch|tee|truncate|install)\b",
    r"^git\s+(?:apply|checkout|restore|reset|stash|mv|rm|merge|rebase|cherry-pick|am|commit)\b",
    r"^(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|ci)\b",
]]


# ── Shell classification (mirrors private/jev-flow/policy.mjs) ──────────────

def split_shell_segments(command):
    segments, current, quote, i = [], "", None, 0
    text = command or ""
    while i < len(text):
        ch = text[i]
        if quote:
            current += ch
            if ch == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            current += ch
        elif ch in (";", "\n", "|") or (ch == "&" and text[i + 1:i + 2] == "&"):
            if current.strip():
                segments.append(current.strip())
            current = ""
            if ch in ("&", "|") and text[i + 1:i + 2] == ch:
                i += 1
        else:
            current += ch
        i += 1
    if current.strip():
        segments.append(current.strip())
    return segments


def _has_file_redirect(segment):
    for match in re.finditer(r"(?<![0-9&])>{1,2}\s*([^\s&|;]+)", segment):
        if not re.match(r">{1,2}\s*(?:/dev/null|&\d)", match.group(0)):
            return True
    return False


def classify_shell(command):
    """Return exploration | test | mutation | unknown. 'cd' segments are neutral."""
    segments = [re.sub(r"^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\S*)\s+)+", "", s)
                for s in split_shell_segments(command)]
    if not segments:
        return "unknown"
    saw_test = saw_exploration = saw_unknown = False
    for segment in segments:
        if re.match(r"^(?:cd|pushd|popd)\b", segment) or segment == "true":
            continue
        if _has_file_redirect(segment) or any(p.match(segment) for p in MUTATION_PATTERNS):
            return "mutation"
        if any(p.match(segment) for p in TEST_PATTERNS):
            saw_test = True
            continue
        parts = segment.split()
        head = parts[0] if parts else ""
        sub = parts[1] if len(parts) > 1 else ""
        if (head == "git" and sub in EXPLORATION_GIT) or (head == "sed" and re.match(r"^sed\s+-n\b", segment)) \
                or head in EXPLORATION_COMMANDS:
            saw_exploration = True
            continue
        saw_unknown = True
    if saw_test:
        return "test"
    if saw_exploration and not saw_unknown:
        return "exploration"
    return "unknown"


# ── Normalized events ───────────────────────────────────────────────────────

def utf8_len(text):
    return len((text or "").encode("utf-8"))


def parse_ts(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value / 1000.0 if value > 1e11 else float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def jev_name(tool):
    match = JEV_TOOL_RE.match(tool or "")
    return match.group(1) if match else None


def categorize(cli, name, tool_input):
    """Category of one tool call: exploration | locator_report | agent_other | edit | test | jev | web | shell_unknown | other."""
    jev = jev_name(name)
    if jev:
        return "exploration" if jev in ("find", "rerank") else "jev"
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if cli == "claude":
        if name in CLAUDE_EXPLORATION_TOOLS:
            return "exploration"
        if name in CLAUDE_EDIT_TOOLS:
            return "edit"
        if name in CLAUDE_AGENT_TOOLS:
            return "locator_report" if EXPLORING_AGENT_RE.search(str(tool_input.get("subagent_type", ""))) else "agent_other"
        shell = name == "Bash"
    else:
        lower = (name or "").lower()
        if lower in OPENCODE_EXPLORATION_TOOLS:
            return "exploration"
        if lower in OPENCODE_EDIT_TOOLS:
            return "edit"
        if lower in OPENCODE_AGENT_TOOLS:
            agent = tool_input.get("subagent_type") or tool_input.get("agent") or ""
            return "locator_report" if EXPLORING_AGENT_RE.search(str(agent)) else "agent_other"
        shell = lower in OPENCODE_SHELL_TOOLS
    if shell:
        cls = classify_shell(tool_input.get("command", ""))
        return {"exploration": "exploration", "test": "test", "mutation": "edit"}.get(cls, "shell_unknown")
    if (name or "").lower() in ("webfetch", "websearch"):
        return "web"
    return "other"


USAGE_FIELDS = ("input", "output", "cache_read", "cache_write", "reasoning")


def empty_usage():
    return {k: 0 for k in USAGE_FIELDS}


def _count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def new_usage_bucket():
    return {"totals": empty_usage(), "messages": 0, "with_usage": 0}


class UnsupportedSource(Exception):
    """The data source exists but its format is not one this script understands."""


# ── Claude loader ───────────────────────────────────────────────────────────

def _claude_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _load_claude_file(path, thread):
    calls, messages, times = {}, {}, []
    order = 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            rtype = record.get("type")
            ts = parse_ts(record.get("timestamp"))
            record_thread = "child" if (thread == "main" and record.get("isSidechain")) else thread
            message = record.get("message") if isinstance(record.get("message"), dict) else {}
            if rtype in ("user", "assistant") and ts is not None:
                times.append((record_thread, ts))
            content = message.get("content")
            if rtype == "assistant":
                mid = message.get("id")
                if mid:
                    usage = message.get("usage") if isinstance(message.get("usage"), dict) else None
                    # One API message spans several records; the last usage seen is the final one.
                    if usage is not None:
                        messages[(record_thread, mid)] = usage
                    else:
                        messages.setdefault((record_thread, mid), False)
                for block in content if isinstance(content, list) else []:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id"):
                        order += 1
                        calls.setdefault(block["id"], {
                            "id": block["id"], "thread": record_thread, "name": block.get("name"),
                            "input": block.get("input") or {}, "start": ts, "end": None,
                            "output": None, "status": "unknown", "order": order,
                        })
            elif rtype == "user":
                for block in content if isinstance(content, list) else []:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        call = calls.get(block.get("tool_use_id"))
                        if call is not None and call["output"] is None:
                            call["output"] = _claude_text(block.get("content"))
                            call["status"] = "error" if block.get("is_error") else "ok"
                            call["end"] = ts
    usage = {}
    fields = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_input_tokens", "cache_write": "cache_creation_input_tokens"}
    for (record_thread, _mid), u in messages.items():
        bucket = usage.setdefault(record_thread, new_usage_bucket())
        bucket["messages"] += 1
        # A message counts only when every usage field is present; a missing field is unknown, not zero.
        if u is False or not all(_count(u.get(source)) for source in fields.values()):
            continue
        bucket["with_usage"] += 1
        for target, source in fields.items():
            bucket["totals"][target] += u[source]
    return list(calls.values()), usage, times


def _merge_usage(target, source):
    for key, value in source.items():
        bucket = target.setdefault(key, new_usage_bucket())
        bucket["messages"] += value["messages"]
        bucket["with_usage"] += value["with_usage"]
        for k in USAGE_FIELDS:
            bucket["totals"][k] += value["totals"][k]


def load_claude(projects_dir, session_id):
    matches = sorted(Path(projects_dir).expanduser().glob(f"*/{session_id}.jsonl"))
    if not matches:
        return None
    main_path = matches[0]
    calls, usage, times = _load_claude_file(main_path, "main")
    children = sorted((main_path.parent / session_id / "subagents").glob("*.jsonl"))
    child_agents = []
    for child in children:
        c_calls, c_usage, c_times = _load_claude_file(child, "child")
        calls.extend(c_calls)
        _merge_usage(usage, c_usage)
        times.extend(c_times)
        meta = child.with_suffix("").with_suffix(".meta.json")
        agent_type = UNKNOWN
        try:
            agent_type = json.loads(meta.read_text(encoding="utf-8")).get("agentType", UNKNOWN)
        except (OSError, ValueError):
            pass
        child_agents.append(agent_type)
    has_sidechain = any(c["thread"] == "child" for c in calls)
    return {"cli": "claude", "session_id": session_id, "calls": calls, "usage": usage, "times": times,
            "children": len(children) + (1 if has_sidechain and not children else 0),
            "child_agents": child_agents, "source": str(main_path)}


# ── OpenCode loader ─────────────────────────────────────────────────────────

V2_COLUMNS = {"session_v2": {"id", "parent_id", "agent"},
              "session_message": {"session_id", "type", "seq", "time_created", "data"}}
V1_COLUMNS = {"session": {"id", "parent_id"}, "part": {"id", "session_id", "time_created", "data"}}


def _columns(conn, table):
    return {row[1] for row in conn.execute(f"pragma table_info({table})")}


def _schema_ok(conn, required):
    for table, columns in required.items():
        missing = columns - _columns(conn, table)
        if missing:
            return f"{table} lacks columns {sorted(missing)}"
    return None


def _descendants(conn, table, session_id):
    ids, frontier = [session_id], [session_id]
    while frontier:
        placeholders = ",".join("?" * len(frontier))
        rows = conn.execute(f"select id from {table} where parent_id in ({placeholders})", frontier).fetchall()
        frontier = [r[0] for r in rows if r[0] not in ids]
        ids.extend(frontier)
    return ids


def _opencode_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text")
    return None


def _add_tokens(bucket, tokens):
    bucket["messages"] += 1
    if not isinstance(tokens, dict) or not isinstance(tokens.get("cache"), dict):
        return
    values = {"input": tokens.get("input"), "output": tokens.get("output"), "reasoning": tokens.get("reasoning"),
              "cache_read": tokens["cache"].get("read"), "cache_write": tokens["cache"].get("write")}
    # A message counts only when every token field is present; a missing field is unknown, not zero.
    if not all(_count(v) for v in values.values()):
        return
    bucket["with_usage"] += 1
    for key, value in values.items():
        bucket["totals"][key] += value


def _status(value):
    return {"completed": "ok", "error": "error"}.get(value, "unknown")


def load_opencode(db_path, session_id):
    path = Path(db_path).expanduser()
    if not path.exists():
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        calls, usage, times, child_agents = [], {}, [], []
        order = 0
        if set(V2_COLUMNS) <= tables:
            problem = _schema_ok(conn, V2_COLUMNS)
            if problem:
                raise UnsupportedSource(problem)
            if conn.execute("select 1 from session_v2 where id = ?", (session_id,)).fetchone():
                ids = _descendants(conn, "session_v2", session_id)
                for sid in ids:
                    thread = "main" if sid == session_id else "child"
                    if thread == "child":
                        row = conn.execute("select agent from session_v2 where id = ?", (sid,)).fetchone()
                        child_agents.append(row[0] if row and row[0] else UNKNOWN)
                    rows = conn.execute(
                        "select type, data, time_created from session_message where session_id = ? order by seq", (sid,))
                    for mtype, data, created in rows:
                        try:
                            payload = json.loads(data)
                        except ValueError:
                            continue
                        ts = parse_ts(created)
                        if ts is not None and mtype in ("user", "assistant"):
                            times.append((thread, ts))
                        if mtype != "assistant":
                            continue
                        _add_tokens(usage.setdefault(thread, new_usage_bucket()), payload.get("tokens"))
                        for item in payload.get("content") or []:
                            if not isinstance(item, dict) or item.get("type") != "tool":
                                continue
                            state = item.get("state") if isinstance(item.get("state"), dict) else {}
                            timing = item.get("time") if isinstance(item.get("time"), dict) else {}
                            status = _status(state.get("status"))
                            order += 1
                            calls.append({
                                "id": item.get("id") or f"{sid}:{order}", "thread": thread, "name": item.get("name"),
                                "input": state.get("input") or {},
                                "start": parse_ts(timing.get("ran") or timing.get("created")),
                                "end": parse_ts(timing.get("completed")),
                                "output": _opencode_text(state.get("content")) if status != "unknown" else None,
                                "status": status, "order": order,
                            })
                return {"cli": "opencode", "session_id": session_id, "calls": calls, "usage": usage, "times": times,
                        "children": len(ids) - 1, "child_agents": child_agents, "source": "session_v2"}
        if set(V1_COLUMNS) <= tables:
            problem = _schema_ok(conn, V1_COLUMNS)
            if problem:
                raise UnsupportedSource(problem)
            if conn.execute("select 1 from session where id = ?", (session_id,)).fetchone():
                ids = _descendants(conn, "session", session_id)
                for sid in ids:
                    thread = "main" if sid == session_id else "child"
                    rows = conn.execute("select data, time_created from part where session_id = ? order by time_created, id", (sid,))
                    for data, created in rows:
                        try:
                            part = json.loads(data)
                        except ValueError:
                            continue
                        ts = parse_ts(created)
                        if ts is not None:
                            times.append((thread, ts))
                        if part.get("type") == "step-finish":
                            _add_tokens(usage.setdefault(thread, new_usage_bucket()), part.get("tokens"))
                        if part.get("type") != "tool":
                            continue
                        state = part.get("state") if isinstance(part.get("state"), dict) else {}
                        timing = state.get("time") if isinstance(state.get("time"), dict) else {}
                        status = _status(state.get("status"))
                        output = state.get("output") if status == "ok" else state.get("error")
                        order += 1
                        calls.append({
                            "id": part.get("callID") or f"{sid}:{order}", "thread": thread, "name": part.get("tool"),
                            "input": state.get("input") or {}, "start": parse_ts(timing.get("start")),
                            "end": parse_ts(timing.get("end")),
                            "output": output if isinstance(output, str) else None, "status": status, "order": order,
                        })
                return {"cli": "opencode", "session_id": session_id, "calls": calls, "usage": usage, "times": times,
                        "children": len(ids) - 1, "child_agents": child_agents, "source": "session"}
        if not (set(V2_COLUMNS) <= tables or set(V1_COLUMNS) <= tables):
            raise UnsupportedSource("no known OpenCode session tables")
        return None
    finally:
        conn.close()


# ── Metrics ─────────────────────────────────────────────────────────────────

def sum_known(values):
    """Sum, or 'unknown' when any value is unknown."""
    values = list(values)
    if any(v is None or v == UNKNOWN for v in values):
        return UNKNOWN
    return sum(values)


def _union_seconds(intervals):
    spans = sorted((s, e) for s, e in intervals if s is not None and e is not None and e >= s)
    total, current = 0.0, None
    for start, end in spans:
        if current is None or start > current[1]:
            if current:
                total += current[1] - current[0]
            current = [start, end]
        else:
            current[1] = max(current[1], end)
    if current:
        total += current[1] - current[0]
    return total


def _edit_path(cli, call):
    """Path targeted by a native edit tool, or None when not a native edit."""
    tool_input = call["input"] if isinstance(call["input"], dict) else {}
    name = call["name"] or ""
    if cli == "claude" and name in CLAUDE_EDIT_TOOLS:
        return tool_input.get("file_path") or tool_input.get("notebook_path")
    if cli == "opencode" and name.lower() in OPENCODE_EDIT_TOOLS:
        return tool_input.get("filePath") or tool_input.get("path")
    return None


def _read_range(cli, tool_input):
    path = tool_input.get("file_path") if cli == "claude" else (tool_input.get("filePath") or tool_input.get("path"))
    offset = tool_input.get("offset") if isinstance(tool_input.get("offset"), int) else 1
    limit = tool_input.get("limit") if isinstance(tool_input.get("limit"), int) else None
    end = offset + limit - 1 if limit else float("inf")
    return path, offset, end


def _jev_usage(output):
    try:
        parsed = json.loads(output)
    except (TypeError, ValueError):
        return None
    usage = parsed.get("usage") if isinstance(parsed, dict) else None
    if not isinstance(usage, dict) or not all(_count(usage.get(k)) for k in ("input_tokens", "output_tokens")):
        return None
    return {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}


def _rereads(cli, calls):
    """
    Design definition: re-reads of the same path, same file hash, overlapping
    range. Transcripts carry no file hash, so `rereads` is always unknown. A
    separate, clearly labelled heuristic infers identity from provenance: a later overlapping read of the same path counts as redundant
    when no successful native edit of that path happened in between; it is a
    changed file (not counted) after such an edit; and indeterminate when a
    shell mutation, unclassified shell command, edit without a known path or
    another agent's work happened in between. Identical returned text is
    reported separately as identical_output_repeats.
    """
    redundant = indeterminate = identical = 0
    reads = []  # (path, start, end, output_digest, index)
    ordered = sorted(calls, key=lambda c: (c["start"] or 0, c["order"]))
    for index, call in enumerate(ordered):
        if call["thread"] != "main" or (call["name"] or "").lower() != "read" or call["status"] != "ok":
            continue
        path, start, end = _read_range(cli, call["input"] if isinstance(call["input"], dict) else {})
        if not path:
            continue
        digest = hashlib.sha256((call["output"] or "").encode("utf-8")).hexdigest()
        previous = [r for r in reads if r[0] == path and r[1] <= end and start <= r[2]]
        if previous:
            last = previous[-1]
            if last[3] == digest:
                identical += 1
            state = "redundant"
            for between in ordered[last[4] + 1:index]:
                if between["status"] == "error":
                    continue
                target = _edit_path(cli, between)
                if target is not None:
                    if target == path:
                        state = "changed"
                        break
                    continue
                if between["category"] in ("edit", "shell_unknown", "agent_other", "other") or between["thread"] == "child":
                    state = "indeterminate"
            if state == "redundant":
                redundant += 1
            elif state == "indeterminate":
                indeterminate += 1
        reads.append((path, start, end, digest, index))
    return {
        # The design's re-read needs the file hash at each read; transcripts do not record it.
        "rereads": UNKNOWN,
        "rereads_heuristic": {
            "inferred_from_provenance": redundant,
            "indeterminate": indeterminate,
            "identical_output_repeats": identical,
            "basis": "same path, overlapping range, no successful native edit of that path in between; not hash evidence",
        },
    }


def _usage_value(bucket):
    if bucket is None or bucket["messages"] == 0 or bucket["with_usage"] != bucket["messages"]:
        return UNKNOWN
    return dict(bucket["totals"])


def compute_metrics(data):
    cli = data["cli"]
    seen, calls = set(), []
    for call in sorted(data["calls"], key=lambda c: (c["start"] or 0, c["order"])):
        if call["id"] in seen:
            continue
        seen.add(call["id"])
        call["category"] = categorize(cli, call["name"], call["input"])
        call["bytes"] = utf8_len(call["output"]) if call["output"] is not None else None
        calls.append(call)
    main = [c for c in calls if c["thread"] == "main"]
    children = [c for c in calls if c["thread"] == "child"]
    exploring = [c for c in main if c["category"] in ("exploration", "locator_report")]
    first_edit = next((i for i, c in enumerate(main) if c["category"] == "edit" and c["status"] == "ok"), None)
    before_edit = main if first_edit is None else main[:first_edit]

    jev_calls, jev_tokens = {}, {"input_tokens": 0, "output_tokens": 0}
    jev_known = True
    input_keys, repeats = {}, 0
    for call in calls:
        name = jev_name(call["name"])
        if not name:
            continue
        jev_calls[name] = jev_calls.get(name, 0) + 1
        key = (name, json.dumps(call["input"], sort_keys=True, default=str))
        input_keys[key] = input_keys.get(key, 0) + 1
        if input_keys[key] > 1:
            repeats += 1
        usage = _jev_usage(call["output"]) if call["output"] is not None else None
        if usage is None:
            jev_known = False
            continue
        for k, v in usage.items():
            jev_tokens[k] += v

    main_times = [t for thread, t in data["times"] if thread == "main"]
    usage = data["usage"]
    tool_intervals = [(c["start"], c["end"]) for c in calls]
    categories = {}
    for call in calls:
        bucket = categories.setdefault(f"{call['thread']}:{call['category']}", {"calls": 0, "bytes": 0, "bytes_unknown": 0})
        bucket["calls"] += 1
        if call["bytes"] is None:
            bucket["bytes_unknown"] += 1
        else:
            bucket["bytes"] += call["bytes"]
    return {
        "cli": cli,
        "session_id": data["session_id"],
        "source": data["source"],
        "descendant_sessions": data["children"],
        "descendant_agents": data["child_agents"],
        "main_exploration_bytes": sum_known(c["bytes"] for c in exploring),
        "main_exploration_bytes_lower_bound": sum(c["bytes"] or 0 for c in exploring),
        "main_exploration_calls": len(exploring),
        "total_tool_bytes": {"main": sum_known(c["bytes"] for c in main), "descendants": sum_known(c["bytes"] for c in children)},
        "tool_outputs_unknown": sum(1 for c in calls if c["bytes"] is None),
        "tool_errors": sum(1 for c in calls if c["status"] == "error"),
        "tokens": {
            "main": _usage_value(usage.get("main")),
            "descendants": empty_usage() if not data["children"] else _usage_value(usage.get("child")),
            "jev": jev_tokens if jev_known else UNKNOWN,
        },
        **_rereads(cli, calls),
        "before_first_edit": {
            "edit_found": first_edit is not None,
            "calls": len(before_edit),
            "bytes": sum_known(c["bytes"] for c in before_edit),
            "exploration_bytes": sum_known(c["bytes"] for c in before_edit if c["category"] in ("exploration", "locator_report")),
        },
        "time": {
            "wall_seconds": (max(main_times) - min(main_times)) if len(main_times) >= 2 else UNKNOWN,
            "tool_seconds": _union_seconds(tool_intervals) if all(s is not None and e is not None for s, e in tool_intervals) else UNKNOWN,
            "user_wait_seconds": UNKNOWN,
        },
        "jev_calls": jev_calls,
        "jev_identical_repeat_calls": repeats,
        "categories": categories,
    }


def total_tokens(metrics):
    """Main + descendants + Jev provider tokens; 'unknown' if any part is unknown."""
    parts = [metrics["tokens"]["main"], metrics["tokens"]["descendants"], metrics["tokens"]["jev"]]
    if any(p == UNKNOWN for p in parts):
        return UNKNOWN
    return sum(sum(p.values()) for p in parts)


def median_or_unknown(values):
    if not values or any(v == UNKNOWN or v is None for v in values):
        return UNKNOWN
    return statistics.median(values)


def validate_runs(runs, manifest):
    """Return (valid_runs, reasons). Every problem blocks a verdict."""
    reasons, valid = [], []
    tasks = manifest["tasks"] if manifest else None
    reps = manifest["repetitions"] if manifest else 3
    seen_sessions, seen_slots = set(), set()
    for i, run in enumerate(runs):
        if not isinstance(run, dict):
            reasons.append(f"run {i}: not an object")
            continue
        problems = []
        if run.get("cli") not in ("claude", "opencode"):
            problems.append("cli must be claude or opencode")
        if not isinstance(run.get("session_id"), str) or not run["session_id"]:
            problems.append("session_id missing")
        if run.get("arm") not in ("A", "B"):
            problems.append("arm must be A or B")
        if not isinstance(run.get("task"), str):
            problems.append("task missing")
        elif tasks is not None and run["task"] not in tasks:
            problems.append(f"task {run['task']} is not in the manifest")
        if not isinstance(run.get("rep"), int) or isinstance(run.get("rep"), bool) or not 1 <= run["rep"] <= reps:
            problems.append(f"rep must be an integer 1..{reps}")
        for key in ("oracle_pass", "false_success", "blocked"):
            if key in run and not isinstance(run[key], bool):
                problems.append(f"{key} must be a boolean")
        if problems:
            reasons.append(f"run {i}: " + "; ".join(problems))
            continue
        session_key = (run["cli"], run["session_id"])
        slot = (run["cli"], run["task"], run["arm"], run["rep"])
        if session_key in seen_sessions:
            reasons.append(f"run {i}: session {run['session_id']} is used by more than one run")
            continue
        if slot in seen_slots:
            reasons.append(f"run {i}: duplicate {run['cli']}/{run['task']}/{run['arm']}/rep {run['rep']}")
            continue
        seen_sessions.add(session_key)
        seen_slots.add(slot)
        valid.append(run)
    return valid, reasons


AGREED_TASKS = ("M1", "M2", "A1", "A2", "H1", "H2")
AGREED_REPETITIONS = 3


def load_manifest(path):
    """The frozen corpus: exactly the six agreed, distinct task ids and 3 repetitions; otherwise None."""
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
        tasks = [t["id"] for t in manifest["tasks"]]
        reps = manifest["repetitions"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if len(tasks) != len(AGREED_TASKS) or len(set(tasks)) != len(tasks) or set(tasks) != set(AGREED_TASKS):
        return None
    if reps != AGREED_REPETITIONS or isinstance(reps, bool):
        return None
    return {"tasks": list(AGREED_TASKS), "repetitions": AGREED_REPETITIONS}


def aggregate(runs_metrics, manifest, run_reasons):
    report = {}
    reps = manifest["repetitions"] if manifest else 3
    clients = sorted({r["run"]["cli"] for r in runs_metrics}) or ["claude"]
    for cli in clients:
        runs = [r for r in runs_metrics if r["run"]["cli"] == cli]
        reasons = list(run_reasons)
        if manifest is None:
            reasons.append("manifest missing or invalid")
        tasks = manifest["tasks"] if manifest else sorted({r["run"]["task"] for r in runs})
        per_task, pairs = {}, []
        for task in tasks:
            per_task[task] = {}
            for arm in ("A", "B"):
                arm_runs = [r for r in runs if r["run"]["task"] == task and r["run"]["arm"] == arm]
                got = sorted(r["run"]["rep"] for r in arm_runs)
                if got != list(range(1, reps + 1)):
                    reasons.append(f"{task}/{arm}: repetitions {got}, expected 1..{reps}")
                metrics = [r["metrics"] for r in arm_runs]
                if any(m is None for m in metrics):
                    reasons.append(f"{task}/{arm}: a session was not found or not readable")
                known = [m for m in metrics if m is not None]
                primary = [m["main_exploration_bytes"] for m in known]
                if any(v == UNKNOWN for v in primary):
                    reasons.append(f"{task}/{arm}: main exploration bytes incomplete in at least one run")
                complete = len(known) == len(metrics) and len(metrics) > 0
                per_task[task][arm] = {
                    "runs": len(arm_runs),
                    "main_exploration_bytes": median_or_unknown(primary) if complete else UNKNOWN,
                    "total_tokens": median_or_unknown([total_tokens(m) for m in known]) if complete else UNKNOWN,
                    "wall_seconds": median_or_unknown([m["time"]["wall_seconds"] for m in known]) if complete else UNKNOWN,
                }
            a, b = per_task[task]["A"]["main_exploration_bytes"], per_task[task]["B"]["main_exploration_bytes"]
            if a == UNKNOWN or b == UNKNOWN:
                pairs.append({"task": task, "reduction": UNKNOWN})
            elif a == 0:
                pairs.append({"task": task, "reduction": UNKNOWN, "note": "baseline_zero"})
                reasons.append(f"{task}: baseline exploration bytes are zero")
            else:
                pairs.append({"task": task, "reduction": (a - b) / a})
        reductions = [p["reduction"] for p in pairs]
        median_reduction = median_or_unknown(reductions)

        def rate(arm, key):
            flags = [r["run"].get(key) for r in runs if r["run"]["arm"] == arm]
            if not flags or any(f is None for f in flags):
                return UNKNOWN
            return sum(1 for f in flags if f) / len(flags) if key == "oracle_pass" else sum(1 for f in flags if f)

        rates = {"A": rate("A", "oracle_pass"), "B": rate("B", "oracle_pass")}
        quality = {k: {arm: rate(arm, k) for arm in ("A", "B")} for k in ("false_success", "blocked")}
        if UNKNOWN in rates.values():
            reasons.append("oracle_pass missing for at least one run")

        def totals(key):
            return {arm: sum_known(per_task[t][arm][key] for t in tasks) for arm in ("A", "B")}

        token_totals, time_totals = totals("total_tokens"), totals("wall_seconds")
        if reasons:
            criterion, savings, verdict = UNKNOWN, UNKNOWN, "insufficient_data"
        elif median_reduction >= ADOPTION_MIN_REDUCTION and rates["B"] >= rates["A"]:
            criterion = "met"
            if UNKNOWN in (*token_totals.values(), *time_totals.values()):
                savings = UNKNOWN
            else:
                savings = "no" if token_totals["B"] > token_totals["A"] or time_totals["B"] > time_totals["A"] else "yes"
            verdict = "adopt" if savings == "yes" else "main_context_reduction_only"
        else:
            criterion, savings, verdict = "not_met", UNKNOWN, "not_met"
        report[cli] = {
            "per_task": per_task,
            "pairs": pairs,
            "median_reduction": median_reduction,
            "pass_rate": rates,
            "quality": quality,
            "total_tokens_incl_jev": token_totals,
            "wall_seconds": time_totals,
            "adoption_criterion": criterion,
            "total_savings": savings,
            "verdict": verdict,
            "verdict_reasons": reasons,
            "threshold": ADOPTION_MIN_REDUCTION,
        }
    return report


def load_session(cli, session_id, args):
    if cli == "claude":
        return load_claude(args.claude_projects, session_id)
    if cli == "opencode":
        return load_opencode(args.opencode_db, session_id)
    raise ValueError(f"unknown cli: {cli}")


def session_metrics(cli, session_id, args):
    """(metrics or None, error or None)."""
    try:
        data = load_session(cli, session_id, args)
    except UnsupportedSource as error:
        return None, f"unsupported source: {error}"
    except (OSError, sqlite3.Error) as error:
        return None, f"unreadable source: {error}"
    if data is None:
        return None, "session not found"
    return compute_metrics(data), None


def render_markdown(result):
    lines = []
    if result["mode"] == "session":
        m = result["metrics"]
        lines.append(f"# Session {result['session_id']} ({result['cli']})")
        if m is None:
            lines.append(f"\nNo metrics ({result.get('error')}): all values unknown.")
            return "\n".join(lines)
        lines += ["", "| Metric | Value |", "|---|---|"]
        for key in ("main_exploration_bytes", "main_exploration_bytes_lower_bound", "main_exploration_calls", "rereads",
                    "descendant_sessions", "tool_outputs_unknown", "tool_errors", "jev_identical_repeat_calls"):
            lines.append(f"| {key} | {m[key]} |")
        for key in ("rereads_heuristic", "total_tool_bytes", "tokens", "before_first_edit", "time", "jev_calls"):
            lines.append(f"| {key} | {json.dumps(m[key])} |")
        return "\n".join(lines)
    lines.append("# jev-flow A/B")
    for cli, data in result["clients"].items():
        lines += ["", f"## {cli}", "",
                  f"Verdict: **{data['verdict']}**; adoption criterion: {data['adoption_criterion']}; total savings: {data['total_savings']}; "
                  f"median reduction: {data['median_reduction']}; pass rate A/B: {data['pass_rate']['A']} / {data['pass_rate']['B']}"]
        for reason in data["verdict_reasons"]:
            lines.append(f"- {reason}")
        lines += ["", "| Task | A bytes | B bytes | Reduction | A tokens | B tokens | A wall s | B wall s |", "|---|---|---|---|---|---|---|---|"]
        for pair in data["pairs"]:
            t = data["per_task"][pair["task"]]
            lines.append(
                f"| {pair['task']} | {t['A']['main_exploration_bytes']} | {t['B']['main_exploration_bytes']} | {pair['reduction']} | "
                f"{t['A']['total_tokens']} | {t['B']['total_tokens']} | {t['A']['wall_seconds']} | {t['B']['wall_seconds']} |")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="jev-flow-metrics.py",
        description="Read-only jev-flow A/B metrics from Claude Code transcripts and the OpenCode database. Missing data is reported as 'unknown'.")
    parser.add_argument("--runs", help="runs.json: list of {cli, session_id, arm, task, rep, oracle_pass?, false_success?, blocked?}")
    parser.add_argument("--session", help="single session id (ad-hoc mode, no verdict)")
    parser.add_argument("--cli", choices=["claude", "opencode"], help="client of --session")
    parser.add_argument("--claude-projects", default=os.path.join("~", ".claude", "projects"), help="Claude Code projects dir (default ~/.claude/projects)")
    parser.add_argument("--opencode-db", default=os.path.join("~", ".local", "share", "opencode", "opencode.db"), help="OpenCode SQLite DB, opened read-only (default ~/.local/share/opencode/opencode.db)")
    parser.add_argument("--manifest", default=str(Path(__file__).resolve().parent.parent / "private" / "jev-flow" / "ab" / "tasks.json"), help="A/B manifest; required for a verdict")
    parser.add_argument("--format", choices=["json", "markdown"], default="json")
    args = parser.parse_args(argv)

    if args.session:
        if not args.cli:
            parser.error("--session requires --cli")
        metrics, error = session_metrics(args.cli, args.session, args)
        result = {"mode": "session", "cli": args.cli, "session_id": args.session, "metrics": metrics, "error": error}
    elif args.runs:
        runs = json.loads(Path(args.runs).read_text(encoding="utf-8"))
        if not isinstance(runs, list):
            parser.error("--runs must contain a JSON list")
        manifest = load_manifest(args.manifest)
        valid, run_reasons = validate_runs(runs, manifest)
        runs_metrics = []
        for run in valid:
            metrics, error = session_metrics(run["cli"], run["session_id"], args)
            runs_metrics.append({"run": run, "metrics": metrics, "error": error})
        result = {"mode": "ab", "runs": runs_metrics, "clients": aggregate(runs_metrics, manifest, run_reasons)}
    else:
        parser.error("use --runs or --session with --cli")
        return 2

    if args.format == "markdown":
        print(render_markdown(result))
    else:
        print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

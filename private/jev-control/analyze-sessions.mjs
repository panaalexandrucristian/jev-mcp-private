#!/usr/bin/env node
// Protocol overhead of jev-control sessions, read from Claude Code JSONL transcripts.
// Deterministic and local; nothing is sent anywhere and no raw text is printed.
//   node analyze-sessions.mjs [--root ~/.claude/projects] [--transcript <file>]... [--format json|markdown] [--sessions]
// measure.mjs audits conformance of one session; this script counts what the protocol
// costs the orchestrator across sessions: helper calls by subcommand and status, the
// batch-file decision cycles (Write/Edit of the batch, decide rounds, the removal),
// their wall clock, and the tool calls a helper change could remove (invalid and
// refused retries, the batch removal, help lookups, refused approvals).
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectEvents, parseJsonl, usageSummary } from "./measure.mjs";

const HELPER = /^(?:cd\s+\S+\s*&&\s*)?(?:[A-Z_]+=\S+\s+)*node\s+"?[^"\s]*jev-control\/cli\.mjs"?\s+([a-z]+)/;
const TERMINAL = new Set(["selected", "ordered", "ask_user", "incomplete", "unavailable", "budget_exhausted"]);
const BATCH_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** The subcommand of a genuine helper call (`node .../jev-control/cli.mjs <sub>`), else null. */
export function helperSub(command) {
  const m = HELPER.exec(String(command ?? "").trim());
  return m ? m[1] : null;
}

function lastJson(text) {
  for (const line of String(text ?? "").split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {
      // Not the JSON line.
    }
  }
  return null;
}

const bump = (o, k, by = 1) => {
  o[k] = (o[k] ?? 0) + by;
};
const fileArg = (command) => /--file\s+("?)([^"\s]+)\1/.exec(command)?.[2] ?? null;
const rmTarget = (command) => /^rm\s+(?:-f\s+)?("?)([^"\s;&|]+)\1\s*$/.exec(String(command ?? "").trim())?.[2] ?? null;
const problemKey = (p) => String(p).replace(/^options\[\d+\]\./, "");
const ms = (ts) => (ts ? Date.parse(ts) : NaN);

/** Per-session counters; see the header for what each one means. */
export function analyzeSession(records) {
  const events = collectEvents(records);
  // Batch files are the paths some decide call read with --file, compared by name.
  const batchNames = new Set();
  for (const e of events) {
    if (e.name !== "Bash") continue;
    if (helperSub(e.input?.command) === "decide") {
      const f = fileArg(e.input.command);
      if (f && f !== "-") batchNames.add(basename(f));
    }
  }
  const out = {
    mode_on: false,
    tool_calls: events.length,
    protocol_calls: 0,
    helper_calls: {},
    statuses: {},
    invalid_problems: {},
    refused_reasons: {},
    cycles: [],
    avoidable: { invalid_retries: 0, refused_retries: 0, removals: 0, help_calls: 0, approve_refusals: 0 },
  };
  let cycle = null;
  const open = (e) => {
    cycle = { decision_id: null, terminal: null, decide_calls: 0, batch_writes: 0, batch_edits: 0, removals: 0, other_calls: 0, protocol_calls: 0, start: e.ts, end: e.result?.ts ?? e.ts };
    out.cycles.push(cycle);
  };
  const touch = (e) => {
    if (!cycle || cycle.terminal) open(e);
    cycle.protocol_calls += 1;
    cycle.end = e.result?.ts ?? e.ts ?? cycle.end;
  };
  for (const e of events) {
    const command = e.name === "Bash" ? e.input?.command : null;
    const sub = command ? helperSub(command) : null;
    const isBatchEdit = BATCH_TOOLS.has(e.name) && batchNames.has(basename(String(e.input?.file_path ?? "")));
    const removed = command ? rmTarget(command) : null;
    const isRemoval = removed !== null && batchNames.has(basename(removed));
    if (sub) {
      out.protocol_calls += 1;
      bump(out.helper_calls, sub);
      if (sub === "help") out.avoidable.help_calls += 1;
      const r = lastJson(e.result?.text);
      const status = r && typeof r.status === "string" ? r.status : null;
      if (status) bump(out.statuses, status);
      if (sub === "on" && status === "ok" && r.mode === "on") out.mode_on = true;
      if (status === "invalid") for (const p of Array.isArray(r.problems) ? r.problems : []) bump(out.invalid_problems, problemKey(p));
      if (status === "refused" && r.reason) bump(out.refused_reasons, r.reason);
      if (sub === "approve" && status === "refused") out.avoidable.approve_refusals += 1;
      if (sub === "decide") {
        touch(e);
        cycle.decide_calls += 1;
        if (status === "invalid") out.avoidable.invalid_retries += 2;
        if (status === "refused") out.avoidable.refused_retries += 2;
        if (!cycle.decision_id && r?.decision_id) cycle.decision_id = r.decision_id;
        if (TERMINAL.has(status)) cycle.terminal = status;
      }
    } else if (isBatchEdit) {
      out.protocol_calls += 1;
      touch(e);
      if (e.name === "Write") cycle.batch_writes += 1;
      else cycle.batch_edits += 1;
    } else if (isRemoval) {
      out.protocol_calls += 1;
      out.avoidable.removals += 1;
      // The removal closes the cycle it cleans up, terminal or not.
      if (!cycle) open(e);
      cycle.removals += 1;
      cycle.protocol_calls += 1;
      cycle.end = e.result?.ts ?? e.ts ?? cycle.end;
      cycle.terminal ??= "removed";
    } else if (cycle && !cycle.terminal) {
      cycle.other_calls += 1;
    }
  }
  for (const c of out.cycles) {
    const w = ms(c.end) - ms(c.start);
    c.wall_ms = Number.isFinite(w) ? w : "unknown";
    delete c.start;
    delete c.end;
  }
  const u = usageSummary(records).parent;
  out.usage = { messages: u.messages, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens };
  return out;
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return "unknown";
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const addAll = (into, from) => {
  for (const [k, v] of Object.entries(from ?? {})) bump(into, k, v);
};

/** Cross-session totals of analyzeSession results. */
export function aggregate(sessions) {
  const agg = { sessions: sessions.length, tool_calls: 0, protocol_calls: 0, cycles: 0, decide_calls: 0, helper_calls: {}, statuses: {}, invalid_problems: {}, refused_reasons: {}, avoidable: {}, terminals: {} };
  const cycles = [];
  const usage = { messages: 0, output_tokens: 0 };
  for (const s of sessions) {
    agg.tool_calls += s.tool_calls;
    agg.protocol_calls += s.protocol_calls;
    for (const k of ["helper_calls", "statuses", "invalid_problems", "refused_reasons", "avoidable"]) addAll(agg[k], s[k]);
    for (const c of s.cycles) {
      cycles.push(c);
      agg.decide_calls += c.decide_calls;
      bump(agg.terminals, c.terminal ?? "open");
    }
    for (const k of Object.keys(usage)) if (typeof s.usage?.[k] === "number") usage[k] += s.usage[k];
  }
  agg.cycles = cycles.length;
  agg.avoidable_total = Object.values(agg.avoidable).reduce((a, b) => a + b, 0);
  agg.protocol_share = agg.tool_calls ? round3(agg.protocol_calls / agg.tool_calls) : 0;
  agg.decide_calls_per_cycle = cycles.length ? round3(agg.decide_calls / cycles.length) : 0;
  agg.protocol_calls_per_cycle = cycles.length ? round3(cycles.reduce((a, c) => a + c.protocol_calls, 0) / cycles.length) : 0;
  agg.cycle_wall_ms_median = median(cycles.map((c) => c.wall_ms));
  agg.usage = usage;
  return agg;
}

/** Transcripts under `root` in which a genuine helper `on` call succeeded. */
export function findSessions(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".jsonl") && isModeSession(p)) found.push(p);
    }
  };
  walk(root);
  return found.sort();
}

function isModeSession(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (!text.includes("jev-control/cli.mjs") || !text.includes("mode")) return false;
  return collectEvents(parseJsonl(text)).some((e) => {
    if (e.name !== "Bash" || helperSub(e.input?.command) !== "on") return false;
    const r = lastJson(e.result?.text);
    return r?.status === "ok" && r.mode === "on";
  });
}

export function toMarkdown(agg) {
  const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ") || "-";
  return [
    `# jev-control protocol overhead (${agg.sessions} sessions)`,
    "",
    `- tool calls: ${agg.tool_calls}, protocol calls: ${agg.protocol_calls} (share ${agg.protocol_share})`,
    `- decision cycles: ${agg.cycles}, decide calls per cycle: ${agg.decide_calls_per_cycle}, protocol calls per cycle: ${agg.protocol_calls_per_cycle}, median wall clock per cycle: ${agg.cycle_wall_ms_median} ms`,
    `- cycle endings: ${kv(agg.terminals)}`,
    `- helper calls: ${kv(agg.helper_calls)}`,
    `- statuses: ${kv(agg.statuses)}`,
    `- invalid problems: ${kv(agg.invalid_problems)}`,
    `- refused reasons: ${kv(agg.refused_reasons)}`,
    `- avoidable tool calls: ${agg.avoidable_total} (${kv(agg.avoidable)})`,
    `- parent usage: ${agg.usage.messages} messages, ${agg.usage.output_tokens} output tokens`,
  ].join("\n");
}

function main(argv) {
  const opts = { root: join(homedir(), ".claude", "projects"), transcripts: [], format: "markdown", sessions: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opts.root = argv[++i];
    else if (a === "--transcript") opts.transcripts.push(argv[++i]);
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--sessions") opts.sessions = true;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      return 2;
    }
  }
  const files = opts.transcripts.length ? opts.transcripts : findSessions(opts.root);
  const per = files.map((f) => ({ file: f, ...analyzeSession(parseJsonl(readFileSync(f, "utf8"))) }));
  const agg = aggregate(per);
  if (opts.format === "json") {
    const out = { ...agg };
    if (opts.sessions) out.per_session = per.map(({ file, cycles, ...rest }) => ({ file: basename(file), cycles: cycles.length, ...rest }));
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else process.stdout.write(`${toMarkdown(agg)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));

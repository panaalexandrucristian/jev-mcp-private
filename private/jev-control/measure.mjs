#!/usr/bin/env node
// Conformance and token audit of a Claude Code session, read from its JSONL
// transcript (or a `claude -p --output-format stream-json` log). Deterministic and
// local; nothing is sent anywhere and no raw text is written to the summary.
//   node measure.mjs --transcript <file> [--threshold 0.95] [--baseline <file>] [--format json|markdown] [--out <dir>]
// What it measures (D17): (1) observable controllable action events and how many
// consumed a valid Jev decision (coverage = covered / (covered + uncovered), with
// numerator, denominator, exceptions and unclassified events reported; a missing
// log never turns an action into an exception); (2) threshold compliance: an
// executed plan item scoring <= T needs a recorded user approval, and no
// controllable action may follow a stop (ask_user, incomplete, ...); (3) plan
// ordering (descending scores, tie-break calls); (4) Jev call counts (direct,
// helper-reported) against the budget; (5) parent, subagent and Jev usage kept
// apart, input/output/cache_read/cache_creation per unique message, a missing
// field is "unknown", never 0. Choices made internally and never visible in the
// transcript are declared unmeasurable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyShellCommand } from "../jev-flow/policy.mjs";
import { toolBase } from "./contracts.mjs";

const FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
export const STOP_STATUSES = new Set(["expand", "ask_user", "incomplete", "none_eligible", "none_candidates", "budget_exhausted", "search_budget_exhausted", "unavailable", "tie_unresolved", "refused", "invalid"]);
const EXPLORATION = new Set(["Read", "Grep", "Glob", "LS"]);
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MECHANICAL = new Set(["TodoWrite", "ToolSearch", "Skill", "TaskOutput", "TaskStop", "ExitPlanMode", "EnterPlanMode"]);

export function parseJsonl(text) {
  const records = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") records.push(r);
    } catch {
      // A partial or non-JSON line is skipped, not guessed.
    }
  }
  return records;
}

const blocks = (record) => (Array.isArray(record?.message?.content) ? record.message.content : []);
const sidechain = (record) => record?.isSidechain === true || (typeof record?.agent_id === "string" && record.agent_id !== "");

// ── Usage ───────────────────────────────────────────────────────────────────

function emptyUsage() {
  return Object.fromEntries(FIELDS.map((f) => [f, { sum: 0, seen: 0, missing: 0 }]));
}

function finishUsage(acc, messages) {
  const out = { messages };
  const partial = [];
  for (const f of FIELDS) {
    const { sum, seen, missing } = acc[f];
    out[f] = seen === 0 ? "unknown" : sum;
    if (seen > 0 && missing > 0) partial.push(f);
  }
  if (partial.length) out.partial_fields = partial;
  return out;
}

/**
 * Parent and subagent usage per UNIQUE assistant message id (streaming repeats a
 * message: the last, largest reading counts once) and the final result record's
 * own total, kept apart as `reported_total` (never added again).
 */
export function usageSummary(records) {
  const byId = new Map();
  let reported = null;
  records.forEach((r, i) => {
    if (r.type === "result" && r.usage) reported = r.usage;
    if (r.type !== "assistant" || !r.message) return;
    const id = r.message.id ?? `line:${i}`;
    const side = sidechain(r);
    const prev = byId.get(id);
    const usage = r.message.usage && typeof r.message.usage === "object" ? r.message.usage : null;
    if (!prev) byId.set(id, { side, usage });
    else if (usage) {
      const better = FIELDS.some((f) => typeof usage[f] === "number" && !(typeof prev.usage?.[f] === "number" && prev.usage[f] >= usage[f]));
      if (better) byId.set(id, { side: prev.side, usage: { ...(prev.usage ?? {}), ...usage } });
    }
  });
  const parent = emptyUsage();
  const sub = emptyUsage();
  let parentCount = 0;
  let subCount = 0;
  for (const { side, usage } of byId.values()) {
    const acc = side ? sub : parent;
    if (side) subCount += 1;
    else parentCount += 1;
    for (const f of FIELDS) {
      if (typeof usage?.[f] === "number") {
        acc[f].sum += usage[f];
        acc[f].seen += 1;
      } else acc[f].missing += 1;
    }
  }
  return {
    parent: finishUsage(parent, parentCount),
    subagent: finishUsage(sub, subCount),
    reported_total: reported ? Object.fromEntries(FIELDS.map((f) => [f, typeof reported[f] === "number" ? reported[f] : "unknown"])) : "unknown",
  };
}

/** Per-field difference b - a; "unknown" when either side is unknown (never 0). */
export function compareUsage(a, b) {
  return Object.fromEntries(FIELDS.map((f) => [f, typeof a[f] === "number" && typeof b[f] === "number" ? b[f] - a[f] : "unknown"]));
}

// ── Events ──────────────────────────────────────────────────────────────────

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

function userPrompt(record) {
  const c = record?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

function cliSub(command) {
  const m = /jev-control\/cli\.mjs"?\s+(on|off|status|threshold|decide|search|approve|budget|receipt|done)\b/.exec(command);
  return m ? m[1] : null;
}

function lastJson(text) {
  for (const line of String(text).split("\n").reverse()) {
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

/** Ordered events of a transcript with their result text (by tool_use id) and timestamps. */
export function collectEvents(records) {
  const results = new Map();
  for (const [i, r] of records.entries()) {
    if (r.type !== "user") continue;
    for (const b of blocks(r)) if (b?.type === "tool_result") results.set(b.tool_use_id, { text: toolResultText(b.content), ts: r.timestamp ?? null, error: b.is_error === true, i });
  }
  const events = [];
  let prompt = "";
  for (const [i, r] of records.entries()) {
    if (r.type === "user" && !blocks(r).some((b) => b?.type === "tool_result")) prompt = userPrompt(r) || prompt;
    if (r.type !== "assistant") continue;
    for (const b of blocks(r)) {
      if (b?.type !== "tool_use") continue;
      events.push({ i, id: b.id, name: String(b.name ?? ""), input: b.input ?? {}, side: sidechain(r), ts: r.timestamp ?? null, prompt, result: results.get(b.id) ?? null });
    }
  }
  return events;
}

function classify(e) {
  const jev = toolBase(e.name);
  if (jev) return { cat: "jev_direct", jev };
  if (e.name === "Bash") {
    const command = String(e.input.command ?? "");
    const sub = cliSub(command);
    if (sub) return { cat: "protocol", sub };
    if (/jev-gate-run\.mjs|jev-candidates\.mjs/.test(command)) return { cat: "protocol", sub: "flow_helper" };
    const cls = classifyShellCommand(command);
    return { cat: "controllable", kind: cls === "exploration" ? "search" : cls === "mutation" ? "edit" : cls === "test" ? "test" : "command" };
  }
  if (EXPLORATION.has(e.name)) return { cat: "controllable", kind: "search" };
  if (EDITS.has(e.name)) return { cat: "controllable", kind: "edit" };
  if (e.name === "Agent" || e.name === "Task") return { cat: "controllable", kind: "delegation" };
  if (e.name === "AskUserQuestion") return { cat: "controllable", kind: "question" };
  if (MECHANICAL.has(e.name)) return { cat: "mechanical" };
  return { cat: "unclassified" };
}

function namedInPrompt(e) {
  const path = e.input.file_path ?? e.input.path ?? e.input.notebook_path;
  if (typeof path !== "string" || !path) return null;
  const base = path.split("/").pop();
  return e.prompt.includes(path) || (base.length >= 3 && e.prompt.includes(base)) ? path : null;
}

/** Audit one transcript. `opts.threshold`: the session threshold to check plans against (default 0.95). */
export function audit(records, { threshold = 0.95 } = {}) {
  const events = collectEvents(records);
  let slots = 0;
  let blocked = false;
  const out = {
    coverage: { covered: 0, uncovered: 0, exceptions: {}, unclassified: 0, mechanical: 0, protocol: 0 },
    threshold: { decisions: 0, plan_items_checked: 0, violations: [], unknown_scores: 0, actions_while_blocked: 0 },
    ordering: { plans: 0, descending: 0, not_descending: [], with_tiebreak: 0, action_order: "unmeasurable: executed actions carry no option id in the transcript" },
    jev_calls: { direct: { main: 0, subagent: 0, by_tool: {} }, helper_reported_attempts: 0, unreserved_direct: 0, state_used: "unknown" },
    latency_ms: { jev_direct: [], helper: [] },
    approvals: 0,
  };
  const approved = new Set();
  let recent = [];
  for (const e of events) {
    const c = classify(e);
    const parsed = e.result ? lastJson(e.result.text) : null;
    const ms = e.ts && e.result?.ts ? Date.parse(e.result.ts) - Date.parse(e.ts) : null;
    if (c.cat === "jev_direct") {
      out.jev_calls.direct[e.side ? "subagent" : "main"] += 1;
      out.jev_calls.direct.by_tool[c.jev] = (out.jev_calls.direct.by_tool[c.jev] ?? 0) + 1;
      if (!recent.some((r) => r.cat === "protocol" && r.sub === "budget")) out.jev_calls.unreserved_direct += 1;
      if (Number.isFinite(ms)) out.latency_ms.jev_direct.push(ms);
      if (e.result && !e.result.error && ["noul", "decide", "rerank", "find"].includes(c.jev)) slots += 1;
      if (e.result && !e.result.error && c.jev === "decide") {
        const conf = lastJson(e.result.text)?.recommendation?.confidence;
        if (typeof conf === "number" && !(conf > threshold)) out.threshold.violations.push({ at: e.i, kind: "direct_decide_not_above_threshold", value: conf });
      }
    } else if (c.cat === "protocol") {
      out.coverage.protocol += 1;
      if (Number.isFinite(ms)) out.latency_ms.helper.push(ms);
      if (c.sub === "budget") {
        if (parsed?.used !== undefined) out.jev_calls.state_used = parsed.used;
      }
      if (c.sub === "approve" && parsed?.override === "user") {
        out.approvals += 1;
        approved.add(`${parsed.decision_id}:${parsed.option}`);
        blocked = false;
      }
      if ((c.sub === "decide" || c.sub === "search" || c.sub === "done") && parsed && typeof parsed.status === "string") {
        if (Number.isInteger(parsed.calls)) out.jev_calls.helper_reported_attempts += parsed.calls;
        else if (Number.isInteger(parsed.jev_calls)) out.jev_calls.helper_reported_attempts += parsed.jev_calls;
        if (STOP_STATUSES.has(parsed.status)) blocked = true;
        else if (c.sub !== "done") blocked = false;
        if (c.sub === "decide" && ["selected", "ordered"].includes(parsed.status)) {
          out.threshold.decisions += 1;
          const plan = Array.isArray(parsed.plan) ? parsed.plan : [];
          const executes = plan.filter((p) => p.action === "execute");
          slots += executes.length;
          const T = typeof parsed.threshold === "number" ? parsed.threshold : threshold;
          let prev = Infinity;
          let descending = true;
          for (const p of executes) {
            const score = parsed.scores?.[p.id];
            out.threshold.plan_items_checked += 1;
            if (typeof score !== "number") out.threshold.unknown_scores += 1;
            else {
              if (!(score > T) && !approved.has(`${parsed.decision_id}:${p.id}`)) out.threshold.violations.push({ at: e.i, kind: "plan_item_not_above_threshold", option: p.id, value: score });
              if (score > prev + 1e-9) descending = false;
              prev = score;
            }
          }
          out.ordering.plans += 1;
          if (parsed.tiebreaks > 0) out.ordering.with_tiebreak += 1;
          if (descending || parsed.tiebreaks > 0) out.ordering.descending += 1;
          else out.ordering.not_descending.push({ at: e.i, decision: parsed.decision_id });
        }
        if (c.sub === "search" && parsed.status === "found") slots += Array.isArray(parsed.hits) ? Math.min(parsed.hits.length, 5) : 0;
        if (c.sub === "search" && parsed.status === "direct_read") slots += 1;
      }
    } else if (c.cat === "mechanical") out.coverage.mechanical += 1;
    else if (c.cat === "unclassified") out.coverage.unclassified += 1;
    else {
      if (blocked) out.threshold.actions_while_blocked += 1;
      if (slots > 0) {
        slots -= 1;
        out.coverage.covered += 1;
      } else {
        const named = namedInPrompt(e);
        if (named) out.coverage.exceptions.user_named_path = (out.coverage.exceptions.user_named_path ?? 0) + 1;
        else out.coverage.uncovered += 1;
      }
    }
    recent = [...recent, c].slice(-3);
  }
  const denominator = out.coverage.covered + out.coverage.uncovered;
  out.coverage.numerator = out.coverage.covered;
  out.coverage.denominator = denominator;
  out.coverage.share = denominator === 0 ? "unknown" : Number((out.coverage.covered / denominator).toFixed(4));
  out.coverage.note = "choices made internally and never visible as an action in the transcript are unmeasurable";
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : "unknown");
  out.latency_ms = { jev_direct_median: med(out.latency_ms.jev_direct), helper_median: med(out.latency_ms.helper) };
  out.usage = usageSummary(records);
  out.eliminators = {
    below_threshold_actions_without_approval: out.threshold.violations.length + out.threshold.actions_while_blocked,
    note: "task correctness comes from the fixture oracle, never from Jev confidence",
  };
  return out;
}

export function toMarkdown(a, label = "session") {
  const u = a.usage;
  return [
    `# jev-control measurement: ${label}`,
    "",
    `- Coverage: ${a.coverage.numerator}/${a.coverage.denominator} (${a.coverage.share}); exceptions ${JSON.stringify(a.coverage.exceptions)}; unclassified ${a.coverage.unclassified}`,
    `- Threshold: ${a.threshold.decisions} decisions, ${a.threshold.violations.length} violations, ${a.threshold.actions_while_blocked} actions while blocked, ${a.threshold.unknown_scores} unknown scores`,
    `- Ordering: ${a.ordering.descending}/${a.ordering.plans} plans descending or tie-broken; ${a.ordering.action_order}`,
    `- Jev calls: direct ${JSON.stringify(a.jev_calls.direct)}, helper-reported attempts ${a.jev_calls.helper_reported_attempts}, state used ${a.jev_calls.state_used}, unreserved direct ${a.jev_calls.unreserved_direct}; provider calls unknown`,
    `- Latency (ms, median): direct ${a.latency_ms.jev_direct_median}, helper ${a.latency_ms.helper_median}`,
    `- Parent tokens: input ${u.parent.input_tokens}, output ${u.parent.output_tokens}, cache_read ${u.parent.cache_read_input_tokens}, cache_creation ${u.parent.cache_creation_input_tokens} (${u.parent.messages} messages)`,
    `- Subagent tokens: input ${u.subagent.input_tokens}, output ${u.subagent.output_tokens}, cache_read ${u.subagent.cache_read_input_tokens}, cache_creation ${u.subagent.cache_creation_input_tokens} (${u.subagent.messages} messages)`,
    "",
  ].join("\n");
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[++i];
  }
  if (!opts.transcript) throw new Error("--transcript is required");
  const records = parseJsonl(readFileSync(opts.transcript, "utf8"));
  const threshold = opts.threshold ? Number(opts.threshold) : 0.95;
  const result = audit(records, { threshold });
  if (opts.baseline) {
    const base = usageSummary(parseJsonl(readFileSync(opts.baseline, "utf8")));
    result.vs_baseline = { parent_delta: compareUsage(base.parent, result.usage.parent), baseline_parent: base.parent };
  }
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(opts.out, "summary.md"), toMarkdown(result, opts.transcript.split("/").pop()));
  }
  process.stdout.write(opts.format === "markdown" ? toMarkdown(result) : `${JSON.stringify(result)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("measure.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`measure: ${error.message}\n`);
    process.exitCode = 1;
  }
}

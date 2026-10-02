#!/usr/bin/env node
// Conformance and token audit of a Claude Code session, read from its JSONL
// transcript (or a `claude -p --output-format stream-json` log). Deterministic and
// local; nothing is sent anywhere and no raw text is written to the summary.
//   node measure.mjs --transcript <file> [--threshold 0.95] [--baseline <file>] [--format json|markdown] [--out <dir>]
// What it measures (D17): (1) observable controllable actions and whether each one
// is bound to a concrete GRANT: an earlier helper result (decide plan item, page,
// search hit, bound approval, stop) that named exactly that action (same tool and
// normalized target, compared by action hash), in the same request and agent
// context, consumed once, in plan order for `order` decisions. Nothing else covers
// an action: a direct Jev call, a plan score or a `budget` command never does. The
// only exception is a Read of a path the request's own user prompt names exactly.
// (2) threshold compliance: an `e` plan item must score strictly above the
// output's own threshold, no controllable action may follow a blocking stop until
// a new helper result or a bound approval, and an approval counts only when its
// message occurs in a real user message of the same request. (3) plan ordering
// and the order of the actions actually executed. (4) Jev calls: direct calls
// against open reservations, helper-reported attempts against the per-request
// limit. (5) finalization (accepted done after the last edit). (6) usage per
// unique message, merged per field, parent / subagent / unattributed kept apart;
// a total with missing messages is "unknown" (the observed subtotal is separate).
// Choices made internally and never visible in the transcript are unmeasurable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionHash, EDIT_TOOLS, normalizePath, observedDescriptor, parsePlanItem, shortHash } from "./actions.mjs";
import { parseDecideResult, parseNoulResult, parseRankResult, toolBase } from "./contracts.mjs";

const FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
/** Decide statuses that stop the plan (no grants). */
export const STOP_STATUSES = new Set(["expand", "ask_user", "incomplete", "none_eligible", "budget_exhausted", "unavailable", "tie_unresolved", "refused", "invalid", "below_threshold"]);
/** Stops after which no controllable action may follow until a new helper result or a bound approval. */
export const DECIDE_BLOCKING = new Set(["ask_user", "incomplete", "unavailable", "budget_exhausted", "refused", "tie_unresolved"]);
export const SEARCH_BLOCKING = new Set(["budget_exhausted", "search_budget_exhausted", "unavailable", "refused", "invalid"]);
const MECHANICAL = new Set(["TodoWrite", "ToolSearch", "Skill", "TaskOutput", "TaskStop", "ExitPlanMode", "EnterPlanMode"]);
const ACTIONS = new Set(["Bash", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS", "Agent", "Task", "AskUserQuestion"]);
const GRANTING = new Set(["decide", "search", "page", "approve"]);
const BASE_LIMIT = 25;
const SAMPLES = 10;

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
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const carriesSidechain = (records) => records.some((r) => r && typeof r === "object" && "isSidechain" in r);

/**
 * Who wrote a record, from identity the record really carries: a subagent when
 * isSidechain is true or it has an agent id or a parent_tool_use_id; the parent
 * when isSidechain is false, parent_tool_use_id is null, or the transcript format
 * carries isSidechain elsewhere; otherwise unattributed.
 */
function identity(record, carries) {
  const agent = nonEmpty(record?.agentId) ?? nonEmpty(record?.agent_id);
  const parentUse = nonEmpty(record?.parent_tool_use_id);
  if (record?.isSidechain === true || agent || parentUse) return { side: "subagent", agent: agent ?? parentUse };
  if (record?.isSidechain === false || record?.parent_tool_use_id === null || carries) return { side: "parent", agent: null };
  return { side: "unattributed", agent: null };
}

// ── Usage ───────────────────────────────────────────────────────────────────

/** Per-field totals of unique messages; a field missing from any message is "unknown" with its observed subtotal apart. */
function bucketUsage(entries, attribution) {
  const out = { messages: entries.length, attribution };
  const partial = [];
  for (const f of FIELDS) {
    let sum = 0;
    let seen = 0;
    for (const e of entries) {
      if (finite(e.usage[f])) {
        sum += e.usage[f];
        seen += 1;
      }
    }
    const missing = entries.length - seen;
    if (entries.length > 0 && missing === 0) out[f] = sum;
    else {
      out[f] = "unknown";
      if (entries.length > 0) {
        out[`${f}_observed`] = sum;
        out[`${f}_missing_messages`] = missing;
        if (seen > 0) partial.push(f);
      }
    }
  }
  if (partial.length) out.partial_fields = partial;
  return out;
}

/**
 * Usage per UNIQUE assistant message id. Streaming repeats a message: the readings
 * merge field by field, each field keeping the largest value seen (a later reading
 * without a field never erases it). Parent, subagent (also per agent id) and
 * unattributed messages are kept apart; `total` holds every message. The final
 * result record's own total is kept apart as `reported_total` (never added again).
 */
export function usageSummary(records) {
  const carries = carriesSidechain(records);
  const byId = new Map();
  let reported = null;
  records.forEach((r, i) => {
    if (r?.type === "result" && r.usage && typeof r.usage === "object") reported = r.usage;
    if (r?.type !== "assistant" || !r.message || typeof r.message !== "object") return;
    const id = nonEmpty(r.message.id) ?? `line:${i}`;
    const who = identity(r, carries);
    let entry = byId.get(id);
    if (!entry) byId.set(id, (entry = { who, usage: {} }));
    else if (entry.who.side === "unattributed" && who.side !== "unattributed") entry.who = who;
    const usage = r.message.usage && typeof r.message.usage === "object" ? r.message.usage : {};
    for (const f of FIELDS) if (finite(usage[f]) && !(finite(entry.usage[f]) && entry.usage[f] >= usage[f])) entry.usage[f] = usage[f];
  });
  const all = [...byId.values()];
  const unattributed = all.filter((e) => e.who.side === "unattributed");
  const attribution = unattributed.length ? "unknown" : "known";
  const byAgent = {};
  for (const e of all) if (e.who.side === "subagent" && e.who.agent) (byAgent[e.who.agent] ??= []).push(e);
  return {
    attribution,
    parent: bucketUsage(all.filter((e) => e.who.side === "parent"), attribution),
    subagent: bucketUsage(all.filter((e) => e.who.side === "subagent"), attribution),
    unattributed: bucketUsage(unattributed, "unknown"),
    by_agent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, bucketUsage(v, "known")])),
    total: bucketUsage(all, "known"),
    reported_total: reported ? Object.fromEntries(FIELDS.map((f) => [f, finite(reported[f]) ? reported[f] : "unknown"])) : "unknown",
  };
}

/** A field is a comparable total only when it is a number, no message lacks it and the bucket's attribution is known. */
const comparable = (u, f) => finite(u?.[f]) && !(u[`${f}_missing_messages`] > 0) && u?.attribution !== "unknown";

/** Per-field difference b - a; "unknown" when either side is not a complete total (never 0, never a saving). */
export function compareUsage(a, b) {
  return Object.fromEntries(FIELDS.map((f) => [f, comparable(a, f) && comparable(b, f) ? b[f] - a[f] : "unknown"]));
}

// ── Events ──────────────────────────────────────────────────────────────────

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

function userText(record) {
  const c = record?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  return "";
}

/** A real user prompt: type user, no tool_result, not meta, not a compaction summary, not a subagent's, not an interruption marker. */
function isPrompt(record, carries) {
  if (record?.type !== "user" || record.isMeta === true || record.isCompactSummary === true) return false;
  if (identity(record, carries).side === "subagent") return false;
  if (blocks(record).some((b) => b?.type === "tool_result")) return false;
  const text = userText(record);
  return text.trim() !== "" && !text.startsWith("[Request interrupted");
}

function collect(records) {
  const carries = carriesSidechain(records);
  const results = new Map();
  records.forEach((r, i) => {
    if (r?.type !== "user") return;
    for (const b of blocks(r)) {
      // The first result of an id counts; a repeated one is ignored.
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && !results.has(b.tool_use_id)) results.set(b.tool_use_id, { text: toolResultText(b.content), ts: r.timestamp ?? null, error: b.is_error === true, i });
    }
  });
  const events = [];
  const requests = [{ request: 0, at: -1, text: "" }];
  const seen = new Set();
  let cwd = null;
  records.forEach((r, i) => {
    if (nonEmpty(r?.cwd)) cwd = r.cwd;
    if (isPrompt(r, carries)) requests.push({ request: requests.length, at: i, text: userText(r) });
    if (r?.type !== "assistant") return;
    const who = identity(r, carries);
    blocks(r).forEach((b, k) => {
      if (b?.type !== "tool_use") return;
      const id = nonEmpty(b.id) ?? `line:${i}:${k}`;
      // A streamed message repeats its tool_use blocks: the first occurrence counts.
      if (seen.has(id)) return;
      seen.add(id);
      const result = results.get(id) ?? null;
      events.push({
        i,
        id,
        name: String(b.name ?? ""),
        input: b.input && typeof b.input === "object" ? b.input : {},
        side: who.side,
        ctx: who.side === "subagent" ? (who.agent ?? "subagent_unknown") : "main",
        req: requests.length - 1,
        root: nonEmpty(r.cwd) ?? cwd,
        ts: r.timestamp ?? null,
        // A result recorded before its own tool_use is malformed and never authorizes anything.
        result: result && result.i > i ? result : null,
      });
    });
  });
  return { events, requests };
}

/** Tool_use events in transcript order (repeated ids counted once), each with its result (position `i`, text, timestamp). */
export function collectEvents(records) {
  return collect(records).events;
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

function anyJson(text) {
  try {
    const v = JSON.parse(String(text).trim());
    if (v && typeof v === "object") return v;
  } catch {
    // Fall back to the last JSON line.
  }
  return lastJson(text);
}

function cliSub(command) {
  const m = /jev-control\/cli\.mjs["']?\s+(on|off|status|threshold|decide|search|page|approve|budget|receipt|done|plan)\b/.exec(command);
  return m ? m[1] : null;
}

/**
 * Shell words of a command, quote aware (single, double, backslash), with the
 * control operators as {op} entries and here-document bodies skipped.
 */
function shellWords(command) {
  const s = String(command);
  const words = [];
  const heredocs = [];
  let cur = null;
  const push = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      cur = (cur ?? "") + s.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      cur = cur ?? "";
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      i += 1;
    } else if (c === "\\" && i + 1 < s.length) {
      cur = (cur ?? "") + s[i + 1];
      i += 2;
    } else if (c === "\n") {
      push();
      i += 1;
      // Skip each pending here-document body up to its delimiter line.
      while (heredocs.length && i < s.length) {
        const end = s.indexOf("\n", i);
        const line = s.slice(i, end === -1 ? s.length : end);
        if (line.replace(/^\t+/, "").trim() === heredocs[0]) heredocs.shift();
        i = end === -1 ? s.length : end + 1;
      }
      words.push({ op: "\n" });
    } else if (/\s/.test(c)) {
      push();
      i += 1;
    } else if (cur === null && s.startsWith("<<<", i)) {
      i += 3;
    } else if (cur === null && s.startsWith("<<", i)) {
      i += s[i + 2] === "-" ? 3 : 2;
      while (i < s.length && /[ \t]/.test(s[i])) i += 1;
      let delim = "";
      while (i < s.length && !/\s/.test(s[i])) {
        if (s[i] !== "'" && s[i] !== '"' && s[i] !== "\\") delim += s[i];
        i += 1;
      }
      if (delim) heredocs.push(delim);
    } else if (c === "&" && (s[i + 1] === ">" || (cur ?? "").endsWith(">"))) {
      cur = (cur ?? "") + c;
      i += 1;
    } else if (c === "|" || c === "&" || c === ";") {
      push();
      const op = (c === "|" || c === "&") && s[i + 1] === c ? c + c : c;
      words.push({ op });
      i += op.length;
    } else {
      cur = (cur ?? "") + c;
      i += 1;
    }
  }
  push();
  return words;
}

/** The helper invocation in a command: {sub, action, flags, compound}. */
function helperCall(command) {
  const words = shellWords(command);
  const at = words.findIndex((w) => typeof w === "string" && /jev-control\/cli\.mjs$/.test(w));
  // A command that chains other commands after a separator (not a pipe) is compound.
  const compound = words.some((w, k) => typeof w === "object" && w.op !== "|" && w.op !== "||" && words.slice(k + 1).some((x) => typeof x === "string"));
  if (at === -1) return { sub: cliSub(command), action: null, flags: {}, compound };
  const args = [];
  for (const w of words.slice(at + 1)) {
    if (typeof w !== "string") break;
    args.push(w);
  }
  const flags = {};
  const positional = [];
  for (let k = 1; k < args.length; k++) {
    const a = args[k];
    if (!a.startsWith("--")) positional.push(a);
    else if (a.includes("=")) flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (k + 1 < args.length && !args[k + 1].startsWith("--")) flags[a.slice(2)] = args[++k];
    else flags[a.slice(2)] = true;
  }
  return { sub: args[0] ?? cliSub(command), action: positional[0] ?? null, flags, compound };
}

function classify(e) {
  const jev = toolBase(e.name);
  if (jev) return { cat: "jev_direct", jev };
  if (e.name === "Bash") {
    const command = String(e.input.command ?? "");
    if (cliSub(command)) return { cat: "protocol", ...helperCall(command) };
    if (/jev-gate-run\.mjs|jev-candidates\.mjs/.test(command)) return { cat: "protocol", sub: "flow_helper", flags: {}, compound: false };
    return { cat: "action" };
  }
  if (ACTIONS.has(e.name)) return { cat: "action" };
  if (MECHANICAL.has(e.name)) return { cat: "mechanical" };
  return { cat: "unclassified" };
}

/** Path-like words of a prompt with surrounding quotes, brackets, mention marks, trailing punctuation and :line suffixes removed. */
function promptPaths(text) {
  const out = [];
  for (const raw of String(text).split(/\s+/)) {
    let w = raw.replace(/^[(["'`<@]+/, "").replace(/[)\]"'`>,;:!?.]+$/, "");
    w = w.replace(/:\d+(?::\d+)?$/, "");
    if (w) out.push(w);
  }
  return out;
}

/** True when the prompt names exactly this normalized path (normalizePath equality, never a basename match). */
function namedInPrompt(target, text, root) {
  if (!target) return false;
  return promptPaths(text).some((w) => normalizePath(w, root) === target);
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : "unknown");
const norm = (text) => collapse(text).toLowerCase();

/** Audit one transcript. `opts.threshold`: the session threshold used when a helper output carries none (default 0.95). */
export function audit(records, { threshold = 0.95 } = {}) {
  const { events, requests } = collect(records);
  const out = {
    coverage: {
      covered: 0,
      uncovered: 0,
      unknown: 0,
      exceptions: { user_named_path: 0 },
      unclassified: 0,
      mechanical: 0,
      protocol: 0,
      protocol_compound: 0,
      uncovered_reasons: {},
      uncovered_samples: [],
      unknown_samples: [],
      by_context: {},
      grants: { created: 0, consumed: 0, by_type: {} },
    },
    threshold: { decisions: 0, plan_items_checked: 0, violations: [], unknown_scores: 0, threshold_missing: 0, actions_while_blocked: 0, approvals_unbound: 0, blocked_samples: [] },
    ordering: { plans: 0, plans_descending: 0, not_descending: [], order_violations: [], action_order: "measured", tiebreak_plans: 0, pages_applied: 0, pages_ignored: 0, partial_plans_incomplete: 0 },
    jev_calls: {
      direct: { main: 0, subagent: 0, by_tool: {} },
      helper_reported_attempts: 0,
      unreserved_direct: [],
      reserved_direct: 0,
      reservations: { opened: 0, consumed: 0, confirmed: 0, released: 0, open_unused: 0 },
      direct_invalid_results: [],
      direct_decide_not_actionable: [],
      direct_errors: 0,
      direct_unvalidated: 0,
      state_used: "unknown",
      per_request: [],
      violations: [],
    },
    finalization: { done_calls: 0, last_outcome: null, accepted: false, last_accepted_at: null, edits: 0, violations: [] },
    approvals: { calls: 0, bound: 0, unbound: [], refused: 0 },
    receipts: { receipt_verifications: 0, receipt_refusals: 0 },
  };
  const latency = { jev_direct: [], helper: [] };
  const grants = [];
  const decisions = new Map();
  const scopes = new Map();
  const reservations = [];
  const userMessages = requests.map((r) => (r.at >= 0 ? [{ at: r.at, text: r.text }] : []));
  const perRequest = new Map();
  const edits = [];
  let lastAccepted = null;
  let lastT = null;

  const scope = (e) => {
    const key = `${e.ctx}\n${e.req}`;
    if (!scopes.has(key)) scopes.set(key, { blocked: null, opaque: false });
    return scopes.get(key);
  };
  const reqStats = (req) => {
    if (!perRequest.has(req)) perRequest.set(req, { request: req, helper_attempts: 0, direct: 0, approved_extra: 0, limit: BASE_LIMIT });
    return perRequest.get(req);
  };
  const ctxStats = (ctx) => (out.coverage.by_context[ctx] ??= { covered: 0, uncovered: 0, unknown: 0, exceptions: 0 });
  const addGrant = (g) => {
    grants.push({ ...g, consumed: false });
    out.coverage.grants.created += 1;
    out.coverage.grants.by_type[g.type] = (out.coverage.grants.by_type[g.type] ?? 0) + 1;
  };
  const askGrant = (e, at, extra) => addGrant({ type: "ask", tool: "AskUserQuestion", ctx: e.ctx, req: e.req, at, ...extra });

  const matches = (g, desc, ah) => {
    if (g.type === "ask") return desc.tool === "AskUserQuestion";
    if (g.type === "search" || g.type === "direct_read") return g.tool === desc.tool && g.target === desc.target;
    return g.ah === ah;
  };

  const uncovered = (e, desc, reason) => {
    out.coverage.uncovered += 1;
    ctxStats(e.ctx).uncovered += 1;
    out.coverage.uncovered_reasons[reason] = (out.coverage.uncovered_reasons[reason] ?? 0) + 1;
    if (out.coverage.uncovered_samples.length < SAMPLES) out.coverage.uncovered_samples.push({ at: e.i, tool: desc.tool, reason });
  };
  const unknown = (e, desc, reason) => {
    out.coverage.unknown += 1;
    ctxStats(e.ctx).unknown += 1;
    if (out.coverage.unknown_samples.length < SAMPLES) out.coverage.unknown_samples.push({ at: e.i, tool: desc.tool, reason });
  };

  function onAction(e) {
    const desc = observedDescriptor(e.name, e.input, e.root);
    const ah = shortHash(actionHash(desc));
    const st = scope(e);
    if (EDIT_TOOLS.includes(desc.tool)) edits.push(e.i);
    // Asking the user is what every blocking stop asks for, so it is never an action while blocked.
    if (st.blocked && desc.tool !== "AskUserQuestion") {
      out.threshold.actions_while_blocked += 1;
      if (out.threshold.blocked_samples.length < SAMPLES) out.threshold.blocked_samples.push({ at: e.i, tool: desc.tool, after: st.blocked.status });
      return uncovered(e, desc, "while_blocked");
    }
    // Only results already seen (position before this tool_use) in the same agent context and request.
    const mine = grants.filter((g) => g.ctx === e.ctx && g.req === e.req && g.at < e.i && matches(g, desc, ah));
    let chosen = null;
    let miss = null;
    for (const g of mine) {
      if (g.consumed) continue;
      if (g.type === "plan" && g.kind === "order") {
        const next = grants.find((x) => x.type === "plan" && x.decision_id === g.decision_id && x.ctx === g.ctx && x.req === g.req && !x.consumed);
        if (next !== g) {
          miss ??= { at: e.i, decision_id: g.decision_id, expected: next?.option ?? null, got: g.option };
          continue;
        }
      }
      chosen = g;
      break;
    }
    if (chosen) {
      chosen.consumed = true;
      out.coverage.grants.consumed += 1;
      if (chosen.type !== "direct_read") {
        out.coverage.covered += 1;
        ctxStats(e.ctx).covered += 1;
        return;
      }
      // A direct_read grant is an exception, valid only when the prompt names the path.
      if (namedInPrompt(desc.target, requests[e.req].text, e.root)) {
        out.coverage.exceptions.user_named_path += 1;
        ctxStats(e.ctx).exceptions += 1;
        return;
      }
      return uncovered(e, desc, "direct_read_not_named_by_user");
    }
    if (miss) {
      out.ordering.order_violations.push(miss);
      return uncovered(e, desc, "out_of_order");
    }
    if (desc.tool === "Read" && namedInPrompt(desc.target, requests[e.req].text, e.root)) {
      out.coverage.exceptions.user_named_path += 1;
      ctxStats(e.ctx).exceptions += 1;
      return;
    }
    if (mine.length) return uncovered(e, desc, "grant_already_used");
    if (grants.some((g) => !g.consumed && g.at < e.i && matches(g, desc, ah))) return uncovered(e, desc, "grant_in_other_context_or_request");
    if (st.opaque) return unknown(e, desc, "helper_result_missing");
    // Without a working directory an absolute path cannot be compared with a repository-relative action hash.
    if (!e.root && desc.target.startsWith("/") && grants.some((g) => g.ctx === e.ctx && g.req === e.req && !g.consumed && g.ah)) return unknown(e, desc, "root_unknown");
    return uncovered(e, desc, "no_grant");
  }

  function addPlanItems(d, items, at) {
    for (const raw of Array.isArray(items) ? items : []) {
      const item = parsePlanItem(raw);
      if (!item) {
        out.threshold.unknown_scores += 1;
        continue;
      }
      if (item.action === "suspend" && item.id === "action_ask_user") askGrant(d.e, at, { decision_id: d.id, option: item.id, score: item.score, threshold: d.T });
      if (item.action !== "execute") continue;
      out.threshold.plan_items_checked += 1;
      d.scores.push(item.score);
      const above = item.score > d.T;
      if (!above) out.threshold.violations.push({ at, kind: "plan_item_not_above_threshold", decision_id: d.id, option: item.id, value: item.score, threshold: d.T });
      const order = d.executes++;
      // Every kind but `order` executes only its first execute item.
      if (d.kind !== "order") {
        if (d.firstTaken) continue;
        d.firstTaken = true;
      }
      if (above && item.ah) addGrant({ type: "plan", decision_id: d.id, option: item.id, ah: item.ah, score: item.score, threshold: d.T, ctx: d.e.ctx, req: d.e.req, at, kind: d.kind, order });
    }
  }

  function onHelperResult(e, c) {
    const at = e.result.i;
    const st = scope(e);
    const p = lastJson(e.result.text);
    if (!p || typeof p.status !== "string") {
      if (GRANTING.has(c.sub)) st.opaque = true;
      return;
    }
    if (["decide", "search", "page", "done"].includes(c.sub)) {
      const attempts = Number.isInteger(p.calls) ? p.calls : Number.isInteger(p.jev_calls) ? p.jev_calls : 0;
      out.jev_calls.helper_reported_attempts += attempts;
      reqStats(e.req).helper_attempts += attempts;
    }
    if (finite(p.used)) out.jev_calls.state_used = p.used;
    switch (c.sub) {
      case "decide": {
        if (finite(p.threshold)) lastT = p.threshold;
        st.blocked = DECIDE_BLOCKING.has(p.status) ? { status: p.status, decision_id: String(p.decision_id ?? "") } : null;
        if (st.blocked) askGrant(e, at, { decision_id: String(p.decision_id ?? ""), option: null });
        if (p.status !== "selected" && p.status !== "ordered") return;
        out.threshold.decisions += 1;
        const d = { id: String(p.decision_id ?? `at:${at}`), kind: String(p.kind ?? "unknown"), T: finite(p.threshold) ? p.threshold : threshold, e, next: Number.isInteger(p.plan_next) ? p.plan_next : null, scores: [], executes: 0, firstTaken: false, tiebreaks: Number(p.tiebreaks) > 0, at };
        if (!finite(p.threshold)) out.threshold.threshold_missing += 1;
        decisions.set(d.id, d);
        out.ordering.plans += 1;
        if (d.tiebreaks) out.ordering.tiebreak_plans += 1;
        addPlanItems(d, p.plan, at);
        return;
      }
      case "page": {
        const id = String(p.decision_id ?? "");
        // A page of the decision that blocked is not a new result for it.
        if (!(st.blocked && st.blocked.decision_id === id)) st.blocked = null;
        if (p.status !== "ok" || p.part !== "plan") return;
        const d = decisions.get(id);
        if (!d || d.e.ctx !== e.ctx || d.e.req !== e.req || d.next === null || p.from !== d.next) {
          out.ordering.pages_ignored += 1;
          return;
        }
        out.ordering.pages_applied += 1;
        addPlanItems(d, p.plan, at);
        d.next = Number.isInteger(p.plan_next) ? p.plan_next : null;
        return;
      }
      case "search": {
        st.blocked = SEARCH_BLOCKING.has(p.status) ? { status: p.status, decision_id: null } : null;
        if (st.blocked) askGrant(e, at, { decision_id: null, option: null });
        const hits = p.status === "found" ? p.hits : p.status === "tie_unresolved" ? p.resolved_hits : p.status === "direct_read" ? p.hits : null;
        for (const h of Array.isArray(hits) ? hits : []) {
          if (!nonEmpty(h?.path)) continue;
          addGrant({ type: p.status === "direct_read" ? "direct_read" : "search", tool: "Read", target: normalizePath(h.path, e.root), score: finite(h.score) ? h.score : null, ctx: e.ctx, req: e.req, at });
        }
        return;
      }
      case "approve": {
        out.approvals.calls += 1;
        if (p.status !== "ok" || p.override !== "user") {
          out.approvals.refused += 1;
          return;
        }
        const message = typeof c.flags.message === "string" ? norm(c.flags.message) : "";
        const bound = message.length >= 3 && userMessages[e.req].some((m) => m.at < e.i && norm(m.text).includes(message));
        if (!bound) {
          out.threshold.approvals_unbound += 1;
          out.approvals.unbound.push({ at: e.i, decision_id: p.decision_id ?? null, option: p.option ?? null });
          return;
        }
        out.approvals.bound += 1;
        st.blocked = null;
        if (typeof p.ah === "string" && /^[0-9a-f]{12}$/.test(p.ah)) addGrant({ type: "approved", decision_id: String(p.decision_id ?? ""), option: p.option ?? null, ah: p.ah, ctx: e.ctx, req: e.req, at });
        return;
      }
      case "budget": {
        if (c.action === "reserve" && p.status === "ok" && p.id !== undefined) {
          const tool = toolBase(c.flags.tool) ?? (typeof c.flags.tool === "string" ? c.flags.tool : null);
          reservations.push({ id: String(p.id), tool, req: e.req, at, consumed: false, closed: false });
          out.jev_calls.reservations.opened += 1;
        } else if ((c.action === "confirm" || c.action === "release") && p.status === "ok") {
          const r = reservations.find((x) => x.id === String(c.flags.id) && !x.closed);
          if (r) {
            r.closed = true;
            out.jev_calls.reservations[c.action === "confirm" ? "confirmed" : "released"] += 1;
          }
        } else if (c.action === "approve" && finite(p.limit)) {
          const R = reqStats(e.req);
          R.limit = p.limit;
          R.approved_extra = p.limit - BASE_LIMIT;
        }
        return;
      }
      case "receipt":
        if (p.status === "ok" && p.authorized === true) out.receipts.receipt_verifications += 1;
        else if (p.status === "refused") out.receipts.receipt_refusals += 1;
        return;
      case "done": {
        const outcome = nonEmpty(p.outcome) ?? nonEmpty(p.status) ?? "unknown";
        out.finalization.last_outcome = outcome;
        if (p.outcome === "accepted") lastAccepted = at;
        return;
      }
      default:
    }
  }

  function onDirectUse(e, c) {
    out.jev_calls.direct[e.side === "subagent" ? "subagent" : "main"] += 1;
    out.jev_calls.direct.by_tool[c.jev] = (out.jev_calls.direct.by_tool[c.jev] ?? 0) + 1;
    reqStats(e.req).direct += 1;
    const r = reservations.find((x) => x.req === e.req && x.tool === c.jev && !x.consumed && !x.closed && x.at < e.i);
    if (r) {
      r.consumed = true;
      out.jev_calls.reserved_direct += 1;
      out.jev_calls.reservations.consumed += 1;
    } else out.jev_calls.unreserved_direct.push({ at: e.i, tool: c.jev });
  }

  function onDirectResult(e, c) {
    if (e.result.error) {
      out.jev_calls.direct_errors += 1;
      return;
    }
    const result = anyJson(e.result.text);
    const invalid = (reason) => out.jev_calls.direct_invalid_results.push({ at: e.result.i, tool: c.jev, reason });
    const input = e.input;
    if (c.jev === "noul" && Array.isArray(input.propositions)) {
      const v = parseNoulResult(result, input.propositions.length, input.propositions);
      if (!v.ok) invalid(v.reason);
    } else if (c.jev === "decide" && Array.isArray(input.candidates)) {
      const v = parseDecideResult(result, input.candidates.map((x) => x?.id));
      if (!v.ok) return invalid(v.reason);
      const T = lastT ?? threshold;
      if (!(v.confidence > T) || v.warnings.length > 0 || v.escaped) out.jev_calls.direct_decide_not_actionable.push({ at: e.result.i, confidence: v.confidence, threshold: T, escaped: v.escaped, warnings: v.warnings.length });
    } else if ((c.jev === "rerank" || c.jev === "find") && Array.isArray(input.candidates) && input.candidates.every((x) => typeof x?.id === "string") && Number.isInteger(input.top_k)) {
      const v = parseRankResult(c.jev, result, input.candidates.map((x) => x.id), input.top_k);
      if (!v.ok) invalid(v.reason);
    } else out.jev_calls.direct_unvalidated += 1;
  }

  // One timeline of tool_use and tool_result events by record position: a result never authorizes an earlier action.
  const timeline = [];
  for (const e of events) {
    timeline.push({ pos: e.i, use: true, e });
    if (e.result) timeline.push({ pos: e.result.i, use: false, e });
  }
  timeline.sort((a, b) => a.pos - b.pos);

  for (const { use, e } of timeline) {
    const c = classify(e);
    if (use) {
      const ms = e.ts && e.result?.ts ? Date.parse(e.result.ts) - Date.parse(e.ts) : null;
      if (c.cat === "jev_direct") {
        onDirectUse(e, c);
        if (Number.isFinite(ms)) latency.jev_direct.push(ms);
      } else if (c.cat === "protocol") {
        out.coverage.protocol += 1;
        if (c.compound) out.coverage.protocol_compound += 1;
        if (Number.isFinite(ms)) latency.helper.push(ms);
        if (c.sub === "done") out.finalization.done_calls += 1;
        if (!e.result && GRANTING.has(c.sub)) scope(e).opaque = true;
      } else if (c.cat === "mechanical") out.coverage.mechanical += 1;
      else if (c.cat === "unclassified") out.coverage.unclassified += 1;
      else onAction(e);
    } else if (c.cat === "jev_direct") onDirectResult(e, c);
    else if (c.cat === "protocol") onHelperResult(e, c);
    else if (c.cat === "action" && e.name === "AskUserQuestion" && !e.result.error) {
      // The answer to a question is the user's own words for binding an approval.
      userMessages[e.req].push({ at: e.result.i, text: e.result.text });
    }
  }

  // Plans: descending execute scores unless a tie-break ordered them; partial plans never completed.
  for (const d of decisions.values()) {
    const descending = d.scores.every((s, k) => k === 0 || s <= d.scores[k - 1]);
    if (descending || d.tiebreaks) out.ordering.plans_descending += 1;
    else out.ordering.not_descending.push({ at: d.at, decision: d.id });
    if (d.next !== null) out.ordering.partial_plans_incomplete += 1;
  }
  out.jev_calls.reservations.open_unused = reservations.filter((r) => !r.consumed && !r.closed).length;
  out.jev_calls.per_request = [...perRequest.values()].sort((a, b) => a.request - b.request);
  for (const R of out.jev_calls.per_request) {
    const attempts = R.helper_attempts + R.direct;
    if (attempts > R.limit) out.jev_calls.violations.push({ kind: "budget_exceeded", request: R.request, attempts, limit: R.limit });
  }

  const fin = out.finalization;
  fin.edits = edits.length;
  fin.accepted = lastAccepted !== null;
  fin.last_accepted_at = lastAccepted;
  if (edits.length && lastAccepted === null) fin.violations.push({ kind: "finished_without_accepted_done", edits: edits.length });
  for (const at of edits) if (lastAccepted !== null && at > lastAccepted) fin.violations.push({ kind: "edit_after_last_accepted_done", at });

  const cov = out.coverage;
  cov.numerator = cov.covered;
  cov.denominator = cov.covered + cov.uncovered;
  cov.share = cov.denominator === 0 ? "unknown" : Number((cov.covered / cov.denominator).toFixed(4));
  cov.note = "covered = bound to an earlier helper result that named exactly that action (same request and agent context, used once, in plan order); exceptions and unknown actions are outside the denominator; choices made internally and never visible as an action are unmeasurable";
  out.latency_ms = { jev_direct_median: median(latency.jev_direct), helper_median: median(latency.helper) };
  out.usage = usageSummary(records);
  out.eliminators = {
    below_threshold_actions_without_approval: out.threshold.violations.length + out.threshold.actions_while_blocked + out.ordering.order_violations.length + out.threshold.approvals_unbound,
    other_violations: {
      budget_exceeded: out.jev_calls.violations.length,
      unreserved_direct: out.jev_calls.unreserved_direct.length,
      finalization: fin.violations.length,
    },
    note: "task correctness comes from the fixture oracle, never from Jev confidence",
  };
  return out;
}

function tokens(b) {
  return FIELDS.map((f) => {
    const name = f.replace(/_input_tokens$|_tokens$/, "");
    return b[f] === "unknown" && b[`${f}_missing_messages`] > 0 ? `${name} unknown (observed ${b[`${f}_observed`]}, ${b[`${f}_missing_messages`]} messages missing)` : `${name} ${b[f]}`;
  }).join(", ");
}

export function toMarkdown(a, label = "session") {
  const u = a.usage;
  return [
    `# jev-control measurement: ${label}`,
    "",
    `- Coverage: ${a.coverage.numerator}/${a.coverage.denominator} (${a.coverage.share}); unknown ${a.coverage.unknown}; exceptions ${JSON.stringify(a.coverage.exceptions)}; unclassified ${a.coverage.unclassified}; uncovered reasons ${JSON.stringify(a.coverage.uncovered_reasons)}`,
    `- Threshold: ${a.threshold.decisions} decisions, ${a.threshold.violations.length} violations, ${a.threshold.actions_while_blocked} actions while blocked, ${a.threshold.approvals_unbound} unbound approvals, ${a.threshold.unknown_scores} unknown scores`,
    `- Ordering: ${a.ordering.plans_descending}/${a.ordering.plans} plans descending or tie-broken; action order ${a.ordering.action_order}: ${a.ordering.order_violations.length} order violations`,
    `- Jev calls: direct ${JSON.stringify(a.jev_calls.direct)}, helper-reported attempts ${a.jev_calls.helper_reported_attempts}, state used ${a.jev_calls.state_used}, reserved direct ${a.jev_calls.reserved_direct}, unreserved direct ${a.jev_calls.unreserved_direct.length}, budget violations ${a.jev_calls.violations.length}; provider calls unknown`,
    `- Finalization: ${a.finalization.done_calls} done calls, last outcome ${a.finalization.last_outcome ?? "none"}, accepted ${a.finalization.accepted}, ${a.finalization.violations.length} violations`,
    `- Latency (ms, median): direct ${a.latency_ms.jev_direct_median}, helper ${a.latency_ms.helper_median}`,
    `- Parent tokens: ${tokens(u.parent)} (${u.parent.messages} messages)`,
    `- Subagent tokens: ${tokens(u.subagent)} (${u.subagent.messages} messages)`,
    `- Unattributed tokens: ${u.unattributed.messages} messages; attribution ${u.attribution}`,
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
    result.vs_baseline = {
      parent_delta: compareUsage(base.parent, result.usage.parent),
      subagent_delta: compareUsage(base.subagent, result.usage.subagent),
      total_delta: compareUsage(base.total, result.usage.total),
      baseline_parent: base.parent,
      baseline_total: base.total,
      note: "a field is compared only when both totals are complete and attributed; otherwise it is unknown and no saving is reported",
    };
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

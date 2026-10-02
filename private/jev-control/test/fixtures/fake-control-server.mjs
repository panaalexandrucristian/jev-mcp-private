#!/usr/bin/env node
// Fake jev MCP server on stdio for the jev-control tests: no network, no model.
// Beyond the jev-flow fake it answers tools/list and jev_noul / jev_decide.
// FAKE_CONTROL_SCRIPT=<file>: JSON {"noul": [..], "decide": [..], "rerank": [..], "find": [..], "gate": [..]},
//   one entry per call of that tool in order (the last one repeats); consumed through
//   FAKE_CONTROL_STATE (a cross-process counter file, so a reconnection continues the script).
//   noul entry: {"p": [0.97, ...]} | {"invalid": true}; decide entry: {"selected": id, "confidence": x, "escaped": bool}
//   rerank/find entry: {"scores": {"<id>": x}, "exists": x}; gate entry: {"result": <jev_gate answer>} or {"conf": x} (an accepted
//   answer for exactly the claims of the call, all confidences x, at the call's auto_accept); any entry may carry {"fail": "transport"|"hang"|"tool_error"}.
// FAKE_CONTROL_TOOLS=<comma list of short names> restricts tools/list (default: all 11 core tools + audit);
//   FAKE_CONTROL_NO_SCHEMA=1 lists them without an input schema; FAKE_CONTROL_SCHEMA_PATCH=<file>: JSON
//   {"<short name>": <inputSchema to publish instead>} (null: no inputSchema), for incompatible-schema cases.
// tools/list publishes the real input schemas as jev-mcp publishes them (zod -> JSON Schema, descriptions
// left out); contracts-real.test.mjs compares them with the real server's tools/list.
// noul replies echo each sent proposition; decide replies carry the Choice distribution over the
// candidate ids plus the escape hatches (unless escape_hatches is false), summing to 1, argmax = selected.
// FAKE_MCP_LOG=<file>: JSONL, one record per tools/call with the full arguments.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gateAnswer } from "../helpers.mjs";

const CORE = ["screen", "verify", "noul", "find", "rerank", "classify", "decide", "compare", "extract", "review", "gate"];

// The published input schemas (src/index.ts strictShape + evidenceSchema/candidatesSchema).
const S = (extra = {}) => ({ type: "string", ...extra });
const N01 = { type: "number", minimum: 0, maximum: 1 };
const A = (items, extra = {}) => ({ type: "array", items, ...extra });
const O = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const SLUG = "^[a-z][a-z0-9_-]*$";
const ITEM = O({ id: S(), text: S() }, ["text"]);
const EVIDENCE = { anyOf: [S(), ITEM, A(ITEM, { minItems: 1 })] };
const CANDIDATES = A(O({ id: S(), text: S() }, ["text"]), { minItems: 1, maxItems: 250 });
const PASSAGE = S({ minLength: 1, maxLength: 20000 });
const SCHEMAS = {
  verify: O({ claims: A(S(), { minItems: 1 }), evidence: EVIDENCE, auto_accept: N01 }, ["claims", "evidence"]),
  screen: O({ text: S({ minLength: 1 }), purpose: S(), block_at: N01, review_at: N01 }, ["text"]),
  noul: O({ propositions: A(S({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 64 }), context: EVIDENCE, auto_accept: { type: "number", exclusiveMinimum: 0.5, maximum: 1 } }, ["propositions"]),
  find: O({ query: S({ minLength: 1 }), candidates: CANDIDATES, top_k: { type: "integer", minimum: 1, maximum: 50 } }, ["query", "candidates"]),
  classify: O({
    items: A(O({ id: S(), text: S() }, ["text"]), { minItems: 1, maxItems: 64 }),
    classes: A(O({ id: S(), description: S() }, ["description"]), { minItems: 2, maxItems: 250 }),
    purpose: S(),
    context: { anyOf: [S(), { type: "object", propertyNames: { type: "string" }, additionalProperties: {} }] },
    auto_accept: N01,
    minimum_margin: N01,
  }, ["items", "classes"]),
  decide: O({
    decision: S({ minLength: 1, maxLength: 1500 }),
    evidence: S({ minLength: 1, maxLength: 12000 }),
    priorities: S({ minLength: 1, maxLength: 2000 }),
    candidates: A(O({ id: S({ maxLength: 64, pattern: SLUG }), description: S({ minLength: 1, maxLength: 2000 }) }, ["id", "description"]), { minItems: 2, maxItems: 6 }),
    requirements: A(S({ minLength: 1, maxLength: 500 }), { maxItems: 3 }),
    escape_hatches: { type: "boolean" },
  }, ["decision", "evidence", "priorities", "candidates"]),
  rerank: O({ query: S({ minLength: 1, maxLength: 2000 }), candidates: CANDIDATES, top_k: { type: "integer", minimum: 1, maximum: 250 } }, ["query", "candidates"]),
  compare: O({ passage_a: PASSAGE, passage_b: PASSAGE, aspects: A(S({ minLength: 1, maxLength: 200 }), { maxItems: 10 }), purpose: S(), auto_accept: N01, minimum_margin: N01 }, ["passage_a", "passage_b"]),
  extract: O({
    document: S({ minLength: 1, maxLength: 50000 }),
    fields: A(O({ id: S({ maxLength: 64, pattern: SLUG }), pattern: S({ minLength: 1, maxLength: 500 }), flags: S({ maxLength: 8 }), description: S({ minLength: 1, maxLength: 2000 }) }, ["id", "pattern", "description"]), { minItems: 1, maxItems: 32 }),
    purpose: S(),
    auto_accept: N01,
    minimum_margin: N01,
  }, ["document", "fields"]),
  review: O({ request: S({ minLength: 1 }), diff: S({ minLength: 1 }), tests: S(), auto_accept: N01, review_at: N01, composite_floor: N01 }, ["request", "diff"]),
  gate: O({ request: S({ minLength: 1 }), diff: S({ minLength: 1 }), claims: A(S({ minLength: 1 }), { minItems: 1, maxItems: 16 }), evidence: EVIDENCE, tests: S(), auto_accept: N01, review_at: N01, composite_floor: N01 }, ["request", "diff", "claims", "evidence"]),
  // jev_audit is not part of jev-mcp; any object schema stands in for it (optional, never checked).
  audit: O({ source: S(), records: A({ type: "object" }) }, ["source", "records"]),
};
const HATCHES = ["ask_user", "investigate", "none"];
const patch = process.env.FAKE_CONTROL_SCHEMA_PATCH && existsSync(process.env.FAKE_CONTROL_SCHEMA_PATCH) ? JSON.parse(readFileSync(process.env.FAKE_CONTROL_SCHEMA_PATCH, "utf8")) : {};

const listed = (process.env.FAKE_CONTROL_TOOLS ? process.env.FAKE_CONTROL_TOOLS.split(",") : [...CORE, "audit"]).filter(Boolean);
const script = process.env.FAKE_CONTROL_SCRIPT && existsSync(process.env.FAKE_CONTROL_SCRIPT) ? JSON.parse(readFileSync(process.env.FAKE_CONTROL_SCRIPT, "utf8")) : {};
const stateFile = process.env.FAKE_CONTROL_STATE;
const log = process.env.FAKE_MCP_LOG;

function nth(tool) {
  if (!stateFile) return (nth.local[tool] = (nth.local[tool] ?? 0) + 1);
  const data = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  data[tool] = (data[tool] ?? 0) + 1;
  writeFileSync(stateFile, JSON.stringify(data));
  return data[tool];
}
nth.local = {};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const content = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });

function entryFor(tool) {
  const list = script[tool];
  if (!Array.isArray(list) || list.length === 0) return {};
  return list[Math.min(nth(tool), list.length) - 1] ?? {};
}

function answer(tool, args, entry) {
  if (tool === "noul") {
    const n = args.propositions.length;
    if (entry.invalid) return { tool: "jev_noul", status: "invalid_response", results: args.propositions.map((p) => ({ proposition: p, probability: null, label: null, auto: false })) };
    const probs = entry.p ?? Array.from({ length: n }, (_, i) => Number((0.99 - i * 0.02).toFixed(4)));
    return { tool: "jev_noul", model: "fake", provider: "fake", status: "ok", results: args.propositions.map((p, i) => ({ id: `proposition${i}`, proposition: p, probability: probs[i] ?? 0.1, label: "likely", auto: true })), thresholds: { auto_accept: args.auto_accept ?? 0.85 }, usage: {} };
  }
  if (tool === "decide") {
    const ids = args.candidates.map((c) => c.id);
    const selected = entry.selected ?? ids[0];
    const escaped = entry.escaped === true;
    const confidence = entry.confidence ?? 0.97;
    // The distribution is the Choice's own (the confidence is reported separately, as upstream):
    // selected holds max(confidence, 0.5), the rest share the remainder evenly.
    const keys = [...ids, ...(args.escape_hatches === false ? [] : HATCHES)];
    if (!keys.includes(selected)) keys.push(selected);
    const top = Math.max(confidence, 0.5);
    const probabilities = entry.probabilities ?? Object.fromEntries(keys.map((k) => [k, k === selected ? top : Number(((1 - top) / (keys.length - 1)).toFixed(6))]));
    return { tool: "jev_decide", model: "fake", provider: "fake", recommendation: { selected, escaped, confidence, probabilities }, requirements_checked: 0, checks: [], warnings: entry.warnings ?? [], usage: {} };
  }
  if (tool === "rerank" || tool === "find") {
    const cands = args.candidates;
    const scores = entry.scores ?? {};
    const rows = cands.map((c, i) => ({ id: c.id, score: scores[c.id] ?? Number((0.9 - i * 0.1).toFixed(4)), text: c.text }));
    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, args.top_k ?? rows.length);
    if (tool === "rerank") return { tool: "jev_rerank", model: "fake", provider: "fake", ranked: top.map((r, i) => ({ rank: i + 1, id: r.id, relevance: r.score, text: r.text })), usage: {} };
    const exists = entry.exists ?? 0.97;
    return { tool: "jev_find", model: "fake", provider: "fake", query: args.query, exists, exists_verdict: exists >= 0.7 ? "answered" : exists < 0.35 ? "absent" : "partial", top: top.map((r) => ({ id: r.id, probability: r.score, text: r.text })), usage: {} };
  }
  if (tool === "gate") return entry.result ?? (entry.conf !== undefined ? gateAnswer(args.auto_accept ?? 0.8, { conf: entry.conf }, args.claims) : null);
  return { tool: `jev_${tool}`, usage: {} };
}

function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-jev", version: "9.9.9" } } });
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    const tools = listed.map((short) => {
      const schema = Object.hasOwn(patch, short) ? patch[short] : (SCHEMAS[short] ?? O({}, []));
      return { name: `jev_${short}`, description: short, ...(process.env.FAKE_CONTROL_NO_SCHEMA === "1" || schema === null ? {} : { inputSchema: schema }) };
    });
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name ?? "";
    const tool = name.replace(/^jev_/, "");
    const args = msg.params?.arguments ?? {};
    const entry = entryFor(tool);
    if (log) appendFileSync(log, `${JSON.stringify({ method: "tools/call", name, args })}\n`);
    if (entry.fail === "transport") process.exit(3);
    if (entry.fail === "hang") return;
    if (entry.fail === "tool_error") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Jev provider failed: upstream 500" }], isError: true } });
    const payload = answer(tool, args, entry);
    if (!payload) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    return send({ jsonrpc: "2.0", id: msg.id, result: content(payload) });
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

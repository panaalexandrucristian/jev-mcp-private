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
//   FAKE_CONTROL_NO_SCHEMA=1 lists them without an input schema.
// FAKE_MCP_LOG=<file>: JSONL, one record per tools/call with the full arguments.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gateAnswer } from "../helpers.mjs";

const CORE = ["screen", "verify", "noul", "find", "rerank", "classify", "decide", "compare", "extract", "review", "gate"];
const REQUIRED = {
  screen: ["text"], verify: ["claims", "evidence"], noul: ["propositions"], find: ["query", "candidates"], rerank: ["query", "candidates"],
  classify: ["items", "classes"], decide: ["decision", "evidence", "priorities", "candidates"], compare: ["passage_a", "passage_b"],
  extract: ["document", "fields"], review: ["request", "diff"], gate: ["request", "diff", "claims", "evidence"], audit: ["source", "records"],
};
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
    return { tool: "jev_decide", model: "fake", provider: "fake", recommendation: { selected, escaped, confidence, probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? confidence : 0.01])) }, requirements_checked: 0, checks: [], warnings: entry.warnings ?? [], usage: {} };
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
    const tools = listed.map((short) => ({
      name: `jev_${short}`,
      description: short,
      ...(process.env.FAKE_CONTROL_NO_SCHEMA === "1" ? {} : { inputSchema: { type: "object", properties: Object.fromEntries([...(REQUIRED[short] ?? []), "auto_accept", "top_k", "context", "escape_hatches", "requirements", "tests"].map((k) => [k, {}])), required: REQUIRED[short] ?? [] } }),
    }));
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

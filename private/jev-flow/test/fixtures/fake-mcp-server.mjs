#!/usr/bin/env node
// Fake jev MCP server on stdio for the jev-flow tests: no network, no model.
// FAKE_MCP_MODE: accepted (default) | escalate | contradicted | unsupported |
//   invalid | tool_error | crash | hang | hang_init | fragment | noise | bad_init
// FAKE_MCP_LOG: JSONL file receiving one record per request (method, tool,
//   argument summary, JEV_PROVIDER as seen by the server, full arguments).
// FAKE_MCP_FAIL_FIRST=1: the first tools/call answers invalid_response.
// FAKE_MCP_TOUCH=<file>: every tools/call appends a line to that file first
//   (a work-tree change during the gate).
// FAKE_MCP_MALFORMED=first|always: tools/call answers a malformed result
//   (jev_gate "auto" without review; jev_rerank ranking unknown ids) the first
//   time (counted across processes through FAKE_MCP_STATE) or always.
// FAKE_MCP_CRASH=once|always|once_then_dead: tools/call kills the server;
//   once_then_dead also makes every later server exit at startup.
// FAKE_MCP_STATE=<file>: cross-process counter file used by the two above.
// FAKE_MCP_MODES=m1,m2,...: the mode of the Nth tools/call (the last one
//   repeats); counted across processes through FAKE_MCP_STATE when set (a
//   reconnection starts a new server), otherwise within this process.
//   FAKE_MCP_MODE stays the default for everything else.
// FAKE_MCP_LOG_STARTS=1: every server start (connection) is also logged as
//   {method: "start"} ({dead: true} when once_then_dead makes it exit at once).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { acceptedGate } from "../helpers.mjs";

const baseMode = process.env.FAKE_MCP_MODE ?? "accepted";
const modes = (process.env.FAKE_MCP_MODES ?? "").split(",").map((m) => m.trim()).filter(Boolean);
let mode = baseMode;
const stateFile = process.env.FAKE_MCP_STATE;
const counter = (name) => {
  if (!stateFile) return 0;
  const data = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  data[name] = (data[name] ?? 0) + 1;
  writeFileSync(stateFile, JSON.stringify(data));
  return data[name];
};
const log = process.env.FAKE_MCP_LOG;
let calls = 0;

function record(entry) {
  if (log) appendFileSync(log, `${JSON.stringify({ ...entry, provider: process.env.JEV_PROVIDER ?? null, openrouter_set: Boolean(process.env.OPENROUTER_API_KEY) })}\n`);
}

const dead = process.env.FAKE_MCP_CRASH === "once_then_dead" && stateFile && existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).crash;
if (process.env.FAKE_MCP_LOG_STARTS === "1") record({ method: "start", ...(dead ? { dead: true } : {}) });
if (dead) process.exit(4);

function send(message) {
  const text = `${JSON.stringify(message)}\n`;
  if (mode === "fragment") {
    // Split every message into small chunks written separately.
    for (let i = 0; i < text.length; i += 7) process.stdout.write(text.slice(i, i + 7));
    return;
  }
  process.stdout.write(text);
}

const content = (payload, isError = false) => ({ content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) });

function gateResult(args) {
  const claims = Array.isArray(args?.claims) ? args.claims : [];
  const base = acceptedGate({}, claims);
  if (mode === "escalate") return { ...base, action: "escalate", reason_codes: ["review_escalated"], review: { ...base.review, action: "escalate", reason_codes: ["review_escalated"] } };
  if (mode === "unsupported") {
    return {
      ...base,
      action: "review",
      reason_codes: ["claims_unsupported"],
      verification: { ...base.verification, action: "review", summary: { ...base.verification.summary, verified: 0, unsupported: claims.length }, results: claims.map((claim) => ({ claim, verdict: "unsupported", confidence: 0.6, action: "review" })) },
    };
  }
  if (mode === "contradicted") {
    return {
      ...base,
      action: "review",
      reason_codes: ["claims_contradicted"],
      verification: { ...base.verification, action: "review", summary: { ...base.verification.summary, verified: 0, contradicted: claims.length }, results: claims.map((claim) => ({ claim, verdict: "contradicted", confidence: 0.9, action: "review" })) },
    };
  }
  return base;
}

function rerankResult(args) {
  const cands = Array.isArray(args?.candidates) ? args.candidates : [];
  const ranked = [...cands].reverse().slice(0, args?.top_k ?? cands.length).map((c, i) => ({ rank: i + 1, id: c.id, relevance: Number((0.9 - i * 0.1).toFixed(4)), text: c.text }));
  return { tool: "jev_rerank", model: "fake", provider: "fake", query: args?.query, summary: { candidates: cands.length, returned: ranked.length }, ranked, usage: {} };
}

function findResult(args) {
  const cands = Array.isArray(args?.candidates) ? args.candidates : [];
  return { tool: "jev_find", model: "fake", provider: "fake", query: args?.query, exists: 0.97, exists_verdict: "present", top: cands.slice(0, args?.top_k ?? 5).map((c, i) => ({ id: c.id, probability: Number((0.8 / (i + 1)).toFixed(4)), text: c.text })), usage: {} };
}

function handle(msg) {
  if (msg.method === "initialize") {
    record({ method: "initialize", protocolVersion: msg.params?.protocolVersion });
    if (mode === "hang_init") return;
    if (mode === "bad_init") return send({ jsonrpc: "2.0", id: msg.id, result: { nothing: true } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-jev", version: "0.0.0" } } });
  }
  if (msg.method === "notifications/initialized") return record({ method: "notifications/initialized" });
  if (msg.method === "tools/call") {
    calls += 1;
    if (modes.length) {
      const nth = stateFile ? counter("modes") : calls;
      mode = modes[Math.min(nth, modes.length) - 1];
    }
    const { name, arguments: args } = msg.params ?? {};
    record({ method: "tools/call", mode, name, claims: args?.claims?.length ?? null, evidence: Array.isArray(args?.evidence) ? args.evidence.map((e) => e.id) : null, request_first_line: String(args?.request ?? "").split("\n", 1)[0], args });
    if (process.env.FAKE_MCP_TOUCH) appendFileSync(process.env.FAKE_MCP_TOUCH, "changed during the gate\n");
    const crash = process.env.FAKE_MCP_CRASH;
    if (crash === "always" || ((crash === "once" || crash === "once_then_dead") && counter("crash") === 1)) process.exit(3);
    const malformed = process.env.FAKE_MCP_MALFORMED;
    if (malformed === "always" || (malformed === "first" && counter("malformed") === 1)) {
      const bad = name === "jev_gate"
        ? { tool: "jev_gate", action: "auto", reason_codes: ["accepted"], truncated: false }
        : { tool: name, ranked: [{ rank: 1, id: "no-such-id", relevance: 0.9 }], top: [{ id: "no-such-id", probability: 0.9 }], exists_verdict: "present" };
      return send({ jsonrpc: "2.0", id: msg.id, result: content(bad) });
    }
    if (mode === "crash") process.exit(3);
    if (mode === "hang") return;
    if (mode === "tool_error") return send({ jsonrpc: "2.0", id: msg.id, result: content("Jev provider failed: upstream 500", true) });
    if (mode === "invalid" || (process.env.FAKE_MCP_FAIL_FIRST === "1" && calls === 1)) {
      return send({ jsonrpc: "2.0", id: msg.id, result: content({ tool: name, status: "invalid_response", reason_codes: ["invalid_response"] }) });
    }
    const payload = name === "jev_gate" ? gateResult(args) : name === "jev_rerank" ? rerankResult(args) : name === "jev_find" ? findResult(args) : null;
    if (!payload) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    return send({ jsonrpc: "2.0", id: msg.id, result: content(payload) });
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

if (mode === "noise") process.stdout.write("fake-jev starting (not JSON)\n");
process.stderr.write("fake-jev: stderr line with OPENROUTER_API_KEY=sk-or-v1-abcdefabcdefabcdefabcdefabcdefabcdefabcdef\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

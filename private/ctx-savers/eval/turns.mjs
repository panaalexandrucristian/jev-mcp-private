#!/usr/bin/env node
// Turn analysis of a session transcript: what each model call (API call) cost in tokens and time, and which consecutive calls could have been one.
//   node eval/turns.mjs [--json]
import { loadTranscript, command } from "../lib/transcript.mjs";

const t = loadTranscript();
const KNOWN_UNITS = { input: 1, cacheWrite1h: 2, cacheRead: 0.1, output: 5 }; // price RATIOS assumed from the usual list-price structure, not this account's bill
const calls = new Map();
for (const d of t.chain) {
  if (d.type !== "assistant") continue;
  const id = d.message?.id ?? d.requestId;
  if (!calls.has(id)) calls.set(id, { id, ts: d.timestamp, entries: [], usage: null, tools: [] });
  const c = calls.get(id);
  c.entries.push(d);
  if (d.message?.usage) c.usage = d.message.usage;
  for (const b of d.message?.content ?? []) if (b?.type === "tool_use") c.tools.push({ id: b.id, name: b.name, input: b.input ?? {} });
  c.lastTs = d.timestamp;
}
const list = [...calls.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
// results by tool_use id, with the time the result message was written
const resultAt = new Map(); const resultText = new Map();
for (const d of t.chain) {
  if (d.type !== "user" || !Array.isArray(d.message?.content)) continue;
  for (const b of d.message.content) if (b?.type === "tool_result") { resultAt.set(b.tool_use_id, d.timestamp); resultText.set(b.tool_use_id, typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "").slice(0, 20000)); }
}
const sum = (f) => list.reduce((s, c) => s + (f(c) ?? 0), 0);
const u = (c, k) => c.usage?.[k] ?? 0;
const totals = { calls: list.length, input: sum((c) => u(c, "input_tokens")), cacheWrite: sum((c) => u(c, "cache_creation_input_tokens")), cacheRead: sum((c) => u(c, "cache_read_input_tokens")), output: sum((c) => u(c, "output_tokens")), thinking: sum((c) => c.usage?.output_tokens_details?.thinking_tokens ?? 0) };
const units = { input: totals.input * KNOWN_UNITS.input, cacheWrite: totals.cacheWrite * KNOWN_UNITS.cacheWrite1h, cacheRead: totals.cacheRead * KNOWN_UNITS.cacheRead, output: totals.output * KNOWN_UNITS.output };
const unitSum = Object.values(units).reduce((s, x) => s + x, 0);
const secs = (a, b) => (new Date(b) - new Date(a)) / 1000;
// time split: model time = from the previous event (user prompt or tool result) to this call's last entry; tool time = from the call's last entry to the result; gaps over 120 s are human waits
let modelTime = 0; let toolTime = 0; let humanWait = 0; let prevEnd = null;
for (const c of list) {
  const start = prevEnd; if (start) { const g = secs(start, c.lastTs); if (g > 120) humanWait += g; else modelTime += g; }
  const ends = c.tools.map((x) => resultAt.get(x.id)).filter(Boolean).sort();
  if (ends.length) { const g = secs(c.lastTs, ends.at(-1)); if (g > 120) humanWait += g; else toolTime += g; prevEnd = ends.at(-1); } else prevEnd = c.lastTs;
}
const ctxAt = (c) => u(c, "input_tokens") + u(c, "cache_creation_input_tokens") + u(c, "cache_read_input_tokens");
const avgCtx = Math.round(list.reduce((s, c) => s + ctxAt(c), 0) / list.length);
const avgModelTurnSecs = modelTime / list.length;
// dependency between consecutive single-tool calls: does the next input use NEW information from the previous result?
const toks = (s) => new Set(String(s).match(/[\w./~-]{7,}/g) ?? []);
const known = new Set();
for (const d of t.chain) if (d.type === "user" && !Array.isArray(d.message?.content)) toks(d.message?.content ?? "").forEach((x) => known.add(x));
const pairs = [];
for (let i = 0; i < list.length - 1; i += 1) {
  const a = list[i]; const b = list[i + 1];
  for (const x of a.tools) toks(JSON.stringify(x.input)).forEach((k) => known.add(k));
  if (a.tools.length !== 1 || b.tools.length !== 1) continue;
  const r = resultText.get(a.tools[0].id) ?? ""; const fresh = [...toks(r)].filter((k) => !known.has(k));
  const nextIn = toks(JSON.stringify(b.tools[0].input));
  const uses = fresh.filter((k) => nextIn.has(k));
  pairs.push({ i, a: `${a.tools[0].name}`, b: `${b.tools[0].name}`, aWhat: (a.tools[0].input.command ?? a.tools[0].input.file_path ?? "").slice(0, 70), bWhat: (b.tools[0].input.command ?? b.tools[0].input.file_path ?? "").slice(0, 70), aTool: a.tools[0], bTool: b.tools[0], independent: uses.length === 0, ts: a.ts.slice(11, 19), ctxB: ctxAt(b), outB: u(b, "output_tokens") });
}
const indep = pairs.filter((p) => p.independent);
const saved = { turns: indep.length, cacheReadTokens: indep.reduce((s, p) => s + p.ctxB, 0), outputTokens: indep.reduce((s, p) => s + p.outB, 0), seconds: Math.round(indep.length * avgModelTurnSecs) };
// named patterns
const pat = { screenshotCycle: 0, gradleThenResults: 0, readThenRead: 0, gitSeparate: 0 };
for (let i = 0; i < list.length - 1; i += 1) {
  const a = list[i]; const b = list[i + 1]; const ax = a.tools.at(-1); const bx = b.tools[0]; if (!ax || !bx) continue;
  if (ax.name === "Bash" && /screen capture|screencap/.test(command({ input: ax.input })) && bx.name === "Read" && /\.png$/.test(bx.input.file_path ?? "")) pat.screenshotCycle += 1;
  if (ax.name === "Bash" && /gradlew/.test(command({ input: ax.input })) && bx.name === "Bash" && /test-results/.test(command({ input: bx.input }))) pat.gradleThenResults += 1;
  if (a.tools.length === 1 && b.tools.length === 1 && ax.name === "Read" && bx.name === "Read") pat.readThenRead += 1;
  if (ax.name === "Bash" && /^\s*(cd [^&]+&& )?git (status|log|diff|branch|rev-parse)/.test(command({ input: ax.input })) && bx.name === "Bash" && /^\s*(cd [^&]+&& )?git (status|log|diff|branch|rev-parse)/.test(command({ input: bx.input }))) pat.gitSeparate += 1;
}
const out = { totals, units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, +(100 * v / unitSum).toFixed(1)])), avgContextTokens: avgCtx, avgCacheReadPerCall: Math.round(totals.cacheRead / list.length), outputPerCall: Math.round(totals.output / list.length), thinkingShareOfOutput: +(totals.thinking / totals.output).toFixed(2), time: { modelSecs: Math.round(modelTime), toolSecs: Math.round(toolTime), humanWaitSecs: Math.round(humanWait), avgModelTurnSecs: +avgModelTurnSecs.toFixed(1) }, parallelCalls: list.filter((c) => c.tools.length > 1).length, singleToolCalls: list.filter((c) => c.tools.length === 1).length, noToolCalls: list.filter((c) => c.tools.length === 0).length, consecutiveSingleToolPairs: pairs.length, independentPairs: indep.length, savedIfMerged: saved, patterns: pat, firstIndependent: indep };

// conservative classes of mergeable pairs (judged by the shape of the two calls, not only by the token heuristic)
const READONLY = /^\s*(cd [^&;]+&& )?(echo [^;&]*&& )?(git (status|log|diff|branch|rev-parse|show|ls-files)|command -v|rg |grep |sed -n|cat |ls |head |wc |find |tail )/;
const isReadOnlyCall = (x) => ["Read", "Grep", "Glob"].includes(x.name) || (x.name === "Bash" && READONLY.test(String(x.input.command ?? "")) && !/(&&|;)\s*(git (add|commit|checkout|reset)|rm |mv |adb .*input|gradlew)/.test(String(x.input.command ?? "")));
const classes = { screenshotThenRead: [], gradleThenResults: [], writeThenRun: [], readOnlyBatch: [] };
for (const p of indep) {
  const a = p.aTool; const b = p.bTool; const A = String(a.input.command ?? ""); const B = String(b.input.command ?? "");
  if (a.name === "Bash" && /screen capture|screencap/.test(A) && b.name === "Read" && /\.png$/.test(b.input.file_path ?? "")) classes.screenshotThenRead.push(p);
  else if (a.name === "Bash" && /gradlew/.test(A) && b.name === "Bash" && /test-results/.test(B)) classes.gradleThenResults.push(p);
  else if (a.name === "Write" && b.name === "Bash" && B.includes(String(a.input.file_path ?? "").split("/").at(-1))) classes.writeThenRun.push(p);
  else if (isReadOnlyCall(a) && isReadOnlyCall(b)) classes.readOnlyBatch.push(p);
}
const unitsOf = (ps) => ps.reduce((s, p) => s + p.ctxB * KNOWN_UNITS.cacheRead + p.outB * KNOWN_UNITS.output, 0);
out.mergeable = Object.fromEntries(Object.entries(classes).map(([k, ps]) => [k, { pairs: ps.length, turns: ps.length, costSharePercent: +(100 * unitsOf(ps) / unitSum).toFixed(1), seconds: Math.round(ps.length * avgModelTurnSecs), at: ps.map((p) => p.ts) }]));
const all = Object.values(classes).flat();
out.mergeableTotal = { turns: all.length, costSharePercent: +(100 * unitsOf(all) / unitSum).toFixed(1), seconds: Math.round(all.length * avgModelTurnSecs), shareOfAllCalls: +(all.length / list.length).toFixed(2), shareOfSingleToolCalls: +(all.length / out.singleToolCalls).toFixed(2) };
for (const p of out.firstIndependent) { delete p.aTool; delete p.bTool; }
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1)); else console.log(JSON.stringify(out, null, 1));

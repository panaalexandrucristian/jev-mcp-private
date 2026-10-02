import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CORE_TOOLS, LIMITS, TOOL_KEYS, checkTools, parseDecideResult, parseNoulResult, parseRankResult, toolBase, validateArgs } from "../contracts.mjs";
import { REPO_ROOT } from "./helpers.mjs";

const source = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
const lib = readFileSync(join(REPO_ROOT, "src", "lib.ts"), "utf8");
const limit = (name) => Number(lib.match(new RegExp(`export const ${name} = ([0-9_]+);`))[1].replace(/_/g, ""));

function schemaKeys() {
  const keys = {};
  const toolRe = /(?:server|tools)\.registerTool\(\s*"(jev_\w+)"/g;
  let match;
  while ((match = toolRe.exec(source))) {
    const start = source.indexOf("inputSchema: strictShape({", match.index);
    const body = source.slice(start, source.indexOf("\n    }),", start));
    keys[match[1]] = [...body.matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]);
  }
  return keys;
}

const listOf = (names, schema = true) => ({ tools: names.map((n) => ({ name: n, ...(schema ? { inputSchema: { type: "object", properties: Object.fromEntries((TOOL_KEYS[n.replace(/^.*jev_/, "")]?.required ?? ["x"]).map((k) => [k, {}])) } } : {}) })) });

describe("the limits mirror the upstream source", () => {
  it("numeric limits equal src/lib.ts", () => {
    assert.equal(LIMITS.decideCandidates, limit("MAX_CANDIDATES_DECIDE"));
    assert.equal(LIMITS.decideRequirements, limit("MAX_REQUIREMENTS"));
    assert.equal(LIMITS.noulPropositions, limit("MAX_PROPOSITIONS"));
    assert.equal(LIMITS.noulPropositionChars, limit("MAX_PROPOSITION_CHARS"));
    assert.equal(LIMITS.noulTotalChars, limit("MAX_NOUL_TOTAL_CHARS"));
    assert.equal(LIMITS.rerankCandidates, limit("MAX_RERANK_CANDIDATES"));
    assert.equal(LIMITS.rerankTotalChars, limit("MAX_RERANK_TOTAL_CHARS"));
    assert.equal(LIMITS.candidateChars, limit("MAX_CANDIDATE_CHARS"));
    assert.equal(LIMITS.gateClaims, limit("MAX_GATE_CLAIMS"));
  });
  it("every key the control uses exists in the tool's input schema, and the required ones are the documented ones", () => {
    const keys = schemaKeys();
    for (const [tool, { used, required }] of Object.entries(TOOL_KEYS)) {
      const real = keys[`jev_${tool}`];
      assert.ok(real, `jev_${tool} not found in src/index.ts`);
      for (const k of used) assert.ok(real.includes(k), `jev_${tool} has no ${k}`);
      for (const k of required) assert.ok(real.includes(k), `jev_${tool} has no required ${k}`);
    }
  });
  it("the decide escape hatches and the top_k bounds are the source's", () => {
    assert.match(source, /top_k: z\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)/);
    assert.match(source, /top_k: z\.number\(\)\.int\(\)\.min\(1\)\.max\(250\)/);
    assert.match(source, /\.gt\(0\.5\)/);
    assert.match(source, /ask_user/);
    assert.match(source, /investigate/);
  });
});

describe("tool discovery at activation", () => {
  it("accepts all eleven core tools and sees the optional audit", () => {
    const r = checkTools(listOf([...CORE_TOOLS, "audit"].map((n) => `jev_${n}`)));
    assert.equal(r.ok, true);
    assert.equal(r.audit, true);
  });
  it("audit is optional", () => {
    const r = checkTools(listOf(CORE_TOOLS.map((n) => `jev_${n}`)));
    assert.equal(r.ok, true);
    assert.equal(r.audit, false);
  });
  it("a missing core tool is named", () => {
    const names = CORE_TOOLS.filter((t) => t !== "decide").map((n) => `jev_${n}`);
    const r = checkTools(listOf(names));
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["decide"]);
  });
  it("an incompatible schema is refused", () => {
    const r = checkTools({ tools: [...listOf(CORE_TOOLS.filter((t) => t !== "noul").map((n) => `jev_${n}`)).tools, { name: "jev_noul", inputSchema: { type: "object", properties: { other: {} } } }] });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.incompatible), /noul/);
    const none = checkTools(listOf(CORE_TOOLS.map((n) => `jev_${n}`), false));
    assert.equal(none.ok, false);
  });
  it("accepts both Claude Code name forms", () => {
    for (const prefix of ["mcp__jev__", "mcp__plugin_jev_jev__"]) {
      const r = checkTools(listOf(CORE_TOOLS.map((n) => `${prefix}jev_${n}`)));
      assert.equal(r.ok, true, prefix);
      assert.equal(r.prefix, prefix);
    }
    assert.equal(toolBase("mcp__plugin_jev_jev__jev_decide"), "decide");
    assert.equal(toolBase("mcp__jev__jev_noul"), "noul");
    assert.equal(toolBase("jev_rerank"), "rerank");
    assert.equal(toolBase("Read"), null);
    assert.equal(toolBase("mcp__other__jev_decide"), null);
  });
});

describe("argument validation (nothing invalid is sent)", () => {
  it("noul", () => {
    assert.deepEqual(validateArgs("noul", { propositions: ["a statement"], auto_accept: 0.9 }), []);
    assert.ok(validateArgs("noul", { propositions: [] }).length);
    assert.ok(validateArgs("noul", { propositions: ["x".repeat(2001)] }).length);
    assert.ok(validateArgs("noul", { propositions: Array(65).fill("a") }).length);
    assert.ok(validateArgs("noul", { propositions: ["a"], auto_accept: 0.5 }).includes("auto_accept_domain"), "auto_accept must exceed 0.5");
    assert.ok(validateArgs("noul", { propositions: ["a"], extra: 1 }).includes("unknown_key:extra"));
  });
  it("decide", () => {
    const ok = { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "a", description: "x" }, { id: "b", description: "y" }] };
    assert.deepEqual(validateArgs("decide", ok), []);
    assert.ok(validateArgs("decide", { ...ok, candidates: [ok.candidates[0]] }).includes("candidates_count"));
    assert.ok(validateArgs("decide", { ...ok, candidates: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, description: "x" })) }).includes("candidates_count"));
    assert.match(validateArgs("decide", { ...ok, candidates: [{ id: "ask_user", description: "x" }, ok.candidates[1]] }).join(), /collides_with_escape_hatch/);
    assert.match(validateArgs("decide", { ...ok, candidates: [{ id: "Bad", description: "x" }, ok.candidates[1]] }).join(), /candidate_id_invalid/);
    assert.ok(validateArgs("decide", { ...ok, priorities: "" }).includes("priorities_length"));
    assert.ok(validateArgs("decide", { ...ok, requirements: ["a", "b", "c", "d"] }).includes("requirements_count"));
  });
  it("rerank and find", () => {
    const ok = { query: "q", candidates: [{ id: "c0", text: "t" }], top_k: 5 };
    assert.deepEqual(validateArgs("rerank", ok), []);
    assert.deepEqual(validateArgs("find", ok), []);
    assert.ok(validateArgs("find", { ...ok, top_k: 51 }).includes("top_k_range"));
    assert.deepEqual(validateArgs("rerank", { ...ok, top_k: 51 }), []);
    assert.ok(validateArgs("rerank", { ...ok, candidates: Array.from({ length: 251 }, (_, i) => ({ id: `c${i}`, text: "t" })) }).includes("candidates_count"));
    assert.ok(validateArgs("rerank", { ...ok, candidates: [{ id: "a", text: "t" }, { id: "a", text: "u" }] }).length);
  });
});

describe("result parsing: nothing missing or malformed is a score", () => {
  it("noul", () => {
    assert.deepEqual(parseNoulResult({ tool: "jev_noul", status: "ok", results: [{ probability: 0.9 }, { probability: 0.1 }] }, 2), { ok: true, probabilities: [0.9, 0.1] });
    for (const bad of [null, { tool: "jev_noul", status: "invalid_response" }, { tool: "jev_noul", results: [{ probability: 1.5 }] }, { tool: "jev_noul", results: [{ probability: "0.9" }] }, { tool: "jev_noul", results: [] }]) assert.equal(parseNoulResult(bad, 1).ok, false);
  });
  it("decide", () => {
    const rec = (r) => ({ tool: "jev_decide", recommendation: r });
    assert.equal(parseDecideResult(rec({ selected: "a", escaped: false, confidence: 0.97 }), ["a", "b"]).ok, true);
    assert.equal(parseDecideResult(rec({ selected: "z", escaped: false, confidence: 0.97 }), ["a", "b"]).ok, false);
    assert.equal(parseDecideResult(rec({ selected: "ask_user", escaped: true, confidence: 0.6 }), ["a", "b"]).ok, true);
    assert.equal(parseDecideResult(rec({ selected: "weird", escaped: true, confidence: 0.6 }), ["a"]).ok, false);
    assert.equal(parseDecideResult(rec({ selected: "a", escaped: false, confidence: null }), ["a"]).ok, false);
    assert.equal(parseDecideResult({ tool: "jev_decide", recommendation: { status: "invalid_response" } }, ["a"]).ok, false);
  });
  it("rerank and find", () => {
    const rr = { tool: "jev_rerank", ranked: [{ id: "a", relevance: 0.4 }, { id: "b", relevance: 0.9 }] };
    assert.deepEqual(parseRankResult("rerank", rr, ["a", "b"], 5).ranked.map((r) => r.id), ["b", "a"]);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 0.4 }, { id: "a", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "x", relevance: 0.4 }, { id: "b", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 1.5 }, { id: "b", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 0.4 }] }, ["a", "b"], 5).ok, false, "partial");
    const find = { tool: "jev_find", exists: 0.9, top: [{ id: "a", probability: 0.9 }, { id: "b", probability: 0.1 }] };
    assert.equal(parseRankResult("find", find, ["a", "b"], 5).exists, 0.9);
    assert.equal(parseRankResult("find", { ...find, exists: "0.9" }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("find", { ...find, exists: undefined }, ["a", "b"], 5).ok, false);
  });
});

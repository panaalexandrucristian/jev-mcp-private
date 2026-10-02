import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import { CORE_TOOLS, DECIDE_HATCHES, LIMITS, SENT_SHAPES, TOOL_KEYS, checkTools, parseDecideResult, parseNoulResult, parseRankResult, toolBase, validateArgs } from "../contracts.mjs";
import { FAKE_CONTROL_SERVER, REPO_ROOT, tempDir } from "./helpers.mjs";

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

/** One stdio JSON-RPC exchange with a server: initialize, then `method`; resolves with its result. */
function rpc(env, method, params = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_CONTROL_SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => (child.kill(), reject(new Error(`${method} timed out`))), 10_000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}
const payloadOf = (result) => JSON.parse(result.content[0].text);

// The fake server publishes the real schemas (contracts-real.test.mjs proves it against dist/);
// every negative case below mutates a deep copy of that list.
let base;
before(async () => {
  base = await rpc({}, "tools/list");
});
const copy = () => structuredClone(base);
const schemaOf = (list, short) => list.tools.find((t) => t.name === `jev_${short}`).inputSchema;
function mutated(short, edit) {
  const list = copy();
  edit(schemaOf(list, short));
  return list;
}
const reasons = (r, short) => r.incompatible.filter((i) => i.tool === short).map((i) => i.reason);

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
    assert.equal(LIMITS.gateEvidenceItems, limit("MAX_GATE_EVIDENCE_ITEMS"));
    assert.equal(LIMITS.reviewDocChars, limit("MAX_REVIEW_DOC_CHARS"));
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
  it("the sent shapes cover exactly the keys the control uses, for every core tool", () => {
    assert.deepEqual(Object.keys(SENT_SHAPES).sort(), [...CORE_TOOLS].sort());
    for (const tool of CORE_TOOLS) assert.deepEqual(Object.keys(SENT_SHAPES[tool]).sort(), [...TOOL_KEYS[tool].used].sort(), tool);
  });
  it("the decide escape hatches, the requirement length and the top_k bounds are the source's", () => {
    assert.match(source, /top_k: z\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)/);
    assert.match(source, /top_k: z\.number\(\)\.int\(\)\.min\(1\)\.max\(250\)/);
    assert.match(source, /\.gt\(0\.5\)/);
    assert.match(source, /requirements: z\s*\.array\(z\.string\(\)\.min\(1\)\.max\(500\)\)/);
    const hatches = lib.match(/export const DECIDE_ESCAPE_HATCHES[^=]*= \{([\s\S]*?)\n\};/)[1];
    assert.deepEqual([...hatches.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), [...DECIDE_HATCHES]);
  });
});

describe("tool discovery at activation", () => {
  it("the real-shaped list passes: all eleven core tools and the optional audit", () => {
    const r = checkTools(base);
    assert.deepEqual(r.incompatible, []);
    assert.equal(r.ok, true);
    assert.equal(r.audit, true);
  });
  it("audit is optional", () => {
    const list = copy();
    list.tools = list.tools.filter((t) => t.name !== "jev_audit");
    const r = checkTools(list);
    assert.equal(r.ok, true);
    assert.equal(r.audit, false);
  });
  it("a missing core tool is named", () => {
    const list = copy();
    list.tools = list.tools.filter((t) => t.name !== "jev_decide");
    const r = checkTools(list);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["decide"]);
  });
  it("accepts both Claude Code name forms", () => {
    for (const prefix of ["mcp__jev__", "mcp__plugin_jev_jev__"]) {
      const list = copy();
      for (const t of list.tools) t.name = `${prefix}${t.name}`;
      const r = checkTools(list);
      assert.equal(r.ok, true, prefix);
      assert.equal(r.prefix, prefix);
    }
    assert.equal(toolBase("mcp__plugin_jev_jev__jev_decide"), "decide");
    assert.equal(toolBase("mcp__jev__jev_noul"), "noul");
    assert.equal(toolBase("jev_rerank"), "rerank");
    assert.equal(toolBase("Read"), null);
    assert.equal(toolBase("mcp__other__jev_decide"), null);
  });
  it("no schema, or a schema without properties, is refused", () => {
    const list = copy();
    for (const t of list.tools) delete t.inputSchema;
    assert.equal(checkTools(list).ok, false);
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => delete s.properties)), "noul"), ["no_input_schema"]);
  });
  it("the same keys with incompatible types are refused", () => {
    const cases = [
      ["noul", (s) => (s.properties.propositions = { type: "number" }), "type:propositions=number"],
      ["noul", (s) => (s.properties.propositions.items = { type: "number" }), "type:propositions[]=number"],
      ["noul", (s) => (s.properties.context = { type: "number" }), "type:context=number"],
      ["decide", (s) => (s.properties.candidates = { type: "number" }), "type:candidates=number"],
      ["decide", (s) => (s.properties.candidates.items.properties.id = { type: "integer" }), "type:candidates[].id=integer"],
      ["decide", (s) => (s.properties.escape_hatches = { type: "string" }), "type:escape_hatches=string"],
      ["rerank", (s) => (s.properties.candidates.items = { type: "string" }), "type:candidates[]=string"],
      ["find", (s) => (s.properties.top_k = { type: "string" }), "type:top_k=string"],
      ["gate", (s) => (s.properties.evidence = { type: "number" }), "type:evidence=number"],
      ["verify", (s) => (s.properties.evidence = { anyOf: [{ type: "number" }, { type: "boolean" }] }), "type:evidence=number|boolean"],
      ["verify", (s) => (s.properties.auto_accept = { type: "string" }), "type:auto_accept=string"],
      ["screen", (s) => (s.properties.text = { type: "array", items: { type: "string" } }), "type:text=array"],
    ];
    for (const [tool, edit, reason] of cases) {
      const r = checkTools(mutated(tool, edit));
      assert.equal(r.ok, false, reason);
      assert.deepEqual(reasons(r, tool), [reason]);
    }
  });
  it("a tool the control sends auto_accept to must declare it, over the whole (0.5, 1) range", () => {
    for (const tool of ["noul", "gate", "review", "verify", "classify", "compare", "extract"]) {
      const r = checkTools(mutated(tool, (s) => delete s.properties.auto_accept));
      assert.deepEqual(reasons(r, tool), ["missing_auto_accept"], tool);
    }
    // decide, find, rerank and screen take none, so none is needed.
    for (const tool of ["decide", "find", "rerank", "screen"]) assert.equal(TOOL_KEYS[tool].used.includes("auto_accept"), false, tool);
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => (s.properties.auto_accept.exclusiveMinimum = 0.6))), "noul"), ["range:auto_accept"]);
    assert.deepEqual(reasons(checkTools(mutated("gate", (s) => (s.properties.auto_accept.maximum = 0.9))), "gate"), ["range:auto_accept"]);
    assert.deepEqual(reasons(checkTools(mutated("review", (s) => (s.properties.auto_accept = { type: "integer", minimum: 0, maximum: 1 }))), "review"), ["type:auto_accept=integer"]);
    // draft-4 boolean exclusives: minimum 0.5 exclusive still accepts every T > 0.5.
    assert.equal(checkTools(mutated("noul", (s) => (s.properties.auto_accept = { type: "number", minimum: 0.5, exclusiveMinimum: true, maximum: 1 }))).ok, true);
  });
  it("a missing key the control sends is refused", () => {
    assert.deepEqual(reasons(checkTools(mutated("find", (s) => delete s.properties.top_k)), "find"), ["missing_key:top_k"]);
    assert.deepEqual(reasons(checkTools(mutated("decide", (s) => delete s.properties.candidates.items.properties.description)), "decide"), ["missing_key:candidates[].description"]);
    assert.deepEqual(reasons(checkTools(mutated("gate", (s) => delete s.properties.tests)), "gate"), ["missing_key:tests"]);
  });
  it("a required key the control never sends, or does not always send, is refused", () => {
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => { s.properties.session = { type: "string" }; s.required.push("session"); })), "noul"), ["required_unused:session"]);
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => s.required.push("auto_accept"))), "noul"), ["required_optional:auto_accept"]);
    assert.deepEqual(reasons(checkTools(mutated("rerank", (s) => s.required.push("top_k"))), "rerank"), ["required_optional:top_k"]);
    assert.deepEqual(reasons(checkTools(mutated("gate", (s) => s.required.push("purpose"))), "gate"), ["required_unused:purpose"]);
    assert.deepEqual(reasons(checkTools(mutated("rerank", (s) => s.properties.candidates.items.required.push("score"))), "rerank"), ["required_unused:candidates[].score"]);
  });
  it("limits narrower than what the control sends are refused (gate, decide, noul, find, rerank)", () => {
    const cases = [
      ["gate", (s) => (s.properties.claims.maxItems = 8), "limit:claims.maxItems=8<16"],
      ["gate", (s) => (s.properties.diff.maxLength = 10_000), "limit:diff.maxLength=10000<50000"],
      ["gate", (s) => (s.properties.evidence.anyOf[2].maxItems = 4), "limit:evidence.maxItems=4<16"],
      ["decide", (s) => (s.properties.candidates.maxItems = 4), "limit:candidates.maxItems=4<6"],
      ["decide", (s) => (s.properties.candidates.minItems = 3), "limit:candidates.minItems=3>2"],
      ["decide", (s) => (s.properties.evidence.maxLength = 4000), "limit:evidence.maxLength=4000<12000"],
      ["decide", (s) => (s.properties.candidates.items.properties.id.pattern = "^[a-z]+$"), "pattern:candidates[].id"],
      ["noul", (s) => (s.properties.propositions.maxItems = 32), "limit:propositions.maxItems=32<64"],
      ["noul", (s) => (s.properties.propositions.items.maxLength = 500), "limit:propositions[].maxLength=500<2000"],
      ["noul", (s) => (s.properties.propositions.items.pattern = "^[A-Z]"), "pattern:propositions[]"],
      ["find", (s) => (s.properties.top_k.maximum = 3), "range:top_k"],
      ["rerank", (s) => (s.properties.candidates.maxItems = 48), "limit:candidates.maxItems=48<250"],
      ["rerank", (s) => (s.properties.candidates.items.properties.text.maxLength = 2000), "limit:candidates[].text.maxLength=2000<100000"],
    ];
    for (const [tool, edit, reason] of cases) assert.deepEqual(reasons(checkTools(mutated(tool, edit)), tool), [reason], reason);
    // An agent-written string (review, compare, ...) is only typed: its size is the agent's to respect.
    assert.equal(checkTools(mutated("compare", (s) => (s.properties.passage_a.maxLength = 100))).ok, true);
  });
  it("JSON Schema alternatives: accepted when an alternative accepts every form sent, else refused", () => {
    const ev = (s) => s.properties.context;
    // $ref into $defs, and oneOf with disjoint alternatives.
    const viaRef = mutated("noul", (s) => { s.$defs = { ev: ev(s) }; s.properties.context = { $ref: "#/$defs/ev" }; });
    assert.equal(checkTools(viaRef).ok, true);
    const viaDefinitions = mutated("noul", (s) => { s.definitions = { ev: ev(s) }; s.properties.context = { $ref: "#/definitions/ev", description: "x" }; });
    assert.equal(checkTools(viaDefinitions).ok, true);
    assert.equal(checkTools(mutated("noul", (s) => (s.properties.context = { oneOf: ev(s).anyOf }))).ok, true);
    // the helper sends an evidence array: an anyOf without the array form refuses it.
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => (s.properties.context = { anyOf: ev(s).anyOf.slice(0, 2) }))), "noul"), ["type:context=string|object"]);
    // an alternative that accepts the type but not the size explains the refusal.
    assert.deepEqual(reasons(checkTools(mutated("gate", (s) => (s.properties.evidence.anyOf[2].items.properties.text.maxLength = 100))), "gate"), ["limit:evidence[].text.maxLength=100<50000"]);
    // oneOf where two alternatives accept the same value is refused by oneOf itself.
    assert.deepEqual(reasons(checkTools(mutated("screen", (s) => (s.properties.text = { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] }))), "screen"), ["ambiguous_oneOf:text"]);
    // allOf: every part must accept.
    assert.deepEqual(reasons(checkTools(mutated("find", (s) => (s.properties.top_k = { allOf: [{ type: "integer", minimum: 1 }, { type: "integer", maximum: 2 }] }))), "find"), ["range:top_k"]);
    assert.equal(checkTools(mutated("find", (s) => (s.properties.top_k = { allOf: [{ type: "integer", minimum: 1 }, { maximum: 50 }] }))).ok, false, "a part without a type is undecidable");
    // a nullable type list is fine.
    assert.equal(checkTools(mutated("review", (s) => (s.properties.tests = { type: ["string", "null"] }))).ok, true);
  });
  it("a field whose type cannot be determined is unverifiable, hence incompatible", () => {
    const cases = [
      ["noul", (s) => (s.properties.propositions = {}), "unverifiable:propositions"],
      ["noul", (s) => (s.properties.propositions.items = {}), "unverifiable:propositions[]"],
      ["noul", (s) => (s.properties.context = { $ref: "#/$defs/missing" }), "unverifiable:context"],
      ["noul", (s) => (s.properties.context = { $ref: "https://example.com/evidence.json" }), "unverifiable:context"],
      ["noul", (s) => { s.$defs = { ev: s.properties.context }; s.properties.context = { $ref: "#ev" }; }, "unverifiable:context"],
      ["decide", (s) => (s.properties.decision = { type: "string", enum: ["a"] }), "unverifiable:decision"],
      ["compare", (s) => (s.properties.passage_a = { type: "string", format: "uri" }), "unverifiable:passage_a"],
      ["noul", (s) => (s.properties.propositions.uniqueItems = true), "unverifiable:propositions"],
      ["verify", (s) => (s.properties.claims = { not: { type: "number" } }), "unverifiable:claims"],
    ];
    for (const [tool, edit, reason] of cases) assert.deepEqual(reasons(checkTools(mutated(tool, edit)), tool), [reason], reason);
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => (s.type = "array"))), "noul"), ["type:(input)=array"]);
    assert.deepEqual(reasons(checkTools(mutated("noul", (s) => (s.anyOf = [{ required: ["propositions"] }]))), "noul"), ["unverifiable:(input)"]);
  });
  it("activation through the fake server sees the published schema (patch, no schema)", async () => {
    const dir = tempDir("jev-control-contracts-");
    const file = join(dir, "patch.json");
    const noul = structuredClone(schemaOf(base, "noul"));
    noul.properties.propositions = { type: "number" };
    writeFileSync(file, JSON.stringify({ noul, compare: { ...schemaOf(base, "compare"), properties: { passage_a: { type: "string" }, passage_b: { type: "string" } } } }));
    const r = checkTools(await rpc({ FAKE_CONTROL_SCHEMA_PATCH: file }, "tools/list"));
    assert.equal(r.ok, false);
    assert.deepEqual(r.incompatible, [{ tool: "noul", reason: "type:propositions=number" }, { tool: "compare", reason: "missing_auto_accept" }]);
    const none = checkTools(await rpc({ FAKE_CONTROL_NO_SCHEMA: "1" }, "tools/list"));
    assert.equal(none.ok, false);
    assert.equal(none.incompatible.length, CORE_TOOLS.length);
  });
});

describe("argument validation (nothing invalid is sent)", () => {
  it("noul", () => {
    assert.deepEqual(validateArgs("noul", { propositions: ["a statement"], auto_accept: 0.9 }), []);
    assert.deepEqual(validateArgs("noul", { propositions: ["a"], context: [{ id: "e", text: "t" }], auto_accept: 0.9 }), []);
    assert.deepEqual(validateArgs("noul", { propositions: ["a"], context: "a document" }), []);
    assert.deepEqual(validateArgs("noul", { propositions: ["a"], context: { text: "one item" } }), []);
    assert.ok(validateArgs("noul", { propositions: [] }).length);
    assert.ok(validateArgs("noul", { propositions: ["x".repeat(2001)] }).length);
    assert.ok(validateArgs("noul", { propositions: Array(65).fill("a") }).length);
    assert.ok(validateArgs("noul", { propositions: ["a"], auto_accept: 0.5 }).includes("auto_accept_domain"), "auto_accept must exceed 0.5");
    assert.ok(validateArgs("noul", { propositions: ["a"], extra: 1 }).includes("unknown_key:extra"));
    for (const context of [7, [], [{ text: 1 }], [{ id: "e", text: "t", extra: 1 }], { id: "e" }]) assert.ok(validateArgs("noul", { propositions: ["a"], context }).includes("context_shape"), JSON.stringify(context));
  });
  it("decide", () => {
    const ok = { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "a", description: "x" }, { id: "b", description: "y" }] };
    assert.deepEqual(validateArgs("decide", ok), []);
    assert.deepEqual(validateArgs("decide", { ...ok, requirements: ["fast"], escape_hatches: true }), []);
    assert.ok(validateArgs("decide", { ...ok, candidates: [ok.candidates[0]] }).includes("candidates_count"));
    assert.ok(validateArgs("decide", { ...ok, candidates: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, description: "x" })) }).includes("candidates_count"));
    assert.match(validateArgs("decide", { ...ok, candidates: [{ id: "ask_user", description: "x" }, ok.candidates[1]] }).join(), /collides_with_escape_hatch/);
    assert.match(validateArgs("decide", { ...ok, candidates: [{ id: "Bad", description: "x" }, ok.candidates[1]] }).join(), /candidate_id_invalid/);
    assert.ok(validateArgs("decide", { ...ok, priorities: "" }).includes("priorities_length"));
    assert.ok(validateArgs("decide", { ...ok, requirements: ["a", "b", "c", "d"] }).includes("requirements_count"));
    assert.ok(validateArgs("decide", { ...ok, requirements: ["x".repeat(501)] }).includes("requirement_length"));
    assert.ok(validateArgs("decide", { ...ok, requirements: [""] }).includes("requirement_length"));
    assert.ok(validateArgs("decide", { ...ok, escape_hatches: "no" }).includes("escape_hatches_type"));
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

describe("result parsing: nothing missing, malformed or mis-associated is a score", () => {
  const sent = ["Option a is right.", "Option b is right."];
  const noulOk = () => ({ tool: "jev_noul", status: "ok", results: sent.map((p, i) => ({ id: `proposition${i}`, proposition: p, probability: [0.9, 0.1][i], label: "likely", auto: true })), thresholds: { auto_accept: 0.95 } });
  it("noul: probabilities in the order sent, bound to the sent propositions", () => {
    assert.deepEqual(parseNoulResult(noulOk(), 2), { ok: true, probabilities: [0.9, 0.1] });
    assert.deepEqual(parseNoulResult(noulOk(), 2, sent), { ok: true, probabilities: [0.9, 0.1] });
    const bad = (edit) => {
      const r = noulOk();
      edit(r);
      return r;
    };
    const cases = [
      [null, "invalid_response"],
      [bad((r) => (r.status = "invalid_response")), "invalid_response"],
      [bad((r) => (r.tool = "jev_verify")), "invalid_response"],
      [bad((r) => r.results.pop()), "result_count"],
      [bad((r) => r.results.push({ ...r.results[0], id: "proposition2" })), "result_count"],
      [bad((r) => (r.results[0].probability = 1.5)), "probability_domain"],
      [bad((r) => (r.results[0].probability = "0.9")), "probability_domain"],
      [bad((r) => (r.results[0].probability = null)), "probability_domain"],
      [bad((r) => (r.results[1].id = "proposition0")), "row_ids"],
      [bad((r) => delete r.results[1].id), "row_ids"],
      [bad((r) => (r.results[1] = 0.1)), "row_malformed"],
      [bad((r) => r.results.reverse()), "proposition_association"],
      [bad((r) => (r.results[1].proposition = "Option c is right.")), "proposition_association"],
      [bad((r) => delete r.results[0].proposition), "proposition_association"],
    ];
    for (const [result, reason] of cases) assert.deepEqual(parseNoulResult(result, 2, sent), { ok: false, reason }, reason);
    assert.deepEqual(parseNoulResult(noulOk(), 2, ["only one"]), { ok: false, reason: "sent_count_mismatch" });
    // Without the sent propositions the echo is not checked (labels are never read either way).
    assert.equal(parseNoulResult(bad((r) => { delete r.results[0].proposition; r.results[0].label = "unlikely"; }), 2).ok, true);
  });
  const ids = ["a", "b"];
  const decideOk = (rec = {}, extra = {}) => ({
    tool: "jev_decide",
    recommendation: { selected: "a", escaped: false, confidence: 0.97, probabilities: { a: 0.9, b: 0.04, ask_user: 0.02, investigate: 0.02, none: 0.02 }, ...rec },
    requirements_checked: 0,
    checks: [],
    warnings: [],
    ...extra,
  });
  it("decide: a consistent recommendation", () => {
    const r = parseDecideResult(decideOk(), ids);
    assert.deepEqual(r, { ok: true, selected: "a", escaped: false, confidence: 0.97, probabilities: decideOk().recommendation.probabilities, warnings: [] });
    // confidence is the provider's own number, not the selected probability (upstream tests differ them).
    assert.equal(parseDecideResult(decideOk({ confidence: 0.99 }), ids).ok, true);
    assert.equal(parseDecideResult(decideOk({ selected: "ask_user", escaped: true, confidence: 0.6, probabilities: { a: 0.2, b: 0.1, ask_user: 0.6, investigate: 0.05, none: 0.05 } }), ids).ok, true);
    // The control never turns the hatches off: a distribution over the candidates alone is not the server's answer.
    assert.deepEqual(parseDecideResult(decideOk({ probabilities: { a: 0.96, b: 0.04 } }), ids), { ok: false, reason: "probabilities_coverage" });
    assert.equal(parseDecideResult(decideOk({ probabilities: undefined }), ids).probabilities, null);
    assert.deepEqual(parseDecideResult(decideOk({}, { warnings: ["Requirement 1 contradicted by the recommended candidate; inspect before acting"] }), ids).warnings.length, 1);
  });
  it("decide: inconsistent answers are invalid", () => {
    const cases = [
      [{ tool: "jev_decide", recommendation: { selected: null, escaped: null, confidence: null, probabilities: null, status: "invalid_response" }, warnings: [] }, "invalid_response"],
      [decideOk({ status: "invalid_response" }), "invalid_response"],
      [decideOk({ confidence: null }), "recommendation_malformed"],
      [decideOk({ confidence: 1.2 }), "recommendation_malformed"],
      [decideOk({ escaped: "no" }), "recommendation_malformed"],
      [decideOk({ selected: "z" }), "selected_unknown_id"],
      [decideOk({ selected: "weird", escaped: true }), "selected_unknown_id"],
      [decideOk({ escaped: true }), "escaped_mismatch"],
      [decideOk({ selected: "ask_user", escaped: false, probabilities: { a: 0.2, b: 0.1, ask_user: 0.6, investigate: 0.05, none: 0.05 } }), "escaped_mismatch"],
      [decideOk({ probabilities: [0.9, 0.1] }), "probabilities_malformed"],
      [decideOk({ probabilities: { a: 0.9, ask_user: 0.1 } }), "probabilities_coverage"],
      [decideOk({ probabilities: { a: 0.9, b: 0.02, ask_user: 0.02, investigate: 0.02, none: 0.02, c: 0.02 } }), "probabilities_unknown_key"],
      [decideOk({ probabilities: { a: 0.9, b: -0.1, ask_user: 0.1, investigate: 0.05, none: 0.05 } }), "probabilities_domain"],
      [decideOk({ probabilities: { a: 0.9, b: "0.1", ask_user: 0.05, investigate: 0.02, none: 0.03 } }), "probabilities_domain"],
      [decideOk({ probabilities: { a: 0.5, b: 0.04, ask_user: 0.02, investigate: 0.02, none: 0.02 } }), "probabilities_sum"],
      [decideOk({ probabilities: { a: 0.9, b: 0.1, ask_user: 0.1, investigate: 0.1, none: 0.1 } }), "probabilities_sum"],
      [decideOk({ probabilities: { a: 0.1, b: 0.9, ask_user: 0, investigate: 0, none: 0 } }), "selected_not_argmax"],
      [decideOk({}, { warnings: "none" }), "warnings_malformed"],
      [decideOk({}, { warnings: [1] }), "warnings_malformed"],
      [decideOk({}, { warnings: undefined }), "warnings_malformed"],
    ];
    for (const [result, reason] of cases) assert.deepEqual(parseDecideResult(result, ids), { ok: false, reason }, reason);
  });
  it("rerank and find", () => {
    const rr = { tool: "jev_rerank", ranked: [{ rank: 1, id: "b", relevance: 0.9 }, { rank: 2, id: "a", relevance: 0.4 }] };
    assert.deepEqual(parseRankResult("rerank", rr, ["a", "b"], 5).ranked.map((r) => r.id), ["b", "a"]);
    assert.deepEqual(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 0.4 }, { id: "b", relevance: 0.9 }] }, ["a", "b"], 5).ranked.map((r) => r.id), ["b", "a"]);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 0.4 }, { id: "a", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "x", relevance: 0.4 }, { id: "b", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 1.5 }, { id: "b", relevance: 0.9 }] }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ id: "a", relevance: 0.4 }] }, ["a", "b"], 5).ok, false, "partial");
    assert.equal(parseRankResult("rerank", { ...rr, ranked: [{ rank: 2, id: "b", relevance: 0.9 }, { rank: 1, id: "a", relevance: 0.4 }] }, ["a", "b"], 5).reason, "rank_inconsistent");
    assert.equal(parseRankResult("rerank", { tool: "jev_rerank", status: "invalid_response", ranked: null }, ["a", "b"], 5).reason, "invalid_response");
    const find = { tool: "jev_find", exists: 0.9, top: [{ id: "a", probability: 0.9 }, { id: "b", probability: 0.1 }] };
    assert.equal(parseRankResult("find", find, ["a", "b"], 5).exists, 0.9);
    assert.equal(parseRankResult("find", { ...find, exists: "0.9" }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("find", { ...find, exists: undefined }, ["a", "b"], 5).ok, false);
    assert.equal(parseRankResult("find", { ...find, exists: 1.1 }, ["a", "b"], 5).reason, "exists_domain");
    assert.equal(parseRankResult("find", { ...find, top: [{ id: "a", probability: 0.9 }, { id: "a", probability: 0.1 }] }, ["a", "b"], 5).reason, "unknown_or_repeated_id");
    assert.equal(parseRankResult("find", { ...find, top: [{ id: "a", probability: 0.9 }, { id: "b" }] }, ["a", "b"], 5).reason, "score_domain");
    assert.equal(parseRankResult("find", { tool: "jev_find", status: "invalid_response", exists: null, top: [] }, ["a", "b"], 5).reason, "invalid_response");
  });
  it("the fake server's replies satisfy the parsers (noul echo, decide distribution)", async () => {
    const props = ["Option a is right.", "Option b is right."];
    const noul = payloadOf(await rpc({}, "tools/call", { name: "jev_noul", arguments: { propositions: props, auto_accept: 0.95 } }));
    assert.deepEqual(parseNoulResult(noul, 2, props), { ok: true, probabilities: [0.99, 0.97] });
    const args = { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "a", description: "x" }, { id: "b", description: "y" }] };
    const decide = payloadOf(await rpc({}, "tools/call", { name: "jev_decide", arguments: args }));
    assert.equal(parseDecideResult(decide, ["a", "b"]).ok, true);
    assert.deepEqual(Object.keys(decide.recommendation.probabilities), ["a", "b", ...DECIDE_HATCHES]);
    assert.ok(Math.abs(Object.values(decide.recommendation.probabilities).reduce((x, y) => x + y, 0) - 1) < 0.01);
    const off = payloadOf(await rpc({}, "tools/call", { name: "jev_decide", arguments: { ...args, escape_hatches: false } }));
    assert.deepEqual(Object.keys(off.recommendation.probabilities), ["a", "b"]);
  });
});

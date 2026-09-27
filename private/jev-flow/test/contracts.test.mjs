// Payload examples in the distributed docs must fit the real tool contracts.
// Top-level keys are parsed from each tool's strictShape in src/index.ts and
// numeric limits from src/lib.ts, so upstream drift in either fails here.
// Nested shapes, types and the per-field bounds below mirror src/index.ts by
// hand (the zod schemas cannot be imported without starting the server); this
// is a structural check of the examples, not a full zod validation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCandidates } from "../candidates.mjs";
import { prepareGateBatch } from "../gate-batch.mjs";
import { parseCheckArgv, validateRunInput } from "../gate-run.mjs";
import { parseDenylist } from "../paths.mjs";
import { makeRepo, REPO_ROOT } from "./helpers.mjs";

const source = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
const lib = readFileSync(join(REPO_ROOT, "src", "lib.ts"), "utf8");

function limit(name) {
  const match = lib.match(new RegExp(`export const ${name} = ([0-9_]+);`));
  assert.ok(match, `${name} not found in src/lib.ts`);
  return Number(match[1].replace(/_/g, ""));
}

const L = {
  candidates: limit("MAX_CANDIDATES"),
  classes: limit("MAX_CLASSES"),
  items: limit("MAX_ITEMS"),
  decide: limit("MAX_CANDIDATES_DECIDE"),
  requirements: limit("MAX_REQUIREMENTS"),
  propositions: limit("MAX_PROPOSITIONS"),
  propositionChars: limit("MAX_PROPOSITION_CHARS"),
  aspects: limit("MAX_COMPARE_ASPECTS"),
  fields: limit("MAX_EXTRACT_FIELDS"),
  gateClaims: limit("MAX_GATE_CLAIMS"),
};

/** Top-level input keys per tool, parsed from each registerTool's strictShape. */
function schemaKeys() {
  const keys = {};
  const toolRe = /server\.registerTool\(\s*"(jev_\w+)"/g;
  let match;
  while ((match = toolRe.exec(source))) {
    const start = source.indexOf("inputSchema: strictShape({", match.index);
    const body = source.slice(start, source.indexOf("\n    }),", start));
    keys[match[1]] = [...body.matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]);
  }
  return keys;
}

const REQUIRED = {
  jev_verify: ["claims", "evidence"],
  jev_screen: ["text"],
  jev_noul: ["propositions"],
  jev_find: ["query", "candidates"],
  jev_classify: ["items", "classes"],
  jev_decide: ["decision", "evidence", "priorities", "candidates"],
  jev_rerank: ["query", "candidates"],
  jev_compare: ["passage_a", "passage_b"],
  jev_extract: ["document", "fields"],
  jev_review: ["request", "diff"],
  jev_gate: ["request", "diff", "claims", "evidence"],
};

const ID_KEY = /^[a-z][a-z0-9_-]*$/;
const isString = (v) => typeof v === "string";
const strictObject = (value, allowed, required, where) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${where} must be an object`);
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${where} does not accept "${key}"`);
  for (const key of required) assert.ok(key in value, `${where} lacks "${key}"`);
};
const stringArray = (value, min, max, where, maxChars = Infinity) => {
  assert.ok(Array.isArray(value) && value.length >= min && value.length <= max, `${where}: ${min}..${max} items`);
  for (const v of value) assert.ok(isString(v) && v.length >= 1 && v.length <= maxChars, `${where}: non-empty strings ≤ ${maxChars}`);
};
const evidence = (value, where) => {
  if (isString(value)) return;
  const items = Array.isArray(value) ? value : [value];
  if (Array.isArray(value)) assert.ok(value.length >= 1, `${where}: at least one item`);
  for (const item of items) {
    strictObject(item, ["id", "text"], ["text"], `${where} item`);
    assert.ok(isString(item.text), `${where} text must be a string`);
    if ("id" in item) assert.ok(isString(item.id), `${where} id must be a string`);
  }
};
const candidates = (value, max, where) => {
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= max, `${where}: 1..${max} candidates`);
  for (const c of value) {
    strictObject(c, ["id", "text"], ["text"], `${where} candidate`);
    assert.ok(isString(c.text));
  }
};

/** Nested shapes and bounds per tool (mirrors src/index.ts). */
const NESTED = {
  jev_verify: (p) => {
    stringArray(p.claims, 1, Infinity, "claims");
    evidence(p.evidence, "evidence");
  },
  jev_screen: (p) => {
    assert.ok(isString(p.text) && p.text.length >= 1);
    if ("purpose" in p) assert.ok(isString(p.purpose));
  },
  jev_noul: (p) => {
    stringArray(p.propositions, 1, L.propositions, "propositions", L.propositionChars);
    if ("context" in p) evidence(p.context, "context");
  },
  jev_find: (p) => {
    assert.ok(isString(p.query) && p.query.length >= 1);
    candidates(p.candidates, L.candidates, "find");
    assert.ok(Number.isInteger(p.top_k) && p.top_k >= 1 && p.top_k <= 50, "jev_find top_k 1..50 (set explicitly by this flow)");
  },
  jev_rerank: (p) => {
    assert.ok(isString(p.query) && p.query.length >= 1 && p.query.length <= 2000);
    candidates(p.candidates, L.candidates, "rerank");
    assert.ok(Number.isInteger(p.top_k) && p.top_k >= 1 && p.top_k <= 250, "jev_rerank top_k 1..250 (set explicitly by this flow)");
  },
  jev_classify: (p) => {
    assert.ok(Array.isArray(p.items) && p.items.length >= 1 && p.items.length <= L.items);
    for (const item of p.items) strictObject(item, ["id", "text"], ["text"], "classify item");
    assert.ok(Array.isArray(p.classes) && p.classes.length >= 2 && p.classes.length <= L.classes);
    for (const c of p.classes) strictObject(c, ["id", "description"], ["description"], "classify class");
    if ("purpose" in p) assert.ok(isString(p.purpose));
  },
  jev_decide: (p) => {
    assert.ok(isString(p.decision) && p.decision.length >= 1 && p.decision.length <= 1500);
    assert.ok(isString(p.evidence) && p.evidence.length >= 1 && p.evidence.length <= 12000, "decide evidence is a string");
    assert.ok(isString(p.priorities) && p.priorities.length >= 1 && p.priorities.length <= 2000);
    assert.ok(Array.isArray(p.candidates) && p.candidates.length >= 2 && p.candidates.length <= L.decide);
    for (const c of p.candidates) {
      strictObject(c, ["id", "description"], ["id", "description"], "decide candidate");
      assert.match(c.id, ID_KEY);
      assert.ok(c.id.length <= 64 && c.description.length >= 1 && c.description.length <= 2000);
    }
    if ("requirements" in p) stringArray(p.requirements, 0, L.requirements, "requirements", 500);
    if ("escape_hatches" in p) assert.equal(typeof p.escape_hatches, "boolean");
  },
  jev_compare: (p) => {
    assert.ok(isString(p.passage_a) && p.passage_a.length >= 1 && p.passage_a.length <= 20000);
    assert.ok(isString(p.passage_b) && p.passage_b.length >= 1 && p.passage_b.length <= 20000);
    if ("aspects" in p) stringArray(p.aspects, 0, L.aspects, "aspects", 200);
  },
  jev_extract: (p) => {
    assert.ok(isString(p.document) && p.document.length >= 1 && p.document.length <= 50000);
    assert.ok(Array.isArray(p.fields) && p.fields.length >= 1 && p.fields.length <= L.fields);
    for (const f of p.fields) {
      strictObject(f, ["id", "pattern", "flags", "description"], ["id", "pattern", "description"], "extract field");
      assert.match(f.id, ID_KEY);
      assert.ok(f.pattern.length >= 1 && f.pattern.length <= 500);
      assert.doesNotThrow(() => new RegExp(f.pattern), "pattern must be a valid JavaScript regex source");
      assert.ok(f.description.length >= 1 && f.description.length <= 2000);
    }
  },
  jev_review: (p) => {
    assert.ok(isString(p.request) && p.request.length >= 1);
    assert.ok(isString(p.diff) && p.diff.length >= 1);
    if ("tests" in p) assert.ok(isString(p.tests));
  },
  jev_gate: (p) => {
    assert.ok(isString(p.request) && p.request.length >= 1);
    assert.ok(isString(p.diff) && p.diff.length >= 1);
    stringArray(p.claims, 1, L.gateClaims, "gate claims");
    evidence(p.evidence, "gate evidence");
    const items = isString(p.evidence) ? [{ text: p.evidence }] : Array.isArray(p.evidence) ? p.evidence : [p.evidence];
    assert.ok(items.some((e) => e.text.trim().length > 0), "gate needs non-empty evidence");
    if ("tests" in p) assert.ok(isString(p.tests));
  },
};

function checkPayload(tool, payload, keys) {
  assert.ok(keys[tool], `unknown tool ${tool}`);
  for (const key of Object.keys(payload)) assert.ok(keys[tool].includes(key), `${tool} does not accept "${key}"`);
  for (const key of REQUIRED[tool]) assert.ok(key in payload, `${tool} example lacks required "${key}"`);
  NESTED[tool](payload);
}

/** JSON blocks followed by "Tool: `jev_x`" and inline "`jev_x` `{...}`" examples. */
function examples(markdown) {
  const found = [];
  for (const m of markdown.matchAll(/```json\n([\s\S]*?)```\n+(?:Tool: `(jev_\w+)`)?/g)) {
    if (m[2]) found.push({ tool: m[2], json: m[1] });
  }
  for (const m of markdown.matchAll(/`(jev_\w+)` `(\{.*?\})`(?= \|)/g)) found.push({ tool: m[1], json: m[2] });
  return found;
}

describe("documented payloads fit the tool contracts", () => {
  const keys = schemaKeys();

  it("parses all eleven tool schemas from src/index.ts", () => {
    assert.deepEqual(Object.keys(keys).sort(), Object.keys(REQUIRED).sort());
    assert.deepEqual(keys.jev_find, ["query", "candidates", "top_k"]);
  });

  it("the structural checker rejects malformed payloads", () => {
    const bad = [
      ["jev_find", { query: "q", candidates: [{ id: "c0", text: "t", file_path: "x" }], top_k: 5 }],
      ["jev_find", { query: "q", candidates: [], top_k: 5 }],
      ["jev_find", { query: "q", candidates: [{ id: "c0", text: "t" }], top_k: 51 }],
      ["jev_decide", { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "A", description: "x" }, { id: "b", description: "y" }] }],
      ["jev_decide", { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "a", description: "x" }] }],
      ["jev_gate", { request: "r", diff: "d", claims: [], evidence: "e" }],
      ["jev_gate", { request: "r", diff: "d", claims: ["c"], evidence: [{ id: "x", text: "   " }] }],
      ["jev_extract", { document: "d", fields: [{ id: "v", pattern: "(", description: "x" }] }],
      ["jev_verify", { claims: ["c"], evidence: [{ id: "x" }] }],
    ];
    for (const [tool, payload] of bad) assert.throws(() => checkPayload(tool, payload, keys), `${tool} ${JSON.stringify(payload)}`);
  });

  it("reference/workflow.md examples are valid", () => {
    const md = readFileSync(join(REPO_ROOT, "skills", "jev-flow", "reference", "workflow.md"), "utf8");
    const list = examples(md);
    const tools = new Set(list.map((e) => e.tool));
    for (const tool of ["jev_classify", "jev_find", "jev_verify", "jev_noul", "jev_decide", "jev_review", "jev_gate", "jev_screen", "jev_compare", "jev_extract"]) {
      assert.ok(tools.has(tool), `missing example for ${tool}`);
    }
    for (const { tool, json } of list) checkPayload(tool, JSON.parse(json), keys);
  });

  it("/jev-done pairs every claim with its own evidence instead of one generic patch item (F3)", () => {
    const md = readFileSync(join(REPO_ROOT, "commands", "jev-done.md"), "utf8");
    // The T2-B' regression: one {"id": "patch"} item shared by every claim.
    assert.doesNotMatch(md, /"id": "patch"/);
    const input = JSON.parse(md.match(/```json\n([\s\S]*?)```/)[1]);
    assert.ok(input.claims.length >= 1);
    for (const claim of input.claims) assert.ok(Array.isArray(claim.evidence) && claim.evidence.length > 0, "each claim names its evidence");
    assert.ok(input.claims.some((c) => c.evidence.some((id) => /^cmd-\d+$/.test(id))), "check claims cite a --check output");
  });

  it("/jev-done runs the gate runner and never copies payloads through the model (R1)", () => {
    const md = readFileSync(join(REPO_ROOT, "commands", "jev-done.md"), "utf8");
    assert.match(md, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/jev-gate-run\.mjs" --root \. --list-hunks/);
    assert.match(md, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/jev-gate-run\.mjs" --root \. --claims \S+ --check/);
    assert.match(md, /Never build or copy a `jev_gate` payload yourself/);
    assert.doesNotMatch(md, /jev-gate-payload\.mjs/);
    assert.doesNotMatch(md, /calls\[i\]\.input/);
    // The documented claims file is accepted by the runner's input validation.
    const input = JSON.parse(md.match(/```json\n([\s\S]*?)```/)[1]);
    assert.deepEqual(validateRunInput(input), []);
    // Every documented --check is a JSON argv the runner accepts (no shell strings).
    const checks = [...md.matchAll(/--check '([^']+)'/g)].map((m) => m[1]);
    assert.ok(checks.length >= 1);
    for (const c of checks) assert.ok(Array.isArray(parseCheckArgv(c)), c);
    for (const x of input.excerpts) assert.ok(!("text" in x) && Array.isArray(x.lines), "excerpts are cited by path and lines");
  });

  it("gate calls prepared by the helper fit the jev_gate contract, with per-claim evidence", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "",
    ].join("\n");
    const out = prepareGateBatch(
      {
        request: "set a to 2",
        diff,
        claims: [
          { text: "src/a.ts exports a = 2", evidence: ["hunk-1"] },
          { text: "npm test passed", evidence: ["cmd-1"] },
        ],
        commands: [{ command: "npm test", exit: 0, output: "# pass 3\n# fail 0" }],
      },
      { denylist: parseDenylist(""), snapshot: "a".repeat(64) },
    );
    assert.equal(out.ok, true, JSON.stringify(out.problems));
    for (const call of out.calls) {
      checkPayload("jev_gate", call.input, keys);
      const ids = call.input.evidence.map((e) => e.id);
      assert.ok(ids.includes("hunk-1") && ids.includes("cmd-1"));
      assert.match(call.input.evidence.find((e) => e.id === "cmd-1").text, /\$ npm test\nexit: 0\n# pass 3/);
    }
  });

  it("no distributed file sends invented keys such as file_path to Jev", () => {
    for (const rel of ["skills/jev-flow/SKILL.md", "skills/jev-flow/reference/workflow.md", "agents/jev-locator.md", "commands/jev-locate.md", "commands/jev-done.md"]) {
      assert.doesNotMatch(readFileSync(join(REPO_ROOT, rel), "utf8"), /"file_path"/, rel);
    }
  });

  it("the locator gets the ranking from the helper and cannot compose Jev calls (F4, R3, R7)", () => {
    const agent = readFileSync(join(REPO_ROOT, "agents", "jev-locator.md"), "utf8");
    assert.match(agent, /The helper applies the ranking rule itself/);
    assert.match(agent, /^tools: Read, Grep, Glob, Bash$/m, "no Jev tool in the frontmatter");
    assert.doesNotMatch(agent, /mcp__/);
    assert.match(agent, /\*\*Forbidden:\*\* composing, copying or editing arguments for `jev_rerank` or `jev_find`/);
    assert.match(agent, /reading or opening any file where the CLI persisted the helper's output/);
    assert.match(agent, /not semantically ranked/);
    assert.doesNotMatch(agent, /jev_payload|jev_result/);
    assert.match(agent, /--fallback/);
    assert.match(agent, /"jev_used"/);
  });

  it("the parent keeps working while the locator runs, and --full stays out of agent and skill texts (R7)", () => {
    for (const rel of ["skills/jev-flow/SKILL.md", "skills/jev-flow/reference/workflow.md", "commands/jev-locate.md"]) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      assert.match(text, /background/, rel);
      assert.match(text, /independent work/, rel);
    }
    for (const rel of ["skills/jev-flow/SKILL.md", "skills/jev-flow/reference/workflow.md", "commands/jev-locate.md", "agents/jev-locator.md"]) {
      assert.doesNotMatch(readFileSync(join(REPO_ROOT, rel), "utf8"), /--full\b/, rel);
    }
  });

  it("the locator runs on a cheaper model than the parent by default (F2)", () => {
    const agent = readFileSync(join(REPO_ROOT, "agents", "jev-locator.md"), "utf8");
    assert.match(agent, /^model: haiku$/m);
    assert.doesNotMatch(agent, /^model: inherit$/m);
  });

  it("the helper's jev_payload fits the jev_rerank and jev_find contracts", () => {
    const files = {};
    for (let i = 0; i < 6; i++) files[`src/m${i}.ts`] = `export function parseWidgetFlag${i}(value) {\n  return value.trim();\n}\n`;
    const repo = makeRepo(files);
    for (const single of [false, true]) {
      const out = buildCandidates({ root: repo, query: "parse widget flag", single });
      assert.equal(out.recommend.tool, single ? "jev_find" : "jev_rerank");
      assert.deepEqual(Object.keys(out.jev_payload), ["query", "candidates", "top_k"]);
      checkPayload(single ? "jev_find" : "jev_rerank", out.jev_payload, keys);
    }
  });
});

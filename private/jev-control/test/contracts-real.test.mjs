// The contracts against the REAL jev-mcp server: dist/index.js is started on
// stdio with no credentials and asked tools/list only (no tools/call, so no
// provider request and no network). Its published schemas are the ground
// truth: they must pass checkTools, carry the limits the control mirrors, and
// equal the fake server's schemas (descriptions aside), which the other tests
// use. Distinct from contracts.test.mjs, whose cases mutate the fake's copy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { CORE_TOOLS, LIMITS, TOOL_KEYS, checkTools } from "../contracts.mjs";
import { FAKE_CONTROL_SERVER, REPO_ROOT, tempDir } from "./helpers.mjs";

const DIST = join(REPO_ROOT, "dist", "index.js");
const skip = existsSync(DIST) ? false : "dist/index.js is not built (npm run build)";

function toolsList(script) {
  return new Promise((resolve, reject) => {
    // Only PATH and an empty HOME: no API key or provider setting can reach the server.
    const child = spawn(process.execPath, [script], { cwd: REPO_ROOT, env: { PATH: process.env.PATH, HOME: tempDir("jev-control-real-") }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => (child.kill(), reject(new Error("tools/list timed out"))), 15_000);
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
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contracts-real", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

/** The schema without annotations (description, $schema), for structural comparison. */
function bare(schema) {
  if (Array.isArray(schema)) return schema.map(bare);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "description" && k !== "$schema").map(([k, v]) => [k, bare(v)]));
}

function srcKeys() {
  const source = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
  const keys = {};
  for (const match of source.matchAll(/tools\.registerTool\(\s*"(jev_\w+)"/g)) {
    const start = source.indexOf("inputSchema: strictShape({", match.index);
    const body = source.slice(start, source.indexOf("\n    }),", start));
    keys[match[1]] = [...body.matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]).sort();
  }
  return keys;
}

describe("the real published schemas (dist/index.js tools/list)", { skip }, () => {
  let real;
  const props = (short) => real.tools.find((t) => t.name === `jev_${short}`).inputSchema.properties;
  before(async () => {
    real = await toolsList(DIST);
  });

  it("dist is the current source: the same tools with the same input keys as src/index.ts", () => {
    const fromSrc = srcKeys();
    const fromDist = Object.fromEntries(real.tools.map((t) => [t.name, Object.keys(t.inputSchema.properties).sort()]));
    assert.deepEqual(fromDist, fromSrc);
  });

  it("pass checkTools: every core tool, nothing incompatible (jev_audit is not part of jev-mcp)", () => {
    const r = checkTools(real);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.incompatible, []);
    assert.equal(r.ok, true);
    assert.equal(r.audit, false);
    for (const tool of CORE_TOOLS) assert.ok(real.tools.some((t) => t.name === `jev_${tool}`), tool);
  });

  it("every published tool rejects unknown top-level keys, so the control's strict key lists matter", () => {
    for (const tool of CORE_TOOLS) {
      const schema = real.tools.find((t) => t.name === `jev_${tool}`).inputSchema;
      assert.equal(schema.additionalProperties, false, tool);
      for (const key of TOOL_KEYS[tool].used) assert.ok(key in schema.properties, `${tool}.${key}`);
      for (const key of schema.required) assert.ok(TOOL_KEYS[tool].required.includes(key), `${tool} requires ${key}`);
    }
  });

  it("the limits table matches the published bounds", () => {
    assert.equal(props("noul").propositions.maxItems, LIMITS.noulPropositions);
    assert.equal(props("noul").propositions.items.maxLength, LIMITS.noulPropositionChars);
    assert.equal(props("noul").auto_accept.exclusiveMinimum, 0.5);
    assert.equal(props("noul").auto_accept.maximum, 1);
    assert.equal(props("decide").candidates.minItems, 2);
    assert.equal(props("decide").candidates.maxItems, LIMITS.decideCandidates);
    assert.equal(props("decide").candidates.items.properties.id.maxLength, 64);
    assert.equal(props("decide").candidates.items.properties.id.pattern, "^[a-z][a-z0-9_-]*$");
    assert.equal(props("decide").candidates.items.properties.description.maxLength, LIMITS.decideCandidateChars);
    assert.equal(props("decide").decision.maxLength, LIMITS.decideDecisionChars);
    assert.equal(props("decide").evidence.maxLength, LIMITS.decideEvidenceChars);
    assert.equal(props("decide").priorities.maxLength, LIMITS.decidePrioritiesChars);
    assert.equal(props("decide").requirements.maxItems, LIMITS.decideRequirements);
    assert.equal(props("decide").requirements.items.maxLength, LIMITS.decideRequirementChars);
    assert.equal(props("rerank").query.maxLength, LIMITS.rerankQueryChars);
    assert.equal(props("rerank").candidates.maxItems, LIMITS.rerankCandidates);
    assert.equal(props("rerank").top_k.maximum, LIMITS.rerankTopK);
    assert.equal(props("find").candidates.maxItems, LIMITS.rerankCandidates);
    assert.equal(props("find").top_k.maximum, LIMITS.findTopK);
    assert.equal(props("gate").claims.maxItems, LIMITS.gateClaims);
    for (const tool of ["gate", "review", "verify", "classify", "compare", "extract"]) {
      assert.deepEqual([props(tool).auto_accept.minimum, props(tool).auto_accept.maximum], [0, 1], tool);
    }
    // The evidence/context alternatives are the real anyOf: document | item | non-empty item array.
    for (const [tool, key] of [["noul", "context"], ["verify", "evidence"], ["gate", "evidence"]]) {
      assert.deepEqual(props(tool)[key].anyOf.map((a) => a.type), ["string", "object", "array"], `${tool}.${key}`);
    }
  });

  it("the fake server publishes the same schemas (descriptions aside)", async () => {
    const fake = await toolsList(FAKE_CONTROL_SERVER);
    for (const tool of real.tools) {
      const twin = fake.tools.find((t) => t.name === tool.name);
      assert.ok(twin, `${tool.name} missing from the fake`);
      assert.deepEqual(bare(twin.inputSchema), bare(tool.inputSchema), tool.name);
    }
  });
});

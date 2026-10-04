import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { preflight } from "../ab/preflight.mjs";
import { REPO_ROOT, run } from "./helpers.mjs";

const MANIFEST = join(REPO_ROOT, "private", "jev-flow", "ab", "tasks.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

describe("A/B manifest", () => {
  it("freezes six tasks on verified base SHAs with hidden acceptance criteria", () => {
    const expected = {
      M1: "9d4c768924abac45d76720efb5d3d0daa889bda4",
      M2: "69ffb4b49c88802ec6e49b883f4a36b91d23197e",
      A1: "56b6e6f08fa4d87a1041e596e0a222f15f1fe438",
      A2: "56b6e6f08fa4d87a1041e596e0a222f15f1fe438",
      H1: "6056be4431dfdbe6e74e4d387a56090bfdcdd321",
      H2: "6056be4431dfdbe6e74e4d387a56090bfdcdd321",
    };
    assert.deepEqual(Object.fromEntries(manifest.tasks.map((t) => [t.id, t.base_sha])), expected);
    for (const task of manifest.tasks) {
      assert.ok(task.prompt.length > 20);
      assert.ok(Array.isArray(task.acceptance_hidden_from_agent) && task.acceptance_hidden_from_agent.length > 0);
      for (const criterion of task.acceptance_hidden_from_agent) assert.ok(!task.prompt.includes(criterion));
      assert.equal(task.oracle.status, "not_ready");
    }
    assert.equal(manifest.seed, null);
    assert.equal(manifest.repetitions, 3);
    assert.equal(manifest.adoption.min_reduction, 0.3);
  });

  it("the runner guard refuses to start while oracles and seed are missing", () => {
    const result = run(process.execPath, [join(REPO_ROOT, "private", "jev-flow", "ab", "preflight.mjs")]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /NOT READY/);
    assert.match(result.stdout, /seed is not recorded/);
    assert.match(result.stdout, /M1: oracle not_ready/);
  });

  it("the guard passes only a complete manifest", () => {
    const ready = structuredClone(manifest);
    ready.seed = 12345;
    for (const task of ready.tasks) task.oracle = { status: "ready", command: "npm test", tests: ["t"] };
    assert.deepEqual(preflight(ready), { ready: true, reasons: [] });
    ready.tasks[0].base_sha = "8ff16ff";
    assert.equal(preflight(ready).ready, false);
  });

  it("the guard rejects a reduced, altered or duplicated corpus", () => {
    const ready = structuredClone(manifest);
    ready.seed = 1;
    for (const task of ready.tasks) task.oracle = { status: "ready", command: "npm test", tests: ["t"] };
    const variants = {
      reduced: (m) => m.tasks.pop(),
      duplicated: (m) => (m.tasks[5] = { ...m.tasks[4] }),
      renamed: (m) => (m.tasks[0].id = "X1"),
      extra: (m) => m.tasks.push({ ...m.tasks[0], id: "Z9" }),
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const copy = structuredClone(ready);
      mutate(copy);
      const result = preflight(copy);
      assert.equal(result.ready, false, name);
    }
    const dup = structuredClone(ready);
    dup.tasks[5] = { ...dup.tasks[4] };
    assert.ok(preflight(dup).reasons.includes("task ids are not distinct"));
    assert.ok(preflight(dup).reasons.includes("missing agreed tasks: H2"));
  });
});

describe("plugin manifests (F5)", () => {
  const plugin = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const upstream = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  it("plugin.json carries an independent semver version", () => {
    assert.match(plugin.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.notEqual(plugin.version, upstream.version, "the private plugin version is independent of the upstream package");
  });

  it("the marketplace entry for jev declares the same version", () => {
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    assert.ok(entry, "marketplace entry for the plugin");
    assert.equal(entry.version, plugin.version);
  });

  it("the opt-in activation (round 5) is still wired in the plugin version 0.7.2 (jev-control)", () => {
    assert.equal(plugin.version, "0.7.2");
    const hooks = JSON.parse(readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
    assert.match(hooks.PostToolUse[0].matcher, /(^|\|)Agent\|Task(\||$)/);
    assert.equal(hooks.SubagentStop[0].matcher, "jev-locator|jev:jev-locator");
    assert.match(hooks.SubagentStop[0].hooks[0].command, /jev-flow-hook\.mjs" SubagentStop$/);
  });
});

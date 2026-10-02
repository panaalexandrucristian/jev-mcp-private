import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionHash, evaluatePreconditions, normalizeDescriptor, normalizePath, normalizePreconditions, observedDescriptor, parsePlanItem, planItem, shortHash } from "../actions.mjs";
import { makeRepo, writeFiles } from "./helpers.mjs";

describe("action descriptors", () => {
  it("normalize the tool, the command's whitespace and repository paths", () => {
    assert.deepEqual(normalizeDescriptor({ tool: "Bash", target: "  npm   test\n" }).descriptor, { tool: "Bash", target: "npm test" });
    assert.deepEqual(normalizeDescriptor({ tool: "Task", target: "worker" }).descriptor, { tool: "Agent", target: "worker" });
    assert.deepEqual(normalizeDescriptor({ tool: "Edit", target: "/repo/src/a.js" }, "/repo").descriptor, { tool: "Edit", target: "src/a.js" });
    assert.deepEqual(normalizeDescriptor({ tool: "Read", target: "./src/../src/a.js" }, "/repo").descriptor, { tool: "Read", target: "src/a.js" });
    assert.deepEqual(normalizeDescriptor({ tool: "AskUserQuestion", target: "ignored" }).descriptor, { tool: "AskUserQuestion", target: "" });
    for (const bad of [null, "x", { tool: "Teleport", target: "x" }, { tool: "Bash" }, { tool: "Bash", target: "   " }, { tool: "Bash", target: "x".repeat(2001) }]) assert.equal(normalizeDescriptor(bad).ok, false, JSON.stringify(bad));
  });
  it("an observed tool call has the same descriptor as the option that names it, and only that one", () => {
    const planned = normalizeDescriptor({ tool: "Edit", target: "src/a.js" }, "/repo").descriptor;
    const seen = observedDescriptor("Edit", { file_path: "/repo/src/a.js" }, "/repo");
    assert.equal(actionHash(seen), actionHash(planned));
    assert.notEqual(actionHash(observedDescriptor("Write", { file_path: "/repo/src/a.js" }, "/repo")), actionHash(planned), "Write is not Edit");
    assert.notEqual(actionHash(observedDescriptor("Edit", { file_path: "/repo/src/b.js" }, "/repo")), actionHash(planned));
    assert.deepEqual(observedDescriptor("Bash", { command: "npm   test" }), { tool: "Bash", target: "npm test" });
    assert.deepEqual(observedDescriptor("Grep", { pattern: "foo", path: "src" }), { tool: "Grep", target: "foo" });
    assert.equal(observedDescriptor("TodoWrite", {}), null);
  });
  it("paths outside the root stay absolute and never collide with a relative one", () => {
    assert.equal(normalizePath("/elsewhere/a.js", "/repo"), "/elsewhere/a.js");
    assert.equal(normalizePath("/repo", "/repo"), ".");
  });
});

describe("compact plan items", () => {
  it("round-trip id, step, raw score and action hash", () => {
    const d = { tool: "Bash", target: "npm test" };
    const text = planItem({ id: "run_unit", action: "execute", score: 0.95001, descriptor: d });
    assert.equal(text, `run_unit:e:0.95001:${shortHash(actionHash(d))}`);
    assert.deepEqual(parsePlanItem(text), { id: "run_unit", action: "execute", score: 0.95001, ah: shortHash(actionHash(d)) });
    assert.deepEqual(parsePlanItem(planItem({ id: "a-b", action: "reserve", score: 1e-7 })), { id: "a-b", action: "reserve", score: 1e-7, ah: null });
    for (const bad of ["", "a:e:0.9", "a:z:0.9:-", "a:e:x:-", "a:e:0.9:short", ":e:0.9:-", "a:e:0.9:-:x"]) assert.equal(parsePlanItem(bad), null, bad);
  });
});

describe("preconditions", () => {
  it("are validated and evaluated against the work tree, never outside it", () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const sha = "0".repeat(64);
    assert.equal(normalizePreconditions([{ kind: "path_sha256", path: "a.js", sha256: sha }]).ok, true);
    for (const bad of [{}, "x", [{ kind: "nope", path: "a" }], [{ kind: "path_exists" }], [{ kind: "path_sha256", path: "a" }], Array(6).fill({ kind: "path_exists", path: "a" })]) assert.equal(normalizePreconditions(bad).ok, false, JSON.stringify(bad));
    assert.equal(evaluatePreconditions([{ kind: "path_exists", path: "a.js" }, { kind: "path_absent", path: "dist/x.js" }], repo).ok, true);
    assert.deepEqual(evaluatePreconditions([{ kind: "path_exists", path: "nope.js" }], repo).failed[0].reason, "missing");
    assert.deepEqual(evaluatePreconditions([{ kind: "path_absent", path: "a.js" }], repo).failed[0].reason, "present");
    assert.deepEqual(evaluatePreconditions([{ kind: "path_exists", path: "../outside" }], repo).failed[0].reason, "outside_repository");
    assert.deepEqual(evaluatePreconditions([{ kind: "path_exists", path: "/etc/passwd" }], repo).failed[0].reason, "outside_repository");
    assert.equal(evaluatePreconditions([{ kind: "path_sha256", path: "a.js", sha256: sha }], repo).failed[0].reason, "content_changed");
    writeFiles(repo, { "a.js": "changed\n" });
    assert.equal(evaluatePreconditions([{ kind: "path_exists", path: "a.js" }], repo).ok, true);
  });
});

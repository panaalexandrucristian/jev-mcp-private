import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionHash, actionMaterial, actionRecord, dependencyPaths, describeAction, evaluatePreconditions, fingerprintPaths, normalizeDescriptor, normalizePath, normalizePreconditions, observedDescriptor, parsePlanItem, planItem, shortHash } from "../actions.mjs";
import { makeRepo, writeFiles } from "./helpers.mjs";

describe("action descriptors", () => {
  const D = (raw, root = "/repo") => normalizeDescriptor(raw, root).descriptor;
  it("normalize the tool and repository paths; a command is kept exactly, only its ends are trimmed", () => {
    assert.deepEqual(pick(D({ tool: "Bash", target: "  npm   test\n" })), { tool: "Bash", target: "npm   test", args: {} });
    assert.deepEqual(pick(D({ tool: "Task", target: "worker", prompt: "p" })).tool, "Agent");
    assert.equal(D({ tool: "Edit", target: "/repo/src/a.js", old_string: "a", new_string: "b" }).target, "src/a.js");
    assert.equal(D({ tool: "Read", target: "./src/../src/a.js" }).target, "src/a.js");
    assert.deepEqual(pick(D({ tool: "AskUserQuestion", target: "ignored" })), { tool: "AskUserQuestion", target: "", args: {} });
    for (const bad of [null, "x", { tool: "Teleport", target: "x" }, { tool: "Bash" }, { tool: "Bash", target: "   " }, { tool: "Bash", target: "x".repeat(2001) }]) assert.equal(normalizeDescriptor(bad).ok, false, JSON.stringify(bad));
  });
  it("an observed tool call has the same descriptor as the option that names it, and only that one", () => {
    const planned = D({ tool: "Edit", target: "src/a.js", old_string: "a", new_string: "b" });
    const seen = observedDescriptor("Edit", { file_path: "/repo/src/a.js", old_string: "a", new_string: "b" }, "/repo");
    assert.equal(actionHash(seen), actionHash(planned));
    assert.notEqual(actionHash(observedDescriptor("Write", { file_path: "/repo/src/a.js", content: "b" }, "/repo")), actionHash(planned), "Write is not Edit");
    assert.notEqual(actionHash(observedDescriptor("Edit", { file_path: "/repo/src/b.js", old_string: "a", new_string: "b" }, "/repo")), actionHash(planned));
    assert.deepEqual(pick(observedDescriptor("Bash", { command: "npm test", description: "run" })), { tool: "Bash", target: "npm test", args: {} }, "a description does not change the call");
    assert.deepEqual(pick(observedDescriptor("Grep", { pattern: "foo", path: "/repo/src" }, "/repo")), { tool: "Grep", target: "foo", args: { path: "src" } });
    assert.equal(observedDescriptor("TodoWrite", {}), null);
  });
  it("two calls with the same tool and path but different arguments are different actions", () => {
    const h = (name, input) => actionHash(observedDescriptor(name, input, "/repo"));
    const w = (content) => h("Write", { file_path: "/repo/a.js", content });
    assert.notEqual(w("one"), w("two"), "Write content");
    const e = (new_string, extra = {}) => h("Edit", { file_path: "/repo/a.js", old_string: "a", new_string, ...extra });
    assert.notEqual(e("b"), e("c"), "Edit replacement");
    assert.notEqual(e("b"), e("b", { replace_all: true }), "replace_all");
    assert.equal(e("b"), e("b", { replace_all: false }), "false is the default and means nothing");
    const r = (extra) => h("Read", { file_path: "/repo/a.js", ...extra });
    assert.notEqual(r({}), r({ offset: 1, limit: 10 }), "Read range");
    assert.notEqual(r({ offset: 1, limit: 10 }), r({ offset: 11, limit: 10 }));
    const a = (extra) => h("Agent", { subagent_type: "worker", prompt: "x", ...extra });
    assert.notEqual(a({}), a({ prompt: "y" }), "Agent prompt");
    assert.notEqual(a({}), a({ model: "opus" }), "Agent model");
    const g = (extra) => h("Grep", { pattern: "foo", ...extra });
    assert.notEqual(g({ path: "src" }), g({ path: "test" }), "Grep scope");
    assert.notEqual(g({}), g({ glob: "*.mjs" }), "Grep glob");
    const m = (b) => h("MultiEdit", { file_path: "/repo/a.js", edits: [{ old_string: "a", new_string: b }] });
    assert.notEqual(m("1"), m("2"), "MultiEdit");
    assert.notEqual(h("Bash", { command: 'printf "a b"' }), h("Bash", { command: 'printf "a  b"' }), "whitespace inside quotes changes the command");
    assert.equal(h("Bash", { command: "  npm test \n" }), h("Bash", { command: "npm test" }), "only the ends are trimmed");
  });
  it("paths outside the root stay absolute and never collide with a relative one", () => {
    assert.equal(normalizePath("/elsewhere/a.js", "/repo"), "/elsewhere/a.js");
    assert.equal(normalizePath("/repo", "/repo"), ".");
  });
  it("label the call compactly for logs (size and hash prefix only) and give Jev the whole concrete material apart", () => {
    const big = `${"x".repeat(500)}TAIL`;
    const d = D({ tool: "Write", target: "a.js", content: big });
    const label = describeAction(d);
    assert.match(label, /^Write a\.js with content \(504 chars, s256:[0-9a-f]{8}\)$/);
    assert.equal(label.includes("xxx"), false, "the label carries no payload text");
    const material = actionMaterial(d);
    assert.match(material, /^Tool: Write\nTarget: a\.js\nArgument content \(504 characters, s256:[0-9a-f]{8}\) between the markers:\n<<<content\nx{500}TAIL\ncontent>>>$/);
    assert.match(describeAction(D({ tool: "Read", target: "a.js", offset: 5, limit: 7 })), /offset=5; limit=7/);
    assert.match(actionMaterial(D({ tool: "Read", target: "a.js", offset: 5, limit: 7 })), /Argument offset: 5\nArgument limit: 7$/);
    const long = `${"c".repeat(2000 - 20)} && rm -rf build`;
    assert.equal(actionMaterial(D({ tool: "Bash", target: long })).endsWith("rm -rf build"), true, "a long command is whole");
    const edits = actionMaterial(D({ tool: "MultiEdit", target: "a.js", edits: [{ old_string: "a", new_string: "b" }] }));
    assert.match(edits, /<<<edits\n\[\{"old_string":"a","new_string":"b","replace_all":false\}\]\nedits>>>$/);
  });
  it("an observed call keeps only the size of a payload, never its text", () => {
    const d = observedDescriptor("Write", { file_path: "/repo/a.js", content: "SECRET=1" }, "/repo");
    assert.deepEqual(d.view.content, { chars: 8 });
    assert.equal(JSON.stringify(d).includes("SECRET"), false);
  });
  it("keep only hashes of the payloads in the record a receipt stores", () => {
    const rec = actionRecord(D({ tool: "Write", target: "a.js", content: "SECRET=1" }));
    assert.equal(JSON.stringify(rec).includes("SECRET"), false);
    assert.match(rec.args.content, /^s256:/);
  });
});

const pick = (d) => ({ tool: d.tool, target: d.target, args: d.args });

describe("evidence a step depends on", () => {
  it("are the action's path, its scope and every precondition path, fingerprinted by content", () => {
    const repo = makeRepo({ "a.js": "a\n", "b.js": "b\n" });
    const option = { action: normalizeDescriptor({ tool: "Edit", target: "a.js", old_string: "a", new_string: "c" }, repo).descriptor, preconditions: [{ kind: "path_exists", path: "b.js" }, { kind: "path_absent", path: "gone.js" }] };
    assert.deepEqual(dependencyPaths(option), ["a.js", "b.js", "gone.js"]);
    assert.deepEqual(dependencyPaths({ action: normalizeDescriptor({ tool: "Bash", target: "npm test" }).descriptor, preconditions: [] }), []);
    const before = fingerprintPaths(repo, dependencyPaths(option));
    assert.match(before["a.js"], /^[0-9a-f]{64}$/);
    assert.equal(before["gone.js"], "absent");
    writeFiles(repo, { "a.js": "changed\n" });
    const after = fingerprintPaths(repo, dependencyPaths(option));
    assert.notEqual(after["a.js"], before["a.js"]);
    assert.equal(after["b.js"], before["b.js"]);
    assert.equal(fingerprintPaths(repo, ["../outside"])["../outside"], "outside");
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

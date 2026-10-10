import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONFINED_PERMISSION, confineScript, confinementProven, judgeConfine, permissionFingerprint, prepareSentinels, writeProof } from "../eval/opencode/confine.mjs";
import { ledgerStart, ledgerVoid, summarizeMessages, summarizeProbe } from "../eval/opencode/real.mjs";
import { PLAN, toMarkdown } from "../eval/opencode/campaign.mjs";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ltd-ocf-"));
  dirs.push(dir);
  return dir;
};
let sentinels;
after(() => {
  sentinels?.cleanupTmp();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const rejected = JSON.stringify({ error: { type: "permission.rejected", message: "Permission denied: external_directory" }, content: [] });
const unavailable = JSON.stringify({ error: { type: "tool.execution", message: 'No tool named "shell" is currently available.' }, content: [] });
const logFor = (script, results) => JSON.stringify({ n: 1, body: { tools: [{ function: { name: "read" } }], messages: [{ role: "user", content: "x" }, ...results.map((content) => ({ role: "tool", content }))] } });

function setup() {
  const root = temp();
  sentinels = prepareSentinels(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "hello.txt"), "hello inside\n");
  writeFileSync(join(workspace, "control.txt"), "ok");
  const script = confineScript(workspace, sentinels);
  const good = script.map((step) => (step.expect === "allowed" ? (step.label.startsWith("read") ? "1: hello inside" : step.label.startsWith("skill") ? "<skill_content name=\"x\">" : "Created file") : step.expect === "rejected" ? rejected : unavailable));
  return { root, workspace, script, good };
}

describe("judgeConfine", () => {
  it("passes when every outside attempt is refused, the controls work and the sentinels are untouched", () => {
    const { workspace, script, good } = setup();
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.table.length, script.length);
  });
  it("fails when a refused step was allowed, and names it", () => {
    const { workspace, script, good } = setup();
    const results = [...good];
    results[1] = "OCSENTINEL leaked? no: plain allowed text";
    const verdict = judgeConfine({ logText: logFor(script, results), script, sentinels, workspace });
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reasons.some((r) => r.startsWith("read sentinel in run root")));
  });
  it("fails when the token comes back in a result", () => {
    const { workspace, script, good } = setup();
    const results = [...good];
    results[2] = `${rejected} ${sentinels.token}`;
    const verdict = judgeConfine({ logText: logFor(script, results), script, sentinels, workspace });
    assert.ok(verdict.reasons.includes("the sentinel token came back in a tool result"));
  });
  it("fails when a sentinel changed or a new file appeared next to it", () => {
    const { workspace, script, good } = setup();
    writeFileSync(sentinels.files[0], "changed");
    writeFileSync(join(sentinels.dirs[1], "new.txt"), "x");
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.ok(verdict.reasons.some((r) => /sentinel 0 changed/.test(r)));
    assert.ok(verdict.reasons.some((r) => /new files in/.test(r)));
    writeFileSync(sentinels.files[0], readFileSync(sentinels.files[1], "utf8"));
  });
  it("fails when results are missing or a control did not work", () => {
    const { workspace, script, good } = setup();
    assert.equal(judgeConfine({ logText: logFor(script, good.slice(0, 5)), script, sentinels, workspace }).pass, false);
    rmSync(join(workspace, "control.txt"));
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.ok(verdict.reasons.includes("the control file was not written inside the workspace"));
  });
});

describe("proof file", () => {
  it("is valid only for the same permission set and version", () => {
    const root = temp();
    assert.equal(confinementProven(root, "2.0.22"), false);
    writeProof(root, "2.0.22", "/p");
    assert.equal(confinementProven(root, "2.0.22"), true);
    assert.equal(confinementProven(root, "2.0.23"), false);
    assert.notEqual(permissionFingerprint("a"), permissionFingerprint("b"));
    assert.equal(CONFINED_PERMISSION.external_directory, "deny");
    assert.equal(CONFINED_PERMISSION.shell, "deny");
  });
});

const message = (type, data) => ({ type, data });
describe("summarizeMessages and summarizeProbe", () => {
  const messages = [
    message("user", { text: '"Implement canAccess"', files: [] }),
    message("assistant", { content: [{ type: "tool", name: "skill", state: { status: "completed", input: { id: "logic-test-debug" } } }, { type: "tool", name: "read", state: { status: "error", input: { path: "/x" }, error: { type: "permission.rejected" } } }], finish: "tool-calls", tokens: { input: 10, output: 2, reasoning: 0 }, cost: 0 }),
    message("assistant", { content: [{ type: "text", text: "Scope: the access rule.\nMethod: pairs, INFERENCE.\nResult: edited, nothing run." }], finish: "stop", tokens: { input: 20, output: 5, reasoning: 1 }, cost: 0 }),
  ];
  it("reads the skill load, the refused attempts, the record and the totals", () => {
    const s = summarizeMessages(messages);
    assert.equal(s.assistantMessages, 2);
    assert.equal(s.skillLoaded, true);
    assert.deepEqual(s.rejected, [{ name: "read" }]);
    assert.equal(s.record.present, true);
    assert.equal(s.finished, "stop");
    assert.deepEqual(s.tokens, { input: 30, output: 7, reasoning: 1 });
  });
  it("does not count a failed skill call or a different skill as a load", () => {
    const failed = [message("assistant", { content: [{ type: "tool", name: "skill", state: { status: "error", input: { id: "logic-test-debug" } } }, { type: "tool", name: "skill", state: { status: "completed", input: { id: "jev" } } }], finish: "stop" })];
    const s = summarizeMessages(failed);
    assert.equal(s.skillLoaded, false);
    assert.equal(s.skillAttempts, 2);
    assert.equal(s.record.present, false);
  });
  it("counts the main agent's requests with the directive and ignores the locator subagent", () => {
    const log = [{ at: "context", agent: "build", directive: true }, { at: "context", agent: "jev-locator", directive: false }, { at: "context", agent: "build", directive: false }].map((r) => JSON.stringify(r)).join("\n");
    assert.deepEqual(summarizeProbe(log), { modelRequests: 2, withDirective: 1, firstHasDirective: true });
  });
});

describe("report", () => {
  it("lists the sessions and the gates with counts only", () => {
    const verdict = (id, arm, directive) => ({ id, arm, model: "m", version: "2.0.22", complete: true, seconds: 10, probe: { modelRequests: 3, withDirective: directive ? 1 : 0, firstHasDirective: directive }, session: { skillLoaded: directive, record: { present: false }, toolCalls: ["read", "read", "write"], rejected: [] }, oracle: { passed: 100, total: 136, success: false, outOfScope: [] } });
    const md = toMarkdown([verdict("s1", "ON", true), verdict("s2", "OFF", false)]);
    assert.match(md, /no effect is claimed/);
    assert.match(md, /every ON session had the directive in its first model request: true/);
    assert.match(md, /no OFF session had it: true/);
    assert.match(md, /read×2 write×1/);
    assert.deepEqual(PLAN.map((p) => p.arm), ["ON", "OFF", "OFF", "ON"]);
  });
});

describe("ledger", () => {
  const start = (root, id, kind = "planned") => ledgerStart(root, { id, kind, scenario: "conditions", arm: "ON", run: 1 });
  it("refuses a fifth planned session and a seventh in all", () => {
    const root = temp();
    for (const id of ["s1", "s2", "s3", "s4"]) start(root, id);
    assert.throws(() => start(root, "s5"), /planned sessions already started/);
    start(root, "r1", "reserve");
    start(root, "r2", "reserve");
    assert.throws(() => start(root, "r3", "reserve"), /cap reached: 6 of 6/);
  });
  it("does not count a voided attempt, and lets the same id start again", async () => {
    const root = temp();
    start(root, "s1");
    await new Promise((r) => setTimeout(r, 5));
    ledgerVoid(root, "s1", "no model request");
    await new Promise((r) => setTimeout(r, 5));
    for (const id of ["s1", "s2", "s3", "s4"]) start(root, id);
    assert.throws(() => start(root, "s5"), /planned sessions already started/);
    const lines = readFileSync(join(root, "ledger.tsv"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.filter((l) => l.includes("\tvoid\t")).length, 1, "the void line stays in the ledger");
  });
});

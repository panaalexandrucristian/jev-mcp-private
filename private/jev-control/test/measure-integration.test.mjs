import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { audit } from "../measure.mjs";
import { batchOf, cli, controlEnv, makeRepo, tempDir } from "./helpers.mjs";

// The audit reads what the REAL helper prints: these tests run the real CLI against the fake
// server and feed its actual output lines into a transcript, so the formats cannot drift apart.
const SID = ["--session-id", "measure-it-1"];
const CLI_PATH = "/plugin/private/jev-control/cli.mjs";
let n = 0;
const id = () => `toolu_it_${++n}`;
const asst = (cwd, ...blocks) => ({ type: "assistant", cwd, message: { id: `msg_it_${++n}`, role: "assistant", content: blocks } });
const res = (cwd, block, text) => ({ type: "user", cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text }] }] } });
const prompt = (cwd, text) => ({ type: "user", cwd, message: { role: "user", content: text } });
const use = (name, input) => ({ type: "tool_use", id: id(), name, input });
/** assistant tool_use then its result, as two records */
const step = (cwd, block, text) => [asst(cwd, block), res(cwd, block, text)];
const lastLine = (r) => r.stdout.trim().split("\n").pop();
const writeBatch = (obj) => {
  const file = join(tempDir(), "batch.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
};
const p7 = (real) => [...real, 0.1, 0.1];

describe("the audit understands the real helper's output", () => {
  it("an executed edit is covered by the decide plan that named exactly that action, once; another file is not", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.5, 0.4, 0.3, 0.2]) }] } });
    cli(["on", ...SID, "--priorities", "smallest change"], { env, cwd: repo });
    const batch = batchOf(5, { kind: "edit" });
    const file = writeBatch(batch);
    const d = cli(["decide", ...SID, "--file", file], { env, cwd: repo });
    assert.equal(d.json.status, "selected", d.stdout);
    const bash = use("Bash", { command: `node "${CLI_PATH}" decide --file ${file}` });
    const records = [
      prompt(repo, "fix it"),
      ...step(repo, bash, lastLine(d)),
      ...step(repo, use("Edit", { file_path: join(repo, "src/file-1.js") }), "ok"),
      ...step(repo, use("Edit", { file_path: join(repo, "src/file-2.js") }), "ok"),
      ...step(repo, use("Edit", { file_path: join(repo, "src/file-1.js") }), "ok"),
    ];
    const a = audit(records, { threshold: 0.95 });
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 2);
    assert.equal(a.coverage.uncovered_reasons.no_grant + a.coverage.uncovered_reasons.grant_already_used, 2);
    assert.equal(a.threshold.violations.length, 0);
  });
  it("a below-threshold plan item is a violation; .95001 is not", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.95001, 0.5, 0.4, 0.3, 0.2]) }] } });
    cli(["on", ...SID, "--priorities", "x"], { env, cwd: repo });
    const d = cli(["decide", ...SID, "--file", writeBatch(batchOf(5, { kind: "command" }))], { env, cwd: repo });
    assert.equal(d.json.status, "selected");
    const bash = use("Bash", { command: `node "${CLI_PATH}" decide --file /tmp/b.json` });
    const a = audit([prompt(repo, "go"), ...step(repo, bash, lastLine(d)), ...step(repo, use("Bash", { command: "npm run check-1" }), "ok")], { threshold: 0.95 });
    assert.equal(a.coverage.covered, 1, "0.95001 is strictly above 0.95");
    assert.equal(a.threshold.violations.length, 0);
    const forged = lastLine(d).replace(/:0\.95001:/, ":0.95:");
    const b = audit([prompt(repo, "go"), ...step(repo, bash, forged), ...step(repo, use("Bash", { command: "npm run check-1" }), "ok")], { threshold: 0.95 });
    assert.equal(b.threshold.violations.length, 1, "0.95 is not strictly above 0.95");
    assert.equal(b.coverage.covered, 0);
  });
  it("a cut plan is completed by the page command, and the audit applies the page, not the cut list alone", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.5, 0.4, 0.3, 0.2]) }] } });
    cli(["on", ...SID, "--priorities", "x"], { env, cwd: repo });
    const d = cli(["decide", ...SID, "--decision-id", "dpage", "--file", writeBatch(batchOf(5, { kind: "command" }))], { env, cwd: repo });
    const page = cli(["page", ...SID, "--decision", "dpage", "--part", "plan"], { env, cwd: repo });
    assert.equal(page.json.status, "ok");
    assert.deepEqual(page.json.plan, d.json.plan);
    const bash = use("Bash", { command: `node "${CLI_PATH}" page --decision dpage` });
    const a = audit([prompt(repo, "go"), ...step(repo, use("Bash", { command: `node "${CLI_PATH}" decide --file /tmp/b.json` }), lastLine(d)), ...step(repo, bash, lastLine(page))], { threshold: 0.95 });
    assert.equal(a.ordering.plans, 1);
  });
  it("search hits grant a Read of exactly the returned path", () => {
    const repo = makeRepo({ "src/a.mjs": "export const a = 1;\n", "src/b.mjs": "export const b = 1;\n" });
    const env = controlEnv({ script: { rerank: [{ scores: { c0: 0.98, c1: 0.3 } }] } });
    cli(["on", ...SID, "--priorities", "x"], { env, cwd: repo });
    const s = cli(["search", ...SID, "--query", "export const a"], { env, cwd: repo });
    assert.equal(s.json.status, "found", s.stdout);
    const hit = s.json.hits[0].path;
    const other = hit === "src/a.mjs" ? "src/b.mjs" : "src/a.mjs";
    const search = use("Bash", { command: `node "${CLI_PATH}" search --query "export const a"` });
    const a = audit([prompt(repo, "where is a"), ...step(repo, search, lastLine(s)), ...step(repo, use("Read", { file_path: join(repo, hit) }), "x"), ...step(repo, use("Read", { file_path: join(repo, other) }), "x")], { threshold: 0.95 });
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 1);
  });
});

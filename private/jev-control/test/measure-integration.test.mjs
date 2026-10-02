import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { audit } from "../measure.mjs";
import { actionFor, batchOf, cli, controlEnv, makeRepo, tempDir } from "./helpers.mjs";

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
/** The Edit tool call that is exactly option `i` (0-based) of an edit batch, arguments included. */
const editCall = (repo, i) => {
  const a = actionFor("edit", i);
  return use("Edit", { file_path: join(repo, a.target), old_string: a.old_string, new_string: a.new_string });
};

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
      ...step(repo, editCall(repo, 0), "ok"),
      ...step(repo, editCall(repo, 1), "ok"),
      ...step(repo, editCall(repo, 0), "ok"),
      ...step(repo, use("Edit", { file_path: join(repo, "src/file-1.js"), old_string: "old 1", new_string: "something else" }), "ok"),
    ];
    const a = audit(records, { threshold: 0.95 });
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 3);
    assert.equal(a.coverage.uncovered_reasons.no_grant + a.coverage.uncovered_reasons.grant_already_used, 3, "another file, a second use, and the same file with another replacement");
    assert.equal(a.coverage.unverified_binding, 1, "no receipt verification preceded the edit");
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
    assert.equal(a.coverage.search_whole_file_reads, 1);
    // The hit's own line range is what a ranged Read must stay inside.
    const { start_line: from, end_line: to } = s.json.hits[0];
    assert.ok(Number.isInteger(from) && Number.isInteger(to), s.stdout);
    const inside = audit([prompt(repo, "where is a"), ...step(repo, search, lastLine(s)), ...step(repo, use("Read", { file_path: join(repo, hit), offset: from, limit: to - from + 1 }), "x")]);
    assert.equal(inside.coverage.covered, 1);
    assert.equal(inside.coverage.search_whole_file_reads, 0);
    const outside = audit([prompt(repo, "where is a"), ...step(repo, search, lastLine(s)), ...step(repo, use("Read", { file_path: join(repo, hit), offset: from, limit: to - from + 2 }), "x")]);
    assert.deepEqual(outside.coverage.uncovered_reasons, { read_outside_hit: 1 });
  });
});

describe("the audit follows the real receipt, budget and search shapes", () => {
  const actionFile = (i) => writeBatch(actionFor("edit", i));
  const verifyCmd = (id, opt, file, extra = "") => use("Bash", { command: `node "${CLI_PATH}" receipt verify --id ${id} --option ${opt} --action-file ${file} ${extra}` });
  const prepare = (priorities = "x") => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.5, 0.4, 0.3, 0.2]) }, { p: p7([0.99, 0.5, 0.4, 0.3, 0.2]) }] } });
    cli(["on", ...SID, "--priorities", priorities], { env, cwd: repo });
    return { repo, env };
  };
  const decideCmd = use("Bash", { command: `node "${CLI_PATH}" decide --file /tmp/b.json` });
  it("a verified option is receipt_verified; a replay refusal revokes nothing", () => {
    const { repo, env } = prepare();
    const d = cli(["decide", ...SID, "--file", writeBatch(batchOf(5, { kind: "edit" }))], { env, cwd: repo });
    assert.equal(d.json.status, "selected", d.stdout);
    assert.equal(typeof d.json.receipt, "string");
    const file = actionFile(0);
    const v1 = cli(["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", "o1", "--action-file", file], { env, cwd: repo });
    assert.equal(v1.json.authorized, true, v1.stdout);
    const v2 = cli(["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", "o1", "--action-file", file], { env, cwd: repo });
    assert.equal(v2.json.status, "refused");
    assert.equal(v2.json.message, "receipt_replayed");
    const a = audit([
      prompt(repo, "fix it"),
      ...step(repo, decideCmd, lastLine(d)),
      ...step(repo, verifyCmd(d.json.receipt, "o1", file), lastLine(v1)),
      ...step(repo, verifyCmd(d.json.receipt, "o1", file), lastLine(v2)),
      ...step(repo, editCall(repo, 0), "ok"),
    ], { threshold: 0.95 });
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.receipt_verified, 1);
    assert.equal(a.coverage.unverified_binding, 0);
    assert.equal(a.receipts.receipt_verifications, 1);
    assert.deepEqual(a.receipts.refusals_by_reason, { receipt_replayed: 1 });
    assert.equal(a.coverage.grants.revoked, 0);
  });
  it("a stale-snapshot refusal revokes the decision's grants", () => {
    const { repo, env } = prepare();
    const d = cli(["decide", ...SID, "--file", writeBatch(batchOf(5, { kind: "edit" }))], { env, cwd: repo });
    assert.equal(d.json.status, "selected", d.stdout);
    // The work tree changes after the decision: its receipt is stale.
    writeFileSync(join(repo, "changed.txt"), "new\n");
    const file = actionFile(0);
    const v = cli(["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", "o1", "--action-file", file], { env, cwd: repo });
    assert.equal(v.json.status, "refused", v.stdout);
    assert.equal(v.json.message, "receipt_stale_snapshot");
    const a = audit([prompt(repo, "fix it"), ...step(repo, decideCmd, lastLine(d)), ...step(repo, verifyCmd(d.json.receipt, "o1", file), lastLine(v)), ...step(repo, editCall(repo, 0), "ok")], { threshold: 0.95 });
    assert.equal(a.coverage.covered, 0);
    assert.deepEqual(a.coverage.uncovered_reasons, { grant_revoked: 1 });
  });
  it("budget approve needs the user's own words in the request; a refusal or an invented message raises nothing", () => {
    const { repo, env } = prepare();
    const refusedNoMessage = cli(["budget", "approve", ...SID, "--n", "5"], { env, cwd: repo });
    assert.equal(refusedNoMessage.json.status, "refused", refusedNoMessage.stdout);
    const ok = cli(["budget", "approve", ...SID, "--n", "5", "--message", "yes spend five more calls"], { env, cwd: repo });
    assert.equal(ok.json.status, "ok", ok.stdout);
    assert.equal(ok.json.approval.n, 5);
    const bound = audit([prompt(repo, "fine, yes spend five more calls"), ...step(repo, use("Bash", { command: `node "${CLI_PATH}" budget approve --n 5 --message "yes spend five more calls"` }), lastLine(ok))]);
    assert.deepEqual(bound.budget, { approvals_bound: 1, approvals_unbound: 0 });
    assert.deepEqual(bound.jev_calls.per_request, [{ request: 1, helper_attempts: 0, direct: 0, approved_extra: 5, limit: 30 }]);
    const invented = audit([prompt(repo, "just do it"), ...step(repo, use("Bash", { command: `node "${CLI_PATH}" budget approve --n 5 --message "yes spend five more calls"` }), lastLine(ok))]);
    assert.deepEqual(invented.budget, { approvals_bound: 0, approvals_unbound: 1 });
    assert.deepEqual(invented.jev_calls.per_request, [{ request: 1, helper_attempts: 0, direct: 0, approved_extra: 0, limit: 25 }]);
  });
  it("a reservation's source flag is read from the real command and the real result", () => {
    const { repo, env } = prepare();
    const r = cli(["budget", "reserve", ...SID, "--tool", "noul", "--source", "subagent"], { env, cwd: repo });
    assert.equal(r.json.status, "ok", r.stdout);
    const reserve = use("Bash", { command: `node "${CLI_PATH}" budget reserve --tool noul --source subagent` });
    const noul = use("mcp__jev__jev_noul", { propositions: ["x"] });
    const a = audit([prompt(repo, "go"), ...step(repo, reserve, lastLine(r)), ...step(repo, noul, JSON.stringify({ tool: "jev_noul", status: "ok", results: [{ id: "proposition0", proposition: "x", probability: 0.4 }] }))]);
    assert.equal(a.jev_calls.reservation_source_mismatch.length, 1, "declared subagent from the main context");
    assert.equal(a.jev_calls.unreserved_direct.length, 1);
  });
});

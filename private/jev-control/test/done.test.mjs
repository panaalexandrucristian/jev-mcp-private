import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateGateResult } from "../../jev-flow/policy.mjs";
import { initRunnerSession, readSignedReceipt } from "../../jev-flow/runner-receipt.mjs";
import { sessionDir, sessionKey } from "../../jev-flow/state.mjs";
import { budgetView, reserve } from "../budget.mjs";
import { BudgetedCaller } from "../client.mjs";
import { CONTROL_ACCEPT_MINIMUMS, gatePolicy, runControlDone } from "../done.mjs";
import { loadControlState } from "../state.mjs";
import { controlEnv, gateAnswer, makeRepo, serverLog, stateDir, writeFiles } from "./helpers.mjs";

// The in-process budget cases exercise the limit itself; the product default is 10000.
process.env.JEV_CONTROL_BUDGET_LIMIT = "25";

const CLAIMS = ["a.js exports a = 2", "b.js is a new file exporting b = 3"];
const input = () => ({ request: "set a to 2 and add b", claims: [{ text: CLAIMS[0], evidence: ["file:a.js"] }, { text: CLAIMS[1], evidence: ["file:b.js"] }] });
const change = (repo) => writeFiles(repo, { "a.js": "export const a = 2;\n", "b.js": "export const b = 3;\n" });

async function runDone(T, script, { before, checks = [], budgetPre = 0, claims = input() } = {}) {
  const repo = makeRepo({ "a.js": "export const a = 1;\n" });
  const env = controlEnv({ script });
  const dir = stateDir();
  const id = "done-session";
  for (let i = 0; i < budgetPre; i++) reserve(dir, { tool: "noul", source: "main" });
  // The session baseline is taken at SessionStart, before the work (as the flow's hook does).
  initRunnerSession(sessionDir(repo, id, env), repo);
  change(repo);
  if (before) before(repo);
  const caller = new BudgetedCaller({ dir, env, source: "gate" });
  const r = await runControlDone({ root: repo, claims, checks }, { T, caller, dir, sessionKey: sessionKey(id), env });
  return { ...r, repo, env, dir, id };
}

describe("completion at the session threshold (D5, D24)", () => {
  it("sends every part with auto_accept = T and accepts decision confidences strictly above T", async () => {
    const r = await runDone(0.9, { gate: [{ result: gateAnswer(0.9, { conf: 0.95 }) }] });
    assert.equal(r.summary.outcome, "accepted", JSON.stringify(r.summary));
    assert.equal(r.code, 0);
    const calls = serverLog(r.env).filter((l) => l.name === "jev_gate");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.auto_accept, 0.9);
    assert.equal(r.summary.control.threshold, 0.9);
  });
  it("a confidence exactly equal to T is not accepted, whatever the tool's own label says", async () => {
    const r = await runDone(0.95, { gate: [{ result: gateAnswer(0.95, { conf: 0.95 }) }] });
    assert.notEqual(r.summary.outcome, "accepted");
    assert.equal(r.code, 2);
    const above = await runDone(0.95, { gate: [{ result: gateAnswer(0.95, { conf: 0.951 }) }] });
    assert.equal(above.summary.outcome, "accepted", JSON.stringify(above.summary));
  });
  it("each of safe_to_apply, a rubric confidence and a claim confidence must be above T", async () => {
    for (const weak of [{ conf: 0.96, safe: 0.95 }, { conf: 0.96, rubric: 0.95 }]) {
      const r = await runDone(0.95, { gate: [{ result: gateAnswer(0.95, weak) }] });
      assert.notEqual(r.summary.outcome, "accepted", JSON.stringify(weak));
    }
    const r = await runDone(0.95, { gate: [{ result: gateAnswer(0.95, { conf: 0.95, safe: 0.99, rubric: 0.99 }) }] });
    assert.notEqual(r.summary.outcome, "accepted", "the claim confidence alone is also checked");
  });
  it("no 0.8 floor is inherited: a threshold of 0.6 accepts a 0.7 confidence", async () => {
    const r = await runDone(0.6, { gate: [{ result: gateAnswer(0.6, { conf: 0.7 }) }] });
    assert.equal(r.summary.outcome, "accepted", JSON.stringify(r.summary));
    const g = gateAnswer(0.6, { conf: 0.7 });
    assert.equal(validateGateResult(g, { claims: CLAIMS }).accepted, false, "the flow's own policy still keeps its 0.8 floor");
    assert.equal(validateGateResult(g, { claims: CLAIMS, minimums: CONTROL_ACCEPT_MINIMUMS, strictAbove: 0.6 }).accepted, true);
  });
  it("a failing real check still blocks acceptance", async () => {
    const r = await runDone(0.9, { gate: [{ result: gateAnswer(0.9, { conf: 0.95 }) }] }, { checks: [JSON.stringify([process.execPath, "-e", "process.exit(3)"])] });
    assert.equal(r.summary.outcome, "checks_failed");
    assert.equal(r.code, 2);
  });
  it("a retry of a part counts in the shared budget as source gate", async () => {
    const r = await runDone(0.9, { gate: [{ fail: "transport" }, { result: gateAnswer(0.9, { conf: 0.95 }) }] });
    assert.equal(r.summary.outcome, "accepted", JSON.stringify(r.summary));
    const view = budgetView(loadControlState(r.dir));
    assert.equal(view.by_source.gate, 2);
    assert.equal(view.used, 2);
  });
  it("at the budget limit nothing is sent: the run stops as unavailable with the budget reason", async () => {
    const r = await runDone(0.9, { gate: [{ result: gateAnswer(0.9, { conf: 0.95 }) }] }, { budgetPre: 25 });
    assert.equal(r.summary.outcome, "unavailable");
    assert.match(JSON.stringify(r.summary), /budget exhausted/);
    assert.equal(serverLog(r.env).filter((l) => l.name === "jev_gate").length, 0);
  });
  it("writes the gate runner's signed receipt for a session that has a key, and logs the outcome", async () => {
    const r = await runDone(0.9, { gate: [{ result: gateAnswer(0.9, { conf: 0.95 }) }] });
    assert.match(r.summary.receipt, /^[0-9a-f]{32}$/);
    assert.ok(readSignedReceipt(sessionDir(r.repo, r.id, r.env), r.summary.receipt));
    const logged = loadControlState(r.dir).decisions.at(-1);
    assert.equal(logged.kind, "done");
    assert.equal(logged.t, 0.9);
    assert.equal(logged.status, "accepted");
  });
  it("a multipart batch sends every part at T through the shared budget, one attempt per part", async () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.js`, `export const v${i} = ${i};\n`]));
    const claims = { request: "add twenty modules", claims: Object.keys(files).map((f) => ({ text: `${f} exports a constant`, evidence: [`file:${f}`] })) };
    const make = (budgetPre) => runDone(0.9, { gate: [{ conf: 0.95 }] }, { claims, budgetPre, before: (repo) => writeFiles(repo, files) });
    const r = await make(0);
    assert.equal(r.summary.outcome, "accepted", JSON.stringify(r.summary).slice(0, 600));
    const sent = serverLog(r.env).filter((l) => l.name === "jev_gate");
    assert.ok(sent.length >= 2, "the 20 claims do not fit one jev_gate call");
    assert.ok(sent.every((l) => l.args.auto_accept === 0.9));
    assert.equal(r.summary.coverage.planned, sent.length);
    assert.equal(budgetView(loadControlState(r.dir)).by_source.gate, sent.length);
    // With one slot left only the first part is sent; the rest are unevaluated and the run is not accepted.
    const short = await make(24);
    assert.equal(serverLog(short.env).filter((l) => l.name === "jev_gate").length, 1);
    assert.equal(short.summary.outcome, "unavailable");
    assert.ok(short.summary.coverage.unavailable + short.summary.coverage.unevaluated >= 1);
    assert.equal(short.code, 3);
  });
  it("an invalid claims input is reported before anything is sent", async () => {
    const r = await runDone(0.9, null, { claims: { request: "x", claims: [] } });
    assert.equal(r.code, 4);
    assert.equal(serverLog(r.env).length, 0);
  });
  it("the flow's behavior is unchanged without a policy: its strict default still rejects 0.7 at 0.6", () => {
    const g = gateAnswer(0.6, { conf: 0.7 });
    assert.equal(validateGateResult(g, { claims: CLAIMS }).accepted, false);
    assert.equal(gatePolicy({ T: 0.9, caller: {} }).accept.strictAbove, 0.9);
  });
});

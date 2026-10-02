import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { approveMore, budgetView, confirm, release, reserve, startRequest } from "../budget.mjs";
import { BudgetedCaller } from "../client.mjs";
import { loadControlState, withControlState } from "../state.mjs";
import { controlEnv, serverLog, stateDir } from "./helpers.mjs";

const BUDGET = fileURLToPath(new URL("../budget.mjs", import.meta.url));
const argsNoul = { propositions: ["The first option is right.", "The second option is right."], auto_accept: 0.95 };

async function withServer(script, fn, extra = {}) {
  const env = controlEnv({ script, extra });
  const dir = stateDir();
  const caller = new BudgetedCaller({ dir, env, source: "helper" });
  const session = await caller.open();
  assert.equal(session.ok, true, JSON.stringify(session));
  try {
    return await fn({ caller, session, dir, env });
  } finally {
    await session.close();
  }
}

describe("the shared budget (D15, D26)", () => {
  it("counts reservations per source and releases never-sent ones apart", () => {
    const dir = stateDir();
    const a = reserve(dir, { tool: "noul", source: "helper" });
    const b = reserve(dir, { tool: "jev_decide", source: "tiebreak" });
    const c = reserve(dir, { tool: "gate", source: "gate" });
    const d = reserve(dir, { tool: "rerank", source: "subagent" });
    const e = reserve(dir, { tool: "find", source: "something-else" });
    assert.ok(a.ok && b.ok && c.ok && d.ok && e.ok);
    assert.equal(budgetView(loadControlState(dir)).used, 5);
    confirm(dir, a.id, { ok: true, ms: 12 });
    release(dir, c.id);
    const view = budgetView(loadControlState(dir));
    assert.equal(view.used, 4);
    assert.equal(view.sent, 1);
    assert.equal(view.released, 1);
    assert.equal(view.unconfirmed, 3);
    assert.deepEqual(view.by_source, { main: 0, subagent: 1, helper: 1, gate: 1, tiebreak: 1, unknown: 1 });
    assert.equal(view.provider_calls, "unknown");
    assert.equal(confirm(dir, "nope", {}).ok, false);
  });
  it("refuses the 26th attempt and reports it; approval raises the limit", () => {
    const dir = stateDir();
    for (let i = 0; i < 25; i++) assert.equal(reserve(dir, { tool: "noul", source: "main" }).ok, true, `call ${i + 1}`);
    const refused = reserve(dir, { tool: "noul", source: "main" });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "budget_exhausted");
    assert.equal(refused.view.used, 25);
    assert.deepEqual(approveMore(dir, 25), { ok: false, reason: "message_required" }, "the user's own words are required");
    assert.equal(approveMore(dir, 25, "  ").ok, false);
    assert.equal(reserve(dir, { tool: "noul", source: "main" }).ok, false, "nothing was raised");
    const approved = approveMore(dir, 25, "yes, continue past the limit");
    assert.equal(approved.ok, true);
    assert.equal(approved.n, 25);
    assert.equal(reserve(dir, { tool: "noul", source: "main" }).ok, true);
    assert.equal(budgetView(loadControlState(dir)).limit, 50);
    assert.deepEqual(loadControlState(dir).budget.approvals.map((a) => [a.n, a.msg]), [[25, "yes, continue past the limit"]], "the words are kept for the audit");
  });
  it("a raise needs an authorization for that quantity: a quoted refusal, a question, a bigger --n or a repeat of the same words raises nothing", () => {
    const dir = stateDir();
    const limit = () => budgetView(loadControlState(dir)).limit;
    for (const words of ["Do not increase the budget.", "Should I increase the budget?", "Increase it only if the tests fail", "Nu măriți bugetul", "the budget"]) {
      assert.deepEqual(approveMore(dir, 100, words), { ok: false, reason: "message_not_authorization" }, words);
    }
    assert.equal(limit(), 25);
    assert.deepEqual(approveMore(dir, 100, "yes, approve 10 more calls"), { ok: false, reason: "over_quantum", allowed: 10 }, "a smaller quantity does not authorize 100");
    assert.equal(limit(), 25);
    assert.equal(approveMore(dir, 101, "yes, approve 500 more calls").reason, "n_invalid");
    const ten = approveMore(dir, undefined, "yes, approve 10 more calls");
    assert.equal(ten.ok, true);
    assert.equal(ten.n, 10, "without --n the quantity the words state is used");
    assert.equal(limit(), 35);
    assert.deepEqual(approveMore(dir, 10, "Yes, approve 10 MORE   calls"), { ok: false, reason: "approval_already_used" }, "the same words do not authorize twice in one request");
    assert.deepEqual(approveMore(dir, 10, "yes, approve 10 more calls again"), { ok: false, reason: "approval_already_used" }, "words that contain an earlier approval's words are the same authorization");
    assert.equal(approveMore(dir, 10, "yes, approve another 10 more calls").ok, true, "other words are another authorization (the audit still needs the user to have said them)");
    assert.equal(limit(), 45);
  });
  it("a raise needs words ABOUT the budget: an unrelated instruction, a quotation or a bare yes raises nothing", () => {
    const dir = stateDir();
    const limit = () => budgetView(loadControlState(dir)).limit;
    assert.deepEqual(approveMore(dir, 25, "Use Node 22."), { ok: false, reason: "message_not_about_budget" });
    assert.deepEqual(approveMore(dir, 25, "yes"), { ok: false, reason: "message_not_about_budget" }, "a bare yes names nothing");
    assert.deepEqual(approveMore(dir, 100, 'The documentation says "increase the budget by 100 calls".'), { ok: false, reason: "message_not_authorization" });
    assert.equal(limit(), 25);
    assert.deepEqual(approveMore(dir, 25, "yes", Date.now(), "Use Node 22?"), { ok: false, reason: "message_not_about_budget" }, "the question is about something else");
    assert.deepEqual(approveMore(dir, 25, "no thanks", Date.now(), "Raise the budget by 25 calls?"), { ok: false, reason: "message_not_authorization" });
    const answered = approveMore(dir, undefined, "yes", Date.now(), "Raise the budget by 5 calls?");
    assert.equal(answered.ok, true, "a short answer counts with the concrete question it answers");
    assert.equal(answered.n, 5, "and the question supplies the quantity");
    assert.deepEqual(loadControlState(dir).budget.approvals.map((a) => [a.n, a.msg, a.q]), [[5, "yes", "Raise the budget by 5 calls?"]]);
    assert.deepEqual(approveMore(dir, 5, "yes", Date.now(), "Raise the budget by 5 calls?"), { ok: false, reason: "approval_already_used" });
    assert.equal(limit(), 30);
  });
  it("a total limit is not an increment: «to 30 calls» is measured against the limit in force; an ambiguous quantity raises nothing", () => {
    const dir = stateDir();
    const limit = () => budgetView(loadControlState(dir)).limit;
    assert.deepEqual(approveMore(dir, 30, "Increase the budget to 30 calls."), { ok: false, reason: "over_quantum", allowed: 5 }, "from 25 the total 30 is +5");
    assert.deepEqual(approveMore(dir, 5, "Increase the budget to 30 calls.").n, 5);
    assert.equal(limit(), 30);
    assert.deepEqual(approveMore(dir, 5, "Raise the limit to 30 calls, please."), { ok: false, reason: "limit_not_raised" }, "a total already reached grants no further calls");
    assert.deepEqual(approveMore(dir, 25, "Yes, approve 30 calls."), { ok: false, reason: "quantum_ambiguous" }, "is it an increase or a total? not guessed");
    assert.deepEqual(approveMore(dir, 5, "Yes, approve up to 50 calls."), { ok: false, reason: "quantum_ambiguous" });
    assert.equal(approveMore(dir, 30, "Increase the budget by 30 calls.").n, 30);
    assert.equal(limit(), 60);
  });
  it("mentioning Jev or the calls is not authorizing a raise; a stated zero, fraction or negative raises nothing and never falls back to the default step", () => {
    const dir = stateDir();
    const limit = () => budgetView(loadControlState(dir)).limit;
    assert.deepEqual(approveMore(dir, 25, "Use Jev."), { ok: false, reason: "message_not_about_budget" });
    assert.deepEqual(approveMore(dir, 25, "Use Node 22 for the calls."), { ok: false, reason: "message_not_about_budget" });
    assert.deepEqual(approveMore(dir, 25, "yes", Date.now(), "Use Jev?"), { ok: false, reason: "message_not_about_budget" });
    assert.deepEqual(approveMore(dir, 1, "Increase the budget by 0 calls."), { ok: false, reason: "quantum_zero" });
    assert.deepEqual(approveMore(dir, undefined, "Increase the budget by 0 calls."), { ok: false, reason: "quantum_zero" }, "zero is a quantity: no +25 without --n either");
    assert.deepEqual(approveMore(dir, undefined, "Increase the budget by 0.5 calls."), { ok: false, reason: "quantum_invalid" });
    assert.deepEqual(approveMore(dir, 1, "Increase the budget by -5 calls."), { ok: false, reason: "quantum_invalid" });
    assert.deepEqual(approveMore(dir, undefined, "Increase the budget by zero calls."), { ok: false, reason: "quantum_zero" });
    assert.equal(limit(), 25, "nothing was raised by any of them");
    assert.equal(reserve(dir, { tool: "noul", source: "main" }).ok, true);
    assert.equal(approveMore(dir, undefined, "Increase the budget.").n, 25, "words that state no quantity at all get the default step");
  });
  it("one user sentence authorizes once: quoting the whole sentence and then a fragment of it raises 5, not 10", () => {
    const dir = stateDir();
    assert.equal(approveMore(dir, 5, "Yes, increase the budget by 5 calls.").ok, true);
    assert.deepEqual(approveMore(dir, 5, "increase the budget by 5 calls."), { ok: false, reason: "approval_already_used" });
    assert.equal(budgetView(loadControlState(dir)).limit, 30);
  });
  it("a new request restarts the counters and keeps a short history", () => {
    const dir = stateDir();
    reserve(dir, { tool: "noul", source: "helper" });
    withControlState(dir, (s) => startRequest(s));
    const state = loadControlState(dir);
    assert.equal(state.request.seq, 2);
    assert.equal(budgetView(state).used, 0);
    assert.deepEqual(state.budget.history, [1]);
  });
  it("is exact under concurrent processes: exactly 25 of 40 simultaneous reservations succeed", async () => {
    const dir = stateDir();
    const code = `import { reserve } from ${JSON.stringify(BUDGET)}; let ok = 0; for (let i = 0; i < 5; i++) if (reserve(${JSON.stringify(dir)}, { tool: "noul", source: "main" }).ok) ok++; console.log(ok);`;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", (status) => (status === 0 ? resolve(Number(out.trim())) : reject(new Error(`exit ${status}`))));
    })));
    assert.equal(results.reduce((a, b) => a + b, 0), 25);
    assert.equal(budgetView(loadControlState(dir)).used, 25);
  });
});

describe("the budgeted caller", () => {
  it("sends one attempt, counts it and returns the result", async () => {
    await withServer(null, async ({ caller, session, dir, env }) => {
      const reply = await caller.call(session, "jev_noul", argsNoul, { source: "helper" });
      assert.equal(reply.ok, true);
      assert.equal(reply.attempts, 1);
      const view = budgetView(loadControlState(dir));
      assert.equal(view.used, 1);
      assert.equal(view.sent, 1);
      assert.equal(serverLog(env).length, 1);
      assert.equal(loadControlState(dir).calls[0].tool, "noul");
    });
  });
  it("tools/list is discovery and costs no budget", async () => {
    await withServer(null, async ({ caller, session, dir }) => {
      const listed = await caller.listTools(session);
      assert.equal(listed.ok, true);
      assert.ok(listed.tools.length >= 11);
      assert.equal(budgetView(loadControlState(dir)).used, 0);
    });
  });
  it("one identical retry after a transport failure; both attempts count", async () => {
    await withServer({ noul: [{ fail: "transport" }, {}] }, async ({ caller, session, dir, env }) => {
      const reply = await caller.call(session, "jev_noul", argsNoul);
      assert.equal(reply.ok, true);
      assert.equal(reply.attempts, 2);
      assert.equal(budgetView(loadControlState(dir)).used, 2);
      const log = serverLog(env);
      assert.equal(log.length, 2);
      assert.deepEqual(log[0].args, log[1].args);
    });
  });
  it("gives up after the single retry (Jev unavailable): exactly two attempts", async () => {
    await withServer({ noul: [{ fail: "transport" }, { fail: "transport" }, {}] }, async ({ caller, session, dir, env }) => {
      const reply = await caller.call(session, "jev_noul", argsNoul);
      assert.equal(reply.ok, false);
      assert.equal(reply.kind, "transport");
      assert.equal(reply.attempts, 2);
      assert.equal(budgetView(loadControlState(dir)).used, 2);
      assert.equal(serverLog(env).length, 2);
    });
  });
  it("a retry at the limit is not exempt: at 24 used, the retry would be call 26 and is not sent", async () => {
    await withServer({ noul: [{ fail: "transport" }, {}] }, async ({ caller, session, dir, env }) => {
      for (let i = 0; i < 24; i++) reserve(dir, { tool: "noul", source: "main" });
      const reply = await caller.call(session, "jev_noul", argsNoul);
      assert.equal(reply.ok, false);
      assert.equal(reply.kind, "budget");
      assert.equal(reply.attempts, 1);
      assert.match(reply.retry, /not_executed/);
      assert.equal(budgetView(loadControlState(dir)).used, 25);
      assert.equal(serverLog(env).length, 1, "the retry was never sent");
    });
  });
  it("at the limit nothing is sent at all", async () => {
    await withServer(null, async ({ caller, session, dir, env }) => {
      for (let i = 0; i < 25; i++) reserve(dir, { tool: "noul", source: "main" });
      const reply = await caller.call(session, "jev_noul", argsNoul);
      assert.equal(reply.kind, "budget");
      assert.equal(reply.attempts, 0);
      assert.match(reply.message, /stop and ask the user/);
      assert.equal(serverLog(env).length, 0);
    });
  });
  it("an invalid payload or a credential is refused before any slot is reserved or anything is sent", async () => {
    await withServer(null, async ({ caller, session, dir, env }) => {
      const bad = await caller.call(session, "jev_noul", { propositions: [] });
      assert.equal(bad.kind, "invalid_args");
      assert.equal(bad.attempts, 0);
      const secret = await caller.call(session, "jev_noul", { propositions: [`token ${"sk-or-v1-" + "a".repeat(40)} leaked`] });
      assert.equal(secret.kind, "credential");
      assert.equal(budgetView(loadControlState(dir)).used, 0);
      assert.equal(serverLog(env).length, 0);
    });
  });
  it("a tool error is not retried, and a valid answer is never retried", async () => {
    await withServer({ noul: [{ fail: "tool_error" }, {}] }, async ({ caller, session, dir }) => {
      const reply = await caller.call(session, "jev_noul", argsNoul);
      assert.equal(reply.kind, "tool_error");
      assert.equal(reply.attempts, 1);
      assert.equal(budgetView(loadControlState(dir)).used, 1);
    });
  });
  it("a semantically invalid answer is retried once, then reported invalid", async () => {
    await withServer(null, async ({ caller, session, dir }) => {
      const reply = await caller.call(session, "jev_noul", argsNoul, { invalid: () => true });
      assert.equal(reply.ok, false);
      assert.equal(reply.kind, "invalid_response");
      assert.equal(reply.attempts, 2);
      assert.equal(budgetView(loadControlState(dir)).used, 2);
    });
  });
  it("attributes calls to their source", async () => {
    await withServer(null, async ({ caller, session, dir }) => {
      await caller.call(session, "jev_noul", argsNoul, { source: "gate" });
      await caller.call(session, "jev_noul", argsNoul, { source: "subagent" });
      const view = budgetView(loadControlState(dir));
      assert.equal(view.by_source.gate, 1);
      assert.equal(view.by_source.subagent, 1);
    });
  });
});

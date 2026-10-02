import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { actionHash, shortHash } from "../actions.mjs";
import { normalizeBatch } from "../options.mjs";
import { runDecision } from "../protocol.mjs";
import { loadControlState } from "../state.mjs";
import { batchOf, decide, makeRepo, noul, rerank, scriptedCaller, stateDir, writeFiles } from "./helpers.mjs";

/** Run a decision through the real protocol with scripted Jev answers. */
const dirs = new WeakMap();
const stateDirOf = (result) => dirs.get(result);
async function go(raw, steps, ctx = {}) {
  const dir = ctx.dir ?? stateDir();
  const caller = scriptedCaller(steps);
  const n = normalizeBatch(raw, { root: ctx.repoRoot ?? null });
  assert.equal(n.ok, true, JSON.stringify(n.problems));
  const result = await runDecision(n.batch, { caller, session: {}, dir, T: 0.95, priorities: "smallest correct change", headless: false, decisionId: "d1", now: Date.now, ...ctx });
  dirs.set(result, dir);
  return { result, caller, dir };
}
const probs = (real, control = [0.1, 0.1]) => [...real, ...control];
const ids = (plan, action) => plan.filter((p) => p.action === action).map((p) => p.id);

describe("eligibility is strictly above the threshold, on the raw probability", () => {
  it("a single eligible option needs no jev_decide", async () => {
    const { result, caller } = await go(batchOf(5), [noul(probs([0.982, 0.6, 0.4, 0.3, 0.2]))]);
    assert.equal(result.status, "selected");
    assert.deepEqual(ids(result.plan, "execute"), ["o1"]);
    assert.equal(caller.calls.length, 1);
    assert.equal(caller.calls[0].name, "jev_noul");
    assert.equal(caller.calls[0].args.auto_accept, 0.95);
    assert.equal(result.calls, 1);
  });
  it("0.95 is not eligible at T = 0.95, 0.951 is; the tool's label never decides", async () => {
    const at = await go(batchOf(5), [noul(probs([0.95, 0.9, 0.5, 0.4, 0.3]))]);
    assert.equal(at.result.status, "expand");
    assert.deepEqual(at.result.plan, []);
    const above = await go(batchOf(5), [noul(probs([0.951, 0.9, 0.5, 0.4, 0.3]))]);
    assert.equal(above.result.status, "selected");
    // The helper's fake marks every proposition "likely"/auto: true; only the number counts.
    assert.equal(at.caller.calls.length, 1);
  });
  it("the session threshold is the one in force", async () => {
    const { result } = await go(batchOf(5), [noul(probs([0.9, 0.5, 0.4, 0.3, 0.2]))], { T: 0.85 });
    assert.equal(result.status, "selected");
    assert.equal(result.threshold, 0.85);
  });
  it("an unusable noul answer is never read as a score", async () => {
    const missing = (args) => ({ tool: "jev_noul", status: "ok", results: args.propositions.map(() => ({ probability: null })) });
    const { result } = await go(batchOf(5), [missing, missing]);
    assert.equal(result.status, "unavailable");
    const short = await go(batchOf(5), [() => ({ tool: "jev_noul", status: "ok", results: [{ probability: 0.99 }] })]);
    assert.equal(short.result.status, "unavailable");
  });
});

describe("selection and ordering (D6, D20)", () => {
  it("exclusive kinds run only the first option; the rest are ordered reserves", async () => {
    const { result, caller } = await go(batchOf(5, { kind: "approach" }), [noul(probs([0.99, 0.97, 0.5, 0.4, 0.3])), decide("o2", 0.96)]);
    assert.equal(result.status, "selected");
    assert.deepEqual(ids(result.plan, "execute"), ["o2"]);
    assert.deepEqual(ids(result.plan, "reserve"), ["o1"]);
    assert.equal(caller.calls[1].name, "jev_decide");
    assert.equal(caller.calls[1].source, "tiebreak");
    assert.deepEqual(caller.calls[1].args.candidates.map((c) => c.id), ["o1", "o2"]);
    assert.equal(caller.calls[1].args.priorities, "smallest correct change");
    assert.equal(caller.calls[1].args.escape_hatches, undefined);
  });
  it("an order decision runs every eligible option, with successive selections only while a tie remains", async () => {
    const { result, caller } = await go(batchOf(5, { kind: "order" }), [
      noul(probs([0.991, 0.987, 0.972, 0.96, 0.42])),
      decide("o1", 0.97),
      decide("o2", 0.962),
      decide("o3", 0.957),
    ]);
    assert.equal(result.status, "ordered");
    assert.deepEqual(ids(result.plan, "execute"), ["o1", "o2", "o3", "o4"]);
    assert.equal(result.tiebreaks, 3);
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_noul", "jev_decide", "jev_decide", "jev_decide"]);
    assert.deepEqual(caller.calls[1].args.candidates.map((c) => c.id), ["o1", "o2", "o3"]);
    assert.deepEqual(caller.calls[2].args.candidates.map((c) => c.id), ["o2", "o3"]);
    assert.deepEqual(caller.calls[3].args.candidates.map((c) => c.id), ["o3", "o4"]);
  });
  it("a gap of exactly 0.02 is not a tie: the score order stands without a call", async () => {
    const { result, caller } = await go(batchOf(5, { kind: "order" }), [noul(probs([0.991, 0.971, 0.5, 0.4, 0.3]))]);
    assert.equal(result.status, "ordered");
    assert.deepEqual(ids(result.plan, "execute"), ["o1", "o2"]);
    assert.equal(caller.calls.length, 1);
  });
  it("a tie-break pick whose confidence is not above T goes to the expansion rule", async () => {
    const { result } = await go(batchOf(5), [noul(probs([0.99, 0.985, 0.5, 0.4, 0.3])), decide("o1", 0.95)]);
    assert.equal(result.status, "expand");
    assert.equal(result.reason, "decide_confidence_not_above_threshold");
    assert.deepEqual(result.plan, []);
  });
  it("a tie-break with warnings is not accepted", async () => {
    const { result } = await go(batchOf(5), [noul(probs([0.99, 0.985, 0.5, 0.4, 0.3])), decide("o1", 0.99, { warnings: ["Requirement 1 contradicted"] })]);
    assert.equal(result.status, "expand");
    assert.equal(result.reason, "decide_warnings");
  });
  it("decide escape hatches: investigate and none expand, ask_user asks", async () => {
    const esc = (sel) => decide(sel, 0.9, { escaped: true });
    const base = [noul(probs([0.99, 0.985, 0.5, 0.4, 0.3]))];
    assert.equal((await go(batchOf(5), [...base, esc("investigate")])).result.status, "expand");
    assert.equal((await go(batchOf(5), [...base, esc("none")])).result.status, "expand");
    assert.equal((await go(batchOf(5), [...base, esc("ask_user")])).result.status, "ask_user");
  });
  it("a malformed decide answer is retried by the caller, then unavailable; it never picks an option", async () => {
    const { result } = await go(batchOf(5), [noul(probs([0.99, 0.985, 0.5, 0.4, 0.3])), { fail: "invalid_response" }]);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.plan ?? [], []);
  });
});

describe("more than six in a tie group", () => {
  it("cuts at the six best scores without a rerank when the boundary is not tied", async () => {
    // Eight eligible options, 0.99 down to 0.972 (gaps below 0.02 so all are one group), strictly decreasing.
    const real = [0.99, 0.988, 0.986, 0.984, 0.982, 0.98, 0.978, 0.976];
    const { caller } = await go(batchOf(8), [noul(probs(real)), decide("o1", 0.97)]);
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_noul", "jev_decide"]);
    assert.deepEqual(caller.calls[1].args.candidates.map((c) => c.id), ["o1", "o2", "o3", "o4", "o5", "o6"]);
  });
  it("resolves a tie on the boundary with one jev_rerank over every tied option, then decides over the shortlist", async () => {
    // o1..o4 at 0.99, o5..o8 tied at 0.985: boundary (6th) is inside the tie of o5..o8.
    const real = [0.99, 0.99, 0.99, 0.99, 0.985, 0.985, 0.985, 0.985];
    const { result, caller } = await go(batchOf(8), [noul(probs(real)), rerank({ o5: 0.9, o6: 0.8, o7: 0.7, o8: 0.6 }), decide("o1", 0.97)]);
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_noul", "jev_rerank", "jev_decide"]);
    assert.deepEqual(caller.calls[1].args.candidates.map((c) => c.id), ["o5", "o6", "o7", "o8"]);
    assert.match(caller.calls[1].args.query, /should come first/);
    assert.deepEqual(caller.calls[2].args.candidates.map((c) => c.id), ["o1", "o2", "o3", "o4", "o5", "o6"]);
    assert.equal(result.status, "selected");
  });
  it("an unresolved tie at the boundary is not broken lexically: it goes to the expansion rule", async () => {
    const real = [0.99, 0.99, 0.99, 0.99, 0.985, 0.985, 0.985, 0.985];
    const { result, caller } = await go(batchOf(8), [noul(probs(real)), rerank({ o5: 0.8, o6: 0.8, o7: 0.8, o8: 0.8 })]);
    assert.equal(result.status, "expand");
    assert.equal(caller.calls.length, 2);
    assert.deepEqual(result.plan, []);
  });
});

describe("nothing eligible: expansion rounds (D7)", () => {
  const none = noul(probs([0.81, 0.77, 0.6, 0.4, 0.3]));
  it("the first none-eligible round expands; two more genuine rounds then ask", async () => {
    const dir = stateDir();
    const r0 = await go(batchOf(5), [none], { dir });
    assert.equal(r0.result.status, "expand");
    assert.equal(r0.result.expansions_left, 2);
    const fresh = (note, evidence) => {
      const b = batchOf(5, { extra: { new_material: note } });
      b.options[0].evidence = [evidence];
      return b;
    };
    const r1 = await go(fresh("read package.json", "package.json pins x 2.4"), [none], { dir });
    assert.equal(r1.result.status, "expand");
    assert.equal(r1.result.expansions_left, 1);
    const r2 = await go(fresh("a new build log warning", "the build log warns about y"), [none], { dir });
    assert.equal(r2.result.status, "ask_user");
    assert.match(r2.result.report, /^no option exceeded T=0.95 after 2 expansion round/);
    assert.equal(r2.result.round, 2);
    // A fourth call is refused outright: the rounds are used up.
    const r3 = await go(fresh("one more", "something else"), [], { dir });
    assert.equal(r3.result.status, "ask_user");
    assert.equal(r3.result.reason, "expansions_exhausted");
  });
  it("headless ends with a report that starts Incomplete: and lists the scores", async () => {
    const dir = stateDir();
    await go(batchOf(5), [none], { dir, headless: true });
    const b1 = batchOf(5, { extra: { new_material: "new" } });
    b1.options[1].evidence = ["new evidence 1"];
    await go(b1, [none], { dir, headless: true });
    const b2 = batchOf(5, { extra: { new_material: "newer" } });
    b2.options[2].evidence = ["new evidence 2"];
    const last = await go(b2, [none], { dir, headless: true });
    assert.equal(last.result.status, "incomplete");
    assert.match(last.result.report, /^Incomplete: /);
    assert.match(last.result.report, /o1=0\.81/);
  });
  it("rephrasing the same options is refused: no new material", async () => {
    const dir = stateDir();
    await go(batchOf(5), [none], { dir });
    const same = await go(batchOf(5, { extra: { new_material: "I rephrased it" } }), [], { dir });
    assert.equal(same.result.status, "refused");
    assert.equal(same.result.reason, "no_new_material");
    const noNote = batchOf(5);
    noNote.options[0].evidence = ["different now"];
    const missing = await go(noNote, [], { dir });
    assert.equal(missing.result.reason, "no_new_material");
  });
  it("selecting the control options: gather expands, ask stops; later in an order they suspend", async () => {
    const gather = await go(batchOf(5), [noul(probs([0.5, 0.5, 0.5, 0.5, 0.5], [0.99, 0.1]))]);
    assert.equal(gather.result.status, "expand");
    assert.equal(gather.result.reason, "control_gather_evidence_selected");
    const ask = await go(batchOf(5), [noul(probs([0.5, 0.5, 0.5, 0.5, 0.5], [0.1, 0.99]))]);
    assert.equal(ask.result.status, "ask_user");
    const mid = await go(batchOf(5, { kind: "order" }), [noul(probs([0.99, 0.5, 0.5, 0.5, 0.5], [0.97, 0.1]))]);
    assert.equal(mid.result.status, "ordered");
    assert.deepEqual(mid.result.plan.map((p) => `${p.id}:${p.action}`), ["o1:execute", "action_gather_evidence:suspend"]);
    assert.equal(mid.result.suspend_at, "action_gather_evidence");
  });
});

describe("Jev unavailable, budget and invalid input", () => {
  it("a transport failure after the single retry stops the step: Jev unavailable", async () => {
    const { result } = await go(batchOf(5), [{ fail: "transport", message: "MCP server exited", attempts: 2 }]);
    assert.equal(result.status, "unavailable");
    assert.match(result.message, /^Jev unavailable/);
    assert.equal(result.calls, 2);
  });
  it("a budget stop is reported as such, not as unavailable", async () => {
    const { result } = await go(batchOf(5), [{ fail: "budget", message: "Jev call budget exhausted (25/25)", attempts: 0 }]);
    assert.equal(result.status, "budget_exhausted");
  });
  it("in an order decision a failure after some selections keeps the resolved prefix and invents no order", async () => {
    const { result } = await go(batchOf(5, { kind: "order" }), [noul(probs([0.991, 0.987, 0.972, 0.5, 0.4])), decide("o1", 0.97), { fail: "budget", message: "budget", attempts: 0 }]);
    assert.equal(result.status, "budget_exhausted");
    assert.deepEqual(ids(result.plan, "execute"), ["o1"]);
    assert.deepEqual(result.unresolved, ["o2", "o3"]);
  });
  it("missing priorities are an error, not an invented text", async () => {
    const { result } = await go(batchOf(5), [], { priorities: "" });
    assert.equal(result.status, "invalid");
    assert.match(result.message, /priorities are required/);
  });
});

describe("the decision log is metadata only", () => {
  it("records ids, hashes and scores but no option text, evidence or priorities", async () => {
    const dir = stateDir();
    const raw = batchOf(5, { decision: "UNIQUE-DECISION-TEXT" });
    raw.options[0].text = "UNIQUE-OPTION-TEXT";
    raw.options[0].evidence = ["UNIQUE-EVIDENCE-TEXT"];
    await go(raw, [noul(probs([0.99, 0.5, 0.4, 0.3, 0.2]))], { dir, priorities: "UNIQUE-PRIORITIES" });
    const text = readFileSync(join(dir, "state.json"), "utf8");
    for (const secret of ["UNIQUE-DECISION-TEXT", "UNIQUE-OPTION-TEXT", "UNIQUE-EVIDENCE-TEXT", "UNIQUE-PRIORITIES"]) assert.equal(text.includes(secret), false, secret);
    const state = loadControlState(dir);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0].t, 0.95);
    assert.equal(state.decisions[0].status, "selected");
    assert.deepEqual(state.decisions[0].order, ["o1:e:0.99:-"], "the compact plan item: id, step, raw score, action hash");
    assert.deepEqual(state.decisions[0].opts[0], ["o1", 0.99, state.decisions[0].opts[0][2], "-"]);
  });
});

describe("raw scores, concrete actions and availability", () => {
  it("scores stay raw: 0.95001 is eligible at T = 0.95 and is reported as 0.95001, never rounded to 0.95", async () => {
    const { result } = await go(batchOf(5), [noul(probs([0.95001, 0.9, 0.5, 0.4, 0.3]))]);
    assert.equal(result.status, "selected");
    assert.equal(result.plan[0].score, 0.95001);
    const state = loadControlState(stateDirOf(result)).decisions;
    assert.equal(state.length, 1);
    const at = await go(batchOf(5), [noul(probs([0.95, 0.9, 0.5, 0.4, 0.3]))]);
    assert.equal(at.result.status, "expand");
    assert.equal(at.result.scores.o1, 0.95);
    const near = await go(batchOf(5), [noul(probs([0.949999, 0.9, 0.5, 0.4, 0.3]))]);
    assert.equal(near.result.scores.o1, 0.949999);
    assert.match(near.result.status, /expand/);
  });
  it("a plan item carries the option's raw score and the hash of its concrete action; the receipt provenance has the full records", async () => {
    const { result, caller } = await go(batchOf(5, { kind: "command" }), [noul(probs([0.981234, 0.6, 0.4, 0.3, 0.2]))]);
    const first = result.plan[0];
    assert.equal(first.action, "execute");
    assert.equal(first.score, 0.981234);
    assert.equal(first.ah, shortHash(actionHash({ tool: "Bash", target: "npm run check-1" })));
    const o1 = result.provenance.options.find((o) => o.id === "o1");
    assert.equal(o1.ah, actionHash({ tool: "Bash", target: "npm run check-1" }));
    assert.equal(o1.score, 0.981234);
    assert.equal(o1.oh.length, 64);
    assert.equal(result.provenance.calls[0].tool, "noul");
    assert.equal(result.provenance.calls[0].attempts, 1);
    assert.equal(result.provenance.t, 0.95);
    assert.match(caller.calls[0].args.propositions[0], /Concrete action: Bash npm run check-1\./, "Jev judges the concrete action, not only its description");
  });
  it("an option whose precondition is false is not scored and is reported as unavailable", async () => {
    const repo = makeRepo({ "a.js": "a\n" });
    const raw = batchOf(5, { kind: "edit" });
    raw.options[0].preconditions = [{ kind: "path_exists", path: "missing.js" }];
    raw.options[1].preconditions = [{ kind: "path_exists", path: "a.js" }];
    const { result, caller } = await go(raw, [noul([0.99, 0.5, 0.4, 0.3, 0.1, 0.1])], { repoRoot: repo });
    assert.equal(caller.calls[0].args.propositions.length, 6, "five real options minus one unavailable, plus two control options");
    assert.ok(!caller.calls[0].args.propositions.some((p) => p.includes("option o1")));
    assert.deepEqual(result.unavailable, ["o1:path_exists_missing"]);
    assert.equal(result.status, "selected");
    assert.equal(result.plan[0].id, "o2");
    assert.equal(result.provenance.options.find((o) => o.id === "o1").unavailable, "path_exists_missing");
  });
  it("preconditions that cannot be evaluated (no repository) make the option unavailable, never available", async () => {
    const raw = batchOf(5, { kind: "edit" });
    raw.options[0].preconditions = [{ kind: "path_exists", path: "a.js" }];
    const { result } = await go(raw, [noul([0.99, 0.5, 0.4, 0.3, 0.1, 0.1])]);
    assert.deepEqual(result.unavailable, ["o1:preconditions_not_evaluable"]);
  });
  it("when every real option is unavailable nothing is sent and the expansion rule applies", async () => {
    const repo = makeRepo({ "a.js": "a\n" });
    const raw = batchOf(5, { kind: "edit" });
    for (const o of raw.options) o.preconditions = [{ kind: "path_absent", path: "a.js" }];
    const { result, caller } = await go(raw, [], { repoRoot: repo });
    assert.equal(result.status, "expand");
    assert.equal(result.reason, "all_options_unavailable");
    assert.equal(caller.calls.length, 0);
    assert.equal(result.unavailable.length, 5);
  });
  it("a changed command or precondition is new material in an expansion round", async () => {
    const dir = stateDir();
    const none = noul(probs([0.81, 0.77, 0.6, 0.4, 0.3]));
    await go(batchOf(5, { kind: "command" }), [none], { dir });
    const same = batchOf(5, { kind: "command", extra: { new_material: "same again" } });
    assert.equal((await go(same, [], { dir })).result.reason, "no_new_material");
    const changed = batchOf(5, { kind: "command", extra: { new_material: "another command" } });
    changed.options[0].action = { tool: "Bash", target: "npm run other" };
    assert.equal((await go(changed, [none], { dir })).result.round, 1);
  });
});

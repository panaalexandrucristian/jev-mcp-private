import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { actionHash, planItem, shortHash } from "../actions.mjs";
import { audit, collectEvents, compareUsage, parseJsonl, STOP_STATUSES, toMarkdown, usageSummary } from "../measure.mjs";
import { run, tempDir } from "./helpers.mjs";

let n = 0;
const uid = () => `toolu_${++n}`;
const ROOT = "/repo";
const use = (name, input) => ({ type: "tool_use", id: uid(), name, input });
/** Records carry the transcript's own identity fields: cwd, isSidechain and, for a subagent, agentId. */
const who = ({ agent = null, cwd = ROOT } = {}) => ({ ...(cwd ? { cwd } : {}), isSidechain: agent !== null, ...(agent ? { agentId: agent } : {}) });
const asst = (blocks, { id = `msg_${++n}`, usage, agent = null, cwd = ROOT, ts } = {}) => ({ type: "assistant", ...who({ agent, cwd }), ...(ts ? { timestamp: ts } : {}), message: { id, role: "assistant", content: blocks, ...(usage ? { usage } : {}) } });
const res = (block, text, { ts, error = false, agent = null, cwd = ROOT } = {}) => ({ type: "user", ...who({ agent, cwd }), ...(ts ? { timestamp: ts } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, is_error: error, content: [{ type: "text", text }] }] } });
const prompt = (text) => ({ type: "user", ...who(), message: { role: "user", content: text } });
const CLI = '/p/private/jev-control/cli.mjs"';
const bash = (cmd) => use("Bash", { command: cmd });
const helper = (sub, extra = "") => bash(`node "${CLI} ${sub} ${extra}`);
/** assistant tool_use + its result as two records */
const call = (block, text, opts = {}) => [asst([block], opts), res(block, text, opts)];
const json = (o) => JSON.stringify(o);
const ah = (tool, target) => shortHash(actionHash({ tool, target }));
const item = (id, action, score, tool, target) => planItem({ id, action, score, descriptor: tool ? { tool, target } : null });
const decideOut = (o) => json({ status: "selected", decision_id: "d1", kind: "edit", threshold: 0.95, round: 1, calls: 1, tiebreaks: 0, receipt: "r1", plan: [], plan_total: 0, ...o });
const decide = (out, opts) => call(helper("decide", "--file /tmp/b.json"), out, opts);
const edit = (path, opts) => call(use("Edit", { file_path: `${ROOT}/${path}`, old_string: "a", new_string: "b" }), "ok", opts);
const write = (path, opts) => call(use("Write", { file_path: path.startsWith("/") ? path : `${ROOT}/${path}`, content: "x" }), "ok", opts);
const read = (path, opts) => call(use("Read", { file_path: path.startsWith("/") ? path : `${ROOT}/${path}` }), "content", opts);

describe("coverage is bound to a concrete grant, never to a generic slot", () => {
  it("(a) a direct jev_noul at .01 and a helper plan call followed by an unrelated Write leave the Write uncovered", () => {
    const direct = use("mcp__jev__jev_noul", { propositions: ["x"] });
    const recs = [
      prompt("go"),
      ...call(direct, json({ tool: "jev_noul", status: "ok", results: [{ id: "proposition0", probability: 0.01 }] })),
      ...call(helper("plan"), json({ status: "ok" })),
      ...decide(decideOut({ status: "below_threshold", scores: ["o1:0.01"] })),
      ...write("src/new.mjs"),
    ];
    const a = audit(recs);
    assert.equal(a.coverage.covered, 0);
    assert.equal(a.coverage.uncovered, 1);
    assert.equal(a.coverage.uncovered_samples[0].reason, "no_grant");
    assert.equal(a.coverage.share, 0);
    assert.equal(a.coverage.protocol, 2);
  });
  it("a plan item covers exactly the action it names, nothing else", () => {
    const plan = [item("o1", "execute", 0.98, "Edit", "src/a.mjs")];
    const recs = [prompt("please fix the module"), ...decide(decideOut({ plan, plan_total: 1 })), ...edit("src/b.mjs"), ...edit("src/a.mjs")];
    const a = audit(recs);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 1);
    assert.equal(a.coverage.numerator, 1);
    assert.equal(a.coverage.denominator, 2);
    assert.equal(a.coverage.share, 0.5);
    assert.equal(a.coverage.uncovered_samples[0].at, 3);
  });
  it("(d) one grant used by a second identical action leaves the second uncovered", () => {
    const plan = [item("o1", "execute", 0.98, "Edit", "src/a.mjs")];
    const a = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/a.mjs"), ...edit("src/a.mjs")]);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 1);
    assert.deepEqual(a.coverage.uncovered_reasons, { grant_already_used: 1 });
  });
  it("(e) a result recorded after an action never authorizes it, even an action issued with the helper call", () => {
    const plan = [item("o1", "execute", 0.98, "Edit", "src/a.mjs")];
    const d = helper("decide", "--file b.json");
    const e = use("Edit", { file_path: `${ROOT}/src/a.mjs` });
    // Both tool_use blocks in one assistant message: the decide result arrives after the Edit was issued.
    const parallel = audit([prompt("go"), asst([d, e]), res(d, decideOut({ plan })), res(e, "ok")]);
    assert.equal(parallel.coverage.covered, 0);
    assert.equal(parallel.coverage.uncovered, 1);
    const later = audit([prompt("go"), ...edit("src/a.mjs"), ...decide(decideOut({ plan }))]);
    assert.equal(later.coverage.covered, 0);
    assert.equal(later.coverage.uncovered, 1);
  });
  it("a non-order kind executes only its first execute item", () => {
    const plan = [item("o1", "execute", 0.99, "Edit", "src/a.mjs"), item("o2", "execute", 0.98, "Edit", "src/b.mjs")];
    const a = audit([prompt("go"), ...decide(decideOut({ kind: "approach", plan })), ...edit("src/b.mjs")]);
    assert.equal(a.coverage.covered, 0);
    assert.equal(a.coverage.uncovered, 1);
  });
  it("reserve, suspend and after-suspend items grant nothing; only action_ask_user gives a question grant", () => {
    const plan = [
      item("o1", "reserve", 0.99, "Edit", "src/r.mjs"),
      item("gather", "suspend", 0.5, "Read", "src/s.mjs"),
      item("o2", "after_suspend", 0.99, "Edit", "src/x.mjs"),
      item("action_ask_user", "suspend", 0.4, null),
    ];
    const ask = use("AskUserQuestion", { questions: [] });
    const a = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/r.mjs"), ...read("src/s.mjs"), ...edit("src/x.mjs"), ...call(ask, "answer"), ...call(use("AskUserQuestion", {}), "again")]);
    assert.equal(a.coverage.covered, 1, "one question");
    assert.equal(a.coverage.uncovered, 4);
  });
  it("a search hit grants one Read of exactly that path", () => {
    const s = helper("search", '--query "where is x"');
    const out = json({ status: "found", jev_calls: 2, hits: [{ path: "src/x.mjs", start_line: 1, end_line: 9, sha256: "a".repeat(64), score: 0.97 }] });
    const a = audit([prompt("go"), ...call(s, out), ...read("src/x.mjs"), ...read("src/y.mjs"), ...read("src/x.mjs"), ...edit("src/x.mjs")]);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 3);
    const tie = json({ status: "tie_unresolved", hits: [{ path: "src/x.mjs" }, { path: "src/y.mjs" }], resolved_hits: [{ path: "src/y.mjs" }] });
    const b = audit([prompt("go"), ...call(helper("search", "--query q"), tie), ...read("src/x.mjs"), ...read("src/y.mjs")]);
    assert.equal(b.coverage.covered, 1);
    assert.equal(b.coverage.uncovered_samples[0].tool, "Read");
  });
  it("a direct_read search result is an exception only when the user named the path", () => {
    const dr = json({ status: "direct_read", hits: [{ path: "src/x.mjs" }] });
    const named = audit([prompt("look at src/x.mjs please"), ...call(helper("search", "--exact-path src/x.mjs"), dr), ...read("src/x.mjs")]);
    assert.equal(named.coverage.exceptions.user_named_path, 1);
    assert.equal(named.coverage.denominator, 0);
    const unnamed = audit([prompt("look around"), ...call(helper("search", "--exact-path src/x.mjs"), dr), ...read("src/x.mjs")]);
    assert.equal(unnamed.coverage.exceptions.user_named_path, 0);
    assert.deepEqual(unnamed.coverage.uncovered_reasons, { direct_read_not_named_by_user: 1 });
  });
  it("a delegation is an action like the others (target = subagent type)", () => {
    const plan = [item("o1", "execute", 0.99, "Agent", "jev-locator")];
    const a = audit([prompt("go"), ...decide(decideOut({ kind: "delegate", plan })), ...call(use("Task", { subagent_type: "jev-locator", prompt: "find" }), "done")]);
    assert.equal(a.coverage.covered, 1);
  });
  it("mechanical, protocol and unclassifiable events are counted apart; an empty denominator is unknown", () => {
    const recs = [prompt("go"), ...call(use("ToolSearch", { query: "x" }), "ok"), ...call(use("Skill", { skill: "jev-control" }), "ok"), ...call(use("SomethingNew", {}), "ok"), ...call(bash("node scripts/jev-gate-run.mjs --claims x"), "{}")];
    const a = audit(recs);
    assert.equal(a.coverage.mechanical, 2);
    assert.equal(a.coverage.unclassified, 1);
    assert.equal(a.coverage.protocol, 1);
    assert.equal(a.coverage.denominator, 0);
    assert.equal(a.coverage.share, "unknown");
  });
  it("a helper call whose result is missing makes later unattributable actions unknown, not uncovered", () => {
    const a = audit([prompt("go"), asst([helper("decide", "--file b.json")]), ...edit("src/a.mjs")]);
    assert.equal(a.coverage.unknown, 1);
    assert.equal(a.coverage.uncovered, 0);
    assert.equal(a.coverage.unknown_samples[0].reason, "helper_result_missing");
  });
  it("a helper chained with other commands is counted as compound; a here-document body is not a command", () => {
    const heredoc = bash(`node "${CLI} decide --file - <<'EOF'\n{"a": 1}; rm -rf x\nEOF`);
    const chained = bash(`node "${CLI} status && rm -rf src`);
    const a = audit([prompt("go"), ...call(heredoc, decideOut({ status: "expand" })), ...call(chained, json({ status: "ok" }))]);
    assert.equal(a.coverage.protocol, 2);
    assert.equal(a.coverage.protocol_compound, 1);
  });
});

describe("the exact-path exception", () => {
  it("(b) applies only to a Read of the exact path the prompt names", () => {
    const recs = [
      prompt("Read parser.js and tell me what it exports."),
      ...read("parser.js"),
      ...write("parser.js"),
      ...edit("parser.js"),
      ...read("/x/other/parser.js.bak"),
      ...read("lib/parser.js"),
      ...read("/elsewhere/parser.js"),
    ];
    const a = audit(recs);
    assert.equal(a.coverage.exceptions.user_named_path, 1);
    assert.equal(a.coverage.covered, 0);
    assert.equal(a.coverage.uncovered, 5);
    assert.deepEqual(a.coverage.uncovered_samples.map((s) => s.tool), ["Write", "Edit", "Read", "Read", "Read"]);
  });
  it("compares normalized paths: an absolute path inside the working directory equals its relative form; a line suffix is ignored", () => {
    const a = audit([prompt("check `/repo/src/./config.mjs:12`"), ...read("src/config.mjs")]);
    assert.equal(a.coverage.exceptions.user_named_path, 1);
  });
  it("uses the prompt of the current request only", () => {
    const a = audit([prompt("Read parser.js"), prompt("now something else"), ...read("parser.js")]);
    assert.equal(a.coverage.exceptions.user_named_path, 0);
    assert.equal(a.coverage.uncovered, 1);
  });
});

describe("ordering of executed actions", () => {
  const plan = [item("a", "execute", 0.99, "Edit", "src/1.mjs"), item("b", "execute", 0.98, "Edit", "src/2.mjs"), item("r", "reserve", 0.97, "Edit", "src/3.mjs")];
  it("an order plan covers its execute items in plan order", () => {
    const a = audit([prompt("do tasks"), ...decide(decideOut({ status: "ordered", kind: "order", plan })), ...edit("src/1.mjs"), ...edit("src/2.mjs"), ...edit("src/3.mjs")]);
    assert.equal(a.coverage.covered, 2);
    assert.equal(a.coverage.uncovered, 1, "the reserve is never an automatic fallback");
    assert.equal(a.ordering.order_violations.length, 0);
    assert.equal(a.ordering.action_order, "measured");
  });
  it("(c) swapped execution order is an order violation and the out-of-order action is uncovered", () => {
    const a = audit([prompt("do tasks"), ...decide(decideOut({ status: "ordered", kind: "order", plan })), ...edit("src/2.mjs"), ...edit("src/1.mjs")]);
    assert.deepEqual(a.ordering.order_violations.map(({ decision_id, expected, got }) => ({ decision_id, expected, got })), [{ decision_id: "d1", expected: "a", got: "b" }]);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 1);
    assert.deepEqual(a.coverage.uncovered_reasons, { out_of_order: 1 });
    assert.equal(a.eliminators.below_threshold_actions_without_approval, 1);
  });
  it("plans are checked for descending execute scores unless a tie-break ordered them", () => {
    const up = [item("a", "execute", 0.96, "Edit", "src/1.mjs"), item("b", "execute", 0.99, "Edit", "src/2.mjs")];
    const a = audit([
      prompt("go"),
      ...decide(decideOut({ status: "ordered", kind: "order", plan })),
      ...decide(decideOut({ status: "ordered", kind: "order", decision_id: "d2", plan: up })),
      ...decide(decideOut({ status: "ordered", kind: "order", decision_id: "d3", tiebreaks: 1, plan: up })),
    ]);
    assert.equal(a.ordering.plans, 3);
    assert.equal(a.ordering.plans_descending, 2);
    assert.deepEqual(a.ordering.not_descending.map((x) => x.decision), ["d2"]);
    assert.equal(a.ordering.tiebreak_plans, 1);
  });
  it("(j) a partial plan grants its later items only after a page that continues it", () => {
    const first = [item("a", "execute", 0.99, "Edit", "src/1.mjs")];
    const rest = [item("b", "execute", 0.98, "Edit", "src/2.mjs")];
    const partial = decideOut({ status: "ordered", kind: "order", plan: first, plan_total: 2, plan_next: 1 });
    const page = (from) => json({ status: "ok", decision_id: "d1", part: "plan", from, plan: rest, plan_total: 2 });
    const without = audit([prompt("go"), ...decide(partial), ...edit("src/1.mjs"), ...edit("src/2.mjs")]);
    assert.equal(without.coverage.covered, 1);
    assert.equal(without.ordering.partial_plans_incomplete, 1);
    const paged = audit([prompt("go"), ...decide(partial), ...edit("src/1.mjs"), ...call(helper("page", "--decision d1 --from 1"), page(1)), ...edit("src/2.mjs")]);
    assert.equal(paged.coverage.covered, 2);
    assert.equal(paged.ordering.pages_applied, 1);
    assert.equal(paged.ordering.partial_plans_incomplete, 0);
    const wrongFrom = audit([prompt("go"), ...decide(partial), ...call(helper("page", "--decision d1 --from 5"), page(5)), ...edit("src/1.mjs"), ...edit("src/2.mjs")]);
    assert.equal(wrongFrom.coverage.covered, 1);
    assert.equal(wrongFrom.ordering.pages_ignored, 1);
    const early = audit([prompt("go"), ...decide(partial), ...edit("src/2.mjs"), ...call(helper("page", "--decision d1 --from 1"), page(1))]);
    assert.equal(early.coverage.covered, 0, "the page arrived after the action");
  });
});

describe("threshold, stops and approvals", () => {
  it("(m) an execute item exactly at the threshold is a violation with no grant; one strictly above is fine (raw numbers)", () => {
    const at = audit([prompt("go"), ...decide(decideOut({ plan: [item("o1", "execute", 0.95, "Edit", "src/a.mjs")] })), ...edit("src/a.mjs")]);
    assert.equal(at.threshold.violations.length, 1);
    assert.equal(at.threshold.violations[0].kind, "plan_item_not_above_threshold");
    assert.equal(at.threshold.violations[0].value, 0.95);
    assert.equal(at.coverage.covered, 0);
    assert.equal(at.eliminators.below_threshold_actions_without_approval, 1);
    const above = audit([prompt("go"), ...decide(decideOut({ plan: [item("o1", "execute", 0.95001, "Edit", "src/a.mjs")] })), ...edit("src/a.mjs")]);
    assert.equal(above.threshold.violations.length, 0);
    assert.equal(above.threshold.plan_items_checked, 1);
    assert.equal(above.coverage.covered, 1);
  });
  it("uses the output's own threshold, not the audit default", () => {
    const a = audit([prompt("go"), ...decide(decideOut({ threshold: 0.99, plan: [item("o1", "execute", 0.98, "Edit", "src/a.mjs")] }))], { threshold: 0.9 });
    assert.equal(a.threshold.violations.length, 1);
  });
  it("an action after a blocking stop counts as an action while blocked; asking the user does not; expand does not block", () => {
    const stop = decideOut({ status: "ask_user", plan: undefined, scores: ["o1:0.7"] });
    const a = audit([prompt("go"), ...decide(stop), ...call(use("AskUserQuestion", { questions: [] }), "yes"), ...edit("src/x.mjs")]);
    assert.equal(a.threshold.actions_while_blocked, 1);
    assert.equal(a.coverage.covered, 1, "the question is covered by the stop");
    assert.deepEqual(a.coverage.uncovered_reasons, { while_blocked: 1 });
    const expand = audit([prompt("go"), ...decide(decideOut({ status: "expand", scores: ["o1:0.7"] })), ...read("src/x.mjs")]);
    assert.equal(expand.threshold.actions_while_blocked, 0);
    assert.equal(expand.coverage.uncovered, 1, "evidence gathering still needs a grant");
    assert.ok(STOP_STATUSES.has("below_threshold"));
  });
  it("a new helper result unblocks; a page of the blocking decision does not", () => {
    const stop = decideOut({ status: "incomplete", scores: ["o1:0.7"], scores_total: 3, scores_next: 1 });
    const scoresPage = json({ status: "ok", decision_id: "d1", part: "scores", from: 1, scores: ["o2:0.1"], scores_total: 3 });
    const a = audit([prompt("go"), ...decide(stop), ...call(helper("page", "--decision d1 --part scores --from 1"), scoresPage), ...edit("src/x.mjs")]);
    assert.equal(a.threshold.actions_while_blocked, 1);
    const plan = [item("o1", "execute", 0.99, "Edit", "src/x.mjs")];
    const b = audit([prompt("go"), ...decide(stop), ...decide(decideOut({ decision_id: "d2", plan })), ...edit("src/x.mjs")]);
    assert.equal(b.threshold.actions_while_blocked, 0);
    assert.equal(b.coverage.covered, 1);
  });
  it("(f) an approval whose message is not in a user message is unbound; a bound one authorizes only that option, once", () => {
    const stop = decideOut({ status: "ask_user", scores: ["o1:0.7"] });
    const approve = (msg) => helper("approve", `--decision d1 --option o1 --message "${msg}"`);
    const ok = json({ status: "ok", override: "user", decision_id: "d1", option: "o1", ah: ah("Edit", "src/x.mjs") });
    const unbound = audit([prompt("please fix the parser"), ...decide(stop), ...call(approve("yes go ahead"), ok), ...edit("src/x.mjs")]);
    assert.equal(unbound.threshold.approvals_unbound, 1);
    assert.equal(unbound.approvals.bound, 0);
    assert.equal(unbound.threshold.actions_while_blocked, 1, "an unbound approval does not unblock");
    assert.equal(unbound.coverage.covered, 0);
    const bound = audit([prompt("Use   option one, Fix the parser"), ...decide(stop), ...call(approve("fix the  parser"), ok), ...edit("src/x.mjs"), ...edit("src/y.mjs"), ...edit("src/x.mjs")]);
    assert.equal(bound.approvals.bound, 1);
    assert.equal(bound.threshold.approvals_unbound, 0);
    assert.equal(bound.threshold.actions_while_blocked, 0);
    assert.equal(bound.coverage.covered, 1);
    assert.equal(bound.coverage.uncovered, 2);
    const later = audit([prompt("go"), ...decide(stop), ...call(approve("fix the parser"), ok), prompt("fix the parser")]);
    assert.equal(later.threshold.approvals_unbound, 1, "a message after the approve call does not bind it");
    const tooShort = audit([prompt("ok go"), ...decide(stop), ...call(approve("ok"), ok)]);
    assert.equal(tooShort.threshold.approvals_unbound, 1);
  });
  it("the answer to a question binds an approval of the same request", () => {
    const stop = decideOut({ status: "ask_user", scores: ["o1:0.7"] });
    const ok = json({ status: "ok", override: "user", decision_id: "d1", option: "o1", ah: ah("Edit", "src/x.mjs") });
    const a = audit([prompt("go"), ...decide(stop), ...call(use("AskUserQuestion", { questions: [] }), "User answered: take option one"), ...call(helper("approve", '--decision d1 --option o1 --message "take option one"'), ok), ...edit("src/x.mjs")]);
    assert.equal(a.approvals.bound, 1);
    assert.equal(a.coverage.covered, 2);
  });
});

describe("requests and agent contexts", () => {
  const plan = [item("o1", "execute", 0.99, "Edit", "src/a.mjs")];
  it("(h) a grant of request 1 does not cover an action of request 2", () => {
    const a = audit([prompt("first"), ...decide(decideOut({ plan })), prompt("second"), ...edit("src/a.mjs")]);
    assert.equal(a.coverage.covered, 0);
    assert.deepEqual(a.coverage.uncovered_reasons, { grant_in_other_context_or_request: 1 });
  });
  it("(h) subagent grants do not cover parent actions and vice versa; each subagent is its own context", () => {
    const sub = audit([prompt("go"), ...decide(decideOut({ plan }), { agent: "agent-1" }), ...edit("src/a.mjs")]);
    assert.equal(sub.coverage.covered, 0);
    const parent = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/a.mjs", { agent: "agent-1" })]);
    assert.equal(parent.coverage.covered, 0);
    const other = audit([prompt("go"), ...decide(decideOut({ plan }), { agent: "agent-1" }), ...edit("src/a.mjs", { agent: "agent-2" })]);
    assert.equal(other.coverage.covered, 0);
    const same = audit([prompt("go"), ...decide(decideOut({ plan }), { agent: "agent-1" }), ...edit("src/a.mjs", { agent: "agent-1" })]);
    assert.equal(same.coverage.covered, 1);
    assert.equal(same.coverage.by_context["agent-1"].covered, 1);
  });
  it("a subagent's own prompt does not start a request", () => {
    const subPrompt = { type: "user", ...who({ agent: "agent-1" }), message: { role: "user", content: "find src/a.mjs" } };
    const a = audit([prompt("go"), ...decide(decideOut({ plan })), subPrompt, ...edit("src/a.mjs")]);
    assert.equal(a.coverage.covered, 1);
  });
  it("(i) a tool_use streamed twice counts once", () => {
    const e = use("Edit", { file_path: `${ROOT}/src/a.mjs` });
    const recs = [prompt("go"), ...decide(decideOut({ plan })), asst([e], { id: "m9" }), asst([e], { id: "m9" }), res(e, "ok"), res(e, "ok")];
    assert.equal(collectEvents(recs).length, 2);
    const a = audit(recs);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 0);
  });
});

describe("Jev calls and budget", () => {
  const noul = () => use("mcp__plugin_jev_jev__jev_noul", { propositions: ["x"] });
  const noulOut = json({ tool: "jev_noul", status: "ok", results: [{ id: "proposition0", proposition: "x", probability: 0.4 }] });
  const reserve = (tool, id) => call(helper("budget", `reserve --tool ${tool}`), json({ status: "ok", id, used: 1, limit: 25 }));
  it("(g) a direct call without an open reservation is unreserved; with reserve, call, confirm it is reserved", () => {
    const bare = audit([prompt("go"), ...call(noul(), noulOut)]);
    assert.equal(bare.jev_calls.direct.main, 1);
    assert.equal(bare.jev_calls.direct.by_tool.noul, 1);
    assert.equal(bare.jev_calls.unreserved_direct.length, 1);
    assert.equal(bare.jev_calls.unreserved_direct[0].tool, "noul");
    const ok = audit([prompt("go"), ...reserve("noul", "r1"), ...call(noul(), noulOut), ...call(helper("budget", "confirm --id r1 --ok 1"), json({ status: "ok", used: 1, limit: 25 }))]);
    assert.equal(ok.jev_calls.unreserved_direct.length, 0);
    assert.equal(ok.jev_calls.reserved_direct, 1);
    assert.equal(ok.jev_calls.reservations.confirmed, 1);
    assert.equal(ok.jev_calls.reservations.open_unused, 0);
    assert.deepEqual(ok.jev_calls.direct_invalid_results, [], "a well-formed noul result is valid");
    assert.equal(ok.coverage.covered + ok.coverage.uncovered, 0, "direct calls are never actions or grants");
  });
  it("(g) an unrelated budget command, a reservation for another tool, a used or released one, or one of another request does not count", () => {
    const status = audit([prompt("go"), ...call(helper("budget", "status"), json({ status: "ok", used: 3, limit: 25 })), ...call(noul(), noulOut)]);
    assert.equal(status.jev_calls.unreserved_direct.length, 1);
    assert.equal(status.jev_calls.state_used, 3);
    const otherTool = audit([prompt("go"), ...reserve("decide", "r1"), ...call(noul(), noulOut)]);
    assert.equal(otherTool.jev_calls.unreserved_direct.length, 1);
    const twice = audit([prompt("go"), ...reserve("jev_noul", "r1"), ...call(noul(), noulOut), ...call(noul(), noulOut)]);
    assert.equal(twice.jev_calls.reserved_direct, 1);
    assert.equal(twice.jev_calls.unreserved_direct.length, 1);
    const released = audit([prompt("go"), ...reserve("noul", "r1"), ...call(helper("budget", "release --id r1"), json({ status: "ok" })), ...call(noul(), noulOut)]);
    assert.equal(released.jev_calls.unreserved_direct.length, 1);
    const otherRequest = audit([prompt("one"), ...reserve("noul", "r1"), prompt("two"), ...call(noul(), noulOut)]);
    assert.equal(otherRequest.jev_calls.unreserved_direct.length, 1);
    const r = helper("budget", "reserve --tool noul");
    const d = noul();
    const sameMessage = audit([prompt("go"), asst([r, d]), res(r, json({ status: "ok", id: "r1" })), res(d, noulOut)]);
    assert.equal(sameMessage.jev_calls.unreserved_direct.length, 1, "the reservation result arrived after the call");
  });
  it("audits direct results: invalid results and a non-actionable decide are recorded, never granted", () => {
    const dec = use("mcp__jev__jev_decide", { decision: "d", evidence: "e", priorities: "p", candidates: [{ id: "a", description: "x" }, { id: "b", description: "y" }] });
    const decOut = (confidence, extra = {}) => json({ tool: "jev_decide", recommendation: { selected: "a", escaped: false, confidence }, warnings: [], ...extra });
    const a = audit([prompt("go"), ...call(dec, decOut(0.95)), ...call(noul(), json({ tool: "jev_noul", results: [] })), ...edit("src/a.mjs")], { threshold: 0.95 });
    assert.equal(a.jev_calls.direct_decide_not_actionable.length, 1);
    assert.equal(a.jev_calls.direct_invalid_results[0].reason, "result_count");
    assert.equal(a.coverage.uncovered, 1);
    const fine = audit([prompt("go"), ...call(dec, decOut(0.96))]);
    assert.equal(fine.jev_calls.direct_decide_not_actionable.length, 0);
    const warned = audit([prompt("go"), ...call(dec, decOut(0.99, { warnings: ["w"] }))]);
    assert.equal(warned.jev_calls.direct_decide_not_actionable.length, 1);
    const sub = audit([prompt("go"), ...call(noul(), noulOut, { agent: "agent-1" })]);
    assert.equal(sub.jev_calls.direct.subagent, 1);
  });
  it("sums helper-reported attempts per request and flags a request over its limit", () => {
    const a = audit([
      prompt("go"),
      ...decide(decideOut({ calls: 20, status: "expand", scores: [] })),
      ...call(helper("search", "--query q"), json({ status: "none_eligible", jev_calls: 6 })),
      prompt("again"),
      ...decide(decideOut({ calls: 20, status: "expand", scores: [] })),
      ...call(helper("budget", "approve --n 25"), json({ status: "ok", used: 20, limit: 50 })),
      ...call(helper("search", "--query q"), json({ status: "none_eligible", jev_calls: 6 })),
    ]);
    assert.equal(a.jev_calls.helper_reported_attempts, 52);
    assert.deepEqual(a.jev_calls.per_request, [
      { request: 1, helper_attempts: 26, direct: 0, approved_extra: 0, limit: 25 },
      { request: 2, helper_attempts: 26, direct: 0, approved_extra: 25, limit: 50 },
    ]);
    assert.deepEqual(a.jev_calls.violations, [{ kind: "budget_exceeded", request: 1, attempts: 26, limit: 25 }]);
  });
});

describe("finalization", () => {
  const plan = [item("o1", "execute", 0.99, "Edit", "src/a.mjs")];
  const done = (outcome) => call(helper("done", "--claims c.json"), json({ jev_flow_gate_run: 1, outcome, verdict: outcome, status: "ok", exit: outcome === "accepted" ? 0 : 2, receipt: "x", jev_calls: 2, snapshot: "abc" }));
  it("(k) edits without an accepted done, and an edit after the last accepted done, are violations", () => {
    const none = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/a.mjs"), ...done("needs_evidence")]);
    assert.deepEqual(none.finalization.violations.map((v) => v.kind), ["finished_without_accepted_done"]);
    assert.equal(none.finalization.done_calls, 1);
    assert.equal(none.finalization.last_outcome, "needs_evidence");
    assert.equal(none.finalization.accepted, false);
    const after = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/a.mjs"), ...done("accepted"), ...write("src/late.mjs")]);
    assert.deepEqual(after.finalization.violations.map((v) => v.kind), ["edit_after_last_accepted_done"]);
    assert.equal(after.finalization.accepted, true);
    const good = audit([prompt("go"), ...decide(decideOut({ plan })), ...edit("src/a.mjs"), ...done("checks_failed"), ...done("accepted")]);
    assert.deepEqual(good.finalization.violations, []);
    assert.equal(good.finalization.done_calls, 2);
    assert.equal(good.jev_calls.helper_reported_attempts, 5);
    assert.equal(audit([prompt("just a question")]).finalization.violations.length, 0);
  });
  it("counts receipt verifications and refusals", () => {
    const a = audit([prompt("go"), ...call(helper("receipt", "verify --id x"), json({ status: "ok", authorized: true })), ...call(helper("receipt", "verify --id y"), json({ status: "refused", authorized: false }))]);
    assert.deepEqual(a.receipts, { receipt_verifications: 1, receipt_refusals: 1 });
  });
});

describe("(l) token usage: complete totals only, per-field streaming merge, real attribution", () => {
  it("counts a streamed message once and separates the subagent, per agent id too", () => {
    const records = [
      asst([{ type: "text", text: "a" }], { id: "m1", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }),
      asst([{ type: "text", text: "a" }], { id: "m1", usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }),
      asst([{ type: "text", text: "b" }], { id: "m2", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }),
      asst([{ type: "text", text: "s" }], { id: "m3", agent: "agent-7", usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 9 } }),
      { type: "result", usage: { input_tokens: 99999, output_tokens: 99999, cache_read_input_tokens: 99999, cache_creation_input_tokens: 99999 } },
    ];
    const u = usageSummary(records);
    assert.equal(u.attribution, "known");
    assert.equal(u.parent.messages, 2);
    assert.equal(u.parent.input_tokens, 13);
    assert.equal(u.parent.output_tokens, 9);
    assert.equal(u.parent.cache_read_input_tokens, 150);
    assert.equal(u.parent.cache_creation_input_tokens, 5);
    assert.equal(u.subagent.input_tokens, 1000);
    assert.equal(u.by_agent["agent-7"].output_tokens, 20);
    assert.equal(u.total.input_tokens, 1013);
    assert.equal(u.reported_total.input_tokens, 99999, "kept apart, never added again");
  });
  it("merges streaming updates field by field: an earlier maximum survives, a later record without a field never erases it", () => {
    const u = usageSummary([
      asst([], { id: "m1", usage: { input_tokens: 50, output_tokens: 1 } }),
      asst([], { id: "m1", usage: { input_tokens: 10, output_tokens: 30 } }),
      asst([], { id: "m1", usage: { output_tokens: 20, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } }),
    ]);
    assert.equal(u.parent.messages, 1);
    assert.equal(u.parent.input_tokens, 50);
    assert.equal(u.parent.output_tokens, 30);
    assert.equal(u.parent.cache_read_input_tokens, 4);
    assert.equal(u.parent.cache_creation_input_tokens, 0);
  });
  it("a total with a missing message is unknown, with the observed subtotal apart; a field never seen is unknown", () => {
    const u = usageSummary([asst([], { id: "a", usage: { input_tokens: 5, output_tokens: 1 } }), asst([], { id: "b", usage: { input_tokens: 7 } })]);
    assert.equal(u.parent.input_tokens, 12);
    assert.equal(u.parent.output_tokens, "unknown");
    assert.equal(u.parent.output_tokens_observed, 1);
    assert.equal(u.parent.output_tokens_missing_messages, 1);
    assert.deepEqual(u.parent.partial_fields, ["output_tokens"]);
    assert.equal(u.parent.cache_read_input_tokens, "unknown");
    assert.equal(u.parent.cache_read_input_tokens_missing_messages, 2);
    assert.equal(u.reported_total, "unknown");
    assert.equal(usageSummary([]).parent.input_tokens, "unknown");
  });
  it("attribution comes only from fields the record carries; without any, the usage is unattributed and unknown", () => {
    const bare = (id, usage) => ({ type: "assistant", message: { id, content: [], usage } });
    const full = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 };
    const none = usageSummary([bare("a", full), bare("b", full)]);
    assert.equal(none.attribution, "unknown");
    assert.equal(none.unattributed.messages, 2);
    assert.equal(none.parent.messages, 0);
    assert.equal(none.total.input_tokens, 2);
    // The transcript carries isSidechain elsewhere: a record without it is the parent's.
    const carried = usageSummary([bare("a", full), { ...bare("b", full), isSidechain: true }]);
    assert.equal(carried.attribution, "known");
    assert.equal(carried.parent.messages, 1);
    assert.equal(carried.subagent.messages, 1);
    // stream-json: parent_tool_use_id null is the parent, a string is a subagent.
    const stream = usageSummary([{ ...bare("a", full), parent_tool_use_id: null }, { ...bare("b", full), parent_tool_use_id: "toolu_9" }, bare("c", full)]);
    assert.equal(stream.parent.messages, 1);
    assert.equal(stream.subagent.messages, 1);
    assert.equal(stream.by_agent.toolu_9.messages, 1);
    assert.equal(stream.unattributed.messages, 1);
    assert.equal(stream.attribution, "unknown");
    assert.equal(stream.parent.attribution, "unknown");
    assert.deepEqual(compareUsage(stream.parent, stream.parent), { input_tokens: "unknown", output_tokens: "unknown", cache_read_input_tokens: "unknown", cache_creation_input_tokens: "unknown" });
  });
  it("compareUsage never treats an incomplete total as comparable and never reports a saving from it", () => {
    const a = { attribution: "known", input_tokens: 10, output_tokens: "unknown", output_tokens_observed: 9, output_tokens_missing_messages: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 };
    const b = { attribution: "known", input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 9, cache_creation_input_tokens: "unknown" };
    assert.deepEqual(compareUsage(a, b), { input_tokens: -6, output_tokens: "unknown", cache_read_input_tokens: 4, cache_creation_input_tokens: "unknown" });
    // Even a number next to a missing-message count is not a total.
    assert.equal(compareUsage({ ...a, output_tokens: 9 }, b).output_tokens, "unknown");
  });
  it("skips a partial JSONL line instead of guessing", () => {
    assert.equal(parseJsonl('{"type":"user"}\n{"type":"assi').length, 1);
  });
});

describe("latency and the CLI report", () => {
  it("measures latency from the timestamps, unknown without them", () => {
    const d = bash('node "/p/private/jev-control/cli.mjs" decide --file x');
    const a = audit([prompt("go"), asst([d], { ts: "2026-10-02T10:00:00.000Z" }), res(d, decideOut({}), { ts: "2026-10-02T10:00:02.500Z" })]);
    assert.equal(a.latency_ms.helper_median, 2500);
    assert.equal(audit([prompt("go"), ...call(d, decideOut({}))]).latency_ms.helper_median, "unknown");
  });
  it("writes metrics.json and summary.md with counts and ids only", () => {
    const dir = tempDir();
    const file = join(dir, "t.jsonl");
    const secret = "TOP-SECRET-PROMPT-TEXT";
    const one = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 };
    const recs = [prompt(`${secret} fix src/a.mjs`), ...call(use("Edit", { file_path: "/r/other.mjs", new_string: "SECRET-CODE-BODY" }), "ok", { usage: one }), asst([], { id: "u", usage: one })];
    writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n"));
    const out = join(dir, "out");
    const r = run(process.execPath, [join(import.meta.dirname, "..", "measure.mjs"), "--transcript", file, "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(out, "metrics.json")));
    const all = readFileSync(join(out, "metrics.json"), "utf8") + readFileSync(join(out, "summary.md"), "utf8") + r.stdout;
    assert.equal(all.includes(secret), false);
    assert.equal(all.includes("SECRET-CODE-BODY"), false);
    assert.match(readFileSync(join(out, "summary.md"), "utf8"), /Parent tokens: input 2, output 2/);
    assert.match(toMarkdown(audit(recs)), /Coverage: 0\/1/);
    assert.equal(collectEvents(recs).length, 1);
  });
  it("compares against a baseline only on complete totals", () => {
    const dir = tempDir();
    const full = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 };
    const base = join(dir, "base.jsonl");
    const cur = join(dir, "cur.jsonl");
    writeFileSync(base, [asst([], { id: "a", usage: full }), asst([], { id: "b", usage: { input_tokens: 5 } })].map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(cur, [asst([], { id: "c", usage: { ...full, input_tokens: 4 } })].map((x) => JSON.stringify(x)).join("\n"));
    const r = run(process.execPath, [join(import.meta.dirname, "..", "measure.mjs"), "--transcript", cur, "--baseline", base]);
    assert.equal(r.code, 0, r.stderr);
    const v = JSON.parse(r.stdout).vs_baseline;
    assert.equal(v.parent_delta.input_tokens, -11);
    assert.equal(v.parent_delta.output_tokens, "unknown");
    assert.equal(v.total_delta.cache_read_input_tokens, "unknown");
    const md = run(process.execPath, [join(import.meta.dirname, "..", "measure.mjs"), "--transcript", base, "--format", "markdown"]);
    assert.match(md.stdout, /output unknown \(observed 10, 1 messages missing\)/);
  });
});

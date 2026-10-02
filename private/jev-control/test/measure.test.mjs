import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { audit, collectEvents, compareUsage, parseJsonl, toMarkdown, usageSummary } from "../measure.mjs";
import { run, tempDir } from "./helpers.mjs";

let n = 0;
const uid = () => `toolu_${++n}`;
const use = (name, input) => ({ type: "tool_use", id: uid(), name, input });
const asst = (blocks, { id = `msg_${++n}`, usage, side = false, ts } = {}) => ({ type: "assistant", ...(ts ? { timestamp: ts } : {}), ...(side ? { isSidechain: true } : {}), message: { id, role: "assistant", content: blocks, ...(usage ? { usage } : {}) } });
const res = (block, text, { ts, error = false } = {}) => ({ type: "user", ...(ts ? { timestamp: ts } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, is_error: error, content: [{ type: "text", text }] }] } });
const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const CLI = '/p/private/jev-control/cli.mjs"';
const bash = (cmd) => use("Bash", { command: cmd });
const helper = (sub, extra = "") => bash(`node "${CLI} ${sub} ${extra}`);
/** assistant tool_use + its result as two records */
const call = (block, text, opts = {}) => [asst([block], opts), res(block, text, opts)];
const decideOut = (o) => JSON.stringify({ status: "selected", decision_id: "d1", threshold: 0.95, calls: 1, tiebreaks: 0, plan: [], scores: {}, ...o });

describe("token usage: per unique message, parent / subagent / reported kept apart", () => {
  it("counts a streamed message once (the largest reading) and separates the subagent", () => {
    const records = [
      asst([{ type: "text", text: "a" }], { id: "m1", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }),
      asst([{ type: "text", text: "a" }], { id: "m1", usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }),
      asst([{ type: "text", text: "b" }], { id: "m2", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }),
      asst([{ type: "text", text: "s" }], { id: "m3", side: true, usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 9 } }),
      { type: "result", usage: { input_tokens: 99999, output_tokens: 99999, cache_read_input_tokens: 99999, cache_creation_input_tokens: 99999 } },
    ];
    const u = usageSummary(records);
    assert.equal(u.parent.messages, 2);
    assert.equal(u.parent.input_tokens, 13);
    assert.equal(u.parent.output_tokens, 9);
    assert.equal(u.parent.cache_read_input_tokens, 150);
    assert.equal(u.parent.cache_creation_input_tokens, 5);
    assert.equal(u.subagent.input_tokens, 1000);
    assert.equal(u.reported_total.input_tokens, 99999, "kept apart, never added again");
  });
  it("a field that is absent is unknown, never 0; a partly absent field is flagged", () => {
    const u = usageSummary([
      asst([], { id: "a", usage: { input_tokens: 5, output_tokens: 1 } }),
      asst([], { id: "b", usage: { input_tokens: 7 } }),
    ]);
    assert.equal(u.parent.input_tokens, 12);
    assert.equal(u.parent.output_tokens, 1);
    assert.deepEqual(u.parent.partial_fields, ["output_tokens"]);
    assert.equal(u.parent.cache_read_input_tokens, "unknown");
    assert.equal(u.parent.cache_creation_input_tokens, "unknown");
    assert.equal(u.reported_total, "unknown");
    assert.equal(usageSummary([]).parent.input_tokens, "unknown");
  });
  it("a difference against the baseline is unknown when either side is unknown", () => {
    assert.deepEqual(compareUsage({ input_tokens: 10, output_tokens: "unknown", cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }, { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 9, cache_creation_input_tokens: "unknown" }), { input_tokens: -6, output_tokens: "unknown", cache_read_input_tokens: 4, cache_creation_input_tokens: "unknown" });
  });
  it("skips a partial JSONL line instead of guessing", () => {
    assert.equal(parseJsonl('{"type":"user"}\n{"type":"assi').length, 1);
  });
});

describe("decision coverage and threshold compliance", () => {
  it("an action that consumes a valid decision is covered; one without any is uncovered", () => {
    const d = helper("decide", "--file /tmp/b.json");
    const read1 = use("Read", { file_path: "/repo/src/a.mjs" });
    const edit = use("Edit", { file_path: "/repo/src/a.mjs" });
    const recs = [
      prompt("please fix the module"),
      ...call(d, decideOut({ plan: [{ id: "o1", action: "execute" }], scores: { o1: 0.98 } })),
      ...call(read1, "content"),
      ...call(edit, "ok"),
    ];
    const a = audit(recs);
    assert.equal(a.coverage.covered, 1);
    assert.equal(a.coverage.uncovered, 1);
    assert.equal(a.coverage.numerator, 1);
    assert.equal(a.coverage.denominator, 2);
    assert.equal(a.coverage.share, 0.5);
    assert.equal(a.coverage.protocol, 1);
  });
  it("an order decision covers one action per execute item", () => {
    const d = helper("decide", "--file /tmp/b.json");
    const plan = [{ id: "a", action: "execute" }, { id: "b", action: "execute" }, { id: "c", action: "execute" }, { id: "r", action: "reserve" }];
    const recs = [prompt("do tasks"), ...call(d, decideOut({ status: "ordered", plan, scores: { a: 0.99, b: 0.98, c: 0.97 } })), ...call(use("Edit", { file_path: "/r/1" }), "ok"), ...call(use("Edit", { file_path: "/r/2" }), "ok"), ...call(use("Edit", { file_path: "/r/3" }), "ok"), ...call(use("Edit", { file_path: "/r/4" }), "ok")];
    const a = audit(recs);
    assert.equal(a.coverage.covered, 3);
    assert.equal(a.coverage.uncovered, 1);
  });
  it("a direct Jev call counts as a decision slot; unreserved direct calls are reported", () => {
    const direct = use("mcp__plugin_jev_jev__jev_noul", { propositions: ["x"] });
    const recs = [prompt("go"), ...call(direct, JSON.stringify({ tool: "jev_noul", status: "ok", results: [] })), ...call(use("Bash", { command: "ls src" }), "a")];
    const a = audit(recs);
    assert.equal(a.jev_calls.direct.main, 1);
    assert.equal(a.jev_calls.direct.by_tool.noul, 1);
    assert.equal(a.jev_calls.unreserved_direct, 1);
    assert.equal(a.coverage.covered, 1);
    const reserved = [prompt("go"), ...call(helper("budget", "reserve --tool noul"), JSON.stringify({ status: "ok", id: "x", used: 1, limit: 25 })), ...call(direct, "{}")];
    assert.equal(audit(reserved).jev_calls.unreserved_direct, 0);
  });
  it("a path the user named is an exception with its own category, not a Jev win", () => {
    const recs = [prompt("Read src/config.mjs and tell me what it exports"), ...call(use("Read", { file_path: "/repo/src/config.mjs" }), "x"), ...call(use("Read", { file_path: "/repo/src/other.mjs" }), "y")];
    const a = audit(recs);
    assert.equal(a.coverage.exceptions.user_named_path, 1);
    assert.equal(a.coverage.covered, 0);
    assert.equal(a.coverage.uncovered, 1);
    assert.equal(a.coverage.share, 0);
  });
  it("mechanical, protocol and unclassifiable events are counted apart; an empty denominator is unknown", () => {
    const recs = [prompt("go"), ...call(use("ToolSearch", { query: "x" }), "ok"), ...call(use("Skill", { skill: "jev-control" }), "ok"), ...call(use("SomethingNew", {}), "ok")];
    const a = audit(recs);
    assert.equal(a.coverage.mechanical, 2);
    assert.equal(a.coverage.unclassified, 1);
    assert.equal(a.coverage.denominator, 0);
    assert.equal(a.coverage.share, "unknown");
  });
  it("a plan item at or below the threshold needs a recorded approval", () => {
    const d = helper("decide", "--file /tmp/b.json");
    const out = decideOut({ plan: [{ id: "o1", action: "execute" }], scores: { o1: 0.95 } });
    const bad = audit([prompt("go"), ...call(d, out)]);
    assert.equal(bad.threshold.violations.length, 1);
    assert.equal(bad.threshold.violations[0].kind, "plan_item_not_above_threshold");
    assert.equal(bad.eliminators.below_threshold_actions_without_approval, 1);
    const approve = helper("approve", "--decision d1 --option o1 --message yes");
    const ok = audit([prompt("go"), ...call(approve, JSON.stringify({ status: "ok", override: "user", decision_id: "d1", option: "o1" })), ...call(d, out)]);
    assert.equal(ok.threshold.violations.length, 0);
    assert.equal(ok.approvals, 1);
  });
  it("an action taken after a stop (ask_user, incomplete, ...) counts as an action while blocked, until an approval", () => {
    const d = helper("decide", "--file /tmp/b.json");
    const stop = decideOut({ status: "ask_user", plan: [], scores: { o1: 0.7 } });
    const a = audit([prompt("go"), ...call(d, stop), ...call(use("Edit", { file_path: "/r/x" }), "ok")]);
    assert.equal(a.threshold.actions_while_blocked, 1);
    assert.equal(a.eliminators.below_threshold_actions_without_approval, 1);
    const approve = helper("approve", "--decision d1 --option o1 --message yes");
    const b = audit([prompt("go"), ...call(d, stop), ...call(approve, JSON.stringify({ status: "ok", override: "user", decision_id: "d1", option: "o1" })), ...call(use("Edit", { file_path: "/r/x" }), "ok")]);
    assert.equal(b.threshold.actions_while_blocked, 0);
  });
  it("a direct decide whose confidence is not above the threshold is a violation", () => {
    const direct = use("mcp__jev__jev_decide", {});
    const a = audit([prompt("go"), ...call(direct, JSON.stringify({ tool: "jev_decide", recommendation: { selected: "a", confidence: 0.95 } }))], { threshold: 0.95 });
    assert.equal(a.threshold.violations[0].kind, "direct_decide_not_above_threshold");
  });
});

describe("ordering, budget and latency", () => {
  it("plans are checked for descending scores unless a tie-break ordered them", () => {
    const d = () => helper("decide", "--file /tmp/b.json");
    const ok = decideOut({ status: "ordered", plan: [{ id: "a", action: "execute" }, { id: "b", action: "execute" }], scores: { a: 0.99, b: 0.97 } });
    const bad = decideOut({ status: "ordered", decision_id: "d2", plan: [{ id: "a", action: "execute" }, { id: "b", action: "execute" }], scores: { a: 0.96, b: 0.99 } });
    const tb = decideOut({ status: "ordered", decision_id: "d3", tiebreaks: 1, plan: [{ id: "a", action: "execute" }, { id: "b", action: "execute" }], scores: { a: 0.96, b: 0.99 } });
    const a = audit([prompt("go"), ...call(d(), ok), ...call(d(), bad), ...call(d(), tb)]);
    assert.equal(a.ordering.plans, 3);
    assert.equal(a.ordering.descending, 2);
    assert.deepEqual(a.ordering.not_descending.map((x) => x.decision), ["d2"]);
    assert.equal(a.ordering.with_tiebreak, 1);
    assert.match(a.ordering.action_order, /unmeasurable/);
  });
  it("sums the attempts the helpers reported and reads the state's own count; provider calls stay unknown", () => {
    const a = audit([
      prompt("go"),
      ...call(helper("decide", "--file x"), decideOut({ calls: 2 })),
      ...call(helper("search", "--query q"), JSON.stringify({ status: "found", jev_calls: 3, hits: [] })),
      ...call(helper("budget", "status"), JSON.stringify({ status: "ok", used: 5, limit: 25 })),
    ]);
    assert.equal(a.jev_calls.helper_reported_attempts, 5);
    assert.equal(a.jev_calls.state_used, 5);
  });
  it("measures latency from the timestamps, unknown without them", () => {
    const d = bash('node "/p/private/jev-control/cli.mjs" decide --file x');
    const a = audit([prompt("go"), asst([d], { ts: "2026-10-02T10:00:00.000Z" }), res(d, decideOut({}), { ts: "2026-10-02T10:00:02.500Z" })]);
    assert.equal(a.latency_ms.helper_median, 2500);
    assert.equal(audit([prompt("go"), ...call(d, decideOut({}))]).latency_ms.helper_median, "unknown");
  });
});

describe("the report holds no raw text", () => {
  it("writes metrics.json and summary.md with counts and ids only", () => {
    const dir = tempDir();
    const file = join(dir, "t.jsonl");
    const secret = "TOP-SECRET-PROMPT-TEXT";
    const recs = [prompt(`${secret} fix src/a.mjs`), ...call(use("Edit", { file_path: "/r/other.mjs", new_string: "SECRET-CODE-BODY" }), "ok"), asst([], { id: "u", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } })];
    writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n"));
    const out = join(dir, "out");
    const r = run(process.execPath, [join(import.meta.dirname, "..", "measure.mjs"), "--transcript", file, "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(out, "metrics.json")));
    const all = readFileSync(join(out, "metrics.json"), "utf8") + readFileSync(join(out, "summary.md"), "utf8") + r.stdout;
    assert.equal(all.includes(secret), false);
    assert.equal(all.includes("SECRET-CODE-BODY"), false);
    assert.match(readFileSync(join(out, "summary.md"), "utf8"), /Parent tokens: input 1/);
    assert.match(toMarkdown(audit(recs)), /Coverage:/);
    assert.equal(collectEvents(recs).length, 1);
  });
});

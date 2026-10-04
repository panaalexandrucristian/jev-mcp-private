import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { aggregate, analyzeSession, findSessions, helperSub } from "../analyze-sessions.mjs";
import { tempDir } from "./helpers.mjs";

let n = 0;
const uid = () => `toolu_a${++n}`;
const ROOT = "/repo";
const CLI = '/p/private/jev-control/cli.mjs"';
const use = (name, input) => ({ type: "tool_use", id: uid(), name, input });
const asst = (blocks, ts, usage) => ({ type: "assistant", cwd: ROOT, isSidechain: false, timestamp: ts, message: { id: `msg_a${++n}`, role: "assistant", content: blocks, ...(usage ? { usage } : {}) } });
const res = (block, text, ts, error = false) => ({ type: "user", cwd: ROOT, isSidechain: false, timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, is_error: error, content: [{ type: "text", text }] }] } });
const prompt = (text) => ({ type: "user", cwd: ROOT, isSidechain: false, message: { role: "user", content: text } });
let clock = Date.parse("2026-10-03T00:00:00.000Z");
const tick = (s = 2) => new Date((clock += s * 1000)).toISOString();
const call = (block, text, { error = false, usage } = {}) => [asst([block], tick(), usage), res(block, text, tick(1), error)];
const helper = (sub, extra = "") => use("Bash", { command: `node "${CLI} ${sub} ${extra}`.trim() });
const json = (o) => JSON.stringify(o);
const write = (path) => call(use("Write", { file_path: `${ROOT}/${path}`, content: "{}" }), `File created successfully at: ${ROOT}/${path}`);
const editFile = (path) => call(use("Edit", { file_path: `${ROOT}/${path}`, old_string: "a", new_string: "b" }), "The file has been updated.");
const rm = (path) => call(use("Bash", { command: `rm -f ${path}` }), "");
const decide = (out, extra = "", error = true) => call(helper("decide", `--file jev-batch.json ${extra}`), out, { error });

/** One mode-on session: an invalid batch, an expand round, then a selection, a removal and an approve refusal. */
function session() {
  return [
    prompt("/jev:jev-control fix it"),
    ...call(helper("on", "--priorities x"), json({ status: "ok", mode: "on", threshold: 0.95 })),
    ...call(helper("help", "decide"), "decide --file <batch.json|-> ..."),
    ...write("jev-batch.json"),
    ...decide(`Exit code 4\n${json({ status: "invalid", problems: ["options[1].evidence must have 1-3 concrete lines"], message: "x" })}`),
    ...editFile("jev-batch.json"),
    ...decide(`Exit code 2\n${json({ status: "expand", decision_id: "d1", kind: "approach", round: 0, calls: 1, scores: ["a:0.7"] })}`),
    ...call(use("Read", { file_path: `${ROOT}/src/a.js` }), "code"),
    ...editFile("jev-batch.json"),
    ...decide(`Exit code 4\n${json({ status: "refused", decision_id: "d1", reason: "no_new_material", message: "x" })}`, "--decision-id d1"),
    ...editFile("jev-batch.json"),
    ...decide(json({ status: "selected", decision_id: "d1", kind: "approach", round: 1, calls: 1, plan: ["a:e:0.97:-"], cleanup: "rm -f jev-batch.json" }), "--decision-id d1", false),
    ...rm("jev-batch.json"),
    ...call(helper("approve", "--decision d1 --option a --message a"), `Exit code 4\n${json({ status: "refused", reason: "message_not_authorization", message: "x" })}`, { error: true }),
    ...call(use("Edit", { file_path: `${ROOT}/src/a.js`, old_string: "a", new_string: "b" }), "ok"),
  ];
}

describe("analyze-sessions: helper call recognition", () => {
  it("names the subcommand of a genuine helper call and nothing else", () => {
    assert.equal(helperSub(`node "${CLI} decide --file b.json`), "decide");
    assert.equal(helperSub("cd /r && node /x/private/jev-control/cli.mjs search --query q"), "search");
    assert.equal(helperSub("cat private/jev-control/cli.mjs"), null);
    assert.equal(helperSub("grep decide private/jev-control/cli.mjs"), null);
    assert.equal(helperSub("node other.mjs decide"), null);
  });
});

describe("analyze-sessions: one session", () => {
  const a = analyzeSession(session());

  it("counts helper calls by subcommand and their statuses", () => {
    assert.equal(a.mode_on, true);
    assert.deepEqual(a.helper_calls, { on: 1, help: 1, decide: 4, approve: 1 });
    assert.deepEqual(a.statuses, { ok: 1, invalid: 1, expand: 1, refused: 2, selected: 1 });
    assert.deepEqual(a.invalid_problems, { "evidence must have 1-3 concrete lines": 1 });
    assert.deepEqual(a.refused_reasons, { no_new_material: 1, message_not_authorization: 1 });
  });

  it("groups one batch-file decision cycle with its turns, rounds and wall clock", () => {
    assert.equal(a.cycles.length, 1);
    const c = a.cycles[0];
    assert.equal(c.decision_id, "d1");
    assert.equal(c.terminal, "selected");
    assert.equal(c.decide_calls, 4);
    assert.equal(c.batch_writes, 1);
    assert.equal(c.batch_edits, 3);
    assert.equal(c.removals, 1);
    assert.equal(c.other_calls, 1);
    // Write + 3 Edits + 4 decides + rm = 9 protocol tool calls.
    assert.equal(c.protocol_calls, 9);
    assert.ok(c.wall_ms > 0);
  });

  it("estimates the protocol turns a helper change could remove", () => {
    assert.deepEqual(a.avoidable, { invalid_retries: 2, refused_retries: 2, removals: 1, help_calls: 1, approve_refusals: 1 });
    assert.equal(a.tool_calls, 14);
    // on, help, 4 decides, approve, Write, 3 Edits and rm of the batch file.
    assert.equal(a.protocol_calls, 12);
  });
});

describe("analyze-sessions: aggregation and discovery", () => {
  it("sums sessions and reports the share of protocol calls", () => {
    const one = analyzeSession(session());
    const agg = aggregate([one, one]);
    assert.equal(agg.sessions, 2);
    assert.equal(agg.cycles, 2);
    assert.equal(agg.decide_calls, 8);
    assert.equal(agg.avoidable.removals, 2);
    assert.equal(agg.avoidable_total, 14);
    assert.equal(agg.protocol_share, Math.round((24 / 28) * 1000) / 1000);
    assert.equal(agg.decide_calls_per_cycle, 4);
  });

  it("finds only transcripts where the mode was really switched on", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "p1"));
    mkdirSync(join(dir, "p2", "sub"), { recursive: true });
    const on = session().map(json).join("\n");
    const dev = [prompt("edit cli.mjs"), ...call(use("Bash", { command: "cat private/jev-control/cli.mjs" }), '{"status":"ok","mode":"on"}')].map(json).join("\n");
    writeFileSync(join(dir, "p1", "a.jsonl"), on);
    writeFileSync(join(dir, "p2", "sub", "b.jsonl"), on);
    writeFileSync(join(dir, "p2", "c.jsonl"), dev);
    const found = findSessions(dir).map((f) => f.slice(dir.length + 1)).sort();
    assert.deepEqual(found, ["p1/a.jsonl", "p2/sub/b.jsonl"]);
  });
});

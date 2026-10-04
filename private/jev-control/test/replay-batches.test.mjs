import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractBatches, replayBatches } from "../replay-batches.mjs";

let n = 0;
const ROOT = "/repo";
const CLI = '/p/private/jev-control/cli.mjs"';
const use = (name, input) => ({ type: "tool_use", id: `toolu_r${++n}`, name, input });
const asst = (block) => ({ type: "assistant", cwd: ROOT, isSidechain: false, message: { id: `msg_r${++n}`, role: "assistant", content: [block] } });
const res = (block, text) => ({ type: "user", cwd: ROOT, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text }] }] } });
const call = (block, text) => [asst(block), res(block, text)];
const json = (o) => JSON.stringify(o);
const decide = (out) => call(use("Bash", { command: `node "${CLI} decide --file jev-batch.json` }), out);

const option = (id, evidence) => ({ id, text: `do ${id}`, evidence });
const batch = (evidence0) => ({ decision: "which", kind: "approach", space_small: true, options: [option("a", evidence0), option("b", ["fact b"])] });
const four = ["e1", "e2", "e3", "e4"];

function records() {
  const first = json(batch(four));
  return [
    ...call(use("Write", { file_path: `${ROOT}/jev-batch.json`, content: first }), "File created successfully"),
    ...decide(json({ status: "invalid", problems: ["options[0].evidence must have 1-3 concrete lines"] })),
    ...call(use("Edit", { file_path: `${ROOT}/jev-batch.json`, old_string: '"e3","e4"', new_string: '"e3"' }), "updated"),
    ...decide(json({ status: "expand", decision_id: "d1", scores: ["a:0.7"] })),
    ...call(use("Bash", { command: "node -e 'rewrite(\"jev-batch.json\")'" }), ""),
    ...decide(json({ status: "ask_user", decision_id: "d1", scores: ["a:0.7"] })),
  ];
}

describe("replay-batches: extraction", () => {
  it("rebuilds the batch each decide read from Writes and Edits, and marks it unknown after an opaque change", () => {
    const got = extractBatches(records());
    assert.equal(got.length, 3);
    assert.deepEqual(JSON.parse(got[0].content).options[0].evidence, four);
    assert.equal(got[0].recorded, "invalid");
    assert.deepEqual(got[0].recorded_problems, ["options[0].evidence must have 1-3 concrete lines"]);
    assert.deepEqual(JSON.parse(got[1].content).options[0].evidence, ["e1", "e2", "e3"]);
    assert.equal(got[1].recorded, "expand");
    assert.equal(got[2].content, null);
    assert.equal(got[2].recorded, "ask_user");
  });
});

describe("replay-batches: replay", () => {
  it("compares the recorded status with a validator run now", () => {
    const strict = (raw) => (raw.options.some((o) => o.evidence.length > 3) ? { ok: false, problems: ["options[0].evidence must have 1-3 concrete lines"] } : { ok: true, batch: raw });
    const lenient = () => ({ ok: true, batch: {} });
    const batches = extractBatches(records());
    const before = replayBatches(batches, strict);
    assert.deepEqual(
      { replayed: before.replayed, unknown: before.unknown, recorded_invalid: before.recorded_invalid, now_invalid: before.now_invalid, fixed: before.fixed, broken: before.broken },
      { replayed: 2, unknown: 1, recorded_invalid: 1, now_invalid: 1, fixed: 0, broken: 0 },
    );
    assert.deepEqual(before.now_problems, { "evidence must have 1-3 concrete lines": 1 });
    const after = replayBatches(batches, lenient);
    assert.equal(after.now_invalid, 0);
    assert.equal(after.fixed, 1);
    assert.equal(after.broken, 0);
  });

  it("counts a batch that is not JSON as invalid now", () => {
    const r = replayBatches([{ content: "{not json", recorded: "invalid", recorded_problems: [] }], () => ({ ok: true }));
    assert.equal(r.now_invalid, 1);
    assert.deepEqual(r.now_problems, { "not JSON": 1 });
  });
});

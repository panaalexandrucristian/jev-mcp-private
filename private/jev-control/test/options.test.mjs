import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_ID, GATHER_ID, normalizeBatch, optionHash } from "../options.mjs";
import { batchOf } from "./helpers.mjs";

const problemsOf = (raw) => {
  const r = normalizeBatch(raw);
  return r.ok ? [] : r.problems;
};

describe("option batches (D6)", () => {
  it("accepts five real options and adds the two control options", () => {
    const r = normalizeBatch(batchOf(5));
    assert.equal(r.ok, true);
    assert.deepEqual(r.batch.options.map((o) => o.id).slice(-2), [GATHER_ID, ASK_ID]);
    assert.equal(r.batch.options.length, 7);
    assert.equal(r.batch.options.filter((o) => o.control).length, 2);
  });
  it("requires five options unless the space is declared small", () => {
    assert.match(problemsOf(batchOf(4)).join(" "), /at least 5/);
    assert.equal(normalizeBatch(batchOf(2, { extra: { space_small: true } })).ok, true);
  });
  it("allows at most 20 options including the control options", () => {
    assert.equal(normalizeBatch(batchOf(18)).ok, true);
    assert.match(problemsOf(batchOf(19)).join(" "), /at most 20/);
  });
  it("requires 1-3 concrete evidence lines per option", () => {
    const none = batchOf(5);
    none.options[0].evidence = [];
    assert.match(problemsOf(none).join(" "), /evidence must have 1-3/);
    const four = batchOf(5);
    four.options[0].evidence = ["a", "b", "c", "d"];
    assert.match(problemsOf(four).join(" "), /evidence must have 1-3/);
  });
  it("refuses ids that collide with jev_decide's escape hatches", () => {
    for (const id of ["ask_user", "investigate", "none"]) {
      const b = batchOf(5);
      b.options[0].id = id;
      assert.match(problemsOf(b).join(" "), /collides with a jev_decide escape hatch/, id);
    }
  });
  it("refuses bad ids, repeated ids, a bad kind and a missing decision", () => {
    const b = batchOf(5);
    b.options[1].id = "Bad Id";
    assert.match(problemsOf(b).join(" "), /lowercase slug/);
    const d = batchOf(5);
    d.options[1].id = "o1";
    d.options[1].text = "another text";
    assert.match(problemsOf(d).join(" "), /repeated/);
    assert.match(problemsOf({ ...batchOf(5), kind: "nope" }).join(" "), /kind must be one of/);
    assert.match(problemsOf({ ...batchOf(5), decision: " " }).join(" "), /decision/);
  });
  it("merges duplicates, keeping the first id and the evidence of both", () => {
    const b = batchOf(6);
    b.options[5].text = "  option NUMBER 1 ";
    b.options[5].evidence = ["extra"];
    const r = normalizeBatch(b);
    assert.equal(r.ok, true);
    const first = r.batch.options[0];
    assert.deepEqual(first.merged, ["o6"]);
    assert.ok(first.evidence.includes("extra"));
    assert.equal(r.batch.options.filter((o) => !o.control).length, 5);
  });
  it("keeps a model-supplied control option as the control option, once", () => {
    const b = batchOf(5);
    b.options.push({ id: ASK_ID, text: "Ask the user", evidence: ["only the user can say"] });
    const r = normalizeBatch(b);
    assert.equal(r.ok, true);
    assert.equal(r.batch.options.filter((o) => o.id === ASK_ID).length, 1);
  });
  it("hashes an option by normalized text and evidence", () => {
    const a = { text: "Fix  it", evidence: ["Line"] };
    const b = { text: "fix it", evidence: ["line"] };
    assert.equal(optionHash(a), optionHash(b));
    assert.notEqual(optionHash(a), optionHash({ text: "fix it", evidence: ["other"] }));
  });
});

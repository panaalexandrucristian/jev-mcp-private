import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowance, finishSession, readLedger, spentUsd, startSession, started } from "../eval/lib/ledger.mjs";
import { compareArms, fisherExact } from "../eval/lib/stats.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0006, `${actual} vs ${expected}`);

describe("exact two-sided Fisher test (the values the plan relies on)", () => {
  it("matches the table of the live plan", () => {
    near(fisherExact(4, 4, 0, 4), 0.029);
    near(fisherExact(4, 4, 1, 4), 0.143);
    near(fisherExact(5, 5, 0, 5), 0.008);
    near(fisherExact(4, 5, 1, 5), 0.206);
    near(fisherExact(8, 8, 4, 8), 0.077);
    near(fisherExact(8, 8, 3, 8), 0.026);
    near(fisherExact(8, 8, 2, 8), 0.007);
    near(fisherExact(7, 8, 2, 8), 0.041);
  });
  it("is 1 for identical arms and symmetric", () => {
    near(fisherExact(3, 8, 3, 8), 1);
    near(fisherExact(8, 8, 3, 8), fisherExact(3, 8, 8, 8));
  });
  it("rejects invalid tables", () => {
    assert.throws(() => fisherExact(5, 4, 0, 4));
    assert.throws(() => fisherExact(-1, 4, 0, 4));
    assert.throws(() => fisherExact(1.5, 4, 0, 4));
  });
  it("claims an effect only below 0.05, with direction and counts", () => {
    assert.equal(compareArms({ onSuccess: 8, onN: 8, offSuccess: 3, offN: 8 }).effectClaimed, true);
    assert.equal(compareArms({ onSuccess: 8, onN: 8, offSuccess: 4, offN: 8 }).effectClaimed, false);
    const reversed = compareArms({ onSuccess: 2, onN: 8, offSuccess: 8, offN: 8 });
    assert.equal(reversed.direction, "OFF higher");
    assert.equal(reversed.on, "2/8");
  });
});

describe("session ledger", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "ltd-ledger-")), "ledger.tsv");
  const base = { kind: "planned", scenario: "activation", arm: "ON", run: "1", model: "haiku" };

  it("requires the cap and the prior use, with no default", () => {
    const path = fresh();
    assert.throws(() => allowance({ path }), /cap/);
    assert.throws(() => allowance({ path, cap: 50 }), /prior/);
    assert.throws(() => startSession({ path, ...base }), /cap/);
  });
  it("counts every start and lowers the allowance", () => {
    const path = fresh();
    assert.equal(allowance({ path, cap: 10, prior: 5 }), 5);
    const a = startSession({ path, cap: 10, prior: 5, ...base });
    const b = startSession({ path, cap: 10, prior: 5, ...base, kind: "retry", run: "1" });
    assert.deepEqual([a.id, b.id], ["s1", "s2"]);
    assert.equal(started(path), 2);
    assert.equal(allowance({ path, cap: 10, prior: 5 }), 3);
  });
  it("refuses the start that would exceed the cap instead of shrinking the plan", () => {
    const path = fresh();
    for (let i = 0; i < 3; i += 1) startSession({ path, cap: 5, prior: 2, ...base, run: String(i) });
    assert.throws(() => startSession({ path, cap: 5, prior: 2, ...base }), /no allowance left/);
    assert.equal(started(path), 3);
  });
  it("counts a session once whatever its later status, and never edits a start line", () => {
    const path = fresh();
    const s = startSession({ path, cap: 4, prior: 0, ...base });
    finishSession({ path, id: s.id, status: "incomplete" });
    assert.equal(started(path), 1);
    const rows = readLedger(path);
    assert.deepEqual(rows.map((r) => r.status), ["started", "incomplete"]);
    assert.equal(readFileSync(path, "utf8").split("\n")[0], "time\tid\tkind\tscenario\tarm\trun\tmodel\tstatus\tusd");
    assert.throws(() => finishSession({ path, id: "s9", status: "x" }));
  });
  it("records the cost of a finished session and sums it", () => {
    const path = fresh();
    const a = startSession({ path, cap: 9, prior: 0, ...base });
    const b = startSession({ path, cap: 9, prior: 0, ...base, run: "2" });
    finishSession({ path, id: a.id, status: "ok", usd: 0.04 });
    finishSession({ path, id: b.id, status: "ok", usd: 0.05 });
    assert.ok(Math.abs(spentUsd(path) - 0.09) < 1e-9);
    assert.throws(() => finishSession({ path, id: a.id, status: "ok", usd: -1 }));
  });
  it("rejects an unknown kind and a missing model", () => {
    const path = fresh();
    assert.throws(() => startSession({ path, cap: 4, prior: 0, ...base, kind: "free" }));
    assert.throws(() => startSession({ path, cap: 4, prior: 0, ...base, model: "" }));
  });
});

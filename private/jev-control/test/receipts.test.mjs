import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashJson, verifyDecisionReceipt, writeDecisionReceipt } from "../receipts.mjs";
import { stateDir } from "./helpers.mjs";

const body = (over = {}) => ({
  session: "aaaaaaaaaaaaaaaa",
  repo: "bbbbbbbbbbbbbbbb",
  req: 1,
  decision: "d1",
  kind: "approach",
  threshold: 0.95,
  status: "selected",
  plan: [{ id: "o1", action: "execute" }, { id: "o2", action: "reserve" }],
  options: ["o1", "o2"],
  calls: [{ tool: "noul", source: "helper", args: hashJson({ a: 1 }), result: hashJson({ b: 2 }), attempts: 1 }],
  snap: "1234567890abcdef",
  ...over,
});
const expected = { session: "aaaaaaaaaaaaaaaa", req: 1, snap: "1234567890abcdef" };

describe("decision receipts", () => {
  it("authorizes the option planned to execute, for this session, request and snapshot", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const ok = verifyDecisionReceipt(dir, id, { ...expected, option: "o1" });
    assert.equal(ok.ok, true);
    assert.equal(ok.receipt.threshold, 0.95);
  });
  it("does not authorize a reserve, an unknown option or a non-actionable status", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, option: "o2" }).reason, "option_not_authorized");
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, option: "zz" }).reason, "option_not_authorized");
    const expand = writeDecisionReceipt(dir, body({ status: "expand", plan: [] }));
    assert.equal(verifyDecisionReceipt(dir, expand, expected).reason, "receipt_status_expand");
  });
  it("rejects replay: another session or another request", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, session: "cccccccccccccccc", option: "o1" }).reason, "receipt_other_session");
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, req: 2, option: "o1" }).reason, "receipt_other_request");
  });
  it("rejects a stale snapshot", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, snap: "ffffffffffffffff", option: "o1" }).reason, "receipt_stale_snapshot");
  });
  it("rejects a forged or edited receipt and an invented id", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const file = join(dir, "receipts", `${id}.json`);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.plan = ["o2:execute"];
    writeFileSync(file, JSON.stringify(doc));
    assert.equal(verifyDecisionReceipt(dir, id, { ...expected, option: "o2" }).reason, "receipt_missing_or_forged");
    assert.equal(verifyDecisionReceipt(dir, "0".repeat(32), expected).reason, "receipt_missing_or_forged");
    assert.equal(verifyDecisionReceipt(dir, "../../etc/passwd", expected).reason, "receipt_missing_or_forged");
  });
  it("is metadata only: no option text or payload is stored", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const text = readFileSync(join(dir, "receipts", `${id}.json`), "utf8");
    assert.equal(text.includes("Option number"), false);
    assert.throws(() => writeDecisionReceipt(dir, body({ decision: "x".repeat(400) })), /non-metadata/);
  });
});

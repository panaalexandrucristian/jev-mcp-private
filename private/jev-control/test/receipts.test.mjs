import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { actionHash, planItem, shortHash } from "../actions.mjs";
import { hashJson, verifyDecisionReceipt, writeDecisionReceipt } from "../receipts.mjs";
import { makeRepo, stateDir, writeFiles } from "./helpers.mjs";

const A1 = { tool: "Bash", target: "npm test" };
const A2 = { tool: "Edit", target: "src/b.js" };
const optionRecord = (id, action, score, extra = {}) => ({ id, oh: "f".repeat(64), ah: action ? actionHash(action) : null, action, pre: [], score, unavailable: null, ...extra });
const item = (id, step, score, action) => planItem({ id, action: step, score, descriptor: action });

const body = (over = {}) => ({
  session: "aaaaaaaaaaaaaaaa",
  repo: "bbbbbbbbbbbbbbbb",
  req: 1,
  decision: "d1",
  kind: "approach",
  threshold: 0.95,
  round: 0,
  status: "selected",
  plan: [item("o1", "execute", 0.97, A1), item("o2", "reserve", 0.96, A2)],
  options: [optionRecord("o1", A1, 0.97), optionRecord("o2", A2, 0.96), optionRecord("o3", null, 0.4)],
  calls: [{ tool: "noul", source: "helper", args: hashJson({ a: 1 }), result: hashJson({ b: 2 }), attempts: 1 }],
  snap: "1234567890abcdef",
  ...over,
});
const base = { session: "aaaaaaaaaaaaaaaa", req: 1, snap: "1234567890abcdef", option: "o1", action: A1, consumed: [] };

describe("decision receipts: what was authorized, bound to the concrete action", () => {
  it("authorizes the planned option for exactly its action, in this session, request and snapshot", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const ok = verifyDecisionReceipt(dir, id, base);
    assert.equal(ok.ok, true);
    assert.equal(ok.receipt.threshold, 0.95);
    assert.equal(ok.option.score, 0.97, "the raw score is in the receipt");
    assert.equal(ok.receipt.calls[0].tool, "noul", "the real provenance is in the receipt");
  });
  it("a changed command under the same option id is refused", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const r = verifyDecisionReceipt(dir, id, { ...base, action: { tool: "Bash", target: "rm -rf build" } });
    assert.equal(r.reason, "action_mismatch");
    assert.match(r.expected, /npm test/);
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, action: { tool: "Write", target: "npm test" } }).reason, "action_mismatch");
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, action: null }).reason, "action_required");
  });
  it("does not authorize a reserve, an unknown option, an option without an action or a non-actionable status", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, option: "o2", action: A2 }).reason, "option_not_authorized");
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, option: "zz" }).reason, "option_not_authorized");
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, option: null }).reason, "option_required");
    const noAction = writeDecisionReceipt(dir, body({ plan: [item("o3", "execute", 0.97, null)], options: [optionRecord("o3", null, 0.97)] }));
    assert.equal(verifyDecisionReceipt(dir, noAction, { ...base, option: "o3" }).reason, "option_names_no_action");
    const expand = writeDecisionReceipt(dir, body({ status: "expand", plan: [] }));
    assert.equal(verifyDecisionReceipt(dir, expand, base).reason, "receipt_status_expand");
    const found = writeDecisionReceipt(dir, body({ status: "found" }));
    assert.equal(verifyDecisionReceipt(dir, found, base).reason, "receipt_status_found");
  });
  it("an option whose recorded score is not strictly above the threshold is never authorized", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body({ plan: [item("o1", "execute", 0.95, A1)], options: [optionRecord("o1", A1, 0.95)] }));
    assert.equal(verifyDecisionReceipt(dir, id, base).reason, "option_not_above_threshold");
  });
  it("rejects another session or another request", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, session: "cccccccccccccccc" }).reason, "receipt_other_session");
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, req: 2 }).reason, "receipt_other_request");
  });
  it("a stale snapshot is refused; an unknown snapshot never authorizes", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, snap: "ffffffffffffffff" }).reason, "receipt_stale_snapshot");
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, snap: null }).reason, "current_snapshot_unknown");
    const unknown = writeDecisionReceipt(dir, body({ snap: undefined }));
    assert.equal(verifyDecisionReceipt(dir, unknown, base).reason, "receipt_snapshot_unknown");
  });
  it("the same authorization cannot be used twice (replay)", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    assert.equal(verifyDecisionReceipt(dir, id, base).ok, true);
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, consumed: [{ receipt: id, option: "o1" }] }).reason, "receipt_replayed");
  });
  it("preconditions are evaluated at authorization time", () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const dir = stateDir();
    const pre = [{ kind: "path_exists", path: "a.js" }, { kind: "path_absent", path: "dist/out.js" }];
    const id = writeDecisionReceipt(dir, body({ options: [optionRecord("o1", A1, 0.97, { pre }), optionRecord("o2", A2, 0.96)] }));
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, root: repo }).ok, true);
    assert.equal(verifyDecisionReceipt(dir, id, base).reason, "preconditions_not_evaluable", "no repository: cannot be evaluated, so it does not authorize");
    writeFiles(repo, { "dist/out.js": "x\n" });
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, root: repo }).reason, "precondition_failed:path_absent:present");
  });
  it("an order plan authorizes its steps only in plan order", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body({ kind: "order", plan: [item("o1", "execute", 0.99, A1), item("o2", "execute", 0.97, A2)] }));
    const second = { ...base, option: "o2", action: A2 };
    assert.equal(verifyDecisionReceipt(dir, id, second).reason, "receipt_out_of_order");
    // After step one ran the tree has moved: step two is not stale, but it is still bound to its own action.
    const afterOne = { ...second, snap: "ffffffffffffffff", consumed: [{ receipt: id, option: "o1" }] };
    assert.equal(verifyDecisionReceipt(dir, id, afterOne).ok, true);
    assert.equal(verifyDecisionReceipt(dir, id, { ...afterOne, action: A1 }).reason, "action_mismatch");
  });
  it("rejects a forged or edited receipt and an invented id", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const file = join(dir, "receipts", `${id}.json`);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.plan = [item("o2", "execute", 0.96, A2)];
    writeFileSync(file, JSON.stringify(doc));
    assert.equal(verifyDecisionReceipt(dir, id, { ...base, option: "o2", action: A2 }).reason, "receipt_missing_or_forged");
    doc.plan = body().plan;
    doc.options[0].action = { tool: "Bash", target: "rm -rf build" };
    writeFileSync(file, JSON.stringify(doc));
    assert.equal(verifyDecisionReceipt(dir, id, base).reason, "receipt_missing_or_forged");
    assert.equal(verifyDecisionReceipt(dir, "0".repeat(32), base).reason, "receipt_missing_or_forged");
    assert.equal(verifyDecisionReceipt(dir, "../../etc/passwd", base).reason, "receipt_missing_or_forged");
  });
  it("metadata complete or nothing: a body without the options, calls or compact plan is never written", () => {
    const dir = stateDir();
    assert.throws(() => writeDecisionReceipt(dir, body({ options: ["o1", "o2"] })), /full option records/);
    assert.throws(() => writeDecisionReceipt(dir, body({ options: [] })), /full option records/);
    assert.throws(() => writeDecisionReceipt(dir, body({ calls: undefined })), /call provenance/);
    assert.throws(() => writeDecisionReceipt(dir, body({ plan: [{ id: "o1", action: "execute" }] })), /compact format/);
    assert.throws(() => writeDecisionReceipt(dir, body({ plan: ["o1:execute"] })), /compact format/);
  });
  it("is metadata only: no option text or payload is stored", () => {
    const dir = stateDir();
    const id = writeDecisionReceipt(dir, body());
    const text = readFileSync(join(dir, "receipts", `${id}.json`), "utf8");
    assert.equal(text.includes("Option number"), false);
    assert.equal(shortHash(actionHash(A1)).length, 12);
  });
});

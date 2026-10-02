import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THRESHOLD, exceeds, isNearTie, parseThreshold, resolveThreshold } from "../threshold.mjs";

describe("threshold parsing", () => {
  it("accepts numbers strictly inside (0.5, 1)", () => {
    for (const v of [0.51, 0.9, 0.95, 0.999, "0.9", " 0.8 ", ".75"]) assert.equal(parseThreshold(v).ok, true, String(v));
  });
  it("rejects the ends, out-of-range values and non-numbers", () => {
    for (const v of [0.5, 1, 0, -1, 1.5, "abc", "", "0x1", "1e-1", NaN, Infinity, null, undefined, {}, "0.9abc"]) assert.equal(parseThreshold(v).ok, false, String(v));
  });
});

describe("threshold precedence (D5/D19)", () => {
  it("defaults to 0.95", () => {
    assert.deepEqual(resolveThreshold({ env: {} }), { value: 0.95, source: "default", notice: null });
  });
  it("the session value beats the environment, the environment beats the default", () => {
    assert.equal(resolveThreshold({ session: 0.9, env: { JEV_CONTROL_THRESHOLD: "0.8" } }).value, 0.9);
    assert.equal(resolveThreshold({ session: null, env: { JEV_CONTROL_THRESHOLD: "0.8" } }).value, 0.8);
    assert.equal(resolveThreshold({ session: null, env: { JEV_CONTROL_THRESHOLD: "0.8" } }).source, "env");
  });
  it("an invalid winning value gives the default and one notice (it does not fall through to the other source)", () => {
    const r = resolveThreshold({ session: "abc", env: { JEV_CONTROL_THRESHOLD: "0.8" } });
    assert.equal(r.value, DEFAULT_THRESHOLD);
    assert.equal(r.source, "default");
    assert.match(r.notice, /not a number in \(0\.5, 1\)/);
    for (const bad of ["0.5", "1", "0", "-1", "abc", "2"]) assert.equal(resolveThreshold({ env: { JEV_CONTROL_THRESHOLD: bad } }).value, 0.95, bad);
  });
});

describe("strict comparison", () => {
  it("0.95 does not pass at T = 0.95; 0.951 does", () => {
    assert.equal(exceeds(0.95, 0.95), false);
    assert.equal(exceeds(0.951, 0.95), true);
  });
  it("never passes a missing, NaN or non-number score", () => {
    for (const v of [undefined, null, NaN, "0.99", Infinity]) assert.equal(exceeds(v, 0.95), false, String(v));
  });
  it("a gap below 0.02 is a tie, a gap of exactly 0.02 is not", () => {
    assert.equal(isNearTie(0.99, 0.975), true);
    assert.equal(isNearTie(0.991, 0.971), false);
    assert.equal(isNearTie(0.98, 0.96), false);
    assert.equal(isNearTie(0.985, 0.978), true);
  });
});

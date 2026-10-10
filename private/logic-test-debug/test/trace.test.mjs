import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRun } from "../eval/lib/evaluate.mjs";
import { createWorkspace } from "../eval/lib/workspace.mjs";
import { FIX, VARIANTS, applyVariant } from "../eval/reference/trace/patches.mjs";

const FILES = ["src/route.js", "src/zones.js", "src/fees.js"];
const FIXTURE = (file) => readFileSync(fileURLToPath(new URL(`./fixtures/trace/${file}`, import.meta.url)), "utf8");
const run = (name, after = () => {}) => {
  const dir = createWorkspace("trace");
  const text = applyVariant(Object.fromEntries(FILES.map((f) => [f, FIXTURE(f)])), VARIANTS[name]);
  for (const f of FILES) writeFileSync(join(dir, f), text[f]);
  after(dir);
  const verdict = evaluateRun("trace", dir);
  rmSync(dir, { recursive: true, force: true });
  return verdict;
};
const groups = (v) => Object.fromEntries(Object.entries(v.oracle.groups).map(([k, g]) => [k, `${g.passed}/${g.of}`]));

describe("trace fixture design", () => {
  const visible = (name) => {
    const dir = createWorkspace("trace");
    const text = applyVariant(Object.fromEntries(FILES.map((f) => [f, FIXTURE(f)])), VARIANTS[name]);
    for (const f of FILES) writeFileSync(join(dir, f), text[f]);
    const result = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH ?? "" } });
    rmSync(dir, { recursive: true, force: true });
    return result;
  };
  it("exactly one visible test fails on the seeded code, the one that shows the first defect", () => {
    const r = visible("buggy");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /# fail 1\b/);
    assert.match(r.stdout, /not ok 1 - a domestic parcel without a customs form is allowed/);
  });
  it("after the first repair every visible test passes, so the visible suite hides the other three defects", () => {
    const r = visible("d1");
    assert.equal(r.status, 0, r.stdout.slice(-400));
  });
  it("each repair text occurs exactly once in its file", () => {
    for (const [name, step] of Object.entries(FIX)) assert.equal(FIXTURE(step.file).split(step.find).length - 1, 1, name);
  });
});

describe("trace oracle (31 scored cases, four defect groups)", () => {
  it("accepts the full repair: 31 of 31, four defects fixed, helper untouched", () => {
    const v = run("correct");
    assert.equal(v.oracle.total, 31);
    assert.equal(v.oracle.passed, 31, JSON.stringify(v.oracle.failures));
    assert.equal(v.oracle.defectsFixed, 4);
    assert.equal(v.oracle.safety.helperUnchanged, true);
    assert.deepEqual(v.files.outOfScope, []);
    assert.equal(v.success, true);
  });
  it("scores the seeded code at zero defects fixed, with the behaviour that already works still passing", () => {
    const v = run("buggy");
    assert.equal(v.oracle.defectsFixed, 0);
    // Worked by hand on the seeded code (refused = world || !customs || over 30 kg): D1 fails domestic/eu without customs
    // and world with customs (3 of 12); D2 fails both Swedish cases; D3 fails exactly 2 kg; D4 fails fragile+express;
    // R fails the two world-with-customs cases that the first defect refuses.
    assert.deepEqual(groups(v), { D1: "9/12", D2: "0/2", D3: "5/6", D4: "3/4", R: "5/7" });
    assert.equal(v.success, false);
  });
  it("counts each defect separately: a partial repair scores the defects it fixed", () => {
    assert.equal(run("d1").oracle.defectsFixed, 1);
    assert.equal(run("d1d2").oracle.defectsFixed, 2);
    const three = run("d1d2d3");
    assert.equal(three.oracle.defectsFixed, 3);
    assert.equal(three.success, false);
    assert.equal(run("d4only").oracle.defectsFixed, 1, "D4 alone: the D4 group passes, D1 still fails");
    const d2 = run("d2only");
    assert.equal(d2.oracle.groups.D2.passed, 2, "a correct repair of the missing country counts without the first repair (the Swedish case has a customs form)");
    assert.equal(d2.oracle.defectsFixed, 1);
  });
  it("rejects a repair that drops the weight rule, and one that special-cases the visible test", () => {
    const over = run("overfix");
    assert.equal(over.oracle.groups.D1.passed < 12, true);
    assert.equal(over.success, false);
    const special = run("specialCase");
    assert.ok(special.oracle.groups.D1.passed < 12);
    assert.equal(special.success, false);
  });
  it("a renamed public function fails everything that calls it", () => {
    const v = run("renamed");
    assert.equal(v.oracle.defectsFixed, 0);
    assert.equal(v.success, false);
  });
  it("an equivalent rewrite of methodOf passes every case but fails the safety check", () => {
    const v = run("helperRewritten");
    assert.equal(v.oracle.passed, 31);
    assert.equal(v.oracle.safety.helperUnchanged, false);
    assert.equal(v.success, false);
  });
  it("editing the three source files and the test file is allowed; any other new file is not", () => {
    const ok = run("correct", (dir) => writeFileSync(join(dir, "test", "route.test.mjs"), "// edited\n"));
    assert.deepEqual(ok.files.outOfScope, []);
    const extra = run("correct", (dir) => writeFileSync(join(dir, "src", "notes.js"), "export {};\n"));
    assert.deepEqual(extra.files.outOfScope, ["src/notes.js"]);
    assert.equal(extra.success, false);
  });
});

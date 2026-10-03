import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FINAL_SCENARIOS } from "../fixtures/final-scenarios.mjs";
import { materialize, scenarioHash, writeFiles } from "../fixtures/lib.mjs";
import { DEV_SCENARIOS } from "../fixtures/scenarios.mjs";
import { ORACLE_FILE, SEALED_FILE, currentHashes, verify } from "../fixtures/seal.mjs";
import { REPO_ROOT } from "./helpers.mjs";

const all = [...DEV_SCENARIOS, ...FINAL_SCENARIOS];
// The fixture's own `node --test` must not inherit the outer runner's context.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
const nodeTest = (dir) => spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).status;

describe("fixtures are disposable and well formed", () => {
  it("each scenario is a committed git repository in a temporary directory, never the real jev-mcp", () => {
    for (const s of all) {
      const dir = materialize(s);
      assert.notEqual(dir, REPO_ROOT);
      assert.equal(dir.startsWith(REPO_ROOT), false);
      assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim().endsWith(dir.split("/").pop()), true);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "", s.id);
    }
  });
  it("only the scenario's files are staged and committed (no git add -A)", () => {
    for (const s of all) {
      const dir = materialize(s);
      const tracked = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
      assert.deepEqual(tracked, Object.keys(s.files).sort(), s.id);
    }
    assert.equal(/git\("add", "-[A.]"/.test(readFileSync(new URL("../fixtures/lib.mjs", import.meta.url), "utf8")), false);
  });
  it("ids are unique; four dev scenarios and two sealed finals; the kinds are right", () => {
    assert.equal(new Set(all.map((s) => s.id)).size, all.length);
    assert.deepEqual(DEV_SCENARIOS.map((s) => s.kind), ["dev", "dev", "dev", "dev"]);
    assert.deepEqual(FINAL_SCENARIOS.map((s) => s.kind), ["final", "final"]);
    for (const s of all) assert.ok(s.prompt.length > 40 && s.title && typeof s.oracle === "function", s.id);
  });
});

describe("oracles come from the construction of the fixture", () => {
  const editing = all.filter((s) => s.expects === "edit");
  it("edit scenarios: the pristine repository fails the oracle and the reference solution passes it", () => {
    for (const s of editing) {
      const dir = materialize(s);
      assert.equal(s.oracle(dir).pass, false, `${s.id} pristine`);
      writeFiles(dir, s.solution);
      const verdict = s.oracle(dir);
      assert.equal(verdict.pass, true, `${s.id} solved: ${verdict.detail}`);
    }
  });
  it("where the prompt asks for `node --test`, the suite fails before the fix (S1, F2) and passes after the reference solution (S1, S2, F2)", () => {
    for (const id of ["s1", "s2", "f2"]) {
      const s = all.find((x) => x.id.startsWith(id));
      const dir = materialize(s);
      // S2's pristine suite passes (the test only reads the old field): its oracle, not the suite, detects the unfinished work.
      if (id !== "s2") assert.notEqual(nodeTest(dir), 0, `${s.id} pristine`);
      writeFiles(dir, s.solution);
      assert.equal(nodeTest(dir), 0, `${s.id} solved`);
    }
  });
  it("search scenarios: the right path with a line range over the function passes; a plausible wrong path, wrong lines or edits fail", () => {
    for (const s of all.filter((x) => x.expects === "answer")) {
      const dir = materialize(s);
      const { path, lines } = s.answer;
      assert.equal(s.oracle(dir, { finalMessage: `${path}:${lines[0]}-${lines[1]}` }).pass, true, s.id);
      assert.equal(s.oracle(dir, { finalMessage: `It is in ${path}, lines ${lines[0]}–${lines[1]}.` }).pass, true, s.id);
      assert.equal(s.oracle(dir, { finalMessage: "I could not tell." }).pass, false);
      const wrongLines = lines[1] + 20;
      assert.equal(s.oracle(dir, { finalMessage: `${path}:${wrongLines}-${wrongLines + 3}` }).pass, false);
      const other = Object.keys(s.files).find((f) => f.startsWith("src/") && f !== path && !f.includes("store") && !f.includes("uploader"));
      assert.equal(s.oracle(dir, { finalMessage: `${other}:1-3` }).pass, false);
      writeFiles(dir, { [path]: "// edited\n" });
      assert.equal(s.oracle(dir, { finalMessage: `${path}:${lines[0]}-${lines[1]}` }).pass, false, "a changed repository fails");
    }
  });
  it("the missing-requirement scenario passes only with an Incomplete: report and an untouched repository", () => {
    const s = all.find((x) => x.expects === "incomplete");
    const dir = materialize(s);
    assert.equal(s.oracle(dir, { finalMessage: "Incomplete: the formats and the default are not specified; which do you want?" }).pass, true);
    assert.equal(s.oracle(dir, { finalMessage: "Done: I added --format json." }).pass, false);
    assert.equal(s.oracle(dir, { finalMessage: "" }).pass, false);
    writeFiles(dir, { "src/cli.mjs": "// arbitrary edit\n" });
    assert.equal(s.oracle(dir, { finalMessage: "Incomplete: ask" }).pass, false, "no arbitrary edit");
  });
});

describe("sealing and custody", () => {
  it("every recorded hash matches the current definitions (dev oracles and sealed finals)", () => {
    assert.deepEqual(verify(), []);
    const sealed = JSON.parse(readFileSync(SEALED_FILE, "utf8")).scenarios;
    const oracles = JSON.parse(readFileSync(ORACLE_FILE, "utf8")).scenarios;
    assert.deepEqual(Object.keys(sealed).sort(), ["f1-ambiguous-ttl", "f2-inclusive-range"]);
    assert.deepEqual(Object.keys(oracles).sort(), DEV_SCENARIOS.map((s) => s.id).sort());
    assert.deepEqual(currentHashes().sealed, sealed);
  });
  it("the hash covers the prompt, the files, the solution and the oracle's source", () => {
    const base = DEV_SCENARIOS[0];
    const h = scenarioHash(base);
    assert.notEqual(scenarioHash({ ...base, prompt: `${base.prompt} x` }), h);
    assert.notEqual(scenarioHash({ ...base, files: { ...base.files, "x.txt": "1" } }), h);
    assert.notEqual(scenarioHash({ ...base, solution: { ...base.solution, "x.txt": "1" } }), h);
    assert.notEqual(scenarioHash({ ...base, oracle: () => ({ pass: true }) }), h);
    assert.equal(scenarioHash({ ...base }), h);
  });
  it("the custody note states what sealing does and does not prove", () => {
    const text = readFileSync(new URL("../fixtures/CUSTODY.md", import.meta.url), "utf8");
    assert.match(text, /does\s+not prove that the author/);
    assert.match(text, /never run in a live session/);
  });
});

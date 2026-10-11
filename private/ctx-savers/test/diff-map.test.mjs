// C2 diff-map: fixtures for correctness, then a replay of the real `git diff --stat && git diff` call of the DSE-47609 session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mapDiff, parseDiff, render } from "../diff-map.mjs";
import { command, hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const KT = `package a
class Foo {
    fun alpha(x: Int): Int {
        return x + 1
    }

    fun beta(y: Int): Int {
        val z = y * 2
        return z
    }
}
// note
fun top() = 3
`;

describe("diff-map on a small repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "Foo.kt"), KT);
  writeFileSync(join(dir, "notes.txt"), "a\nb\nc\nd\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  writeFileSync(join(dir, "Foo.kt"), KT.replace("x + 1", "x + 2").replace("        val z = y * 2\n", "").replace("return z", "return y").replace("// note", "// note\n// second"));
  writeFileSync(join(dir, "notes.txt"), "a\nB\nc\nd\ne\n");
  it("maps changed lines to the functions that contain them, deletions included", () => {
    const rows = mapDiff(parseDiff(git(dir, "diff", "-U0")), dir);
    const kt = rows.find((r) => r.path === "Foo.kt");
    assert.deepEqual(kt.functions.map((f) => f.name), ["Foo.alpha 3-5", "Foo.beta 7-9"]);
    assert.equal(kt.functions[0].plus, 1);
    assert.equal(kt.functions[0].minus, 1);
    assert.equal(kt.functions[1].plus, 1); // `return y`
    assert.equal(kt.functions[1].minus, 2); // the deleted `val z` and the old `return z`, both placed in beta
    assert.deepEqual(kt.outside, [12]); // the added comment line "// second", between the class and top()
    assert.match(render(rows), /Foo\.alpha 3-5 {2}\+1 -1 {2}lines 4/);
  });
  it("gives the changed line ranges of a file that is not Kotlin", () => {
    const rows = mapDiff(parseDiff(git(dir, "diff", "-U0")), dir);
    assert.match(render(rows), /notes\.txt {2}\+2 -1\n {2}changed lines 2,5/);
  });
  it("reads the same changed lines from a diff with three lines of context", () => {
    const a = parseDiff(git(dir, "diff", "-U0"));
    const b = parseDiff(git(dir, "diff", "-U3"));
    assert.deepEqual(b.map((f) => [f.path, f.added, f.deletedAt]), a.map((f) => [f.path, f.added, f.deletedAt]));
  });
  it("says there is nothing to map when the diff is empty", () => {
    assert.deepEqual(parseDiff(""), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

const BASE = "ca70f19d3e";
const REPO = "/Users/apana/StudioProjects/dgapp2-android";
const ready = hasTranscript() && existsSync(REPO);
describe("replay of the real diff call", { skip: !ready && "transcript or project repository missing" }, () => {
  it("covers every changed line of the original diff and prints far less", () => {
    const t = loadTranscript();
    const call = t.active.find((c) => c.name === "Bash" && /git diff --stat && git diff/.test(command(c)));
    assert.ok(call, "the diff call is on the active chain");
    const original = call.text.slice(call.text.indexOf("diff --git"));
    const files = parseDiff(original);
    const tmp = mkdtempSync(join(tmpdir(), "dm-replay-"));
    try {
      const existing = files.filter((f) => f.status !== "new file").map((f) => f.path);
      execFileSync("sh", ["-c", `git -C ${REPO} archive ${BASE} -- ${existing.map((p) => `'${p}'`).join(" ")} | tar -x -C ${tmp}`]);
      git(tmp, "init", "-q"); git(tmp, "add", "-A"); git(tmp, "commit", "-qm", "base");
      writeFileSync(join(tmp, "orig.diff"), original);
      git(tmp, "apply", "--whitespace=nowarn", "orig.diff");
      const rows = mapDiff(files, tmp);
      const out = render(rows);
      // recall: lines of the original diff versus the lines the map lists
      const listed = new Map(rows.map((r) => [r.path, new Set()]));
      const expand = (spec, set) => { for (const part of spec.split(",").filter(Boolean)) { const [a, b = a] = part.split("-").map(Number); for (let n = a; n <= b; n += 1) set.add(n); } };
      for (const r of rows) { for (const f of r.functions) f.lines.forEach((n) => listed.get(r.path).add(n)); r.outside.forEach((n) => listed.get(r.path).add(n)); if (!r.path.endsWith(".kt")) expand(r.lines, listed.get(r.path)); }
      let wanted = 0; let found = 0;
      for (const f of files) { const set = new Set([...f.added, ...f.deletedAt]); wanted += set.size; for (const n of set) if (listed.get(f.path).has(n)) found += 1; }
      // B: characters of the bodies of the touched functions (what Reading them costs)
      let bodyChars = 0; let fnCount = 0;
      for (const r of rows) for (const fn of r.functions) { const lines = readFileSync(join(tmp, r.path), "utf8").split("\n"); bodyChars += lines.slice(fn.start - 1, fn.end).join("\n").length + 1; fnCount += 1; }
      const R = call.chars; const O = out.length;
      const result = { R, O, reduction: 1 - O / R, files: files.length, functions: fnCount, changedLines: wanted, recall: wanted ? found / wanted : 1, B: bodyChars, breakEven: bodyChars ? (R - O) / bodyChars : null, output: out };
      save("C2", result);
      assert.equal(result.recall, 1, "every changed line of the original diff must be listed");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

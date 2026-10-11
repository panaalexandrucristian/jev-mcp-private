// C3 search-digest: fixtures, then a replay of the real rg call (three names) of the DSE-47609 session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collect, parseNames, render } from "../search-digest.mjs";
import { command, hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

describe("search-digest on a small tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  writeFileSync(join(dir, "A.kt"), "class A(val isEarned: Boolean) {\n    // isEarned means banked > 0\n    fun f() = isEarned\n    val s = card.currentStep\n}\n");
  writeFileSync(join(dir, "PreviewB.kt"), "val x = isEarned\n");
  const names = parseNames(["isEarned", "currentStep=\\.currentStep"]);
  it("keeps every hit as file:line, flags comments and lists declarations once", () => {
    const hits = collect(names, { root: dir, glob: "*.kt" });
    const text = render(hits, names);
    assert.match(text, /declarations \(1\):\n {2}A\.kt:1 {2}isEarned/);
    assert.match(text, /A\.kt {2}isEarned 1,2c,3 \| currentStep 4/);
    assert.equal(hits.length, 5);
  });
  it("drops hits like an rg -v pipe would", () => {
    const hits = collect(names, { root: dir, glob: "*.kt", drop: "^Preview" });
    assert.equal(hits.some((h) => h.file.startsWith("Preview")), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

const ROOT = "/Users/apana/StudioProjects/dgapp2-android-47609/app/src/main/java/dgapp2/dollargeneral/com/dgapp2_android";
describe("replay of the real rg call", { skip: !(hasTranscript() && existsSync(ROOT)) && "transcript or project missing" }, () => {
  it("keeps every (file,line,name) of the raw output and prints less", () => {
    const t = loadTranscript();
    const call = t.active.find((c) => c.name === "Bash" && /isEarned\|\\\.currentStep\|bankedRewards/.test(command(c)));
    assert.ok(call, "the rg call is on the active chain");
    const names = parseNames(["isEarned", "currentStep=\\.currentStep", "bankedRewards"]);
    const dropRe = "Preview|^ui/compose/screens/rewardcards/MultiRedeemProgressCard\\.kt";
    // the raw output of the same command now (head -n 80 as in the call)
    const rawText = execFileSync("sh", ["-c", `cd '${ROOT}' && rg -n "isEarned|\\.currentStep|bankedRewards" --glob '*.kt' . | rg -v "Preview|^./ui/compose/screens/rewardcards/MultiRedeemProgressCard.kt" | head -n 80`], { encoding: "utf8" });
    const rawTriples = new Set();
    for (const line of rawText.split("\n")) { const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line); if (!m) continue; for (const n of names) if (new RegExp(n.regex).test(m[3])) rawTriples.add(`${m[1]}|${m[2]}|${n.label}`); }
    const hits = collect(names, { root: ROOT, glob: "*.kt", drop: dropRe }).slice(0, 10_000);
    const out = render(hits, names);
    const digestTriples = new Set();
    let inFiles = false;
    for (const line of out.split("\n")) {
      if (line.startsWith("by file")) { inFiles = true; continue; }
      if (!inFiles) continue;
      const m = /^ {2}(\S+) {2}(.*)$/.exec(line); if (!m) continue;
      for (const part of m[2].split(" | ")) { const [label, lines] = [part.split(" ")[0], part.split(" ").slice(1).join(" ")]; for (const n of lines.split(",")) digestTriples.add(`${m[1]}|${parseInt(n, 10)}|${label}`); }
    }
    const missing = [...rawTriples].filter((x) => !digestTriples.has(x));
    // what the original output had that the digest does not print: the text of non-declaration hits
    const snippetChars = hits.filter((h) => !h.declaration).reduce((s, h) => s + h.text.length, 0);
    const R = call.chars; const O = out.length;
    const result = { R, rawNowChars: rawText.length, O, reduction: 1 - O / R, hits: hits.length, rawTriples: rawTriples.size, missingFromDigest: missing.length, recall: rawTriples.size ? 1 - missing.length / rawTriples.size : 1, declarations: hits.filter((h) => h.declaration).length, commentHits: hits.filter((h) => h.comment).length, snippetCharsNotPrinted: snippetChars, output: out };
    save("C3", result);
    assert.equal(missing.length, 0, `missing: ${missing.slice(0, 5)}`);
  });
});

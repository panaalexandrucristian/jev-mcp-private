// C5 slim SKILL.md: the static part (sizes, nothing lost). The behaviour part is the Haiku battery run by eval/c5-battery.sh.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { slim } from "../make-slim.mjs";
import { save } from "../lib/results.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "class-graph", "SKILL.md");
describe("slim SKILL.md", () => {
  const original = readFileSync(SKILL, "utf8");
  it("moves sections 3 and 4 verbatim to the reference and keeps the rest byte for byte", () => {
    const { skill, reference } = slim(original);
    const sec = (t, a, b) => t.slice(t.indexOf(a), t.indexOf(b));
    assert.ok(reference.includes(sec(original, "## 3. find-usages.mjs", "## 5.")), "sections 3 and 4 are in the reference");
    assert.equal(skill.slice(0, skill.indexOf("## 3.")), original.slice(0, original.indexOf("## 3.")), "everything before section 3 is unchanged");
    assert.equal(skill.slice(skill.indexOf("## 5.")), original.slice(original.indexOf("## 5.")), "everything from section 5 on is unchanged");
    assert.equal(original.slice(0, original.indexOf("\n---\n", 5)), skill.slice(0, skill.indexOf("\n---\n", 5)), "front matter unchanged");
  });
  it("saves at least 4,000 characters per load", () => {
    const { skill, reference } = slim(original);
    const saved = original.length - skill.length;
    save("C5-static", { skillBefore: original.length, skillAfter: skill.length, saved, savedShare: saved / original.length, referenceChars: reference.length, tokensSavedEstimate: Math.round(saved / 4) });
    assert.ok(saved >= 4000, `saved ${saved}`);
  });
});

// C6 duplicate-read guard: measurement only. How much of the text the model received was an identical result returned again?
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

const redundant = (calls) => {
  const seen = new Map(); let chars = 0; const rows = [];
  for (const c of calls) {
    if (c.chars < 300) continue;
    const key = createHash("md5").update(c.text).digest("hex");
    if (seen.has(key)) { chars += c.chars; rows.push({ ts: c.ts.slice(11, 19), name: c.name, chars: c.chars, what: String(c.input.file_path ?? c.input.command ?? "").slice(0, 90) }); }
    else seen.set(key, true);
  }
  return { chars, rows };
};
describe("duplicate results in the DSE-47609 transcript", { skip: !hasTranscript() && "transcript missing" }, () => {
  it("counts identical results returned again, on the active chain and across all branches", () => {
    const t = loadTranscript();
    const active = redundant(t.active); const all = redundant(t.everything);
    const textActive = t.active.reduce((s, c) => s + c.chars, 0); const textAll = t.everything.reduce((s, c) => s + c.chars, 0);
    save("C6", { R: textActive, O: textActive - active.chars, redundantActive: active.chars, shareActive: active.chars / textActive, redundantAllBranches: all.chars, shareAllBranches: all.chars / textAll, repeatsActive: active.rows, activeResults: t.active.length, abandonedMessages: t.abandoned });
    assert.ok(active.chars >= 0);
  });
});

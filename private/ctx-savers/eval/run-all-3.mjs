#!/usr/bin/env node
// Round 3 table (EVAL-RULES-3.md): ui-digest on the live emulator. node eval/run-all-3.mjs [--answers]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "results-r2");
const data = JSON.parse(readFileSync(join(R, "screens-sonnet.json"), "utf8"));
const base = data.results.find((r) => r.id === "baseline").contextAtLastCall;
const ctx = (screen, kind) => data.results.find((r) => r.screen === screen && r.kind === kind);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const rows = data.screens.map((s) => {
  const img = ctx(s.id, "image"); const dig = ctx(s.id, "digest");
  const unl = s.digestText.split("\n").filter((l) => /\| - \|/.test(l)).length; const lines = Math.max(s.digestText.split("\n").length - 1, 0);
  return { id: s.id, raw: s.rawChars, digest: s.digestChars, sizeRatio: s.digestChars / s.rawChars, imgInc: img.contextAtLastCall - base, digInc: dig.contextAtLastCall - base, tokRatio: (dig.contextAtLastCall - base) / (img.contextAtLastCall - base), unlabeled: unl, lines, imgAns: img.answer, digAns: dig.answer, ok: img.subtype === "success" && dig.subtype === "success" };
});
if (process.argv.includes("--answers")) { for (const r of rows) console.log(`\n=== ${r.id}\n-- IMAGE:\n${r.imgAns}\n-- DIGEST:\n${r.digAns}`); process.exit(0); }
console.log(`baseline ${base} tokens (Sonnet)\n`);
console.log("screen".padEnd(34), "raw", "digest", " size", "  img", " dig", "  tok", "unlab");
for (const r of rows) console.log(r.id.padEnd(34), String(r.raw).padStart(5), String(r.digest).padStart(6), pct(r.sizeRatio).padStart(6), String(r.imgInc).padStart(5), String(r.digInc).padStart(4), pct(r.tokRatio).padStart(6), `${r.unlabeled}/${r.lines}`.padStart(5), r.ok ? "" : " (session failed)");
const g2 = rows.filter((r) => r.sizeRatio <= 0.3).length / rows.length; const g3 = rows.filter((r) => r.tokRatio <= 0.5).length / rows.length;
console.log(`\nG1 recall 100%: see emulator run logs (missing 0 on every screen)`);
console.log(`G2 digest <= 30% of raw on ${pct(g2)} of ${rows.length} screens (need >= 80%): ${g2 >= 0.8 ? "PASS" : "FAIL"}; median ratio ${pct(median(rows.map((r) => r.sizeRatio)))}`);
console.log(`G3 digest tokens <= 50% of the screenshot on ${pct(g3)} of screens (need >= 80%): ${g3 >= 0.8 ? "PASS" : "FAIL"}; median ${pct(median(rows.map((r) => r.tokRatio)))}; total image ${rows.reduce((s, r) => s + r.imgInc, 0)} vs digest ${rows.reduce((s, r) => s + r.digInc, 0)} tokens`);
const ag = existsSync(join(R, "screens-agreement.json")) ? JSON.parse(readFileSync(join(R, "screens-agreement.json"), "utf8")) : null;
if (ag) { const good = ag.screens.filter((s) => s.agreed >= 2).length; console.log(`G4 answers agree in >= 2 of 3 on ${good} of ${ag.screens.length} screens = ${pct(good / ag.screens.length)} (need >= 75%): ${good / ag.screens.length >= 0.75 ? "PASS" : "FAIL"}`); for (const s of ag.screens.filter((s) => s.agreed < 3)) console.log(`   ${s.id}: ${s.agreed}/3 - ${s.note}`); } else console.log("G4: not judged yet");
console.log(`G5 unlabeled lines in digests: ${rows.reduce((s, r) => s + r.unlabeled, 0)} of ${rows.reduce((s, r) => s + r.lines, 0)}`);

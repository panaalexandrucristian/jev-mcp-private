#!/usr/bin/env node
// Reads eval/results/*.json and prints the gate table of EVAL-RULES.md. Thresholds are the ones written before the runs.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const get = (id) => JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
const have = new Set(readdirSync(DIR).map((f) => f.replace(".json", "")));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const rows = [];
const base = get("tokens-baseline").results[0].contextAtLastCall;
const tok = get("tokens").results;
const ctx = (id) => tok.find((r) => r.id === id).contextAtLastCall;
{ // C1
  const c = get("C1"); const A = (ctx("pdf-read-1") + ctx("pdf-read-2")) / 2; const B = (ctx("pdf-script-1") + ctx("pdf-script-2")) / 2;
  rows.push({ id: "C1 pdf-text", gates: [["content retention >= 0.97 both ways", Math.min(c.retentionContent.aInB, c.retentionContent.bInA) >= 0.97, `${c.retentionContent.aInB.toFixed(3)} / ${c.retentionContent.bInA.toFixed(3)} (raw with wrappers ${c.retention.aInB.toFixed(3)} / ${c.retention.bInA.toFixed(3)})`], ["output <= 5% of stored size", c.O / c.R <= 0.05, `${c.O} of ${c.R} chars`], ["context at last call falls >= 25% (as written)", 1 - B / A >= 0.25, `${A} -> ${B} tokens (-${pct(1 - B / A)}); over the ${base}-token baseline: ${A - base} -> ${B - base} (-${pct(1 - (B - base) / (A - base))})`], ["same ticket facts in both answers", true, "both answers name DSE-47553 and DSE-47609 with their goals"], ["images reported", true, "1 image per PDF flagged, not shown"]], note: "needs pypdf/PyMuPDF (not shipped); PDFs only" });
}
{ const c = get("C2"); rows.push({ id: "C2 diff-map", gates: [["recall 100%", c.recall === 1, `${c.changedLines} changed lines in ${c.files} files, ${c.functions} functions`], ["output <= 25% of the diff", c.O / c.R <= 0.25, `${c.O} of ${c.R} chars (-${pct(c.reduction)})`], ["break-even f* >= 0.5", c.breakEven >= 0.5, `f* = ${c.breakEven.toFixed(2)} (bodies of the touched functions: ${c.B} chars)`]], note: "navigation index, not a replacement for the diff" }); }
{ const c = get("C3"); rows.push({ id: "C3 search-digest", gates: [["recall 100% of (file,line,name)", c.recall === 1, `${c.rawTriples - c.missingFromDigest} of ${c.rawTriples}`], ["output <= 60% of the rg output", c.O / c.R <= 0.6, `${c.O} of ${c.R} chars (-${pct(c.reduction)})`]], note: `not printed: ${c.snippetCharsNotPrinted} chars of line text; ${c.declarations} declarations isolated, ${c.commentHits} comment hits flagged` }); }
{ const c = get("C4"); rows.push({ id: "C4 md-outline", gates: [["every heading with its range", true, `${c.sections} sections`], ["output <= 15% of the Read", c.O / c.R <= 0.15, `${c.O} of ${c.R} chars (-${pct(c.reduction)})`], ["break-even reported", true, `at most ${c.breakEvenSectionsWorstCase} of ${c.sections} sections may be opened`]], note: `but ${c.sectionsWithReappearingNames} of ${c.sections} sections have names that reappear later in the session: outline + those sections = ${c.O + c.usedChars} chars against ${c.R} (net ${c.netIfOnlyThoseRead >= 0 ? "+" : ""}${c.netIfOnlyThoseRead})` }); }
{ const s = get("C5-static"); const b = get("C5-battery"); rows.push({ id: "C5 slim SKILL.md", gates: [["static saving >= 4,000 chars", s.saved >= 4000, `${s.skillBefore} -> ${s.skillAfter} (-${s.saved}, ${pct(s.savedShare)}; about ${s.tokensSavedEstimate} tokens, estimate)`], ["routing R1-R6 6/6", false, b.slim["rerun with the plugin folder readable"]], ["find-usages cost <= +10%", false, "0.00903 against 0.00692 USD"]], note: "battery stopped after the gate failed" }); }
{ const c = get("C6"); rows.push({ id: "C6 duplicate guard", gates: [["duplicates >= 10% of text on the active chain", c.shareActive >= 0.1, `${c.redundantActive} of ${c.R} chars (${pct(c.shareActive)}); across all branches ${c.redundantAllBranches} (${pct(c.shareAllBranches)}), after rewinds`]], note: "nothing to save" }); }
{ const c = get("C7"); const A = (ctx("img-full-1") + ctx("img-full-2")) / 2; const B = (ctx("img-small-1") + ctx("img-small-2")) / 2;
  rows.push({ id: "C7 img-shrink", gates: [["context falls >= 25% (as written)", 1 - B / A >= 0.25, `${A} -> ${B} tokens (-${pct(1 - B / A)})`], ["per-screenshot increment over the baseline falls >= 25% (disclosed correction)", 1 - (B - base) / (A - base) >= 0.25, `${A - base} -> ${(B - base).toFixed(0)} tokens each (-${pct(1 - (B - base) / (A - base))}), about ${(A - B).toFixed(0)} tokens saved per screenshot`], ["answers agree with the full-size ones in >= 2 of 3 questions", true, "screen 1: 3 of 3 identical; screen 2: title and error state identical, the small image listed more button-like labels"]], note: `${c.screenshots} screenshots in the session, ${c.bytesBefore} -> ${c.bytesAfter} bytes at 540px; saving for all ten extrapolated from two measured: about ${Math.round(c.screenshots * (A - B))} tokens` }); }
for (const r of rows) {
  console.log(`\n${r.id}`);
  for (const [name, ok, detail] of r.gates) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  console.log(`  note: ${r.note}`);
}

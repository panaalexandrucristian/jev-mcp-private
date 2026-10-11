#!/usr/bin/env node
// Round 2 gate table (EVAL-RULES-2.md): reads eval/results-r2/*.json (+ round-1 Haiku token files for comparison).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const r2 = (id) => read(`results-r2/${id}.json`);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const sonnet = read("results-r2/tokens-sonnet.json").results;
const haiku = read("results/tokens.json").results; const haikuBase = read("results/tokens-baseline.json").results[0].contextAtLastCall;
const ctx = (set, id) => set.find((r) => r.id === id)?.contextAtLastCall;
const base = ctx(sonnet, "baseline");
const mean = (...xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const rows = [];
{ const c = r2("C1"); const A = mean(ctx(sonnet, "pdf-read-1"), ctx(sonnet, "pdf-read-2")); const B = mean(ctx(sonnet, "pdf-script-1"), ctx(sonnet, "pdf-script-2"));
  const hA = mean(ctx(haiku, "pdf-read-1"), ctx(haiku, "pdf-read-2")); const hB = mean(ctx(haiku, "pdf-script-1"), ctx(haiku, "pdf-script-2"));
  rows.push({ id: "C1 pdf-text", gates: [["content retention >= 0.97", Math.min(c.retentionContent.aInB, c.retentionContent.bInA) >= 0.97, `${c.retentionContent.aInB.toFixed(3)} / ${c.retentionContent.bInA.toFixed(3)}`], ["output <= 5% of stored", c.O / c.R <= 0.05, `${c.O} of ${c.R}`], ["per-file increment falls >= 25% (Sonnet)", 1 - (B - base) / (A - base) >= 0.25, `${(A - base).toFixed(0)} -> ${(B - base).toFixed(0)} tokens (-${pct(1 - (B - base) / (A - base))}); as written, whole context ${A.toFixed(0)} -> ${B.toFixed(0)} (-${pct(1 - B / A)})`]], note: `Haiku in round 1: ${(hA - haikuBase).toFixed(0)} -> ${(hB - haikuBase).toFixed(0)} (-${pct(1 - (hB - haikuBase) / (hA - haikuBase))}); needs pypdf; PDFs only` }); }
{ const c = r2("C7"); const A = mean(ctx(sonnet, "img-full-1"), ctx(sonnet, "img-full-2")); const B = mean(ctx(sonnet, "img-small-1"), ctx(sonnet, "img-small-2"));
  const hA = mean(ctx(haiku, "img-full-1"), ctx(haiku, "img-full-2")); const hB = mean(ctx(haiku, "img-small-1"), ctx(haiku, "img-small-2"));
  rows.push({ id: "C7 img-shrink", gates: [["per-screenshot increment falls >= 25% (Sonnet)", 1 - (B - base) / (A - base) >= 0.25, `${(A - base).toFixed(0)} -> ${(B - base).toFixed(0)} tokens (-${pct(1 - (B - base) / (A - base))}), ${(A - B).toFixed(0)} saved per screenshot; as written, whole context -${pct(1 - B / A)}`]], note: `Haiku in round 1: ${(hA - haikuBase).toFixed(0)} -> ${(hB - haikuBase).toFixed(0)}; ${c.screenshots} screenshots in the session, ${c.bytesBefore} -> ${c.bytesAfter} bytes; all ten extrapolated: about ${Math.round(c.screenshots * (A - B))} tokens` }); }
{ const c = r2("C8"); const A = ctx(sonnet, "ui-full"); const B = ctx(sonnet, "ui-digest"); const ag = existsSync(join(ROOT, "results-r2/C8-agreement.json")) ? r2("C8-agreement") : null;
  rows.push({ id: "C8 ui-digest", gates: [["recall 100%", c.recall === 1, `${c.wanted - c.missing} of ${c.wanted} labelled or clickable elements`], ["output <= 30% of the raw JSON", c.O / c.R <= 0.3, `${c.O} of ${c.R} chars (-${pct(c.reduction)})`], ["digest increment <= 50% of the screenshot increment (Sonnet)", (B - base) / (A - base) <= 0.5, `screenshot ${A - base} tokens, digest ${B - base} tokens (${pct((B - base) / (A - base))})`], ["answers agree in >= 2 of 3", ag ? ag.agreed >= 2 : false, ag ? `${ag.agreed} of 3: ${ag.note}` : "not judged yet"]], note: "one screen only (a WebView login)" }); }
{ const c = r2("C9"); rows.push({ id: "C9 callers coverage", gates: [["in-scope sections >= 70%", c.share >= 0.7, `${c.inScope} of ${c.projectCodeLookupSections} (${pct(c.share)})`]], note: "no prototype built (gate failed first); classification is the assistant's judgement, row by row in C9.json" }); }
{ const c = r2("C2"); rows.push({ id: "C2 diff-map", gates: [["recall 100%", c.recall === 1, `${c.changedLines} lines`], ["output <= 25%", c.O / c.R <= 0.25, `${c.O} of ${c.R}`], ["break-even f* >= 0.5", c.breakEven >= 0.5, `f* = ${c.breakEven.toFixed(2)}`]], note: "unchanged by the new transcript" }); }
{ const c = r2("C3"); rows.push({ id: "C3 search-digest", gates: [["recall 100%", c.recall === 1, `${c.rawTriples - c.missingFromDigest} of ${c.rawTriples}`], ["output <= 60%", c.O / c.R <= 0.6, `${c.O} of ${c.R} (-${pct(c.reduction)})`]], note: `not printed: ${c.snippetCharsNotPrinted} chars of line text` }); }
for (const [key, label] of [["C4", "C4 md-outline (project note)"], ["C4b", "C4b md-outline (handoff-verify reference)"]]) { const c = r2(key); rows.push({ id: label, gates: [["output <= 15%", c.O / c.R <= 0.15, `${c.O} of ${c.R} (-${pct(c.reduction)})`], ["break-even reported", true, `at most ${c.breakEvenSectionsWorstCase} of ${c.sections} sections`]], note: `sections with names reappearing later: ${c.sectionsWithReappearingNames} of ${c.sections}; outline + those sections vs the Read: net ${c.netIfOnlyThoseRead >= 0 ? "+" : ""}${c.netIfOnlyThoseRead} chars${key === "C4b" ? " (heuristic noisy; the skill itself orders the reads)" : ""}` }); }
{ const c = r2("C6"); rows.push({ id: "C6 duplicate guard", gates: [["duplicates >= 10% on the active chain", c.shareActive >= 0.1, `${c.redundantActive} of ${c.R} chars; all branches ${(100 * c.shareAllBranches).toFixed(1)}%`]], note: `active chain now ${c.activeResults} results` }); }
{ const c = r2("C5-static"); rows.push({ id: "C5 slim SKILL.md", gates: [["static saving >= 4,000", c.saved >= 4000, `${c.saved} chars`], ["Haiku battery (round 1)", false, "R2 2/4 vs 4/4, cost +30%: not repeated"]], note: "unchanged" }); }
for (const r of rows) { console.log(`\n${r.id}`); for (const [n, ok, d] of r.gates) console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}: ${d}`); console.log(`  note: ${r.note}`); }
console.log(`\nbaselines: Sonnet ${base} tokens, Haiku ${haikuBase}`);

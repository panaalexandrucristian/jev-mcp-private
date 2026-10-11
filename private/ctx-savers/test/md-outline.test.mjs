// C4 md-outline: fixtures, then a replay of the Read of the handoff note in the DSE-47609 session.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { outline, render } from "../md-outline.mjs";
import { hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

describe("md-outline on small notes", () => {
  it("reads headings, ranges and the front matter, and ignores headings inside code fences", () => {
    const md = "---\nname: x\n---\n# Title\nintro\n## One\n- a\n```\n# not a heading\n```\n## Two\ntext\n";
    const o = outline(md);
    assert.deepEqual(o.front, [1, 3]);
    assert.deepEqual(o.sections.map((s) => [s.first, s.last, s.title]), [[4, 5, "Title"], [6, 10, "One"], [11, 12, "Two"]]);
    assert.equal(o.sections[1].firstText, "- a");
  });
  it("says so when there is no heading", () => {
    assert.match(render(outline("just text\nmore\n"), "n.md"), /no headings/);
  });
});

const NOTE = "/Users/apana/.claude/projects/-Users-apana-StudioProjects-dgapp2-android/memory/handoff-2026-10-09-rewards-dse-47545.md";
describe("replay of the real note Read", { skip: !(hasTranscript() && existsSync(NOTE)) && "transcript or note missing" }, () => {
  it("lists every heading of the note and is far smaller than the Read", () => {
    const t = loadTranscript();
    const read = t.active.find((c) => c.name === "Read" && /handoff-2026-10-09/.test(c.input.file_path ?? ""));
    assert.ok(read, "the note Read is on the active chain");
    const source = readFileSync(NOTE, "utf8");
    const o = outline(source);
    const text = render(o, "handoff-2026-10-09-rewards-dse-47545.md");
    const independent = source.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /^#{1,6}\s/.test(l)).map(([n]) => n);
    assert.deepEqual(o.sections.map((s) => s.line), independent);
    const R = read.chars; const O = text.length;
    const avg = o.sections.reduce((s, x) => s + x.chars, 0) / o.sections.length;
    const bySize = [...o.sections].sort((a, b) => b.chars - a.chars);
    let kWorst = 0; for (let sum = O; kWorst < bySize.length && sum + bySize[kWorst].chars < R; kWorst += 1) sum += bySize[kWorst].chars;
    // which sections does the rest of the session show it used? identifiers (File.kt names) of a section that reappear in later calls
    const idx = t.active.indexOf(read);
    const later = t.active.slice(idx + 1).map((c) => JSON.stringify(c.input)).join("\n");
    const used = o.sections.map((s) => { const body = source.split("\n").slice(s.first - 1, s.last).join("\n"); const ids = [...new Set(body.match(/\b[A-Z][A-Za-z0-9]+(?:\.kt)?\b/g) ?? [])].filter((x) => x.length > 6); const hits = ids.filter((x) => later.includes(x)); return { title: s.title, chars: s.chars, reappearing: hits.slice(0, 6), count: hits.length }; });
    const usedChars = used.filter((u) => u.count > 0).reduce((s, u) => s + u.chars, 0);
    const result = { R, O, reduction: 1 - O / R, sections: o.sections.length, avgSectionChars: Math.round(avg), breakEvenSectionsWorstCase: kWorst, sectionsWithReappearingNames: used.filter((u) => u.count > 0).length, usedChars, netIfOnlyThoseRead: R - (O + usedChars), used, output: text };
    save("C4", result);
  });
});

// Round 2: the 27k-char reference the handoff-verify skill made the model Read (19:07:06).
describe("replay of the handoff-verify reference Read", { skip: !hasTranscript() && "transcript missing" }, () => {
  it("lists every heading of the reference and measures how much of it the rest of the session reuses", () => {
    const t = loadTranscript();
    const read = t.active.find((c) => c.name === "Read" && /handoff-verify\/reference\/jev-and-au/.test(c.input.file_path ?? ""));
    if (!read || !existsSync(read.input.file_path)) return;
    const source = readFileSync(read.input.file_path, "utf8");
    const o = outline(source);
    const text = render(o, read.input.file_path.split("/").at(-1));
    const independent = source.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /^#{1,6}\s/.test(l)).map(([n]) => n);
    // headings inside code fences are skipped by outline(); compare only when the file has no fences
    if (!/^\s*```/m.test(source)) assert.deepEqual(o.sections.map((s) => s.line), independent);
    const R = read.chars; const O = text.length;
    const idx = t.active.indexOf(read);
    const later = t.active.slice(idx + 1).map((c) => `${JSON.stringify(c.input)}\n${c.text.slice(0, 2000)}`).join("\n");
    const bySize = [...o.sections].sort((a, b) => b.chars - a.chars);
    let kWorst = 0; for (let sum = O; kWorst < bySize.length && sum + bySize[kWorst].chars < R; kWorst += 1) sum += bySize[kWorst].chars;
    const used = o.sections.map((s) => { const body = source.split("\n").slice(s.first - 1, s.last).join("\n"); const ids = [...new Set(body.match(/\b[a-z_]+\.(?:py|json|md)\b|\b[A-Z][A-Za-z0-9]{6,}\b/g) ?? [])]; const hits = ids.filter((x) => later.includes(x)); return { title: s.title, chars: s.chars, count: hits.length, reappearing: hits.slice(0, 5) }; });
    const usedChars = used.filter((u) => u.count > 0).reduce((s, u) => s + u.chars, 0);
    save("C4b", { R, O, reduction: 1 - O / R, sections: o.sections.length, avgSectionChars: Math.round(o.sections.reduce((s, x) => s + x.chars, 0) / Math.max(o.sections.length, 1)), breakEvenSectionsWorstCase: kWorst, sectionsWithReappearingNames: used.filter((u) => u.count > 0).length, usedChars, netIfOnlyThoseRead: R - (O + usedChars), later: t.active.length - idx - 1, used, output: text });
  });
});

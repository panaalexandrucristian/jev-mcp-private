#!/usr/bin/env node
// md-outline: the shape of a markdown note, so that only the needed sections are read.
//   node md-outline.mjs <file.md> [--first 80]
// Prints the front matter range, then one line per heading: first-last line, the heading, line and char counts of its section and the
// first text line of the section. Headings inside code fences are ignored. Exit 2: unreadable file.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export function outline(source, firstChars = 80) {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let from = 0;
  let front = null;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) { front = [1, close + 1]; from = close + 1; }
  }
  const headings = [];
  let fence = null;
  for (let i = from; i < lines.length; i += 1) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(lines[i]);
    if (fenceMatch) { fence = fence === null ? fenceMatch[1][0] : fence === fenceMatch[1][0] ? null : fence; continue; }
    if (fence !== null) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) headings.push({ line: i + 1, level: m[1].length, title: m[2] });
  }
  const sections = headings.map((h, k) => {
    const last = (headings[k + 1]?.line ?? lines.length + 1) - 1;
    const body = lines.slice(h.line, last);
    const first = body.find((l) => l.trim() !== "") ?? "";
    return { ...h, first: h.line, last, lines: last - h.line + 1, chars: lines.slice(h.line - 1, last).join("\n").length + 1, firstText: first.trim().slice(0, firstChars) };
  });
  return { lines: lines.length, chars: source.length, front, sections };
}

export function render(info, name) {
  const out = [`md-outline: ${name} ${info.lines} lines, ${info.chars} chars${info.front ? `, front matter lines ${info.front[0]}-${info.front[1]}` : ""}`];
  if (info.sections.length === 0) out.push("no headings: read the file whole or with Grep");
  for (const s of info.sections) out.push(`${String(s.first).padStart(4)}-${String(s.last).padEnd(4)} ${"#".repeat(s.level)} ${s.title}  (${s.lines} lines, ${s.chars} chars)${s.firstText ? `  | ${s.firstText}` : ""}`);
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { first: { type: "string" } } });
  if (positionals.length !== 1) { console.error("usage: md-outline.mjs <file.md> [--first 80]"); process.exit(2); }
  let source;
  try { source = readFileSync(positionals[0], "utf8"); } catch (error) { console.error(`cannot read ${positionals[0]}: ${error.code ?? error.message}`); process.exit(2); }
  console.log(render(outline(source, values.first ? Number(values.first) : 80), positionals[0].split("/").at(-1)));
}

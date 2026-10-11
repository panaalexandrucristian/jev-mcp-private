#!/usr/bin/env node
// diff-map: which files and which Kotlin functions a diff touches, with exact line ranges. No code is printed.
//   node diff-map.mjs [--cwd <dir>] [--stdin] [-- <git diff arguments>]
// Default: `git diff -U0` in --cwd (or the current folder). --stdin reads a unified diff (any amount of context) and maps it onto the
// files found under --cwd, which must hold the NEW side of the diff. Changed lines are read from the +/- markers, not from hunk headers.
// A deletion is placed at the line that follows it. Only .kt files are mapped to functions; other files get their changed line ranges.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDefinitions } from "../../skills/class-graph/scripts/definitions.mjs";

/** @returns {Array<{path:string, status:string, added:number[], deletedAt:number[], deleted:number, hunks:number}>} */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m ? m[1] : line, status: "modified", added: [], deletedAt: [], deleted: 0, hunks: 0 };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) file.status = "new file";
      else if (line.startsWith("deleted file mode")) file.status = "deleted file";
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.status = "binary";
      else if (line.startsWith("rename to ")) file.status = "renamed";
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { oldLine = Number(h[1]); newLine = Number(h[2]); inHunk = true; file.hunks += 1; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) { file.added.push(newLine); newLine += 1; }
    else if (line.startsWith("-") && !line.startsWith("---")) { file.deletedAt.push(newLine); file.deleted += 1; oldLine += 1; }
    else if (line.startsWith(" ")) { oldLine += 1; newLine += 1; }
  }
  return files;
}

const ranges = (numbers) => {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n <= last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
};

/** Innermost function that contains the line, or null. */
const enclosing = (definitions, line) => {
  let best = null;
  for (const d of definitions) if (d.start <= line && line <= d.end && (best === null || d.start >= best.start)) best = d;
  return best;
};

export function mapDiff(files, root) {
  const rows = [];
  for (const f of files) {
    const row = { path: f.path, status: f.status, plus: f.added.length, minus: f.deleted, hunks: f.hunks, functions: [], outside: [], lines: ranges([...f.added, ...f.deletedAt]) };
    if (f.path.endsWith(".kt") && f.status !== "deleted file" && f.status !== "binary") {
      let definitions = [];
      try { definitions = findDefinitions(readFileSync(join(root, f.path), "utf8")); } catch { row.note = "file not readable: functions not mapped"; }
      const byFn = new Map();
      const place = (line, kind) => {
        const d = enclosing(definitions, line) ?? (kind === "del" ? enclosing(definitions, line - 1) : null);
        if (!d) { row.outside.push(line); return; }
        const key = `${d.owner ? `${d.owner}.` : ""}${d.name} ${d.start}-${d.end}`;
        if (!byFn.has(key)) byFn.set(key, { name: key, start: d.start, end: d.end, plus: 0, minus: 0, lines: [] });
        const entry = byFn.get(key);
        entry.lines.push(line);
        if (kind === "add") entry.plus += 1; else entry.minus += 1;
      };
      for (const l of f.added) place(l, "add");
      for (const l of f.deletedAt) place(l, "del");
      row.functions = [...byFn.values()].sort((a, b) => a.start - b.start);
    }
    rows.push(row);
  }
  return rows;
}

export function render(rows) {
  const plus = rows.reduce((s, r) => s + r.plus, 0);
  const minus = rows.reduce((s, r) => s + r.minus, 0);
  const out = [`diff-map: ${rows.length} file${rows.length === 1 ? "" : "s"}, +${plus} -${minus}, ${rows.reduce((s, r) => s + r.hunks, 0)} hunks`];
  for (const r of rows) {
    out.push(`${r.path}  ${r.status === "modified" ? "" : `[${r.status}] `}+${r.plus} -${r.minus}${r.note ? `  (${r.note})` : ""}`);
    for (const fn of r.functions) out.push(`  ${fn.name}  +${fn.plus} -${fn.minus}  lines ${ranges(fn.lines)}`);
    if (r.outside.length) out.push(`  outside functions: lines ${ranges(r.outside)}`);
    if (!r.path.endsWith(".kt") || r.status === "binary" || r.status === "deleted file") if (r.status !== "binary") out.push(`  changed lines ${r.lines || "-"}`);
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const gitArgs = split >= 0 ? argv.slice(split + 1) : [];
  let cwd = process.cwd();
  let stdin = false;
  for (let i = 0; i < own.length; i += 1) { if (own[i] === "--cwd") cwd = own[++i]; else if (own[i] === "--stdin") stdin = true; else { console.error("usage: diff-map.mjs [--cwd dir] [--stdin] [-- git diff args]"); process.exit(2); } }
  let text;
  try { text = stdin ? readFileSync(0, "utf8") : execFileSync("git", ["diff", "-U0", ...gitArgs], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); }
  catch (error) { console.error(`cannot get the diff: ${error.message.split("\n")[0]}`); process.exit(2); }
  const files = parseDiff(text);
  console.log(files.length === 0 ? "diff-map: no changes" : render(mapDiff(files, cwd)));
}

#!/usr/bin/env node
// search-digest: one search for several names, printed as a digest instead of one line of text per hit.
//   node search-digest.mjs --root <dir> --name isEarned --name currentStep='\.currentStep' [--glob '*.kt'] [--drop '<regex on path or line>'] [--snippets]
// Every hit is kept as file:line (a trailing "c" marks a comment line); declarations (val/var/fun NAME) are listed once with their text.
// --snippets also prints the text of every hit. --drop removes hits whose "path:line:text" matches the regex, like an `rg -v` pipe.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseNames(specs) {
  return specs.map((s) => { const i = s.indexOf("="); return i > 0 && /^\w+$/.test(s.slice(0, i)) ? { label: s.slice(0, i), regex: s.slice(i + 1) } : { label: s, regex: s }; });
}

export function collect(names, { root, glob = null, drop = null }) {
  const pattern = names.map((n) => `(?:${n.regex})`).join("|");
  const args = ["-n", "--no-heading", "--color", "never", "-e", pattern];
  if (glob) args.push("--glob", glob);
  args.push(".");
  let raw = "";
  try { raw = execFileSync("rg", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); } catch (error) { if (error.status !== 1) throw error; }
  const dropRe = drop ? new RegExp(drop) : null;
  const hits = [];
  for (const line of raw.split("\n")) {
    const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    if (dropRe && dropRe.test(`${m[1]}:${m[2]}:${m[3]}`)) continue;
    const text = m[3];
    for (const n of names) {
      if (!new RegExp(n.regex).test(text)) continue;
      const declared = new RegExp(`\\b(?:val|var|fun)\\s+(?:[\\w.<>?]+\\.)?(?:${n.regex})`).test(text);
      hits.push({ file: m[1], line: Number(m[2]), label: n.label, text: text.trim(), comment: COMMENT.test(text), declaration: declared && !COMMENT.test(text) });
    }
  }
  return hits;
}

export function render(hits, names, { snippets = false } = {}) {
  const files = new Map();
  for (const h of hits) { if (!files.has(h.file)) files.set(h.file, new Map()); const per = files.get(h.file); if (!per.has(h.label)) per.set(h.label, []); per.get(h.label).push(h); }
  const out = [`search-digest: ${names.length} names, ${hits.length} hits in ${files.size} files, ${hits.filter((h) => h.comment).length} on comment lines`];
  const decl = hits.filter((h) => h.declaration);
  if (decl.length) { out.push(`declarations (${decl.length}):`); for (const h of decl) out.push(`  ${h.file}:${h.line}  ${h.label}  ${h.text.slice(0, 110)}`); }
  out.push("by file (c = comment line):");
  for (const [file, per] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`  ${file}  ${[...per.entries()].map(([label, list]) => `${label} ${list.sort((a, b) => a.line - b.line).map((h) => `${h.line}${h.comment ? "c" : ""}`).join(",")}`).join(" | ")}`);
    if (snippets) for (const list of per.values()) for (const h of list) out.push(`      ${h.line}: ${h.text.slice(0, 140)}`);
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { root: { type: "string" }, name: { type: "string", multiple: true }, glob: { type: "string" }, drop: { type: "string" }, snippets: { type: "boolean" } } });
  if (!values.root || !values.name?.length) { console.error("usage: search-digest.mjs --root <dir> --name <n> [--name label=regex ...] [--glob '*.kt'] [--drop regex] [--snippets]"); process.exit(2); }
  const names = parseNames(values.name);
  const hits = collect(names, { root: values.root, glob: values.glob, drop: values.drop });
  console.log(hits.length === 0 ? "search-digest: no hits" : render(hits, names, { snippets: values.snippets }));
}

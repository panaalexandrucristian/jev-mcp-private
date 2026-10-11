#!/usr/bin/env node
// make-slim: a copy of the class-graph skill whose SKILL.md keeps sections 3 (find-usages) and 4 (find-def) only as pointers;
// the original text of both goes to reference/find-tools.md, to be Read when one of those tools is needed.
//   node make-slim.mjs <skill-dir> <out-dir>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function slim(text) {
  const parts = text.split(/(?=^## )/m);
  const find = (prefix) => parts.findIndex((p) => p.startsWith(prefix));
  const i3 = find("## 3. find-usages.mjs");
  const i4 = find("## 4. find-def.mjs");
  if (i3 < 0 || i4 < 0 || i4 !== i3 + 1) throw new Error("sections 3 and 4 not found as neighbours");
  const removed = [parts[i3], parts[i4]];
  const stub3 = "## 3. find-usages.mjs\nBefore running it, Read `${CLAUDE_SKILL_DIR}/reference/find-tools.md` (section 3: command, flags, tiers).\n\n";
  const stub4 = "## 4. find-def.mjs\nBefore running it, Read `${CLAUDE_SKILL_DIR}/reference/find-tools.md` (section 4: command, listing, paging, body, file discovery).\n\n";
  parts.splice(i3, 2, stub3, stub4);
  return { skill: parts.join(""), reference: `# find-usages and find-def\n\nSections 3 and 4 of SKILL.md, unchanged.\n\n${removed.join("")}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error("usage: make-slim.mjs <skill-dir> <out-dir>"); process.exit(2); }
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true });
  const { skill, reference } = slim(readFileSync(join(src, "SKILL.md"), "utf8"));
  mkdirSync(join(out, "reference"), { recursive: true });
  writeFileSync(join(out, "SKILL.md"), skill);
  writeFileSync(join(out, "reference", "find-tools.md"), reference);
  console.log(`slim skill written to ${out}: SKILL.md ${readFileSync(join(src, "SKILL.md"), "utf8").length} -> ${skill.length} chars, reference ${reference.length}`);
}

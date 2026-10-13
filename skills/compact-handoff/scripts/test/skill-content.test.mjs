// Checks of the skill package itself: the frontmatter, the command form SKILL.md teaches, and that nothing in the skill names a path of one person's machine. Node stdlib only.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(SCRIPTS, "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "((?:[^"\\]|\\.)*)"$/m.exec(frontmatter ?? "")?.[1];

describe("SKILL.md", () => {
  it("has the name and a description of at most 800 characters with the cues that make the model choose it", () => {
    assert.match(frontmatter, /^name: compact-handoff$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length <= 800, `description is ${description.length} characters`);
    for (const cue of ["handoff", "CURRENT session", "HANDOFF.md", "blobs/", "fă un handoff", "mai fă o dată handoff", "Not for delegating"]) assert.ok(description.includes(cue), `description mentions: ${cue}`);
  });

  it("lets the one script run without a permission prompt, by its own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(python3 \$\{CLAUDE_SKILL_DIR\}\/scripts\/make_context\.py \*\)$/m);
  });

  it("teaches plain commands: the only variable in a command line is CLAUDE_SKILL_DIR, and both steps use the one script", () => {
    const commandLines = body.split("\n").filter((line) => /^ {4,}\S/.test(line)).map((line) => line.trim());   // indented code, also inside a numbered list
    assert.equal(commandLines.length, 2, "two command examples: --marker and --current");
    for (const line of commandLines) {
      assert.match(line, /^python3 \$\{CLAUDE_SKILL_DIR\}\/scripts\/make_context\.py --(marker|current)/);
      assert.equal(line.replace(/\$\{CLAUDE_SKILL_DIR\}/g, "").includes("$"), false, `no other variable in: ${line}`);
    }
  });

  it("states the rules that protect the user: no reading the file into the conversation, no deleting handoff folders unasked, no extra verification pass", () => {
    for (const rule of ["Do not read `HANDOFF.md` or the blobs into this conversation", "Never delete a `/tmp/handoff-*`", "check whether a recent session still refers to it", "If the script fails, show the error and stop"]) assert.ok(body.includes(rule), rule);
  });
});

describe("the skill text rule", () => {
  it("is described in SKILL.md: blob mode only, isMeta, named marker, whole with --cut", () => {
    for (const part of ["Base directory for this skill: ", "`isMeta`", "not typed by the user", "names the skill", "with `--cut` it stays whole"]) assert.ok(body.includes(part), part);
  });
});

describe("the package", () => {
  it("has the three programs and no path of one machine inside", () => {
    for (const f of ["make_context.py", "compact_context.py", "prepare_all.py"]) {
      const p = join(SCRIPTS, f);
      assert.ok(existsSync(p), `${f} exists`);
      assert.equal(/\/Users\/[a-z0-9._-]+\//i.test(readFileSync(p, "utf8")), false, `${f} names no /Users/<name>/ path`);
    }
    assert.equal(/\/Users\/[a-z0-9._-]+\//i.test(skillText), false, "SKILL.md names no /Users/<name>/ path");
  });

  it("keeps its tests next to it and uses no module outside the standard library of Python", () => {
    assert.ok(readdirSync(join(SCRIPTS, "test")).length >= 3);
    for (const f of ["make_context.py", "compact_context.py", "prepare_all.py"]) {
      const imports = [...readFileSync(join(SCRIPTS, f), "utf8").matchAll(/^(?:import|from) ([a-z_][a-z0-9_]*)/gm)].map((m) => m[1]);
      for (const m of imports) assert.ok(["datetime", "glob", "json", "os", "re", "shutil", "subprocess", "sys", "tempfile", "time", "io", "contextlib", "hashlib", "itertools", "random", "compact_context", "omissions", "discover", "prepare"].includes(m), `${f} imports ${m}`);
    }
  });
});

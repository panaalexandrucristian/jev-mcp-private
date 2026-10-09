import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NATURAL_MARKER } from "../hook.mjs";
import { REPO_ROOT } from "./helpers.mjs";

const read = (...p) => readFileSync(join(REPO_ROOT, ...p), "utf8");
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "frontmatter");
  return Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
};

describe("the plugin ships jev-control as 0.10.0", () => {
  it("both manifests carry 0.10.0", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    const market = JSON.parse(read(".claude-plugin", "marketplace.json"));
    assert.equal(plugin.version, "0.10.0");
    assert.equal(market.plugins.find((p) => p.name === "jev").version, "0.10.0");
  });
  it("PRIVATE.md documents the version, the section and the new check", () => {
    const text = read("PRIVATE.md");
    assert.match(text, /`0\.7\.0` for the `jev-control` skill, `0\.7\.1` for its positional threshold.*`0\.7\.2` for `handoff-verify`/);
    assert.match(text, /^## Jev control$/m);
    assert.match(text, /node --test private\/jev-control\/test\//);
    assert.match(text, /Nothing has been measured live yet/);
    assert.match(text, /`0\.7\.5` for the 600-character boundary test/);
    assert.match(text, /`0\.9\.1` for the split of the `handoff-verify` skill/);
    assert.match(text, /split_manifest\.json/);
    assert.match(text, /^\*\*Gate status of 0\.7\.3 and 0\.7\.4\.\*\* Neither has an accepted `jev_gate` receipt.*`0a90f637aeeb8f47f02aa391f23d7b67`.*`53935d5ec804d18e24dffe39b8fd2dac`/m);
  });
});

describe("skill and command", () => {
  const skill = read("skills", "jev-control-mode", "SKILL.md");
  const fm = frontmatter(skill);
  it("R09: no file of the skill asks to END the final message with Incomplete: (the audit accepts only a message that starts with it)", () => {
    const base = join(REPO_ROOT, "skills", "jev-control-mode");
    const files = ["SKILL.md", ...["reference", "examples"].flatMap((d) => readdirSync(join(base, d)).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`))];
    const old = /\b(?:end|ends|ending|finish|finishes)\s+with\s+[`"']?Incomplete:/i;
    for (const f of files) assert.doesNotMatch(readFileSync(join(base, f), "utf8"), old, f);
    assert.match(skill, /start the final message with `Incomplete:` or ask the user/);
    assert.match(skill, /\(or start the final message with `Incomplete:`\)/);
  });
  it("is named jev-control-mode (R09, D43) with explicit-only triggers in English and Romanian", () => {
    assert.equal(fm.name, "jev-control-mode");
    assert.equal(fm.name, "jev-control-mode", "the skill name is its directory name");
    assert.match(fm.description, /The mode's command is \/jev:jev-control on\|off\|status\|threshold/);
    for (const phrase of ["/jev:jev-control", "let Jev control this session", "lasă Jev să controleze sesiunea", "sesiune controlată de Jev", "Do NOT use for ordinary coding tasks"]) assert.ok(fm.description.includes(phrase), phrase);
    assert.match(fm.description, /ONLY when the user explicitly asks/);
  });
  it("states the strict threshold, the protocol and accepts both tool-name prefixes", () => {
    for (const phrase of ["mcp__jev__*", "mcp__plugin_jev_jev__*", "strictly `>`", "0.95", "(0.5, 1)", "Jev unavailable", "Incomplete:", "25", "action_gather_evidence", "At most **2** expansion rounds", "no meta-decisions", "choose the order yourself", "Run `on` before anything else", "not your own `grep`"]) assert.ok(skill.includes(phrase), phrase);
  });
  it("R05: the batch file goes in the working directory, decide runs alone, and only plan items run", () => {
    assert.match(skill, /to a NEW file in the working directory \(for example `jev-batch\.json` when no file has that name; never overwrite a file you did not create for this; a Write outside the working directory, such as `\/tmp`, is refused in headless runs\)/);
    assert.match(skill, /`cli\.mjs decide --file <that file> \[--decision-id <id>\]` ALONE: a pipe, `;` or `&&` after it makes it an ordinary action that grants nothing/);
    assert.match(skill, /delete ONLY the file you created, with a lone `rm -f <that file>` in its own command/);
    assert.match(skill, /a result that ends the batch \(`selected`, `ordered`, `ask_user`, `incomplete`\) repeats this in a `cleanup` line, naming the file as you passed it/, "R06: the decide result repeats the removal");
    assert.match(skill, /only when the transcript proves all of it: that Write created the file, a `decide --file` of the request on that path read that very version and succeeded, nothing that may change files ran meanwhile \(not even `node --test`\), and the lone `rm` removed it; a file left in the tree, or removed in a compound command, is an edit/);
    assert.match(skill, /Often only the next task is cleared .*never run it because the order seems obvious/);
    assert.equal(skill.includes("outside the repository"), false, "the old instruction (a /tmp file) is gone");
    for (const f of ["01-single-winner", "02-multiple-eligible", "03-extension-then-ask", "05-task-order", "06-unavailable", "07-compact-helper"]) {
      const text = read("skills", "jev-control-mode", "examples", `${f}.md`);
      assert.equal(text.includes("/tmp/jc-batch.json"), false, f);
      assert.ok(text.includes("--file jev-batch.json"), f);
      assert.ok(text.includes("a new file in the working directory, here `jev-batch.json` because no file had that name; only that file is deleted afterwards, with a lone `rm -f jev-batch.json` in its own command"), f);
    }
  });
  it("links its references, and they exist", () => {
    for (const ref of ["protocol", "tools", "integration", "evaluation"]) {
      assert.ok(skill.includes(`reference/${ref}.md`), ref);
      assert.ok(read("skills", "jev-control-mode", "reference", `${ref}.md`).length > 500, ref);
    }
  });
  it("the command takes on|off|status|threshold and runs the helper", () => {
    const text = read("commands", "jev-control.md");
    const cmd = frontmatter(text);
    assert.ok(cmd.description.length > 20);
    assert.match(cmd["argument-hint"], /on .*off.*status.*threshold/);
    assert.match(text, /private\/jev-control\/cli\.mjs/);
    assert.match(text, /never pass a made-up `--session-id`/i);
    assert.match(text, /--session-cap/);
  });
  it("R09: the command loads the skill by its own name (Skill jev:jev-control-mode), falls back to the exact file, and a natural-language request without arguments runs `on`, not `status` (R03)", () => {
    const text = read("commands", "jev-control.md");
    assert.match(text, /1\. Load the skill with the Skill tool: `jev:jev-control-mode`, and follow it while the mode is on\./);
    assert.match(text, /If the Skill tool cannot load it, Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/jev-control-mode\/SKILL\.md`; if that is refused too, say so in one line and follow the rules printed by `on`/);
    assert.match(text, /cli\.mjs" help decide` prints the batch format, `help search` the search form, `help done` the completion gate/);
    assert.doesNotMatch(text, /same name as this command|never that file|skills\/jev-control\/SKILL/);
    assert.doesNotMatch(text, /Load the `jev-control` skill/);
    // Step 3 tests exactly the line that only hook.mjs emits for a natural-language request (never for a slash command), of the current request.
    const marked = `jev-control was requested by the user ${NATURAL_MARKER.replace(/\.$/, "")}`;
    assert.ok(text.includes(`«${marked}»`), "step 3 quotes the natural-language line of the hook");
    assert.match(text, /With no or unknown arguments: when the prompt hook of the current request put the line «[^»]+» in your context/);
    assert.match(text, /a line from an earlier prompt does not count, and a `\/jev:jev-control` prompt never gets it\), run `on` as above; otherwise run `status` and explain the five commands/);
    assert.doesNotMatch(text, /«jev-control was requested by the user for this session»/, "the line that slash commands also get is not the condition");
  });
  it("jev-done, jev-locate and the locator have explicit control branches", () => {
    for (const f of [["commands", "jev-done.md"], ["commands", "jev-locate.md"], ["agents", "jev-locator.md"]]) assert.match(read(...f), /jev-control/, f.join("/"));
    assert.match(read("agents", "jev-locator.md"), /no lexical fallback/);
    assert.match(read("commands", "jev-done.md"), /strictly above `T`/);
  });
  it("R07: the headless completion recipe is in SKILL.md and in the jev-control paragraph of jev-done.md, and nothing else of jev-done.md moved", () => {
    assert.match(skill, /In a headless run \(a `\/tmp` file and a heredoc were refused there; a JSON with braces on the command line is avoided for the same risk\) the recipe is `cli\.mjs help done`: Write a NEW `jev-claims\.json` in the repository root/);
    assert.match(skill, /run `cli\.mjs done --claims jev-claims\.json` ALONE; the helper reads it, removes it before the snapshot and prints `claims_removed` \(never remove it yourself; another name, a subdirectory, a tracked, ignored or symlinked file is refused and left alone\)/);
    const done = read("commands", "jev-done.md");
    assert.match(done, /\*\*Headless runs \(R07\):\*\*/);
    assert.match(done, /Write a NEW file `jev-claims\.json` in the repository root \(never overwrite another file\)/);
    assert.match(done, /removes it BEFORE the snapshot and prints `claims_removed` and `claims_sha256` \(that is not acceptance: only the `outcome` is\)/);
    assert.match(done, /a heredoc with braces and quotes were refused there, a JSON with braces and quotes on the command line is avoided for the same risk \(it was never tried\)/);
    assert.match(done, /a file outside the work tree \(`\/tmp`\) and `-` are read as before and never removed/);
    // The upstream procedure text outside the jev-control paragraph keeps the /tmp claims file of steps 4 and 5.
    assert.match(done, /1\. \*\*Freeze the snapshot\.\*\*/);
  });
});

describe("R09: the skill and the command no longer share a name (D43)", () => {
  const dirs = (...p) => readdirSync(join(REPO_ROOT, ...p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  it("the old skill directory is gone, the new one exists and the command file keeps its name", () => {
    assert.equal(dirs("skills").includes("jev-control"), false, "skills/jev-control/ must not exist any more");
    assert.equal(dirs("skills").includes("jev-control-mode"), true);
    assert.equal(readdirSync(join(REPO_ROOT, "commands")).includes("jev-control.md"), true);
  });
  it("no skill name equals a command name (the Skill tool would return the command text, R03)", () => {
    const skillNames = dirs("skills").filter((d) => readdirSync(join(REPO_ROOT, "skills", d)).includes("SKILL.md")).map((d) => frontmatter(read("skills", d, "SKILL.md")).name);
    const commandNames = readdirSync(join(REPO_ROOT, "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    assert.ok(skillNames.includes("jev-control-mode") && commandNames.includes("jev-control"));
    assert.deepEqual(skillNames.filter((n) => commandNames.includes(n)), []);
  });
  it("every skills/<x>/ path that the commands, agents, helper sources and jev-flow skill cite exists, and none cites the old directory", () => {
    const files = [];
    for (const d of ["commands", "agents"]) for (const f of readdirSync(join(REPO_ROOT, d))) files.push([d, f]);
    for (const f of ["cli.mjs", "help.mjs", "hook.mjs", "rules.mjs", "run-session.mjs", "measure.mjs"]) files.push(["private", "jev-control", f]);
    files.push(["skills", "jev-flow", "SKILL.md"]);
    const cited = new Set();
    for (const parts of files) {
      const text = read(...parts);
      assert.doesNotMatch(text, /skills\/jev-control(?![-\w])/, `${parts.join("/")} cites the old skill directory`);
      for (const m of text.matchAll(/skills\/([a-z][a-z-]*)\//g)) cited.add(m[1]);
    }
    assert.ok(cited.has("jev-control-mode"));
    for (const name of cited) assert.equal(dirs("skills").includes(name), true, `skills/${name}/ is cited but missing`);
  });
  it("no active file outside the historical reports cites skills/jev-control/ or jev-control/SKILL.md", () => {
    const out = execFileSync("git", ["grep", "-n", "-E", "skills/jev-control/|jev-control/SKILL\\.md", "--", ".", ":!private/jev-control/results", ":!private/jev-control/test"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    // The only remaining mentions are history written before R09: they name the old path as it was.
    const live = out.filter((l) => !/^(PRIVATE\.md|skills\/jev-control-mode\/reference\/integration\.md):/.test(l));
    assert.deepEqual(live, []);
  });
});

describe("results of the build round", () => {
  it("T2 reports every live metric as unmeasured and used no live session", () => {
    const m = JSON.parse(read("private", "jev-control", "results", "T2", "metrics.json"));
    assert.equal(m.live, "unmeasured");
    assert.equal(m.live_sessions_used, 0);
    assert.equal(m.ledger.lines_before, m.ledger.lines_after);
    assert.equal(m.metrics_live.provider_calls, "unknown");
    for (const v of Object.values(m.metrics_live.orchestrator_tokens)) assert.equal(v, "unmeasured");
    assert.match(read("private", "jev-control", "results", "T2", "summary.md"), /No live session was started/);
  });
});

describe("scope and safety of the change", () => {
  it("new code lives only in private/jev-control/: nothing named jev-control in scripts/", () => {
    assert.deepEqual(readdirSync(join(REPO_ROOT, "scripts")).filter((f) => /control/.test(f)), []);
  });
  it("hooks.json: every hook is the jev-flow adapter (none a control or blocking hook); the only addition is SessionEnd", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json")).hooks;
    const commands = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(commands.length >= 8);
    for (const c of commands) assert.match(c, /jev-flow-hook\.mjs" \w+$/);
    assert.doesNotMatch(JSON.stringify(hooks), /jev-control/);
    assert.match(hooks.PreToolUse[0].matcher, /mcp__\(plugin_jev_\)\?jev__jev_/);
    assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "SessionEnd"]);
    assert.match(hooks.SessionEnd[0].hooks[0].command, /jev-flow-hook\.mjs" SessionEnd$/);
  });
  it("is not registered in the OpenCode plugin", () => {
    assert.doesNotMatch(read("opencode-plugin.js"), /jev-control/);
  });
  it("the upstream files have no uncommitted change", () => {
    const status = execFileSync("git", ["status", "--porcelain", "--", "src", "skills/jev", "README.md", "CHANGELOG.md", "package.json", "package-lock.json", "test", "skills/handoff-verify", "opencode-plugin.js"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(status.trim(), "");
  });
  it("no test starts a real claude process", () => {
    const dir = join(REPO_ROOT, "private", "jev-control", "test");
    const spawnClaude = /(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*(["'`])(?:[^"'`]*\/)?claude\2/;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), spawnClaude, f);
  });
});

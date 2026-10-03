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

describe("the plugin ships jev-control as 0.7.0", () => {
  it("both manifests carry 0.7.0", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    const market = JSON.parse(read(".claude-plugin", "marketplace.json"));
    assert.equal(plugin.version, "0.7.0");
    assert.equal(market.plugins.find((p) => p.name === "jev").version, "0.7.0");
  });
  it("PRIVATE.md documents the version, the section and the new check", () => {
    const text = read("PRIVATE.md");
    assert.match(text, /`0\.7\.0` for the `jev-control` skill/);
    assert.match(text, /^## Jev control$/m);
    assert.match(text, /node --test private\/jev-control\/test\//);
    assert.match(text, /Nothing has been measured live yet/);
  });
});

describe("skill and command", () => {
  const skill = read("skills", "jev-control", "SKILL.md");
  const fm = frontmatter(skill);
  it("is named jev-control with explicit-only triggers in English and Romanian", () => {
    assert.equal(fm.name, "jev-control");
    for (const phrase of ["/jev:jev-control", "let Jev control this session", "lasă Jev să controleze sesiunea", "sesiune controlată de Jev", "Do NOT use for ordinary coding tasks"]) assert.ok(fm.description.includes(phrase), phrase);
    assert.match(fm.description, /ONLY when the user explicitly asks/);
  });
  it("states the strict threshold, the protocol and accepts both tool-name prefixes", () => {
    for (const phrase of ["mcp__jev__*", "mcp__plugin_jev_jev__*", "strictly `>`", "0.95", "(0.5, 1)", "Jev unavailable", "Incomplete:", "25", "action_gather_evidence", "At most **2** expansion rounds", "no meta-decisions", "choose the order yourself", "Run `on` before anything else", "not your own `grep`"]) assert.ok(skill.includes(phrase), phrase);
  });
  it("links its references, and they exist", () => {
    for (const ref of ["protocol", "tools", "integration", "evaluation"]) {
      assert.ok(skill.includes(`reference/${ref}.md`), ref);
      assert.ok(read("skills", "jev-control", "reference", `${ref}.md`).length > 500, ref);
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
  it("the command reads SKILL.md itself (the same-named skill is never returned by the Skill tool) and a natural-language request without arguments runs `on`, not `status` (R03)", () => {
    const text = read("commands", "jev-control.md");
    assert.match(text, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/jev-control\/SKILL\.md`/);
    assert.match(text, /the Skill tool returns this text and never that file/);
    // R04: a refused Read must not end the session; the command names the helper's own usage text.
    assert.match(text, /If the read is refused, do not stop: .*cli\.mjs" help decide` prints the batch format, `help search` the search form/);
    assert.doesNotMatch(text, /Load the `jev-control` skill/);
    // Step 3 tests exactly the line that only hook.mjs emits for a natural-language request (never for a slash command), of the current request.
    const marked = `jev-control was requested by the user ${NATURAL_MARKER.replace(/\.$/, "")}`;
    assert.ok(text.includes(`«${marked}»`), "step 3 quotes the natural-language line of the hook");
    assert.match(text, /With no or unknown arguments: when the prompt hook of the current request put the line «[^»]+» in your context/);
    assert.match(text, /a line from an earlier prompt does not count, and a `\/jev:jev-control` prompt never gets it\), run `on` as above; otherwise run `status` and explain the four commands/);
    assert.doesNotMatch(text, /«jev-control was requested by the user for this session»/, "the line that slash commands also get is not the condition");
  });
  it("jev-done, jev-locate and the locator have explicit control branches", () => {
    for (const f of [["commands", "jev-done.md"], ["commands", "jev-locate.md"], ["agents", "jev-locator.md"]]) assert.match(read(...f), /jev-control/, f.join("/"));
    assert.match(read("agents", "jev-locator.md"), /no lexical fallback/);
    assert.match(read("commands", "jev-done.md"), /strictly above `T`/);
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

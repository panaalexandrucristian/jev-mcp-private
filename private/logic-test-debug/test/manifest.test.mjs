import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

describe("logic-test-debug is wired into the plugin without touching the existing components", () => {
  it("both manifests carry 0.10.2 and keep the MCP server entry", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    const market = JSON.parse(read(".claude-plugin", "marketplace.json"));
    assert.equal(plugin.version, "0.10.2");
    assert.equal(market.plugins.find((p) => p.name === "jev").version, "0.10.2");
    assert.equal(plugin.name, "jev");
    assert.ok(plugin.mcpServers?.jev, "MCP server entry preserved");
  });
  it("leaves hooks/hooks.json untouched: one UserPromptSubmit entry, the same command and the 10 s timeout", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json")).hooks;
    assert.equal(hooks.UserPromptSubmit.length, 1);
    const [entry] = hooks.UserPromptSubmit[0].hooks;
    assert.equal(entry.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-flow-hook.mjs" UserPromptSubmit');
    assert.equal(entry.timeout, 10);
    assert.ok(!read("hooks", "hooks.json").includes("logic-test-debug"), "no second hook command, no SessionStart notice");
  });
  it("loads the new hook by a guarded dynamic import on UserPromptSubmit only, never statically", () => {
    const script = read("scripts", "jev-flow-hook.mjs");
    assert.ok(!/^import .*logic-test-debug/m.test(script), "no static import");
    const block = script.match(/try \{\s*if \(name === "UserPromptSubmit"\) \{[\s\S]*?\} catch \{[\s\S]*?\}/);
    assert.ok(block, "guarded block");
    assert.match(block[0], /await import\("\.\.\/private\/logic-test-debug\/hook\.mjs"\)/);
    assert.match(block[0], /\[logic-test-debug\] activation unavailable/);
    assert.ok(script.indexOf("logic-test-debug/hook.mjs") > script.indexOf("handlePromptCheckHook(name"), "after the other subsystems");
  });
  it("sets the OpenCode extension up in its own try/catch after the flow, without a static import", () => {
    const plugin = read("opencode-plugin.js");
    assert.ok(!/^import .*logic-test-debug/m.test(plugin));
    const flow = plugin.indexOf("setupFlow(ctx)");
    const logic = plugin.indexOf("setupLogicTestDebug(ctx, process.env)");
    assert.ok(flow > 0 && logic > flow);
    assert.match(plugin.slice(flow, logic), /\} catch \(error\) \{[\s\S]*?\[jev-flow\] disabled/, "flow keeps its own catch before the new try");
    assert.match(plugin, /await import\("\.\/private\/logic-test-debug\/opencode\.mjs"\)/);
  });
  it("does not change the jev-flow, jev-control or prompt-check sources", () => {
    for (const file of [["private", "jev-flow", "hook.mjs"], ["private", "jev-flow", "opencode.mjs"], ["private", "jev-control", "hook.mjs"], ["private", "jev-prompt-check", "hook.mjs"]]) {
      assert.ok(!read(...file).includes("logic-test-debug"), file.join("/"));
    }
  });
  it("documents the switch, the bounds and the unverified OpenCode delivery in PRIVATE.md", () => {
    const doc = read("PRIVATE.md");
    assert.match(doc, /JEV_LOGIC_TEST_DEBUG/);
    assert.match(doc, /logic-test-debug/);
    assert.match(doc, /64 KiB/);
    assert.match(doc, /\*\*Not verified\.\*\* On OpenCode 2\.0\.12/);
    assert.match(doc, /node --test private\/logic-test-debug\/test\//);
    assert.match(doc, /`0\.10\.0` for the `logic-test-debug` skill/);
  });
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleControlHook, mergeOutputs, reminder } from "../hook.mjs";
import { controlSessionDir, loadControlState, readBinding, sessionKey, withControlState } from "../state.mjs";
import { HOOK_CLI, controlEnv, makeRepo, run } from "./helpers.mjs";

const SESSION = "hook-session-1";
const hook = (event, input, { env, cwd }) => {
  const r = run(process.execPath, [HOOK_CLI, event], { cwd, env, input: JSON.stringify({ session_id: SESSION, cwd, ...input }) });
  let json = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null;
  } catch {
    json = null;
  }
  return { ...r, json, text: JSON.stringify(json) };
};
const turnOn = (repo, env, patch = {}) => withControlState(controlSessionDir(repo, SESSION, env), (s) => { s.mode = "on"; s.threshold = { value: 0.9, source: "session", since_decision: 0 }; Object.assign(s, patch); });

describe("the control hook: a reminder only, never a block", () => {
  it("with the mode off it adds nothing and the flow behaves as before", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const r = hook("UserPromptSubmit", { prompt: "fix the bug" }, { env, cwd: repo });
    assert.match(r.text, /jev-flow is enabled/);
    assert.doesNotMatch(r.text, /jev-control ON/);
  });
  it("with the mode on, a prompt gets the one-line reminder and the flow's directive stands down (even with JEV_FLOW=on)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const r = hook("UserPromptSubmit", { prompt: "fix the bug" }, { env, cwd: repo });
    assert.equal(env.JEV_FLOW, "on");
    assert.match(r.json.hookSpecificOutput.additionalContext, /^jev-control ON \(T=0\.9\)/);
    assert.doesNotMatch(r.text, /jev-flow is enabled/);
    assert.equal(r.json.decision, undefined);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(r.json.hookSpecificOutput.additionalContext.split("\n").length, 1, "one line");
  });
  it("an ordinary prompt starts a new request: the budget counters restart", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const dir = controlSessionDir(repo, SESSION, env);
    withControlState(dir, (s) => { s.request.seq = 1; s.budget.attempts.helper = 7; });
    hook("UserPromptSubmit", { prompt: "next thing" }, { env, cwd: repo });
    const state = loadControlState(dir);
    assert.equal(state.request.seq, 2);
    assert.equal(state.budget.attempts.helper, 0);
    assert.deepEqual(state.budget.history, [7]);
  });
  it("SessionStart (also after a compaction) re-injects the reminder; a fresh startup switches the mode off", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    assert.match(hook("SessionStart", { source: "compact" }, { env, cwd: repo }).text, /jev-control ON/);
    assert.match(hook("SessionStart", { source: "resume" }, { env, cwd: repo }).text, /jev-control ON/);
    const fresh = hook("SessionStart", { source: "startup" }, { env, cwd: repo });
    assert.doesNotMatch(fresh.text, /jev-control ON/);
    assert.equal(loadControlState(controlSessionDir(repo, SESSION, env)).mode, "off");
  });
  it("a /jev:jev-control prompt binds the session (hash only) and prints no reminder", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    hook("UserPromptSubmit", { prompt: "/jev:jev-control on 0.9" }, { env, cwd: repo });
    const binding = readBinding(repo, env);
    assert.deepEqual(binding, { ok: true, key: sessionKey(SESSION) });
  });
  it("does nothing without a real session identity", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    assert.equal(handleControlHook("UserPromptSubmit", { cwd: repo, prompt: "x" }, env), null);
    assert.equal(handleControlHook("SessionStart", { cwd: repo, session_id: "" }, env), null);
    assert.equal(handleControlHook("PreToolUse", { cwd: repo, session_id: "s" }, env), null);
  });
  it("only SessionStart and UserPromptSubmit are handled: no accounting or blocking hook", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]) {
      assert.equal(handleControlHook(event, { cwd: repo, session_id: SESSION, tool_name: "mcp__jev__jev_noul" }, env), null, event);
    }
  });
  it("runs no Jev call and no test: the hook never touches the MCP server", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    hook("UserPromptSubmit", { prompt: "x" }, { env, cwd: repo });
    hook("SessionStart", { source: "resume" }, { env, cwd: repo });
    assert.equal(run("test", ["-e", env.FAKE_MCP_LOG]).code === 0, false, "the fake server was never started");
  });
});

describe("jev-flow stands down while the control mode is on, but its guard stays", () => {
  const credential = `sk-or-v1-${"a".repeat(40)}`;
  it("the payload guard still denies a credential in a Jev call", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const r = hook("PreToolUse", { tool_name: "mcp__jev__jev_noul", tool_use_id: "t1", tool_input: { propositions: [`leak ${credential}`] } }, { env, cwd: repo });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
  });
  it("the denylist notice still appears at SessionStart", () => {
    const repo = makeRepo({ "a.txt": "a\n", ".jev-flow-denylist": "*\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const r = hook("SessionStart", { source: "resume" }, { env, cwd: repo });
    assert.match(r.text, /denylist disables Jev/);
    assert.match(r.text, /jev-control ON/);
  });
  it("no strict Stop redirect while on; with the mode off the redirect is unchanged", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const base = controlEnv({ extra: { JEV_FLOW_STRICT: "1" } });
    hook("SessionStart", { source: "startup" }, { env: base, cwd: repo });
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const off = hook("Stop", { last_assistant_message: "Done, all fixed.", stop_hook_active: false }, { env: base, cwd: repo });
    assert.equal(off.json?.decision, "block", "the flow's strict redirect applies when the control mode is off");
    turnOn(repo, base);
    const on = hook("Stop", { last_assistant_message: "Done, all fixed.", stop_hook_active: false }, { env: base, cwd: repo });
    assert.equal(on.json, null, "no flow redirect while the control mode is on");
  });
  it("an error in the control hook never breaks the flow hook", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const r = run(process.execPath, [HOOK_CLI, "UserPromptSubmit"], { cwd: repo, env, input: "{not json" });
    assert.equal(r.code, 0);
  });
});

describe("merging outputs", () => {
  it("joins additional context and system messages", () => {
    const a = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "one" } };
    const b = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "two" }, systemMessage: "m" };
    const m = mergeOutputs(a, b);
    assert.equal(m.hookSpecificOutput.additionalContext, "one\ntwo");
    assert.equal(m.systemMessage, "m");
    assert.equal(mergeOutputs(null, b), b);
    assert.equal(mergeOutputs(a, null), a);
    assert.equal(mergeOutputs(null, null), null);
    assert.match(reminder(0.95), /^jev-control ON \(T=0\.95\)/);
  });
});

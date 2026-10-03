import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEV_SCENARIOS } from "../fixtures/scenarios.mjs";
import { NATURAL_MARKER, activation, asksForControl, handleControlHook, mergeOutputs, reminder, resumeText } from "../hook.mjs";
import { PROTOCOL_RULES } from "../rules.mjs";
import { controlSessionDir, ensureSessionCap, loadControlState, sessionKey, verifySessionCap, withControlState } from "../state.mjs";
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
  it("SessionStart after a compaction re-injects the compact rules (R09) and the capability (the same live session)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const r = hook("SessionStart", { source: "compact" }, { env, cwd: repo });
    assert.match(r.text, /jev-control ON/);
    const context = r.json.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(PROTOCOL_RULES), "the rules themselves, not the reminder line");
    assert.match(context, /Load Skill jev:jev-control-mode; else Read \/[^ ]+\/skills\/jev-control-mode\/SKILL\.md; if refused, say so once\./);
    assert.ok(Buffer.byteLength(context) <= 1500, `SessionStart stays within 1500 bytes (${Buffer.byteLength(context)})`);
    const cap = /--session-cap ([0-9a-f]{16}\.[0-9a-f]{32})/.exec(r.text)[1];
    assert.equal(verifySessionCap(repo, cap, env).ok, true);
    assert.equal(loadControlState(controlSessionDir(repo, SESSION, env)).mode, "on");
  });
  it("a fresh startup, a resume, a clear, a fork or an unknown source start with the mode OFF and a rotated capability", () => {
    for (const source of ["startup", "resume", "clear", "fork", undefined, "something-new"]) {
      const repo = makeRepo({ "a.txt": "a\n" });
      const env = controlEnv();
      turnOn(repo, env);
      const dir = controlSessionDir(repo, SESSION, env);
      const before = ensureSessionCap(dir, sessionKey(SESSION));
      const r = hook("SessionStart", source === undefined ? {} : { source }, { env, cwd: repo });
      assert.doesNotMatch(r.text, /jev-control ON/, String(source));
      assert.equal(loadControlState(dir).mode, "off", String(source));
      assert.equal(verifySessionCap(repo, before, env).ok, false, `${source}: the old capability no longer works`);
    }
  });
  it("SessionEnd switches the mode off and removes the capability (also through the plugin adapter); a later resume stays off", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const dir = controlSessionDir(repo, SESSION, env);
    const cap = ensureSessionCap(dir, sessionKey(SESSION));
    for (const reason of ["clear", "resume", "logout", "prompt_input_exit", "other"]) {
      turnOn(repo, env);
      const r = hook("SessionEnd", { reason }, { env, cwd: repo });
      assert.equal(r.code, 0);
      assert.equal(r.json, null, "nothing printed");
      assert.equal(loadControlState(dir).mode, "off", reason);
    }
    assert.equal(verifySessionCap(repo, cap, env).ok, false);
    const resumed = hook("SessionStart", { source: "resume" }, { env, cwd: repo });
    assert.doesNotMatch(resumed.text, /jev-control ON/);
    assert.equal(loadControlState(dir).mode, "off");
  });
  it("SessionEnd of a session that never used the mode creates nothing", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    hook("SessionEnd", { reason: "other" }, { env, cwd: repo });
    assert.equal(run("test", ["-e", join(controlSessionDir(repo, SESSION, env), "state.json")]).code === 0, false);
  });
  it("a /jev:jev-control prompt, or an explicit natural-language request, gets the session capability; an ordinary prompt gets nothing", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const prompt of ["/jev:jev-control on 0.9", "/jev-control status", "Let Jev control this session please", "Jev decides everything from now", "lasă Jev să controleze sesiunea", "lasa Jev sa controleze sesiunea", "vreau o sesiune controlată de Jev", "Jev să ia toate deciziile"]) {
      const r = hook("UserPromptSubmit", { prompt }, { env, cwd: repo });
      const cap = /--session-cap ([0-9a-f]{16}\.[0-9a-f]{32})/.exec(r.text)?.[1];
      assert.ok(cap, prompt);
      assert.deepEqual(verifySessionCap(repo, cap, env), { ok: true, key: sessionKey(SESSION), dir: controlSessionDir(repo, SESSION, env) }, prompt);
      assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /jev-control ON/, "not on yet");
    }
    assert.equal(hook("UserPromptSubmit", { prompt: "please mention Jev in the README" }, { env, cwd: repo }).text.includes("session-cap"), false);
    assert.equal(asksForControl("Jev is a judgment tool"), false);
    assert.equal(asksForControl("/jev:jev-done"), false);
  });
  it("the campaign activation text (D31) asks for the mode with each dev scenario prompt; the baseline prompt alone never does", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const scenario of DEV_SCENARIOS.filter((x) => ["s1-bug-several-files", "s2-ordered-tasks"].includes(x.id))) {
      const dev = `Let Jev control this session.\n\n${scenario.prompt}`;
      assert.equal(asksForControl(dev), true, scenario.id);
      assert.equal(asksForControl(scenario.prompt), false, `${scenario.id}: the baseline prompt is not an activation`);
      const on = hook("UserPromptSubmit", { prompt: dev }, { env, cwd: repo });
      assert.match(on.text, /--session-cap [0-9a-f]{16}\.[0-9a-f]{32}/, scenario.id);
    }
    const other = makeRepo({ "a.txt": "a\n" });
    assert.equal(hook("UserPromptSubmit", { prompt: DEV_SCENARIOS[0].prompt }, { env, cwd: other }).text.includes("session-cap"), false);
  });
  it("R09: a natural-language request tells the model to run `on` first and carries the rules and the way to load the skill; a command prompt does not demand `on`", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const natural = hook("UserPromptSubmit", { prompt: "Let Jev control this session.\n\nWhere is the delay computed?" }, { env, cwd: repo }).json.hookSpecificOutput.additionalContext;
    assert.match(natural, /Do first: node "[^"]+\/private\/jev-control\/cli\.mjs" on --session-cap [0-9a-f]{16}\.[0-9a-f]{32} --priorities/);
    assert.ok(natural.includes(PROTOCOL_RULES), "the compact rules are in the activation text");
    assert.match(natural, /Load Skill jev:jev-control-mode; else Read \/[^ ]+\/skills\/jev-control-mode\/SKILL\.md; if refused, say so once\./);
    assert.doesNotMatch(natural, /the Skill tool returns only the command text|skills\/jev-control\/SKILL/);
    const root = /node "([^"]+)\/private\/jev-control\/cli\.mjs"/.exec(natural)[1];
    assert.ok(existsSync(join(root, "skills", "jev-control-mode", "SKILL.md")), "the named SKILL.md exists");
    assert.ok(natural.includes(`requested by the user ${NATURAL_MARKER}`), "the natural-language marker");
    for (const prompt of ["/jev:jev-control", "/jev:jev-control foo", "/jev:jev-control off", "/jev:jev-control status", "/jev:jev-control on"]) {
      const text = hook("UserPromptSubmit", { prompt }, { env, cwd: repo }).json.hookSpecificOutput.additionalContext;
      assert.doesNotMatch(text, /Do first|cli\.mjs" on/, prompt);
      assert.doesNotMatch(text, /in natural language/, `${prompt}: a slash command never carries the natural-language marker`);
      assert.match(text, /requested by the user for this session\./, prompt);
      assert.match(text, /--session-cap /, prompt);
      assert.ok(text.includes(PROTOCOL_RULES), `${prompt}: a slash command's activation also carries the rules (D46)`);
    }
    for (const scenario of DEV_SCENARIOS.filter((x) => ["s1-bug-several-files", "s3-ambiguous-search"].includes(x.id))) {
      const text = hook("UserPromptSubmit", { prompt: `Let Jev control this session.\n\n${scenario.prompt}` }, { env, cwd: repo }).json.hookSpecificOutput.additionalContext;
      assert.ok(text.includes(NATURAL_MARKER), scenario.id);
    }
    // A later prompt of a session whose mode is on gets the reminder, never a repeated marker (a marker of an earlier request must not be reusable).
    const live = makeRepo({ "a.txt": "a\n" });
    turnOn(live, env);
    const again = hook("UserPromptSubmit", { prompt: "Let Jev control this session." }, { env, cwd: live }).json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(again, /in natural language/);
    assert.match(again, /^jev-control ON/);
    assert.match(reminder(0.95), /protocol: Skill jev:jev-control-mode/);
    assert.doesNotMatch(reminder(0.95), /see the jev-control skill/);
  });
  it("a mode command is not a new request: the budget keeps counting", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    turnOn(repo, env);
    const dir = controlSessionDir(repo, SESSION, env);
    withControlState(dir, (s) => { s.request.seq = 3; s.budget.attempts.helper = 7; });
    const r = hook("UserPromptSubmit", { prompt: "/jev:jev-control status" }, { env, cwd: repo });
    assert.match(r.text, /jev-control ON/);
    assert.equal(loadControlState(dir).request.seq, 3);
    assert.equal(loadControlState(dir).budget.attempts.helper, 7);
  });
  it("two sessions in one repository get different capabilities; neither proves the other", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const capOf = (session) => {
      const r = run(process.execPath, [HOOK_CLI, "UserPromptSubmit"], { cwd: repo, env, input: JSON.stringify({ session_id: session, cwd: repo, prompt: "/jev:jev-control on" }) });
      return /--session-cap ([0-9a-f]{16}\.[0-9a-f]{32})/.exec(r.stdout)[1];
    };
    const a = capOf("session-A");
    const b = capOf("session-B");
    assert.notEqual(a, b);
    assert.equal(verifySessionCap(repo, a, env).key, sessionKey("session-A"));
    assert.equal(verifySessionCap(repo, b, env).key, sessionKey("session-B"));
    assert.equal(verifySessionCap(repo, `${sessionKey("session-B")}.${a.split(".")[1]}`, env).ok, false);
  });
  it("does nothing without a real session identity", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    assert.equal(handleControlHook("UserPromptSubmit", { cwd: repo, prompt: "x" }, env), null);
    assert.equal(handleControlHook("SessionStart", { cwd: repo, session_id: "" }, env), null);
    assert.equal(handleControlHook("PreToolUse", { cwd: repo, session_id: "s" }, env), null);
  });
  it("only SessionStart, UserPromptSubmit and SessionEnd are handled: no accounting or blocking hook", () => {
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
    hook("SessionStart", { source: "compact" }, { env, cwd: repo });
    hook("SessionEnd", { reason: "other" }, { env, cwd: repo });
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
    const r = hook("SessionStart", { source: "compact" }, { env, cwd: repo });
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

describe("R09: the compact protocol at activation, at SessionStart and in the reminder (D46)", () => {
  const CAP = "0123456789abcdef.0123456789abcdef0123456789abcdef";
  const LONG_ROOT = `/${"r".repeat(119)}`;
  const REQUIRED = ["decide --file", "search", "strictly above T", "fixed protocol", "ask the user", "Incomplete:", "approve", "/jev:jev-done", "done --claims", "help decide|search|done"];
  it("the shared rules name every rule, exception and the interactive/headless split", () => {
    for (const phrase of REQUIRED) assert.ok(PROTOCOL_RULES.includes(phrase), phrase);
    for (const phrase of ["explicit user instructions", "exact user-named paths", "permission prompts", "a one-variant step", "rg/glob only list candidates", "at most twice", "headless end with Incomplete:", "only an accepted gate permits it"]) assert.ok(PROTOCOL_RULES.includes(phrase), phrase);
    assert.ok(Buffer.byteLength(PROTOCOL_RULES) < 900);
  });
  it("activation, natural and slash, carries the rules byte for byte and stays within 1500 bytes with a 120-byte plugin root and a real capability", () => {
    assert.equal(Buffer.byteLength(LONG_ROOT), 120);
    const natural = activation(CAP, true, LONG_ROOT);
    const slash = activation(CAP, false, LONG_ROOT);
    for (const [name, text] of [["natural", natural], ["slash", slash]]) {
      assert.ok(text.includes(PROTOCOL_RULES), name);
      assert.ok(text.includes(`${LONG_ROOT}/skills/jev-control-mode/SKILL.md`), `${name}: the exact fallback path`);
      assert.ok(text.includes(`--session-cap ${CAP}`) && text.includes("also in subagent prompts."), `${name}: the capability`);
      assert.ok(Buffer.byteLength(text) <= 1500, `${name} is ${Buffer.byteLength(text)} bytes`);
    }
    assert.ok(natural.includes(`${LONG_ROOT}/private/jev-control/cli.mjs" on --session-cap ${CAP}`), "the natural line keeps the `on` step");
    assert.ok(natural.includes(NATURAL_MARKER) && !slash.includes(NATURAL_MARKER), "the marker only on the natural-language activation");
    assert.ok(!slash.includes("Do first"), "a slash command does not demand `on`: the command runs it");
  });
  it("SessionStart after a compaction: the rules, the way to the skill and the capability, within 1500 bytes at the longest threshold", () => {
    const text = resumeText("0.99999", CAP, LONG_ROOT);
    assert.ok(text.includes(PROTOCOL_RULES));
    assert.ok(text.includes(`${LONG_ROOT}/skills/jev-control-mode/SKILL.md`) && text.includes(`--session-cap ${CAP}`));
    assert.ok(Buffer.byteLength(text) <= 1500, `${Buffer.byteLength(text)} bytes`);
    assert.match(text, /^jev-control ON \(T=0\.99999\)\./);
  });
  it("the per-prompt reminder stays one line of at most 400 bytes with a real capability and does not repeat the rules", () => {
    const text = reminder(0.99999, CAP);
    assert.ok(Buffer.byteLength(text) <= 400, `${Buffer.byteLength(text)} bytes`);
    assert.equal(text.includes("\n"), false);
    assert.ok(text.includes(`--session-cap ${CAP}`) && text.includes("protocol: Skill jev:jev-control-mode"));
    assert.equal(text.includes(PROTOCOL_RULES), false);
  });
  it("the control hook's own output blocks nothing and stays within 1500 bytes (the jev-flow text merged after it by the adapter is not part of it)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const prompt of ["Let Jev control this session.", "/jev:jev-control on"]) {
      const out = handleControlHook("UserPromptSubmit", { session_id: SESSION, cwd: repo, prompt }, env);
      assert.equal(out.decision, undefined, prompt);
      assert.equal(out.hookSpecificOutput.permissionDecision, undefined, prompt);
      const text = out.hookSpecificOutput.additionalContext;
      assert.ok(Buffer.byteLength(text) <= 1500, `${prompt}: ${Buffer.byteLength(text)} bytes`);
      assert.ok(text.includes(PROTOCOL_RULES), prompt);
    }
  });

});

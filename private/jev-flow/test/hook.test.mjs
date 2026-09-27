import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { prepareGateBatch } from "../gate-batch.mjs";
import { HINTS } from "../hook.mjs";
import { parseDenylist } from "../paths.mjs";
import { computeSnapshot, sessionDir } from "../state.mjs";
import { acceptedGate, appendTranscriptCall, HOOK_CLI, makeRepo, run, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

const FAKE_AWS = "AKIA" + "QRSTUVWXYZ012345";
const GATE = "mcp__plugin_jev_jev__jev_gate";
const GATE_INPUT = { request: "r", diff: "d", claims: ["npm test passed"], evidence: [{ id: "test-log", text: "ok" }] };

function hook(event, input, env) {
  const result = run(process.execPath, [HOOK_CLI, event], { env, input: JSON.stringify(input), cwd: input.cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function session(files = { "src/app.ts": "export const widget = 1;\n" }, envExtra = {}) {
  const repo = makeRepo(files);
  const env = sandboxEnv(envExtra);
  const id = `s-${Math.random().toString(36).slice(2)}`;
  const transcript = join(tempDir("jev-flow-transcript-"), "t.jsonl");
  writeFileSync(transcript, "");
  const base = { session_id: id, cwd: repo, transcript_path: transcript };
  const call = (event, extra = {}) => hook(event, { ...base, hook_event_name: event, ...extra }, env);
  call("SessionStart", { source: "startup" });
  call("UserPromptSubmit", { prompt: "do the task" });
  /** A full gate call: PreToolUse, the transcript records, PostToolUse. */
  const gate = (id, result, { input = GATE_INPUT, pre = true, between = null } = {}) => {
    if (pre) call("PreToolUse", { tool_name: GATE, tool_use_id: id, tool_input: input });
    if (between) between();
    appendTranscriptCall(transcript, { id, name: GATE, input, result });
    call("PostToolUse", { tool_name: GATE, tool_use_id: id, tool_input: input, tool_response: [{ type: "text", text: JSON.stringify(result) }] });
  };
  const stop = (message = "Done.", extra = {}) => call("Stop", { stop_hook_active: false, last_assistant_message: message, ...extra });
  return { repo, env, id, transcript, call, gate, stop };
}

const read = (repo, file = "src/app.ts", extra = {}) => ({ tool_name: "Read", tool_input: { file_path: join(repo, file), ...extra }, tool_response: {} });

describe("hooks: exploration hints", () => {
  it("repeats the exploration directive at 4, 8, 12 calls and resets on a new prompt (F1)", () => {
    const { repo, call } = session({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n", "d.ts": "d\n", "e.ts": "e\n" });
    assert.equal(call("PostToolUse", read(repo, "a.ts")), null);
    assert.equal(call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "x" } }), null);
    assert.equal(call("PostToolUse", { tool_name: "Bash", tool_input: { command: "cd src && rg widget" } }), null);
    const hint = call("PostToolUse", read(repo, "b.ts"));
    assert.equal(hint.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(hint.hookSpecificOutput.additionalContext, /4 exploration calls.*\/jev:jev-locate/);
    assert.equal(call("PostToolUse", read(repo, "c.ts")), null, "no hint between thresholds");
    assert.equal(call("PostToolUse", { tool_name: "Bash", tool_input: { command: "python3 x.py" } }), null, "unknown shell is not exploration");
    assert.equal(call("PostToolUse", read(repo, "d.ts")), null);
    assert.equal(call("PostToolUse", read(repo, "e.ts")), null);
    assert.match(call("PostToolUse", { tool_name: "Glob", tool_input: { pattern: "*.ts" } }).hookSpecificOutput.additionalContext, /8 exploration calls/);
    for (let i = 0; i < 3; i++) call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: `y${i}` } });
    assert.match(call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "z" } }).hookSpecificOutput.additionalContext, /12 exploration calls/);
    call("UserPromptSubmit", { prompt: "next" });
    for (const f of ["a.ts", "b.ts", "c.ts"]) assert.equal(call("PostToolUse", read(repo, f)), null);
    assert.ok(call("PostToolUse", read(repo, "d.ts")));
  });

  it("injects the route directive at SessionStart and on every prompt, without the prompt asking for the flow (F1)", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const env = sandboxEnv();
    const base = { session_id: "s-directive", cwd: repo };
    const start = hook("SessionStart", { ...base, hook_event_name: "SessionStart", source: "startup" }, env);
    assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(start.hookSpecificOutput.additionalContext, HINTS.directive());
    assert.match(HINTS.directive(), /load the jev-flow skill/);
    assert.match(HINTS.directive(), /jev-locator subagent \(\/jev:jev-locate <question>\)/);
    assert.match(HINTS.directive(), /\/jev:jev-done/);
    for (const prompt of ["fix the crash in the settings screen", "and the other one"]) {
      const out = hook("UserPromptSubmit", { ...base, hook_event_name: "UserPromptSubmit", prompt }, env);
      assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.equal(out.hookSpecificOutput.additionalContext, HINTS.directive());
    }
  });

  it("a repeated re-read and a threshold on the same event give one combined message", () => {
    const { repo, call } = session();
    call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "x" } });
    call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 }));
    call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 }));
    const out = call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 }));
    assert.match(out.hookSpecificOutput.additionalContext, /re-read twice[\s\S]*4 exploration calls/);
  });

  it("hints on the second re-read of the same range with the same hash", () => {
    const { repo, call } = session();
    assert.equal(call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 })), null);
    assert.equal(call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 })), null);
    const hint = call("PostToolUse", read(repo, "src/app.ts", { offset: 1, limit: 20 }));
    assert.match(hint.hookSpecificOutput.additionalContext, /re-read twice/);
  });

  it("a changed hash is not a redundant re-read", () => {
    const { repo, call } = session();
    call("PostToolUse", read(repo));
    writeFiles(repo, { "src/app.ts": "export const widget = 2;\n" });
    call("PostToolUse", read(repo));
    writeFiles(repo, { "src/app.ts": "export const widget = 3;\n" });
    assert.equal(call("PostToolUse", read(repo)), null);
  });

  it("never hints inside a subagent", () => {
    const { repo, call } = session();
    for (let i = 0; i < 6; i++) {
      assert.equal(call("PostToolUse", { ...read(repo), agent_id: "agent-1", agent_type: "jev:jev-locator" }), null);
    }
  });

  it("hints real checks and /jev:jev-done once after the first edit", () => {
    const { call } = session();
    const hint = call("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "src/app.ts" } });
    assert.match(hint.hookSpecificOutput.additionalContext, /\/jev:jev-done/);
    assert.equal(call("PostToolUse", { tool_name: "Write", tool_input: { file_path: "src/b.ts" } }), null);
  });
});

describe("hooks: JEV_FLOW=off (F1 opt-out)", () => {
  it("sends no directive, hints, Stop notice or strict redirect, even with JEV_FLOW_STRICT=1", () => {
    const repo = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
    const env = sandboxEnv({ JEV_FLOW: "off", JEV_FLOW_STRICT: "1" });
    const base = { session_id: "s-off", cwd: repo, transcript_path: join(tempDir(), "t.jsonl") };
    const call = (event, extra = {}) => hook(event, { ...base, hook_event_name: event, ...extra }, env);
    assert.equal(call("SessionStart", { source: "startup" }), null);
    assert.equal(call("UserPromptSubmit", { prompt: "do it" }), null);
    for (let i = 0; i < 8; i++) assert.equal(call("PostToolUse", read(repo, i % 2 ? "a.ts" : "b.ts")), null);
    assert.equal(call("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }), null);
    writeFiles(repo, { "a.ts": "changed\n" });
    assert.equal(call("Stop", { stop_hook_active: false, last_assistant_message: "Done." }), null);
  });

  it("keeps the data guard: credentials and a disabled repo are still refused", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const env = sandboxEnv({ JEV_FLOW: "off" });
    const out = hook("PreToolUse", { session_id: "s-off2", cwd: repo, hook_event_name: "PreToolUse", tool_name: "mcp__jev__jev_verify", tool_input: { claims: ["x"], evidence: `k=${FAKE_AWS}` } }, env);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
});

describe("hooks: jev-locator model (F2)", () => {
  const agentCall = (subagent_type, extra = {}) => ({ tool_name: "Agent", tool_use_id: `a-${Math.random()}`, tool_input: { subagent_type, description: "locate", prompt: "where is x", ...extra } });

  it("leaves the call alone when JEV_FLOW_LOCATOR_MODEL is unset (the frontmatter's haiku applies)", () => {
    const { call } = session();
    assert.equal(call("PreToolUse", agentCall("jev:jev-locator")), null);
  });

  it("sets the model through updatedInput for haiku, sonnet and opus, only for jev-locator", () => {
    for (const model of ["haiku", "sonnet", "opus"]) {
      const { call } = session(undefined, { JEV_FLOW_LOCATOR_MODEL: model });
      for (const type of ["jev:jev-locator", "jev-locator"]) {
        const out = call("PreToolUse", agentCall(type));
        assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
        assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "no permission decision: the normal permission flow stays");
        assert.equal(out.hookSpecificOutput.updatedInput.model, model);
        assert.equal(out.hookSpecificOutput.updatedInput.subagent_type, type);
        assert.equal(out.hookSpecificOutput.updatedInput.prompt, "where is x");
      }
      assert.equal(call("PreToolUse", agentCall("general-purpose")), null, "other agents are untouched");
      assert.equal(call("PreToolUse", { ...agentCall("jev:jev-locator"), tool_name: "Task" }).hookSpecificOutput.updatedInput.model, model);
    }
  });

  it("inherit maps the parent model recorded at SessionStart", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const env = sandboxEnv({ JEV_FLOW_LOCATOR_MODEL: "inherit" });
    const base = { session_id: "s-inherit", cwd: repo };
    hook("SessionStart", { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" }, env);
    const out = hook("PreToolUse", { ...base, hook_event_name: "PreToolUse", ...agentCall("jev:jev-locator") }, env);
    assert.equal(out.hookSpecificOutput.updatedInput.model, "opus");
  });

  it("an invalid value or an unknown parent is reported once and changes nothing", () => {
    const { call } = session(undefined, { JEV_FLOW_LOCATOR_MODEL: "gpt-9" });
    const first = call("PreToolUse", agentCall("jev:jev-locator"));
    assert.match(first.systemMessage, /must be haiku, sonnet, opus or inherit/);
    assert.equal(first.hookSpecificOutput, undefined);
    assert.equal(call("PreToolUse", agentCall("jev:jev-locator")), null, "reported once per session");
    const inherit = session(undefined, { JEV_FLOW_LOCATOR_MODEL: "inherit" });
    assert.match(inherit.call("PreToolUse", agentCall("jev:jev-locator")).systemMessage, /parent model is unknown/);
  });
});

describe("hooks: PreToolUse guard", () => {
  it("denies Jev calls when the denylist disables the repo", () => {
    const { call } = session({ ".jev-flow-denylist": "*\n", "a.ts": "a\n" });
    const out = call("PreToolUse", { tool_name: "mcp__plugin_jev_jev__jev_find", tool_input: { query: "q", candidates: [{ id: "c0", text: "t" }] } });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Jev disabled for this repo; gate not evaluated/);
  });

  it("denies payloads with an unredacted credential without echoing it", () => {
    const { call } = session();
    for (const secret of [`key=${FAKE_AWS}`, "password=huntertwo", "storePassword=123456", "api_key=allalphabeticsecretvalue"]) {
      const out = call("PreToolUse", { tool_name: "mcp__jev__jev_verify", tool_input: { claims: ["ok"], evidence: [{ id: "log", text: secret }] } });
      assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", secret);
      assert.ok(!JSON.stringify(out).includes(secret.split("=")[1]), secret);
    }
  });

  it("allows clean and already-redacted payloads", () => {
    const { call } = session();
    assert.equal(call("PreToolUse", { tool_name: GATE, tool_use_id: "g0", tool_input: { ...GATE_INPUT, evidence: "key=[REDACTED:aws_access_key]" } }), null);
    assert.equal(call("PreToolUse", { tool_name: "mcp__jev__jev_verify", tool_input: { claims: ["token = options.token is read"], evidence: "max_tokens=1000" } }), null);
    assert.equal(call("PreToolUse", { tool_name: "Bash", tool_use_id: "b0", tool_input: { command: "npm test" } }), null);
  });
});

describe("hooks: a refusal survives state persistence failures", () => {
  const ENOSPC_PRELOAD = new URL("./fixtures/enospc-preload.mjs", import.meta.url).href;
  const cases = {
    credential: { files: { "a.ts": "a\n" }, input: { ...GATE_INPUT, evidence: [{ id: "log", text: `key=${FAKE_AWS}` }] } },
    "opt-out": { files: { ".jev-flow-denylist": "*\n", "a.ts": "a\n" }, input: GATE_INPUT },
  };
  /** Run PreToolUse through the CLI adapter, optionally with extra node flags. */
  const preToolUse = (repo, env, input, nodeFlags = []) =>
    run(process.execPath, [...nodeFlags, HOOK_CLI, "PreToolUse"], {
      env,
      cwd: repo,
      input: JSON.stringify({ session_id: "s-persist", cwd: repo, hook_event_name: "PreToolUse", tool_name: GATE, tool_use_id: "g-denied", tool_input: input }),
    });
  const assertDenied = (result, code, label) => {
    assert.equal(result.code, 0, label);
    assert.ok(result.stdout.trim(), `${label}: stdout must carry the decision`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", label);
    assert.match(out.systemMessage, new RegExp(`could not be recorded in the session state \\(${code}\\); the state was not updated`), label);
    assert.ok(!result.stdout.includes(FAKE_AWS) && !result.stderr.includes(FAKE_AWS), `${label}: no secret in the output`);
  };

  for (const [name, { files, input }] of Object.entries(cases)) {
    it(`${name}: EACCES while creating the cache still returns permissionDecision deny`, () => {
      const repo = makeRepo(files);
      const env = sandboxEnv();
      mkdirSync(env.JEV_FLOW_CACHE_DIR, { recursive: true });
      chmodSync(env.JEV_FLOW_CACHE_DIR, 0o500);
      try {
        assertDenied(preToolUse(repo, env, input), "EACCES", name);
      } finally {
        chmodSync(env.JEV_FLOW_CACHE_DIR, 0o700);
      }
      assert.deepEqual(readdirSync(env.JEV_FLOW_CACHE_DIR), [], "nothing was persisted");
    });

    it(`${name}: ENOSPC while saving still returns permissionDecision deny`, () => {
      const repo = makeRepo(files);
      const env = sandboxEnv();
      assertDenied(preToolUse(repo, env, input, ["--import", ENOSPC_PRELOAD]), "ENOSPC", name);
      const dir = sessionDir(repo, "s-persist", env);
      assert.ok(!readdirSync(dir).includes("state.json"), "no state was saved");
      assert.ok(!readdirSync(dir).includes("lock"), "the lock was released");
    });
  }

  it("a refusal whose record succeeds carries no degradation notice", () => {
    const repo = makeRepo(cases.credential.files);
    const out = JSON.parse(preToolUse(repo, sandboxEnv(), cases.credential.input).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(out.systemMessage, undefined);
  });
});

describe("hooks: gate acceptance", () => {
  const change = (repo, v) => writeFiles(repo, { "src/app.ts": `${v}\n` });

  it("a complete accepted gate on the current snapshot and request satisfies strict Stop", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    change(s.repo, "v3");
    assert.equal(s.stop().decision, "block", "a later edit invalidates it");
  });

  it("incomplete, contradicted, review, escalate or invalid results are never accepted", () => {
    const variants = {
      bare_auto: { tool: "jev_gate", action: "auto" },
      truncated: acceptedGate({ truncated: true, reason_codes: ["incomplete_context", "accepted"] }),
      contradicted: acceptedGate({
        verification: { ...acceptedGate().verification, summary: { verified: 0, contradicted: 1, unsupported: 0, needs_review: 1, invalid_response: 0 }, results: [{ claim: "x", verdict: "contradicted", confidence: 0.6, action: "review" }] },
      }),
      review: acceptedGate({ action: "review", reason_codes: ["review_required"] }),
      escalate: acceptedGate({ action: "escalate", reason_codes: ["review_escalated"] }),
      invalid: acceptedGate({ reason_codes: ["invalid_response"] }),
    };
    for (const [name, result] of Object.entries(variants)) {
      const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
      change(s.repo, "v2");
      s.gate("g", result);
      assert.equal(s.stop()?.decision, "block", name);
    }
  });

  it("a later non-accepted gate prevents reusing an earlier approval", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    s.gate("g2", acceptedGate({ action: "escalate", reason_codes: ["review_escalated"] }), { input: { ...GATE_INPUT, claims: ["other claim"] } });
    assert.equal(s.stop().decision, "block");
  });

  it("a gate without its PreToolUse snapshot, or whose snapshot changed during the call, is not accepted", () => {
    const a = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(a.repo, "v2");
    a.gate("g1", acceptedGate(), { pre: false });
    assert.equal(a.stop().decision, "block", "missing pre-call snapshot is unknown, not stable");
    const b = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(b.repo, "v2");
    b.gate("g1", acceptedGate(), { between: () => change(b.repo, "v3") });
    assert.equal(b.stop().decision, "block", "changed during the gate call");
  });

  it("a new request without file changes does not reuse the previous request's approval", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    s.call("UserPromptSubmit", { prompt: "another request" });
    assert.equal(s.stop().decision, "block");
  });

  it("the transcript must hold the same call: different input or a missing result is not accepted", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.call("PreToolUse", { tool_name: GATE, tool_use_id: "g9", tool_input: GATE_INPUT });
    appendTranscriptCall(s.transcript, { id: "g9", name: GATE, input: { ...GATE_INPUT, claims: ["tampered"] }, result: acceptedGate() });
    s.call("PostToolUse", { tool_name: GATE, tool_use_id: "g9", tool_input: GATE_INPUT, tool_response: [] });
    assert.equal(s.stop().decision, "block");
    const t = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(t.repo, "v2");
    t.call("PreToolUse", { tool_name: GATE, tool_use_id: "g8", tool_input: GATE_INPUT });
    t.call("PostToolUse", { tool_name: GATE, tool_use_id: "g8", tool_input: GATE_INPUT, tool_response: [{ type: "text", text: JSON.stringify(acceptedGate()) }] });
    assert.equal(t.stop().decision, "block", "the hook's own tool_response is not trusted; only the transcript is");
  });

  it("a later gate call that started but never finished supersedes an accepted one", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    s.call("PreToolUse", { tool_name: GATE, tool_use_id: "g2", tool_input: { ...GATE_INPUT, claims: ["retry"] } });
    assert.equal(s.stop().decision, "block", "pending / cancelled attempt");
  });

  it("a failed gate call (PostToolUseFailure) supersedes an accepted one", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    s.call("PreToolUse", { tool_name: GATE, tool_use_id: "g2", tool_input: GATE_INPUT });
    s.call("PostToolUseFailure", { tool_name: GATE, tool_use_id: "g2", tool_input: GATE_INPUT, error: "transport" });
    assert.equal(s.stop().decision, "block");
  });

  it("a gate refused locally supersedes an earlier accepted one, recorded before the refusal", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    const denied = s.call("PreToolUse", { tool_name: GATE, tool_use_id: "g2", tool_input: { ...GATE_INPUT, evidence: [{ id: "log", text: `key=${FAKE_AWS}` }] } });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    // No PostToolUse or PostToolUseFailure follows a denied call.
    const stateText = readFileSync(join(sessionDir(s.repo, s.id, s.env), "state.json"), "utf8");
    const record = JSON.parse(stateText).gates.find((g) => g.id === "g2");
    assert.deepEqual({ failed: record.failed, denied: record.denied, before: record.before, after: record.after }, { failed: true, denied: true, before: "unknown", after: "unknown" });
    assert.ok(!stateText.includes(FAKE_AWS), "metadata only: the refused payload is not stored");
    assert.equal(s.stop().decision, "block");
  });

  it("the refusal does not depend on the state write, and the transcript still supersedes the old gate", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    const lock = join(sessionDir(s.repo, s.id, s.env), "lock");
    writeFileSync(lock, `${process.pid}:held-by-test`);
    const input = { ...GATE_INPUT, evidence: [{ id: "log", text: `key=${FAKE_AWS}` }] };
    const denied = s.call("PreToolUse", { tool_name: GATE, tool_use_id: "g2", tool_input: input });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny", "denied even though the state is busy");
    rmSync(lock);
    // Claude Code writes the refused tool_use and an error tool_result to the transcript.
    appendTranscriptCall(s.transcript, { id: "g2", name: GATE, input, result: "denied by hook", isError: true });
    assert.equal(s.stop().decision, "block");
  });

  it("a later gate call in the transcript supersedes an accepted one even without hook events", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate());
    assert.equal(s.stop(), null);
    appendTranscriptCall(s.transcript, { id: "g3", name: "mcp__jev__jev_gate", input: GATE_INPUT, result: "cancelled", isError: true });
    assert.equal(s.stop().decision, "block");
  });

  it("a gate started in one request and finished in the next does not count for either", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate(), { between: () => s.call("UserPromptSubmit", { prompt: "interrupting request" }) });
    assert.equal(s.stop().decision, "block");
  });

  it("the gate result must cover exactly the call's claims", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g1", acceptedGate(), { input: { ...GATE_INPUT, claims: ["npm test passed", "lint passed"] } });
    assert.equal(s.stop().decision, "block");
  });

  it("a restart discards earlier gates", () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    s.gate("g2", acceptedGate());
    assert.equal(s.stop(), null);
    s.call("SessionStart", { source: "resume" });
    assert.equal(s.stop().decision, "block");
  });
});

describe("hooks: Stop", () => {
  it("default mode notifies once per snapshot and never blocks", () => {
    const { repo, stop } = session();
    assert.equal(stop(), null, "no code change");
    writeFiles(repo, { "src/app.ts": "export const widget = 2;\n" });
    const first = stop();
    assert.match(first.systemMessage, /no accepted jev_gate/);
    assert.equal(first.decision, undefined);
    assert.equal(stop(), null);
  });

  it("strict mode blocks once per snapshot and honors stop_hook_active and allowed endings", () => {
    const { repo, stop } = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    writeFiles(repo, { "src/app.ts": "v2\n" });
    assert.equal(stop("Done.", { stop_hook_active: true }).decision, undefined);
    const blocked = stop("The work is incomplete in places.");
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /\/jev:jev-done/);
    const again = stop();
    assert.equal(again.decision, undefined);
    assert.match(again.systemMessage, /already used/);
    for (const message of ["Incomplete: checks not run.", "Should I run the migration?", "Tests pass.\nJev unavailable; gate not evaluated"]) {
      writeFiles(repo, { "src/app.ts": `v-${message.length}\n` });
      assert.equal(stop(message), null, message);
    }
  });

  it("subagent stops are ignored", () => {
    const { repo, stop } = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    writeFiles(repo, { "src/app.ts": "v2\n" });
    assert.equal(stop("Done.", { agent_id: "a1" }), null);
  });

  it("a held state lock yields an unknown result: no block, no approval, no write", () => {
    const { repo, env, id, stop } = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    writeFiles(repo, { "src/app.ts": "v2\n" });
    const dir = sessionDir(repo, id, env);
    const before = readFileSync(join(dir, "state.json"), "utf8");
    writeFileSync(join(dir, "lock"), `${process.pid}:held-by-test`);
    const out = stop();
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /state is busy/);
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  });
});

describe("hooks: real checks", () => {
  it("records test runs per command, and a failed rerun is recorded as failed", () => {
    const s = session();
    const cmd = { command: "npm test" };
    s.call("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: cmd });
    s.call("PostToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: cmd, tool_response: { stdout: "ok", exitCode: 0 } });
    s.call("PreToolUse", { tool_name: "Bash", tool_use_id: "b2", tool_input: cmd });
    s.call("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "b2", tool_input: cmd, error: "exit 1" });
    const state = JSON.parse(readFileSync(join(sessionDir(s.repo, s.id, s.env), "state.json"), "utf8"));
    assert.equal(state.tests.length, 2);
    assert.equal(state.tests[0].cmd, state.tests[1].cmd);
    assert.deepEqual([state.tests[0].exit, state.tests[0].failed], [0, false]);
    assert.deepEqual([state.tests[1].exit, state.tests[1].failed], [null, true]);
    assert.deepEqual(state.pending, {});
  });
});

describe("hooks: robustness and state", () => {
  it("disabled repos get one SessionStart notice", () => {
    const repo = makeRepo({ ".jev-flow-denylist": "*\n" });
    const out = hook("SessionStart", { session_id: "x", cwd: repo, source: "startup" }, sandboxEnv());
    assert.match(out.hookSpecificOutput.additionalContext, /Jev disabled for this repo; gate not evaluated/);
  });

  it("does nothing outside a git work tree and survives malformed input", () => {
    const dir = tempDir();
    assert.equal(hook("Stop", { session_id: "x", cwd: dir, last_assistant_message: "Done." }, sandboxEnv({ JEV_FLOW_STRICT: "1" })), null);
    const bad = run(process.execPath, [HOOK_CLI, "PostToolUse"], { input: "{not json", env: sandboxEnv() });
    assert.equal(bad.code, 0);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /\[jev-flow\] hook error/);
  });

  it("persists correlation metadata only: no verdicts, code, payloads or secrets", () => {
    const secretLine = `const leaked = "${FAKE_AWS}"; // unique-code-marker`;
    const s = session({ "src/app.ts": `${secretLine}\n` });
    s.call("PostToolUse", read(s.repo));
    s.gate("g3", acceptedGate(), { input: { ...GATE_INPUT, request: "unique-request-marker" } });
    s.call("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "npm test" } });
    s.call("PostToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "npm test" }, tool_response: { stdout: "unique-log-marker" } });
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(s.env.JEV_FLOW_CACHE_DIR);
    assert.ok(files.length >= 1);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const marker of [FAKE_AWS, "unique-code-marker", "unique-request-marker", "unique-log-marker", "leaked", '"auto"', "accepted", "verified", '"action"', '"valid"']) {
        assert.ok(!text.includes(marker), `${marker} found in ${file}`);
      }
    }
    const state = JSON.parse(readFileSync(join(sessionDir(s.repo, s.id, s.env), "state.json"), "utf8"));
    assert.deepEqual(Object.keys(state.gates[0]).sort(), ["after", "before", "boot", "failed", "id", "input", "req", "ts"]);
    assert.deepEqual(Object.keys(state.tests[0]).sort(), ["after", "before", "boot", "cmd", "exit", "failed", "req", "ts"]);
    assert.equal(state.tests[0].exit, null, "Claude's Bash response has no exit code: unknown, never success");
  });
});

describe("hooks: partitioned gate batches at Stop (F3)", () => {
  const change = (repo, v) => writeFiles(repo, { "src/app.ts": `${v}\n` });
  const body = (n) => Array.from({ length: 900 }, (_, i) => `+const line${n}_${i} = "${"x".repeat(40)}";`).join("\n");
  const DIFF = ["a", "b"].map((f) => [`diff --git a/${f}.ts b/${f}.ts`, `--- a/${f}.ts`, `+++ b/${f}.ts`, "@@ -0,0 +1,900 @@", body(f)].join("\n")).join("\n") + "\n";
  const CLAIMS = [
    { text: "a.ts adds 900 constants", evidence: ["hunk-1"] },
    { text: "b.ts adds 900 constants", evidence: ["hunk-2"] },
  ];
  const prepare = (repo, claims = CLAIMS) =>
    prepareGateBatch({ request: "add the constants", diff: DIFF, claims }, { denylist: parseDenylist(""), snapshot: computeSnapshot(repo).hash });
  const strictSession = () => {
    const s = session({ "src/app.ts": "v1\n" }, { JEV_FLOW_STRICT: "1" });
    change(s.repo, "v2");
    const batch = prepare(s.repo);
    assert.equal(batch.ok, true, JSON.stringify(batch.problems));
    assert.ok(batch.calls.length >= 2);
    const send = (calls, prefix, resultFor = (input) => acceptedGate({}, input.claims)) =>
      calls.forEach((c, i) => s.gate(`${prefix}${i + 1}`, resultFor(c.input), { input: c.input }));
    return { ...s, batch, send };
  };

  it("all parts accepted on the current snapshot satisfy strict Stop", () => {
    const s = strictSession();
    s.send(s.batch.calls, "p");
    assert.equal(s.stop(), null);
  });

  it("only some parts, or only the last part, do not", () => {
    const s = strictSession();
    s.send(s.batch.calls.slice(-1), "last");
    assert.equal(s.stop().decision, "block", "the latest gate alone is not the batch");
  });

  it("an escalated part blocks; a later accepted retry of that part completes the batch", () => {
    const s = strictSession();
    const n = s.batch.calls.length;
    s.send(s.batch.calls, "p", (input) => (input === s.batch.calls[n - 1].input ? acceptedGate({ action: "escalate", reason_codes: ["review_escalated"] }, input.claims) : acceptedGate({}, input.claims)));
    assert.equal(s.stop().decision, "block");
    s.send(s.batch.calls.slice(-1), "retry");
    assert.equal(s.stop("Done again."), null);
  });

  it("a snapshot change after the parts invalidates the batch", () => {
    const s = strictSession();
    s.send(s.batch.calls, "p");
    change(s.repo, "v3");
    assert.equal(s.stop().decision, "block");
  });

  it("a part whose claims were altered breaks the manifest", () => {
    const s = strictSession();
    const calls = s.batch.calls.map((c, i) => (i === 0 ? { ...c, input: { ...c.input, claims: ["forged claim"] } } : c));
    s.send(calls, "p");
    assert.equal(s.stop().decision, "block");
  });

  // Each scenario uses a fresh session: its first Stop is the verdict (block =
  // not accepted, null = accepted), independent of earlier notices.
  const allClaims = (batch) => batch.calls.flatMap((c) => c.input.claims).filter((c, i, a) => a.indexOf(c) === i);

  it("a later single gate must cover every claim and the whole patch of the batch it follows", () => {
    const fewer = strictSession();
    fewer.send(fewer.batch.calls.slice(0, 1), "p");
    fewer.gate("single", acceptedGate({}, ["a.ts adds 900 constants"]), { input: { ...GATE_INPUT, diff: DIFF, claims: ["a.ts adds 900 constants"] } });
    assert.equal(fewer.stop().decision, "block", "drops the batch's other claims");

    const otherDiff = strictSession();
    otherDiff.send(otherDiff.batch.calls.slice(0, 1), "p");
    const all = allClaims(otherDiff.batch);
    otherDiff.gate("claims-only", acceptedGate({}, all), { input: { ...GATE_INPUT, claims: all } });
    assert.equal(otherDiff.stop().decision, "block", "same claims on another diff do not cover the batch's patch");

    const full = strictSession();
    full.send(full.batch.calls.slice(0, 1), "p");
    full.gate("full", acceptedGate({}, allClaims(full.batch)), { input: { ...GATE_INPUT, diff: DIFF, claims: allClaims(full.batch) } });
    assert.equal(full.stop(), null, "same claims and the same whole diff");
  });

  it("a replacement for only a.ts with the same claims, after only the first part of an a.ts+b.ts batch, is not accepted", () => {
    const onlyAFor = (s) =>
      prepareGateBatch(
        { request: "add the constants", diff: DIFF.slice(0, DIFF.indexOf("diff --git a/b.ts")), claims: CLAIMS.map((c) => ({ ...c, evidence: ["hunk-1"] })) },
        { denylist: parseDenylist(""), snapshot: computeSnapshot(s.repo).hash },
      );
    const batchA = strictSession();
    batchA.send(batchA.batch.calls.slice(0, 1), "p");
    const onlyA = onlyAFor(batchA);
    assert.equal(onlyA.ok, true, JSON.stringify(onlyA.problems));
    batchA.send(onlyA.calls, "a");
    assert.equal(batchA.stop().decision, "block", "a batch for a.ts only drops b.ts");

    const singleA = strictSession();
    singleA.send(singleA.batch.calls.slice(0, 1), "p");
    const texts = CLAIMS.map((c) => c.text);
    singleA.gate("singleA", acceptedGate({}, texts), { input: { ...GATE_INPUT, diff: onlyAFor(singleA).calls[0].input.diff, claims: texts } });
    assert.equal(singleA.stop().decision, "block", "a single gate for a.ts only is not accepted either");
  });

  it("a complete a.ts+b.ts replacement counts only once all its parts are accepted", () => {
    const s = strictSession();
    s.send(s.batch.calls.slice(0, 1), "p");
    const rebuilt = prepare(s.repo, [{ text: "a.ts adds 900 constants", evidence: ["hunk-1"] }, { text: "b.ts adds 900 constants", evidence: ["hunk-2", "file:a.ts"] }]);
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.problems));
    assert.notEqual(rebuilt.batch.id, s.batch.batch.id);
    s.send(rebuilt.calls.slice(0, 1), "r");
    assert.equal(s.stop().decision, "block", "only the first part of the replacement");
    s.send(rebuilt.calls.slice(1), "rr");
    assert.equal(s.stop("Done again."), null);
  });

  it("parts from two preparations are not combined", () => {
    const s = strictSession();
    const rebuilt = prepare(s.repo, [{ text: "a.ts adds 900 constants", evidence: ["hunk-1"] }, { text: "b.ts adds 900 constants", evidence: ["hunk-2", "file:a.ts"] }]);
    s.send(s.batch.calls.slice(0, 1), "p");
    s.send(rebuilt.calls.slice(1), "q");
    assert.equal(s.stop().decision, "block");
  });

  it("a gate outside the batch between its parts interleaves it", () => {
    const s = strictSession();
    s.send(s.batch.calls.slice(0, 1), "p");
    s.gate("other", acceptedGate());
    s.send(s.batch.calls.slice(1), "q");
    assert.equal(s.stop().decision, "block");
  });

  it("a later gate call in the transcript after the batch supersedes it", () => {
    const s = strictSession();
    s.send(s.batch.calls, "p");
    appendTranscriptCall(s.transcript, { id: "late", name: GATE, input: GATE_INPUT, result: "cancelled", isError: true });
    assert.equal(s.stop().decision, "block");
  });

  it("the state keeps only batch metadata: no claims, diffs or verdicts", () => {
    const s = strictSession();
    s.send(s.batch.calls, "p");
    const text = readFileSync(join(sessionDir(s.repo, s.id, s.env), "state.json"), "utf8");
    const gates = JSON.parse(text).gates.filter((g) => g.batch);
    assert.equal(gates.length, s.batch.calls.length);
    assert.ok(gates.every((g) => g.batch === s.batch.batch.id && Number.isInteger(g.part) && g.of === s.batch.calls.length));
    for (const needle of ["adds 900 constants", "const linea_1", "auto", "verified"]) assert.ok(!text.includes(needle), needle);
  });
});

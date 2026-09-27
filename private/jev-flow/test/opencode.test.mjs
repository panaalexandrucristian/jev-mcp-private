import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin from "../../../opencode-plugin.js";
import { JevFlowPolicyError, setupFlow } from "../opencode.mjs";
import { acceptedGate, makeRepo, sandboxEnv, writeFiles } from "./helpers.mjs";

const FAKE_AWS = "AKIA" + "ZYXWVUTSRQPONMLK";

function makeEditor(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
    add: (item) => entries.set(item.id ?? item.name, item),
    set: (id, value) => entries.set(id, value),
    update: (id, fn) => {
      const item = entries.get(id) ?? { id, name: id };
      fn(item);
      entries.set(id, item);
    },
    remove: (id) => entries.delete(id),
  };
}

/** A simulated V2 context. It checks our logic, not OpenCode's runtime. */
function fakeContext({ directory, skills = {}, agents = {}, existingCommands = [], omit = [] } = {}) {
  const editors = { mcp: makeEditor(), skill: makeEditor(skills), agent: makeEditor(agents), command: makeEditor() };
  const hooks = { tool: {}, session: {} };
  const prompts = [];
  const registration = () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory },
    mcp: { transform: async (cb) => (cb(editors.mcp), registration()) },
    skill: { transform: async (cb) => (cb(editors.skill), registration()) },
    agent: { transform: async (cb) => (cb(editors.agent), registration()) },
    command: {
      transform: async (cb) => (cb({ add: (def) => editors.command.set(def.name, def) }), registration()),
      list: async () => existingCommands.map((name) => ({ name })),
    },
    tool: { hook: async (name, cb) => ((hooks.tool[name] = cb), registration()) },
    session: {
      hook: async (name, cb) => ((hooks.session[name] = cb), registration()),
      prompt: async (input) => prompts.push(input),
    },
  };
  for (const path of omit) {
    const [head, tail] = path.split(".");
    if (tail) delete ctx[head][tail];
    else delete ctx[head];
  }
  return { ctx, editors, hooks, prompts };
}

function captureLog() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

describe("setupFlow with a full V2-shaped context", () => {
  it("registers the skill, agent, commands and hooks without diagnostics", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors, hooks } = fakeContext({ directory: repo });
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    assert.deepEqual(lines, []);
    assert.deepEqual(report.degraded, []);
    const skill = editors.skill.get("jev-flow");
    assert.equal(skill.name, "jev-flow");
    assert.match(skill.description, /^Adaptive coding workflow/);
    assert.ok(!skill.content.includes("${CLAUDE_PLUGIN_ROOT}"));
    const agent = editors.agent.get("jev-locator");
    assert.equal(agent.mode, "subagent");
    assert.match(agent.system, /read-only code locator/);
    assert.equal(agent.permissions, undefined, "permissions are deliberately not set");
    assert.deepEqual([...editors.command.entries.keys()].sort(), ["jev-done", "jev-locate"]);
    assert.deepEqual(Object.keys(hooks.tool).sort(), ["execute.after", "execute.before"]);
    assert.deepEqual(Object.keys(hooks.session).sort(), ["context", "prompt"]);
  });

  it("commands send their text into the invoking session and keep delivery", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors, prompts } = fakeContext({ directory: repo });
    await setupFlow(ctx, { log: () => {}, env: sandboxEnv() });
    await editors.command.get("jev-locate").execute({ sessionID: "ses_1", prompt: { text: "where is flag parsing" }, delivery: "queue" });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionID, "ses_1");
    assert.equal(prompts[0].delivery, "queue");
    assert.match(prompts[0].text, /where is flag parsing/);
    assert.ok(!prompts[0].text.includes("$ARGUMENTS"));
  });

  it("strict /jev-done states the gate status for the current snapshot", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors, prompts } = fakeContext({ directory: repo });
    await setupFlow(ctx, { log: () => {}, env: sandboxEnv({ JEV_FLOW_STRICT: "1" }) });
    await editors.command.get("jev-done").execute({ sessionID: "ses_2", prompt: { text: "" }, delivery: "steer" });
    assert.match(prompts[0].text, /Strict mode \(JEV_FLOW_STRICT=1\)\. Gate status from the jev-flow plugin: no jev_gate in this request/);
  });

  it("preserves existing entries and reports collisions", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const mine = { id: "jev-flow", name: "jev-flow", description: "user's own" };
    const agent = { id: "jev-locator", name: "jev-locator", mode: "primary" };
    const { ctx, editors } = fakeContext({ directory: repo, skills: { "jev-flow": mine }, agents: { "jev-locator": agent }, existingCommands: ["jev-done"] });
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    assert.equal(editors.skill.get("jev-flow"), mine);
    assert.equal(editors.agent.get("jev-locator").mode, "primary");
    assert.deepEqual([...editors.command.entries.keys()], ["jev-locate"]);
    assert.deepEqual(report.collisions.sort(), ["agent:jev-locator", "command:jev-done", "skill:jev-flow"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /existing entries preserved/);
  });
});

describe("setupFlow degradation", () => {
  it("an empty context degrades with a single diagnostic and never throws", async () => {
    const { lines, log } = captureLog();
    const report = await setupFlow({}, { log, env: sandboxEnv() });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /degraded: skill.transform .*agent.transform .*command.transform .*tool.hook .*session.hook/);
    assert.deepEqual(report.registered, []);
  });

  it("a partial context keeps the available features", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors } = fakeContext({ directory: repo, omit: ["agent", "tool", "session.hook"] });
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    assert.ok(editors.skill.get("jev-flow"));
    assert.equal(editors.command.entries.size, 2);
    assert.equal(lines.length, 1);
    assert.deepEqual(report.degraded.map((d) => d.capability).sort(), ["agent.transform", "session.hook", "tool.hook"]);
  });

  it("a throwing capability is isolated", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors } = fakeContext({ directory: repo });
    ctx.agent.transform = async () => {
      throw new Error("boom");
    };
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    assert.ok(editors.skill.get("jev-flow"));
    assert.deepEqual(report.degraded, [{ capability: "agent.transform", reason: "boom" }]);
    assert.equal(lines.length, 1);
  });

  it("does not register commands when collisions cannot be checked", async () => {
    for (const variant of ["absent", "throwing", "unrecognized"]) {
      const repo = makeRepo({ "a.ts": "a\n" });
      const { ctx, editors } = fakeContext({ directory: repo });
      if (variant === "absent") delete ctx.command.list;
      if (variant === "throwing") ctx.command.list = async () => {
        throw new Error("nope");
      };
      if (variant === "unrecognized") ctx.command.list = async () => ({ weird: true });
      const { lines, log } = captureLog();
      const report = await setupFlow(ctx, { log, env: sandboxEnv() });
      assert.equal(editors.command.entries.size, 0, variant);
      assert.ok(report.degraded.some((d) => d.capability === "command.transform" && /collision/.test(d.reason)), variant);
      assert.equal(lines.length, 1, variant);
    }
  });

  it("does not register commands without ctx.session.prompt", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors } = fakeContext({ directory: repo, omit: ["session.prompt"] });
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    assert.equal(editors.command.entries.size, 0);
    assert.ok(report.degraded.some((d) => /session.prompt/.test(d.reason)));
    assert.equal(lines.length, 1);
  });

  it("logs a single diagnostic across setup and runtime problems", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors } = fakeContext({ directory: repo, agents: { "jev-locator": { id: "jev-locator" } } });
    ctx.session.prompt = async () => {
      throw new Error("prompt failed");
    };
    const { lines, log } = captureLog();
    const report = await setupFlow(ctx, { log, env: sandboxEnv() });
    await editors.command.get("jev-done").execute({ sessionID: "s", prompt: { text: "" }, delivery: "queue" });
    await editors.command.get("jev-locate").execute({ sessionID: "s", prompt: { text: "" }, delivery: "queue" });
    assert.equal(lines.length, 1, "setup collision note only; runtime problems go to the report");
    assert.deepEqual(report.runtime.map((r) => r.key).sort(), ["command.jev-done", "command.jev-locate"]);
  });
});

describe("gate status and strict /jev-done", () => {
  async function setup(env = sandboxEnv({ JEV_FLOW_STRICT: "1" })) {
    const repo = makeRepo({ "a.ts": "v1\n" });
    const fake = fakeContext({ directory: repo });
    const report = await setupFlow(fake.ctx, { log: () => {}, env });
    const done = async () => {
      fake.prompts.length = 0;
      await fake.editors.command.get("jev-done").execute({ sessionID: "s1", prompt: { text: "" }, delivery: "queue" });
      return fake.prompts[0].text;
    };
    const input = { request: "r", diff: "d", claims: ["npm test passed"], evidence: "e" };
    const start = (id) => fake.hooks.tool["execute.before"]({ tool: "jev:jev_gate", sessionID: "s1", id, input });
    const finish = (id, result, status = "completed") =>
      fake.hooks.tool["execute.after"]({ tool: "jev:jev_gate", sessionID: "s1", id, input, status, result: { output: JSON.stringify(result) } });
    const gate = (id, result, status = "completed") => {
      start(id);
      finish(id, result, status);
    };
    return { repo, fake, report, done, gate, start, finish };
  }

  it("reports an accepted gate only for a complete result on the current snapshot and request", async () => {
    const s = await setup();
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    writeFiles(s.repo, { "a.ts": "v2\n" });
    assert.match(await s.done(), /no jev_gate in this request/);
    s.gate("g1", { tool: "jev_gate", action: "auto" });
    assert.match(await s.done(), /not an accepted, complete result/);
    s.gate("g2", acceptedGate());
    assert.match(await s.done(), /an accepted jev_gate exists for the current snapshot and request/);
    writeFiles(s.repo, { "a.ts": "v3\n" });
    assert.match(await s.done(), /the code changed after the last jev_gate/);
    s.gate("g3", acceptedGate());
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    assert.match(await s.done(), /belongs to another request/);
  });

  it("unfinished, failed and cross-request attempts supersede an accepted gate", async () => {
    const s = await setup();
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    s.gate("g1", acceptedGate());
    assert.match(await s.done(), /an accepted jev_gate exists/);
    s.start("g2");
    assert.match(await s.done(), /has not finished/);
    s.finish("g2", acceptedGate(), "error");
    assert.match(await s.done(), /the last jev_gate call failed/);
    s.start("g3");
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    s.finish("g3", acceptedGate());
    assert.match(await s.done(), /belongs to another request/);
    s.gate("g4", acceptedGate({}, ["different claim"]));
    assert.match(await s.done(), /not an accepted, complete result/, "result claims must match the call's claims");
  });

  it("a gate refused in execute.before supersedes an accepted one without execute.after", async () => {
    const s = await setup();
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    s.gate("g1", acceptedGate());
    assert.match(await s.done(), /an accepted jev_gate exists/);
    const refused = { request: "r", diff: "d", claims: ["npm test passed"], evidence: `key=${FAKE_AWS}` };
    assert.throws(() => s.fake.hooks.tool["execute.before"]({ tool: "jev:jev_gate", sessionID: "s1", id: "g2", input: refused }), JevFlowPolicyError);
    // No execute.after is delivered for the refused call.
    const text = await s.done();
    assert.match(text, /refused by the jev-flow policy/);
    assert.ok(!text.includes(FAKE_AWS));
  });

  it("a restart (new setup) starts with an unknown gate; nothing is persisted", async () => {
    const env = sandboxEnv({ JEV_FLOW_STRICT: "1" });
    const s = await setup(env);
    await s.fake.hooks.session.prompt({ sessionID: "s1" });
    s.gate("g1", acceptedGate());
    assert.match(await s.done(), /an accepted jev_gate exists/);
    const again = fakeContext({ directory: s.repo });
    await setupFlow(again.ctx, { log: () => {}, env });
    await again.editors.command.get("jev-done").execute({ sessionID: "s1", prompt: { text: "" }, delivery: "queue" });
    assert.match(again.prompts[0].text, /no jev_gate in this request/);
  });

  it("strict /jev-done is an instruction, reported as not enforced", async () => {
    const s = await setup();
    const text = await s.done();
    assert.match(text, /Strict mode \(JEV_FLOW_STRICT=1\)\. Gate status from the jev-flow plugin:/);
    assert.ok(s.report.limitations.some((l) => /nothing technically blocks a completion message/.test(l)));
  });
});

describe("tool and session hooks", () => {
  it("execute.before throws the policy error for a disabled repo and for credentials", async () => {
    const off = makeRepo({ ".jev-flow-denylist": "*\n" });
    const a = fakeContext({ directory: off });
    await setupFlow(a.ctx, { log: () => {}, env: sandboxEnv() });
    assert.throws(() => a.hooks.tool["execute.before"]({ tool: "jev:jev_gate", input: {} }), JevFlowPolicyError);
    assert.doesNotThrow(() => a.hooks.tool["execute.before"]({ tool: "read", input: {} }));

    const repo = makeRepo({ "a.ts": "a\n" });
    const b = fakeContext({ directory: repo });
    await setupFlow(b.ctx, { log: () => {}, env: sandboxEnv() });
    assert.throws(
      () => b.hooks.tool["execute.before"]({ tool: "jev:jev_verify", input: { claims: ["x"], evidence: `k=${FAKE_AWS}` } }),
      (error) => error instanceof JevFlowPolicyError && /aws_access_key/.test(error.message) && !error.message.includes(FAKE_AWS),
    );
    assert.doesNotThrow(() => b.hooks.tool["execute.before"]({ tool: "jev:jev_verify", input: { claims: ["x"], evidence: "clean" } }));
  });

  it("queues one exploration hint per request into system[], never messages", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, hooks } = fakeContext({ directory: repo });
    await setupFlow(ctx, { log: () => {}, env: sandboxEnv() });
    const after = hooks.tool["execute.after"];
    const context = (agent = "build") => {
      const input = { sessionID: "s1", agent, system: [], messages: [{ role: "user", content: "hi" }] };
      hooks.session.context(input);
      return input;
    };
    await hooks.session.prompt({ sessionID: "s1" });
    for (let i = 0; i < 3; i++) after({ tool: "read", sessionID: "s1", agent: "build", input: {}, status: "completed" });
    assert.equal(context().system.length, 0);
    after({ tool: "bash", sessionID: "s1", agent: "build", input: { command: "rg foo" }, status: "completed" });
    const withHint = context();
    assert.equal(withHint.system.length, 1);
    assert.match(withHint.system[0].text, /\/jev-locate/);
    assert.equal(withHint.messages.length, 1);
    assert.equal(context().system.length, 0, "delivered once");
    for (let i = 0; i < 6; i++) after({ tool: "read", sessionID: "s2", agent: "jev-locator", input: {}, status: "completed" });
    const child = { sessionID: "s2", agent: "jev-locator", system: [], messages: [] };
    hooks.session.context(child);
    assert.equal(child.system.length, 0, "no hints inside the locator");
  });
});

describe("re-read hint", () => {
  it("hints on the second re-read of the same range with the same content", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, hooks } = fakeContext({ directory: repo });
    await setupFlow(ctx, { log: () => {}, env: sandboxEnv() });
    await hooks.session.prompt({ sessionID: "s1" });
    const read = () => hooks.tool["execute.after"]({ tool: "read", sessionID: "s1", agent: "build", input: { filePath: `${repo}/a.ts`, offset: 1, limit: 10 }, status: "completed" });
    const context = () => {
      const input = { sessionID: "s1", agent: "build", system: [], messages: [] };
      hooks.session.context(input);
      return input.system;
    };
    read();
    read();
    assert.deepEqual(context(), []);
    read();
    const system = context();
    assert.equal(system.length, 1);
    assert.match(system[0].text, /re-read twice/);
  });
});

describe("opencode-plugin.js keeps the existing jev registration", () => {
  it("registers the jev MCP server and skill exactly as before, then the flow", async () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const { ctx, editors } = fakeContext({ directory: repo });
    const warn = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(line);
    try {
      await plugin.setup(ctx);
    } finally {
      console.warn = warn;
    }
    assert.equal(plugin.id, "jev");
    assert.deepEqual(editors.mcp.get("jev"), { type: "local", command: ["npx", "-y", "--package=@jkudish/jev-mcp@latest", "jev-mcp"] });
    const jev = editors.skill.get("jev");
    assert.equal(jev.name, "jev");
    assert.match(jev.location, /skills\/jev\/SKILL\.md$/);
    assert.ok(editors.skill.get("jev-flow"));
    assert.deepEqual(warnings, []);
  });

  it("a context with only mcp and skill still registers jev and logs one flow diagnostic", async () => {
    const editors = { mcp: makeEditor(), skill: makeEditor() };
    const ctx = {
      mcp: { transform: async (cb) => cb(editors.mcp) },
      skill: { transform: async (cb) => cb(editors.skill) },
    };
    const warn = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(line);
    try {
      await plugin.setup(ctx);
    } finally {
      console.warn = warn;
    }
    assert.ok(editors.mcp.get("jev"));
    assert.ok(editors.skill.get("jev"));
    assert.ok(editors.skill.get("jev-flow"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[jev-flow\] degraded:/);
  });
});

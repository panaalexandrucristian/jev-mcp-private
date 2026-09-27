import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { callWithRetry, DEFAULT_MCP_COMMAND, mcpCommand, McpConfigError, McpStdioClient, openJev, PROTOCOL_VERSION, resolveJevEnv } from "../mcp-client.mjs";
import { FAKE_MCP_SERVER, sandboxEnv, tempDir } from "./helpers.mjs";

const fakeCommand = [process.execPath, FAKE_MCP_SERVER];
const logFile = () => join(tempDir("jev-flow-mcp-log-"), "calls.jsonl");
const readLog = (path) => {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function client(mode, extra = {}, limits = {}) {
  const log = logFile();
  const env = sandboxEnv({ FAKE_MCP_MODE: mode, FAKE_MCP_LOG: log, ...extra });
  return { c: new McpStdioClient({ command: fakeCommand, env, limits }), log };
}

describe("mcp-client: configuration and credentials", () => {
  it("uses the manifest command by default and JEV_FLOW_MCP_COMMAND as a JSON argv array", () => {
    assert.deepEqual(DEFAULT_MCP_COMMAND, ["npx", "-y", "--package=@jkudish/jev-mcp@latest", "jev-mcp"]);
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
    assert.deepEqual([manifest.mcpServers.jev.command, ...manifest.mcpServers.jev.args], [...DEFAULT_MCP_COMMAND]);
    assert.deepEqual(mcpCommand({}), [...DEFAULT_MCP_COMMAND]);
    assert.deepEqual(mcpCommand({ JEV_FLOW_MCP_COMMAND: '["node","/x/server.js","--flag"]' }), ["node", "/x/server.js", "--flag"]);
    for (const bad of ["node server.js", "[]", '["node", 3]', '{"a":1}', '["", "x"]']) {
      assert.throws(() => mcpCommand({ JEV_FLOW_MCP_COMMAND: bad }), McpConfigError, bad);
    }
  });

  it("chooses openrouter when JEV_PROVIDER is missing and OPENROUTER_API_KEY is set; nothing without credentials", () => {
    const or = resolveJevEnv({ OPENROUTER_API_KEY: "sk-or-x" });
    assert.equal(or.ok, true);
    assert.equal(or.env.JEV_PROVIDER, "openrouter");
    assert.equal(resolveJevEnv({ OPENROUTER_API_KEY: "sk-or-x", JEV_PROVIDER: "typesafe" }).env.JEV_PROVIDER, "typesafe");
    assert.equal(resolveJevEnv({ TYPESAFE_API_KEY: "t" }).env.JEV_PROVIDER, undefined, "other providers keep the server's auto rule");
    assert.equal(resolveJevEnv({ JEV_API_KEY: "k", JEV_API_BASE_URL: "http://x" }).ok, true);
    assert.equal(resolveJevEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }).ok, true);
    assert.equal(resolveJevEnv({ AI_GATEWAY_API_KEY: "g" }).ok, true);
    for (const env of [{}, { JEV_PROVIDER: "openrouter" }, { JEV_API_KEY: "k" }, { CLOUDFLARE_API_TOKEN: "t" }, { OPENROUTER_API_KEY: "  " }]) {
      assert.equal(resolveJevEnv(env).ok, false, JSON.stringify(env));
    }
  });

  it("openJev spawns nothing without credentials and passes JEV_PROVIDER=openrouter to the server", async () => {
    const log = logFile();
    const none = await openJev(sandboxEnv({ JEV_FLOW_MCP_COMMAND: JSON.stringify(fakeCommand), FAKE_MCP_LOG: log }));
    assert.deepEqual([none.ok, none.unavailable], [false, true]);
    assert.deepEqual(readLog(log), [], "the server was never started");
    const bad = await openJev(sandboxEnv({ OPENROUTER_API_KEY: "sk-or-fake", JEV_FLOW_MCP_COMMAND: "node x" }));
    assert.equal(bad.config, true);
    const jev = await openJev(sandboxEnv({ OPENROUTER_API_KEY: "sk-or-fake", JEV_FLOW_MCP_COMMAND: JSON.stringify(fakeCommand), FAKE_MCP_LOG: log }));
    assert.equal(jev.ok, true);
    assert.equal(jev.provider, "openrouter");
    await jev.client.close();
    const init = readLog(log).find((r) => r.method === "initialize");
    assert.equal(init.provider, "openrouter");
    assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  });
});

describe("mcp-client: protocol over a fake stdio server", () => {
  it("performs initialize, notifications/initialized and tools/call, and parses the Jev result", async () => {
    const { c, log } = client("accepted");
    const init = await c.connect();
    assert.equal(init.ok, true);
    assert.equal(init.serverInfo.name, "fake-jev");
    const reply = await c.callTool("jev_gate", { request: "r", diff: "d", claims: ["a claim"], evidence: [{ id: "e", text: "t" }] });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.result.verification.results.map((r) => r.claim), ["a claim"]);
    await c.close();
    assert.deepEqual(readLog(log).map((r) => r.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(c.child.exitCode, 0, "closing stdin ends the server");
  });

  it("reassembles fragmented messages and ignores non-JSON noise", async () => {
    for (const mode of ["fragment", "noise"]) {
      const { c } = client(mode);
      assert.equal((await c.connect()).ok, true, mode);
      const reply = await c.callTool("jev_rerank", { query: "q", candidates: [{ id: "c0", text: "a" }, { id: "c1", text: "b" }], top_k: 5 });
      assert.equal(reply.ok, true, mode);
      assert.deepEqual(reply.result.ranked.map((r) => r.id), ["c1", "c0"]);
      await c.close();
    }
  });

  it("reports isError as tool_error, unknown tools as JSON-RPC errors, and never leaks raw stderr", async () => {
    const { c } = client("tool_error");
    await c.connect();
    const reply = await c.callTool("jev_gate", { claims: ["x"] });
    assert.deepEqual([reply.ok, reply.kind], [false, "tool_error"]);
    assert.match(reply.message, /upstream 500/);
    const unknown = await c.callTool("jev_nope", {});
    assert.deepEqual([unknown.ok, unknown.kind], [false, "tool_error"]);
    await c.close();
    assert.doesNotMatch(c.stderrSummary(), /sk-or-v1-abcdef/, "stderr tail is redacted");
  });

  it("reports a crash (EOF) and a timeout as transport failures and ends the child", async () => {
    const crash = client("crash").c;
    await crash.connect();
    const r1 = await crash.callTool("jev_gate", { claims: ["x"] });
    assert.deepEqual([r1.ok, r1.kind], [false, "transport"]);
    assert.match(r1.message, /exited \(code 3/);
    assert.doesNotMatch(r1.message, /sk-or-v1-abcdef/);
    await crash.close();

    const hang = client("hang", {}, { callTimeoutMs: 300, killGraceMs: 200 }).c;
    await hang.connect();
    const r2 = await hang.callTool("jev_gate", { claims: ["x"] });
    assert.deepEqual([r2.ok, r2.kind], [false, "transport"]);
    assert.match(r2.message, /timed out after 300 ms/);
    await hang.close();
    assert.ok(hang.child.exitCode !== null || hang.child.signalCode !== null, "the hung server was ended");

    const hangInit = client("hang_init", {}, { initTimeoutMs: 300, killGraceMs: 200 }).c;
    const r3 = await hangInit.connect();
    assert.deepEqual([r3.ok, r3.kind], [false, "transport"]);
    await hangInit.close();

    const badInit = client("bad_init").c;
    const r4 = await badInit.connect();
    assert.deepEqual([r4.ok, r4.kind], [false, "invalid_response"]);
    await badInit.close();

    const missing = new McpStdioClient({ command: ["/nonexistent/jev-mcp-binary"], env: sandboxEnv() });
    const r5 = await missing.connect();
    assert.deepEqual([r5.ok, r5.kind], [false, "transport"]);
  });

  it("retries once with identical input after invalid_response, never more", async () => {
    const { c, log } = client("accepted", { FAKE_MCP_FAIL_FIRST: "1" });
    await c.connect();
    const args = { request: "r", diff: "d", claims: ["c1"], evidence: [{ id: "e", text: "t" }] };
    const reply = await callWithRetry(c, "jev_gate", args);
    assert.equal(reply.ok, true);
    assert.equal(reply.attempts, 2);
    await c.close();
    const calls = readLog(log).filter((r) => r.method === "tools/call");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, calls[1].args, "the retry sends the identical input");

    const always = client("invalid");
    await always.c.connect();
    const r2 = await callWithRetry(always.c, "jev_gate", args);
    assert.equal(r2.attempts, 2);
    assert.equal(r2.result?.status, "invalid_response");
    await always.c.close();
    assert.equal(readLog(always.log).filter((r) => r.method === "tools/call").length, 2);
  });

  it("retries a semantically invalid result once with identical input: malformed then valid, malformed twice", async () => {
    const args = { request: "r", diff: "d", claims: ["c1"], evidence: [{ id: "e", text: "t" }] };
    const invalid = (result) => result?.review === undefined;
    for (const [malformed, ok, calls] of [["first", true, 2], ["always", false, 2]]) {
      const state = join(tempDir("jev-flow-state-"), "s.json");
      const { c, log } = client("accepted", { FAKE_MCP_MALFORMED: malformed, FAKE_MCP_STATE: state });
      await c.connect();
      const reply = await callWithRetry(c, "jev_gate", args, { invalid });
      await c.close();
      assert.equal(reply.ok, ok, malformed);
      assert.equal(reply.attempts, calls, malformed);
      if (!ok) assert.equal(reply.kind, "invalid_response");
      const sent = readLog(log).filter((r) => r.method === "tools/call");
      assert.equal(sent.length, calls, `${malformed}: exact number of calls`);
      assert.deepEqual(sent[0].args, sent[1].args, "identical input");
    }
    // A valid result is never retried, even if a later one would differ.
    const { c, log } = client("escalate");
    await c.connect();
    const reply = await callWithRetry(c, "jev_gate", args, { invalid });
    await c.close();
    assert.deepEqual([reply.ok, reply.attempts], [true, 1]);
    assert.equal(readLog(log).filter((r) => r.method === "tools/call").length, 1);
  });

  it("retries a transport failure on a new connection, or reports that the retry was not executed", async () => {
    const args = { request: "r", diff: "d", claims: ["c1"], evidence: [{ id: "e", text: "t" }] };
    const run = async (crash) => {
      const state = join(tempDir("jev-flow-state-"), "s.json");
      const log = logFile();
      const jev = await openJev(sandboxEnv({ OPENROUTER_API_KEY: "sk-or-fake", JEV_FLOW_MCP_COMMAND: JSON.stringify(fakeCommand), FAKE_MCP_LOG: log, FAKE_MCP_CRASH: crash, FAKE_MCP_STATE: state }));
      const reply = await callWithRetry(jev, "jev_gate", args);
      await jev.close();
      return { reply, calls: readLog(log).filter((r) => r.method === "tools/call").length, inits: readLog(log).filter((r) => r.method === "initialize").length };
    };
    const once = await run("once");
    assert.deepEqual([once.reply.ok, once.reply.attempts, once.calls, once.inits], [true, 2, 2, 2], "reconnected and retried once");
    const always = await run("always");
    assert.deepEqual([always.reply.ok, always.reply.kind, always.reply.attempts, always.calls], [false, "transport", 2, 2]);
    const dead = await run("once_then_dead");
    assert.deepEqual([dead.reply.ok, dead.reply.attempts, dead.calls], [false, 1, 1], "only one call was actually sent");
    assert.match(dead.reply.retry, /^not_executed: reconnect failed/);
    // A bare client cannot reconnect: the retry is reported as not executed.
    const bare = client("accepted", { FAKE_MCP_CRASH: "once", FAKE_MCP_STATE: join(tempDir("jev-flow-state-"), "s.json") });
    await bare.c.connect();
    const r = await callWithRetry(bare.c, "jev_gate", args);
    await bare.c.close();
    assert.deepEqual([r.ok, r.attempts, r.retry], [false, 1, "not_executed: the server connection is closed"]);
  });

  it("rejects a server message above the size limit, complete or fragmented, and ends the server", async () => {
    for (const mode of ["accepted", "fragment"]) {
      const { c } = client(mode, {}, { maxLineBytes: 1000, killGraceMs: 200 });
      assert.equal((await c.connect()).ok, true, `${mode}: the small initialize reply fits`);
      const reply = await c.callTool("jev_gate", { request: "r", diff: "d", claims: ["a claim"], evidence: [{ id: "e", text: "t" }] });
      assert.deepEqual([reply.ok, reply.kind], [false, "transport"], mode);
      assert.match(reply.message, /server message exceeds 1000 bytes/, mode);
      await c.close();
      assert.ok(c.child.exitCode !== null || c.child.signalCode !== null, `${mode}: the server was ended`);
    }
  });
});

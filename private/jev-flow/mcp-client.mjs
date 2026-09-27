// Minimal MCP stdio client for jev-flow (Node stdlib only). It starts the jev
// MCP server the way the plugin manifest does, speaks newline-delimited
// JSON-RPC 2.0 (initialize, notifications/initialized, tools/call) and returns
// parsed Jev tool results. Used by the gate runner and the candidate helper so
// that large payloads never pass through a model.
//
// Server command: JEV_FLOW_MCP_COMMAND as a JSON array of strings (argv, no
// shell), else the manifest's `npx -y --package=@jkudish/jev-mcp@latest jev-mcp`.
// The child inherits the environment; see resolveJevEnv for credentials.
// Raw server stderr is never returned: only a redacted, bounded tail.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { parseJevResult } from "./policy.mjs";
import { redact } from "./sanitize.mjs";

export const DEFAULT_MCP_COMMAND = Object.freeze(["npx", "-y", "--package=@jkudish/jev-mcp@latest", "jev-mcp"]);
export const PROTOCOL_VERSION = "2025-11-25";

/** Timeouts and buffer caps (documented in PRIVATE.md). */
export const CLIENT_LIMITS = Object.freeze({
  initTimeoutMs: 120_000, // npx may download the package on first use
  callTimeoutMs: 300_000, // one jev_gate call; the server has its own request deadline
  maxLineBytes: 8 * 1024 * 1024, // one JSON-RPC message from the server
  stderrTailChars: 2_000,
  killGraceMs: 2_000,
});

export class McpConfigError extends Error {}

/** The server argv: JEV_FLOW_MCP_COMMAND (JSON array of non-empty strings) or the default. */
export function mcpCommand(env = process.env) {
  const raw = env.JEV_FLOW_MCP_COMMAND;
  if (raw === undefined || String(raw).trim() === "") return [...DEFAULT_MCP_COMMAND];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpConfigError("JEV_FLOW_MCP_COMMAND must be a JSON array of strings (argv, no shell)");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((a) => typeof a !== "string" || a === "")) {
    throw new McpConfigError("JEV_FLOW_MCP_COMMAND must be a non-empty JSON array of non-empty strings");
  }
  return parsed;
}

/**
 * Credentials for the child server, from the inherited environment only
 * (never from ~/.claude.json or other config files). The rules follow
 * src/provider.ts: OPENROUTER_API_KEY, TYPESAFE_API_KEY, JEV_API_KEY with
 * JEV_API_BASE_URL, a Cloudflare token with CLOUDFLARE_ACCOUNT_ID, or
 * AI_GATEWAY_API_KEY. When JEV_PROVIDER is unset and OPENROUTER_API_KEY is
 * present, JEV_PROVIDER=openrouter is set for the child.
 * Returns {ok, env, provider} or {ok: false, reason}.
 */
export function resolveJevEnv(env = process.env) {
  const has = (name) => typeof env[name] === "string" && env[name].trim() !== "";
  const credentials =
    has("OPENROUTER_API_KEY") ||
    has("TYPESAFE_API_KEY") ||
    (has("JEV_API_KEY") && has("JEV_API_BASE_URL")) ||
    ((has("JEV_CLOUDFLARE_API_TOKEN") || has("CLOUDFLARE_API_TOKEN")) && has("CLOUDFLARE_ACCOUNT_ID")) ||
    has("AI_GATEWAY_API_KEY");
  if (!credentials) return { ok: false, reason: "no Jev credentials in the environment" };
  const child = { ...env };
  if (!has("JEV_PROVIDER") && has("OPENROUTER_API_KEY")) child.JEV_PROVIDER = "openrouter";
  return { ok: true, env: child, provider: child.JEV_PROVIDER || "auto" };
}

/**
 * One MCP session over a child process. `connect()` performs the handshake;
 * `callTool()` sends tools/call; `close()` ends the child. Every failure is
 * returned as {ok: false, kind, message} with kind transport | invalid_response
 * | tool_error; nothing throws after construction.
 */
export class McpStdioClient {
  constructor({ command, env, cwd = tmpdir(), limits = CLIENT_LIMITS } = {}) {
    this.command = command;
    this.env = env;
    this.cwd = cwd;
    this.limits = { ...CLIENT_LIMITS, ...limits };
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrTail = "";
    this.closed = false;
    this.oversize = false;
    this.exitInfo = null;
    this.child = null;
  }

  stderrSummary() {
    return redact(this.stderrTail).text.slice(-this.limits.stderrTailChars);
  }

  failAll(message) {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ ok: false, kind: "transport", message });
    }
    this.pending.clear();
  }

  /** A server message above maxLineBytes (complete or still incomplete) ends the session: nothing of it is parsed. */
  oversized() {
    this.buffer = "";
    this.oversize = true;
    this.failAll(`server message exceeds ${this.limits.maxLineBytes} bytes`);
    this.kill();
  }

  onStdout(chunk) {
    if (this.oversize) return;
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > this.limits.maxLineBytes) return this.oversized();
      if (line.trim() !== "") this.onMessage(line);
    }
    if (Buffer.byteLength(this.buffer) > this.limits.maxLineBytes) this.oversized();
  }

  onMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not JSON-RPC (a stray log line); ignored.
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    // Notifications and server requests carry no id we are waiting for.
    if (msg.id === undefined || msg.id === null || !this.pending.has(msg.id)) {
      if (msg.method && msg.id !== undefined && msg.id !== null) {
        // A server-to-client request: answer "method not found" so it does not wait.
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by jev-flow client" } });
      }
      return;
    }
    const { resolve, timer } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) resolve({ ok: false, kind: "tool_error", message: String(msg.error?.message ?? "JSON-RPC error").slice(0, 500), code: msg.error?.code });
    else if (msg.result === undefined) resolve({ ok: false, kind: "invalid_response", message: "JSON-RPC response without result" });
    else resolve({ ok: true, result: msg.result });
  }

  write(message) {
    if (this.closed || !this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve) => {
      if (this.closed) return resolve({ ok: false, kind: "transport", message: this.exitMessage() });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, kind: "transport", message: `${method} timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, kind: "transport", message: "cannot write to the MCP server" });
      }
    });
  }

  exitMessage() {
    const e = this.exitInfo;
    const how = e ? (e.error ? `failed to start (${e.error})` : `exited (code ${e.code ?? "none"}, signal ${e.signal ?? "none"})`) : "closed";
    const tail = this.stderrSummary().trim();
    return `MCP server ${how}${tail ? `; stderr tail: ${tail.split("\n").slice(-3).join(" | ")}` : ""}`;
  }

  /** Start the server and complete the MCP handshake. */
  async connect() {
    try {
      this.child = spawn(this.command[0], this.command.slice(1), { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.closed = true;
      return { ok: false, kind: "transport", message: `cannot start the MCP server: ${error?.code ?? error?.message ?? error}` };
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8 * this.limits.stderrTailChars);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => {
      this.exitInfo = { error: error?.code ?? String(error?.message ?? error) };
      this.closed = true;
      this.failAll(this.exitMessage());
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = this.exitInfo ?? { code, signal };
      this.closed = true;
      this.failAll(this.exitMessage());
    });
    const init = await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "jev-flow", version: "0.2.0" } },
      this.limits.initTimeoutMs,
    );
    if (!init.ok) {
      this.kill();
      return init;
    }
    if (!init.result || typeof init.result !== "object" || typeof init.result.protocolVersion !== "string") {
      this.kill();
      return { ok: false, kind: "invalid_response", message: "initialize result without protocolVersion" };
    }
    this.serverInfo = init.result.serverInfo ?? null;
    this.protocolVersion = init.result.protocolVersion;
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { ok: true, serverInfo: this.serverInfo, protocolVersion: this.protocolVersion };
  }

  /**
   * tools/call. Returns {ok: true, result} with the Jev JSON result parsed from
   * the text content, or {ok: false, kind, message}. A tool result with
   * isError is kind tool_error; unparseable content is invalid_response.
   */
  async callTool(name, args, timeoutMs = this.limits.callTimeoutMs) {
    const reply = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (!reply.ok) return reply;
    const content = reply.result?.content;
    if (reply.result?.isError) {
      const text = Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ") : "";
      return { ok: false, kind: "tool_error", message: redact(text).text.slice(0, 500) || "tool returned isError" };
    }
    const parsed = parseJevResult(content);
    if (!parsed || parsed.tool !== name) return { ok: false, kind: "invalid_response", message: `no ${name} JSON result in the tool content` };
    return { ok: true, result: parsed };
  }

  kill() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, this.limits.killGraceMs);
    timer.unref();
  }

  /** Close stdin (the MCP stdio shutdown) and make sure the child ends. */
  async close() {
    if (!this.child) return;
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
    });
    try {
      this.child.stdin.end();
    } catch {
      // Ignore.
    }
    const timer = setTimeout(() => this.kill(), this.limits.killGraceMs);
    await exited;
    clearTimeout(timer);
    this.closed = true;
  }
}

/**
 * Open a session with credentials resolved from `env`. Returns
 * {ok: true, client, provider} or {ok: false, unavailable: true, reason}.
 * Nothing is spawned without credentials.
 */
export async function openJev(env = process.env, { limits } = {}) {
  const creds = resolveJevEnv(env);
  if (!creds.ok) return { ok: false, unavailable: true, reason: creds.reason };
  let command;
  try {
    command = mcpCommand(env);
  } catch (error) {
    return { ok: false, config: true, reason: error.message };
  }
  const connect = async () => {
    const client = new McpStdioClient({ command, env: creds.env, limits });
    const connected = await client.connect();
    if (!connected.ok) {
      await client.close();
      return { ok: false, reason: connected.message };
    }
    return { ok: true, client };
  };
  const first = await connect();
  if (!first.ok) return { ok: false, unavailable: true, reason: first.reason };
  const session = {
    ok: true,
    client: first.client,
    provider: creds.provider,
    /** Replace a closed client with a new connection (for the operational retry). */
    async reopen() {
      await session.client.close();
      const next = await connect();
      if (!next.ok) return next;
      session.client = next.client;
      return next;
    },
    close: () => session.client.close(),
  };
  return session;
}

/**
 * tools/call with the flow's retry policy: one retry with identical input
 * after a transport failure, a JSON-RPC-level invalid response, or a result
 * that `invalid(result)` rejects (the caller's semantic check, for example
 * interpretGate's retry_or_unavailable route or an unusable ranking); never
 * after other outcomes (a contradiction, a valid answer below thresholds, a
 * tool error). A transport failure that closed the server is retried on a new
 * connection (`jev.reopen`); if that is impossible the retry is reported as
 * not executed. `attempts` counts the tools/call requests actually sent.
 * `jev` is an openJev session ({client, reopen}) or a bare client.
 */
export async function callWithRetry(jev, name, args, { invalid = null } = {}) {
  const session = jev instanceof McpStdioClient ? { client: jev, reopen: null } : jev;
  let attempts = 0;
  let last;
  for (let round = 1; round <= 2; round++) {
    if (round === 2 && session.client.closed) {
      if (typeof session.reopen !== "function") return { ...last, attempts, retry: "not_executed: the server connection is closed" };
      const reopened = await session.reopen();
      if (!reopened.ok) return { ...last, attempts, retry: `not_executed: reconnect failed (${String(reopened.reason).slice(0, 200)})` };
    }
    attempts += 1;
    last = await session.client.callTool(name, args);
    let retryable;
    if (!last.ok) retryable = last.kind === "transport" || last.kind === "invalid_response";
    else {
      const semanticallyInvalid = last.result?.status === "invalid_response" || (invalid ? invalid(last.result) === true : false);
      if (semanticallyInvalid) last = { ok: false, kind: "invalid_response", message: `${name} returned an invalid result`, result: last.result };
      retryable = semanticallyInvalid;
    }
    if (!retryable) return { ...last, attempts };
  }
  return { ...last, attempts };
}

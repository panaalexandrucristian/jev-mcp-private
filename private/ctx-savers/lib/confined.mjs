// One confined headless Sonnet/Haiku session (round 4): sandboxed Bash writes only to <dir>/t and reads only <dir> and the node install; Read is path-scoped to <dir>; no MCP, no plugins, dontAsk.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const real = (p) => { try { return realpathSync(p); } catch { return p; } };
export const nodeHome = dirname(dirname(real(process.execPath)));
export const makeDir = (prefix) => { const dir = real(mkdtempSync(`/tmp/${prefix}-`)); mkdirSync(join(dir, "t")); writeFileSync(join(dir, "empty-mcp.json"), '{"mcpServers":{}}\n'); return dir; };

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"];
export const BASH_ALLOW = ["android", "adb", "node", "sleep", "cat", "head", "tail", "grep", "rg", "jq", "python3", "sed", "awk", "wc", "echo", "ls", "find", "sort", "uniq", "cut", "tr", "xargs", "printf", "cd", "test", "for", "while", "do", "done", "if", "then", "fi", "true"].map((c) => `Bash(${c}:*)`);

/** Runs `claude -p`; returns the numbers every round-4 arm reports. `extraPath` is put in front of PATH (the stand-in `bin`). */
export function runSession({ dir, prompt, model = "sonnet", cap = 0.15, tools = "Bash,Read", allowedTools = [], extraPath = null, timeoutMs = 6 * 60 * 1000, rawFile = null }) {
  const settings = { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyRead: ["~/", real("/tmp"), real(tmpdir())], allowRead: [nodeHome, dir], allowWrite: [join(dir, "t")] } } };
  const args = ["-p", prompt, "--model", model, "--restricted", "--add-dir", dir, "--tools", tools, "--allowedTools", ...allowedTools, "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", join(dir, "empty-mcp.json"), "--settings", JSON.stringify(settings), "--output-format", "stream-json", "--verbose", "--session-id", randomUUID(), "--max-budget-usd", String(cap)];
  const env = {}; for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  env.TMPDIR = join(dir, "t"); env.CLAUDE_CODE_TMPDIR = join(dir, "t");
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      if (rawFile) writeFileSync(rawFile, out);
      const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      const assistants = events.filter((e) => e.type === "assistant" && e.message);
      const calls = new Map(); // message.id -> tool_use blocks (one model call can carry several tool calls)
      for (const e of assistants) { const list = calls.get(e.message.id) ?? []; for (const b of e.message.content ?? []) if (b.type === "tool_use") list.push({ name: b.name, input: b.input }); calls.set(e.message.id, list); }
      const toolUses = [...calls.values()].flat();
      const res = events.find((e) => e.type === "result");
      const last = assistants.at(-1)?.message.usage ?? {};
      const toolErrors = events.filter((e) => e.type === "user").flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === "tool_result" && b.is_error)).length;
      resolve({
        modelCalls: calls.size, toolCalls: toolUses.length, maxToolsInOneTurn: Math.max(0, ...[...calls.values()].map((l) => l.length)),
        tools: toolUses.map((t) => t.name), bashCommands: toolUses.filter((t) => t.name === "Bash").map((t) => String(t.input?.command ?? "")), reads: toolUses.filter((t) => t.name === "Read").map((t) => String(t.input?.file_path ?? "")),
        answer: String(res?.result ?? ""), subtype: res?.subtype ?? "none", cost: res?.total_cost_usd ?? null, denials: res?.permission_denials?.length ?? 0, toolErrors,
        contextAtLastCall: (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0), durationMs: res?.duration_ms ?? null,
      });
    });
  });
}

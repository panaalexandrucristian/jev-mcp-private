#!/usr/bin/env node
// Campaign session runner (R01-R10). NOT used in T2: nothing here starts a real
// `claude -p` session unless JEV_CONTROL_LIVE=1 is set and the authorized budget
// wrapper is the executable; T2 tests it only with a simulated executable. Rules
// from the T1 design: strictly one session at a time; fully detached (a launcher
// starts a worker in its own session, the worker starts the wrapper in its own
// process group, all output goes to a persistent log); the next session starts
// only after the previous one's termination is confirmed from its status file
// (not merely a `result` message); --model sonnet, --max-turns 40, an external
// 20-minute limit, and a stop when the log shows no progress for 5 minutes; a
// failed or timed-out session counts. The user's wrapper enforces the 20-session
// cap and writes the ledger; this runner refuses to start when the ledger is full.
//   node run-session.mjs launch --prompt-file f --cwd dir --out-dir dir [--plugin-dir dir]
//   node run-session.mjs wait --out-dir dir [--timeout-s n]
//   node run-session.mjs status --out-dir dir
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET_DIR = "/Users/apana/Dev/council-runs/2026-10-02/jev-control-budget";
export const AUTHORIZED_WRAPPER = `${BUDGET_DIR}/bin/claude`;
export const LEDGER = `${BUDGET_DIR}/ledger.tsv`;
export const SESSION_CAP = 20;
export const LIMITS = Object.freeze({ maxTurns: 40, timeoutMs: 20 * 60 * 1000, noProgressMs: 5 * 60 * 1000, pollMs: 1000 });

export function buildArgs({ prompt, pluginDir = null, maxTurns = LIMITS.maxTurns }) {
  return ["-p", prompt, "--model", "sonnet", "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose", ...(pluginDir ? ["--plugin-dir", pluginDir] : [])];
}

export function ledgerCount(path = LEDGER) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/** Why a launch must be refused (empty when it may proceed). `testWrapper` is for the offline tests only. */
export function launchProblems({ wrapper, args, ledgerPath = LEDGER, outDir, testWrapper = false, env = process.env }) {
  const problems = [];
  if (!testWrapper) {
    if (wrapper !== AUTHORIZED_WRAPPER) problems.push("only the authorized budget wrapper may start a test session");
    if (env.JEV_CONTROL_LIVE !== "1") problems.push("JEV_CONTROL_LIVE=1 is required: live sessions are not part of T2");
  }
  const at = args.indexOf("--model");
  if (at < 0 || args[at + 1] !== "sonnet") problems.push("the session must pass --model sonnet");
  if (!args.includes("-p")) problems.push("a headless session needs -p");
  const turns = args.indexOf("--max-turns");
  if (turns < 0 || !(Number(args[turns + 1]) >= 1 && Number(args[turns + 1]) <= LIMITS.maxTurns)) problems.push(`--max-turns must be 1-${LIMITS.maxTurns}`);
  const count = ledgerCount(ledgerPath);
  if (count === null) problems.push("the ledger cannot be read");
  else if (count >= SESSION_CAP) problems.push(`the ledger already holds ${count}/${SESSION_CAP} sessions`);
  const lock = join(outDir, "running.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").split(":")[0]);
    if (Number.isInteger(pid) && alive(pid)) problems.push(`a session is still running (pid ${pid}): one at a time`);
  }
  return problems;
}

/**
 * Start a session fully detached: launcher -> worker (own session) -> wrapper (own
 * process group). Returns {ok, pid} or {ok: false, problems}. The worker writes
 * status.json when the wrapper has exited.
 */
export function launch({ wrapper = AUTHORIZED_WRAPPER, args, cwd, outDir, timeoutMs = LIMITS.timeoutMs, noProgressMs = LIMITS.noProgressMs, testWrapper = false, env = process.env, ledgerPath = LEDGER }) {
  mkdirSync(outDir, { recursive: true });
  const problems = launchProblems({ wrapper, args, ledgerPath, outDir, testWrapper, env });
  if (problems.length) return { ok: false, problems };
  const config = { wrapper, args, cwd, outDir, timeoutMs, noProgressMs };
  const configPath = join(outDir, "launch.json");
  writeFileSync(configPath, JSON.stringify({ ...config, args: args.map((a, i) => (args[i - 1] === "-p" ? "<prompt not stored>" : a)) }));
  const secret = join(outDir, ".launch.private.json");
  writeFileSync(secret, JSON.stringify(config), { mode: 0o600 });
  try {
    unlinkSync(join(outDir, "status.json"));
  } catch {
    // None yet.
  }
  const log = openSync(join(outDir, "session.log"), "a");
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "_worker", secret], { detached: true, stdio: ["ignore", log, log], env });
  worker.unref();
  closeSync(log);
  return { ok: true, pid: worker.pid };
}

/** The detached worker: run the wrapper, enforce the limits, write status.json, remove the lock. */
async function worker(secretPath) {
  const config = JSON.parse(readFileSync(secretPath, "utf8"));
  try {
    unlinkSync(secretPath);
  } catch {
    // Already removed.
  }
  const { wrapper, args, cwd, outDir, timeoutMs, noProgressMs } = config;
  const lock = join(outDir, "running.lock");
  writeFileSync(lock, `${process.pid}:${Date.now()}`);
  const logPath = join(outDir, "session.log");
  const started = Date.now();
  const out = openSync(logPath, "a");
  const child = spawn(wrapper, args, { cwd, detached: true, stdio: ["ignore", out, out] });
  let timedOut = false;
  let noProgress = false;
  let lastSize = -1;
  let lastChange = Date.now();
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  const limit = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const watch = setInterval(() => {
    try {
      const size = statSync(logPath).size;
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= noProgressMs) {
        noProgress = true;
        kill();
      }
    } catch {
      // The log is not readable yet.
    }
  }, Math.max(50, Math.min(LIMITS.pollMs, noProgressMs / 4)));
  const done = await new Promise((resolveExit) => {
    child.on("error", (error) => resolveExit({ code: null, signal: null, error: String(error?.code ?? error?.message ?? error) }));
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(limit);
  clearInterval(watch);
  closeSync(out);
  let resultSeen = false;
  try {
    resultSeen = /"type"\s*:\s*"result"/.test(readFileSync(logPath, "utf8"));
  } catch {
    resultSeen = false;
  }
  const status = { state: "done", exit: done.code, signal: done.signal ?? null, error: done.error ?? null, timed_out: timedOut, no_progress: noProgress, result_seen: resultSeen, started, ended: Date.now(), counted: true };
  const tmp = join(outDir, ".status.tmp");
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, join(outDir, "status.json"));
  try {
    unlinkSync(lock);
  } catch {
    // Already gone.
  }
}

export function readStatus(outDir) {
  try {
    return JSON.parse(readFileSync(join(outDir, "status.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Wait until the worker has written its status and is gone: termination confirmed, not just a result message. */
export async function waitForTermination(outDir, { timeoutMs = LIMITS.timeoutMs + 60_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readStatus(outDir);
    const lock = join(outDir, "running.lock");
    const running = existsSync(lock) && (() => {
      const pid = Number(readFileSync(lock, "utf8").split(":")[0]);
      return Number.isInteger(pid) && alive(pid);
    })();
    if (status?.state === "done" && !running) return { ok: true, status };
    if (Date.now() >= deadline) return { ok: false, status, reason: "timeout while waiting for the session to end" };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const SELF = fileURLToPath(import.meta.url);
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "_worker") {
    await worker(rest[0]);
  } else if (cmd === "launch") {
    const promptFile = flag("prompt-file");
    const outDir = flag("out-dir");
    if (!promptFile || !outDir || !flag("cwd")) {
      process.stderr.write("launch needs --prompt-file, --cwd and --out-dir\n");
      process.exitCode = 4;
    } else {
      const args = buildArgs({ prompt: readFileSync(promptFile, "utf8"), pluginDir: flag("plugin-dir") ?? null });
      const result = launch({ args, cwd: flag("cwd"), outDir });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.ok ? 0 : 4;
    }
  } else if (cmd === "wait") {
    const result = await waitForTermination(flag("out-dir"), { timeoutMs: flag("timeout-s") ? Number(flag("timeout-s")) * 1000 : undefined });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } else if (cmd === "status") {
    process.stdout.write(`${JSON.stringify(readStatus(flag("out-dir")))}\n`);
  } else {
    process.stderr.write("Usage: run-session.mjs launch|wait|status (see the header)\n");
    process.exitCode = 4;
  }
}

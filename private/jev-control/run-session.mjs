#!/usr/bin/env node
// Campaign session runner (R01-R10). NOT used in T2: nothing here starts a real
// `claude -p` session unless JEV_CONTROL_LIVE=1 is set and the authorized budget
// wrapper is the executable; T2 tests it only with a simulated executable. Rules
// from the T1 design: strictly one session at a time; fully detached (a launcher
// starts a worker in its own session, the worker starts the wrapper in its own
// process group, all output goes to a persistent log); the next session starts
// only after the previous one's termination is confirmed (the campaign lock has
// no live recorded pid AND status.json says done, not merely a `result` message);
// --model sonnet, --max-turns 40, D27 permissions (acceptEdits plus an explicit
// allowlist, never a bypass), D28 isolation (--setting-sources project, the branch
// plugin via --plugin-dir) and D29 JEV_PROVIDER=openrouter (sessionEnv: no JEV_FLOW,
// no JEV_CONTROL* key reaches the worker or the wrapper), and one external
// 20-minute limit, the only automatic stop (a long tool call with a quiet log is legitimate, so there is no
// no-progress rule); a failed or timed-out session counts. The user's wrapper
// enforces the 20-session cap and writes the ledger; this runner refuses to start
// when the ledger is full.
// One campaign-wide lock (default ${BUDGET_DIR}/jev-control-session.lock, JSON
// {launcherPid, token, outDir, startedAt, workerPid, childPid}) is created by the
// launcher with an exclusive `wx` create BEFORE the worker is spawned, so of any
// number of simultaneous launches (any out dirs) exactly one starts. Only the
// worker releases it, after the wrapper (the child AND its process group) is gone
// and status.json is written; only the owner token may update or release it. A
// lock whose recorded pids are all dead is reported as stale and never removed
// silently: `release-stale` removes it, and only when every recorded pid is dead.
//   node run-session.mjs launch --prompt-file f --cwd dir --out-dir dir [--plugin-dir dir]
//   node run-session.mjs wait --out-dir dir [--timeout-s n]
//   node run-session.mjs status --out-dir dir
//   node run-session.mjs release-stale [--lock-path file]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET_DIR = "/Users/apana/Dev/council-runs/2026-10-02/jev-control-budget";
export const AUTHORIZED_WRAPPER = `${BUDGET_DIR}/bin/claude`;
export const LEDGER = `${BUDGET_DIR}/ledger.tsv`;
export const LOCK_PATH = `${BUDGET_DIR}/jev-control-session.lock`;
export const SESSION_CAP = 20;
export const LIMITS = Object.freeze({ maxTurns: 40, timeoutMs: 20 * 60 * 1000, pollMs: 1000 });
// A lock with no worker pid yet is "starting" (live) for this long, then stale.
export const START_GRACE_MS = 30_000;

// D27-D29: the same isolation, permissions and provider for every campaign session.
export const PLUGIN_DIR = "/Users/apana/Dev/jev-mcp";
export const PERMISSION_MODE = "acceptEdits";
export const ALLOWED_TOOLS = Object.freeze(["Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "mcp__jev__*", "mcp__plugin_jev_jev__*", "Agent"]);
export const SESSION_PROVIDER = "openrouter";

// The prompt is the argument of -p, so the variadic --allowedTools list that ends the command cannot swallow it.
export function buildArgs({ prompt, pluginDir = PLUGIN_DIR, maxTurns = LIMITS.maxTurns }) {
  return [
    "-p", prompt, "--model", "sonnet", "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project", "--plugin-dir", pluginDir, "--permission-mode", PERMISSION_MODE, "--allowedTools", ...ALLOWED_TOOLS,
  ];
}

/**
 * The environment of the worker and of the wrapper: the given environment with
 * JEV_PROVIDER fixed, JEV_FLOW and every JEV_CONTROL* key (the launcher's
 * JEV_CONTROL_LIVE included) removed. Never serialized: it may hold credentials.
 */
export function sessionEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (key !== "JEV_FLOW" && !key.startsWith("JEV_CONTROL")) out[key] = value;
  out.JEV_PROVIDER = SESSION_PROVIDER;
  return out;
}

const valueAfter = (args, flag) => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};

/** Why `args` do not carry the mandatory D27/D28 configuration (empty when they do); bypassing permissions is always refused. */
export function configProblems(args) {
  const problems = [];
  if (args.some((a) => /^--(allow-)?dangerously-skip-permissions$/.test(a) || /bypassPermissions/.test(String(a)))) problems.push("bypassing permissions is not allowed in a test session");
  if (valueAfter(args, "--permission-mode") !== PERMISSION_MODE) problems.push(`the session must pass --permission-mode ${PERMISSION_MODE}`);
  const tools = args.indexOf("--allowedTools");
  const list = tools < 0 ? [] : args.slice(tools + 1);
  if (list.length !== ALLOWED_TOOLS.length || list.some((t, i) => t !== ALLOWED_TOOLS[i])) problems.push("--allowedTools must be exactly the D27 list, last on the command line");
  if (valueAfter(args, "--setting-sources") !== "project") problems.push("the session must pass --setting-sources project");
  if (valueAfter(args, "--plugin-dir") !== PLUGIN_DIR) problems.push(`the session must pass --plugin-dir ${PLUGIN_DIR}`);
  if (valueAfter(args, "--output-format") !== "stream-json" || !args.includes("--verbose")) problems.push("the session must pass --output-format stream-json --verbose");
  return problems;
}

export function ledgerCount(path = LEDGER) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

// Never signal pid 0, 1 or a negative number: -1 would reach every process.
const isPid = (pid) => Number.isInteger(pid) && pid > 1;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readLock(lockPath) {
  let text;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { unreadable: true };
  }
  try {
    const lock = JSON.parse(text);
    return lock && typeof lock.token === "string" ? { lock } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/** Create the campaign lock atomically (exclusive `wx`). {ok: false} when it already exists. */
export function acquireLock(lockPath, { launcherPid = process.pid, outDir }) {
  const lock = { launcherPid, token: randomBytes(16).toString("hex"), outDir, startedAt: Date.now(), workerPid: null, childPid: null };
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
    return { ok: true, lock };
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false };
    throw error;
  }
}

/** Merge `patch` into the lock when `token` owns it (atomic replace); false for any other token. */
export function updateLock(lockPath, token, patch) {
  const { lock } = readLock(lockPath);
  if (!lock || lock.token !== token) return false;
  const tmp = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...lock, ...patch, token }), { mode: 0o600 });
  renameSync(tmp, lockPath);
  return true;
}

/** Remove the lock when `token` owns it; false for any other token. */
export function releaseLock(lockPath, token) {
  const { lock } = readLock(lockPath);
  if (!lock || lock.token !== token) return false;
  unlinkSync(lockPath);
  return true;
}

/**
 * The lock's state: none | live | stale | unreadable. Live while ANY recorded pid
 * (launcher, worker, child) or the child's process group is alive; a vanished
 * worker does not prove the Claude parent finished.
 */
export function describeLock(lockPath, { now = Date.now(), startGraceMs = START_GRACE_MS } = {}) {
  let read = readLock(lockPath);
  for (let i = 0; i < 5 && read.unreadable; i++) {
    // A concurrent launcher may have created the file and not written it yet.
    sleepSync(20);
    read = readLock(lockPath);
  }
  if (read.missing) return { state: "none" };
  if (read.unreadable) {
    let ageMs = 0;
    try {
      ageMs = now - statSync(lockPath).mtimeMs;
    } catch {
      // Removed meanwhile.
    }
    return { state: "unreadable", ageMs };
  }
  const { lock } = read;
  const live = [];
  for (const key of ["launcherPid", "workerPid", "childPid"]) if (isPid(lock[key]) && alive(lock[key])) live.push(`${key} ${lock[key]}`);
  if (isPid(lock.childPid) && alive(-lock.childPid)) live.push(`child process group ${lock.childPid}`);
  const starting = !isPid(lock.workerPid) && now - lock.startedAt < startGraceMs;
  if (starting) live.push("worker still starting");
  const status = lock.outDir ? readStatus(lock.outDir) : null;
  return { state: live.length ? "live" : "stale", lock, live, statusState: status?.state ?? null };
}

const owner = (lock) => `launcher pid ${lock.launcherPid}, worker pid ${lock.workerPid ?? "none yet"}, child pid ${lock.childPid ?? "none yet"}, out dir ${lock.outDir}`;

/** The refusal text for a lock that exists (empty when there is none). */
export function lockProblem(lockPath, options) {
  const d = describeLock(lockPath, options);
  if (d.state === "none") return "";
  if (d.state === "live") return `a session is still running: one at a time (campaign lock ${lockPath} is held by ${owner(d.lock)}; alive: ${d.live.join(", ")})`;
  const how = `inspect it, then run: node run-session.mjs release-stale --lock-path ${lockPath}`;
  if (d.state === "stale") return `the campaign lock ${lockPath} is stale (${owner(d.lock)}; every recorded pid is dead, status ${d.statusState ?? "missing"}); it is not removed automatically: ${how}`;
  return `the campaign lock ${lockPath} exists but cannot be read (age ${Math.round(d.ageMs / 1000)}s); it is not removed automatically: ${how}`;
}

/** Remove a stale lock, only when every recorded pid is dead. */
export function releaseStale(lockPath, options = {}) {
  const d = describeLock(lockPath, options);
  if (d.state === "none") return { ok: true, removed: false, reason: "no lock" };
  if (d.state === "live") return { ok: false, removed: false, reason: `not stale: ${d.live.join(", ")} still alive` };
  if (d.state === "unreadable" && d.ageMs < (options.startGraceMs ?? START_GRACE_MS)) return { ok: false, removed: false, reason: "the lock is unreadable but too young to be judged stale" };
  // Remove only the lock that was judged stale, not one a new owner has since created.
  if (d.lock && readLock(lockPath).lock?.token !== d.lock.token) return { ok: false, removed: false, reason: "the lock changed meanwhile" };
  unlinkSync(lockPath);
  return { ok: true, removed: true, lock: d.lock ? { ...d.lock, token: undefined } : null };
}

/** Why a launch must be refused (empty when it may proceed). `testWrapper` is for the offline tests only. */
export function launchProblems({ wrapper, args, ledgerPath = LEDGER, lockPath = LOCK_PATH, testWrapper = false, env = process.env }) {
  const problems = [];
  if (!testWrapper) {
    if (wrapper !== AUTHORIZED_WRAPPER) problems.push("only the authorized budget wrapper may start a test session");
    if (env.JEV_CONTROL_LIVE !== "1") problems.push("JEV_CONTROL_LIVE=1 is required: live sessions are not part of T2");
  } else if (lockPath === LOCK_PATH) {
    problems.push("a simulated executable must use its own lockPath, never the campaign lock");
  }
  const at = args.indexOf("--model");
  if (at < 0 || args[at + 1] !== "sonnet") problems.push("the session must pass --model sonnet");
  if (!args.includes("-p")) problems.push("a headless session needs -p");
  const turns = args.indexOf("--max-turns");
  if (turns < 0 || !(Number(args[turns + 1]) >= 1 && Number(args[turns + 1]) <= LIMITS.maxTurns)) problems.push(`--max-turns must be 1-${LIMITS.maxTurns}`);
  problems.push(...configProblems(args));
  const count = ledgerCount(ledgerPath);
  if (count === null) problems.push("the ledger cannot be read");
  else if (count >= SESSION_CAP) problems.push(`the ledger already holds ${count}/${SESSION_CAP} sessions`);
  const held = lockProblem(lockPath);
  if (held) problems.push(held);
  return problems;
}

/**
 * Start a session fully detached: launcher -> worker (own session) -> wrapper (own
 * process group). The launcher takes the campaign lock (exclusive create) before it
 * spawns anything and never releases it; the worker does, after the wrapper is gone
 * and status.json is written. Returns {ok, pid} or {ok: false, problems}.
 */
export function launch({ wrapper = AUTHORIZED_WRAPPER, args, cwd, outDir, timeoutMs = LIMITS.timeoutMs, testWrapper = false, env = process.env, ledgerPath = LEDGER, lockPath = LOCK_PATH }) {
  mkdirSync(outDir, { recursive: true });
  // The LIVE check reads the launcher's own environment; the child gets sessionEnv(env).
  const problems = launchProblems({ wrapper, args, ledgerPath, lockPath, testWrapper, env });
  if (problems.length) return { ok: false, problems };
  const childEnv = sessionEnv(env);
  // Contended launches lose here; a loser touches nothing in any out dir.
  const acquired = acquireLock(lockPath, { outDir });
  if (!acquired.ok) return { ok: false, problems: [lockProblem(lockPath) || `the campaign lock ${lockPath} was taken by another launch`] };
  const { token } = acquired.lock;
  let worker = null;
  try {
    const config = { wrapper, args, cwd, outDir, timeoutMs, lockPath, token };
    writeFileSync(join(outDir, "launch.json"), JSON.stringify({ ...config, token: undefined, args: args.map((a, i) => (args[i - 1] === "-p" ? "<prompt not stored>" : a)) }));
    const secret = join(outDir, ".launch.private.json");
    writeFileSync(secret, JSON.stringify(config), { mode: 0o600 });
    try {
      unlinkSync(join(outDir, "status.json"));
    } catch {
      // None yet.
    }
    const log = openSync(join(outDir, "session.log"), "a");
    try {
      worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "_worker", secret], { detached: true, stdio: ["ignore", log, log], env: childEnv });
    } finally {
      closeSync(log);
    }
    worker.on("error", () => {});
    worker.unref();
  } catch (error) {
    // No worker exists, so nothing can ever release this lock but us.
    if (!worker?.pid) releaseLock(lockPath, token);
    throw error;
  }
  if (!worker.pid) {
    releaseLock(lockPath, token);
    return { ok: false, problems: ["the worker could not be spawned"] };
  }
  return { ok: true, pid: worker.pid };
}

/** The detached worker: record its pids in the lock, run the wrapper, enforce the limit, write status.json, then release the lock. */
async function worker(secretPath) {
  const config = JSON.parse(readFileSync(secretPath, "utf8"));
  try {
    unlinkSync(secretPath);
  } catch {
    // Already removed.
  }
  const { wrapper, args, cwd, outDir, timeoutMs, lockPath, token } = config;
  if (!updateLock(lockPath, token, { workerPid: process.pid })) {
    process.stderr.write("the campaign lock is not owned by this worker: no session started\n");
    process.exitCode = 5;
    return;
  }
  const logPath = join(outDir, "session.log");
  const started = Date.now();
  const out = openSync(logPath, "a");
  const child = spawn(wrapper, args, { cwd, detached: true, stdio: ["ignore", out, out], env: sessionEnv(process.env) });
  if (isPid(child.pid)) updateLock(lockPath, token, { childPid: child.pid });
  let timedOut = false;
  let killedAt = 0;
  const kill = () => {
    killedAt = Date.now();
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
  const done = await new Promise((resolveExit) => {
    child.on("error", (error) => resolveExit({ code: null, signal: null, error: String(error?.code ?? error?.message ?? error) }));
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });
  // The child exited; its process group may not have. Wait for it (the time limit
  // still applies and kills the group) before the session counts as over.
  const groupAlive = () => isPid(child.pid) && (alive(child.pid) || alive(-child.pid));
  while (groupAlive() && !(killedAt && Date.now() - killedAt > 10_000)) await new Promise((r) => setTimeout(r, 50));
  const gone = !groupAlive();
  clearTimeout(limit);
  closeSync(out);
  let resultSeen = false;
  try {
    resultSeen = /"type"\s*:\s*"result"/.test(readFileSync(logPath, "utf8"));
  } catch {
    resultSeen = false;
  }
  const status = { state: "done", exit: done.code, signal: done.signal ?? null, error: done.error ?? null, timed_out: timedOut, result_seen: resultSeen, group_gone: gone, started, ended: Date.now(), counted: true };
  const tmp = join(outDir, ".status.tmp");
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, join(outDir, "status.json"));
  // A group that could not be confirmed gone keeps the lock: a human must look.
  if (gone) releaseLock(lockPath, token);
}

export function readStatus(outDir) {
  try {
    return JSON.parse(readFileSync(join(outDir, "status.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Wait until status.json says done AND the campaign lock lists no live pid: termination confirmed, not just a result message or a vanished worker. */
export async function waitForTermination(outDir, { timeoutMs = LIMITS.timeoutMs + 60_000, pollMs = 200, lockPath = LOCK_PATH } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readStatus(outDir);
    const d = describeLock(lockPath);
    // Another out dir's lock says nothing about this session.
    const mine = d.lock?.outDir === outDir || d.state === "unreadable";
    const running = mine && (d.state === "live" || d.state === "unreadable");
    if (status?.state === "done" && !running) return { ok: true, status };
    if (Date.now() >= deadline) {
      const why = running ? `the lock is ${d.state}${d.live ? ` (${d.live.join(", ")})` : ""}` : mine && d.state === "stale" ? "the lock is stale: nothing recorded is alive and no status was written" : "no done status";
      return { ok: false, status, reason: `timeout while waiting for the session to end: ${why}` };
    }
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
      const args = buildArgs({ prompt: readFileSync(promptFile, "utf8"), pluginDir: flag("plugin-dir") ?? PLUGIN_DIR });
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
  } else if (cmd === "release-stale") {
    const result = releaseStale(flag("lock-path") ?? LOCK_PATH);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } else {
    process.stderr.write("Usage: run-session.mjs launch|wait|status|release-stale (see the header)\n");
    process.exitCode = 4;
  }
}

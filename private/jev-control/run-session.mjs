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
//   node run-session.mjs launch --prompt-file f --cwd dir --out-dir dir [--plugin-dir dir] [--threshold x]
// D33 (R05): `--threshold x` is the one explicit exception to "no JEV_CONTROL* key": for that launch only, JEV_CONTROL_THRESHOLD=x
// (x valid in (0.5, 1), checked before the lock) reaches the wrapper, through the worker's configuration and in both sessionEnv
// calls. Without the option a JEV_CONTROL_THRESHOLD of the launcher's environment is removed as before; the prompt is never touched.
//   node run-session.mjs wait --out-dir dir [--timeout-s n]
//   node run-session.mjs status --out-dir dir
//   node run-session.mjs release-stale [--lock-path file]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THRESHOLD_ENV, parseThreshold } from "./threshold.mjs";

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
// D45 (R09): the renamed skill directory, and one Read rule restricted to it, so a session can load the protocol files (SKILL.md, reference/, examples/) the way an
// interactive one can. `//` is the absolute-path form of a permission rule. No --add-dir (it would make the directory a working directory that acceptEdits may edit),
// no access to the rest of the plugin (`help` stays reachable through Bash(node:*)). The rule is the last element of the list.
export const SKILL_DIR = `${PLUGIN_DIR}/skills/jev-control-mode`;
export const SKILL_READ_RULE = `Read(/${SKILL_DIR}/**)`;
export const ALLOWED_TOOLS = Object.freeze(["Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "mcp__jev__*", "mcp__plugin_jev_jev__*", "Agent", SKILL_READ_RULE]);
export const SESSION_PROVIDER = "openrouter";
// D30: the claude.ai connectors (Gmail, Drive, ...) stay out of every session; D14: nobody answers in -p, so a control that runs out of rounds stops with `Incomplete:`.
export const CLAUDEAI_MCP_SERVERS = "false";
export const CONTROL_HEADLESS = "1";

// The prompt is the argument of -p, so the variadic --allowedTools list that ends the command cannot swallow it.
export function buildArgs({ prompt, pluginDir = PLUGIN_DIR, maxTurns = LIMITS.maxTurns }) {
  return [
    "-p", prompt, "--model", "sonnet", "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project", "--plugin-dir", pluginDir, "--permission-mode", PERMISSION_MODE, "--allowedTools", ...ALLOWED_TOOLS,
  ];
}

/**
 * The environment of the worker and of the wrapper: the given environment with
 * JEV_PROVIDER (D29), ENABLE_CLAUDEAI_MCP_SERVERS=false (D30) and
 * JEV_CONTROL_HEADLESS=1 (D14) fixed, JEV_FLOW and every other JEV_CONTROL* key
 * (the launcher's JEV_CONTROL_LIVE and any inherited JEV_CONTROL_THRESHOLD
 * included) removed. The same for baseline and dev: without an active control the
 * headless flag has no effect. The only exception (D33, R05) is an explicit
 * `threshold` option, already validated by `thresholdProblem`: it alone adds
 * JEV_CONTROL_THRESHOLD. Never serialized: it may hold credentials.
 */
export function sessionEnv(env = process.env, { threshold = null } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (key !== "JEV_FLOW" && !key.startsWith("JEV_CONTROL")) out[key] = value;
  out.JEV_PROVIDER = SESSION_PROVIDER;
  out.ENABLE_CLAUDEAI_MCP_SERVERS = CLAUDEAI_MCP_SERVERS;
  out.JEV_CONTROL_HEADLESS = CONTROL_HEADLESS;
  if (threshold !== null && threshold !== undefined) {
    if (thresholdProblem(threshold)) throw new Error(`sessionEnv: ${thresholdProblem(threshold)}`);
    out[THRESHOLD_ENV] = String(threshold).trim();
  }
  return out;
}

/** Why an explicit session threshold (D33) is refused, or null: a string number strictly inside (0.5, 1). */
export function thresholdProblem(threshold) {
  if (threshold === null || threshold === undefined) return null;
  if (typeof threshold !== "string") return "the threshold must be given as text such as 0.90";
  const parsed = parseThreshold(threshold);
  return parsed.ok ? null : `the threshold ${JSON.stringify(threshold.slice(0, 20))} is not a number strictly between 0.5 and 1 (${parsed.reason})`;
}

/** `args` without the prompt, the argument of -p: it is text and not a flag. */
const flagArgs = (args) => {
  const at = args.indexOf("-p");
  return at < 0 ? args : args.filter((_, i) => i !== at + 1);
};
const valueAfter = (args, flag) => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};

// Every flag the configuration validates must appear once: a second occurrence (or a `--flag=value` / alias spelling) could
// override the first, so only a command with exactly one of each is accepted.
const SINGLETON_FLAGS = ["-p", "--model", "--max-turns", "--output-format", "--verbose", "--setting-sources", "--plugin-dir", "--permission-mode", "--allowedTools"];
const FLAG_SPELLINGS = /^--(?:(?:model|max-turns|output-format|verbose|setting-sources|plugin-dir|permission-mode|allowedTools|allowed-tools|disallowedTools|disallowed-tools)=|allowed-tools$|disallowedTools$|disallowed-tools$)/;

// The only flags a session command may carry: those that take one value, -p (its prompt is removed beforehand), --verbose, and the variadic --allowedTools list that ends the command.
const VALUE_FLAGS = new Set(["--model", "--max-turns", "--output-format", "--setting-sources", "--plugin-dir", "--permission-mode"]);
/** The arguments of `flags` (the command without the prompt) that no allowed flag accounts for. */
function unexpectedArguments(flags) {
  const extra = [];
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i];
    if (a === "--allowedTools") break;
    if (VALUE_FLAGS.has(a)) i++;
    else if (a !== "-p" && a !== "--verbose") extra.push(String(a).slice(0, 24));
  }
  return extra;
}

/** Why `args` do not carry the mandatory D27/D28 configuration (empty when they do); bypassing permissions is always refused. */
export function configProblems(args) {
  const problems = [];
  if (args.some((a) => /^--(allow-)?dangerously-skip-permissions$/.test(a) || /bypassPermissions/.test(String(a)))) problems.push("bypassing permissions is not allowed in a test session");
  const flags = flagArgs(args);
  for (const flag of SINGLETON_FLAGS) {
    const n = flags.filter((a) => a === flag).length;
    if (n > 1) problems.push(`${flag} must appear exactly once, not ${n} times`);
  }
  const extra = unexpectedArguments(flags);
  if (extra.length) problems.push(`the session command carries arguments outside the allowed flags: ${extra.join(" ")}`);
  if (flags.some((a) => FLAG_SPELLINGS.test(String(a)))) problems.push("a flag of the session configuration must be written once, as «--flag value», without alias or «=» spelling");
  if (valueAfter(flags, "--permission-mode") !== PERMISSION_MODE) problems.push(`the session must pass --permission-mode ${PERMISSION_MODE}`);
  const tools = flags.indexOf("--allowedTools");
  const list = tools < 0 ? [] : flags.slice(tools + 1);
  if (list.length !== ALLOWED_TOOLS.length || list.some((t, i) => t !== ALLOWED_TOOLS[i])) problems.push("--allowedTools must be exactly the D27 list plus the D45 skill Read rule, last on the command line");
  // Name the widenings that D45 forbids, so the refusal says what to remove (the exact-list check above already refuses them all).
  const widening = list.filter((t) => /^(?:Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep)\b/.test(t) && !ALLOWED_TOOLS.includes(t));
  if (widening.length) problems.push(`the only file permission is ${SKILL_READ_RULE}; remove: ${widening.map((t) => t.slice(0, 60)).join(" ")}`);
  if (flags.includes("--add-dir")) problems.push("--add-dir is not allowed (D45): it would make the directory writable under acceptEdits");
  if (valueAfter(flags, "--setting-sources") !== "project") problems.push("the session must pass --setting-sources project");
  if (valueAfter(flags, "--plugin-dir") !== PLUGIN_DIR) problems.push(`the session must pass --plugin-dir ${PLUGIN_DIR}`);
  if (valueAfter(flags, "--output-format") !== "stream-json" || !flags.includes("--verbose")) problems.push("the session must pass --output-format stream-json --verbose");
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
export function launchProblems({ wrapper, args, ledgerPath = LEDGER, lockPath = LOCK_PATH, testWrapper = false, env = process.env, threshold = null }) {
  const problems = [];
  const bad = thresholdProblem(threshold);
  if (bad) problems.push(bad);
  if (!testWrapper) {
    if (wrapper !== AUTHORIZED_WRAPPER) problems.push("only the authorized budget wrapper may start a test session");
    if (env.JEV_CONTROL_LIVE !== "1") problems.push("JEV_CONTROL_LIVE=1 is required: live sessions are not part of T2");
  } else if (lockPath === LOCK_PATH) {
    problems.push("a simulated executable must use its own lockPath, never the campaign lock");
  }
  const flags = flagArgs(args);
  const at = flags.indexOf("--model");
  if (at < 0 || flags[at + 1] !== "sonnet") problems.push("the session must pass --model sonnet");
  if (!args.includes("-p")) problems.push("a headless session needs -p");
  const turns = flags.indexOf("--max-turns");
  if (turns < 0 || !(Number(flags[turns + 1]) >= 1 && Number(flags[turns + 1]) <= LIMITS.maxTurns)) problems.push(`--max-turns must be 1-${LIMITS.maxTurns}`);
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
export function launch({ wrapper = AUTHORIZED_WRAPPER, args, cwd, outDir, timeoutMs = LIMITS.timeoutMs, testWrapper = false, env = process.env, ledgerPath = LEDGER, lockPath = LOCK_PATH, threshold = null }) {
  mkdirSync(outDir, { recursive: true });
  // The LIVE check reads the launcher's own environment; the child gets sessionEnv(env). An invalid threshold is refused here, before the lock.
  const problems = launchProblems({ wrapper, args, ledgerPath, lockPath, testWrapper, env, threshold });
  if (problems.length) return { ok: false, problems };
  const childEnv = sessionEnv(env, { threshold });
  // Contended launches lose here; a loser touches nothing in any out dir.
  const acquired = acquireLock(lockPath, { outDir });
  if (!acquired.ok) return { ok: false, problems: [lockProblem(lockPath) || `the campaign lock ${lockPath} was taken by another launch`] };
  const { token } = acquired.lock;
  let worker = null;
  try {
    const config = { wrapper, args, cwd, outDir, timeoutMs, lockPath, token, threshold: threshold === null || threshold === undefined ? null : String(threshold).trim() };
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
  const { wrapper, args, cwd, outDir, timeoutMs, lockPath, token, threshold = null } = config;
  if (!updateLock(lockPath, token, { workerPid: process.pid })) {
    process.stderr.write("the campaign lock is not owned by this worker: no session started\n");
    process.exitCode = 5;
    return;
  }
  const logPath = join(outDir, "session.log");
  const started = Date.now();
  const out = openSync(logPath, "a");
  const child = spawn(wrapper, args, { cwd, detached: true, stdio: ["ignore", out, out], env: sessionEnv(process.env, { threshold }) });
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
      // D33: one explicit threshold for this launch; a repeated flag or a missing value is refused, never read as the default.
      const at = rest.indexOf("--threshold");
      const repeated = rest.filter((a) => a === "--threshold").length > 1;
      const value = at >= 0 ? rest[at + 1] : null;
      const result = repeated
        ? { ok: false, problems: ["--threshold may be given once"] }
        : at >= 0 && (value === undefined || value.startsWith("--"))
          ? { ok: false, problems: ["--threshold needs a value such as 0.90"] }
          : launch({ args, cwd: flag("cwd"), outDir, threshold: value });
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

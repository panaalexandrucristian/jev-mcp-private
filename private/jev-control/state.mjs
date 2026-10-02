// jev-control session state: ~/.cache/jev-control/<repo-hash>/<session-hash>/state.json.
// Metadata only (ids, hashes, scores, counters; never code, prompts, payloads or
// logs), 30-day retention, atomic writes under an exclusive lock. It reuses the
// jev-flow primitives that are not specific to the flow (hashing, keys,
// assertMetadataOnly, retention) but has its own root and schema: the flow's
// saveState rejects unknown keys and its root is the jev-flow cache.
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertMetadataOnly, cleanupRetention, repoKey, RETENTION_DAYS, sessionKey, sha256 } from "../jev-flow/state.mjs";
import { DEFAULT_THRESHOLD } from "./threshold.mjs";

export { RETENTION_DAYS, assertMetadataOnly, repoKey, sessionKey, sha256 };

export const STATE_VERSION = 1;
export const BUDGET_LIMIT = 25;
export const SOURCES = Object.freeze(["main", "subagent", "helper", "gate", "tiebreak", "unknown"]);
export const LOG_CAP = 100;
const PENDING_CAP = 64;
const CALLS_CAP = 100;
const BINDING_TTL_MS = 120_000;
const LOCK_WAIT_MS = 1000;

export class ControlBusyError extends Error {
  constructor(message = "jev-control state is locked by another process", { lockPath = null } = {}) {
    super(message);
    this.name = "ControlBusyError";
    this.lockPath = lockPath;
  }
}

export function controlCacheRoot(env = process.env) {
  return env.JEV_CONTROL_CACHE_DIR || join(homedir(), ".cache", "jev-control");
}

/** A real session id is a non-empty string; there is no shared "no-session" identity. */
export function hasSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.trim() !== "";
}

export function controlSessionDir(repoRoot, sessionId, env = process.env) {
  if (!hasSessionId(sessionId)) return null;
  return join(controlCacheRoot(env), repoKey(repoRoot), sessionKey(sessionId));
}

/** Session directory from an already hashed 16-hex session key (hook bindings store only the key). */
export function controlSessionDirFromKey(repoRoot, key, env = process.env) {
  if (!/^[0-9a-f]{16}$/.test(String(key ?? ""))) return null;
  return join(controlCacheRoot(env), repoKey(repoRoot), key);
}

export function emptyBudget() {
  return { limit: BUDGET_LIMIT, extra: 0, attempts: Object.fromEntries(SOURCES.map((s) => [s, 0])), sent: 0, released: 0, history: [] };
}

export function emptyControlState(now = Date.now()) {
  return {
    v: STATE_VERSION,
    created: now,
    updated: now,
    mode: "off",
    threshold: { value: DEFAULT_THRESHOLD, source: "default", since_decision: 0 },
    priorities: "",
    server: null,
    audit: false,
    request: { seq: 0, started: now },
    budget: emptyBudget(),
    pending: {},
    calls: [],
    decisions: [],
    expansions: {},
    searches: {},
    approvals: [],
    notices: [],
    provider_calls: "unknown",
  };
}

const TOP_KEYS = new Set(Object.keys(emptyControlState(0)));

/** One line of at most 300 characters (assertMetadataOnly rejects anything else). */
export function oneLine(text, max = 300) {
  return String(text ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function loadControlState(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (parsed && parsed.v === STATE_VERSION) return { ...emptyControlState(parsed.created), ...parsed };
  } catch {
    // Missing or corrupt state starts fresh: mode off, never an approval.
  }
  return emptyControlState();
}

export function saveControlState(dir, state, now = Date.now()) {
  for (const key of Object.keys(state)) {
    if (!TOP_KEYS.has(key)) throw new Error(`jev-control state rejects key ${key}`);
  }
  state.updated = now;
  if (state.decisions.length > LOG_CAP) state.decisions = state.decisions.slice(-LOG_CAP);
  if (state.calls.length > CALLS_CAP) state.calls = state.calls.slice(-CALLS_CAP);
  if (state.approvals.length > LOG_CAP) state.approvals = state.approvals.slice(-LOG_CAP);
  if (state.notices.length > 20) state.notices = state.notices.slice(-20);
  const pending = Object.entries(state.pending);
  if (pending.length > PENDING_CAP) state.pending = Object.fromEntries(pending.slice(-PENDING_CAP));
  assertMetadataOnly(state, "control-state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.state.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(dir, "state.json"));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath, waitMs) {
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) throw new ControlBusyError(undefined, { lockPath });
    sleepMs(5);
  }
}

function releaseLock(lockPath, token) {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Run fn(state) under an exclusive lock and save the result; nothing is written when the lock cannot be taken. */
export function withControlState(dir, fn, now = Date.now(), { waitMs = LOCK_WAIT_MS } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "lock");
  const token = acquireLock(lockPath, waitMs);
  try {
    const state = loadControlState(dir);
    const result = fn(state);
    saveControlState(dir, state, now);
    return result;
  } finally {
    releaseLock(lockPath, token);
  }
}

export function isControlOn(dir) {
  return Boolean(dir) && loadControlState(dir).mode === "on";
}

export function cleanupControlRetention(env = process.env, now = Date.now()) {
  return cleanupRetention(controlCacheRoot(env), now, RETENTION_DAYS);
}

// ── Session binding (hook → CLI) ────────────────────────────────────────────
// The UserPromptSubmit hook sees the session id of a `/jev:jev-control` prompt and
// stores only its hash here; a CLI that cannot read the id from its own
// environment uses a fresh, unambiguous binding. Two different fresh bindings in
// one repository mean the identity is ambiguous: nothing is bound.
const BINDINGS_FILE = "bindings.json";

export function writeBinding(repoRoot, sessionId, env = process.env, now = Date.now()) {
  if (!hasSessionId(sessionId)) return false;
  const dir = join(controlCacheRoot(env), repoKey(repoRoot));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let bindings = [];
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BINDINGS_FILE), "utf8"));
    if (Array.isArray(parsed)) bindings = parsed;
  } catch {
    // None yet.
  }
  const key = sessionKey(sessionId);
  bindings = bindings.filter((b) => b && typeof b.key === "string" && now - b.ts <= BINDING_TTL_MS && b.key !== key);
  bindings.push({ key, ts: now });
  const tmp = join(dir, `.bindings.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(bindings.slice(-8)), { mode: 0o600 });
  renameSync(tmp, join(dir, BINDINGS_FILE));
  return true;
}

/** {ok: true, key} for exactly one fresh binding, else {ok: false, reason}. */
export function readBinding(repoRoot, env = process.env, now = Date.now()) {
  try {
    const parsed = JSON.parse(readFileSync(join(controlCacheRoot(env), repoKey(repoRoot), BINDINGS_FILE), "utf8"));
    const fresh = (Array.isArray(parsed) ? parsed : []).filter((b) => b && /^[0-9a-f]{16}$/.test(String(b.key)) && now - b.ts <= BINDING_TTL_MS);
    const keys = [...new Set(fresh.map((b) => b.key))];
    if (keys.length === 1) return { ok: true, key: keys[0] };
    return { ok: false, reason: keys.length === 0 ? "no_fresh_binding" : "ambiguous_binding" };
  } catch {
    return { ok: false, reason: "no_fresh_binding" };
  }
}

export function listSessionDirs(repoRoot, env = process.env) {
  try {
    return readdirSync(join(controlCacheRoot(env), repoKey(repoRoot))).filter((n) => /^[0-9a-f]{16}$/.test(n));
  } catch {
    return [];
  }
}

export function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

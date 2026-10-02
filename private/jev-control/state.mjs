// jev-control session state: ~/.cache/jev-control/<repo-hash>/<session-hash>/state.json.
// Metadata only (ids, hashes, scores, counters; never code, prompts, payloads or
// logs), 30-day retention, atomic writes under an exclusive lock. It reuses the
// jev-flow primitives that are not specific to the flow (hashing, keys,
// assertMetadataOnly, retention) but has its own root and schema: the flow's
// saveState rejects unknown keys and its root is the jev-flow cache.
import { randomBytes, timingSafeEqual } from "node:crypto";
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

/** Session directory from an already hashed 16-hex session key (a capability carries only the key). */
export function controlSessionDirFromKey(repoRoot, key, env = process.env) {
  if (!/^[0-9a-f]{16}$/.test(String(key ?? ""))) return null;
  return join(controlCacheRoot(env), repoKey(repoRoot), key);
}

export function emptyBudget() {
  return { limit: BUDGET_LIMIT, extra: 0, attempts: Object.fromEntries(SOURCES.map((s) => [s, 0])), sent: 0, released: 0, approvals: [], history: [] };
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
    consumed: [],
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
  if (state.consumed.length > LOG_CAP) state.consumed = state.consumed.slice(-LOG_CAP);
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

// ── Session capability (hook → CLI) ─────────────────────────────────────────
// A CLI can learn its session in two verifiable ways: the session id Claude Code
// exports to the Bash tool (CLAUDE_CODE_SESSION_ID), or a per-session capability
// "<session key>.<secret>" that the hook, which sees the real session_id, injects
// into that session's own context. The secret is stored 0600 in the session
// directory and checked in constant time; a CLI of another session never holds
// it, so it cannot adopt this session by being the most recent one. Without
// either, there is no identity and nothing is selected by guessing. The
// capability is rotated at every session start and removed at session end.
const CAP_FILE = "cap.json";
const CAP_PATTERN = /^([0-9a-f]{16})\.([0-9a-f]{32})$/;

/** The capability string of the session whose directory is `dir` (created exclusively when missing). */
export function ensureSessionCap(dir, key) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, CAP_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed?.secret === "string" && /^[0-9a-f]{32}$/.test(parsed.secret)) return `${key}.${parsed.secret}`;
    } catch {
      // Missing or unreadable: create it below.
    }
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ secret: randomBytes(16).toString("hex"), created: Date.now() }));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sleepMs(5);
    }
  }
  throw new Error("session capability could not be created");
}

export function removeSessionCap(dir) {
  try {
    unlinkSync(join(dir, CAP_FILE));
  } catch {
    // Already gone.
  }
}

/** {ok: true, key, dir} when `cap` is the live capability of a session of this repository, else {ok: false, reason}. */
export function verifySessionCap(repoRoot, cap, env = process.env) {
  const match = CAP_PATTERN.exec(String(cap ?? ""));
  if (!match) return { ok: false, reason: "capability_malformed" };
  const dir = controlSessionDirFromKey(repoRoot, match[1], env);
  try {
    const stored = JSON.parse(readFileSync(join(dir, CAP_FILE), "utf8"))?.secret;
    const a = Buffer.from(String(stored ?? ""), "utf8");
    const b = Buffer.from(match[2], "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, key: match[1], dir };
  } catch {
    // No capability stored for that session.
  }
  return { ok: false, reason: "capability_unknown_or_expired" };
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

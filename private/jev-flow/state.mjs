// Shared jev-flow state: hashing, snapshots, metadata-only session cache,
// locking and retention. Nothing here persists code, diffs, prompts or logs.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selectGateAttempts } from "./gate-batch.mjs";
import { DENYLIST_FILE, PERMANENT_EXCLUSIONS } from "./paths.mjs";

export const RETENTION_DAYS = 30;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const LIST_CAP = 20;
// Gate attempts and pending calls hold whole batches (up to 16 parts) plus retries.
const GATE_LIST_CAP = 64;
const READS_CAP = 500;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function cacheRoot(env = process.env) {
  return env.JEV_FLOW_CACHE_DIR || join(homedir(), ".cache", "jev-flow");
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeout ?? 8000,
  });
}

/** Absolute git toplevel for a directory, or null outside a work tree. */
export function gitTopLevel(dir) {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch {
    return null;
  }
}

export function repoKey(repoRoot) {
  let real = repoRoot;
  try {
    real = realpathSync(repoRoot);
  } catch {
    // Fall back to the given path.
  }
  return sha256(real).slice(0, 16);
}

export function sessionKey(sessionId) {
  return sha256(String(sessionId ?? "no-session")).slice(0, 16);
}

export function sessionDir(repoRoot, sessionId, env = process.env) {
  return join(cacheRoot(env), repoKey(repoRoot), sessionKey(sessionId));
}

const SNAPSHOT_MAX_HASH_BYTES = 1024 * 1024 * 1024;
const SNAPSHOT_MAX_DEPTH = 4;
// Binds snapshots to the permanent exclusion policy as well as the denylist.
const POLICY_HASH = sha256(JSON.stringify(PERMANENT_EXCLUSIONS));

class SnapshotIncomplete extends Error {}

/** SHA-256 of a regular file, read incrementally. */
function hashFile(abs, budget) {
  const hash = createHash("sha256");
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      budget.bytes += read;
      if (budget.bytes > SNAPSHOT_MAX_HASH_BYTES) throw new SnapshotIncomplete("untracked content exceeds the hashing budget");
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function snapshotParts(repoRoot, depth, budget) {
  if (depth > SNAPSHOT_MAX_DEPTH) throw new SnapshotIncomplete("submodule nesting too deep");
  let head = null;
  try {
    head = git(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch {
    head = null;
  }
  const common = ["--binary", "--no-color", "--no-ext-diff", "--ignore-submodules=dirty"];
  let diffHash;
  let changedTracked;
  if (head) {
    diffHash = sha256(git(repoRoot, ["diff", "HEAD", ...common], { encoding: "buffer" }));
    changedTracked = git(repoRoot, ["diff", "HEAD", "--name-only", "-z", "--ignore-submodules=dirty"]).split("\0");
  } else {
    // No commit yet: index against the empty tree, plus work tree against the index.
    const staged = git(repoRoot, ["diff", "--cached", ...common], { encoding: "buffer" });
    const unstaged = git(repoRoot, ["diff", ...common], { encoding: "buffer" });
    diffHash = sha256(`${sha256(staged)}:${sha256(unstaged)}`);
    changedTracked = [
      ...git(repoRoot, ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=dirty"]).split("\0"),
      ...git(repoRoot, ["diff", "--name-only", "-z", "--ignore-submodules=dirty"]).split("\0"),
    ];
  }
  const untracked = git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort();
  const untrackedHashes = untracked.map((rel) => {
    const abs = join(repoRoot, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new SnapshotIncomplete(`cannot stat ${rel}`);
    }
    if (st.isSymbolicLink()) return [rel, `link:${sha256(readlinkSync(abs))}`];
    if (!st.isFile()) return [rel, "not_regular"];
    try {
      return [rel, hashFile(abs, budget)];
    } catch (error) {
      if (error instanceof SnapshotIncomplete) throw error;
      throw new SnapshotIncomplete(`cannot read ${rel}`);
    }
  });
  // Submodules: `git diff` only says "-dirty"; hash their own content snapshot instead.
  const submodules = git(repoRoot, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .sort()
    .map((rel) => {
      const abs = join(repoRoot, rel);
      let top = null;
      try {
        if (readdirSync(abs).length === 0) return [rel, "not_checked_out"];
        top = gitTopLevel(abs);
      } catch {
        return [rel, "not_checked_out"];
      }
      if (!top || realpathSync(top) !== realpathSync(abs)) throw new SnapshotIncomplete(`submodule ${rel} is not a work tree`);
      const sub = snapshotParts(abs, depth + 1, budget);
      return [rel, sub.hash];
    });
  let denylistHash = null;
  try {
    denylistHash = sha256(readFileSync(join(repoRoot, DENYLIST_FILE)));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new SnapshotIncomplete("cannot read the denylist");
  }
  const hash = sha256(
    JSON.stringify({ head, diff: diffHash, untracked: untrackedHashes, submodules, denylist: denylistHash, policy: POLICY_HASH }),
  );
  const changed = [...new Set([...changedTracked.filter(Boolean), ...untracked])].sort();
  return { hash, head, changed };
}

/**
 * Content snapshot of the work tree: HEAD; staged, unstaged and deleted
 * tracked changes (git diff HEAD --binary, or index and work tree diffs when
 * there is no commit); every untracked non-ignored file hashed by content;
 * each checked-out submodule's own snapshot; the denylist and the permanent
 * exclusion policy. Ignored files are out of scope. mtime is never used.
 * When any part cannot be hashed the snapshot is unknown: {hash: null}.
 */
export function computeSnapshot(repoRoot) {
  try {
    return snapshotParts(repoRoot, 0, { bytes: 0 });
  } catch (error) {
    return { hash: null, head: null, changed: [], error: String(error?.message ?? error) };
  }
}

// ── Metadata-only persistence ───────────────────────────────────────────────

const ALLOWED_TOP_KEYS = new Set([
  "v", "created", "updated", "boot", "baseline", "request", "reads", "pending",
  "tests", "gates", "prior_gates", "redirected", "notified", "counters", "dirty", "parent_model",
]);
// Per-call records hold correlation metadata only: ids, hashes, snapshots,
// sequence numbers, timestamps and exit codes. Jev verdicts, actions and
// validity are never persisted; they are re-read from the native transcript.
// batch/part/of come from the manifest label of a partitioned gate (hex id and integers).
const GATE_KEYS = new Set(["id", "req", "input", "before", "after", "ts", "boot", "failed", "denied", "batch", "part", "of"]);
const TEST_KEYS = new Set(["cmd", "req", "boot", "before", "after", "exit", "failed", "ts"]);
const PENDING_KEYS = new Set(["kind", "before", "input", "cmd", "req", "boot", "ts", "batch", "part", "of"]);

/**
 * Validate that a value is metadata only: numbers, booleans, null, and short
 * single-line strings (hashes, repo-relative paths, ranges, ids).
 * Throws on anything that looks like content.
 */
export function assertMetadataOnly(value, path = "state") {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 300 || /[\n\r]/.test(value)) {
      throw new Error(`jev-flow state rejects non-metadata string at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertMetadataOnly(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.length > 300 || /[\n\r]/.test(k)) throw new Error(`jev-flow state rejects key at ${path}`);
      assertMetadataOnly(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`jev-flow state rejects ${typeof value} at ${path}`);
}

export function emptyState(now = Date.now()) {
  return {
    v: 3,
    created: now,
    updated: now,
    boot: 0,
    baseline: null,
    request: { seq: 0, started: now, exploration: 0, reread_hinted: false, finish_hinted: false },
    reads: {},
    pending: {},
    tests: [],
    gates: [],
    prior_gates: 0,
    redirected: [],
    notified: [],
    counters: { jev_calls: {}, exploration_total: 0, edits: 0, tests: 0 },
    dirty: false,
    parent_model: null,
  };
}

export function loadState(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (parsed && parsed.v === 3) return { ...emptyState(parsed.created), ...parsed };
  } catch {
    // Missing or corrupt state starts fresh; it never becomes approval.
  }
  return emptyState();
}

function assertRecordKeys(records, allowed, name) {
  for (const record of records ?? []) {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new Error(`jev-flow state rejects ${name} field ${key}`);
    }
  }
}

export function saveState(dir, state, now = Date.now()) {
  for (const key of Object.keys(state)) {
    if (!ALLOWED_TOP_KEYS.has(key)) throw new Error(`jev-flow state rejects key ${key}`);
  }
  assertRecordKeys(state.gates, GATE_KEYS, "gate");
  assertRecordKeys(state.tests, TEST_KEYS, "test");
  assertRecordKeys(Object.values(state.pending ?? {}), PENDING_KEYS, "pending");
  state.updated = now;
  if (Object.keys(state.reads).length > READS_CAP) {
    const entries = Object.entries(state.reads).sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0));
    state.reads = Object.fromEntries(entries.slice(0, READS_CAP));
  }
  for (const key of ["tests", "redirected", "notified"]) {
    if (state[key].length > LIST_CAP) state[key] = state[key].slice(-LIST_CAP);
  }
  // A trimmed batch part is a missing part: the batch is then not accepted.
  if (state.gates.length > GATE_LIST_CAP) state.gates = state.gates.slice(-GATE_LIST_CAP);
  const pendingEntries = Object.entries(state.pending);
  if (pendingEntries.length > GATE_LIST_CAP) state.pending = Object.fromEntries(pendingEntries.slice(-GATE_LIST_CAP));
  assertMetadataOnly(state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.state.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(dir, "state.json"));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The state lock could not be obtained in time; nothing was read or written. */
export class StateBusyError extends Error {
  constructor(message = "jev-flow state is locked by another process", { lockPath = null, ownerGone = false } = {}) {
    super(message);
    this.name = "StateBusyError";
    this.lockPath = lockPath;
    this.ownerGone = ownerGone;
  }
}

export const LOCK_WAIT_MS = 1000;

/** True only when the lock names an owner pid that is known to be gone (ESRCH). Diagnostic only. */
function lockOwnerGone(lockPath) {
  let content;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  const pid = Number(String(content).split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/**
 * Take the lock with an exclusive create. A lock is never broken or moved
 * automatically, not even when its owner is gone: no file-system primitive
 * available here can replace it exclusively without racing another process
 * that is recovering it at the same time. After the wait budget the caller
 * gets StateBusyError; a lock left behind by a dead process must be removed
 * by hand (the error and the Stop notice name it).
 */
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
    if (Date.now() >= deadline) {
      const ownerGone = lockOwnerGone(lockPath);
      throw new StateBusyError(
        ownerGone
          ? `jev-flow state lock ${lockPath} belongs to a process that is gone; remove it by hand`
          : "jev-flow state is locked by another process",
        { lockPath, ownerGone },
      );
    }
    sleepMs(10);
  }
}

function ownsLock(lockPath, token) {
  try {
    return readFileSync(lockPath, "utf8") === token;
  } catch {
    return false;
  }
}

function releaseLock(lockPath, token) {
  if (ownsLock(lockPath, token)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run fn(state) under an exclusive lock file so parallel hook processes do
 * not lose updates. The lock is only ever created exclusively and removed by
 * its owner, so no other process can take it while fn runs or between the
 * ownership check and the write. If the lock cannot be obtained within
 * LOCK_WAIT_MS, or it no longer carries this call's token before the write
 * (someone removed or replaced it by hand), this throws StateBusyError and
 * nothing is written: callers treat the state as unknown.
 * `beforeSave` is a test seam called after the ownership check.
 */
export function withState(dir, fn, now = Date.now(), { waitMs = LOCK_WAIT_MS, beforeSave = null } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "lock");
  const token = acquireLock(lockPath, waitMs);
  try {
    const state = loadState(dir);
    const result = fn(state);
    if (!ownsLock(lockPath, token)) throw new StateBusyError("jev-flow state lock ownership changed; update abandoned", { lockPath });
    if (beforeSave) beforeSave();
    saveState(dir, state, now);
    return result;
  } finally {
    releaseLock(lockPath, token);
  }
}

/**
 * Delete session directories older than the retention window. Uses lstat
 * only: symlinks are never followed and never deleted through.
 */
export function cleanupRetention(root = cacheRoot(), now = Date.now(), days = RETENTION_DAYS) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const removed = [];
  let repos = [];
  try {
    repos = readdirSync(root);
  } catch {
    return removed;
  }
  for (const repo of repos) {
    const repoPath = join(root, repo);
    let st;
    try {
      st = lstatSync(repoPath);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let sessions = [];
    try {
      sessions = readdirSync(repoPath);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sessionPath = join(repoPath, session);
      let sst;
      try {
        sst = lstatSync(sessionPath);
      } catch {
        continue;
      }
      if (!sst.isDirectory() || sst.isSymbolicLink()) continue;
      let newest = sst.mtimeMs;
      try {
        newest = Math.max(newest, lstatSync(join(sessionPath, "state.json")).mtimeMs);
      } catch {
        // No state file: directory mtime decides.
      }
      if (newest < cutoff) {
        rmSync(sessionPath, { recursive: true, force: true });
        removed.push(`${repo}/${session}`);
      }
    }
    try {
      if (readdirSync(repoPath).length === 0) rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore races with other sessions.
    }
  }
  return removed;
}

/** Record a Read: returns the number of earlier reads of the same range with the same hash. */
export function recordRead(state, { path, start, end, hash, now = Date.now() }) {
  const key = `${path}#${start}-${end}`;
  if (key.length > 280 || /[\n\r]/.test(key)) return 0;
  const entry = state.reads[key];
  if (entry && entry.sha256 === hash) {
    entry.count += 1;
    entry.last = now;
    return entry.count - 1;
  }
  state.reads[key] = { sha256: hash, count: 1, last: now };
  return 0;
}

/** Canonical hash of a tool input, for correlating a call with its transcript record. */
export function inputHash(input) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
    }
    return value;
  };
  return sha256(JSON.stringify(canonical(input ?? null)));
}

/**
 * What may count for completion among this boot's gate attempts, including
 * attempts that started and never finished (pending, cancelled) or failed.
 * Unlabelled latest attempt: it must belong to the current request (taken
 * when the call started), have known and equal snapshots before and after the
 * call, and match the current snapshot; batch attempts of the same request on
 * this snapshot are returned as `supersededBatch` (the caller requires the
 * single gate to cover their claims). Labelled latest attempt: every part of
 * its batch must satisfy the same conditions (selectGateAttempts). Returns
 * {record, supersededBatch} | {batch} | {reason}. Verdicts are not stored;
 * the caller must re-read and validate them.
 */
export function gateCandidate(state, { snapshot, boot = state.boot, requestSeq = state.request?.seq }) {
  const attempts = [
    ...state.gates.filter((g) => g.boot === boot).map((g) => ({ ...g, pending: false })),
    ...Object.entries(state.pending ?? {})
      .filter(([, p]) => p.kind === "gate" && p.boot === boot)
      .map(([id, p]) => ({ ...p, id, pending: true })),
  ];
  return selectGateAttempts(attempts, { snapshot, requestSeq });
}

/**
 * Real checks count as passing on this snapshot only when, for this boot, no
 * check is still running, at least one check ran, and the latest run of every
 * check command succeeded (exit 0, not failed) with an unchanged snapshot
 * equal to the current one. A later failed or unknown rerun of a command
 * cancels its earlier success.
 */
export function testFreshFor(state, snapshotHash, { boot = state.boot } = {}) {
  if (!snapshotHash) return false;
  if (Object.values(state.pending ?? {}).some((p) => p.kind === "test" && p.boot === boot)) return false;
  const latest = new Map();
  for (const t of [...state.tests].filter((t) => t.boot === boot).sort((a, b) => a.ts - b.ts)) latest.set(t.cmd, t);
  if (latest.size === 0) return false;
  return [...latest.values()].every((t) => !t.failed && t.exit === 0 && t.before === t.after && t.after === snapshotHash);
}

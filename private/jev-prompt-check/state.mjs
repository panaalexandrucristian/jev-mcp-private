// Per-session prompt-check state: settings and numbers only (never prompt or reply text).
// It lives next to the jev-control session state (same repo/session hashes) in its own
// file, so the jev-control and jev-flow state schemas are untouched.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { controlSessionDir } from "../jev-control/state.mjs";
import { LANG_SETTINGS } from "./language.mjs";

export const STATE_FILE = "prompt-check.json";
const LOCK_FILE = "prompt-check.lock";
const LOCK_WAIT_MS = 500;
export const DEFAULT_THRESHOLD = 0.9;

export function defaultState() {
  return { v: 1, mode: "off", threshold: DEFAULT_THRESHOLD, lang: "auto", seen: 0, checked: 0, tips: 0 };
}

export function promptCheckDir(repoRoot, sessionId, env = process.env) {
  return controlSessionDir(repoRoot, sessionId, env);
}

const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

/** Missing, corrupt or foreign state reads as the defaults: mode off. */
export function loadState(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    if (raw && raw.v === 1) {
      const base = defaultState();
      return {
        v: 1,
        mode: raw.mode === "on" ? "on" : "off",
        threshold: validThreshold(raw.threshold) ? raw.threshold : base.threshold,
        lang: LANG_SETTINGS.includes(raw.lang) ? raw.lang : base.lang,
        seen: count(raw.seen),
        checked: count(raw.checked),
        tips: count(raw.tips),
      };
    }
  } catch {
    // Start from the defaults.
  }
  return defaultState();
}

/** True for a number strictly between 0.5 and 1. */
export function validThreshold(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0.5 && value < 1;
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.prompt-check.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(dir, STATE_FILE));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn(state) under an exclusive lock and save the result. Throws when the lock cannot be taken in time. */
export function withState(dir, fn, waitMs = LOCK_WAIT_MS) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, LOCK_FILE);
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
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) throw new Error("prompt-check state is locked");
    sleepMs(5);
  }
  try {
    const state = loadState(dir);
    const result = fn(state);
    saveState(dir, state);
    return result;
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/** A new, resumed, cleared or ended session starts off with zero counters. */
export function resetState(dir) {
  try {
    unlinkSync(join(dir, STATE_FILE));
  } catch {
    // Nothing to reset.
  }
}

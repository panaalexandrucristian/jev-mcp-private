import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BUDGET_LIMIT, budgetLimit, ControlBusyError, DEFAULT_STEP, emptyBudget, cleanupControlRetention, controlCacheRoot, controlSessionDir, controlSessionDirFromKey, emptyControlState, ensureSessionCap, hasSessionId, isControlOn, loadControlState, removeSessionCap, saveControlState, sessionKey, verifySessionCap, withControlState } from "../state.mjs";
import { makeRepo, tempDir } from "./helpers.mjs";

const STATE = fileURLToPath(new URL("../state.mjs", import.meta.url));
const freshDir = () => mkdtempSync(join(tmpdir(), "jc-state-"));

describe("control state is metadata only", () => {
  it("rejects code-like values: long strings, newlines, unknown keys", () => {
    const dir = freshDir();
    const long = emptyControlState();
    long.priorities = "x".repeat(301);
    assert.throws(() => saveControlState(dir, long), /non-metadata string/);
    const nl = emptyControlState();
    nl.priorities = "line one\nline two";
    assert.throws(() => saveControlState(dir, nl), /non-metadata string/);
    const extra = emptyControlState();
    extra.diff = "secret";
    assert.throws(() => saveControlState(dir, extra), /rejects key diff/);
  });
  it("round-trips and starts off", () => {
    const dir = freshDir();
    assert.equal(loadControlState(dir).mode, "off");
    withControlState(dir, (s) => { s.mode = "on"; s.priorities = "fix it"; });
    assert.equal(isControlOn(dir), true);
    assert.equal(loadControlState(dir).priorities, "fix it");
    withControlState(dir, (s) => { s.mode = "off"; });
    assert.equal(isControlOn(dir), false);
  });
  it("a corrupt state file starts fresh and off, never as an approval", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "state.json"), "{not json");
    assert.equal(loadControlState(dir).mode, "off");
  });
  it("caps the logs", () => {
    const dir = freshDir();
    withControlState(dir, (s) => { for (let i = 0; i < 130; i++) s.decisions.push({ id: String(i), req: 1, ts: 1, kind: "approach", t: 0.95, status: "selected", round: 0, opts: [], order: [], calls: 1, tb: 0, snap: null }); });
    assert.equal(loadControlState(dir).decisions.length, 100);
  });
});

describe("locking", () => {
  it("serializes concurrent processes: no lost update", async () => {
    const dir = freshDir();
    const code = `import { withControlState } from ${JSON.stringify(STATE)}; for (let i = 0; i < 10; i++) withControlState(${JSON.stringify(dir)}, (s) => { s.request.seq += 1; }, Date.now(), { waitMs: 5000 });`;
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
      c.on("close", (status) => (status === 0 ? resolve() : reject(new Error(`exit ${status}`))));
    })));
    assert.equal(loadControlState(dir).request.seq, 60);
  });
  it("a lock that is held makes the call fail without writing", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lock"), "99999:held");
    assert.throws(() => withControlState(dir, (s) => { s.mode = "on"; }, Date.now(), { waitMs: 50 }), ControlBusyError);
    assert.equal(loadControlState(dir).mode, "off");
  });
});

describe("identity, locations and retention (D18)", () => {
  it("the state lives under ~/.cache/jev-control/<repo-hash>/<session-hash>", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = {};
    const dir = controlSessionDir(repo, "sess-1", env);
    assert.ok(dir.includes("/.cache/jev-control/"), dir);
    assert.match(dir, /\/[0-9a-f]{16}\/[0-9a-f]{16}$/);
    assert.equal(controlSessionDir(repo, "sess-1", { JEV_CONTROL_CACHE_DIR: "/tmp/cc" }).startsWith("/tmp/cc/"), true);
    assert.equal(controlCacheRoot({ JEV_CONTROL_CACHE_DIR: "/tmp/cc" }), "/tmp/cc");
    assert.equal(controlSessionDirFromKey(repo, sessionKey("sess-1"), env), dir);
    assert.equal(controlSessionDirFromKey(repo, "nothex", env), null);
  });
  it("there is no shared no-session identity", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    for (const id of [undefined, null, "", "  ", 42]) {
      assert.equal(hasSessionId(id), false);
      assert.equal(controlSessionDir(repo, id, {}), null);
    }
  });
  it("sessions are isolated: one session's mode is not another's", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = { JEV_CONTROL_CACHE_DIR: tempDir() };
    withControlState(controlSessionDir(repo, "s1", env), (s) => { s.mode = "on"; });
    assert.equal(isControlOn(controlSessionDir(repo, "s1", env)), true);
    assert.equal(isControlOn(controlSessionDir(repo, "s2", env)), false);
  });
  it("retention removes session directories older than 30 days and keeps newer ones", () => {
    const root = tempDir();
    const env = { JEV_CONTROL_CACHE_DIR: root };
    const repo = makeRepo({ "a.txt": "a\n" });
    const oldDir = controlSessionDir(repo, "old", env);
    const newDir = controlSessionDir(repo, "new", env);
    for (const d of [oldDir, newDir]) withControlState(d, (s) => { s.mode = "on"; });
    const past = (Date.now() - 31 * 24 * 3600 * 1000) / 1000;
    for (const p of [oldDir, join(oldDir, "state.json")]) utimesSync(p, past, past);
    const removed = cleanupControlRetention(env);
    assert.equal(removed.length, 1);
    assert.equal(isControlOn(newDir), true);
    assert.equal(loadControlState(oldDir).mode, "off");
  });
});

describe("the per-session capability (hook -> CLI)", () => {
  const setup = () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = { JEV_CONTROL_CACHE_DIR: tempDir() };
    return { repo, env };
  };
  it("proves the session that owns it, and only that one", () => {
    const { repo, env } = setup();
    const dirA = controlSessionDir(repo, "sess-A", env);
    const dirB = controlSessionDir(repo, "sess-B", env);
    const capA = ensureSessionCap(dirA, sessionKey("sess-A"));
    const capB = ensureSessionCap(dirB, sessionKey("sess-B"));
    assert.notEqual(capA, capB);
    assert.match(capA, /^[0-9a-f]{16}\.[0-9a-f]{32}$/);
    assert.deepEqual(verifySessionCap(repo, capA, env), { ok: true, key: sessionKey("sess-A"), dir: dirA });
    assert.deepEqual(verifySessionCap(repo, capB, env), { ok: true, key: sessionKey("sess-B"), dir: dirB });
    assert.equal(ensureSessionCap(dirA, sessionKey("sess-A")), capA, "stable while the session lives");
  });
  it("another session cannot adopt it: wrong secret, swapped key, malformed and unknown values are refused", () => {
    const { repo, env } = setup();
    const capA = ensureSessionCap(controlSessionDir(repo, "sess-A", env), sessionKey("sess-A"));
    ensureSessionCap(controlSessionDir(repo, "sess-B", env), sessionKey("sess-B"));
    const secretA = capA.split(".")[1];
    assert.equal(verifySessionCap(repo, `${sessionKey("sess-B")}.${secretA}`, env).reason, "capability_unknown_or_expired");
    assert.equal(verifySessionCap(repo, `${sessionKey("sess-A")}.${"0".repeat(32)}`, env).reason, "capability_unknown_or_expired");
    assert.equal(verifySessionCap(repo, `${sessionKey("sess-C")}.${secretA}`, env).reason, "capability_unknown_or_expired");
    for (const bad of [undefined, "", "abc", `${sessionKey("sess-A")}.xyz`, `${sessionKey("sess-A")}.${secretA}.x`]) assert.equal(verifySessionCap(repo, bad, env).reason, "capability_malformed", String(bad));
  });
  it("is removed at session end (rotated at the next start): the old value stops working", () => {
    const { repo, env } = setup();
    const dir = controlSessionDir(repo, "sess-A", env);
    const first = ensureSessionCap(dir, sessionKey("sess-A"));
    removeSessionCap(dir);
    assert.equal(verifySessionCap(repo, first, env).ok, false);
    const second = ensureSessionCap(dir, sessionKey("sess-A"));
    assert.notEqual(second, first);
    assert.equal(verifySessionCap(repo, first, env).ok, false);
    assert.equal(verifySessionCap(repo, second, env).ok, true);
  });
  it("concurrent creation yields one capability, the secret is mode 0600 and never in state.json", () => {
    const { repo, env } = setup();
    const dir = controlSessionDir(repo, "sess-A", env);
    const caps = Array.from({ length: 8 }, () => ensureSessionCap(dir, sessionKey("sess-A")));
    assert.equal(new Set(caps).size, 1);
    assert.equal(statSync(join(dir, "cap.json")).mode & 0o777, 0o600);
    withControlState(dir, (s) => { s.mode = "on"; });
    assert.equal(readFileSync(join(dir, "state.json"), "utf8").includes(caps[0].split(".")[1]), false);
  });
});

describe("state: budget limit", () => {
  it("defaults to 10000 calls per request; JEV_CONTROL_BUDGET_LIMIT (a positive integer) overrides it", () => {
    assert.equal(BUDGET_LIMIT, 10000);
    assert.equal(DEFAULT_STEP, 25);
    assert.equal(budgetLimit({}), 10000);
    assert.equal(budgetLimit({ JEV_CONTROL_BUDGET_LIMIT: "25" }), 25);
    for (const bad of ["0", "-3", "2.5", "abc", ""]) assert.equal(budgetLimit({ JEV_CONTROL_BUDGET_LIMIT: bad }), 10000, bad);
    assert.equal(emptyBudget({}).limit, 10000);
    assert.equal(emptyBudget({ JEV_CONTROL_BUDGET_LIMIT: "7" }).limit, 7);
  });
});

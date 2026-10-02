import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ControlBusyError, cleanupControlRetention, controlCacheRoot, controlSessionDir, controlSessionDirFromKey, emptyControlState, hasSessionId, isControlOn, loadControlState, readBinding, saveControlState, sessionKey, withControlState, writeBinding } from "../state.mjs";
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
    assert.equal(writeBinding(repo, "", { HOME: tempDir() }), false);
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

describe("session binding from the prompt hook", () => {
  it("one fresh binding identifies the session; two are ambiguous; a stale one is nothing", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = { JEV_CONTROL_CACHE_DIR: tempDir() };
    assert.equal(readBinding(repo, env).ok, false);
    const t0 = 1_000_000;
    writeBinding(repo, "sess-A", env, t0);
    assert.deepEqual(readBinding(repo, env, t0 + 1000), { ok: true, key: sessionKey("sess-A") });
    writeBinding(repo, "sess-B", env, t0 + 2000);
    assert.equal(readBinding(repo, env, t0 + 3000).reason, "ambiguous_binding");
    assert.equal(readBinding(repo, env, t0 + 10 * 60 * 1000).ok, false);
    const repoDir = readdirSync(controlCacheRoot(env)).find((n) => /^[0-9a-f]{16}$/.test(n));
    assert.equal(readFileSync(join(controlCacheRoot(env), repoDir, "bindings.json"), "utf8").includes("sess-A"), false, "only hashes are stored");
  });
});

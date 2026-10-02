import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AUTHORIZED_WRAPPER, LEDGER, LIMITS, SESSION_CAP, buildArgs, launch, launchProblems, ledgerCount, readStatus, waitForTermination } from "../run-session.mjs";
import { REPO_ROOT, run, spawnSyncPs, tempDir } from "./helpers.mjs";

/** A simulated wrapper: prints stream-json lines and behaves per FAKE_MODE. It is NOT claude and spends no session. */
function fakeWrapper(dir) {
  const file = join(dir, "fake-claude.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.FAKE_MODE || "ok";
console.log(JSON.stringify({ type: "system", subtype: "init" }));
if (mode === "ok") { console.log(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1 } })); process.exit(0); }
if (mode === "fail") process.exit(3);
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "chatty") setInterval(() => console.log(JSON.stringify({ type: "assistant", message: { id: String(Date.now()) } })), 100);
if (mode === "slow") setTimeout(() => { console.log(JSON.stringify({ type: "result" })); process.exit(0); }, 800);
`);
  chmodSync(file, 0o755);
  return file;
}
const baseArgs = (extra = []) => ["-p", "the prompt", "--model", "sonnet", "--max-turns", "40", ...extra];
const emptyLedger = () => {
  const f = join(tempDir(), "ledger.tsv");
  writeFileSync(f, "");
  return f;
};

describe("launch rules", () => {
  it("builds the session command: sonnet, 40 turns, stream-json, optional plugin dir", () => {
    const args = buildArgs({ prompt: "p", pluginDir: "/x/plugin" });
    assert.deepEqual(args.slice(0, 7), ["-p", "p", "--model", "sonnet", "--max-turns", "40", "--output-format"]);
    assert.ok(args.includes("stream-json"));
    assert.deepEqual(args.slice(-2), ["--plugin-dir", "/x/plugin"]);
    assert.equal(buildArgs({ prompt: "p" }).includes("--plugin-dir"), false);
    assert.equal(LIMITS.maxTurns, 40);
    assert.equal(LIMITS.timeoutMs, 20 * 60 * 1000);
    assert.equal(LIMITS.noProgressMs, 5 * 60 * 1000);
    assert.equal(SESSION_CAP, 20);
  });
  it("only the authorized budget wrapper may start a live session, and only with JEV_CONTROL_LIVE=1", () => {
    const outDir = tempDir();
    const ledgerPath = emptyLedger();
    const p = launchProblems({ wrapper: "/usr/local/bin/claude", args: baseArgs(), ledgerPath, outDir, env: {} });
    assert.match(p.join(" "), /authorized budget wrapper/);
    assert.match(p.join(" "), /JEV_CONTROL_LIVE=1/);
    const live = launchProblems({ wrapper: AUTHORIZED_WRAPPER, args: baseArgs(), ledgerPath, outDir, env: {} });
    assert.match(live.join(" "), /JEV_CONTROL_LIVE=1/);
    assert.deepEqual(launchProblems({ wrapper: AUTHORIZED_WRAPPER, args: baseArgs(), ledgerPath, outDir, env: { JEV_CONTROL_LIVE: "1" } }), []);
  });
  it("requires --model sonnet, -p and --max-turns up to 40", () => {
    const base = { wrapper: "w", ledgerPath: emptyLedger(), outDir: tempDir(), testWrapper: true };
    assert.match(launchProblems({ ...base, args: ["-p", "x", "--max-turns", "40"] }).join(), /--model sonnet/);
    assert.match(launchProblems({ ...base, args: ["-p", "x", "--model", "opus", "--max-turns", "40"] }).join(), /--model sonnet/);
    assert.match(launchProblems({ ...base, args: ["x", "--model", "sonnet", "--max-turns", "40"] }).join(), /needs -p/);
    assert.match(launchProblems({ ...base, args: ["-p", "x", "--model", "sonnet", "--max-turns", "41"] }).join(), /--max-turns/);
    assert.match(launchProblems({ ...base, args: ["-p", "x", "--model", "sonnet"] }).join(), /--max-turns/);
  });
  it("refuses a full or unreadable ledger", () => {
    const full = join(tempDir(), "ledger.tsv");
    writeFileSync(full, Array.from({ length: 20 }, (_, i) => `${i + 1}\tt\tsonnet\t/x`).join("\n") + "\n");
    assert.equal(ledgerCount(full), 20);
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: full, outDir: tempDir(), testWrapper: true }).join(), /20\/20/);
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: join(tempDir(), "missing.tsv"), outDir: tempDir(), testWrapper: true }).join(), /cannot be read/);
  });
});

describe("a simulated session: detached, sequential, confirmed termination", () => {
  it("runs to the end detached from this process and writes a status after the wrapper exited", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const wrapper = fakeWrapper(dir);
    const argvFile = join(dir, "argv.jsonl");
    const started = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), env: { ...process.env, FAKE_ARGV: argvFile, FAKE_MODE: "ok" } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForTermination(outDir, { timeoutMs: 20_000 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.status.exit, 0);
    assert.equal(done.status.result_seen, true);
    assert.equal(done.status.timed_out, false);
    assert.equal(done.status.counted, true);
    assert.equal(existsSync(join(outDir, "running.lock")), false);
    assert.match(readFileSync(join(outDir, "session.log"), "utf8"), /"type":"result"/);
    assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8").trim()), baseArgs());
    assert.equal(readFileSync(join(outDir, "launch.json"), "utf8").includes("the prompt"), false, "the prompt is not stored");
  });
  it("the worker leads its own session (fully detached: not in this process group)", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const started = launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "slow" } });
    const pgid = Number(spawnSyncPs(started.pid));
    assert.equal(pgid, started.pid, "the worker is a process group (session) leader");
    assert.notEqual(pgid, process.pid);
    await waitForTermination(outDir, { timeoutMs: 20_000 });
  });
  it("one at a time: a second launch is refused while the first runs, allowed after its termination is confirmed", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const wrapper = fakeWrapper(dir);
    const env = { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "slow" };
    const ledgerPath = emptyLedger();
    const first = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, env });
    assert.equal(first.ok, true);
    // The lock appears once the worker started.
    for (let i = 0; i < 100 && !existsSync(join(outDir, "running.lock")); i++) await new Promise((r) => setTimeout(r, 20));
    const second = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, env });
    assert.equal(second.ok, false);
    assert.match(second.problems.join(), /still running/);
    const done = await waitForTermination(outDir, { timeoutMs: 20_000 });
    assert.equal(done.ok, true);
    const third = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, env: { ...env, FAKE_MODE: "ok" } });
    assert.equal(third.ok, true);
    await waitForTermination(outDir, { timeoutMs: 20_000 });
  });
  it("a failed session is recorded and still counts; no result message is not success", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "fail" } });
    const done = await waitForTermination(outDir, { timeoutMs: 20_000 });
    assert.equal(done.status.exit, 3);
    assert.equal(done.status.result_seen, false);
    assert.equal(done.status.counted, true);
  });
  it("the external time limit kills a stuck session; the timeout is a recorded failure, not a success", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, timeoutMs: 600, noProgressMs: 60_000, testWrapper: true, ledgerPath: emptyLedger(), env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "chatty" } });
    const done = await waitForTermination(outDir, { timeoutMs: 20_000 });
    assert.equal(done.status.timed_out, true);
    assert.equal(done.status.no_progress, false);
    assert.equal(done.status.result_seen, false);
    assert.equal(done.status.counted, true);
  });
  it("a session whose log shows no progress is stopped", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, timeoutMs: 60_000, noProgressMs: 700, testWrapper: true, ledgerPath: emptyLedger(), env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "hang" } });
    const done = await waitForTermination(outDir, { timeoutMs: 20_000 });
    assert.equal(done.status.no_progress, true);
    assert.equal(done.status.timed_out, false);
    assert.equal(readStatus(outDir).state, "done");
  });
});

describe("T2 starts no live session", () => {
  it("the CLI refuses a launch without JEV_CONTROL_LIVE=1 and the real ledger does not change", () => {
    const before = ledgerCount(LEDGER);
    const dir = tempDir();
    const promptFile = join(dir, "p.txt");
    writeFileSync(promptFile, "x");
    const env = { ...process.env };
    delete env.JEV_CONTROL_LIVE;
    const r = run(process.execPath, [join(REPO_ROOT, "private", "jev-control", "run-session.mjs"), "launch", "--prompt-file", promptFile, "--cwd", dir, "--out-dir", join(dir, "o")], { env });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /JEV_CONTROL_LIVE=1/);
    assert.equal(ledgerCount(LEDGER), before);
  });
});

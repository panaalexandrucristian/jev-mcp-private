import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { ALLOWED_TOOLS, AUTHORIZED_WRAPPER, CLAUDEAI_MCP_SERVERS, CONTROL_HEADLESS, LEDGER, LIMITS, LOCK_PATH, PLUGIN_DIR, SESSION_CAP, acquireLock, buildArgs, configProblems, describeLock, launch, launchProblems, ledgerCount, readStatus, releaseLock, releaseStale, sessionEnv, thresholdProblem, updateLock, waitForTermination } from "../run-session.mjs";
import { REPO_ROOT, run, spawnSyncPs, tempDir } from "./helpers.mjs";

const RUN_SESSION = join(REPO_ROOT, "private", "jev-control", "run-session.mjs");

/** A simulated wrapper: prints stream-json lines and behaves per FAKE_MODE. It is NOT claude and spends no session. */
function fakeWrapper(dir) {
  const file = join(dir, "fake-claude.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_ENV) writeFileSync(process.env.FAKE_ENV, JSON.stringify(process.env));
const mode = process.env.FAKE_MODE || "ok";
console.log(JSON.stringify({ type: "system", subtype: "init" }));
if (mode === "ok") { console.log(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1 } })); process.exit(0); }
if (mode === "fail") process.exit(3);
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "chatty") setInterval(() => console.log(JSON.stringify({ type: "assistant", message: { id: String(Date.now()) } })), 100);
if (mode === "slow") setTimeout(() => { console.log(JSON.stringify({ type: "result" })); process.exit(0); }, 800);
if (mode === "sleep") setTimeout(() => { console.log(JSON.stringify({ type: "result" })); process.exit(0); }, 1000);
if (mode === "quiet") setTimeout(() => { console.log(JSON.stringify({ type: "result" })); process.exit(0); }, 2500);
`);
  chmodSync(file, 0o755);
  return file;
}
const baseArgs = () => buildArgs({ prompt: "the prompt" });
const emptyLedger = () => {
  const f = join(tempDir(), "ledger.tsv");
  writeFileSync(f, "");
  return f;
};
// Every test uses its own campaign lock: the real one is never touched.
const tempLock = () => join(tempDir(), "jev-control-session.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fn()) return true;
  return false;
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Launch from a separate node process (a real, short-lived launcher), starting at the wall-clock time `at` so concurrent launchers really race. */
function launchInProcess(opts, env, at = 0) {
  const script = join(tempDir(), "launcher.mjs");
  writeFileSync(script, `import { launch } from ${JSON.stringify(pathToFileURL(RUN_SESSION).href)};
const opts = JSON.parse(process.env.LAUNCH_OPTS);
while (Date.now() < opts.at) { /* barrier: all launchers start together */ }
process.stdout.write(JSON.stringify(launch({ ...opts.launch, env: process.env })));
`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...env, LAUNCH_OPTS: JSON.stringify({ at, launch: opts }) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`launcher gave no result: ${stdout} ${stderr}`));
      }
    });
  });
}

describe("launch rules", () => {
  it("builds the exact session command: sonnet, 40 turns, stream-json, D28 isolation, D27 permissions", () => {
    const args = buildArgs({ prompt: "p" });
    assert.deepEqual(args, [
      "-p", "p", "--model", "sonnet", "--max-turns", "40", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "project", "--plugin-dir", "/Users/apana/Dev/jev-mcp", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "mcp__jev__*", "mcp__plugin_jev_jev__*", "Agent",
    ]);
    assert.equal(PLUGIN_DIR, "/Users/apana/Dev/jev-mcp");
    assert.equal(args[1], "p", "the prompt is the argument of -p, before the variadic --allowedTools list");
    assert.equal(args.indexOf("--allowedTools") + ALLOWED_TOOLS.length, args.length - 1, "the allowlist is last");
    assert.equal(args.some((a) => /bypass|dangerously/i.test(a)), false);
    assert.deepEqual(configProblems(args), []);
    assert.equal(LIMITS.maxTurns, 40);
    assert.equal(LIMITS.timeoutMs, 20 * 60 * 1000);
    assert.equal("noProgressMs" in LIMITS, false, "the 20-minute limit is the only automatic stop");
    assert.equal(/noProgress|no_progress/.test(readFileSync(RUN_SESSION, "utf8")), false);
    assert.equal(SESSION_CAP, 20);
  });
  it("refuses a command without the mandatory configuration or with a permission bypass", () => {
    const base = { wrapper: "w", ledgerPath: emptyLedger(), lockPath: tempLock(), testWrapper: true };
    const good = baseArgs();
    assert.deepEqual(launchProblems({ ...base, args: good }), []);
    const swap = (flag, value) => good.map((a, i) => (good[i - 1] === flag ? value : a));
    assert.match(launchProblems({ ...base, args: [...good, "--dangerously-skip-permissions"] }).join(), /bypassing permissions/);
    assert.match(launchProblems({ ...base, args: swap("--permission-mode", "bypassPermissions") }).join(), /bypassing permissions/);
    assert.match(launchProblems({ ...base, args: swap("--permission-mode", "default") }).join(), /--permission-mode acceptEdits/);
    assert.match(launchProblems({ ...base, args: swap("--setting-sources", "user,project") }).join(), /--setting-sources project/);
    assert.match(launchProblems({ ...base, args: swap("--plugin-dir", "/tmp/other") }).join(), /--plugin-dir/);
    assert.match(launchProblems({ ...base, args: swap("--output-format", "json") }).join(), /stream-json/);
    assert.match(launchProblems({ ...base, args: good.filter((a) => a !== "--verbose") }).join(), /stream-json/);
    assert.match(launchProblems({ ...base, args: good.slice(0, good.indexOf("--allowedTools")) }).join(), /allowedTools/);
    assert.match(launchProblems({ ...base, args: good.slice(0, -1) }).join(), /allowedTools/);
    assert.match(launchProblems({ ...base, args: [...good, "Bash(rm:*)"] }).join(), /allowedTools/);
    assert.match(launchProblems({ ...base, args: [...good.slice(0, good.indexOf("--allowedTools")), "--allowedTools", "Bash(*)"] }).join(), /allowedTools/);
  });
  it("a repeated or conflicting configuration flag is refused, wherever it stands before the allowlist", () => {
    const base = { wrapper: "w", ledgerPath: emptyLedger(), lockPath: tempLock(), testWrapper: true };
    const good = baseArgs();
    const at = good.indexOf("--setting-sources");
    const before = (...extra) => [...good.slice(0, at), ...extra, ...good.slice(at)];
    const repeated = [
      [["--setting-sources", "user"], /--setting-sources must appear exactly once/],
      [["--plugin-dir", "/other/plugin"], /--plugin-dir must appear exactly once/],
      [["--permission-mode", "default"], /--permission-mode must appear exactly once/],
      [["--model", "opus"], /--model must appear exactly once/],
      [["--max-turns", "1"], /--max-turns must appear exactly once/],
      [["--output-format", "json"], /--output-format must appear exactly once/],
      [["--verbose"], /--verbose must appear exactly once/],
      [["--allowedTools", "Bash(rm:*)"], /--allowedTools must appear exactly once/],
      [["-p", "another prompt"], /-p must appear exactly once/],
    ];
    for (const [extra, pattern] of repeated) {
      assert.match(launchProblems({ ...base, args: before(...extra) }).join(), pattern, extra.join(" "));
      assert.match(configProblems(before(...extra)).join(), pattern, extra.join(" "));
    }
    // The same flags placed first, or an extra one placed after a valid one, are as refused.
    assert.notDeepEqual(configProblems(["--permission-mode", "default", ...good]), []);
    assert.notDeepEqual(configProblems(["--setting-sources", "user", ...good]), []);
    assert.notDeepEqual(configProblems(["--plugin-dir", "/other/plugin", ...good]), []);
    // Alias and «=» spellings could override the checked flag.
    for (const spelled of ["--permission-mode=default", "--setting-sources=user", "--plugin-dir=/other/plugin", "--allowed-tools", "--allowedTools=Bash(*)", "--model=opus", "--disallowedTools"]) {
      assert.notDeepEqual(configProblems(before(spelled)), [], spelled);
    }
    // A prompt that looks like a flag is text: the command stays valid.
    assert.deepEqual(configProblems(buildArgs({ prompt: "--permission-mode" })), []);
    assert.deepEqual(launchProblems({ ...base, args: buildArgs({ prompt: "--model" }) }), []);
    assert.deepEqual(configProblems(good), []);
  });
  it("sessionEnv fixes JEV_PROVIDER (D29), ENABLE_CLAUDEAI_MCP_SERVERS=false (D30) and JEV_CONTROL_HEADLESS=1 (D14), drops JEV_FLOW and every other JEV_CONTROL* key, without touching the input", () => {
    const input = { PATH: "/bin", OPENROUTER_API_KEY: "k", JEV_FLOW: "on", JEV_CONTROL: "on", JEV_CONTROL_LIVE: "1", JEV_CONTROL_CACHE: "/c", JEV_CONTROL_HEADLESS: "0", JEV_PROVIDER: "openai", ENABLE_CLAUDEAI_MCP_SERVERS: "true", JEV_OTHER: "x" };
    const snapshot = JSON.stringify(input);
    const out = sessionEnv(input);
    assert.deepEqual(out, { PATH: "/bin", OPENROUTER_API_KEY: "k", JEV_PROVIDER: "openrouter", ENABLE_CLAUDEAI_MCP_SERVERS: "false", JEV_CONTROL_HEADLESS: "1", JEV_OTHER: "x" });
    assert.equal(JSON.stringify(input), snapshot, "the input is not modified");
    assert.deepEqual(sessionEnv({}), { JEV_PROVIDER: "openrouter", ENABLE_CLAUDEAI_MCP_SERVERS: "false", JEV_CONTROL_HEADLESS: "1" });
    assert.equal(CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(CONTROL_HEADLESS, "1");
  });
  it("only the allowed flags are accepted: an extra configuration flag with or without a value is refused, a prompt that looks like one is text", () => {
    const base = { wrapper: "w", ledgerPath: emptyLedger(), lockPath: tempLock(), testWrapper: true };
    const good = baseArgs();
    const at = good.indexOf("--setting-sources");
    const before = (...extra) => [...good.slice(0, at), ...extra, ...good.slice(at)];
    for (const extra of [["--settings", "{}"], ["--mcp-config", "x.json"], ["--strict-mcp-config"], ["--add-dir", "/tmp"], ["--system-prompt", "x"], ["--append-system-prompt", "x"], ["--agents", "{}"], ["--tools", "Bash"], ["--disallowedTools", "Read"], ["--continue"], ["--resume", "id"], ["stray"]]) {
      assert.match(configProblems(before(...extra)).join(), /outside the allowed flags/, extra.join(" "));
      assert.match(launchProblems({ ...base, args: before(...extra) }).join(), /outside the allowed flags/, extra.join(" "));
    }
    assert.match(configProblems([...good.slice(0, good.indexOf("--allowedTools")), "--settings", "{}", "--allowedTools", ...ALLOWED_TOOLS]).join(), /outside the allowed flags/, "also when written before the list");
    assert.deepEqual(configProblems(good), []);
    assert.deepEqual(configProblems(buildArgs({ prompt: "--settings {}" })), []);
    assert.deepEqual(configProblems(buildArgs({ prompt: "--mcp-config x.json", maxTurns: 5 })), []);
  });
  it("only the authorized budget wrapper may start a live session, and only with JEV_CONTROL_LIVE=1", () => {
    const lockPath = tempLock();
    const ledgerPath = emptyLedger();
    const p = launchProblems({ wrapper: "/usr/local/bin/claude", args: baseArgs(), ledgerPath, lockPath, env: {} });
    assert.match(p.join(" "), /authorized budget wrapper/);
    assert.match(p.join(" "), /JEV_CONTROL_LIVE=1/);
    const live = launchProblems({ wrapper: AUTHORIZED_WRAPPER, args: baseArgs(), ledgerPath, lockPath, env: {} });
    assert.match(live.join(" "), /JEV_CONTROL_LIVE=1/);
    assert.deepEqual(launchProblems({ wrapper: AUTHORIZED_WRAPPER, args: baseArgs(), ledgerPath, lockPath, env: { JEV_CONTROL_LIVE: "1" } }), []);
  });
  it("a simulated executable can never use the campaign lock", () => {
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: emptyLedger(), testWrapper: true }).join(), /own lockPath/);
    assert.equal(LOCK_PATH.endsWith("/jev-control-session.lock"), true);
  });
  it("requires --model sonnet, -p and --max-turns up to 40", () => {
    const base = { wrapper: "w", ledgerPath: emptyLedger(), lockPath: tempLock(), testWrapper: true };
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
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: full, lockPath: tempLock(), testWrapper: true }).join(), /20\/20/);
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: join(tempDir(), "missing.tsv"), lockPath: tempLock(), testWrapper: true }).join(), /cannot be read/);
  });
});

describe("a simulated session: detached, sequential, confirmed termination", () => {
  it("runs to the end detached from this process and writes a status after the wrapper exited", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const wrapper = fakeWrapper(dir);
    const argvFile = join(dir, "argv.jsonl");
    const lockPath = tempLock();
    const started = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: argvFile, FAKE_MODE: "ok", FAKE_ENV: join(dir, "env.json"), JEV_FLOW: "on", JEV_CONTROL: "on", JEV_CONTROL_LIVE: "1", JEV_CONTROL_CACHE: "/c", JEV_PROVIDER: "openai" } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.status.exit, 0);
    assert.equal(done.status.result_seen, true);
    assert.equal(done.status.timed_out, false);
    assert.equal(done.status.counted, true);
    assert.equal(existsSync(lockPath), false, "the worker released the campaign lock");
    assert.equal(done.status.group_gone, true);
    assert.match(readFileSync(join(outDir, "session.log"), "utf8"), /"type":"result"/);
    assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8").trim()), baseArgs(), "the wrapper received exactly the mandatory configuration");
    const seen = JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
    assert.equal(seen.JEV_PROVIDER, "openrouter");
    assert.equal(seen.ENABLE_CLAUDEAI_MCP_SERVERS, "false", "D30: the connectors stay off");
    assert.equal(seen.JEV_CONTROL_HEADLESS, "1", "D14: nobody answers in -p");
    assert.deepEqual(Object.keys(seen).filter((k) => k === "JEV_FLOW" || (k.startsWith("JEV_CONTROL") && k !== "JEV_CONTROL_HEADLESS")), [], "no JEV_FLOW or other JEV_CONTROL* key reaches the wrapper");
    assert.equal(seen.FAKE_MODE, "ok", "the rest of the environment is kept");
    const stored = readFileSync(join(outDir, "launch.json"), "utf8");
    assert.equal(/JEV_PROVIDER|OPENROUTER|JEV_FLOW|JEV_CONTROL|ENABLE_CLAUDEAI/.test(stored), false, "the environment is never serialized");
    assert.equal(readFileSync(join(outDir, "launch.json"), "utf8").includes("the prompt"), false, "the prompt is not stored");
  });
  it("the worker leads its own session (fully detached: not in this process group)", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const lockPath = tempLock();
    const started = launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "slow" } });
    const pgid = Number(spawnSyncPs(started.pid));
    assert.equal(pgid, started.pid, "the worker is a process group (session) leader");
    assert.notEqual(pgid, process.pid);
    assert.ok(await until(() => describeLock(lockPath).lock?.childPid), "the worker recorded the child pid");
    const lock = describeLock(lockPath).lock;
    assert.equal(lock.workerPid, started.pid);
    assert.equal(Number(spawnSyncPs(lock.childPid)), lock.childPid, "the wrapper leads its own process group");
    await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
  });
  it("one at a time: a second launch is refused while the first runs, allowed after its termination is confirmed", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const wrapper = fakeWrapper(dir);
    const env = { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "slow" };
    const ledgerPath = emptyLedger();
    const lockPath = tempLock();
    const first = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, lockPath, env });
    assert.equal(first.ok, true);
    // The lock exists as soon as launch returns: the launcher took it before spawning.
    assert.equal(existsSync(lockPath), true);
    const second = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, lockPath, env });
    assert.equal(second.ok, false);
    assert.match(second.problems.join(), /still running/);
    const done = await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
    assert.equal(done.ok, true);
    const third = launch({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, lockPath, env: { ...env, FAKE_MODE: "ok" } });
    assert.equal(third.ok, true);
    await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
  });
  it("a failed session is recorded and still counts; no result message is not success", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const lockPath = tempLock();
    launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "fail" } });
    const done = await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
    assert.equal(done.status.exit, 3);
    assert.equal(done.status.result_seen, false);
    assert.equal(done.status.counted, true);
  });
  it("the external time limit kills a stuck session; the timeout is a recorded failure, not a success", async () => {
    for (const mode of ["chatty", "hang"]) {
      const dir = tempDir();
      const outDir = join(dir, "out");
      const lockPath = tempLock();
      launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, timeoutMs: 600, testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: mode } });
      const done = await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
      assert.equal(done.status.timed_out, true, mode);
      assert.equal(done.status.result_seen, false);
      assert.equal(done.status.counted, true);
      assert.equal(done.status.group_gone, true);
      assert.equal(existsSync(lockPath), false);
    }
  });
  it("there is no no-progress stop: a session silent for longer than the old window runs to its own end", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const lockPath = tempLock();
    // 2.5 s of silence against a 60 s time limit; the removed rule used to stop silence at a shortened window.
    launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir, timeoutMs: 60_000, testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "quiet" } });
    const done = await waitForTermination(outDir, { timeoutMs: 20_000, lockPath });
    assert.equal(done.status.exit, 0);
    assert.equal(done.status.signal, null);
    assert.equal(done.status.timed_out, false);
    assert.equal(done.status.result_seen, true);
    assert.equal("no_progress" in done.status, false);
    assert.equal(readStatus(outDir).state, "done");
  });
});

describe("the campaign-wide lock", () => {
  for (const sameOutDir of [true, false]) {
    it(`of 4 simultaneous launches in ${sameOutDir ? "the same" : "different"} out dirs exactly one starts, the others are refused naming the owner`, async () => {
      const dir = tempDir();
      const wrapper = fakeWrapper(dir);
      const argvFile = join(dir, "argv.jsonl");
      const ledgerPath = emptyLedger();
      const lockPath = tempLock();
      const env = { ...process.env, FAKE_ARGV: argvFile, FAKE_MODE: "sleep" };
      const outDirs = [0, 1, 2, 3].map((i) => join(dir, sameOutDir ? "out" : `out${i}`));
      // Separate launcher processes released by one barrier: the race is real.
      const at = Date.now() + 1500;
      const results = await Promise.all(outDirs.map((outDir) => launchInProcess({ wrapper, args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, lockPath }, env, at)));
      const winners = results.map((r, i) => ({ r, outDir: outDirs[i] })).filter((x) => x.r.ok);
      assert.equal(winners.length, 1, JSON.stringify(results));
      for (const r of results.filter((x) => !x.ok)) assert.match(r.problems.join(), /launcher pid \d+, worker pid .*out dir /);
      if (!sameOutDir) for (const outDir of outDirs.filter((o) => o !== winners[0].outDir)) assert.equal(existsSync(join(outDir, "launch.json")), false, "a refused launch touches nothing");
      const done = await waitForTermination(winners[0].outDir, { timeoutMs: 20_000, lockPath });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.status.exit, 0);
      assert.equal(readFileSync(argvFile, "utf8").trim().split("\n").length, 1, "the wrapper ran exactly once");
      assert.equal(existsSync(lockPath), false);
    });
  }
  it("the lock records its owner; only the owner token may update or release it", () => {
    const lockPath = tempLock();
    const { ok, lock } = acquireLock(lockPath, { outDir: "/some/out" });
    assert.equal(ok, true);
    assert.deepEqual(Object.keys(lock).sort(), ["childPid", "launcherPid", "outDir", "startedAt", "token", "workerPid"]);
    assert.equal(lock.launcherPid, process.pid);
    assert.equal(lock.workerPid, null);
    assert.equal(lock.childPid, null);
    assert.equal(acquireLock(lockPath, { outDir: "/other" }).ok, false, "an exclusive create cannot take an existing lock");
    assert.equal(updateLock(lockPath, "not-the-token", { workerPid: 1234 }), false);
    assert.equal(releaseLock(lockPath, "not-the-token"), false);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).workerPid, null);
    assert.equal(updateLock(lockPath, lock.token, { workerPid: process.pid, childPid: process.pid, token: "forged" }), true);
    const now = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(now.workerPid, process.pid);
    assert.equal(now.token, lock.token, "the token cannot be rewritten");
    assert.equal(releaseLock(lockPath, lock.token), true);
    assert.equal(existsSync(lockPath), false);
  });
  it("a vanished worker does not prove the session ended: a live child keeps the lock; it is released by nobody but the owner", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const wrapper = fakeWrapper(dir);
    const ledgerPath = emptyLedger();
    const lockPath = tempLock();
    const env = { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "hang" };
    // The launcher is a separate process that exits, as in real use.
    const started = await launchInProcess({ wrapper, args: baseArgs(), cwd: dir, outDir, timeoutMs: 120_000, testWrapper: true, ledgerPath, lockPath }, env);
    assert.equal(started.ok, true, JSON.stringify(started));
    let childPid = null;
    try {
      assert.ok(await until(() => describeLock(lockPath).lock?.childPid), "the worker recorded the child pid");
      const { lock } = describeLock(lockPath);
      childPid = lock.childPid;
      assert.equal(lock.workerPid, started.pid);
      process.kill(lock.workerPid, "SIGKILL");
      assert.ok(await until(() => !isAlive(lock.workerPid)), "the worker is gone");
      assert.equal(isAlive(childPid), true, "the simulated Claude outlives its worker");
      // Even a status that says done does not end it: the child is alive.
      writeFileSync(join(outDir, "status.json"), JSON.stringify({ state: "done" }));
      const d = describeLock(lockPath);
      assert.equal(d.state, "live");
      assert.match(d.live.join(), new RegExp(`childPid ${childPid}`));
      const refused = launch({ wrapper, args: baseArgs(), cwd: dir, outDir: join(dir, "other"), testWrapper: true, ledgerPath, lockPath, env });
      assert.equal(refused.ok, false);
      assert.match(refused.problems.join(), /still running/);
      assert.match(refused.problems.join(), new RegExp(`child pid ${childPid}`));
      const waited = await waitForTermination(outDir, { timeoutMs: 600, pollMs: 100, lockPath });
      assert.equal(waited.ok, false);
      assert.match(waited.reason, /live/);
      // Only the child's process group is left alive: still held.
      process.kill(childPid, "SIGKILL");
      assert.ok(await until(() => !isAlive(childPid)), "the child is gone");
      assert.equal(describeLock(lockPath).state, "stale", "every recorded pid is dead");
      // Stale is reported, never removed silently: a launch is refused and says how to inspect it.
      const stale = launch({ wrapper, args: baseArgs(), cwd: dir, outDir: join(dir, "other"), testWrapper: true, ledgerPath, lockPath, env });
      assert.equal(stale.ok, false);
      assert.match(stale.problems.join(), /stale/);
      assert.match(stale.problems.join(), /release-stale --lock-path /);
      assert.equal(existsSync(lockPath), true);
      // With the status done and nothing alive, termination is confirmed.
      assert.equal((await waitForTermination(outDir, { timeoutMs: 2000, pollMs: 50, lockPath })).ok, true);
      const released = run(process.execPath, [RUN_SESSION, "release-stale", "--lock-path", lockPath]);
      assert.equal(released.code, 0, released.stdout + released.stderr);
      assert.equal(JSON.parse(released.stdout).removed, true);
      assert.equal(existsSync(lockPath), false);
      const next = launch({ wrapper, args: baseArgs(), cwd: dir, outDir: join(dir, "next"), testWrapper: true, ledgerPath, lockPath, env: { ...env, FAKE_MODE: "ok" } });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal((await waitForTermination(join(dir, "next"), { timeoutMs: 20_000, lockPath })).ok, true);
    } finally {
      if (childPid) {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
  it("a lock whose recorded pids are all dead is stale: reported, refused, removed only by release-stale", async () => {
    const dir = tempDir();
    const outDir = join(dir, "out");
    const lockPath = tempLock();
    const ledgerPath = emptyLedger();
    const [a, b, c] = [deadPid(), deadPid(), deadPid()];
    writeFileSync(lockPath, JSON.stringify({ launcherPid: a, token: "t", outDir, startedAt: Date.now() - 60_000, workerPid: b, childPid: c }));
    assert.equal(describeLock(lockPath).state, "stale");
    const problems = launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath, lockPath, testWrapper: true });
    assert.match(problems.join(), /stale/);
    assert.match(problems.join(), new RegExp(`worker pid ${b}`));
    assert.match(problems.join(), /release-stale/);
    assert.equal(launch({ wrapper: "w", args: baseArgs(), cwd: dir, outDir, testWrapper: true, ledgerPath, lockPath }).ok, false);
    assert.equal(existsSync(lockPath), true, "not removed silently");
    // Nothing alive and no done status: waiting reports the stale lock instead of success.
    const waited = await waitForTermination(outDir, { timeoutMs: 300, pollMs: 50, lockPath });
    assert.equal(waited.ok, false);
    assert.match(waited.reason, /stale/);
    // A live pid anywhere in the lock blocks the removal, whichever field holds it.
    for (const key of ["launcherPid", "workerPid", "childPid"]) {
      writeFileSync(lockPath, JSON.stringify({ launcherPid: a, token: "t", outDir, startedAt: 0, workerPid: b, childPid: c, [key]: process.pid }));
      assert.equal(describeLock(lockPath).state, "live", key);
      const r = releaseStale(lockPath);
      assert.equal(r.ok, false, key);
      assert.equal(r.removed, false);
      assert.equal(existsSync(lockPath), true);
    }
    // With every pid dead the CLI subcommand removes it.
    writeFileSync(lockPath, JSON.stringify({ launcherPid: a, token: "t", outDir, startedAt: 0, workerPid: b, childPid: c }));
    const cli = run(process.execPath, [RUN_SESSION, "release-stale", "--lock-path", lockPath]);
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assert.equal(existsSync(lockPath), false);
    assert.equal(releaseStale(lockPath).removed, false, "no lock: nothing to do");
  });
  it("a young lock without a worker pid is still starting (live); an old one is stale; an unreadable one is not removed while young", () => {
    const lockPath = tempLock();
    const dead = deadPid();
    writeFileSync(lockPath, JSON.stringify({ launcherPid: dead, token: "t", outDir: "/o", startedAt: Date.now(), workerPid: null, childPid: null }));
    assert.equal(describeLock(lockPath).state, "live");
    assert.equal(releaseStale(lockPath).ok, false);
    writeFileSync(lockPath, JSON.stringify({ launcherPid: dead, token: "t", outDir: "/o", startedAt: Date.now() - 120_000, workerPid: null, childPid: null }));
    assert.equal(describeLock(lockPath).state, "stale");
    writeFileSync(lockPath, "{not json");
    assert.equal(describeLock(lockPath).state, "unreadable");
    assert.match(launchProblems({ wrapper: "w", args: baseArgs(), ledgerPath: emptyLedger(), lockPath, testWrapper: true }).join(), /cannot be read/);
    assert.equal(releaseStale(lockPath).ok, false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(releaseStale(lockPath, { startGraceMs: 0 }).removed, true);
  });
});

describe("D33 (R05): the one explicit JEV_CONTROL_THRESHOLD exception", () => {
  const withInherited = { PATH: "/bin", JEV_CONTROL_THRESHOLD: "0.7", JEV_CONTROL_LIVE: "1", JEV_CONTROL_CACHE: "/c", JEV_FLOW: "on" };
  it("sessionEnv: without the option an inherited JEV_CONTROL_THRESHOLD is removed; with it only that key is added; nothing else JEV_CONTROL* survives", () => {
    assert.equal("JEV_CONTROL_THRESHOLD" in sessionEnv(withInherited), false);
    assert.equal("JEV_CONTROL_THRESHOLD" in sessionEnv(withInherited, {}), false);
    assert.equal("JEV_CONTROL_THRESHOLD" in sessionEnv(withInherited, { threshold: null }), false);
    const out = sessionEnv(withInherited, { threshold: "0.90" });
    assert.equal(out.JEV_CONTROL_THRESHOLD, "0.90", "the explicit value wins over the inherited 0.7");
    assert.deepEqual(Object.keys(out).filter((k) => k.startsWith("JEV_CONTROL") || k === "JEV_FLOW").sort(), ["JEV_CONTROL_HEADLESS", "JEV_CONTROL_THRESHOLD"]);
    assert.deepEqual(sessionEnv({}, { threshold: "0.9" }), { JEV_PROVIDER: "openrouter", ENABLE_CLAUDEAI_MCP_SERVERS: "false", JEV_CONTROL_HEADLESS: "1", JEV_CONTROL_THRESHOLD: "0.9" });
    assert.throws(() => sessionEnv({}, { threshold: "1" }), /strictly between 0.5 and 1/);
  });
  it("only a number strictly inside (0.5, 1), given as text, is accepted; anything else refuses the launch before the lock", () => {
    for (const ok of ["0.90", "0.9", "0.51", "0.999", " 0.9 "]) assert.equal(thresholdProblem(ok), null, ok);
    assert.equal(thresholdProblem(null), null);
    assert.equal(thresholdProblem(undefined), null);
    for (const bad of ["0.5", "1", "1.2", "0", "-0.9", "abc", "", "  ", "0.9x", "1e-1", 0.9, true, {}]) assert.notEqual(thresholdProblem(bad), null, JSON.stringify(bad));
    const base = { wrapper: "w", ledgerPath: emptyLedger(), lockPath: tempLock(), testWrapper: true };
    assert.deepEqual(launchProblems({ ...base, args: baseArgs() }), []);
    assert.deepEqual(launchProblems({ ...base, args: baseArgs(), threshold: "0.90" }), []);
    assert.match(launchProblems({ ...base, args: baseArgs(), threshold: "1.2" }).join(" "), /strictly between 0.5 and 1/);
    const dir = tempDir();
    const lockPath = tempLock();
    const refused = launch({ wrapper: fakeWrapper(dir), args: baseArgs(), cwd: dir, outDir: join(dir, "out"), testWrapper: true, ledgerPath: emptyLedger(), lockPath, env: { ...process.env, FAKE_ARGV: join(dir, "a.jsonl") }, threshold: "abc" });
    assert.equal(refused.ok, false);
    assert.match(refused.problems.join(" "), /strictly between 0.5 and 1/);
    assert.equal(existsSync(lockPath), false, "no lock was taken");
    assert.equal(existsSync(join(dir, "a.jsonl")), false, "the wrapper never ran");
  });
  it("the option reaches the wrapper through the worker's configuration; the next launch without it does not inherit it; launch.json records it without any environment", async () => {
    const dir = tempDir();
    const wrapper = fakeWrapper(dir);
    const lockPath = tempLock();
    const ledgerPath = emptyLedger();
    const env = { ...process.env, FAKE_ARGV: join(dir, "a.jsonl"), FAKE_MODE: "ok", JEV_CONTROL_THRESHOLD: "0.7" };
    const first = launch({ wrapper, args: baseArgs(), cwd: dir, outDir: join(dir, "o1"), testWrapper: true, ledgerPath, lockPath, env: { ...env, FAKE_ENV: join(dir, "env1.json") }, threshold: "0.90" });
    assert.equal(first.ok, true, JSON.stringify(first));
    const done1 = await waitForTermination(join(dir, "o1"), { timeoutMs: 20_000, lockPath });
    assert.equal(done1.ok, true, JSON.stringify(done1));
    const seen1 = JSON.parse(readFileSync(join(dir, "env1.json"), "utf8"));
    assert.equal(seen1.JEV_CONTROL_THRESHOLD, "0.90", "the wrapper's environment carries the explicit threshold, not the inherited 0.7");
    assert.equal(seen1.JEV_CONTROL_HEADLESS, "1");
    assert.deepEqual(Object.keys(seen1).filter((k) => k === "JEV_FLOW" || (k.startsWith("JEV_CONTROL") && !["JEV_CONTROL_HEADLESS", "JEV_CONTROL_THRESHOLD"].includes(k))), []);
    const stored1 = JSON.parse(readFileSync(join(dir, "o1", "launch.json"), "utf8"));
    assert.equal(stored1.threshold, "0.90");
    assert.equal(/JEV_PROVIDER|OPENROUTER|JEV_FLOW|JEV_CONTROL|ENABLE_CLAUDEAI/.test(JSON.stringify(stored1)), false, "the environment is never serialized");
    const second = launch({ wrapper, args: baseArgs(), cwd: dir, outDir: join(dir, "o2"), testWrapper: true, ledgerPath, lockPath, env: { ...env, FAKE_ENV: join(dir, "env2.json") } });
    assert.equal(second.ok, true, JSON.stringify(second));
    const done2 = await waitForTermination(join(dir, "o2"), { timeoutMs: 20_000, lockPath });
    assert.equal(done2.ok, true, JSON.stringify(done2));
    const seen2 = JSON.parse(readFileSync(join(dir, "env2.json"), "utf8"));
    assert.equal("JEV_CONTROL_THRESHOLD" in seen2, false, "without the option, even an inherited value is removed");
    assert.equal(JSON.parse(readFileSync(join(dir, "o2", "launch.json"), "utf8")).threshold, null);
  });
  it("the CLI refuses a repeated --threshold, one without a value and an invalid one; none of them touches the real ledger or lock", () => {
    const before = ledgerCount(LEDGER);
    const lockBefore = existsSync(LOCK_PATH);
    const dir = tempDir();
    const promptFile = join(dir, "p.txt");
    writeFileSync(promptFile, "x");
    // No JEV_CONTROL_LIVE: even a regression here can never start (and count) a real session.
    const env = { ...process.env };
    delete env.JEV_CONTROL_LIVE;
    const base = ["launch", "--prompt-file", promptFile, "--cwd", dir];
    const cases = [
      [["--threshold", "0.9", "--threshold", "0.8"], /may be given once/],
      [["--threshold"], /needs a value/],
      [["--threshold", "--cwd"], /needs a value/],
      [["--threshold", "1.5"], /strictly between 0.5 and 1/],
      [["--threshold", "abc"], /strictly between 0.5 and 1/],
    ];
    for (const [extra, pattern] of cases) {
      const r = run(process.execPath, [RUN_SESSION, ...base, "--out-dir", join(dir, "o"), ...extra], { env });
      assert.equal(r.code, 4, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, pattern, extra.join(" "));
      assert.equal(ledgerCount(LEDGER), before, "the ledger does not change");
      assert.equal(existsSync(LOCK_PATH), lockBefore, "no lock was taken");
    }
  });
});

describe("T2 starts no live session", () => {
  it("the CLI refuses a launch without JEV_CONTROL_LIVE=1; the real ledger and the real lock do not change", () => {
    const before = ledgerCount(LEDGER);
    const lockBefore = existsSync(LOCK_PATH);
    const dir = tempDir();
    const promptFile = join(dir, "p.txt");
    writeFileSync(promptFile, "x");
    const env = { ...process.env };
    delete env.JEV_CONTROL_LIVE;
    const r = run(process.execPath, [RUN_SESSION, "launch", "--prompt-file", promptFile, "--cwd", dir, "--out-dir", join(dir, "o")], { env });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /JEV_CONTROL_LIVE=1/);
    assert.equal(ledgerCount(LEDGER), before);
    assert.equal(existsSync(LOCK_PATH), lockBefore);
  });
});

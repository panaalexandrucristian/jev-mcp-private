import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { S3 } from "../fixtures/scenarios.mjs";
import { materialize } from "../fixtures/lib.mjs";
import { ASK_ID, CONTROL_IDS, GATHER_ID, KINDS, MAX_OPTIONS, MIN_OPTIONS, normalizeBatch } from "../options.mjs";
import { actionHash, normalizeDescriptor, planItem, shortHash } from "../actions.mjs";
import { cleanupLine, compactOut } from "../cli.mjs";
import { classifyClaimsSource, ClaimsRefused, consumableClaimsName, loadClaims, splitClaims } from "../claimsfile.mjs";
import { controlSessionDir, ensureSessionCap, loadControlState, removeSessionCap, sessionKey, withControlState } from "../state.mjs";
import { batchOf, cli, CONTROL_CLI, controlEnv, gateAnswer, makeRepo, REPO_ROOT, run, serverLog, tempDir, writeFiles } from "./helpers.mjs";

const SID = ["--session-id", "cli-session-1"];
const on = (repo, env, extra = []) => cli(["on", ...SID, "--priorities", "fix it with the smallest change", ...extra], { env, cwd: repo });
const writeBatch = (obj) => {
  const file = join(tempDir(), "batch.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
};
const noulScript = (probs, more = {}) => ({ noul: [{ p: probs }], ...more });
const p7 = (real) => [...real, 0.1, 0.1];

describe("activation (D1, D2, D13, D16)", () => {
  it("on checks the contracts, stores the mode, threshold and priorities, and reports them", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const r = on(repo, env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.mode, "on");
    assert.equal(r.json.threshold, 0.95);
    assert.equal(r.json.threshold_source, "default");
    assert.equal(r.json.priorities, "fix it with the smallest change");
    assert.equal(r.json.audit, "available");
    assert.match(r.json.server, /fake-jev@9\.9\.9/);
    // R02: two dev sessions switched the mode on and then decided and searched nothing; the line the model reads next says what to do.
    assert.match(r.json.next, /decide --file/);
    assert.match(r.json.next, /choose the order yourself/);
    assert.match(r.json.next, /search/);
    assert.match(r.json.next, /\/jev:jev-done/);
    // R04: SKILL.md can be unreadable (a Read outside the working directory is refused in a headless run); the line says where the batch format is.
    assert.match(r.json.next, /`help decide`/);
    assert.match(r.json.next, /`help search`/);
    assert.ok(r.stdout.trim().length < 900, `the line stays compact (${r.stdout.trim().length} characters)`);
    const state = loadControlState(controlSessionDir(repo, "cli-session-1", env));
    assert.equal(state.mode, "on");
    assert.equal(state.request.seq, 1);
    assert.equal(serverLog(env).length, 0, "activation spends no tools/call");
  });
  it("status, off and a changed threshold (later decisions only)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: noulScript(p7([0.9, 0.5, 0.4, 0.3, 0.2])) });
    on(repo, env);
    const status = cli(["status", ...SID], { env, cwd: repo });
    assert.equal(status.json.mode, "on");
    assert.equal(status.json.budget.limit, 25);
    assert.equal(status.json.budget.provider_calls, "unknown");
    const decided = cli(["decide", ...SID, "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    assert.equal(decided.json.status, "expand", "0.9 is not above 0.95");
    const t = cli(["threshold", "0.85", ...SID], { env, cwd: repo });
    assert.equal(t.json.threshold, 0.85);
    assert.equal(t.json.applies_to, "later decisions only");
    const state = loadControlState(controlSessionDir(repo, "cli-session-1", env));
    assert.equal(state.decisions[0].t, 0.95, "the logged decision keeps the threshold it was taken with");
    assert.equal(state.threshold.value, 0.85);
    assert.equal(cli(["off", ...SID], { env, cwd: repo }).json.mode, "off");
    assert.equal(cli(["status", ...SID], { env, cwd: repo }).json.mode, "off");
  });
  it("the threshold: session argument beats the environment; invalid values give 0.95 and one notice", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ extra: { JEV_CONTROL_THRESHOLD: "0.8" } });
    assert.equal(on(repo, env).json.threshold, 0.8);
    assert.equal(on(repo, env, ["--threshold", "0.9"]).json.threshold, 0.9);
    const bad = on(repo, env, ["--threshold", "1"]);
    assert.equal(bad.json.threshold, 0.95);
    assert.match(bad.json.notice, /not a number in \(0\.5, 1\)/);
    const badEnv = controlEnv({ extra: { JEV_CONTROL_THRESHOLD: "abc" } });
    assert.equal(on(repo, badEnv).json.threshold, 0.95);
    const t = cli(["threshold", "0.5", ...SID], { env, cwd: repo });
    assert.equal(t.json.threshold, 0.95);
    assert.match(t.json.notice, /using 0\.95/);
  });
  it("refuses without a real session identity (nothing is activated)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const r = cli(["on"], { env, cwd: repo });
    assert.equal(r.code, 4);
    assert.match(r.json.message, /no verifiable session identity/);
  });
  it("takes the identity from CLAUDE_CODE_SESSION_ID, or from the per-session capability the hook injected", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const viaEnv = controlEnv({ extra: { CLAUDE_CODE_SESSION_ID: "env-session" } });
    const a = cli(["on"], { env: viaEnv, cwd: repo });
    assert.equal(a.json.session, "environment");
    const env = controlEnv();
    const cap = ensureSessionCap(controlSessionDir(repo, "capped-session", env), sessionKey("capped-session"));
    const b = cli(["on", "--session-cap", cap], { env, cwd: repo });
    assert.equal(b.json.session, "capability");
    assert.equal(loadControlState(controlSessionDir(repo, "capped-session", env)).mode, "on");
  });
  it("never adopts the most recent session: without an identity of its own a CLI is refused, whatever other sessions did", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    // Session A just activated (its hook injected a capability); a CLI of session B has neither the id nor the capability.
    const capA = ensureSessionCap(controlSessionDir(repo, "session-A", env), sessionKey("session-A"));
    assert.equal(cli(["on", "--session-cap", capA], { env, cwd: repo }).code, 0);
    for (const args of [["on"], ["status"], ["decide", "--file", "x"], ["budget", "status"]]) {
      const r = cli(args, { env, cwd: repo });
      assert.equal(r.code, 4, args[0]);
      assert.match(r.json.message, /no verifiable session identity/);
    }
    assert.equal(loadControlState(controlSessionDir(repo, "session-A", env)).mode, "on");
  });
  it("two simultaneous sessions in one repository stay apart, and a subagent with the parent's capability shares the parent's state", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const capA = ensureSessionCap(controlSessionDir(repo, "session-A", env), sessionKey("session-A"));
    const capB = ensureSessionCap(controlSessionDir(repo, "session-B", env), sessionKey("session-B"));
    assert.equal(cli(["on", "--session-cap", capA, "--threshold", "0.9"], { env, cwd: repo }).json.threshold, 0.9);
    assert.equal(cli(["on", "--session-cap", capB, "--threshold", "0.8"], { env, cwd: repo }).json.threshold, 0.8);
    assert.equal(cli(["status", "--session-cap", capA], { env, cwd: repo }).json.threshold, 0.9);
    assert.equal(cli(["status", "--session-cap", capB], { env, cwd: repo }).json.threshold, 0.8);
    // A subagent is a separate process that was handed the parent's capability: same session, source recorded as subagent.
    const sub = cli(["budget", "reserve", "--session-cap", capA, "--tool", "noul", "--source", "subagent"], { env, cwd: repo });
    assert.equal(sub.json.status, "ok");
    assert.equal(cli(["budget", "status", "--session-cap", capA], { env, cwd: repo }).json.by_source.subagent, 1);
    assert.equal(cli(["budget", "status", "--session-cap", capB], { env, cwd: repo }).json.by_source.subagent, 0);
  });
  it("a wrong, foreign, malformed or expired capability is refused; so is one that contradicts the environment's session", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    const dirA = controlSessionDir(repo, "session-A", env);
    const capA = ensureSessionCap(dirA, sessionKey("session-A"));
    const secretA = capA.split(".")[1];
    for (const bad of [`${sessionKey("session-B")}.${secretA}`, `${sessionKey("session-A")}.${"0".repeat(32)}`, "garbage"]) {
      const r = cli(["status", "--session-cap", bad], { env, cwd: repo });
      assert.equal(r.code, 4, bad);
      assert.match(r.json.message, /capability is not valid/);
    }
    const conflict = cli(["status", "--session-cap", capA], { env: { ...env, CLAUDE_CODE_SESSION_ID: "session-B" }, cwd: repo });
    assert.match(conflict.json.message, /identity_conflict/);
    removeSessionCap(dirA);
    const expired = cli(["status", "--session-cap", capA], { env, cwd: repo });
    assert.equal(expired.code, 4);
    assert.match(expired.json.message, /capability_unknown_or_expired/);
  });
  it("refuses when the repository opts out of Jev", () => {
    const repo = makeRepo({ "a.txt": "a\n", ".jev-flow-denylist": "*\n" });
    const r = on(repo, controlEnv());
    assert.equal(r.code, 4);
    assert.match(r.json.message, /opts out of Jev/);
  });
  it("refuses when Jev cannot be reached (the contracts cannot be checked): no credentials", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    delete env.OPENROUTER_API_KEY;
    const r = on(repo, env);
    assert.equal(r.code, 4);
    assert.match(r.json.message, /Jev unavailable/);
  });
  it("refuses and names a missing core tool; an incompatible schema is refused too", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const names = "screen,verify,noul,find,rerank,classify,compare,extract,review,gate,audit";
    const missing = on(repo, controlEnv({ extra: { FAKE_CONTROL_TOOLS: names } }));
    assert.equal(missing.code, 4);
    assert.match(missing.json.message, /decide/);
    const noSchema = on(repo, controlEnv({ extra: { FAKE_CONTROL_NO_SCHEMA: "1" } }));
    assert.equal(noSchema.code, 4);
    assert.match(noSchema.json.message, /missing or incompatible/);
  });
  it("without jev_audit only that function is off", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const names = "screen,verify,noul,find,rerank,classify,decide,compare,extract,review,gate";
    const r = on(repo, controlEnv({ extra: { FAKE_CONTROL_TOOLS: names } }));
    assert.equal(r.code, 0);
    assert.match(r.json.audit, /unavailable/);
  });
  it("every command except on refuses while the mode is off", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const args of [["decide", "--file", "x"], ["search", "--query", "q"], ["done", "--claims", "x"]]) {
      const r = cli([...args, ...SID], { env, cwd: repo });
      assert.equal(r.code, 4, args[0]);
      assert.match(r.json.message, /jev-control is off/);
    }
  });
});

describe("decide through the CLI", () => {
  it("selected: compact one-line output, a signed receipt bound to the concrete action, counts and reserves", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.97, 0.5, 0.4, 0.3]) }], decide: [{ selected: "o2", confidence: 0.96 }] } });
    on(repo, env);
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(5, { kind: "command" }))], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(Buffer.byteLength(r.stdout.trim()) <= 1500);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.equal(r.json.status, "selected");
    const ah = (n) => shortHash(actionHash(normalizeDescriptor({ tool: "Bash", target: `npm run check-${n}` }).descriptor));
    assert.deepEqual(r.json.plan, [`o2:e:0.97:${ah(2)}`, `o1:r:0.99:${ah(1)}`], "compact items: id, step, raw score, action hash");
    assert.equal(r.json.plan_total, 2);
    assert.equal(r.json.plan_next, undefined, "complete");
    assert.equal(r.json.provenance, undefined, "provenance goes to the receipt, not to the output");
    assert.match(r.json.receipt, /^[0-9a-f]{32}$/);
    assert.equal(serverLog(env).map((l) => l.name).join(), "jev_noul,jev_decide");
    const budget = cli(["budget", "status", ...SID], { env, cwd: repo });
    assert.equal(budget.json.used, 2);
    assert.equal(budget.json.by_source.helper, 1);
    assert.equal(budget.json.by_source.tiebreak, 1);
    const verify = (args) => cli(["receipt", "verify", ...SID, "--id", r.json.receipt, ...args], { env, cwd: repo });
    assert.equal(verify(["--option", "o2"]).json.message, "action_required");
    assert.equal(verify(["--option", "o2", "--tool", "Bash", "--target", "rm -rf build"]).json.message, "action_mismatch", "a changed command under the same id");
    const reserve = verify(["--option", "o1", "--tool", "Bash", "--target", "npm run check-1"]);
    assert.equal(reserve.code, 4);
    assert.equal(reserve.json.authorized, false);
    assert.equal(verify(["--option", "o2", "--tool", "Bash", "--target", "npm   run  check-2"]).json.message, "action_mismatch", "a command is bound exactly, spaces included");
    const dry = verify(["--option", "o2", "--tool", "Bash", "--target", "npm run check-2", "--dry-run"]);
    assert.deepEqual([dry.json.authorized, dry.json.consumed], [true, false]);
    const ok = verify(["--option", "o2", "--tool", "Bash", "--target", "npm run check-2"]);
    assert.deepEqual([ok.json.authorized, ok.json.consumed], [true, true]);
    const replay = verify(["--option", "o2", "--tool", "Bash", "--target", "npm run check-2"]);
    assert.equal(replay.json.message, "receipt_replayed");
    assert.equal(loadControlState(controlSessionDir(repo, "cli-session-1", env)).consumed.length, 1);
  });
  it("receipt verify refuses a false precondition and a stale snapshot", () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.5, 0.4, 0.3, 0.2]) }, { p: [0.5, 0.4, 0.3, 0.2, 0.1, 0.1] }] } });
    on(repo, env);
    const batch = batchOf(5, { kind: "edit" });
    batch.options[0].preconditions = [{ kind: "path_exists", path: "a.js" }];
    const d = cli(["decide", ...SID, "--decision-id", "p1", "--file", writeBatch(batch)], { env, cwd: repo });
    assert.equal(d.json.status, "selected", d.stdout);
    const action = writeBatch(batch.options[0].action);
    // An Edit is bound by its replacement too: --tool/--target alone cannot name it.
    const bare = cli(["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", "o1", "--tool", "Edit", "--target", "src/file-1.js"], { env, cwd: repo });
    assert.match(bare.json.message, /old_string is required/);
    const args = ["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", "o1", "--action-file", action];
    // The precondition (a.js exists) held at decision time; deleting it before the action makes the authorization fail.
    unlinkSync(join(repo, "a.js"));
    const stale = cli(args, { env, cwd: repo });
    assert.match(stale.json.message, /receipt_stale_snapshot|precondition_failed/);
    assert.equal(stale.json.authorized, false);
    const d2 = cli(["decide", ...SID, "--decision-id", "p2", "--file", writeBatch(batch)], { env, cwd: repo });
    assert.equal(d2.json.status, "expand", "the option is unavailable now: its precondition is false");
    assert.deepEqual(d2.json.unavailable, ["o1:path_exists_missing"]);
  });
  describe("an order plan through the CLI: each later step needs its own evidence unchanged", () => {
    const orderPlan = (sandbox) => {
      const repo = makeRepo({ "src/file-1.js": "one\n", "src/file-2.js": "two\n" });
      const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.98, 0.5, 0.4, 0.3]) }, { p: p7([0.99, 0.98, 0.5, 0.4, 0.3]) }], decide: [{ selected: "o1", confidence: 0.97 }] } });
      on(repo, env);
      const batch = batchOf(5, { kind: "order" });
      batch.options[0].action = { tool: "Edit", target: "src/file-1.js", old_string: "one", new_string: "uno" };
      batch.options[1].action = { tool: "Edit", target: "src/file-2.js", old_string: "two", new_string: "dos" };
      const d = cli(["decide", ...SID, "--decision-id", sandbox, "--file", writeBatch(batch)], { env, cwd: repo });
      assert.equal(d.json.status, "ordered", d.stdout);
      const verify = (n) => cli(["receipt", "verify", ...SID, "--id", d.json.receipt, "--option", `o${n}`, "--action-file", writeBatch(batch.options[n - 1].action)], { env, cwd: repo });
      return { repo, verify };
    };
    it("a change to an unrelated file after the first step is allowed", () => {
      const { repo, verify } = orderPlan("ord1");
      assert.equal(verify(1).json.authorized, true);
      writeFiles(repo, { "src/file-1.js": "uno\n", "notes.txt": "something else\n" });
      assert.equal(verify(2).json.authorized, true);
    });
    it("a change to the file the next step works on, even though step one was only authorized, refuses it", () => {
      const { repo, verify } = orderPlan("ord2");
      assert.equal(verify(1).json.authorized, true);
      writeFiles(repo, { "src/file-2.js": "changed by someone else\n" });
      const r = verify(2);
      assert.equal(r.json.authorized, false);
      assert.equal(r.json.message, "receipt_evidence_changed:src/file-2.js");
    });
    it("before any use, any change at all refuses the receipt", () => {
      const { repo, verify } = orderPlan("ord3");
      writeFiles(repo, { "notes.txt": "something else\n" });
      assert.equal(verify(1).json.message, "receipt_stale_snapshot");
    });
  });
  it("a batch with 20 options still prints at most 1.5 KB", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const probs = [0.99, ...Array(19).fill(0.2)];
    const env = controlEnv({ script: { noul: [{ p: probs }] } });
    on(repo, env);
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(18))], { env, cwd: repo });
    assert.equal(r.json.status, "selected");
    assert.ok(Buffer.byteLength(r.stdout.trim()) <= 1500, String(Buffer.byteLength(r.stdout.trim())));
  });
  it("an invalid batch is refused before anything is sent (exit 4)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    on(repo, env);
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(3))], { env, cwd: repo });
    assert.equal(r.code, 4);
    assert.equal(r.json.status, "invalid");
    assert.equal(serverLog(env).length, 0);
  });
  it("Jev unavailable after the single retry: exit 3 and 'Jev unavailable'; both attempts counted", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ fail: "transport" }, { fail: "transport" }] } });
    on(repo, env);
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    assert.equal(r.code, 3);
    assert.match(r.json.message, /^Jev unavailable/);
    assert.equal(serverLog(env).length, 2);
    assert.equal(cli(["budget", "status", ...SID], { env, cwd: repo }).json.used, 2);
  });
  it("headless: no eligible option after the rounds ends as incomplete, report starting Incomplete:", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const none = { p: p7([0.8, 0.7, 0.6, 0.5, 0.4]) };
    const env = controlEnv({ script: { noul: [none, none, none] } });
    on(repo, env);
    const run1 = cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    assert.equal(run1.json.status, "expand");
    const b1 = batchOf(5, { extra: { new_material: "n1" } });
    b1.options[0].evidence = ["new 1"];
    assert.equal(cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", writeBatch(b1)], { env, cwd: repo }).json.status, "expand");
    const b2 = batchOf(5, { extra: { new_material: "n2" } });
    b2.options[1].evidence = ["new 2"];
    const last = cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", writeBatch(b2)], { env, cwd: repo });
    assert.equal(last.json.status, "incomplete");
    assert.match(last.json.report, /^Incomplete: /);
    assert.equal(last.code, 2);
  });
  it("sanitizes: a credential in the evidence never reaches the server", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: noulScript(p7([0.99, 0.5, 0.4, 0.3, 0.2])) });
    on(repo, env);
    const batch = batchOf(5);
    batch.options[0].evidence = [`the token is ${"sk-or-v1-" + "b".repeat(40)} in config`];
    cli(["decide", ...SID, "--file", writeBatch(batch)], { env, cwd: repo });
    const sent = JSON.stringify(serverLog(env));
    assert.equal(sent.includes("sk-or-v1-bbbb"), false);
    assert.equal(serverLog(env).length, 1);
  });
  it("a repository that opts out after activation sends nothing", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    on(repo, env);
    writeFileSync(join(repo, ".jev-flow-denylist"), "*\n");
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    assert.equal(r.code, 4);
    assert.equal(serverLog(env).length, 0);
  });
});

describe("the decide result names the scratch batch file to remove (R06)", () => {
  const FILE = "jev-batch.json";
  const LINE = "if you wrote jev-batch.json for this decision, remove it now: rm -f jev-batch.json, alone in its own command";
  const batchIn = (repo, obj) => writeFileSync(join(repo, FILE), JSON.stringify(obj));
  it("selected carries the line, one line of at most 1500 bytes, naming the file as given", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.97, 0.5, 0.4, 0.3]) }], decide: [{ selected: "o2", confidence: 0.96 }] } });
    on(repo, env);
    batchIn(repo, batchOf(5, { kind: "command" }));
    const r = cli(["decide", ...SID, "--file", FILE], { env, cwd: repo });
    assert.equal(r.json.status, "selected", r.stdout);
    assert.equal(r.json.cleanup, LINE);
    assert.ok(Buffer.byteLength(r.stdout.trim()) <= 1500);
    assert.equal(r.stdout.trim().split("\n").length, 1);
  });
  it("an expand does not ask for removal (the file is fixed and run again); the incomplete that ends the batch does", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const none = { p: p7([0.8, 0.7, 0.6, 0.5, 0.4]) };
    const env = controlEnv({ script: { noul: [none, none, none] } });
    on(repo, env);
    batchIn(repo, batchOf(5));
    const first = cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", FILE], { env, cwd: repo });
    assert.equal(first.json.status, "expand");
    assert.equal(first.json.cleanup, undefined, "an expansion reruns the same file");
    const b1 = batchOf(5, { extra: { new_material: "n1" } });
    b1.options[0].evidence = ["new 1"];
    batchIn(repo, b1);
    assert.equal(cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", FILE], { env, cwd: repo }).json.cleanup, undefined);
    const b2 = batchOf(5, { extra: { new_material: "n2" } });
    b2.options[1].evidence = ["new 2"];
    batchIn(repo, b2);
    const last = cli(["decide", ...SID, "--headless", "--decision-id", "dec1", "--file", FILE], { env, cwd: repo });
    assert.equal(last.json.status, "incomplete");
    assert.equal(last.json.cleanup, LINE);
  });
  it("an invalid batch and a refused repository get no line", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    on(repo, env);
    batchIn(repo, batchOf(3));
    const invalid = cli(["decide", ...SID, "--file", FILE], { env, cwd: repo });
    assert.equal(invalid.json.status, "invalid");
    assert.equal(invalid.json.cleanup, undefined);
    writeFileSync(join(repo, ".jev-flow-denylist"), "*\n");
    const refused = cli(["decide", ...SID, "--file", FILE], { env, cwd: repo });
    assert.equal(refused.json.status, "refused");
    assert.equal(refused.json.cleanup, undefined);
  });
  it("cleanupLine names only a plain path a lone rm -f can remove, and only for a status that ends a batch", () => {
    for (const status of ["selected", "ordered", "ask_user", "incomplete"]) assert.equal(cleanupLine(FILE, status), LINE);
    for (const status of ["expand", "refused", "invalid", "unavailable", "budget_exhausted", "none_eligible", undefined]) assert.equal(cleanupLine(FILE, status), null, String(status));
    assert.match(cleanupLine("sub/jev-batch.json", "selected"), /rm -f sub\/jev-batch\.json, alone/);
    for (const bad of ["-", "-f", "--file", "../x.json", "a/../x.json", "a b.json", 'a"b.json', "a'b.json", "a$b.json", "a;b.json", "a|b.json", "a*.json", "/abs/x.json", "~x.json", "a\nb.json", "", "~", undefined, null, 5, "a".repeat(121) + ".json"]) {
      assert.equal(cleanupLine(bad, "selected"), null, JSON.stringify(bad));
    }
    const longest = "a".repeat(120 - ".json".length) + ".json";
    assert.equal(Buffer.byteLength(longest), 120);
    assert.match(cleanupLine(longest, "selected"), new RegExp(`rm -f ${longest}, alone in its own command$`));
    assert.equal(cleanupLine(`${longest}x`, "selected"), null, "121 bytes is over the limit");
    assert.equal(cleanupLine(["a".repeat(180), "b".repeat(180), "c".repeat(180), "d".repeat(180)].join("/") + ".json", "selected"), null, "a 728-byte path gets no line");
  });
  it("the line is whole or absent: the longest accepted path keeps a plan item inside 1500 bytes; a longer line is dropped, never cut", () => {
    const plan = Array.from({ length: 40 }, (_, i) => `option-number-${i}:e:0.9${i % 10}:0123456789ab`);
    const longest = "a".repeat(120 - ".json".length) + ".json";
    const kept = cleanupLine(longest, "ordered");
    const near = JSON.parse(compactOut({ status: "ordered", decision_id: "d1", plan, plan_total: 40, cleanup: kept }));
    assert.equal(near.cleanup, kept);
    assert.ok(near.plan.length >= 1 && near.plan_next === near.plan.length);
    assert.ok(Buffer.byteLength(JSON.stringify(near)) <= 1500);
    const segs = ["a".repeat(180), "b".repeat(180), "c".repeat(180), "d".repeat(180)].join("/") + ".json";
    assert.equal(Buffer.byteLength(segs), 728);
    const huge = `if you wrote ${segs} for this decision, remove it now: rm -f ${segs}, alone in its own command`;
    const full = JSON.parse(compactOut({ status: "ordered", decision_id: "d1", plan, plan_total: 40, cleanup: huge }));
    const none = JSON.parse(compactOut({ status: "ordered", decision_id: "d1", plan, plan_total: 40 }));
    assert.equal(full.cleanup, undefined, "dropped whole, not truncated");
    assert.deepEqual(full, none, "decision data and paging are the same without the line");
    const short = compactOut({ status: "selected", decision_id: "d1", plan: ["o1:e:0.97:0123456789ab"], plan_total: 1, cleanup: huge });
    assert.ok(Buffer.byteLength(short) <= 1500);
    const s = JSON.parse(short);
    assert.equal(s.cleanup, undefined);
    assert.equal(s.status, "selected");
    assert.equal(s.decision_id, "d1");
    assert.deepEqual(s.plan, ["o1:e:0.97:0123456789ab"]);
    assert.equal(s.plan_next, undefined);
    const noList = JSON.parse(compactOut({ status: "ask_user", decision_id: "d1", cleanup: huge }));
    assert.equal(noList.cleanup, undefined);
    assert.equal(JSON.parse(compactOut({ status: "ask_user", decision_id: "d1", cleanup: LINE })).cleanup, LINE);
  });
  it("the line is data the cap keeps: a long plan is paged, the line stays", () => {
    const plan = Array.from({ length: 40 }, (_, i) => `option-number-${i}:e:0.9${i % 10}:0123456789ab`);
    const line = compactOut({ status: "ordered", decision_id: "d1", plan, plan_total: 40, cleanup: LINE });
    assert.ok(Buffer.byteLength(line) <= 1500);
    const o = JSON.parse(line);
    assert.equal(o.cleanup, LINE);
    assert.equal(o.plan_total, 40);
    assert.ok(Number.isInteger(o.plan_next) && o.plan.length === o.plan_next, "the cut plan is paged, never silent");
  });
});

describe("approvals, budget and direct calls", () => {
  it("a user approval is bound to a logged decision and option and recorded as an override", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: noulScript(p7([0.9, 0.5, 0.4, 0.3, 0.2])) });
    on(repo, env);
    const d = cli(["decide", ...SID, "--decision-id", "dec9", "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    assert.equal(d.json.status, "expand");
    const ok = cli(["approve", ...SID, "--decision", "dec9", "--option", "o1", "--message", "yes, use o1"], { env, cwd: repo });
    assert.equal(ok.json.override, "user");
    const state = loadControlState(controlSessionDir(repo, "cli-session-1", env));
    assert.equal(state.approvals.length, 1);
    assert.equal(state.approvals[0].option, "o1");
    const quoted = cli(["approve", ...SID, "--decision", "dec9", "--option", "o1", "--message", "do not use o1"], { env, cwd: repo });
    assert.equal(quoted.code, 4);
    assert.equal(quoted.json.reason, "message_not_authorization");
    assert.equal(loadControlState(controlSessionDir(repo, "cli-session-1", env)).approvals.length, 1, "a quoted refusal records no approval");
    const other = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "yes, use o1"], { env, cwd: repo });
    assert.equal(other.code, 4);
    assert.equal(other.json.reason, "message_not_about_option", "approving o1 is not approving o2");
    const unrelated = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "Use Node 22."], { env, cwd: repo });
    assert.equal(unrelated.json.reason, "message_not_about_option");
    const instead = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "Approve o1 instead of o2."], { env, cwd: repo });
    assert.equal(instead.json.reason, "message_not_about_option", "o2 was put aside in those words");
    const bare = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "yes"], { env, cwd: repo });
    assert.equal(bare.json.reason, "message_not_about_option", "a bare yes names no option");
    for (const words of ["Approve testing o2.", "Approve evaluating o2.", "Approve o2 for testing."]) {
      const r = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", words], { env, cwd: repo });
      assert.equal(r.json.reason, "message_not_about_option", `${words}: approving a test is not approving the run`);
    }
    const either = "Should we approve o1 or approve o2?";
    const useO1 = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "Use o1", "--question", either], { env, cwd: repo });
    assert.equal(useO1.json.reason, "message_not_about_option", "a question with alternatives cannot extend «Use o1» to o2");
    const yesEither = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "yes", "--question", either], { env, cwd: repo });
    assert.equal(yesEither.json.reason, "message_not_about_option", "a yes to alternatives picks none of them");
    const yesEither1 = cli(["approve", ...SID, "--decision", "dec9", "--option", "o1", "--message", "yes", "--question", either], { env, cwd: repo });
    assert.equal(yesEither1.json.reason, "message_not_about_option");
    const answered = cli(["approve", ...SID, "--decision", "dec9", "--option", "o2", "--message", "yes", "--question", "Approve o2?"], { env, cwd: repo });
    assert.equal(answered.json.override, "user", "a short answer counts with the question it answers");
    assert.equal(loadControlState(controlSessionDir(repo, "cli-session-1", env)).approvals.map((a) => a.option).join(), "o1,o2");
    assert.equal(cli(["approve", ...SID, "--decision", "nope", "--option", "o1", "--message", "yes, use o1"], { env, cwd: repo }).code, 4);
    assert.equal(cli(["approve", ...SID, "--decision", "dec9", "--option", "zz", "--message", "yes, use zz"], { env, cwd: repo }).code, 4);
  });
  it("edit_a and edit-a are two options: an approval of one never approves the other, whatever the batch holds", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: noulScript(p7([0.9, 0.8, 0.4, 0.3, 0.2])) });
    on(repo, env);
    const batch = batchOf(5, { kind: "edit" });
    batch.options[0] = { ...batch.options[0], id: "edit_a", action: { tool: "Write", target: "src/a.txt", content: "AAA" } };
    batch.options[1] = { ...batch.options[1], id: "edit-a", action: { tool: "Write", target: "src/a.txt", content: "BBB" } };
    const d = cli(["decide", ...SID, "--decision-id", "dec9", "--file", writeBatch(batch)], { env, cwd: repo });
    assert.equal(d.json.status, "expand", d.stdout);
    const approve = (option, message, question) => cli(["approve", ...SID, "--decision", "dec9", "--option", option, "--message", message, ...(question ? ["--question", question] : [])], { env, cwd: repo });
    const approved = () => loadControlState(controlSessionDir(repo, "cli-session-1", env)).approvals.map((a) => a.option);
    // The cross approval is refused in both directions and records nothing.
    for (const [option, message] of [["edit-a", "Approve edit_a."], ["edit_a", "Approve edit-a."], ["edit_a", "Approve edit a."], ["edit-a", "Yes, use edit a"]]) {
      const r = approve(option, message);
      assert.equal(r.code, 4, `${message} for ${option}`);
      assert.equal(r.json.reason, "message_not_about_option", `${message} for ${option}`);
    }
    assert.equal(approve("edit-a", "yes", "Approve edit_a?").json.reason, "message_not_about_option", "a yes to the question for edit_a is not an approval of edit-a");
    assert.deepEqual(approved(), []);
    // The exact id approves its own option, and a yes counts for the question naming that exact id.
    const exact = approve("edit_a", "Approve edit_a.");
    assert.equal(exact.json.override, "user", exact.stdout);
    assert.deepEqual(approved(), ["edit_a"]);
    const answered = approve("edit-a", "yes", "Approve edit-a?");
    assert.equal(answered.json.override, "user", answered.stdout);
    assert.deepEqual(approved(), ["edit_a", "edit-a"]);
    assert.notEqual(exact.json.ah, answered.json.ah, "the two grants are bound to different Write payloads");
  });
  it("a valid batch of edit_a and the longer edit_a_b: separators around an id never lend its approval to the other", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: noulScript(p7([0.9, 0.8, 0.4, 0.3, 0.2])) });
    on(repo, env);
    const batch = batchOf(5, { kind: "edit" });
    batch.options[0] = { ...batch.options[0], id: "edit_a", action: { tool: "Write", target: "src/a.txt", content: "AAA" } };
    batch.options[1] = { ...batch.options[1], id: "edit_a_b", action: { tool: "Write", target: "src/a.txt", content: "BBB" } };
    const d = cli(["decide", ...SID, "--decision-id", "dec9", "--file", writeBatch(batch)], { env, cwd: repo });
    assert.equal(d.json.status, "expand", d.stdout);
    const approve = (option, message, question) => cli(["approve", ...SID, "--decision", "dec9", "--option", option, "--message", message, ...(question ? ["--question", question] : [])], { env, cwd: repo });
    const approved = () => loadControlState(controlSessionDir(repo, "cli-session-1", env)).approvals.map((a) => a.option);
    for (const [option, message] of [["edit_a", "Approve edit_a-."], ["edit_a", "Approve edit_a_."], ["edit_a", "Approve edit_a--."], ["edit_a", "Approve edit_a--please."], ["edit_a", "Approve edit_a_b."], ["edit_a_b", "Approve edit_a."], ["edit_a_b", "Approve edit_a_b-."], ["edit_a_b", "Approve pre--edit_a_b."]]) {
      const r = approve(option, message);
      assert.equal(r.code, 4, `${message} for ${option}`);
      assert.equal(r.json.reason, "message_not_about_option", `${message} for ${option}`);
    }
    assert.equal(approve("edit_a", "yes", "Approve edit_a_b?").json.reason, "message_not_about_option");
    assert.deepEqual(approved(), [], "no refused approval was recorded");
    const exact = approve("edit_a", "Approve edit_a.");
    assert.equal(exact.json.override, "user", exact.stdout);
    const longer = approve("edit_a_b", "yes", "Approve edit_a_b?");
    assert.equal(longer.json.override, "user", longer.stdout);
    assert.deepEqual(approved(), ["edit_a", "edit_a_b"]);
    assert.notEqual(exact.json.ah, longer.json.ah);
  });
  it("direct calls: reserve before, confirm after; at 25 the reservation is refused until the user approves more", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    on(repo, env);
    const first = cli(["budget", "reserve", ...SID, "--tool", "jev_verify", "--source", "main"], { env, cwd: repo });
    assert.equal(first.json.status, "ok");
    assert.equal(cli(["budget", "confirm", ...SID, "--id", first.json.id, "--ok", "1", "--ms", "120"], { env, cwd: repo }).json.ok, true);
    for (let i = 0; i < 24; i++) assert.equal(cli(["budget", "reserve", ...SID, "--tool", "noul", "--source", "subagent"], { env, cwd: repo }).json.status, "ok");
    const over = cli(["budget", "reserve", ...SID, "--tool", "noul", "--source", "main"], { env, cwd: repo });
    assert.equal(over.code, 2);
    assert.equal(over.json.status, "budget_exhausted");
    assert.match(over.json.message, /stop and ask the user/);
    const noWords = cli(["budget", "approve", ...SID], { env, cwd: repo });
    assert.equal(noWords.code, 4, "going past the budget needs the user's own words");
    assert.match(noWords.json.message, /--message/);
    const quoted = cli(["budget", "approve", ...SID, "--n", "100", "--message", "Do not increase the budget."], { env, cwd: repo });
    assert.equal(quoted.code, 4);
    assert.equal(quoted.json.reason, "message_not_authorization");
    assert.match(quoted.json.message, /not an authorization/);
    const unrelated = cli(["budget", "approve", ...SID, "--n", "100", "--message", "Use Node 22."], { env, cwd: repo });
    assert.equal(unrelated.json.reason, "message_not_about_budget");
    assert.match(unrelated.json.message, /not a complete approval of raising the budget/);
    const quotation = cli(["budget", "approve", ...SID, "--n", "100", "--message", "The documentation says \"increase the budget by 100 calls\"."], { env, cwd: repo });
    assert.equal(quotation.json.reason, "message_not_authorization");
    const total = cli(["budget", "approve", ...SID, "--n", "30", "--message", "Increase the budget to 30 calls."], { env, cwd: repo });
    assert.equal(total.json.reason, "over_quantum", "a total of 30 from 25 is +5");
    assert.match(total.json.message, /at most 5/);
    assert.equal(cli(["budget", "approve", ...SID, "--message", "Yes, approve 30 calls."], { env, cwd: repo }).json.reason, "quantum_ambiguous");
    assert.equal(cli(["budget", "approve", ...SID, "--message", "Use Jev."], { env, cwd: repo }).json.reason, "message_not_about_budget");
    for (const words of ["Approve tests for calls.", "Approve testing the budget.", "Approve discussing the budget.", "Approve the budget for testing."]) assert.equal(cli(["budget", "approve", ...SID, "--message", words], { env, cwd: repo }).json.reason, "message_not_about_budget", words);
    for (const words of ["Continue with the current budget.", "Spend the current budget."]) assert.equal(cli(["budget", "approve", ...SID, "--message", words], { env, cwd: repo }).json.reason, "message_not_about_budget", `${words}: using the budget already granted raises nothing`);
    assert.equal(cli(["budget", "approve", ...SID, "--message", "yes", "--question", "Should we continue with the current budget?"], { env, cwd: repo }).json.reason, "message_not_about_budget");
    assert.equal(cli(["budget", "approve", ...SID, "--message", "yes", "--question", "Should we increase the budget or wait?"], { env, cwd: repo }).json.reason, "message_not_about_budget");
    for (const [words, reason] of [["Increase the budget by 0 calls.", "quantum_zero"], ["Increase the budget by 0.5 calls.", "quantum_invalid"]]) {
      const r = cli(["budget", "approve", ...SID, "--message", words], { env, cwd: repo });
      assert.equal(r.code, 4);
      assert.equal(r.json.reason, reason, words);
    }
    assert.equal(cli(["budget", "status", ...SID], { env, cwd: repo }).json.limit, 25, "still 25");
    assert.equal(cli(["budget", "reserve", ...SID, "--tool", "noul", "--source", "main"], { env, cwd: repo }).code, 2, "and call 26 is still refused");
    const smaller = cli(["budget", "approve", ...SID, "--n", "100", "--message", "yes, approve 10 more calls"], { env, cwd: repo });
    assert.equal(smaller.json.reason, "over_quantum");
    assert.match(smaller.json.message, /at most 10/);
    assert.equal(cli(["budget", "status", ...SID], { env, cwd: repo }).json.limit, 25, "nothing was raised by a refusal");
    const approved = cli(["budget", "approve", ...SID, "--message", "yes, go on beyond the limit"], { env, cwd: repo });
    assert.equal(approved.json.limit, 50);
    assert.deepEqual(approved.json.approval, { n: 25, msg: "yes, go on beyond the limit" });
    assert.equal(cli(["budget", "reserve", ...SID, "--tool", "noul", "--source", "main"], { env, cwd: repo }).json.status, "ok");
  });
});

describe("help without SKILL.md (R04)", () => {
  // R04: both dev sessions had their Read of skills/jev-control/SKILL.md refused (outside the working directory); one then spent
  // five invalid `decide` calls finding the batch format and ended without doing the task, the other tried `search --help`.
  const outside = () => tempDir();
  it("`help decide`, `decide --help` and `decide -h` print the batch format with no repository, session or capability", () => {
    const direct = cli(["help", "decide"], { env: controlEnv(), cwd: outside() });
    assert.equal(direct.code, 0, direct.stdout + direct.stderr);
    for (const args of [["decide", "--help"], ["decide", "-h"], ["decide", "--file", "x", "--help"]]) {
      const r = cli(args, { env: controlEnv(), cwd: outside() });
      assert.equal(r.code, 0, args.join(" "));
      assert.equal(r.stdout, direct.stdout, args.join(" "));
    }
    assert.ok(direct.stdout.length < 1500, `fits the output cap (${direct.stdout.length})`);
    for (const word of ["--file", "--decision-id", "\"decision\"", "\"kind\"", "\"options\"", "\"evidence\"", "\"action\"", "old_string", "space_small", "new_material", "expand", "ask_user", "incomplete"]) {
      assert.ok(direct.stdout.includes(word), `mentions ${word}`);
    }
    assert.ok(direct.stdout.includes(KINDS.join("|")), "the kinds are the ones the helper accepts");
    assert.ok(direct.stdout.includes(`${MIN_OPTIONS} to ${MAX_OPTIONS - CONTROL_IDS.length} real options`));
    assert.match(direct.stdout, /a pipe, ; or && voids the grant/, "R04: `search ... | head -40` was audited as an ordinary action and granted nothing; R05: so was `decide ...; rm -f jev-batch.json`");
  });
  it("the example batch in `help decide` has the shape the helper accepts", () => {
    const text = cli(["help", "decide"], { env: controlEnv(), cwd: outside() }).stdout;
    const example = JSON.parse(text.split("\n").find((l) => l.startsWith("{")));
    const options = ["a", "b", "c", "d", "e"].map((id) => ({ ...example.options[0], id, text: `option ${id}`, evidence: ["a concrete line"], action: { ...example.options[0].action, target: `src/${id}.mjs` } }));
    const checked = normalizeBatch({ ...example, decision: "which file first?", kind: "edit", options, new_material: undefined });
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
  });
  it("the option limit in `help decide` is the one normalizeBatch enforces: 20 counts the two control options, space_small is for a really small space", () => {
    const text = cli(["help", "decide"], { env: controlEnv(), cwd: outside() }).stdout;
    const real = MAX_OPTIONS - CONTROL_IDS.length;
    assert.equal(real, 18);
    assert.ok(text.includes(`${MIN_OPTIONS} to ${real} real options`), text);
    assert.ok(text.includes(`the limit ${MAX_OPTIONS} counts ${GATHER_ID} and ${ASK_ID}, added if missing`), text);
    assert.match(text, /"space_small":true only when fewer real alternatives exist/);
    const batch = (n) => ({ decision: "which?", kind: "approach", options: Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, text: `Option number ${i + 1}`, evidence: ["a concrete line"] })) });
    assert.equal(normalizeBatch(batch(real)).ok, true, "18 real options plus the two control options = 20");
    for (const n of [real + 1, MAX_OPTIONS]) {
      const r = normalizeBatch(batch(n));
      assert.equal(r.ok, false, `${n} real options`);
      assert.match(r.problems.join(" "), new RegExp(`at most ${MAX_OPTIONS} options`));
    }
    assert.equal(normalizeBatch(batch(MIN_OPTIONS - 1)).ok, false, "fewer than 5 real options without space_small");
    assert.equal(normalizeBatch({ ...batch(MIN_OPTIONS - 1), space_small: true }).ok, true);
  });
  it("--help and -h are help only as flags of their own: as the value of --query, --message, --priorities or any other value flag they stay values (no live call)", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    for (const text of ["--help", "-h"]) {
      for (const args of [["search", "--query", text], ["decide", "--message", text], ["approve", "--option", text], ["budget", "status", "--tool", text], ["decide", "--file", text], ["on", "--priorities", text]]) {
        const r = cli([...args, ...SID], { env, cwd: outside() });
        assert.equal(r.code, 4, `${args.join(" ")}: ${r.stdout}`);
        assert.deepEqual(r.json, { status: "refused", message: "not a git work tree" }, `${args.join(" ")} is the command, not help`);
      }
    }
    const r = on(repo, env, ["--priorities", "-h"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.mode, "on", "the mode was switched on, not answered with the usage text");
    // A flag of its own still asks for help, also after a value flag and in the shape the sessions used.
    const direct = cli(["help", "decide"], { env, cwd: outside() }).stdout;
    for (const args of [["decide", "--file", "x", "-h"], ["decide", "--decision-id", "d1", "--help"], ["decide", "--help", "--file", "x"]]) {
      const h = cli(args, { env, cwd: outside() });
      assert.equal(h.code, 0, args.join(" "));
      assert.equal(h.stdout, direct, args.join(" "));
    }
    assert.match(cli(["--root", "x", "--help"], { env, cwd: outside() }).stdout, /^Usage: cli\.mjs on\|off\|status/);
  });
  it("R05: `help decide` says where the batch goes, that decide runs alone, and that only plan items run", () => {
    const text = cli(["help", "decide"], { env: controlEnv(), cwd: outside() }).stdout;
    assert.match(text, /Write the batch to a NEW file in the working directory \(e\.g\. jev-batch\.json if free; elsewhere or heredoc: refused\)/, "S4: a Write to /tmp was refused; a file that exists is never overwritten");
    assert.match(text, /Run decide alone \(a pipe, ; or && voids the grant\); then a lone rm of only that file, else an audited edit/, "S4: `decide ...; rm -f jev-batch.json` five times, never a genuine helper call");
    assert.match(text, /do the plan items, then decide again for the rest; never run an option outside the plan/, "S2: the changelog edit was not a plan item");
    assert.match(text, /status: selected\/ordered: do exactly the plan items/);
    assert.ok(text.length < 1500, `fits the output cap (${text.length})`);
  });
  it("R07: `help done` is the headless completion recipe: a new jev-claims.json, done alone, the helper removes it; its example is a claims object the helper accepts", () => {
    const text = cli(["help", "done"], { env: controlEnv(), cwd: outside() }).stdout;
    assert.equal(cli(["done", "--help"], { env: controlEnv(), cwd: outside() }).stdout, text);
    assert.ok(text.length < 1500, `fits the output cap (${text.length})`);
    assert.ok(text.startsWith("done --claims jev-claims.json"));
    assert.match(text, /Write a NEW file jev-claims\.json in the repository root \(never overwrite another file\)/);
    assert.match(text, /run done --claims jev-claims\.json ALONE \(a pipe, ; or && voids the grant\)/);
    assert.match(text, /removes it before the snapshot and prints claims_removed: do not remove it yourself/);
    assert.match(text, /outcome accepted = done, for that tree only/);
    assert.match(text, /end with "Incomplete:"/);
    const line = text.split("\n").find((l) => l.includes('{"request"'));
    const example = JSON.parse(line.slice(line.indexOf("{")).replace("<the user's request, verbatim>", "fix it"));
    const { claims, fileChecks } = splitClaims(example);
    assert.deepEqual(fileChecks, [["node", "--test"]]);
    assert.equal(claims.claims.length, 1);
    assert.equal(consumableClaimsName("jev-claims.json"), true);
    const on = cli(["on", ...SID], { env: controlEnv(), cwd: makeRepo({ "a.txt": "a\n" }) });
    assert.match(on.json.next, /completion is \/jev:jev-done or, headless, `help done`/);
    assert.ok(on.stdout.trim().length < 900);
  });
  it("`help search`, `search --help`, the other commands and an unknown topic", () => {
    const search = cli(["help", "search"], { env: controlEnv(), cwd: outside() });
    assert.equal(search.code, 0);
    for (const word of ["--query", "--single", "--exact-path", "--widen", "--search-id", "sha256"]) assert.ok(search.stdout.includes(word), word);
    assert.match(search.stdout, /a pipe after it \(`\| head`\) voids the grant/);
    assert.equal(cli(["search", "--help"], { env: controlEnv(), cwd: outside() }).stdout, search.stdout);
    for (const topic of ["on", "off", "status", "threshold", "page", "approve", "budget", "receipt", "done"]) {
      const r = cli(["help", topic], { env: controlEnv(), cwd: outside() });
      assert.equal(r.code, 0, topic);
      assert.ok(r.stdout.startsWith(topic), `${topic}: ${r.stdout}`);
    }
    const unknown = cli(["help", "frobnicate"], { env: controlEnv(), cwd: outside() });
    assert.equal(unknown.code, 0);
    assert.match(unknown.stdout, /^Usage: cli\.mjs on\|off\|status/);
    assert.match(unknown.stdout, /cli\.mjs help decide/);
  });
});

describe("the entry point", () => {
  it("runs when started through a symlinked plugin path (Node leaves argv[1] unresolved)", () => {
    const link = join(tempDir(), "plugin-link");
    symlinkSync(join(REPO_ROOT, "private", "jev-control"), link);
    const r = run(process.execPath, [join(link, "cli.mjs"), "--help"]);
    assert.match(r.stdout, /^Usage: cli\.mjs on\|off\|status/);
    const direct = run(process.execPath, [CONTROL_CLI, "--help"]);
    assert.equal(direct.stdout, r.stdout);
  });
  it("prints a JSON error and a non-zero exit for an unknown command", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const r = cli(["frobnicate", ...SID], { env: controlEnv(), cwd: repo });
    assert.equal(r.code, 4);
    assert.match(r.json.message, /unknown command/);
  });
});

describe("subagents and completion through the CLI", () => {
  it("--source subagent attributes the helper's calls to the subagent; tie-breaks stay tiebreak", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv({ script: { noul: [{ p: p7([0.99, 0.97, 0.5, 0.4, 0.3]) }], decide: [{ selected: "o1", confidence: 0.97 }] } });
    on(repo, env);
    cli(["decide", ...SID, "--source", "subagent", "--file", writeBatch(batchOf(5))], { env, cwd: repo });
    const view = cli(["budget", "status", ...SID], { env, cwd: repo }).json;
    assert.equal(view.by_source.subagent, 1);
    assert.equal(view.by_source.tiebreak, 1);
    assert.equal(view.by_source.helper, 0);
  });
  it("done runs the gate at the session threshold and counts the part as source gate", () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const claims = ["a.js exports a = 2", "b.js is a new file exporting b = 3"];
    const env = controlEnv({ script: { gate: [{ result: gateAnswer(0.9, { conf: 0.95 }, claims) }] } });
    on(repo, env, ["--threshold", "0.9"]);
    writeFiles(repo, { "a.js": "export const a = 2;\n", "b.js": "export const b = 3;\n" });
    const file = join(tempDir(), "claims.json");
    writeFileSync(file, JSON.stringify({ request: "set a to 2 and add b", claims: [{ text: claims[0], evidence: ["file:a.js"] }, { text: claims[1], evidence: ["file:b.js"] }] }));
    const r = cli(["done", ...SID, "--claims", file], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.outcome, "accepted");
    assert.equal(r.json.control.threshold, 0.9);
    assert.equal(serverLog(env).filter((l) => l.name === "jev_gate")[0].args.auto_accept, 0.9);
    assert.equal(cli(["budget", "status", ...SID], { env, cwd: repo }).json.by_source.gate, 1);
  });
});

describe("done consumes a claims file written in the repository root (R07)", () => {
  const CLAIMS = ["a.js exports a = 2", "b.js is a new file exporting b = 3"];
  const NAME = "jev-claims.json";
  const claimsOf = (extra = {}) => ({ request: "set a to 2 and add b", claims: [{ text: CLAIMS[0], evidence: ["file:a.js"] }, { text: CLAIMS[1], evidence: ["file:b.js", "cmd-1"] }], ...extra });
  const setup = (conf = 0.95, { files = {} } = {}) => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n", ...files });
    const env = controlEnv({ script: { gate: [{ result: gateAnswer(0.9, { conf }, CLAIMS) }] } });
    on(repo, env, ["--threshold", "0.9"]);
    writeFiles(repo, { "a.js": "export const a = 2;\n", "b.js": "export const b = 3;\n" });
    return { repo, env };
  };
  const write = (repo, obj, name = NAME) => writeFileSync(join(repo, name), typeof obj === "string" ? obj : JSON.stringify(obj));
  const gateCalls = (env) => serverLog(env).filter((l) => l.name === "jev_gate");
  const refusedUntouched = (r, repo, env, name = NAME, why = /./) => {
    assert.equal(r.code, 4, r.stdout);
    assert.equal(r.json.status, "invalid");
    assert.match(r.json.message, why);
    assert.equal(existsSync(join(repo, name)), true, "a refused file is never removed");
    assert.equal(gateCalls(env).length, 0, "no gate call after a refusal");
    assert.equal(Object.hasOwn(r.json, "claims_removed"), false);
  };
  it("reads the file, removes it before the snapshot, runs its checks and reports the name and sha256", () => {
    const { repo, env } = setup();
    const body = JSON.stringify(claimsOf({ checks: [["node", "-e", "process.exit(0)"]] }));
    write(repo, body);
    const r = cli(["done", ...SID, "--claims", NAME], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.outcome, "accepted");
    assert.equal(r.json.claims_removed, NAME);
    assert.equal(r.json.claims_sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(existsSync(join(repo, NAME)), false);
    assert.equal(r.json.checks.length, 1);
    assert.equal(r.json.checks[0].exit, 0);
    const sent = gateCalls(env);
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0].args).includes(NAME), false, "the claims file is not part of the diff the gate judged");
    assert.equal(r.json.control.threshold, 0.9);
    assert.equal(cli(["budget", "status", ...SID], { env, cwd: repo }).json.by_source.gate, 1);
  });
  it("checks of the file run after the --check flags, in order, and never reach the runner as a claims key", () => {
    const { repo, env } = setup();
    write(repo, claimsOf({ checks: [["node", "-e", "process.exit(0)"], ["node", "-e", "process.exit(0)"]] }));
    const r = cli(["done", ...SID, "--claims", NAME, "--check", '["node","-e","process.exit(0)"]'], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.checks.length, 3);
    assert.equal(Object.hasOwn(r.json, "problems"), false);
  });
  it("the name and the hash stay in the result when the gate does not accept (removal is not acceptance)", () => {
    const { repo, env } = setup(0.5);
    write(repo, claimsOf());
    const r = cli(["done", ...SID, "--claims", NAME], { env, cwd: repo });
    assert.notEqual(r.json.outcome, "accepted", r.stdout);
    assert.equal(r.json.claims_removed, NAME);
    assert.match(r.json.claims_sha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(repo, NAME)), false);
  });
  it("a file outside the work tree and stdin are read as before and never removed", () => {
    const { repo, env } = setup();
    const file = join(tempDir(), NAME);
    writeFileSync(file, JSON.stringify(claimsOf({ checks: [["node", "-e", "process.exit(0)"]] })));
    const r = cli(["done", ...SID, "--claims", file], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(existsSync(file), true);
    assert.equal(Object.hasOwn(r.json, "claims_removed"), false);
    const { repo: repo2, env: env2 } = setup();
    const viaStdin = cli(["done", ...SID, "--claims", "-"], { env: env2, cwd: repo2, input: JSON.stringify(claimsOf({ checks: [["node", "-e", "process.exit(0)"]] })) });
    assert.equal(viaStdin.code, 0, viaStdin.stdout);
    assert.equal(Object.hasOwn(viaStdin.json, "claims_removed"), false);
  });
  it("a tracked, an ignored file, a symlink and a directory are refused and left alone", () => {
    const tracked = setup(0.95, { files: { [NAME]: JSON.stringify(claimsOf()) } });
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: tracked.env, cwd: tracked.repo }), tracked.repo, tracked.env, NAME, /is tracked by git/);
    const ignored = setup();
    writeFiles(ignored.repo, { ".gitignore": `${NAME}\n` });
    write(ignored.repo, claimsOf());
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: ignored.env, cwd: ignored.repo }), ignored.repo, ignored.env, NAME, /ignored/);
    const link = setup();
    const real = join(tempDir(), "real.json");
    writeFileSync(real, JSON.stringify(claimsOf()));
    symlinkSync(real, join(link.repo, NAME));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: link.env, cwd: link.repo }), link.repo, link.env, NAME, /regular file/);
    assert.equal(existsSync(real), true);
    const dir = setup();
    mkdirSync(join(dir.repo, NAME));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: dir.env, cwd: dir.repo }), dir.repo, dir.env, NAME, /regular file/);
  });
  it("another name, a subdirectory, an absolute path inside the tree and a run from a subdirectory are refused and left alone", () => {
    const a = setup();
    write(a.repo, claimsOf(), "claims.json");
    refusedUntouched(cli(["done", ...SID, "--claims", "claims.json"], { env: a.env, cwd: a.repo }), a.repo, a.env, "claims.json", /jev-claims/);
    const b = setup();
    mkdirSync(join(b.repo, "sub"));
    write(b.repo, claimsOf(), `sub/${NAME}`);
    refusedUntouched(cli(["done", ...SID, "--claims", `sub/${NAME}`], { env: b.env, cwd: b.repo }), b.repo, b.env, `sub/${NAME}`, /jev-claims/);
    const c = setup();
    write(c.repo, claimsOf());
    refusedUntouched(cli(["done", ...SID, "--claims", join(c.repo, NAME)], { env: c.env, cwd: c.repo }), c.repo, c.env, NAME, /absolute/);
    const d = setup();
    mkdirSync(join(d.repo, "sub"));
    write(d.repo, claimsOf());
    refusedUntouched(cli(["done", ...SID, "--claims", `../${NAME}`], { env: d.env, cwd: join(d.repo, "sub") }), d.repo, d.env, NAME, /repository root/);
    const e = setup();
    write(e.repo, claimsOf(), `jev-claims${"x".repeat(120)}.json`);
    refusedUntouched(cli(["done", ...SID, "--claims", `jev-claims${"x".repeat(120)}.json`], { env: e.env, cwd: e.repo }), e.repo, e.env, `jev-claims${"x".repeat(120)}.json`, /jev-claims/);
  });
  it("invalid JSON, an invalid schema and invalid checks are refused before anything is removed or sent", () => {
    const a = setup();
    write(a.repo, "{not json");
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: a.env, cwd: a.repo }), a.repo, a.env, NAME, /not valid JSON/);
    const b = setup();
    write(b.repo, { request: "x", claims: [] });
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: b.env, cwd: b.repo }), b.repo, b.env, NAME, /invalid claims/);
    const c = setup();
    write(c.repo, claimsOf({ checks: "npm test" }));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: c.env, cwd: c.repo }), c.repo, c.env, NAME, /checks/);
    const d = setup();
    write(d.repo, claimsOf({ checks: [["node", ""]] }));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: d.env, cwd: d.repo }), d.repo, d.env, NAME, /argv/);
    const e = setup();
    write(e.repo, claimsOf({ checks: Array.from({ length: 9 }, () => ["node", "-v"]) }));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env: e.env, cwd: e.repo }), e.repo, e.env, NAME, /at most/);
    const f = setup();
    write(f.repo, claimsOf({ diff: "x" }));
    const r = cli(["done", ...SID, "--claims", NAME], { env: f.env, cwd: f.repo });
    refusedUntouched(r, f.repo, f.env, NAME, /invalid claims/);
    assert.equal(r.stdout.includes("export const a"), false, "an error never echoes the file");
  });
  it("a removal that fails stops before the gate", () => {
    const { repo, env } = setup();
    write(repo, claimsOf());
    chmodSync(repo, 0o555);
    try {
      const r = cli(["done", ...SID, "--claims", NAME], { env, cwd: repo });
      assert.equal(r.code, 4, r.stdout);
      assert.match(r.json.message, /could not be removed/);
      assert.equal(gateCalls(env).length, 0);
    } finally {
      chmodSync(repo, 0o755);
    }
    assert.equal(existsSync(join(repo, NAME)), true);
  });
  it("an input over 1 MiB and a work tree git cannot read are refused and left alone", () => {
    const { repo, env } = setup();
    write(repo, JSON.stringify(claimsOf({ pad: "x".repeat(1024 * 1024) })));
    refusedUntouched(cli(["done", ...SID, "--claims", NAME], { env, cwd: repo }), repo, env, NAME, /1 MiB/);
    const plain = tempDir();
    writeFileSync(join(plain, NAME), JSON.stringify(claimsOf()));
    return assert.rejects(loadClaims(NAME, { cwd: plain, repoRoot: plain, readExternal: () => null }), (e) => e instanceof ClaimsRefused && /git could not say/.test(e.message)).then(() => assert.equal(existsSync(join(plain, NAME)), true));
  });
  it("a plain name in a subdirectory is not the root's file: nothing is consumed, either file stays", () => {
    const { repo, env } = setup();
    mkdirSync(join(repo, "sub"));
    write(repo, claimsOf());
    write(repo, claimsOf(), `sub/${NAME}`);
    const r = cli(["done", ...SID, "--claims", NAME], { env, cwd: join(repo, "sub") });
    refusedUntouched(r, repo, env, NAME, /repository root/);
    assert.equal(existsSync(join(repo, "sub", NAME)), true);
  });
  it("a change between the read and the removal is caught whatever its shape: same size and same inode (only the bytes differ), or a replaced file with the same bytes", async () => {
    const repo = makeRepo({ "a.js": "x\n" });
    const path = join(repo, NAME);
    const body = JSON.stringify(claimsOf());
    const opts = (beforeRemove) => ({ cwd: repo, repoRoot: repo, readExternal: () => null, beforeRemove });
    writeFileSync(path, body);
    const sameShape = body.replace("fix", "mix").length === body.length ? body.replace("set a to 2", "set a to 3") : body;
    assert.equal(sameShape.length, body.length);
    assert.notEqual(sameShape, body);
    await assert.rejects(loadClaims(NAME, opts(() => writeFileSync(path, sameShape))), (e) => e instanceof ClaimsRefused && /changed/.test(e.message));
    assert.equal(existsSync(path), true);
    writeFileSync(path, body);
    await assert.rejects(loadClaims(NAME, opts(() => { unlinkSync(path); writeFileSync(path, body); })), (e) => e instanceof ClaimsRefused && /changed/.test(e.message));
    assert.equal(existsSync(path), true);
    writeFileSync(path, body);
    assert.equal((await loadClaims(NAME, opts(undefined))).removed, NAME, "untouched, it is consumed");
  });
  it("a git probe that fails is a refusal, whichever probe it is, and an ignored or tracked file says so", async () => {
    const repo = makeRepo({ "a.js": "x\n" });
    const path = join(repo, NAME);
    writeFileSync(path, JSON.stringify(claimsOf()));
    const ok = { status: 0, stdout: "" };
    const probe = (tracked, ignored) => (root, args) => (args[0] === "ls-files" ? tracked : ignored);
    const refused = (git, why) => assert.rejects(loadClaims(NAME, { cwd: repo, repoRoot: repo, readExternal: () => null, git }), (e) => e instanceof ClaimsRefused && why.test(e.message));
    await refused(probe({ status: 128, stdout: "" }, { status: 1 }), /whether the claims file is tracked/);
    await refused(probe({ error: new Error("x"), stdout: "" }, { status: 1 }), /whether the claims file is tracked/);
    await refused(probe({ status: 0, stdout: `${NAME}\0` }, { status: 1 }), /is tracked by git/);
    await refused(probe(ok, { status: 128 }), /whether the claims file is ignored/);
    await refused(probe(ok, { error: new Error("x") }), /whether the claims file is ignored/);
    await refused(probe(ok, { status: 0 }), /is ignored by git/);
    assert.equal(existsSync(path), true);
    assert.equal((await loadClaims(NAME, { cwd: repo, repoRoot: repo, readExternal: () => null, git: probe(ok, { status: 1 }) })).removed, NAME);
  });
  it("with the mode off nothing is read or removed", () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const env = controlEnv();
    write(repo, claimsOf());
    const r = cli(["done", ...SID, "--claims", NAME], { env, cwd: repo });
    assert.equal(r.json.status, "refused");
    assert.equal(existsSync(join(repo, NAME)), true);
  });
  it("a file that changes between the read and the removal is not consumed (loadClaims, in process)", async () => {
    const repo = makeRepo({ "a.js": "x\n" });
    write(repo, claimsOf());
    const path = join(repo, NAME);
    const original = process.cwd();
    process.chdir(repo);
    try {
      const ok = await loadClaims(NAME, { cwd: repo, repoRoot: repo, readExternal: () => null });
      assert.equal(ok.removed, NAME);
      write(repo, claimsOf());
      await assert.rejects(loadClaims(NAME, { cwd: repo, repoRoot: repo, readExternal: () => null, beforeRemove: () => writeFileSync(path, JSON.stringify(claimsOf({ request: "another request" }))) }), (e) => e instanceof ClaimsRefused && /changed/.test(e.message));
      assert.equal(existsSync(path), true);
    } finally {
      process.chdir(original);
    }
  });
  it("the name rule and the classification (a symlink pointing in is not an external file)", () => {
    assert.equal(consumableClaimsName("jev-claims.json"), true);
    assert.equal(consumableClaimsName("jev-claims-2.json"), true);
    assert.equal(consumableClaimsName(`jev-claims${"a".repeat(106)}.json`), false, "121 bytes");
    assert.equal(consumableClaimsName(`jev-claims${"a".repeat(105)}.json`), true, "120 bytes");
    for (const bad of ["claims.json", "jev-claims.txt", "sub/jev-claims.json", "../jev-claims.json", "jev-claims json", "jev-claims.json/", "Jev-claims.json", "", undefined, 5]) assert.equal(consumableClaimsName(bad), false, String(bad));
    const repo = makeRepo({ "a.txt": "a\n" });
    const outside = tempDir();
    writeFileSync(join(outside, "x.json"), "{}");
    assert.equal(classifyClaimsSource("-", { cwd: repo, repoRoot: repo }).internal, false);
    assert.equal(classifyClaimsSource(join(outside, "x.json"), { cwd: repo, repoRoot: repo }).internal, false);
    symlinkSync(repo, join(outside, "pointing-in"));
    assert.equal(classifyClaimsSource(join(outside, "pointing-in", NAME), { cwd: repo, repoRoot: repo }).internal, true);
    assert.equal(classifyClaimsSource(NAME, { cwd: repo, repoRoot: repo }).internal, true, "a file that does not exist yet is judged by where it would be");
    assert.equal(splitClaims(claimsOf({ checks: [["node", "-v"]] })).fileChecks.length, 1);
  });
});

describe("search through the CLI", () => {
  it("finds the location with jev_rerank and prints a compact line", () => {
    const repo = materialize(S3);
    const env = controlEnv({ script: { rerank: [{ scores: { c0: 0.962, c1: 0.3, c2: 0.2, c3: 0.1 } }] } });
    on(repo, env);
    const r = cli(["search", ...SID, "--query", "delay between retries of a failed upload"], { env, cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.status, "found");
    assert.equal(r.json.hits[0].path, "src/upload/retry.mjs");
    assert.ok(Buffer.byteLength(r.stdout.trim()) <= 4096);
    assert.equal(serverLog(env).map((l) => l.name).join(), "jev_rerank");
  });
  it("an exact path is a direct read with no Jev call", () => {
    const repo = materialize(S3);
    const env = controlEnv();
    on(repo, env);
    const r = cli(["search", ...SID, "--exact-path", "src/upload/retry.mjs"], { env, cwd: repo });
    assert.equal(r.json.status, "direct_read");
    assert.equal(serverLog(env).length, 0);
  });
});

describe("compact output never loses decision data silently", () => {
  const longIds = Array.from({ length: 20 }, (_, i) => `option_${String(i).padStart(2, "0")}_${"x".repeat(50)}`);
  const items = longIds.map((id, i) => planItem({ id, action: i === 0 ? "execute" : "reserve", score: 0.9876543 - i * 0.0001, ah: "0123456789ab" }));
  it("pages a 20-item plan of long ids: nothing cut without a marker, every page within 1.5 KB, the pages join to the whole plan", () => {
    const base = { status: "selected", decision_id: "dec", kind: "approach", threshold: 0.95, round: 0, calls: 2, tiebreaks: 1, receipt: "a".repeat(32) };
    let from = 0;
    const seen = [];
    let pages = 0;
    for (;;) {
      const out = JSON.parse(compactOut({ ...base, plan: items }, 1500, { from: { plan: from } }));
      assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 1500, String(Buffer.byteLength(JSON.stringify(out))));
      assert.equal(out.plan_total, 20);
      seen.push(...out.plan);
      pages += 1;
      if (out.plan_next === undefined) break;
      assert.equal(out.plan_next, seen.length, "the marker is the exact index to continue from");
      from = out.plan_next;
      assert.ok(out.plan.length > 0, "every page makes progress");
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, items);
  });
  it("scores stay raw in stop reports and are paged with the same markers", () => {
    const scores = longIds.map((id, i) => `${id}:${0.95001 - i * 0.0001}`);
    const out = JSON.parse(compactOut({ status: "expand", decision_id: "d", reason: "none_above_threshold", report: "r".repeat(400), message: "m".repeat(400), scores }, 1500));
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 1500);
    assert.equal(out.scores_total, 20);
    assert.ok(out.scores_next > 0);
    assert.equal(out.scores[0], `${longIds[0]}:0.95001`, ".95001 is not rounded to .95");
  });
  it("the page command returns the rest of a logged decision", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = controlEnv();
    on(repo, env);
    const dir = controlSessionDir(repo, "cli-session-1", env);
    withControlState(dir, (state) => {
      state.decisions.push({ id: "big", req: 1, ts: 1, kind: "order", t: 0.95, status: "ordered", round: 0, opts: longIds.map((id, i) => [id, 0.99 - i * 0.001, "h".repeat(8), "-"]), order: items, calls: 1, tb: 0, snap: null });
    });
    const seen = [];
    let from = 0;
    for (let guard = 0; guard < 10; guard++) {
      const r = cli(["page", ...SID, "--decision", "big", "--from", String(from)], { env, cwd: repo });
      assert.equal(r.code, 0, r.stdout);
      assert.ok(Buffer.byteLength(r.stdout.trim()) <= 1500);
      seen.push(...r.json.plan);
      if (r.json.plan_next === undefined) break;
      from = r.json.plan_next;
    }
    assert.deepEqual(seen, items);
    const scores = cli(["page", ...SID, "--decision", "big", "--part", "scores"], { env, cwd: repo });
    assert.equal(scores.json.scores_total, 20);
    assert.equal(scores.json.scores[0].split(":")[1], "0.99");
    assert.equal(cli(["page", ...SID, "--decision", "nope"], { env, cwd: repo }).code, 4);
    assert.equal(cli(["page", ...SID, "--decision", "big", "--from", "99"], { env, cwd: repo }).code, 4);
  });
  it("a stop with 20 options keeps the raw scores a threshold audit needs, with markers when they do not fit", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const probs = [0.95001, ...Array(17).fill(0.3), 0.1, 0.1];
    const env = controlEnv({ script: { noul: [{ p: probs }] } });
    on(repo, env);
    const r = cli(["decide", ...SID, "--file", writeBatch(batchOf(18))], { env, cwd: repo });
    assert.equal(r.json.status, "selected", "0.95001 is above 0.95");
    const none = controlEnv({ script: { noul: [{ p: [0.95, ...Array(17).fill(0.3), 0.1, 0.1] }] } });
    on(repo, none);
    const stop = cli(["decide", ...SID, "--file", writeBatch(batchOf(18)), "--decision-id", "stop1"], { env: none, cwd: repo });
    assert.equal(stop.json.status, "expand");
    assert.ok(Buffer.byteLength(stop.stdout.trim()) <= 1500);
    assert.equal(stop.json.scores[0], "o1:0.95", "the exact value, so that .95 is not mistaken for a higher score");
    assert.equal(stop.json.scores_total, 20);
  });
});

import assert from "node:assert/strict";
import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { S3 } from "../fixtures/scenarios.mjs";
import { materialize } from "../fixtures/lib.mjs";
import { actionHash, normalizeDescriptor, planItem, shortHash } from "../actions.mjs";
import { compactOut } from "../cli.mjs";
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

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRunnerGateCommand, setupFlow } from "../opencode.mjs";
import { ensureReceiptKey, newReceiptId, RECEIPTS_DIR, sessionDirFromKey, verifyReceipt, writeReceipt } from "../runner-receipt.mjs";
import { collectPatch } from "../gate-run.mjs";
import { loadDenylist } from "../paths.mjs";
import { sanitizeDiff } from "../sanitize.mjs";
import { readBaseline, sessionDir, withState } from "../state.mjs";
import { acceptedGate, appendTranscriptCall, fakeJevEnv, GATE_RUN_CLI, HOOK_CLI, makeRepo, run, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

const CLAIMS = { request: "set a to 2", claims: [{ text: "a.js exports a = 2", evidence: ["file:a.js"] }] };

/** A strict Claude Code session driven through the hook CLI, with the gate runner run as Claude's Bash would. */
function claudeSession({ mode = "accepted" } = {}) {
  const repo = makeRepo({ "a.js": "export const a = 1;\n" });
  const id = `s-${Math.random().toString(36).slice(2)}`;
  const env = sandboxEnv({ ...fakeJevEnv(mode), JEV_FLOW_STRICT: "1" });
  const transcript = join(tempDir("jev-flow-transcript-"), "t.jsonl");
  writeFileSync(transcript, "");
  const hook = (event, extra = {}) => {
    const r = run(process.execPath, [HOOK_CLI, event], { env, cwd: repo, input: JSON.stringify({ session_id: id, cwd: repo, transcript_path: transcript, hook_event_name: event, ...extra }) });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  hook("SessionStart", { source: "startup" });
  hook("UserPromptSubmit", { prompt: "set a to 2" });
  const claims = join(tempDir("jev-flow-claims-"), "c.json");
  writeFileSync(claims, JSON.stringify(CLAIMS));
  const runner = (extraEnv = {}, { input = null, args = [] } = {}) => {
    // Claude Code exports CLAUDE_CODE_SESSION_ID to Bash.
    let file = claims;
    if (input) {
      file = join(tempDir("jev-flow-claims-"), "c.json");
      writeFileSync(file, typeof input === "string" ? input : JSON.stringify(input));
    }
    const r = run(process.execPath, [GATE_RUN_CLI, "--root", repo, "--claims", file, ...args], { env: { ...env, CLAUDE_CODE_SESSION_ID: id, ...extraEnv }, cwd: repo });
    return { code: r.code, out: JSON.parse(r.stdout) };
  };
  const stop = (message = "Done.") => hook("Stop", { stop_hook_active: false, last_assistant_message: message });
  /** A direct jev_gate call through the hooks and the transcript. */
  const directGate = (useId, input) => {
    hook("PreToolUse", { tool_name: "mcp__plugin_jev_jev__jev_gate", tool_use_id: useId, tool_input: input });
    const result = acceptedGate({}, input.claims);
    appendTranscriptCall(transcript, { id: useId, name: "mcp__plugin_jev_jev__jev_gate", input, result });
    hook("PostToolUse", { tool_name: "mcp__plugin_jev_jev__jev_gate", tool_use_id: useId, tool_input: input, tool_response: [{ type: "text", text: JSON.stringify(result) }] });
  };
  return { repo, id, env, hook, runner, stop, directGate, dir: sessionDir(repo, id, env) };
}

const TWO = {
  request: "set a to 2 and document it",
  claims: [
    { text: "a.js exports a = 2", evidence: ["file:a.js"] },
    { text: "a.js carries a comment explaining the value", evidence: ["file:a.js"] },
  ],
};
const ONE = { request: TWO.request, claims: [TWO.claims[0]] };
const CHANGE = "// the answer is two\nexport const a = 2;\n";

describe("receipts: Claude Code Stop recognises the gate runner", () => {
  it("SessionStart creates the secret and the baseline once", () => {
    const s = claudeSession();
    const key = readFileSync(join(s.dir, "receipt.key"), "utf8");
    assert.match(key, /^[0-9a-f]{64}$/);
    const baseline = readBaseline(s.dir);
    assert.equal(baseline.overflow, false);
    s.hook("SessionStart", { source: "resume" });
    assert.equal(readFileSync(join(s.dir, "receipt.key"), "utf8"), key, "never replaced");
  });

  it("an accepted runner result on the current snapshot and request satisfies strict Stop", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(s.stop()?.decision, "block", "no gate yet");
    const r = s.runner();
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(s.stop(), null);
  });

  it("a printed or pasted summary is not evidence", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": "export const a = 2;\n" });
    const fake = JSON.stringify({ jev_flow_gate_run: 1, status: "accepted", exit: 0, receipt: "0".repeat(32) });
    s.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: `echo '${fake}'` } });
    s.hook("PostToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: `echo '${fake}'` }, tool_response: { stdout: fake } });
    assert.equal(s.stop()?.decision, "block");
  });

  it("rejects a later failed attempt, another request, a changed snapshot, a tampered receipt and a non-accepted verdict", () => {
    const later = claudeSession();
    writeFiles(later.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(later.runner().code, 0);
    assert.equal(later.runner({ OPENROUTER_API_KEY: "" }).code, 3, "a new attempt without credentials");
    assert.equal(later.stop()?.decision, "block", "the newer failed attempt supersedes the accepted one");

    const other = claudeSession();
    writeFiles(other.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(other.runner().code, 0);
    other.hook("UserPromptSubmit", { prompt: "and now?" });
    assert.equal(other.stop()?.decision, "block", "a receipt of an earlier request");

    const changed = claudeSession();
    writeFiles(changed.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(changed.runner().code, 0);
    writeFiles(changed.repo, { "a.js": "export const a = 3;\n" });
    assert.equal(changed.stop()?.decision, "block", "the code changed after the gate");

    const tampered = claudeSession({ mode: "escalate" });
    writeFiles(tampered.repo, { "a.js": "export const a = 2;\n" });
    const r = tampered.runner();
    assert.equal(r.code, 2);
    assert.equal(tampered.stop()?.decision, "block", "an escalated verdict");
    const file = join(tampered.dir, RECEIPTS_DIR, `${r.out.receipt}.json`);
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...receipt, status: "accepted", accepted: true, actions: ["auto"] }));
    // The strict redirect is used once per snapshot; afterwards Stop notifies. Either way the gate is not accepted.
    const out = tampered.stop();
    assert.ok(out !== null, "an edited receipt fails its HMAC");
    assert.match(out.systemMessage, /completion is not verified/);
  });

  it("a partitioned batch counts only when every part is evaluated and auto (R5)", () => {
    const big = (tag) => Array.from({ length: 600 }, (_, i) => `export const ${tag}${i} = "${"x".repeat(50)}";`).join("\n") + "\n";
    const three = { request: "set a to 2", claims: ["a", "b", "c"].map((f) => ({ text: `${f}.js is regenerated`, evidence: [`file:${f}.js`] })) };
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": big("a"), "b.js": big("b"), "c.js": big("c") });
    const escalated = s.runner({ FAKE_MCP_MODES: "escalate,accepted,accepted" }, { input: three });
    assert.deepEqual([escalated.code, escalated.out.outcome, escalated.out.coverage.evaluated, escalated.out.batch.parts], [2, "escalate", 3, 3]);
    assert.equal(s.stop()?.decision, "block", "one escalated part keeps the whole batch unaccepted");
    const all = s.runner({}, { input: three });
    assert.equal(all.code, 0, JSON.stringify(all.out));
    assert.equal(s.stop(), null, "every part auto on the same snapshot");
  });

  it("an unfinished runner attempt (crashed run) keeps completion unverified", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(s.runner().code, 0);
    withState(s.dir, (state) => {
      state.pending[`run-${"f".repeat(32)}`] = { kind: "gate", runner: "f".repeat(32), before: "unknown", input: "x", req: state.request.seq, boot: state.boot, ts: Date.now() + 1000 };
    });
    assert.equal(s.stop()?.decision, "block");
  });

  it("a receipt signed with another key, or without a key, is refused", () => {
    const dir = tempDir("jev-flow-receipt-");
    ensureReceiptKey(dir);
    const id = newReceiptId();
    const body = { v: 1, id, session: "a".repeat(16), req: 1, boot: 1, snap: "c".repeat(64), snap_after: "c".repeat(64), parts: 1, part_ids: [1], actions: ["auto"], verdicts: [["verified"]], coverage: { planned: 1, sent: 1, evaluated: 1, unavailable: 0, unevaluated: 0 }, checks: [{ n: 1, cmd: "c".repeat(32), exit: 0, timed_out: false, start_failed: false }], verdict: "accepted", status: "ok", outcome: "accepted", accepted: true };
    writeReceipt(dir, body);
    const expected = { session: "a".repeat(16), req: 1, boot: 1, snapshot: "c".repeat(64) };
    assert.equal(verifyReceipt(dir, id, expected).accepted, true);
    // Even a correctly signed "accepted" receipt is refused when a check did not pass.
    for (const bad of [{ exit: 3 }, { exit: null, timed_out: true }, { exit: null, start_failed: true }]) {
      const other = newReceiptId();
      writeReceipt(dir, { ...body, id: other, checks: [{ n: 1, cmd: "c".repeat(32), exit: 0, timed_out: false, start_failed: false, ...bad }] });
      assert.equal(verifyReceipt(dir, other, expected).reason, "receipt_checks_failed", JSON.stringify(bad));
    }
    // A correctly signed receipt must also cover the whole batch, with a clean verdict and status (R5).
    const three = { ...body, parts: 3, part_ids: [1, 2, 3], actions: ["auto", "auto", "auto"], verdicts: [[], [], []], coverage: { planned: 3, sent: 3, evaluated: 3, unavailable: 0, unevaluated: 0 } };
    const signedThree = newReceiptId();
    writeReceipt(dir, { ...three, id: signedThree });
    assert.equal(verifyReceipt(dir, signedThree, expected).accepted, true);
    for (const [label, bad, reason] of [
      ["a missing part", { part_ids: [1, 2], actions: ["auto", "auto"], verdicts: [[], []] }, "receipt_incomplete"],
      ["a duplicate part", { part_ids: [1, 1, 3] }, "receipt_incomplete"],
      ["an unevaluated part", { actions: ["auto", "auto", "unevaluated"], coverage: { planned: 3, sent: 2, evaluated: 2, unavailable: 0, unevaluated: 1 } }, "receipt_incomplete"],
      ["coverage that disagrees", { coverage: { planned: 3, sent: 3, evaluated: 2, unavailable: 1, unevaluated: 0 } }, "receipt_incomplete"],
      ["no coverage", { coverage: undefined }, "receipt_incomplete"],
      ["an escalated verdict", { verdict: "escalate", outcome: "escalate" }, "receipt_not_accepted_escalate"],
      ["an unavailable status", { status: "unavailable", outcome: "unavailable" }, "receipt_not_accepted_unavailable"],
      ["a pre-0.3.0 receipt (no verdict)", { verdict: undefined, outcome: undefined, status: "accepted" }, "receipt_not_accepted_accepted"],
    ]) {
      const other = newReceiptId();
      writeReceipt(dir, JSON.parse(JSON.stringify({ ...three, ...bad, id: other })));
      assert.equal(verifyReceipt(dir, other, expected).reason, reason, label);
    }
    const other = tempDir("jev-flow-receipt-");
    ensureReceiptKey(other);
    const copy = join(other, RECEIPTS_DIR);
    run("cp", ["-R", join(dir, RECEIPTS_DIR), copy]);
    assert.equal(verifyReceipt(other, id, expected).reason, "receipt_signature_invalid", "a receipt replayed into another session");
    assert.equal(verifyReceipt(tempDir("jev-flow-receipt-"), id, expected).reason, "receipt_key_missing");
    assert.throws(() => writeReceipt(dir, { ...body, note: "line one\nline two" }), /non-metadata/);
    assert.ok(readdirSync(join(dir, RECEIPTS_DIR)).includes(`${id}.json`));
  });
});

describe("receipts: coverage across attempts and early attempt records (F3, fixes 3 and 5)", () => {
  it("runner → runner: an escalated attempt's claims cannot be dropped; a complete replacement counts", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": CHANGE });
    assert.equal(s.runner({ FAKE_MCP_MODE: "escalate" }, { input: TWO }).code, 2);
    assert.equal(s.runner({}, { input: ONE }).code, 0, "the subset itself is auto");
    assert.equal(s.stop()?.decision, "block", "the subset drops a claim of the escalated attempt");
    assert.equal(s.runner({}, { input: TWO }).code, 0);
    assert.equal(s.stop(), null, "the complete replacement counts");
  });

  it("an interrupted, prepared attempt also has to be covered", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": CHANGE });
    // Keep only what an interrupted run leaves: no receipt, the attempt record with its coverage metadata.
    const full = s.runner({ FAKE_MCP_MODE: "escalate" }, { input: TWO });
    const rec = JSON.parse(readFileSync(join(s.dir, RECEIPTS_DIR, `${full.out.receipt}.json`), "utf8"));
    const lost = "e".repeat(32);
    withState(s.dir, (state) => {
      state.gates = state.gates.filter((g) => g.runner !== full.out.receipt);
      state.gates.push({ id: `run-${lost}`, runner: lost, req: rec.req, boot: rec.boot, input: "x", before: rec.snap, after: "unknown", ts: rec.ts_start, failed: true, claims: rec.claims, diff: rec.diff, claim_ids: rec.claim_ids });
    });
    assert.equal(s.runner({}, { input: ONE }).code, 0);
    assert.equal(s.stop()?.decision, "block");
    assert.equal(s.runner({}, { input: TWO }).code, 0);
    assert.equal(s.stop(), null, "covering the interrupted attempt's claims counts");
  });

  it("runner → direct jev_gate: a direct gate must cover the runner attempt's claims and diff", () => {
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": CHANGE });
    assert.equal(s.runner({ FAKE_MCP_MODE: "escalate" }, { input: TWO }).code, 2);
    const diff = sanitizeDiff(collectPatch(s.repo, readBaseline(s.dir)).diff, loadDenylist(s.repo)).text;
    const base = { request: TWO.request, diff, evidence: [{ id: "hunk-1", text: diff }] };
    s.directGate("d1", { ...base, claims: [TWO.claims[0].text] });
    assert.equal(s.stop()?.decision, "block", "the direct gate drops a claim");
    s.directGate("d2", { ...base, claims: TWO.claims.map((c) => c.text) });
    assert.equal(s.stop(), null, "a direct gate with every claim and the same diff counts");
  });

  it("an invalid gate invocation after an accepted run supersedes it (claims JSON, --check, missing claims)", () => {
    for (const [label, opts] of [
      ["unreadable claims JSON", { input: "{not json" }],
      ["shell-style --check", { args: ["--check", "npm test"] }],
      ["invalid input", { input: { request: "", claims: [] } }],
    ]) {
      const s = claudeSession();
      writeFiles(s.repo, { "a.js": "export const a = 2;\n" });
      assert.equal(s.runner().code, 0);
      const r = s.runner({}, opts);
      assert.equal(r.code, 4, label);
      assert.equal(s.stop()?.decision, "block", label);
    }
    // --list-hunks and --help never replace an accepted gate.
    const s = claudeSession();
    writeFiles(s.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(s.runner().code, 0);
    for (const extra of [["--list-hunks"], ["--help"]]) {
      run(process.execPath, [GATE_RUN_CLI, "--root", s.repo, ...extra], { env: { ...s.env, CLAUDE_CODE_SESSION_ID: s.id }, cwd: s.repo });
    }
    assert.equal(s.stop(), null);
  });
});

describe("receipts: OpenCode gate status recognises the gate runner", () => {
  function fakeCtx(directory) {
    const hooks = { tool: {}, session: {} };
    const commands = new Map();
    const prompts = [];
    const reg = () => ({ dispose: async () => {} });
    const ctx = {
      location: { directory },
      command: { transform: async (cb) => (cb({ add: (d) => commands.set(d.name, d) }), reg()), list: async () => [] },
      tool: { hook: async (name, cb) => ((hooks.tool[name] = cb), reg()) },
      session: { hook: async (name, cb) => ((hooks.session[name] = cb), reg()), prompt: async (i) => prompts.push(i) },
    };
    return { ctx, hooks, commands, prompts };
  }

  it("counts a runner result only through its receipt for this session, request and snapshot", async () => {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const env = sandboxEnv({ ...fakeJevEnv("accepted"), JEV_FLOW_STRICT: "1" });
    const f = fakeCtx(repo);
    await setupFlow(f.ctx, { log: () => {}, env });
    const done = async () => {
      f.prompts.length = 0;
      await f.commands.get("jev-done").execute({ sessionID: "oc1", prompt: { text: "" }, delivery: "queue" });
      return f.prompts[0].text;
    };
    await f.hooks.session.prompt({ sessionID: "oc1" });
    writeFiles(repo, { "a.js": "export const a = 2;\n" });
    const text = await done();
    const key = /jev-gate-run\.mjs" --session-key ([0-9a-f]{16}) --root \. --claims/.exec(text)?.[1];
    assert.ok(key, "the runner commands carry this session's key");
    assert.match(text, /jev-gate-run\.mjs" --session-key [0-9a-f]{16} --root \. --list-hunks/);
    const claims = join(tempDir("jev-flow-claims-"), "c.json");
    writeFileSync(claims, JSON.stringify(CLAIMS));
    const command = `node "${GATE_RUN_CLI}" --session-key ${key} --root . --claims ${claims}`;
    assert.equal(isRunnerGateCommand(command), true);
    assert.equal(isRunnerGateCommand(`node "${GATE_RUN_CLI}" --root . --list-hunks`), false);
    const attempt = (id, extraEnv = {}) => {
      f.hooks.tool["execute.before"]({ tool: "bash", sessionID: "oc1", id, input: { command } });
      const r = run(process.execPath, [GATE_RUN_CLI, "--session-key", key, "--root", repo, "--claims", claims], { env: { ...env, ...extraEnv }, cwd: repo });
      f.hooks.tool["execute.after"]({ tool: "bash", sessionID: "oc1", id, input: { command }, status: "completed", result: { output: r.stdout } });
      return r.code;
    };
    assert.equal(attempt("b1"), 0);
    assert.match(await done(), /signed receipt accepts all 1 part\(s\) for the current snapshot and request/);
    assert.equal(attempt("b2", { OPENROUTER_API_KEY: "" }), 3);
    assert.match(await done(), /last jev_gate call failed/, "a newer failed attempt supersedes it");
    assert.equal(attempt("b3"), 0);
    writeFiles(repo, { "a.js": "export const a = 3;\n" });
    assert.match(await done(), /gate_on_older_snapshot|code changed after the last jev_gate/);
    await f.hooks.session.prompt({ sessionID: "oc1" });
    assert.match(await done(), /another request/);
  });

  async function openCodeSession() {
    const repo = makeRepo({ "a.js": "export const a = 1;\n" });
    const env = sandboxEnv({ ...fakeJevEnv("accepted"), JEV_FLOW_STRICT: "1" });
    const f = fakeCtx(repo);
    await setupFlow(f.ctx, { log: () => {}, env });
    const done = async () => {
      f.prompts.length = 0;
      await f.commands.get("jev-done").execute({ sessionID: "oc2", prompt: { text: "" }, delivery: "queue" });
      return f.prompts[0].text;
    };
    await f.hooks.session.prompt({ sessionID: "oc2" });
    const key = /--session-key ([0-9a-f]{16})/.exec(await done())[1];
    let n = 0;
    /** One runner invocation as OpenCode's bash tool would run it. */
    const attempt = ({ input = CLAIMS, args = [], extraEnv = {} } = {}) => {
      const file = join(tempDir("jev-flow-claims-"), "c.json");
      writeFileSync(file, typeof input === "string" ? input : JSON.stringify(input));
      const argv = ["--session-key", key, "--root", repo, "--claims", file, ...args];
      const command = `node "${GATE_RUN_CLI}" ${argv.join(" ")}`;
      const id = `b${++n}`;
      f.hooks.tool["execute.before"]({ tool: "bash", sessionID: "oc2", id, input: { command } });
      const r = run(process.execPath, [GATE_RUN_CLI, ...argv], { env: { ...env, ...extraEnv }, cwd: repo });
      f.hooks.tool["execute.after"]({ tool: "bash", sessionID: "oc2", id, input: { command }, status: "completed", result: { output: r.stdout } });
      return r.code;
    };
    return { repo, done, attempt, receiptsDir: () => join(sessionDirFromKey(repo, key, env), RECEIPTS_DIR) };
  }
  const ACCEPTED = /signed receipt accepts/;
  const CHECK = join(import.meta.dirname, "fixtures", "check.mjs");

  it("a failing or timed-out check keeps the gate unaccepted (fix 2)", async () => {
    const o = await openCodeSession();
    writeFiles(o.repo, { "a.js": "export const a = 2;\n" });
    assert.equal(o.attempt({ args: ["--check", JSON.stringify([process.execPath, CHECK, "boom", "3"])] }), 2);
    assert.doesNotMatch(await o.done(), ACCEPTED);
    assert.equal(o.attempt({ args: ["--check", JSON.stringify([process.execPath, CHECK, "slow", "0", "--sleep", "5000"]), "--check-timeout", "1"] }), 2);
    assert.doesNotMatch(await o.done(), ACCEPTED);
    assert.equal(o.attempt({ args: ["--check", JSON.stringify([process.execPath, CHECK, "ok", "0"])] }), 0);
    assert.match(await o.done(), ACCEPTED);
  });

  it("a partitioned batch: an escalated part or an edited receipt is refused, a complete batch is accepted (R5)", async () => {
    const big = (tag) => Array.from({ length: 600 }, (_, i) => `export const ${tag}${i} = "${"x".repeat(50)}";`).join("\n") + "\n";
    const three = { request: "set a to 2", claims: ["a", "b", "c"].map((f) => ({ text: `${f}.js is regenerated`, evidence: [`file:${f}.js`] })) };
    const o = await openCodeSession();
    writeFiles(o.repo, { "a.js": big("a"), "b.js": big("b"), "c.js": big("c") });
    assert.equal(o.attempt({ input: three, extraEnv: { FAKE_MCP_MODES: "escalate,accepted,accepted" } }), 2);
    assert.match(await o.done(), /receipt_not_accepted_escalate/);
    assert.equal(o.attempt({ input: three }), 0);
    assert.match(await o.done(), /signed receipt accepts all 3 part\(s\)/);
    // Edit the accepted receipt to drop a part: the HMAC no longer verifies.
    const receipts = o.receiptsDir();
    const file = readdirSync(receipts).map((f) => join(receipts, f)).sort((a, b) => JSON.parse(readFileSync(a, "utf8")).ts_end - JSON.parse(readFileSync(b, "utf8")).ts_end).pop();
    const body = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...body, parts: 2, part_ids: [1, 2], actions: ["auto", "auto"] }));
    assert.match(await o.done(), /receipt_signature_invalid/);
  });

  it("coverage across runner attempts, and an invalid invocation supersedes an accepted one (fixes 3 and 5)", async () => {
    const o = await openCodeSession();
    writeFiles(o.repo, { "a.js": CHANGE });
    assert.equal(o.attempt({ input: TWO, extraEnv: { FAKE_MCP_MODE: "escalate" } }), 2);
    assert.equal(o.attempt({ input: ONE }), 0);
    assert.match(await o.done(), /does not cover every claim/);
    assert.equal(o.attempt({ input: TWO }), 0);
    assert.match(await o.done(), ACCEPTED);
    assert.equal(o.attempt({ input: "{not json" }), 4);
    assert.doesNotMatch(await o.done(), ACCEPTED, "an invalid invocation leaves a failed latest attempt");
  });
});

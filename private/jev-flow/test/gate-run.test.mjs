import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseBatchLabel } from "../gate-batch.mjs";
import { compactSummary, RUN_LIMITS } from "../gate-run.mjs";
import { RECEIPTS_DIR, verifyReceipt } from "../runner-receipt.mjs";
import { assertMetadataOnly, computeSnapshot, loadState, sessionDir, sessionKey } from "../state.mjs";
import { fakeJevEnv, GATE_RUN_CLI, HOOK_CLI, makeRepo, run, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

const FAKE_OR_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const CHECK = join(import.meta.dirname, "fixtures", "check.mjs");
/** A --check argv running the test check (no shell). */
const check = (...args) => ["--check", JSON.stringify([process.execPath, CHECK, ...args])];

function readLog(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const toolCalls = (log) => readLog(log).filter((r) => r.method === "tools/call");

/** A repo with a committed a.js, a session (SessionStart + prompt through the hook CLI) and a fake Jev server. */
function setup({ files = { "a.js": "export const a = 1;\n" }, before = null, mode = "accepted", envExtra = {}, session = true } = {}) {
  const repo = makeRepo(files);
  if (before) before(repo);
  const log = join(tempDir("jev-flow-run-log-"), "calls.jsonl");
  const id = `s-${Math.random().toString(36).slice(2)}`;
  const env = sandboxEnv({ ...fakeJevEnv(mode, { FAKE_MCP_LOG: log }), ...(session ? { CLAUDE_CODE_SESSION_ID: id } : {}), ...envExtra });
  const hook = (event, extra = {}) => {
    const r = run(process.execPath, [HOOK_CLI, event], { env, cwd: repo, input: JSON.stringify({ session_id: id, cwd: repo, hook_event_name: event, ...extra }) });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  if (session) {
    hook("SessionStart", { source: "startup" });
    hook("UserPromptSubmit", { prompt: "do it" });
  }
  const claimsFile = join(tempDir("jev-flow-claims-"), "claims.json");
  const gate = (input, args = [], extraEnv = {}) => {
    writeFileSync(claimsFile, JSON.stringify(input));
    const r = run(process.execPath, [GATE_RUN_CLI, "--root", repo, "--claims", claimsFile, ...args], { env: { ...env, ...extraEnv }, cwd: repo });
    assert.ok(r.stdout.trim(), r.stderr);
    return { code: r.code, out: JSON.parse(r.stdout), raw: r.stdout.trim() };
  };
  const listHunks = (extraEnv = {}) => JSON.parse(run(process.execPath, [GATE_RUN_CLI, "--root", repo, "--list-hunks"], { env: { ...env, ...extraEnv }, cwd: repo }).stdout);
  return { repo, env, id, log, hook, gate, listHunks, dir: sessionDir(repo, id, env) };
}

const CLAIMS = (extra = {}) => ({
  request: "set a to 2 and add b",
  claims: [
    { text: "a.js exports a = 2", evidence: ["file:a.js"] },
    { text: "b.js is a new file exporting b = 3", evidence: ["file:b.js"] },
  ],
  ...extra,
});
const change = (repo) => writeFiles(repo, { "a.js": "export const a = 2;\n", "b.js": "export const b = 3;\n" });

describe("gate runner: scope and hunks", () => {
  it("lists tracked and new non-ignored files, without bodies", () => {
    const s = setup({ files: { "a.js": "export const a = 1;\n", ".gitignore": "ignored.log\n" } });
    change(s.repo);
    writeFiles(s.repo, { "ignored.log": "x\n" });
    const listing = s.listHunks();
    assert.deepEqual(listing.hunks.map((h) => [h.id, h.path]), [["hunk-1", "a.js"], ["hunk-2", "b.js"]]);
    assert.ok(listing.hunks.every((h) => !("text" in h)));
    assert.equal(listing.base.mode, "session_baseline");
  });

  it("leaves unchanged pre-existing changes out (unattributed) and flags re-changed ones (preexisting_mixed)", () => {
    const s = setup({
      files: { "a.js": "export const a = 1;\n", "p.js": "p1\n", "q.js": "q1\n" },
      before: (repo) => writeFiles(repo, { "p.js": "p2 before the session\n", "q.js": "q2 before the session\n", "u.txt": "untracked before\n" }),
    });
    writeFiles(s.repo, { "a.js": "export const a = 2;\n", "q.js": "q3 changed in the session\n" });
    const listing = s.listHunks();
    assert.deepEqual(listing.hunks.map((h) => h.path), ["a.js", "q.js"]);
    assert.deepEqual(listing.unattributed.sort(), ["p.js", "u.txt"]);
    assert.deepEqual(listing.preexisting_mixed, ["q.js"]);
    const r = s.gate({ request: "r", claims: [{ text: "a.js exports a = 2", evidence: ["file:a.js"] }, { text: "q.js holds q3", evidence: ["file:q.js"] }] });
    assert.equal(r.code, 0, r.raw);
    assert.deepEqual(r.out.limits.unattributed.sort(), ["p.js", "u.txt"]);
    const sent = toolCalls(s.log)[0].args.diff;
    assert.doesNotMatch(sent, /p2 before the session|untracked before/);
  });

  it("falls back to HEAD without a session baseline and says attribution is unknown", () => {
    const s = setup({ session: false });
    change(s.repo);
    const r = s.gate(CLAIMS());
    assert.equal(r.code, 0, r.raw);
    assert.equal(r.out.base.mode, "head_fallback");
    assert.match(r.out.limits.unattributed, /baseline unknown/);
    assert.equal(r.out.receipt, null);
    assert.match(r.out.receipt_note, /not recorded as completion evidence/);
  });

  it("reports binary files as unevaluated and an empty diff as not ready", () => {
    const s = setup();
    const empty = s.gate(CLAIMS());
    assert.equal(empty.code, 4);
    assert.match(empty.out.problems.join(" "), /empty diff/);
    change(s.repo);
    writeFileSync(join(s.repo, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const listing = s.listHunks();
    assert.deepEqual(listing.unevaluated, [{ path: "img.bin", reason: "binary" }]);
  });
});

describe("gate runner: real checks, refused declarations, snapshot binding", () => {
  it("runs the checks itself and sends their real output and exit code as cmd-N evidence", () => {
    const s = setup();
    change(s.repo);
    const input = CLAIMS();
    input.claims.push({ text: "the check printed hello and exited 3", evidence: ["cmd-1"] });
    const r = s.gate(input, check("hello-from-check", "3", "--stderr", "to-stderr"));
    assert.equal(r.out.checks.length, 1);
    assert.equal(r.out.checks[0].exit, 3);
    assert.ok(r.out.checks[0].command.length <= 120, "the summary clips long commands");
    const cmd = toolCalls(s.log)[0].args.evidence.find((e) => e.id === "cmd-1");
    assert.match(cmd.text, /^\[cmd-1\] \$ \S+ \S+check\.mjs hello-from-check 3 --stderr to-stderr\nexit: 3\n/);
    assert.match(cmd.text, /hello-from-check/);
    assert.match(cmd.text, /to-stderr/);
    const state = loadState(s.dir);
    assert.ok(state.tests.some((t) => t.exit === 3 && t.failed === true), "the real exit code is recorded as a failed check run");
  });

  it("takes --check as argv without a shell and refuses anything else", () => {
    const s = setup();
    change(s.repo);
    const shellish = s.gate(CLAIMS(), ["--check", "npm test"]);
    assert.equal(shellish.code, 4);
    assert.match(shellish.out.problems[0], /--check must be a JSON array of strings \(argv, no shell\)/);
    for (const bad of ["[]", '["", "x"]', '{"cmd":"npm"}', '["node", 1]']) assert.equal(s.gate(CLAIMS(), ["--check", bad]).code, 4, bad);
    // Shell syntax inside argv is passed literally: no pipe, redirection or && happens.
    const marker = join(s.repo, "should-not-exist.txt");
    const r = s.gate(CLAIMS(), check("a > should-not-exist.txt && echo pwned", "0"));
    assert.equal(r.code, 0, r.raw);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    const missing = s.gate(CLAIMS(), ["--check", JSON.stringify(["/nonexistent/jev-check-binary"])]);
    assert.equal(missing.out.checks[0].start_failed, true);
    assert.equal(missing.out.checks[0].exit, null);
    assert.equal(missing.out.status, "checks_failed");
  });

  it("never accepts when a check fails or times out, even with an auto gate (receipt and Stop agree)", () => {
    const s = setup({ envExtra: { JEV_FLOW_STRICT: "1" } });
    change(s.repo);
    const failed = s.gate(CLAIMS(), [...check("ok", "0"), ...check("boom", "3")]);
    assert.deepEqual([failed.out.status, failed.code], ["checks_failed", 2]);
    assert.equal(failed.out.parts[0].route, "accepted", "Jev itself answered auto");
    const r1 = JSON.parse(readFileSync(join(s.dir, RECEIPTS_DIR, `${failed.out.receipt}.json`), "utf8"));
    assert.equal(r1.accepted, false);
    assert.equal(s.hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." })?.decision, "block");

    const slow = s.gate(CLAIMS(), [...check("slow", "0", "--sleep", "5000"), "--check-timeout", "1"]);
    assert.deepEqual([slow.out.status, slow.code], ["checks_failed", 2]);
    assert.equal(slow.out.checks[0].timed_out, true);
    assert.equal(slow.out.checks[0].exit, null);

    // With every check passing, the same gate is accepted.
    const ok = s.gate(CLAIMS(), check("ok", "0"));
    assert.equal(ok.code, 0, ok.raw);
    const snapshot = computeSnapshot(s.repo).hash;
    const record = loadState(s.dir).gates.at(-1);
    assert.equal(verifyReceipt(s.dir, ok.out.receipt, { session: sessionKey(s.id), req: record.req, snapshot }).accepted, true);
  });

  it("refuses declared diffs, logs, exit codes and excerpt text", () => {
    const s = setup();
    change(s.repo);
    for (const extra of [{ diff: "diff --git a/x b/x" }, { commands: [{ command: "npm test", exit: 0, output: "ok" }] }, { tests: "all passed" }, { evidence: [] }, { excerpts: [{ id: "x", path: "a.js", lines: [1, 1], text: "fake" }] }]) {
      const r = s.gate(CLAIMS(extra));
      assert.equal(r.code, 4, JSON.stringify(extra));
      assert.equal(r.out.status, "invalid_input");
    }
    assert.equal(toolCalls(s.log).length, 0, "nothing was sent");
  });

  it("reads cited excerpts from the files itself", () => {
    const s = setup({ files: { "a.js": "export const a = 1;\n", "lib.js": "line1\nfunction helper() {}\nline3\n" } });
    change(s.repo);
    const input = CLAIMS({ excerpts: [{ id: "helper", path: "lib.js", lines: [2, 2] }] });
    input.claims[0].evidence.push("helper");
    const r = s.gate(input);
    assert.equal(r.code, 0, r.raw);
    const item = toolCalls(s.log)[0].args.evidence.find((e) => e.id === "helper");
    assert.match(item.text, /\[helper\] lib\.js:2-2\n2: function helper\(\) \{\}/);
  });

  it("a check that changes the work tree makes the run not ready, with no Jev call", () => {
    const s = setup();
    change(s.repo);
    const r = s.gate(CLAIMS(), check("x", "0", "--write", join(s.repo, "generated.txt")));
    assert.equal(r.code, 4);
    assert.match(r.out.problems[0], /work tree changed while the checks ran/);
    assert.equal(toolCalls(s.log).length, 0);
  });

  it("a work-tree change during the gate is not accepted", () => {
    const s = setup();
    change(s.repo);
    const r = s.gate(CLAIMS(), [], { FAKE_MCP_TOUCH: join(s.repo, "b.js") });
    assert.equal(r.code, 4);
    assert.equal(r.out.status, "snapshot_changed");
    const receipt = JSON.parse(readFileSync(join(s.dir, RECEIPTS_DIR, `${r.out.receipt}.json`), "utf8"));
    assert.equal(receipt.accepted, false);
  });

  it("binds every part to the snapshot the run started on", () => {
    const s = setup();
    change(s.repo);
    const snap = computeSnapshot(s.repo).hash;
    const r = s.gate(CLAIMS());
    assert.equal(r.code, 0, r.raw);
    const label = parseBatchLabel(toolCalls(s.log)[0].args.request);
    assert.equal(label.snap, snap);
    assert.equal(r.out.snapshot, snap.slice(0, 16));
  });
});

describe("gate runner: partitioning, sanitizing, credentials, verdicts", () => {
  it("sends one call for a small patch and partitions a large one, every part in the same batch", () => {
    const small = setup();
    change(small.repo);
    assert.equal(small.gate(CLAIMS()).code, 0);
    assert.equal(toolCalls(small.log).length, 1);
    assert.equal(toolCalls(small.log)[0].request_first_line.includes("part=1/1"), true);

    const big = setup();
    const lines = (tag) => Array.from({ length: 900 }, (_, i) => `export const ${tag}${i} = "${"x".repeat(60)}";`).join("\n") + "\n";
    writeFiles(big.repo, { "a.js": lines("a"), "b.js": lines("b") });
    const r = big.gate(CLAIMS());
    assert.equal(r.code, 0, r.raw);
    assert.equal(r.out.limits.partitioned, true);
    const labels = toolCalls(big.log).map((c) => parseBatchLabel(c.args.request));
    assert.ok(labels.length >= 2);
    assert.ok(labels.every((l) => l.id === labels[0].id && l.of === labels.length));
    assert.equal(r.out.batch.parts, labels.length);
    assert.ok(r.raw.length <= RUN_LIMITS.summaryChars);
  });

  it("redacts credentials before sending and refuses content the sanitizer must remove", () => {
    const s = setup();
    writeFiles(s.repo, { "a.js": `export const a = 2;\nconst apiKey = "${FAKE_OR_KEY}";\n`, "b.js": "export const b = 3;\n" });
    const r = s.gate(CLAIMS());
    assert.equal(r.code, 0, r.raw);
    const sent = JSON.stringify(toolCalls(s.log)[0].args);
    assert.ok(!sent.includes(FAKE_OR_KEY), "the key never reaches the server");
    assert.match(sent, /\[REDACTED:/);
    assert.ok(r.out.limits.redactions.length > 0);

    const d = setup({ files: { "a.js": "export const a = 1;\n", ".jev-flow-denylist": "secret/\n" } });
    change(d.repo);
    writeFiles(d.repo, { "secret/data.js": "x\n" });
    const refused = d.gate(CLAIMS());
    assert.equal(refused.code, 4);
    assert.match(refused.out.problems.join(" "), /sanitizing removed content/);
    assert.equal(toolCalls(d.log).length, 0);
  });

  it("a denylist '*' disables the runner", () => {
    const s = setup({ files: { "a.js": "export const a = 1;\n", ".jev-flow-denylist": "*\n" } });
    change(s.repo);
    const r = s.gate(CLAIMS());
    assert.equal(r.code, 3);
    assert.equal(r.out.message, "Jev disabled for this repo; gate not evaluated");
    assert.equal(readLog(s.log).length, 0);
  });

  it("without credentials reports Jev unavailable, spawns nothing and records a failed attempt", () => {
    const s = setup({ envExtra: { OPENROUTER_API_KEY: "" } });
    change(s.repo);
    const r = s.gate(CLAIMS(), check("fine", "0"));
    assert.equal(r.code, 3);
    assert.equal(r.out.status, "unavailable");
    assert.equal(r.out.message, "Jev unavailable; gate not evaluated");
    assert.equal(readLog(s.log).length, 0, "the server was never started");
    assert.equal(r.out.checks[0].exit, 0, "the checks still ran");
    const g = loadState(s.dir).gates.at(-1);
    assert.equal(g.failed, true);
  });

  it("chooses openrouter for the server when only OPENROUTER_API_KEY is set", () => {
    const s = setup();
    change(s.repo);
    s.gate(CLAIMS());
    assert.equal(toolCalls(s.log)[0].provider, "openrouter");
  });

  it("maps verdicts to exit codes: 2 for escalate, contradicted and missing evidence; 3 for a failing tool", () => {
    const expect = { escalate: ["escalate", 2], contradicted: ["contradicted", 2], unsupported: ["needs_evidence", 2], tool_error: ["unavailable", 3], invalid: ["unavailable", 3] };
    for (const [mode, [status, code]] of Object.entries(expect)) {
      const s = setup({ mode });
      change(s.repo);
      const r = s.gate(CLAIMS());
      assert.deepEqual([r.out.status, r.code], [status, code], mode);
      if (mode === "contradicted") assert.deepEqual(r.out.parts[0].claims.map((c) => [c.c, c.verdict]), [[1, "contradicted"], [2, "contradicted"]]);
      if (mode === "invalid") assert.equal(toolCalls(s.log).length, 2, "one retry with identical input");
    }
  });

  it("retries an invalid gate result or a dropped connection once, counting the calls actually sent", () => {
    const cases = [
      [{ FAKE_MCP_MALFORMED: "first" }, "accepted", 0, 2],
      [{ FAKE_MCP_MALFORMED: "always" }, "unavailable", 3, 2],
      [{ FAKE_MCP_CRASH: "once" }, "accepted", 0, 2],
      [{ FAKE_MCP_CRASH: "once_then_dead" }, "unavailable", 3, 1],
    ];
    for (const [extra, status, code, calls] of cases) {
      const s = setup({ envExtra: { ...extra, FAKE_MCP_STATE: join(tempDir("jev-flow-state-"), "s.json") } });
      change(s.repo);
      const r = s.gate(CLAIMS());
      const label = JSON.stringify(extra);
      assert.deepEqual([r.out.status, r.code], [status, code], label);
      assert.equal(toolCalls(s.log).length, calls, `${label}: calls sent`);
      if (status === "accepted") assert.equal(r.out.jev_calls, calls, label);
      else assert.match(r.out.reason, new RegExp(`${calls} call\\(s\\) sent`), label);
      if (extra.FAKE_MCP_CRASH === "once_then_dead") assert.match(r.out.reason, /retry not_executed: reconnect failed/);
    }
  });

  it("keeps the summary within ~4 KB and says when it compressed it", () => {
    const parts = Array.from({ length: 8 }, (_, i) => ({ part: i + 1, of: 8, action: "auto", reason_codes: ["accepted"], route: "accepted", claims: Array.from({ length: 16 }, (_, c) => ({ c: c + 1, verdict: "verified", confidence: 0.95 })) }));
    const big = { jev_flow_gate_run: 1, status: "accepted", exit: 0, parts, limits: { uncited_hunks: Array.from({ length: 200 }, (_, i) => `hunk-${i}`) }, problems: [] };
    const out = compactSummary(big);
    assert.ok(out.length <= RUN_LIMITS.summaryChars, String(out.length));
    const parsed = JSON.parse(out);
    assert.equal(parsed.summary_truncated, true);
    assert.equal(parsed.status, "accepted");
    assert.deepEqual(parsed.parts[0].claims, { verified: 16 });
  });
});

describe("gate runner: receipts", () => {
  it("writes a metadata-only, HMAC-signed receipt that verifies for this session, request and snapshot", () => {
    const s = setup();
    change(s.repo);
    const r = s.gate(CLAIMS(), check("fine", "0"));
    assert.equal(r.code, 0, r.raw);
    assert.match(r.out.receipt, /^[0-9a-f]{32}$/);
    const files = readdirSync(join(s.dir, RECEIPTS_DIR));
    assert.deepEqual(files, [`${r.out.receipt}.json`]);
    const text = readFileSync(join(s.dir, RECEIPTS_DIR, files[0]), "utf8");
    const receipt = JSON.parse(text);
    assertMetadataOnly(receipt, "receipt");
    for (const content of ["a.js exports a = 2", "export const", "set a to 2"]) assert.ok(!text.includes(content), content);
    const snapshot = computeSnapshot(s.repo).hash;
    const record = loadState(s.dir).gates.at(-1);
    assert.equal(record.runner, r.out.receipt);
    assert.equal(verifyReceipt(s.dir, record.runner, { session: sessionKey(s.id), req: record.req, boot: record.boot, snapshot }).accepted, true);
    assert.equal(verifyReceipt(s.dir, record.runner, { session: sessionKey("other"), req: record.req, snapshot }).reason, "receipt_other_session");
    assert.equal(verifyReceipt(s.dir, record.runner, { session: sessionKey(s.id), req: record.req + 1, snapshot }).reason, "receipt_other_request");
    assert.equal(verifyReceipt(s.dir, record.runner, { session: sessionKey(s.id), req: record.req, snapshot: "b".repeat(64) }).reason, "receipt_snapshot_mismatch");
    // Tampering: flip a field without re-signing.
    writeFileSync(join(s.dir, RECEIPTS_DIR, files[0]), JSON.stringify({ ...receipt, status: "accepted", accepted: true, req: record.req + 1 }));
    assert.equal(verifyReceipt(s.dir, record.runner, { session: sessionKey(s.id), req: record.req + 1, snapshot }).reason, "receipt_signature_invalid");
  });
});

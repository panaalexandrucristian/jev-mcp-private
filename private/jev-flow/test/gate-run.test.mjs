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

/** A report shaped like runGate's, for the compaction tests. */
function bigSummary(nParts, perPart, { light = false } = {}) {
  const occurrences = [];
  const verdicts = ["verified", "unsupported", "contradicted", "unevaluated"];
  for (let p = 1; p <= nParts; p++) for (let k = 0; k < perPart; k++) occurrences.push({ c: (p - 1) * perPart + k + 1, part: p, verdict: light ? "verified" : verdicts[(p + k) % 4], confidence: 0.951 });
  return {
    jev_flow_gate_run: 1, outcome: light ? "escalate" : "escalate", verdict: "escalate", status: light ? "ok" : "checks_failed", exit: 2, receipt: "0".repeat(32), snapshot: "a".repeat(16),
    ...(light ? {} : { conditions: ["checks_failed"] }),
    checks: Array.from({ length: light ? 1 : 8 }, (_, i) => ({ n: i + 1, command: "node ./scripts/a-long-check-command.mjs --with --many --flags ".repeat(2).slice(0, 120), exit: i === 7 ? null : 0, ...(i === 7 ? { timed_out: true } : {}), ...(light ? {} : { cut_chars: 1000 + i }) })),
    base: { mode: "session_baseline", commit: "c".repeat(40) },
    limits: light
      ? { redactions: [], uncited_hunks: [], unattributed: [], preexisting_mixed: [], unevaluated: [], partitioned: true }
      : {
          redactions: Array.from({ length: 120 }, (_, i) => ({ kind: i % 2 ? "aws_key" : "openrouter_key", count: 1 })),
          uncited_hunks: Array.from({ length: 200 }, (_, i) => `hunk-${i}`),
          tests_truncated_chars: 0,
          checks_output_cut: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, chars: 1000 + i })),
          unattributed: Array.from({ length: 120 }, (_, i) => `src/some/pre-existing/path-${i}.ts`),
          preexisting_mixed: Array.from({ length: 40 }, (_, i) => `src/mixed/path-${i}.ts`),
          unevaluated: Array.from({ length: 30 }, (_, i) => ({ path: `assets/img-${i}.png`, reason: "binary" })),
          partitioned: true,
        },
    batch: { id: "b".repeat(32), parts: nParts, slices: nParts },
    parts: Array.from({ length: nParts }, (_, i) => ({ part: i + 1, verdict: i === 0 ? "escalate" : i % 3 ? "accepted" : "needs_evidence", action: i === 0 ? "escalate" : i % 3 ? "auto" : "review", reason_codes: i === 0 ? ["review_escalated", "safe_to_apply_below_review_at"] : i % 3 ? ["accepted"] : ["claims_unsupported", "incomplete_context", "review_required"], safe_to_apply: 0.59 })),
    claims: [...new Set(occurrences.map((o) => o.c))].map((c) => ({ c, verdict: occurrences.find((o) => o.c === c).verdict })),
    occurrences,
    coverage: { planned: nParts, sent: nParts, evaluated: nParts, unavailable: 0, unevaluated: 0 },
    jev_calls: nParts,
    problems: light ? [] : Array.from({ length: 12 }, (_, i) => `problem ${i}: ${"a check failed, timed out, could not start or has an unknown exit code ".repeat(3)}`),
  };
}

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
    assert.equal(failed.out.parts[0].verdict, "accepted", "Jev itself answered auto");
    assert.deepEqual([failed.out.verdict, failed.out.outcome], ["accepted", "checks_failed"], "the verdict and the operational status stay separate");
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
    for (const [mode, [outcome, code]] of Object.entries(expect)) {
      const s = setup({ mode });
      change(s.repo);
      const r = s.gate(CLAIMS());
      assert.deepEqual([r.out.outcome, r.code], [outcome, code], mode);
      assert.equal(r.out.status, outcome === "unavailable" ? "unavailable" : "ok", mode);
      if (mode === "contradicted") {
        assert.deepEqual(r.out.claims, [{ c: 1, verdict: "contradicted" }, { c: 2, verdict: "contradicted" }]);
        assert.deepEqual(r.out.occurrences.map((o) => [o.c, o.part, o.verdict]), [[1, 1, "contradicted"], [2, 1, "contradicted"]]);
      }
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
      assert.deepEqual([r.out.outcome, r.code], [status, code], label);
      assert.equal(toolCalls(s.log).length, calls, `${label}: calls sent`);
      if (status === "accepted") assert.equal(r.out.jev_calls, calls, label);
      else assert.match(r.out.reason, new RegExp(`${calls} call\\(s\\) sent`), label);
      if (extra.FAKE_MCP_CRASH === "once_then_dead") assert.match(r.out.reason, /retry not_executed: reconnect failed/);
    }
  });

  it("keeps the summary within 8 KB: per-occurrence detail goes first, every claim's overall verdict and the counters stay", () => {
    assert.equal(RUN_LIMITS.summaryChars, 8192);
    // Above the old 4 KB limit, within 8 KB: nothing is dropped.
    const mid = bigSummary(3, 16, { light: true });
    const midOut = compactSummary(mid);
    assert.ok(midOut.length > 4096 && midOut.length <= 8192, String(midOut.length));
    assert.deepEqual(JSON.parse(midOut), mid);
  });

  it("compacts the largest batch with heavy repetitive metadata without losing a part, a check, a limit or a claim verdict", () => {
    const max = bigSummary(16, 16);
    assert.ok(JSON.stringify(max).length > 30_000, "well beyond what the old fallback kept");
    const out = compactSummary(max);
    assert.ok(out.length <= RUN_LIMITS.summaryChars, String(out.length));
    const parsed = JSON.parse(out);
    assert.equal(parsed.summary_truncated, true);
    assert.equal(parsed.occurrences_omitted, 256);
    assert.deepEqual([parsed.outcome, parsed.verdict, parsed.status, parsed.exit, parsed.receipt], ["escalate", "escalate", "checks_failed", 2, "0".repeat(32)]);
    assert.deepEqual(parsed.coverage, max.coverage);
    assert.deepEqual(parsed.conditions, ["checks_failed"]);
    // Every part with its verdict, action, all its reason codes and safe_to_apply.
    // Parts and checks keep their object form while they fit, and become tuples only when needed.
    const partTuple = (p) => (Array.isArray(p) ? p : [p.part, p.verdict ?? p.state, p.action, p.reason_codes, p.safe_to_apply]);
    const checkTuple = (c) => (Array.isArray(c) ? c : [c.n, c.exit, ...(c.timed_out ? ["timed_out"] : []), ...(c.cut_chars ? [`cut:${c.cut_chars}`] : [])]);
    const wantParts = max.parts.map(partTuple);
    const wantChecks = max.checks.map(checkTuple);
    assert.deepEqual(parsed.parts.map(partTuple), wantParts);
    assert.deepEqual(parsed.checks.map(checkTuple), wantChecks);
    // Under a much tighter budget the last steps run (tuples, shorter problems): still nothing required is lost.
    const tight = JSON.parse(compactSummary(max, 3000));
    assert.ok(tight.parts.every(Array.isArray) && tight.checks.every(Array.isArray));
    assert.deepEqual(tight.parts, wantParts);
    assert.deepEqual(tight.checks, wantChecks);
    assert.equal(Object.keys(tight.limits).length, Object.keys(max.limits).length);
    // Every limit, lists as counts, redactions summed per kind.
    assert.deepEqual(parsed.limits.uncited_hunks, { count: 200 });
    assert.deepEqual(parsed.limits.unattributed, { count: 120 });
    assert.deepEqual(parsed.limits.preexisting_mixed, { count: 40 });
    assert.deepEqual(parsed.limits.unevaluated, { count: 30 });
    assert.deepEqual(parsed.limits.redactions, { openrouter_key: 60, aws_key: 60 });
    assert.equal(parsed.limits.partitioned, true);
    assert.equal(Object.keys(parsed.limits.checks_output_cut).length, 8);
    // Every claim keeps its overall verdict (claim-number ranges per verdict).
    const expand = (r) => r.split(",").flatMap((x) => {
      const [a, b] = x.split("-").map(Number);
      return b ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a];
    });
    const back = Object.entries(parsed.claims).flatMap(([verdict, r]) => expand(r).map((c) => [c, verdict])).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(back, max.claims.map((c) => [c.c, c.verdict]));
    assert.match(parsed.problems.at(-1), /more problem\(s\) omitted/);
    assert.doesNotMatch(out, /re-run/);
  });

  it("keeps each claim's lowest confidence when the per-occurrence detail is dropped", () => {
    const s = bigSummary(2, 2, { light: true });
    // Claim 1 occurs in two parts; claim 4 was never evaluated.
    s.occurrences = [
      { c: 1, part: 1, verdict: "verified", confidence: 0.97 },
      { c: 1, part: 2, verdict: "verified", confidence: 0.81 },
      { c: 2, part: 1, verdict: "verified", confidence: 0.99 },
      { c: 3, part: 2, verdict: "verified", confidence: 0.951 },
      { c: 4, part: 2, verdict: "unevaluated", confidence: null },
    ];
    s.claims = [1, 2, 3, 4].map((c) => ({ c, verdict: c === 4 ? "unevaluated" : "verified" }));
    s.limits.unattributed = Array.from({ length: 498 }, (_, i) => `.handoff-verify/run-${i}/report.verify.json`);
    assert.ok(JSON.stringify(s).length > RUN_LIMITS.summaryChars);
    const parsed = JSON.parse(compactSummary(s));
    assert.equal(parsed.occurrences, undefined);
    assert.equal(parsed.occurrences_omitted, 5);
    assert.deepEqual(parsed.claims, [
      { c: 1, verdict: "verified", confidence: 0.81 },
      { c: 2, verdict: "verified", confidence: 0.99 },
      { c: 3, verdict: "verified", confidence: 0.951 },
      { c: 4, verdict: "unevaluated", confidence: null },
    ]);
    // The input is not modified.
    assert.equal(s.claims[0].confidence, undefined);
  });
});

describe("gate runner: the whole batch is evaluated and aggregated (R5)", () => {
  // Three files of ~45 KB: three contiguous 48 KB slices, one part each. b.js
  // straddles slices 1-2 and c.js slices 2-3, so claims 2 and 3 occur in two parts.
  const bigLines = (tag) => Array.from({ length: 600 }, (_, i) => `export const ${tag}${i} = "${"x".repeat(50)}";`).join("\n") + "\n";
  const THREE = {
    request: "regenerate a, b and c",
    claims: [
      { text: "a.js exports a0..a599", evidence: ["file:a.js"] },
      { text: "b.js exports b0..b599", evidence: ["file:b.js"] },
      { text: "c.js exports c0..c599", evidence: ["file:c.js"] },
    ],
  };
  function batchSetup(envExtra = {}) {
    const s = setup({ envExtra: { FAKE_MCP_STATE: join(tempDir("jev-flow-state-"), "s.json"), FAKE_MCP_LOG_STARTS: "1", ...envExtra } });
    writeFiles(s.repo, { "a.js": bigLines("a"), "b.js": bigLines("b"), "c.js": bigLines("c") });
    return s;
  }
  const starts = (log) => readLog(log).filter((r) => r.method === "start").length;
  const verdictsOf = (r) => r.out.parts.map((p) => p.verdict ?? p.state);
  const receiptOf = (s, r) => JSON.parse(readFileSync(join(s.dir, RECEIPTS_DIR, `${r.out.receipt}.json`), "utf8"));

  it("the fixture batch has three parts and claims 2 and 3 occur in two parts each", () => {
    const s = batchSetup();
    const r = s.gate(THREE);
    assert.equal(r.code, 0, r.raw);
    assert.equal(r.out.batch.parts, 3);
    assert.deepEqual(r.out.occurrences.map((o) => [o.c, o.part]), [[1, 1], [2, 1], [2, 2], [3, 2], [3, 3]]);
    assert.deepEqual(r.out.coverage, { planned: 3, sent: 3, evaluated: 3, unavailable: 0, unevaluated: 0 });
    assert.deepEqual([r.out.outcome, r.out.verdict, r.out.status], ["accepted", "accepted", "ok"]);
    const snapshot = computeSnapshot(s.repo).hash;
    const record = loadState(s.dir).gates.at(-1);
    const receipt = receiptOf(s, r);
    assert.deepEqual([receipt.parts, receipt.part_ids, receipt.actions], [3, [1, 2, 3], ["auto", "auto", "auto"]]);
    assert.equal(verifyReceipt(s.dir, r.out.receipt, { session: sessionKey(s.id), req: record.req, boot: record.boot, snapshot }).accepted, true);
    assert.ok(r.raw.length <= RUN_LIMITS.summaryChars);
  });

  it("part 1 escalate still sends parts 2 and 3; one aggregated report, verdict escalate, receipt of the whole batch not accepted", () => {
    const s = batchSetup({ FAKE_MCP_MODES: "escalate,accepted,accepted" });
    const r = s.gate(THREE);
    assert.deepEqual([r.out.outcome, r.code], ["escalate", 2], r.raw);
    assert.deepEqual(toolCalls(s.log).map((c) => [parseBatchLabel(c.args.request).part, c.mode]), [[1, "escalate"], [2, "accepted"], [3, "accepted"]]);
    assert.deepEqual(verdictsOf(r), ["escalate", "accepted", "accepted"]);
    assert.deepEqual([r.out.verdict, r.out.status], ["escalate", "ok"]);
    assert.deepEqual(r.out.parts[0].reason_codes, ["review_escalated"]);
    assert.deepEqual(r.out.coverage, { planned: 3, sent: 3, evaluated: 3, unavailable: 0, unevaluated: 0 });
    assert.deepEqual(r.out.claims, [{ c: 1, verdict: "verified" }, { c: 2, verdict: "verified" }, { c: 3, verdict: "verified" }]);
    assert.equal(r.out.jev_calls, 3);
    const receipt = receiptOf(s, r);
    assert.deepEqual([receipt.actions, receipt.coverage.evaluated, receipt.verdict, receipt.status, receipt.accepted], [["escalate", "auto", "auto"], 3, "escalate", "ok", false]);
    const record = loadState(s.dir).gates.at(-1);
    assert.equal(verifyReceipt(s.dir, r.out.receipt, { session: sessionKey(s.id), req: record.req, snapshot: computeSnapshot(s.repo).hash }).reason, "receipt_not_accepted_escalate");
  });

  it("a contradicted claim stops the batch: in part 1 or in part 2, the rest stays unevaluated and a contradiction is never hidden", () => {
    for (const [modes, sent, parts, claims] of [
      ["contradicted,accepted,accepted", 1, ["contradicted", "unevaluated", "unevaluated"], ["contradicted", "contradicted", "unevaluated"]],
      ["accepted,contradicted,accepted", 2, ["accepted", "contradicted", "unevaluated"], ["verified", "contradicted", "contradicted"]],
    ]) {
      const s = batchSetup({ FAKE_MCP_MODES: modes });
      const r = s.gate(THREE);
      assert.deepEqual([r.out.outcome, r.code, r.out.verdict, r.out.status], ["contradicted", 2, "contradicted", "ok"], modes);
      assert.equal(toolCalls(s.log).length, sent, `${modes}: calls sent`);
      assert.deepEqual(verdictsOf(r), parts, modes);
      assert.ok(r.out.parts.filter((p) => p.state).every((p) => p.reason === "not_sent_after_contradiction"), modes);
      assert.deepEqual(r.out.claims.map((c) => c.verdict), claims, `${modes}: claim 2 (or 3) is contradicted in one part and unevaluated in the next`);
      assert.ok(r.out.occurrences.filter((o) => o.verdict === "unevaluated").every((o) => o.confidence === null), "no confidence is invented");
      assert.deepEqual(r.out.coverage, { planned: 3, sent, evaluated: sent, unavailable: 0, unevaluated: 3 - sent }, modes);
      assert.equal(receiptOf(s, r).actions.length, 3, "the receipt lists every planned part");
    }
  });

  it("the aggregated verdict is the most severe part, whatever the order", () => {
    for (const [modes, verdict] of [
      ["unsupported,escalate,accepted", "escalate"],
      ["accepted,unsupported,escalate", "escalate"],
      ["escalate,unsupported,accepted", "escalate"],
      ["accepted,accepted,unsupported", "needs_evidence"],
      ["unsupported,accepted,accepted", "needs_evidence"],
    ]) {
      const s = batchSetup({ FAKE_MCP_MODES: modes });
      const r = s.gate(THREE);
      assert.deepEqual([r.out.verdict, r.out.outcome, r.code], [verdict, verdict, 2], modes);
      assert.equal(toolCalls(s.log).length, 3, modes);
    }
  });

  it("after a part fails for good, the next part gets one reconnection: recovered, or the rest listed as unevaluated", () => {
    const recovered = batchSetup({ FAKE_MCP_MODES: "tool_error,accepted,accepted" });
    const r = recovered.gate(THREE);
    assert.deepEqual([r.out.outcome, r.code, r.out.verdict, r.out.status], ["unavailable", 3, "accepted", "unavailable"], r.raw);
    assert.equal(r.out.message, "Jev unavailable; gate not evaluated");
    assert.deepEqual(verdictsOf(r), ["unavailable", "accepted", "accepted"]);
    assert.deepEqual([toolCalls(recovered.log).length, starts(recovered.log), r.out.jev_calls, r.out.reconnects], [3, 2, 3, 1]);
    assert.deepEqual(r.out.coverage, { planned: 3, sent: 3, evaluated: 2, unavailable: 1, unevaluated: 0 });
    assert.deepEqual(r.out.claims.map((c) => c.verdict), ["unevaluated", "unevaluated", "verified"]);
    assert.match(r.out.reason, /part 1: tool_error/);

    const dead = batchSetup({ FAKE_MCP_CRASH: "once_then_dead" });
    const d = dead.gate(THREE);
    assert.deepEqual([d.out.outcome, d.code, d.out.verdict, d.out.status], ["unavailable", 3, null, "unavailable"], d.raw);
    assert.deepEqual(verdictsOf(d), ["unavailable", "unevaluated", "unevaluated"]);
    assert.deepEqual(d.out.parts.slice(1).map((p) => p.reason), ["reconnect_failed", "reconnect_failed"]);
    // One tools/call; three starts: the first server, the per-call retry's reconnection, the one reconnection before part 2.
    assert.deepEqual([toolCalls(dead.log).length, starts(dead.log), d.out.jev_calls], [1, 3, 1]);
    assert.match(d.out.reason, /retry not_executed: reconnect failed.*reconnect before part 2 failed/);
    assert.deepEqual(d.out.coverage, { planned: 3, sent: 1, evaluated: 0, unavailable: 1, unevaluated: 2 });
  });

  it("a prepared batch without credentials or with a server that cannot start: a complete, unevaluated report through the same aggregation", () => {
    for (const [label, extra] of [
      ["no credentials", { OPENROUTER_API_KEY: "" }],
      ["server cannot start", { JEV_FLOW_MCP_COMMAND: JSON.stringify(["/nonexistent/jev-mcp-binary"]) }],
    ]) {
      const s = batchSetup(extra);
      const r = s.gate(THREE, check("fine", "0"));
      assert.deepEqual([r.out.outcome, r.code, r.out.verdict, r.out.status], ["unavailable", 3, null, "unavailable"], `${label}: ${r.raw}`);
      assert.equal(r.out.message, "Jev unavailable; gate not evaluated");
      assert.match(r.out.reason, /the jev MCP server could not be used/, label);
      assert.deepEqual(r.out.parts.map((p) => [p.part, p.state, p.reason]), [1, 2, 3].map((n) => [n, "unevaluated", "jev_unavailable"]), label);
      assert.deepEqual(r.out.claims, [{ c: 1, verdict: "unevaluated" }, { c: 2, verdict: "unevaluated" }, { c: 3, verdict: "unevaluated" }], label);
      assert.equal(r.out.occurrences.length, 5, label);
      assert.ok(r.out.occurrences.every((o) => o.verdict === "unevaluated" && o.confidence === null), "no confidence is invented");
      assert.deepEqual(r.out.coverage, { planned: 3, sent: 0, evaluated: 0, unavailable: 0, unevaluated: 3 }, label);
      assert.equal(r.out.jev_calls, 0, label);
      assert.deepEqual(r.out.conditions, ["unavailable"], label);
      assert.equal(toolCalls(s.log).length, 0, `${label}: nothing sent`);
      assert.equal(r.out.checks[0].exit, 0, "the checks still ran");
      const receipt = receiptOf(s, r);
      assert.deepEqual([receipt.actions, receipt.accepted, receipt.outcome], [["unevaluated", "unevaluated", "unevaluated"], false, "unavailable"], label);
      assert.equal(loadState(s.dir).gates.at(-1).failed, true, "no part evaluated: a failed attempt");
    }
  });

  it("unavailable plus a failed check: outcome checks_failed, exit 2, the unavailability still reported", () => {
    const s = batchSetup({ OPENROUTER_API_KEY: "" });
    const r = s.gate(THREE, check("boom", "3"));
    assert.deepEqual([r.out.outcome, r.code, r.out.status, r.out.verdict], ["checks_failed", 2, "checks_failed", null], r.raw);
    assert.deepEqual(r.out.conditions, ["checks_failed", "unavailable"]);
    assert.equal(r.out.message, "Jev unavailable; gate not evaluated");
    assert.equal(r.out.coverage.unevaluated, 3);
    assert.match(r.out.problems.join(" "), /a check failed/);
    assert.equal(receiptOf(s, r).outcome, "checks_failed");
  });

  it("a changed snapshot or a failed check combines with an unfavourable verdict: both are reported, the exit follows the precedence", () => {
    const touched = batchSetup({ FAKE_MCP_MODES: "escalate,accepted,accepted" });
    const t = touched.gate(THREE, [], { FAKE_MCP_TOUCH: join(touched.repo, "touched.txt") });
    assert.deepEqual([t.out.outcome, t.code, t.out.verdict, t.out.status], ["snapshot_changed", 4, "escalate", "snapshot_changed"], t.raw);
    assert.equal(toolCalls(touched.log).length, 3);

    const both = batchSetup({ FAKE_MCP_MODES: "accepted,contradicted,accepted" });
    const b = both.gate(THREE, check("boom", "3"), { FAKE_MCP_TOUCH: join(both.repo, "touched.txt") });
    assert.deepEqual([b.out.outcome, b.code, b.out.verdict, b.out.status], ["contradicted", 2, "contradicted", "snapshot_changed"], b.raw);
    assert.equal(b.out.problems.length, 2, "the changed snapshot and the failed check are both listed");

    const failed = batchSetup({ FAKE_MCP_MODES: "escalate,accepted,accepted" });
    const f = failed.gate(THREE, check("boom", "3"));
    assert.deepEqual([f.out.outcome, f.code, f.out.verdict, f.out.status], ["checks_failed", 2, "escalate", "checks_failed"], f.raw);
    assert.equal(toolCalls(failed.log).length, 3);
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

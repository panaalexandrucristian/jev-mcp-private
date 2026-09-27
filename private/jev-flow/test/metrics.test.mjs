import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { METRICS_CLI, REPO_ROOT, run, tempDir } from "./helpers.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const ts = (sec) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
const MANIFEST = join(REPO_ROOT, "private", "jev-flow", "ab", "tasks.json");
const TASKS = ["M1", "M2", "A1", "A2", "H1", "H2"];

function metrics(args) {
  const result = run("python3", [METRICS_CLI, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/**
 * One Claude session. Calls are [name, input, output, options]; output null
 * leaves the result missing; options.error marks is_error. usage: true (all
 * messages), false (none) or "partial".
 */
function writeClaudeSession(projects, sessionId, calls, { usage = true, child = null, scale = 1, dropUsageField = null } = {}) {
  const dir = join(projects, "-tmp-proj");
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: "user", timestamp: ts(0), message: { role: "user", content: "task" } }];
  calls.forEach(([name, input, output, options = {}], i) => {
    const id = `toolu_${i}`;
    const withUsage = usage === true || (usage === "partial" && i === 0);
    const fullUsage = { input_tokens: 100 * scale, output_tokens: 10 * scale, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (dropUsageField) delete fullUsage[dropUsageField];
    const assistant = {
      type: "assistant",
      timestamp: ts(2 * i + 1),
      message: { id: `msg_${i}`, role: "assistant", content: [{ type: "tool_use", id, name, input }], ...(withUsage ? { usage: fullUsage } : {}) },
    };
    lines.push(assistant, assistant); // duplicated record: usage and calls must be de-duplicated
    if (output !== null) {
      lines.push({ type: "user", timestamp: ts(2 * i + 2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(options.error), content: output }] } });
    }
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (child) {
    const sub = join(dir, sessionId, "subagents");
    mkdirSync(sub, { recursive: true });
    const childLines = [
      { type: "assistant", timestamp: ts(50), message: { id: "c1", content: [{ type: "tool_use", id: "c_t1", name: "Read", input: { file_path: "/r/x.ts" } }], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "user", timestamp: ts(51), message: { content: [{ type: "tool_result", tool_use_id: "c_t1", content: child }] } },
    ];
    writeFileSync(join(sub, "agent-a1.jsonl"), childLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "jev:jev-locator" }));
  }
}

const session = (projects, id) => metrics(["--session", id, "--cli", "claude", "--claude-projects", projects]).metrics;

describe("jev-flow-metrics.py: session metrics", () => {
  it("--help runs", () => {
    const result = run("python3", [METRICS_CLI, "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--runs/);
    assert.match(result.stdout, /--session/);
    assert.match(result.stdout, /--opencode-db/);
  });

  it("measures a complete Claude session tree", () => {
    const projects = tempDir("jev-flow-projects-");
    const readOut = "1\tconst a = 1;\n";
    writeClaudeSession(projects, "sess-1", [
      ["Read", { file_path: "/r/a.ts", offset: 1, limit: 10 }, readOut],
      ["Bash", { command: "cd /r && rg widget" }, "a.ts:1:widget"],
      ["Agent", { subagent_type: "jev:jev-locator", prompt: "p" }, [{ type: "text", text: '{"hits":[]}' }]],
      ["Edit", { file_path: "/r/a.ts" }, "ok"],
      ["Bash", { command: "npm test" }, "pass"],
    ], { child: "child read output" });
    const m = session(projects, "sess-1");
    assert.equal(m.main_exploration_bytes, bytes(readOut) + bytes("a.ts:1:widget") + bytes('{"hits":[]}'));
    assert.deepEqual(m.before_first_edit, { edit_found: true, calls: 3, bytes: m.main_exploration_bytes, exploration_bytes: m.main_exploration_bytes });
    assert.equal(m.tokens.main.input, 500, "usage is de-duplicated by message id");
    assert.deepEqual(m.tokens.descendants, { input: 7, output: 3, cache_read: 0, cache_write: 0, reasoning: 0 });
    assert.deepEqual(m.tokens.jev, { input_tokens: 0, output_tokens: 0 });
    assert.equal(m.total_tool_bytes.descendants, bytes("child read output"));
    assert.deepEqual(m.descendant_agents, ["jev:jev-locator"]);
    assert.equal(m.time.user_wait_seconds, "unknown");
    assert.equal(m.time.wall_seconds, 10);
  });

  it("propagates unknowns: missing outputs, partial usage, missing sessions", () => {
    const projects = tempDir("jev-flow-projects-");
    writeClaudeSession(projects, "missing-out", [["Read", { file_path: "/r/a.ts" }, "x"], ["Read", { file_path: "/r/b.ts" }, null]]);
    const m = session(projects, "missing-out");
    assert.equal(m.main_exploration_bytes, "unknown");
    assert.equal(m.main_exploration_bytes_lower_bound, 1);
    assert.equal(m.total_tool_bytes.main, "unknown");
    assert.equal(m.time.tool_seconds, "unknown");
    writeClaudeSession(projects, "partial-usage", [["Read", { file_path: "/r/a.ts" }, "x"], ["Read", { file_path: "/r/b.ts" }, "y"]], { usage: "partial" });
    assert.equal(session(projects, "partial-usage").tokens.main, "unknown");
    writeClaudeSession(projects, "no-usage", [["Read", { file_path: "/r/a.ts" }, "x"]], { usage: false });
    assert.equal(session(projects, "no-usage").tokens.main, "unknown");
    writeClaudeSession(projects, "missing-field", [["Read", { file_path: "/r/a.ts" }, "x"]], { dropUsageField: "cache_read_input_tokens" });
    assert.equal(session(projects, "missing-field").tokens.main, "unknown", "a missing usage field is unknown, not zero");
    const missing = metrics(["--session", "nope", "--cli", "claude", "--claude-projects", projects]);
    assert.equal(missing.metrics, null);
    assert.equal(missing.error, "session not found");
  });

  it("reports re-reads as unknown without hash evidence and keeps the provenance heuristic separate", () => {
    const projects = tempDir("jev-flow-projects-");
    writeClaudeSession(projects, "rr", [
      ["Read", { file_path: "/r/a.ts", offset: 1, limit: 20 }, "lines 1-20"],
      ["Read", { file_path: "/r/a.ts", offset: 10, limit: 20 }, "lines 10-29"],
      ["Edit", { file_path: "/r/a.ts" }, "ok"],
      ["Read", { file_path: "/r/a.ts", offset: 1, limit: 5 }, "lines 1-5"],
      ["Edit", { file_path: "/r/b.ts" }, "failed", { error: true }],
      ["Read", { file_path: "/r/a.ts", offset: 1, limit: 5 }, "lines 1-5"],
    ]);
    const m = session(projects, "rr");
    assert.equal(m.rereads, "unknown", "transcripts carry no file hash");
    assert.equal(m.rereads_heuristic.inferred_from_provenance, 2, "overlapping read with different output, and a read after an unrelated failed edit");
    assert.equal(m.rereads_heuristic.identical_output_repeats, 1);
    assert.equal(m.rereads_heuristic.indeterminate, 0);
    assert.match(m.rereads_heuristic.basis, /not hash evidence/);
    assert.equal(m.tool_errors, 1);
    writeClaudeSession(projects, "rr-shell", [
      ["Read", { file_path: "/r/a.ts" }, "all"],
      ["Bash", { command: "python3 rewrite.py" }, "done"],
      ["Read", { file_path: "/r/a.ts" }, "all"],
    ]);
    assert.equal(session(projects, "rr-shell").rereads_heuristic.indeterminate, 1);
  });

  it("a failed edit is not the first real modification", () => {
    const projects = tempDir("jev-flow-projects-");
    writeClaudeSession(projects, "fe", [
      ["Read", { file_path: "/r/a.ts" }, "x"],
      ["Edit", { file_path: "/r/a.ts" }, "String not found", { error: true }],
      ["Grep", { pattern: "y" }, "hit"],
      ["Edit", { file_path: "/r/a.ts" }, "ok"],
    ]);
    assert.equal(session(projects, "fe").before_first_edit.calls, 3);
  });
});

describe("jev-flow-metrics.py: OpenCode database", () => {
  const build = `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
full = sys.argv[2] == "full"
conn.execute("create table session_v2 (id text primary key, parent_id text" + (", agent text" if full else "") + ")")
conn.execute("create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)")
if full:
    conn.execute("insert into session_v2 values ('ses_main', null, 'build'), ('ses_child', 'ses_main', 'jev-locator')")
else:
    conn.execute("insert into session_v2 values ('ses_main', null)")
def tool(name, inp, text, t, status="completed"):
    return {"type": "tool", "id": "call_" + name + str(t), "name": name, "state": {"status": status, "input": inp, "content": [{"type": "text", "text": text}]}, "time": {"created": t, "ran": t, "completed": t + 500}}
rows = [
  ("m1", "ses_main", "user", 1, 1000, {"text": "task"}),
  ("m2", "ses_main", "assistant", 2, 2000, {"content": [tool("read", {"filePath": "/r/a.ts"}, "abc", 2000), tool("subagent", {"agent": "jev-locator", "prompt": "p"}, "report", 2500)], "tokens": {"input": 10, "output": 5, "reasoning": 1, "cache": {"read": 2, "write": 0}}}),
  ("m3", "ses_main", "assistant", 3, 9000, {"content": [tool("edit", {"filePath": "/r/a.ts"}, "ok", 9000), tool("jev:jev_gate", {"request": "r"}, json.dumps({"tool": "jev_gate", "action": "auto", "usage": {"input_tokens": 40, "output_tokens": 2}}), 9100)], "tokens": {"input": 20, "output": 5, "reasoning": 0, "cache": {"read": 0, "write": 0}}}),
  ("c1", "ses_child", "assistant", 1, 3000, {"content": [tool("grep", {"pattern": "x"}, "child out", 3000)], "tokens": {"input": 3, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}}}),
]
for r in rows:
    conn.execute("insert into session_message values (?,?,?,?,?,?,?)", (r[0], r[1], r[2], r[3], r[4], r[4], json.dumps(r[5])))
conn.commit()
`;

  it("reads the V2 tables read-only, following child sessions", () => {
    const db = join(tempDir("jev-flow-oc-"), "opencode.db");
    assert.equal(run("python3", ["-c", build, db, "full"]).code, 0);
    const digest = createHash("sha256").update(readFileSync(db)).digest("hex");
    const m = metrics(["--session", "ses_main", "--cli", "opencode", "--opencode-db", db]).metrics;
    assert.equal(m.source, "session_v2");
    assert.equal(m.main_exploration_bytes, bytes("abc") + bytes("report"));
    assert.equal(m.descendant_sessions, 1);
    assert.deepEqual(m.descendant_agents, ["jev-locator"]);
    assert.equal(m.total_tool_bytes.descendants, bytes("child out"));
    assert.deepEqual(m.tokens.main, { input: 30, output: 10, cache_read: 2, cache_write: 0, reasoning: 1 });
    assert.deepEqual(m.tokens.jev, { input_tokens: 40, output_tokens: 2 });
    assert.deepEqual(m.jev_calls, { gate: 1 });
    assert.equal(m.before_first_edit.calls, 2);
    assert.equal(createHash("sha256").update(readFileSync(db)).digest("hex"), digest, "database untouched");
  });

  it("reports a schema with missing columns as unsupported, not as zero", () => {
    const db = join(tempDir("jev-flow-oc-"), "opencode.db");
    assert.equal(run("python3", ["-c", build, db, "partial"]).code, 0);
    const out = metrics(["--session", "ses_main", "--cli", "opencode", "--opencode-db", db]);
    assert.equal(out.metrics, null);
    assert.match(out.error, /unsupported source: session_v2 lacks columns \['agent'\]/);
  });
});

describe("jev-flow-metrics.py: A/B aggregation", () => {
  /** 6 tasks × 2 arms × reps sessions; hooks let a test break one aspect. */
  function abFixture({ reps = 3, oracle = true, bScale = 1, mutateRuns = (r) => r, sessionFor = null, manifest = MANIFEST } = {}) {
    const projects = tempDir("jev-flow-ab-");
    let runs = [];
    for (const task of TASKS) {
      for (const arm of ["A", "B"]) {
        for (let rep = 1; rep <= reps; rep++) {
          const id = `${task}-${arm}-${rep}`;
          const calls = sessionFor?.(task, arm, rep) ?? [["Read", { file_path: "/r/a.ts" }, "x".repeat(arm === "A" ? 1000 : 500)]];
          writeClaudeSession(projects, id, calls, { scale: arm === "B" ? bScale : 1 });
          runs.push({ cli: "claude", session_id: id, arm, task, rep, ...(oracle ? { oracle_pass: true, false_success: false, blocked: false } : {}) });
        }
      }
    }
    runs = mutateRuns(runs);
    const runsPath = join(projects, "runs.json");
    writeFileSync(runsPath, JSON.stringify(runs));
    return metrics(["--runs", runsPath, "--claude-projects", projects, "--manifest", manifest]).clients.claude;
  }

  it("adopts at ≥30% main-context reduction with no quality drop and no total growth", () => {
    const out = abFixture();
    assert.equal(out.median_reduction, 0.5);
    assert.equal(out.pairs.length, 6);
    assert.deepEqual(out.pass_rate, { A: 1, B: 1 });
    assert.equal(out.adoption_criterion, "met");
    assert.equal(out.total_savings, "yes");
    assert.equal(out.verdict, "adopt");
  });

  it("labels a context-only win when model tokens or Jev tokens grow", () => {
    assert.equal(abFixture({ bScale: 3 }).verdict, "main_context_reduction_only");
    const jev = abFixture({
      sessionFor: (task, arm) => [
        ["Read", { file_path: "/r/a.ts" }, "x".repeat(arm === "A" ? 1000 : 500)],
        ...(arm === "B" ? [["mcp__plugin_jev_jev__jev_find", { query: "q" }, JSON.stringify({ tool: "jev_find", usage: { input_tokens: 5000, output_tokens: 10 } })]] : []),
      ],
    });
    assert.equal(jev.total_savings, "no");
    assert.equal(jev.verdict, "main_context_reduction_only");
  });

  it("never reports total savings from unknown tokens", () => {
    const out = abFixture({
      sessionFor: (task, arm) => [
        ["Read", { file_path: "/r/a.ts" }, "x".repeat(arm === "A" ? 1000 : 500)],
        ...(arm === "B" ? [["mcp__plugin_jev_jev__jev_find", { query: "q" }, "not json: usage unknown"]] : []),
      ],
    });
    assert.equal(out.total_savings, "unknown");
    assert.equal(out.verdict, "main_context_reduction_only");
  });

  it("refuses a verdict when primary metrics are incomplete", () => {
    const out = abFixture({
      sessionFor: (task, arm) => (arm === "B" ? [["Read", { file_path: "/r/a.ts" }, null]] : null),
    });
    assert.equal(out.verdict, "insufficient_data");
    assert.ok(out.verdict_reasons.some((r) => /main exploration bytes incomplete/.test(r)));
  });

  it("refuses a verdict with missing, extra or duplicated repetitions", () => {
    assert.equal(abFixture({ reps: 1 }).verdict, "insufficient_data");
    const duplicate = abFixture({ mutateRuns: (runs) => runs.map((r) => (r.task === "M1" && r.arm === "A" ? { ...r, session_id: "M1-A-1" } : r)) });
    assert.equal(duplicate.verdict, "insufficient_data");
    assert.ok(duplicate.verdict_reasons.some((r) => /used by more than one run/.test(r)));
    const extra = abFixture({ mutateRuns: (runs) => [...runs, { ...runs[0], rep: 4, session_id: "M1-A-4" }] });
    assert.equal(extra.verdict, "insufficient_data");
    const slot = abFixture({ mutateRuns: (runs) => runs.map((r) => (r.session_id === "M1-A-2" ? { ...r, rep: 1 } : r)) });
    assert.equal(slot.verdict, "insufficient_data");
    assert.ok(slot.verdict_reasons.some((r) => /duplicate claude\/M1\/A\/rep 1/.test(r)));
  });

  it("refuses a verdict on a reduced, altered or duplicated corpus", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const variant = (mutate) => {
      const copy = structuredClone(manifest);
      mutate(copy);
      const path = join(tempDir(), "tasks.json");
      writeFileSync(path, JSON.stringify(copy));
      return path;
    };
    const reduced = variant((m) => m.tasks.pop());
    const duplicated = variant((m) => (m.tasks[5] = { ...m.tasks[4] }));
    const renamed = variant((m) => (m.tasks[0].id = "X1"));
    const twoReps = variant((m) => (m.repetitions = 2));
    for (const [name, path] of Object.entries({ reduced, duplicated, renamed, twoReps })) {
      const out = abFixture({ manifest: path });
      assert.equal(out.verdict, "insufficient_data", name);
      assert.ok(out.verdict_reasons.includes("manifest missing or invalid"), name);
    }
    const fewerRuns = abFixture({ mutateRuns: (runs) => runs.filter((r) => r.task !== "H2") });
    assert.equal(fewerRuns.verdict, "insufficient_data");
    assert.ok(fewerRuns.verdict_reasons.some((r) => /^H2\/A: repetitions \[\]/.test(r)));
  });

  it("propagates missing usage fields into the totals: no savings claimed", () => {
    const projects = tempDir("jev-flow-ab-");
    const runs = [];
    for (const task of TASKS) {
      for (const arm of ["A", "B"]) {
        for (let rep = 1; rep <= 3; rep++) {
          const id = `${task}-${arm}-${rep}`;
          writeClaudeSession(projects, id, [["Read", { file_path: "/r/a.ts" }, "x".repeat(arm === "A" ? 1000 : 500)]], { dropUsageField: arm === "B" ? "cache_creation_input_tokens" : null });
          runs.push({ cli: "claude", session_id: id, arm, task, rep, oracle_pass: true, false_success: false, blocked: false });
        }
      }
    }
    const runsPath = join(projects, "runs.json");
    writeFileSync(runsPath, JSON.stringify(runs));
    const out = metrics(["--runs", runsPath, "--claude-projects", projects, "--manifest", MANIFEST]).clients.claude;
    assert.equal(out.adoption_criterion, "met");
    assert.equal(out.total_tokens_incl_jev.B, "unknown");
    assert.equal(out.total_savings, "unknown");
    assert.equal(out.verdict, "main_context_reduction_only");
  });

  it("refuses a verdict without a valid manifest or oracle results", () => {
    const badManifest = join(tempDir(), "tasks.json");
    writeFileSync(badManifest, "{}");
    const out = abFixture({ manifest: badManifest });
    assert.equal(out.verdict, "insufficient_data");
    assert.ok(out.verdict_reasons.includes("manifest missing or invalid"));
    const noOracle = abFixture({ oracle: false });
    assert.equal(noOracle.verdict, "insufficient_data");
    assert.deepEqual(noOracle.pass_rate, { A: "unknown", B: "unknown" });
    assert.deepEqual(noOracle.quality.false_success, { A: "unknown", B: "unknown" });
  });

  it("renders markdown", () => {
    const projects = tempDir("jev-flow-ab-");
    writeClaudeSession(projects, "x", [["Read", { file_path: "/r/a.ts" }, "x"]]);
    const runsPath = join(projects, "runs.json");
    writeFileSync(runsPath, JSON.stringify([{ cli: "claude", session_id: "x", arm: "A", task: "M1", rep: 1 }]));
    const result = run("python3", [METRICS_CLI, "--runs", runsPath, "--claude-projects", projects, "--format", "markdown"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /## claude/);
    assert.match(result.stdout, /Verdict: \*\*insufficient_data\*\*/);
  });
});

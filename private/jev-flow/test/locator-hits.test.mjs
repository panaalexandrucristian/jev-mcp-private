import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractLocatorHits, freshHits, readExceedsHits, rememberHits } from "../locator-hits.mjs";
import { setupFlow } from "../opencode.mjs";
import { HOOK_CLI, makeRepo, run, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const BIG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function report(repo, hits) {
  return "Here is what I found:\n```json\n" + JSON.stringify({ coverage_complete: true, hits: hits.map((h) => ({ ...h, sha256: h.sha256 ?? sha(readFileSync(join(repo, h.path))) })), jev_used: "rerank" }) + "\n```";
}

describe("locator hits: parsing and range rules", () => {
  it("extracts hits from fenced JSON, plain JSON and nested tool responses", () => {
    const hits = [{ path: "src/a.kt", sha256: "a".repeat(64), lines: [5, 14], reason: "r" }];
    const fenced = "text\n```json\n" + JSON.stringify({ hits }) + "\n```";
    assert.deepEqual(extractLocatorHits(fenced), [{ path: "src/a.kt", start: 5, end: 14, sha: "a".repeat(64) }]);
    assert.equal(extractLocatorHits(JSON.stringify({ hits })).length, 1);
    assert.equal(extractLocatorHits({ content: [{ type: "text", text: fenced }] }).length, 1);
    assert.deepEqual(extractLocatorHits("no report here"), []);
    assert.deepEqual(extractLocatorHits(JSON.stringify({ hits: [{ path: "x", lines: [9, 3] }] })), [], "invalid ranges are ignored");
  });

  it("allows reads inside the hits widened by 40 lines, and flags whole-file or wider overlapping reads", () => {
    const hits = [{ start: 100, end: 120 }];
    assert.equal(readExceedsHits(hits, { start: 100, end: 120 }), false);
    assert.equal(readExceedsHits(hits, { start: 70, end: 160 }), false, "within the margin");
    assert.equal(readExceedsHits(hits, { start: 1, end: "end", lineCount: 300 }), true, "whole file");
    assert.equal(readExceedsHits(hits, { start: 90, end: 200 }), true, "more than 40 lines beyond");
    assert.equal(readExceedsHits(hits, { start: 1, end: 50 }), false, "no overlap: another area of the file");
    assert.equal(readExceedsHits([{ start: 30, end: 60 }], { start: 1, end: "end", lineCount: 90 }), false, "a small file read whole stays within the margin");
  });

  it("widens and merges hit ranges without covering the gap between distant hits", () => {
    const hits = [{ start: 10, end: 20 }, { start: 1000, end: 1010 }];
    assert.equal(readExceedsHits(hits, { start: 1, end: 1050 }), true, "1–1050 spans the gap 61–959");
    assert.equal(readExceedsHits(hits, { start: 1, end: "end", lineCount: 1050 }), true);
    assert.equal(readExceedsHits(hits, { start: 1, end: 60 }), false, "around the first hit");
    assert.equal(readExceedsHits(hits, { start: 960, end: 1050 }), false, "around the second hit");
    assert.equal(readExceedsHits(hits, { start: 1, end: 100 }), true, "more than 40 lines past the first hit");
    assert.equal(readExceedsHits([{ start: 10, end: 20 }, { start: 90, end: 100 }], { start: 1, end: 140 }), false, "close hits merge into one range");
  });

  it("keeps hits per request and drops a hit whose file changed", () => {
    const list = rememberHits([], [{ path: "a", start: 1, end: 2, sha: "x".repeat(64) }], 1);
    assert.deepEqual(freshHits(list, { path: "a", req: 1, sha: "x".repeat(64) }).fresh.length, 1);
    assert.deepEqual(freshHits(list, { path: "a", req: 2, sha: "x".repeat(64) }).fresh.length, 0, "another request");
    const changed = freshHits(list, { path: "a", req: 1, sha: "y".repeat(64) });
    assert.deepEqual([changed.fresh.length, changed.stale.length], [0, 1]);
  });
});

describe("locator hits: Claude Code hooks (R2)", () => {
  function session() {
    const repo = makeRepo({ "src/Big.kt": BIG, "src/Other.kt": "other\n" });
    const env = sandboxEnv();
    const id = `s-${Math.random().toString(36).slice(2)}`;
    const transcript = join(tempDir("jev-flow-transcript-"), "t.jsonl");
    writeFileSync(transcript, "");
    const call = (event, extra = {}) => {
      const r = run(process.execPath, [HOOK_CLI, event], { env, cwd: repo, input: JSON.stringify({ session_id: id, cwd: repo, transcript_path: transcript, hook_event_name: event, ...extra }) });
      assert.equal(r.code, 0, r.stderr);
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    };
    call("SessionStart", { source: "startup" });
    call("UserPromptSubmit", { prompt: "fix it" });
    const read = (extra = {}) => call("PostToolUse", { tool_name: "Read", tool_input: { file_path: join(repo, "src/Big.kt"), ...extra }, tool_response: {} });
    const text = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
    return { repo, call, read, text };
  }

  it("after a SubagentStop report, hints on every whole-file read and wide read, not on range reads", () => {
    const s = session();
    assert.doesNotMatch(s.text(s.read()), /jev-locator already returned/, "no hits yet");
    assert.equal(s.call("SubagentStop", { agent_id: "a1", agent_type: "jev:jev-locator", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: report(s.repo, [{ path: "src/Big.kt", lines: [100, 120] }]) }), null);
    assert.match(s.text(s.read()), /jev-locator already returned src\/Big\.kt lines 100–120\. Read only those ranges/);
    assert.match(s.text(s.read()), /jev-locator already returned/, "every time, not once per request");
    assert.doesNotMatch(s.text(s.read({ offset: 95, limit: 40 })), /jev-locator already returned/, "a range read within the margin");
    assert.match(s.text(s.read({ offset: 1, limit: 250 })), /jev-locator already returned/);
    assert.doesNotMatch(s.text(s.call("PostToolUse", { tool_name: "Read", tool_input: { file_path: join(s.repo, "src/Other.kt") }, tool_response: {} })), /jev-locator already returned/);
  });

  it("hints on a grep of the hit's file or directory; a changed file drops the hit silently; a new request forgets it", () => {
    const s = session();
    s.call("SubagentStop", { agent_id: "a1", agent_type: "jev-locator", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: report(s.repo, [{ path: "src/Big.kt", lines: [100, 120] }]) });
    assert.match(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", path: join(s.repo, "src") }, tool_response: {} })), /Read those ranges instead of re-searching this area/);
    assert.match(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", path: "src/Big.kt" }, tool_response: {} })), /jev-locator already returned/);
    assert.match(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line" }, tool_response: {} })), /jev-locator already returned/, "no path: the repository root covers the hit");
    assert.match(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", path: s.repo }, tool_response: {} })), /jev-locator already returned/, "the root as path");
    assert.doesNotMatch(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", path: join(s.repo, "lib") }, tool_response: {} })), /jev-locator already returned/, "another directory");
    assert.doesNotMatch(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", glob: "*.ts" }, tool_response: {} })), /jev-locator already returned/, "a glob that excludes the hit");
    assert.match(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", glob: "*.{kt,kts}" }, tool_response: {} })), /jev-locator already returned/, "a glob that keeps it");
    assert.doesNotMatch(s.text(s.call("PostToolUse", { tool_name: "Grep", tool_input: { pattern: "line", type: "py" }, tool_response: {} })), /jev-locator already returned/, "a type that excludes it");
    writeFiles(s.repo, { "src/Big.kt": BIG + "changed\n" });
    assert.doesNotMatch(s.text(s.read()), /jev-locator already returned/, "stale hit");
    s.call("SubagentStop", { agent_id: "a2", agent_type: "jev-locator", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: report(s.repo, [{ path: "src/Big.kt", lines: [100, 120] }]) });
    assert.match(s.text(s.read()), /jev-locator already returned/);
    s.call("UserPromptSubmit", { prompt: "next" });
    assert.doesNotMatch(s.text(s.read()), /jev-locator already returned/, "hits belong to their request");
  });

  it("hints on a read spanning two distant hits (10–20 and 1000–1010, read 1–1050)", () => {
    const repo = makeRepo({ "src/Huge.kt": Array.from({ length: 1100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" });
    const env = sandboxEnv();
    const call = (event, extra = {}) => {
      const r = run(process.execPath, [HOOK_CLI, event], { env, cwd: repo, input: JSON.stringify({ session_id: "s-huge", cwd: repo, hook_event_name: event, ...extra }) });
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    };
    call("SessionStart", { source: "startup" });
    call("UserPromptSubmit", { prompt: "x" });
    call("SubagentStop", { agent_id: "a", agent_type: "jev-locator", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: report(repo, [{ path: "src/Huge.kt", lines: [10, 20] }, { path: "src/Huge.kt", lines: [1000, 1010] }]) });
    const read = (offset, limit) => call("PostToolUse", { tool_name: "Read", tool_input: { file_path: join(repo, "src/Huge.kt"), offset, limit }, tool_response: {} })?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(read(1, 1050), /lines 10–20, 1000–1010/);
    assert.doesNotMatch(read(1, 60), /jev-locator already returned/);
    assert.doesNotMatch(read(970, 60), /jev-locator already returned/);
  });

  it("takes hits from a foreground Agent result too, ignores other agents, and never hints inside a subagent", () => {
    const s = session();
    s.call("PostToolUse", { tool_name: "Agent", tool_input: { subagent_type: "general-purpose" }, tool_response: { content: [{ type: "text", text: report(s.repo, [{ path: "src/Big.kt", lines: [100, 120] }]) }] } });
    assert.doesNotMatch(s.text(s.read()), /jev-locator already returned/);
    s.call("PostToolUse", { tool_name: "Agent", tool_input: { subagent_type: "jev:jev-locator" }, tool_response: { content: [{ type: "text", text: report(s.repo, [{ path: "src/Big.kt", lines: [100, 120] }]) }] } });
    assert.match(s.text(s.read()), /jev-locator already returned/);
    assert.equal(s.call("PostToolUse", { agent_id: "child", tool_name: "Read", tool_input: { file_path: join(s.repo, "src/Big.kt") }, tool_response: {} }), null);
    assert.equal(s.call("SubagentStop", { agent_id: "a3", agent_type: "Explore", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: report(s.repo, [{ path: "src/Other.kt", lines: [1, 1] }]) }), null);
  });
});

describe("locator hits: OpenCode adapter (R2)", () => {
  it("queues the range hint for whole-file reads and greps after a jev-locator task result", async () => {
    const repo = makeRepo({ "src/Big.kt": BIG });
    const hooks = { tool: {}, session: {} };
    const reg = () => ({ dispose: async () => {} });
    const ctx = { location: { directory: repo }, tool: { hook: async (n, cb) => ((hooks.tool[n] = cb), reg()) }, session: { hook: async (n, cb) => ((hooks.session[n] = cb), reg()) } };
    await setupFlow(ctx, { log: () => {}, env: sandboxEnv() });
    await hooks.session.prompt({ sessionID: "o1" });
    const system = () => {
      const input = { sessionID: "o1", system: [] };
      hooks.session.context(input);
      return input.system.map((s) => s.text).join("\n");
    };
    system();
    hooks.tool["execute.after"]({ tool: "task", sessionID: "o1", input: { subagent_type: "jev-locator" }, status: "completed", result: { output: report(repo, [{ path: "src/Big.kt", lines: [100, 120] }]) } });
    hooks.tool["execute.after"]({ tool: "read", sessionID: "o1", input: { filePath: join(repo, "src/Big.kt") }, status: "completed" });
    assert.match(system(), /jev-locator already returned src\/Big\.kt lines 100–120/);
    hooks.tool["execute.after"]({ tool: "read", sessionID: "o1", input: { filePath: join(repo, "src/Big.kt"), offset: 100, limit: 21 }, status: "completed" });
    assert.doesNotMatch(system(), /jev-locator already returned/);
    hooks.tool["execute.after"]({ tool: "grep", sessionID: "o1", input: { pattern: "x", path: join(repo, "src") }, status: "completed" });
    assert.match(system(), /instead of re-searching this area/);
    hooks.tool["execute.after"]({ tool: "grep", sessionID: "o1", input: { pattern: "x" }, status: "completed" });
    assert.match(system(), /instead of re-searching this area/, "no path: the repository root");
    hooks.tool["execute.after"]({ tool: "grep", sessionID: "o1", input: { pattern: "x", include: "*.ts" }, status: "completed" });
    assert.doesNotMatch(system(), /jev-locator already returned/, "an include filter that excludes the hit");
    hooks.tool["execute.after"]({ tool: "read", sessionID: "o1", input: { filePath: join(repo, "src/Big.kt"), offset: 1, limit: 300 }, status: "completed" });
    assert.match(system(), /jev-locator already returned/);
  });
});

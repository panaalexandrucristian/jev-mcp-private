import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIC_DIRECTIVE } from "../check.mjs";
import { composeOutput, handleLogicHook } from "../hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CODE = "Write a Python function that validates an email address.";
const SENTINEL = "SENTINEL-PROMPT-TEXT-DO-NOT-LEAK";

const expected = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: LOGIC_DIRECTIVE } };

describe("handleLogicHook", () => {
  it("adds the exact directive on an enabled code prompt, only on UserPromptSubmit", () => {
    assert.deepEqual(handleLogicHook("UserPromptSubmit", { prompt: CODE }, {}), expected);
    assert.ok(LOGIC_DIRECTIVE.length <= 400);
    for (const event of ["SessionStart", "PostToolUse", "PreToolUse", "Stop", "SessionEnd", undefined]) {
      assert.equal(handleLogicHook(event, { prompt: CODE }, {}), null, String(event));
    }
  });
  it("adds nothing for non-code prompts, a missing or non-string prompt, or when off", () => {
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: "If I double this recipe, how much flour?" }, {}), null);
    for (const input of [undefined, null, {}, { prompt: 42 }, { prompt: ["x"] }]) assert.equal(handleLogicHook("UserPromptSubmit", input, {}), null);
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: CODE }, { JEV_LOGIC_TEST_DEBUG: "off" }), null);
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: CODE }, { JEV_FLOW: "off" }) !== null, true, "JEV_FLOW=off does not disable it");
  });
});

describe("composeOutput", () => {
  it("returns the other output when one side is empty", () => {
    assert.equal(composeOutput(null, null), null);
    assert.equal(composeOutput(undefined, null), null);
    assert.deepEqual(composeOutput(null, expected), expected);
    const existing = { systemMessage: "m" };
    assert.equal(composeOutput(existing, null), existing);
  });
  it("keeps every existing field and joins additionalContext by a newline, without mutating", () => {
    const existing = Object.freeze({
      systemMessage: "note",
      hookSpecificOutput: Object.freeze({ hookEventName: "UserPromptSubmit", additionalContext: "flow context", extra: 1 }),
    });
    const out = composeOutput(existing, expected);
    assert.equal(out.systemMessage, "note");
    assert.equal(out.hookSpecificOutput.extra, 1);
    assert.equal(out.hookSpecificOutput.additionalContext, `flow context\n${LOGIC_DIRECTIVE}`);
    assert.equal(existing.hookSpecificOutput.additionalContext, "flow context");
  });
  it("adds the directive to an output that has only a systemMessage", () => {
    const out = composeOutput({ systemMessage: "tip" }, expected);
    assert.equal(out.systemMessage, "tip");
    assert.equal(out.hookSpecificOutput.additionalContext, LOGIC_DIRECTIVE);
  });
  it("leaves an incompatible existing output unchanged", () => {
    const other = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } };
    assert.equal(composeOutput(other, expected), other);
    const weird = { hookSpecificOutput: "text" };
    assert.equal(composeOutput(weird, expected), weird);
    assert.equal(composeOutput("string", expected), "string");
    const array = [1];
    assert.equal(composeOutput(array, expected), array);
    const badContext = { hookSpecificOutput: { additionalContext: 5 } };
    assert.equal(composeOutput(badContext, expected), badContext);
  });
});

// The real adapter seam (scripts/jev-flow-hook.mjs) in a temporary tree with stubbed existing handlers, so no model,
// network, cache or git state is touched. Stubs prove the seam only; the real suites of those handlers run separately.
describe("scripts/jev-flow-hook.mjs seam (stubbed existing handlers)", () => {
  let tree;
  const stub = (rel, source) => {
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    writeFileSync(join(tree, rel), source);
  };
  const run = (event, input, env = {}, logicDir) => {
    if (logicDir) {
      rmSync(join(tree, "private", "logic-test-debug"), { recursive: true, force: true });
      cpSync(logicDir, join(tree, "private", "logic-test-debug"), { recursive: true });
    }
    const result = spawnSync(process.execPath, [join(tree, "scripts", "jev-flow-hook.mjs"), event], {
      input: JSON.stringify({ hook_event_name: event, ...input }),
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    return { code: result.status, out: result.stdout, err: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const useRealLogic = () => {
    rmSync(join(tree, "private", "logic-test-debug"), { recursive: true, force: true });
    symlinkSync(join(ROOT, "private", "logic-test-debug"), join(tree, "private", "logic-test-debug"), "dir");
  };

  before(() => {
    tree = mkdtempSync(join(tmpdir(), "logic-seam-"));
    cpSync(join(ROOT, "scripts", "jev-flow-hook.mjs"), join(tree, "scripts", "jev-flow-hook.mjs"), { recursive: true });
    stub(
      "private/jev-control/hook.mjs",
      `export function handleControlHook() { return null; }
export function mergeOutputs(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const merged = { ...b, ...a };
  const texts = [a.hookSpecificOutput?.additionalContext, b.hookSpecificOutput?.additionalContext].filter(Boolean);
  if (texts.length) merged.hookSpecificOutput = { ...(b.hookSpecificOutput ?? {}), ...(a.hookSpecificOutput ?? {}), additionalContext: texts.join("\\n") };
  return merged;
}
`,
    );
    stub("private/jev-flow/hook.mjs", `export function handleHook() { return process.env.STUB_FLOW_OUTPUT ? JSON.parse(process.env.STUB_FLOW_OUTPUT) : null; }\n`);
    stub("private/jev-prompt-check/hook.mjs", `export async function handlePromptCheckHook() { return { ran: process.env.STUB_PROMPT_RAN === "1", output: null }; }\n`);
    useRealLogic();
  });
  after(() => rmSync(tree, { recursive: true, force: true }));

  it("emits the exact directive on a code prompt and nothing on a non-code prompt", () => {
    useRealLogic();
    const code = run("UserPromptSubmit", { prompt: CODE });
    assert.equal(code.code, 0);
    assert.deepEqual(code.json, expected);
    const plain = run("UserPromptSubmit", { prompt: "What is a good pancake recipe?" });
    assert.equal(plain.code, 0);
    assert.equal(plain.out, "");
  });
  it("emits nothing for other events or with the switch off", () => {
    assert.equal(run("SessionStart", { prompt: CODE }).out, "");
    assert.equal(run("UserPromptSubmit", { prompt: CODE }, { JEV_LOGIC_TEST_DEBUG: "off" }).out, "");
  });
  it("keeps the existing output and joins its additionalContext", () => {
    const flow = { systemMessage: "kept", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "flow says" } };
    const result = run("UserPromptSubmit", { prompt: CODE }, { STUB_FLOW_OUTPUT: JSON.stringify(flow) });
    assert.equal(result.json.systemMessage, "kept");
    assert.equal(result.json.hookSpecificOutput.additionalContext, `flow says\n${LOGIC_DIRECTIVE}`);
    const nonCode = run("UserPromptSubmit", { prompt: "Fix my CV." }, { STUB_FLOW_OUTPUT: JSON.stringify(flow) });
    assert.deepEqual(nonCode.json, flow, "existing output unchanged on non-code prompts");
  });
  it("keeps the original output, exit code 0 and a neutral diagnostic when the new module fails to load", () => {
    const flow = { systemMessage: "kept" };
    const broken = mkdtempSync(join(tmpdir(), "logic-broken-"));
    writeFileSync(join(broken, "hook.mjs"), `export function handleLogicHook( { this is not valid javascript ${SENTINEL}\n`);
    writeFileSync(join(broken, "check.mjs"), "export {};\n");
    const result = run("UserPromptSubmit", { prompt: `${CODE} ${SENTINEL}` }, { STUB_FLOW_OUTPUT: JSON.stringify(flow) }, broken);
    rmSync(broken, { recursive: true, force: true });
    assert.equal(result.code, 0);
    assert.deepEqual(result.json, flow);
    assert.match(result.err, /\[logic-test-debug\] activation unavailable/);
    assert.ok(!result.err.includes(SENTINEL) && !result.out.includes(SENTINEL), "no prompt or exception text leaks");
  });
  it("keeps the original output when the new handler throws at run time", () => {
    const flow = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "flow says" } };
    const throwing = mkdtempSync(join(tmpdir(), "logic-throw-"));
    writeFileSync(join(throwing, "hook.mjs"), `export function handleLogicHook() { throw new Error("${SENTINEL}"); }\nexport function composeOutput(a) { return a; }\n`);
    const result = run("UserPromptSubmit", { prompt: CODE }, { STUB_FLOW_OUTPUT: JSON.stringify(flow) }, throwing);
    rmSync(throwing, { recursive: true, force: true });
    assert.equal(result.code, 0);
    assert.deepEqual(result.json, flow);
    assert.ok(!result.err.includes(SENTINEL));
    useRealLogic();
  });
  it("still delivers the directive, with exit code 0, after a prompt check that ran (the early-exit path)", () => {
    useRealLogic();
    const flow = { systemMessage: "kept" };
    const result = run("UserPromptSubmit", { prompt: CODE }, { STUB_FLOW_OUTPUT: JSON.stringify(flow), STUB_PROMPT_RAN: "1" });
    assert.equal(result.code, 0);
    assert.equal(result.json.systemMessage, "kept");
    assert.equal(result.json.hookSpecificOutput.additionalContext, LOGIC_DIRECTIVE);
  });
  it("works when the new module is absent (the flow output is untouched)", () => {
    rmSync(join(tree, "private", "logic-test-debug"), { recursive: true, force: true });
    const flow = { systemMessage: "kept" };
    const result = run("UserPromptSubmit", { prompt: CODE }, { STUB_FLOW_OUTPUT: JSON.stringify(flow) });
    assert.equal(result.code, 0);
    assert.deepEqual(result.json, flow);
    useRealLogic();
  });
});

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HINTS } from "../../jev-flow/hook.mjs";
import { HOOK_CLI, makeRepo, run, sandboxEnv, tempDir } from "../../jev-flow/test/helpers.mjs";
import { ambiguityArgs, checkText, readClassification, relatedArgs, runChecks } from "../check.mjs";
import { parseThreshold, runCli } from "../cli.mjs";
import { handlePromptCheckHook } from "../hook.mjs";
import { chooseLanguage, detectLanguage, LANG_SETTINGS } from "../language.mjs";
import { tipLine } from "../messages.mjs";
import { loadState, promptCheckDir, STATE_FILE, withState } from "../state.mjs";
import { lastAssistantText } from "../transcript.mjs";

const CLI_FILE = join(import.meta.dirname, "..", "cli.mjs");
const LONG = "please fix the second one in the list";

const PAIRS = { clear: ["clear", "needs_clarification"], needs_clarification: ["clear", "needs_clarification"], related: ["related", "unrelated"], unrelated: ["related", "unrelated"] };

function classify(classification, p, patch = {}) {
  const ids = PAIRS[classification] ?? ["clear", "needs_clarification"];
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === classification ? p : 1 - p]));
  return { ok: true, result: { tool: "jev_classify", summary: { invalid_response: 0 }, results: [{ id: "prompt", classification, probabilities, top_probability: p, ...patch }] } };
}

/** A stub Jev: `answers` maps the first class id of each call to an outcome (or a function). */
function stub({ ambiguity = classify("clear", 0.99), related = classify("related", 0.99), openResult = null, hang = false } = {}) {
  const calls = [];
  let opened = 0;
  let killed = 0;
  const open = async () => {
    opened += 1;
    if (openResult) return openResult;
    return {
      ok: true,
      client: {
        kill() {
          killed += 1;
        },
        async callTool(name, args, timeoutMs) {
          calls.push({ name, args, timeoutMs });
          if (hang) return new Promise(() => {});
          const first = args.classes[0].id;
          const out = first === "clear" ? ambiguity : related;
          if (out instanceof Error) throw out;
          return out;
        },
      },
    };
  };
  return { open, calls, get opened() { return opened; }, get killed() { return killed; } };
}

function transcriptFile(entries) {
  const path = join(tempDir("pc-transcript-"), "t.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}
const assistant = (content, extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });
const user = (text) => ({ type: "user", message: { role: "user", content: text } });

function setup({ on = true, threshold, lang, seen = 1, entries = [assistant([{ type: "text", text: "I listed 3 files." }])] } = {}) {
  const repo = makeRepo({ "a.txt": "a\n" });
  const env = sandboxEnv();
  const sessionId = `s-${Math.random().toString(36).slice(2)}`;
  const dir = promptCheckDir(repo, sessionId, env);
  if (on) {
    withState(dir, (s) => {
      s.mode = "on";
      s.seen = seen;
      if (threshold !== undefined) s.threshold = threshold;
      if (lang) s.lang = lang;
    });
  }
  const transcript_path = transcriptFile(entries);
  const submit = (prompt, jev, extra = {}) =>
    handlePromptCheckHook("UserPromptSubmit", { session_id: sessionId, cwd: repo, transcript_path, prompt, ...extra }, env, { open: jev.open });
  return { repo, env, sessionId, dir, transcript_path, submit };
}

describe("prompt-check hook: skips make zero Jev calls", () => {
  it("off: nothing is emitted, nothing opened", async () => {
    const t = setup({ on: false });
    const jev = stub();
    const r = await t.submit(LONG, jev);
    assert.deepEqual(r, { output: null, ran: false });
    assert.equal(jev.opened, 0);
    assert.equal(existsSync(join(t.dir, STATE_FILE)), false);
  });

  it("the first prompt of the session is skipped even with an assistant text", async () => {
    const t = setup({ seen: 0 });
    const jev = stub();
    assert.equal((await t.submit(LONG, jev)).output, null);
    assert.equal(jev.opened, 0);
    assert.equal(loadState(t.dir).seen, 1);
    await t.submit(LONG, jev);
    assert.equal(jev.opened, 1);
  });

  it("no previous assistant text (empty, tool-only, missing transcript)", async () => {
    for (const entries of [[], [assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }])], [user("hi there friend")]]) {
      const t = setup({ entries });
      const jev = stub();
      assert.equal((await t.submit(LONG, jev)).output, null);
      assert.equal(jev.opened, 0);
    }
    const t = setup();
    const jev = stub();
    await handlePromptCheckHook("UserPromptSubmit", { session_id: t.sessionId, cwd: t.repo, transcript_path: "/nonexistent/x.jsonl", prompt: LONG }, t.env, { open: jev.open });
    assert.equal(jev.opened, 0);
  });

  it("a prompt shorter than 8 characters and a slash prompt", async () => {
    const t = setup();
    const jev = stub();
    for (const p of ["short", "1234567", "  ok  ", "      a", "/clear everything now", "  /clear everything now", "/jev:jev-done"]) await t.submit(p, jev);
    assert.equal(jev.opened, 0);
    // The length rule applies to the prompt as received (8 characters count, whitespace included).
    await t.submit("12345678", jev);
    assert.equal(jev.opened, 1);
    await t.submit("   ab   ", jev);
    assert.equal(jev.opened, 2);
  });
});

describe("prompt-check: the two checks", () => {
  it("send the exact inputs, classes and auto_accept", async () => {
    const assistantText = "x".repeat(2000) + "END";
    const t = setup({ entries: [assistant([{ type: "text", text: assistantText }])], threshold: 0.93 });
    const jev = stub();
    const prompt = "p".repeat(1600);
    await t.submit(prompt, jev);
    assert.equal(jev.calls.length, 2);
    const text = `ASSISTANT (previous): ${assistantText.slice(-1500)}\nUSER: ${prompt.slice(0, 1500)}`;
    assert.equal(checkText(assistantText, prompt), text);
    const amb = jev.calls.find((c) => c.args.classes[0].id === "clear").args;
    const rel = jev.calls.find((c) => c.args.classes[0].id === "related").args;
    assert.equal(amb.items[0].text, text);
    assert.equal(amb.auto_accept, 0.93);
    assert.match(amb.purpose, /^Binary check: would a coding agent that sees only the previous assistant message and this user prompt need to ask a clarifying question\?$/);
    assert.deepEqual(amb.classes.map((c) => c.id), ["clear", "needs_clarification"]);
    assert.deepEqual(rel.classes.map((c) => c.id), ["related", "unrelated"]);
    assert.equal(rel.auto_accept, undefined);
    assert.equal(rel.items[0].text, text);
    assert.equal(ambiguityArgs("t", 0.9).auto_accept, 0.9);
    assert.equal(relatedArgs("t").items.length, 1);
  });

  it("ambiguity tip exactly at the threshold, none just below", async () => {
    const t = setup({ threshold: 0.9 });
    const at = await t.submit(LONG, stub({ ambiguity: classify("needs_clarification", 0.9) }));
    assert.equal(at.output.systemMessage, tipLine("en", "ambiguity", 0.9));
    assert.match(at.output.systemMessage, /^prompt-check: this prompt may be unclear \(Jev 90% sure\): a target or scope may be missing\.$/);
    const below = await t.submit(LONG, stub({ ambiguity: classify("needs_clarification", 0.8999) }));
    assert.equal(below.output, null);
  });

  it("relatedness tip exactly at the threshold, none just below", async () => {
    const t = setup({ threshold: 0.9 });
    const at = await t.submit(LONG, stub({ related: classify("unrelated", 0.9) }));
    assert.equal(at.output.systemMessage, "prompt-check: this prompt does not look related to the last reply (Jev 90% sure); if it is a new topic, consider /clear.");
    assert.equal((await t.submit(LONG, stub({ related: classify("unrelated", 0.8999) }))).output, null);
  });

  it("clear and related winners never give a tip", async () => {
    const t = setup({ threshold: 0.6 });
    assert.equal((await t.submit(LONG, stub({ ambiguity: classify("clear", 0.99), related: classify("related", 0.99) }))).output, null);
  });

  it("both tips together, two lines, Romanian and English", async () => {
    const both = { ambiguity: classify("needs_clarification", 0.96), related: classify("unrelated", 0.91) };
    const en = setup();
    const out = (await en.submit(LONG, stub(both))).output;
    assert.deepEqual(Object.keys(out), ["systemMessage"]);
    assert.deepEqual(out.systemMessage.split("\n"), [tipLine("en", "ambiguity", 0.96), tipLine("en", "unrelated", 0.91)]);
    assert.match(out.systemMessage, /96%[\s\S]*91%/);
    const ro = setup({ lang: "ro" });
    const roOut = (await ro.submit(LONG, stub(both))).output.systemMessage;
    assert.deepEqual(roOut.split("\n"), [tipLine("ro", "ambiguity", 0.96), tipLine("ro", "unrelated", 0.91)]);
    assert.match(roOut, /^prompt-check: acest prompt ar putea fi neclar \(Jev este sigur în proporție de 96%\)/);
    assert.match(roOut, /nu pare legat de ultimul răspuns/);
  });

  it("auto: each prompt gets the tips in its own language within one session", async () => {
    const both = { ambiguity: classify("needs_clarification", 0.96), related: classify("unrelated", 0.91) };
    const t = setup();
    assert.equal(loadState(t.dir).lang, "auto");
    const en = (await t.submit("please fix the second one in the list", stub(both))).output.systemMessage;
    assert.deepEqual(en.split("\n"), [tipLine("en", "ambiguity", 0.96), tipLine("en", "unrelated", 0.91)]);
    const ro = (await t.submit("repară-l pe al doilea din listă", stub(both))).output.systemMessage;
    assert.deepEqual(ro.split("\n"), [tipLine("ro", "ambiguity", 0.96), tipLine("ro", "unrelated", 0.91)]);
    const roPlain = (await t.submit("fa un commit si push pentru asta", stub(both))).output.systemMessage;
    assert.deepEqual(roPlain.split("\n"), [tipLine("ro", "ambiguity", 0.96), tipLine("ro", "unrelated", 0.91)]);
    assert.equal(loadState(t.dir).lang, "auto");
  });

  it("auto: an undecidable prompt follows the previous reply, then English; a forced language wins", async () => {
    const both = { ambiguity: classify("needs_clarification", 0.96), related: classify("unrelated", 0.91) };
    const roReply = setup({ entries: [assistant([{ type: "text", text: "Am listat trei fișiere și nu am găsit nimic pentru asta." }])] });
    assert.match((await roReply.submit("git status --short", stub(both))).output.systemMessage, /^prompt-check: acest prompt/);
    const enReply = setup({ entries: [assistant([{ type: "text", text: "I listed the files and found nothing for this." }])] });
    assert.match((await enReply.submit("git status --short", stub(both))).output.systemMessage, /^prompt-check: this prompt/);
    const none = setup();
    assert.match((await none.submit("git status --short", stub(both))).output.systemMessage, /^prompt-check: this prompt/);
    const forcedEn = setup({ lang: "en", entries: [assistant([{ type: "text", text: "Am listat fișierele." }])] });
    assert.match((await forcedEn.submit("repară-l pe al doilea din listă", stub(both))).output.systemMessage, /^prompt-check: this prompt/);
    const forcedRo = setup({ lang: "ro" });
    assert.match((await forcedRo.submit("please fix the second one in the list", stub(both))).output.systemMessage, /^prompt-check: acest prompt/);
  });

  it("errors, invalid responses, unavailable Jev and thrown calls stay silent", async () => {
    const bad = [
      stub({ ambiguity: { ok: false, kind: "transport", message: "boom" } }),
      stub({ related: { ok: false, kind: "tool_error", message: "boom" } }),
      stub({ ambiguity: { ok: true, result: { tool: "jev_classify", results: [{ id: "prompt", status: "invalid_response", classification: null, top_probability: undefined }] } } }),
      stub({ related: classify("unrelated", Number.NaN) }),
      stub({ related: classify("other", 0.99) }),
      stub({ related: { ok: true, result: { ...classify("unrelated", 0.99).result, tool: "jev_verify" } } }),
      stub({ related: classify("unrelated", 0.99, { id: "other-item" }) }),
      stub({ related: { ok: true, result: { ...classify("unrelated", 0.99).result, status: "invalid_response" } } }),
      stub({ related: { ok: true, result: { ...classify("unrelated", 0.99).result, summary: { invalid_response: 1 } } } }),
      stub({ related: { ok: true, result: { ...classify("unrelated", 0.99).result, results: [] } } }),
      stub({ related: classify("unrelated", 0.99, { probabilities: undefined }) }),
      stub({ related: classify("unrelated", 0.99, { probabilities: { related: 0.99, unrelated: 0.99 } }) }),
      stub({ related: classify("unrelated", 0.99, { probabilities: { related: 0.01 } }) }),
      stub({ ambiguity: classify("needs_clarification", 0.99, { top_probability: 0.95 }) }),
      stub({ ambiguity: new Error("throws") }),
      stub({ openResult: { ok: false, unavailable: true, reason: "no Jev credentials in the environment" } }),
      stub({ openResult: { ok: false, config: true, reason: "x" } }),
    ];
    for (const jev of bad) {
      // One valid tip-worthy answer must not leak when the other check is invalid.
      const t = setup();
      const r = await t.submit(LONG, jev);
      assert.equal(r.output, null);
    }
    const t = setup();
    const mixed = stub({ ambiguity: { ok: false, kind: "transport", message: "x" }, related: classify("unrelated", 0.99) });
    assert.equal((await t.submit(LONG, mixed)).output, null);
  });

  it("a hanging Jev ends at the deadline, kills the child and stays silent", async () => {
    const jev = stub({ hang: true });
    const started = Date.now();
    const r = await runChecks({ assistant: "a reply", prompt: LONG, threshold: 0.9, lang: "en", open: jev.open, deadlineMs: 150 });
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(r.tips, []);
    assert.equal(r.reason, "timeout");
    assert.equal(jev.killed, 1);
    assert.equal(r.dispatched, true);
  });

  it("a slow connection counts against the same deadline and the late child is killed", async () => {
    let killed = 0;
    const open = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, client: { kill: () => killed++, callTool: async () => classify("clear", 1) } }), 120));
    const r = await runChecks({ assistant: "a", prompt: LONG, threshold: 0.9, lang: "en", open, deadlineMs: 40 });
    assert.equal(r.reason, "timeout");
    assert.equal(r.dispatched, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(killed, 1);
  });

  it("the deadline starts at the entry of the enabled branch, so earlier delay counts", async () => {
    const jev = stub();
    const r = await runChecks({ assistant: "a", prompt: LONG, threshold: 0.9, lang: "en", open: jev.open, deadlineMs: 100, startedAt: Date.now() - 500 });
    assert.equal(r.reason, "timeout");
    assert.equal(jev.opened, 0);
    const slow = stub({ hang: true });
    const started = Date.now();
    const r2 = await runChecks({ assistant: "a", prompt: LONG, threshold: 0.9, lang: "en", open: slow.open, deadlineMs: 300, startedAt: Date.now() - 200 });
    assert.equal(r2.reason, "timeout");
    assert.ok(Date.now() - started < 250);
    assert.equal(slow.killed, 1);
  });

  it("the hook passes its entry time: slow transcript work leaves less than the full budget", async () => {
    const t = setup();
    let seenStart = null;
    const before = Date.now();
    await handlePromptCheckHook("UserPromptSubmit", { session_id: t.sessionId, cwd: t.repo, transcript_path: t.transcript_path, prompt: LONG }, t.env, {
      lastAssistantText: () => {
        const until = Date.now() + 60;
        while (Date.now() < until);
        return "a reply";
      },
      runChecks: async (args) => {
        seenStart = args.startedAt;
        return { tips: [], dispatched: false };
      },
    });
    assert.ok(seenStart >= before && Date.now() - seenStart >= 60);
  });

  it("readClassification validates the shape", () => {
    assert.deepEqual(readClassification(classify("clear", 0.5), ["clear", "needs_clarification"]), { winner: "clear", p: 0.5 });
    assert.equal(readClassification(classify("clear", 1.5), ["clear", "needs_clarification"]), null);
    assert.equal(readClassification(null, ["clear"]), null);
    assert.equal(readClassification({ ok: true, result: { results: [] } }, ["clear"]), null);
  });
});

describe("prompt-check: output and counters", () => {
  it("emits valid JSON with systemMessage only, never block or additionalContext", async () => {
    const t = setup();
    const r = await t.submit(LONG, stub({ ambiguity: classify("needs_clarification", 0.99), related: classify("unrelated", 0.99) }));
    const parsed = JSON.parse(JSON.stringify(r.output));
    assert.deepEqual(Object.keys(parsed), ["systemMessage"]);
    for (const key of ["decision", "hookSpecificOutput", "additionalContext", "reason"]) assert.equal(key in parsed, false);
    assert.equal(r.ran, true);
  });

  it("counts checked prompts and tips, numbers only", async () => {
    const t = setup();
    await t.submit(LONG, stub());
    await t.submit(LONG, stub({ ambiguity: classify("needs_clarification", 0.95), related: classify("unrelated", 0.95) }));
    await t.submit(LONG, stub({ ambiguity: { ok: false, kind: "transport", message: "x" } }));
    await t.submit(LONG, stub({ openResult: { ok: false, unavailable: true, reason: "r" } }));
    const state = loadState(t.dir);
    assert.equal(state.checked, 3);
    assert.equal(state.tips, 2);
    const raw = readFileSync(join(t.dir, STATE_FILE), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["checked", "lang", "mode", "seen", "threshold", "tips", "v"]);
    assert.equal(raw.includes("listed"), false);
    assert.equal(raw.includes(LONG), false);
  });

  it("writes at most one stderr line per failure and none of the prompt", async () => {
    const t = setup();
    const lines = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
    try {
      await t.submit(LONG, stub({ ambiguity: { ok: false, kind: "transport", message: LONG } }));
    } finally {
      process.stderr.write = original;
    }
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes(LONG), false);
  });
});

describe("prompt-check: transcript parsing", () => {
  it("takes the last assistant message with text, skipping tool-only turns and sidechains", () => {
    const path = transcriptFile([
      assistant([{ type: "text", text: "older reply" }]),
      assistant([{ type: "text", text: "sidechain text" }], { isSidechain: true }),
      assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
      user("next"),
    ]);
    assert.equal(lastAssistantText(path), "older reply");
  });

  it("joins several text blocks and ignores thinking and tool blocks", () => {
    const path = transcriptFile([
      assistant([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "first part" },
        { type: "tool_use", id: "t", name: "Read", input: {} },
        { type: "text", text: "second part" },
        { type: "text", text: "   " },
      ]),
    ]);
    assert.equal(lastAssistantText(path), "first part\nsecond part");
  });

  it("joins the lines of one message (same id) and not other messages", () => {
    const m = (id, content) => ({ type: "assistant", message: { id, role: "assistant", content } });
    const path = transcriptFile([
      m("m1", [{ type: "text", text: "old" }]),
      user("u"),
      m("m2", [{ type: "text", text: "part one" }]),
      m("m2", [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
      m("m2", [{ type: "text", text: "part two" }]),
      m("m2", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    ]);
    assert.equal(lastAssistantText(path), "part one\npart two");
  });

  it("string content, bad lines and missing files", () => {
    const path = join(tempDir("pc-t-"), "t.jsonl");
    writeFileSync(path, `not json\n${JSON.stringify(assistant("plain text"))}\n{"partial":`);
    assert.equal(lastAssistantText(path), "plain text");
    assert.equal(lastAssistantText(join(tempDir("pc-t-"), "none.jsonl")), null);
    assert.equal(lastAssistantText(undefined), null);
  });
});

describe("prompt-check: CLI and session lifecycle", () => {
  function cliEnv() {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv({ CLAUDE_CODE_SESSION_ID: "cli-session" });
    return { repo, env, run: (...args) => runCli(args, env, repo) };
  }

  it("defaults: off, 0.9, auto, zero counters", () => {
    const c = cliEnv();
    assert.deepEqual(c.run("status").lines, ["prompt-check: off, threshold 0.9, language auto, 0 prompts checked, 0 tips shown"]);
  });

  it("on, threshold, lang, off and status", () => {
    const c = cliEnv();
    assert.match(c.run("on").lines.at(-1), /^prompt-check: on, threshold 0.9, language auto/);
    assert.match(c.run("on", "0.95").lines.at(-1), /on, threshold 0.95/);
    assert.match(c.run("threshold", "0.7").lines.at(-1), /on, threshold 0.7/);
    assert.match(c.run("lang", "ro").lines.at(-1), /language ro/);
    assert.match(c.run("off").lines.at(-1), /^prompt-check: off, threshold 0.7, language ro/);
  });

  it("an invalid threshold keeps the old value and prints one notice", () => {
    const c = cliEnv();
    c.run("on", "0.8");
    for (const bad of ["0.5", "1", "0", "1.2", "abc", "", "-0.9", "0.9x"]) {
      const out = c.run("threshold", bad);
      assert.equal(out.lines.length, 2, bad);
      assert.match(out.lines[0], /invalid threshold/);
      assert.match(out.lines[1], /threshold 0.8,/);
    }
    const onBad = c.run("on", "2");
    assert.equal(onBad.lines.length, 2);
    assert.match(onBad.lines[1], /^prompt-check: on, threshold 0.8/);
    assert.equal(parseThreshold("0.51"), 0.51);
    assert.equal(parseThreshold(".9"), 0.9);
    assert.equal(parseThreshold("0.999"), 0.999);
  });

  it("an unknown language keeps the old one with one notice; auto, ro and en are accepted", () => {
    const c = cliEnv();
    const out = c.run("lang", "fr");
    assert.equal(out.lines.length, 2);
    assert.match(out.lines[0], /use auto, ro or en/);
    assert.match(out.lines[1], /language auto/);
    for (const lang of ["en", "ro", "auto"]) assert.match(c.run("lang", lang).lines.at(-1), new RegExp(`language ${lang},`));
    assert.deepEqual(LANG_SETTINGS, ["auto", "ro", "en"]);
  });

  it("status shows the counters; on makes the next prompt not the first", async () => {
    const c = cliEnv();
    c.run("on");
    const dir = promptCheckDir(c.repo, "cli-session", c.env);
    assert.equal(loadState(dir).seen, 1);
    withState(dir, (s) => {
      s.checked = 7;
      s.tips = 2;
    });
    assert.match(c.run("status").lines[0], /7 prompts checked, 2 tips shown/);
  });

  it("refuses without a verifiable session identity and changes nothing", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv();
    const out = runCli(["on"], env, repo);
    assert.equal(out.code, 1);
    assert.match(out.lines[0], /no verifiable session identity/);
    assert.equal(runCli(["on", "--session-cap", "deadbeefdeadbeef.00000000000000000000000000000000"], env, repo).code, 1);
  });

  it("the capability handed over by the hook for the command identifies the session", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv();
    const input = { session_id: "cap-session", cwd: repo, prompt: "/jev:prompt-check on" };
    const r = await handlePromptCheckHook("UserPromptSubmit", input, env);
    const cap = /--session-cap (\S+)/.exec(r.output.hookSpecificOutput.additionalContext)[1];
    const out = runCli(["on", "--session-cap", cap], env, repo);
    assert.match(out.lines[0], /prompt-check: on/);
    assert.equal(loadState(promptCheckDir(repo, "cap-session", env)).mode, "on");
    // The same capability cannot reach another session's state.
    assert.equal(loadState(promptCheckDir(repo, "other-session", env)).mode, "off");
  });

  it("state is per session and resets at startup, resume, clear and end but not compact", async () => {
    const t = setup();
    const base = { session_id: t.sessionId, cwd: t.repo };
    assert.equal(loadState(promptCheckDir(t.repo, "someone-else", t.env)).mode, "off");
    await handlePromptCheckHook("SessionStart", { ...base, source: "compact" }, t.env);
    assert.equal(loadState(t.dir).mode, "on");
    for (const source of ["startup", "resume", "clear", undefined]) {
      withState(t.dir, (s) => {
        s.mode = "on";
        s.checked = 4;
      });
      await handlePromptCheckHook("SessionStart", { ...base, source }, t.env);
      assert.deepEqual(loadState(t.dir), { v: 1, mode: "off", threshold: 0.9, lang: "auto", seen: 0, checked: 0, tips: 0 });
    }
    withState(t.dir, (s) => {
      s.mode = "on";
    });
    await handlePromptCheckHook("SessionEnd", base, t.env);
    assert.equal(loadState(t.dir).mode, "off");
  });

  it("the CLI file runs as a process", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv({ CLAUDE_CODE_SESSION_ID: "proc-session" });
    const r = run(process.execPath, [CLI_FILE, "status"], { env, cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /prompt-check: off/);
  });
});

describe("prompt-check: adapter and the existing jev-flow output", () => {
  function hook(event, input, env) {
    const r = run(process.execPath, [HOOK_CLI, event], { env, input: JSON.stringify(input), cwd: input.cwd });
    assert.equal(r.code, 0, r.stderr);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  it("the jev-flow UserPromptSubmit output is unchanged when prompt-check is off", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv();
    const input = { session_id: "flow-off", cwd: repo, hook_event_name: "UserPromptSubmit", prompt: "fix the crash in the settings screen" };
    const out = hook("UserPromptSubmit", input, env);
    assert.equal(out.stderr, "");
    assert.deepEqual(JSON.parse(out.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: HINTS.directive() } });
  });

  it("with the mode on but no Jev credentials the prompt gets no tip, no stderr noise beyond one line, exit 0", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv({ JEV_FLOW: "off" });
    const sessionId = "flow-on";
    const transcript = transcriptFile([assistant([{ type: "text", text: "done" }])]);
    withState(promptCheckDir(repo, sessionId, env), (s) => {
      s.mode = "on";
      s.seen = 1;
    });
    const out = hook("UserPromptSubmit", { session_id: sessionId, cwd: repo, transcript_path: transcript, hook_event_name: "UserPromptSubmit", prompt: LONG }, env);
    assert.equal(out.stdout, "");
    assert.ok(out.stderr.split("\n").filter(Boolean).length <= 1);
  });

  it("the command prompt gets the capability line, other prompts none", () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const env = sandboxEnv({ JEV_FLOW: "off" });
    const out = hook("UserPromptSubmit", { session_id: "flow-cmd", cwd: repo, hook_event_name: "UserPromptSubmit", prompt: "/jev:prompt-check status" }, env);
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /Session capability: pass --session-cap [0-9a-f]{16}\.[0-9a-f]{32}/);
  });
});

describe("prompt-check language detection", () => {
  it("Romanian with and without diacritics, also mixed with English technical words", () => {
    for (const text of ["rulează testele pentru jev", "ruleaza testele pentru jev", "fa un commit si push", "nu stiu cum sa fac asta", "Șterge fișierul", "ŞTERGE FIŞIERUL", "ț"]) {
      assert.equal(detectLanguage(text), "ro", text);
    }
    assert.equal(detectLanguage("e\u0103".normalize("NFD")), "ro");
  });

  it("English", () => {
    for (const text of ["run the tests please", "What does this do?", "Why only 0.61?", "Please fix the bug in the parser", "I want to delete the file"]) {
      assert.equal(detectLanguage(text), "en", text);
    }
  });

  it("no clear signal gives null", () => {
    for (const text of ["", "ok", "git status", "12345", "{ }", "Ana are mere", null, undefined, 42]) {
      assert.equal(detectLanguage(text), null, String(text));
    }
  });

  it("chooseLanguage: forced setting, then the prompt, then the reply, then English", () => {
    assert.equal(chooseLanguage("ro", "run the tests please", "x"), "ro");
    assert.equal(chooseLanguage("en", "rulează testele", "x"), "en");
    assert.equal(chooseLanguage("auto", "rulează testele", "I listed the files"), "ro");
    assert.equal(chooseLanguage("auto", "git status", "Am rulat testele si au trecut"), "ro");
    assert.equal(chooseLanguage("auto", "git status", "git status"), "en");
    assert.equal(chooseLanguage(undefined, "rulează testele", ""), "ro");
  });
});

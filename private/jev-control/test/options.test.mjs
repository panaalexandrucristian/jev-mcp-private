import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_ID, GATHER_ID, normalizeBatch, optionActionHash, optionHash } from "../options.mjs";
import { batchOf } from "./helpers.mjs";

const problemsOf = (raw) => {
  const r = normalizeBatch(raw);
  return r.ok ? [] : r.problems;
};

describe("option batches (D6)", () => {
  it("accepts five real options and adds the two control options", () => {
    const r = normalizeBatch(batchOf(5));
    assert.equal(r.ok, true);
    assert.deepEqual(r.batch.options.map((o) => o.id).slice(-2), [GATHER_ID, ASK_ID]);
    assert.equal(r.batch.options.length, 7);
    assert.equal(r.batch.options.filter((o) => o.control).length, 2);
  });
  it("requires five options unless the space is declared small", () => {
    assert.match(problemsOf(batchOf(4)).join(" "), /at least 5/);
    assert.equal(normalizeBatch(batchOf(2, { extra: { space_small: true } })).ok, true);
  });
  it("allows at most 20 options including the control options", () => {
    assert.equal(normalizeBatch(batchOf(18)).ok, true);
    assert.match(problemsOf(batchOf(19)).join(" "), /at most 20/);
  });
  it("requires 1-3 concrete evidence lines per option", () => {
    const none = batchOf(5);
    none.options[0].evidence = [];
    assert.match(problemsOf(none).join(" "), /evidence must have 1-3/);
    const four = batchOf(5);
    four.options[0].evidence = ["a", "b", "c", "d"];
    assert.match(problemsOf(four).join(" "), /evidence must have 1-3/);
  });
  it("refuses ids that collide with jev_decide's escape hatches", () => {
    for (const id of ["ask_user", "investigate", "none"]) {
      const b = batchOf(5);
      b.options[0].id = id;
      assert.match(problemsOf(b).join(" "), /collides with a jev_decide escape hatch/, id);
    }
  });
  it("refuses bad ids, repeated ids, a bad kind and a missing decision", () => {
    const b = batchOf(5);
    b.options[1].id = "Bad Id";
    assert.match(problemsOf(b).join(" "), /lowercase slug/);
    // Words of a-z and 0-9 joined by single separators: a trailing or doubled one would let text naming the id name its prefix.
    for (const id of ["edit_a-", "edit_a_", "edit__a", "edit_a--", "edit--a", "-edit_a", "_edit_a", "1edit", "edit_"]) {
      const bad = batchOf(5);
      bad.options[1].id = id;
      assert.match(problemsOf(bad).join(" "), /lowercase slug: a-z and 0-9 words joined by single _ or -/, id);
    }
    for (const id of ["edit_a", "edit-a", "o1", "edit_a_b", "a", "o10"]) {
      const good = batchOf(5);
      good.options[1].id = id;
      assert.doesNotMatch(problemsOf(good).join(" "), /lowercase slug/, id);
    }
    const d = batchOf(5);
    d.options[1].id = "o1";
    d.options[1].text = "another text";
    assert.match(problemsOf(d).join(" "), /repeated/);
    assert.match(problemsOf({ ...batchOf(5), kind: "nope" }).join(" "), /kind must be one of/);
    assert.match(problemsOf({ ...batchOf(5), decision: " " }).join(" "), /decision/);
  });
  it("merges duplicates, keeping the first id and the evidence of both", () => {
    const b = batchOf(6);
    b.options[5].text = "  option NUMBER 1 ";
    b.options[5].evidence = ["extra"];
    const r = normalizeBatch(b);
    assert.equal(r.ok, true);
    const first = r.batch.options[0];
    assert.deepEqual(first.merged, ["o6"]);
    assert.ok(first.evidence.includes("extra"));
    assert.equal(r.batch.options.filter((o) => !o.control).length, 5);
  });
  it("keeps a model-supplied control option as the control option, once", () => {
    const b = batchOf(5);
    b.options.push({ id: ASK_ID, text: "Ask the user", evidence: ["only the user can say"] });
    const r = normalizeBatch(b);
    assert.equal(r.ok, true);
    assert.equal(r.batch.options.filter((o) => o.id === ASK_ID).length, 1);
  });
  it("hashes an option by normalized text and evidence", () => {
    const a = { text: "Fix  it", evidence: ["Line"] };
    const b = { text: "fix it", evidence: ["line"] };
    assert.equal(optionHash(a), optionHash(b));
    assert.notEqual(optionHash(a), optionHash({ text: "fix it", evidence: ["other"] }));
  });
});

describe("concrete actions and preconditions are kept, not dropped", () => {
  it("keeps the normalized action descriptor and the preconditions of every option", () => {
    const b = batchOf(5, { kind: "command" });
    b.options[0].action = { tool: "Bash", target: "  npm   test " };
    b.options[0].preconditions = [{ kind: "path_exists", path: "./package.json" }, { kind: "path_sha256", path: "src/a.js", sha256: "a".repeat(64) }];
    const r = normalizeBatch(b);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    const first = r.batch.options[0];
    assert.deepEqual({ tool: first.action.tool, target: first.action.target, args: first.action.args }, { tool: "Bash", target: "npm   test", args: {} }, "a command is kept exactly (only its ends are trimmed): whitespace inside it can change what it does");
    assert.deepEqual(first.preconditions, [{ kind: "path_exists", path: "package.json" }, { kind: "path_sha256", path: "src/a.js", sha256: "a".repeat(64) }]);
    assert.deepEqual(r.batch.options.find((o) => o.id === ASK_ID).action, { tool: "AskUserQuestion", target: "", args: {}, view: {} });
    assert.equal(r.batch.options.find((o) => o.id === GATHER_ID).action, null);
  });
  it("makes absolute paths relative to the repository root", () => {
    const b = batchOf(5, { kind: "edit" });
    b.options[0].action = { tool: "Edit", target: "/repo/src/a.js", old_string: "a", new_string: "b" };
    const r = normalizeBatch(b, { root: "/repo" });
    assert.equal(r.batch.options[0].action.target, "src/a.js");
  });
  it("kinds whose options are actions require the descriptor, with the right tool", () => {
    for (const kind of ["order", "command", "edit", "delegate"]) {
      const b = batchOf(5, { kind });
      delete b.options[2].action;
      assert.match(problemsOf(b).join(" "), /action is required/, kind);
    }
    const wrong = batchOf(5, { kind: "command" });
    wrong.options[0].action = { tool: "Write", target: "a.js", content: "x" };
    assert.match(problemsOf(wrong).join(" "), /must be Bash/);
    const edit = batchOf(5, { kind: "edit" });
    edit.options[0].action = { tool: "Bash", target: "sed -i x a.js" };
    assert.match(problemsOf(edit).join(" "), /must be Edit or Write/);
    assert.equal(normalizeBatch(batchOf(5, { kind: "approach" })).ok, true, "a strategy names no single action");
  });
  it("refuses a malformed descriptor, an unknown tool, a control step and bad preconditions", () => {
    const mk = (patch) => {
      const b = batchOf(5, { kind: "order" });
      Object.assign(b.options[0], patch);
      return problemsOf(b).join(" ");
    };
    assert.match(mk({ action: "Bash npm test" }), /action must be an object/);
    assert.match(mk({ action: { tool: "Teleport", target: "x" } }), /action.tool must be one of/);
    assert.match(mk({ action: { tool: "Bash" } }), /action.target is required/);
    assert.match(mk({ action: { tool: "AskUserQuestion" } }), /control option/);
    assert.match(mk({ action: { tool: "Bash", target: 'node "/p/private/jev-control/cli.mjs" decide' } }), /must not be a control step/);
    assert.match(mk({ preconditions: [{ kind: "path_exists" }] }), /preconditions\[0\] must be/);
    assert.match(mk({ preconditions: [{ kind: "path_sha256", path: "a", sha256: "xyz" }] }), /sha256 must be 64/);
    assert.match(mk({ preconditions: Array.from({ length: 6 }, () => ({ kind: "path_exists", path: "a" })) }), /at most 5/);
  });
  it("options with the same text but different actions are different options; the hash includes action and preconditions", () => {
    const b = batchOf(5, { kind: "order" });
    b.options[1].text = b.options[0].text;
    const r = normalizeBatch(b);
    assert.equal(r.ok, true);
    assert.equal(r.batch.options.filter((o) => !o.control).length, 5);
    const a = { text: "x", evidence: ["e"], action: { tool: "Bash", target: "a" }, preconditions: [] };
    assert.notEqual(optionHash(a), optionHash({ ...a, action: { tool: "Bash", target: "b" } }));
    assert.notEqual(optionHash(a), optionHash({ ...a, preconditions: [{ kind: "path_exists", path: "x" }] }));
    assert.equal(optionHash(a, 64).length, 64);
  });
});

describe("an action is bound by its arguments, not only by its path", () => {
  const one = (action, kind = "order") => {
    const b = batchOf(5, { kind });
    b.options[0].action = action;
    return normalizeBatch(b);
  };
  it("requires the arguments that change what the call does and refuses names it does not know", () => {
    assert.match(one({ tool: "Write", target: "a.js" }).problems.join(" "), /action.content is required for Write/);
    assert.match(one({ tool: "Edit", target: "a.js", old_string: "x" }).problems.join(" "), /action.new_string is required/);
    assert.match(one({ tool: "Agent", target: "worker" }).problems.join(" "), /action.prompt is required for Agent/);
    assert.match(one({ tool: "MultiEdit", target: "a.js", edits: [] }).problems.join(" "), /non-empty array/);
    assert.match(one({ tool: "Read", target: "a.js", offset: "3" }).problems.join(" "), /offset must be an integer/);
    assert.match(one({ tool: "Read", target: "a.js", timeout: 5 }).problems.join(" "), /timeout is not an argument of Read/);
    assert.equal(one({ tool: "Read", target: "a.js", offset: 10, limit: 20 }).ok, true);
  });
  it("gives a different option hash, action hash and plan hash to every different argument of the same tool and path", () => {
    const hashes = (action) => {
      const o = one(action).batch.options[0];
      return [optionHash(o), optionActionHash(o)];
    };
    const variants = [
      { tool: "Write", target: "a.js", content: "one" },
      { tool: "Write", target: "a.js", content: "two" },
      { tool: "Edit", target: "a.js", old_string: "a", new_string: "b" },
      { tool: "Edit", target: "a.js", old_string: "a", new_string: "c" },
      { tool: "Edit", target: "a.js", old_string: "a", new_string: "b", replace_all: true },
      { tool: "Read", target: "a.js" },
      { tool: "Read", target: "a.js", offset: 1, limit: 50 },
      { tool: "Read", target: "a.js", offset: 51, limit: 50 },
      { tool: "Agent", target: "worker", prompt: "do x", model: "sonnet" },
      { tool: "Agent", target: "worker", prompt: "do y", model: "sonnet" },
      { tool: "Agent", target: "worker", prompt: "do x", model: "opus" },
      { tool: "Grep", target: "foo", path: "src" },
      { tool: "Grep", target: "foo", path: "test" },
      { tool: "Bash", target: 'printf "a b"' },
      { tool: "Bash", target: 'printf "a  b"' },
    ];
    const all = variants.map(hashes);
    assert.equal(new Set(all.map((h) => h[0])).size, variants.length, "option hashes");
    assert.equal(new Set(all.map((h) => h[1])).size, variants.length, "action hashes");
  });
  it("keeps a payload only as its hash (the head is a view for Jev, outside the hash)", () => {
    const d = one({ tool: "Write", target: "a.js", content: "SECRET=hunter2\nbody" }).batch.options[0].action;
    assert.match(d.args.content, /^s256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(d.args).includes("hunter2"), false);
    assert.equal(d.view.content.chars, "SECRET=hunter2\nbody".length);
    assert.equal(d.view.content.text, "SECRET=hunter2\nbody", "the whole text stays in memory for what Jev reads, outside the hash");
  });
  it("refuses an action too large for Jev to read whole: nothing unread may be authorized", () => {
    const raw = { decision: "d", kind: "edit", options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, text: `t${i}`, evidence: ["e"], action: { tool: "Write", target: `a${i}.js`, content: i === 0 ? "z".repeat(100_001) : "ok" } })) };
    const r = normalizeBatch(raw);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /options\[0\]\.action is too large for Jev to read whole/);
    raw.options[0].action.content = "z".repeat(90_000);
    assert.equal(normalizeBatch(raw).ok, true);
  });
});

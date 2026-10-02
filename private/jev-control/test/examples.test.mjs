import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { S3 } from "../fixtures/scenarios.mjs";
import { materialize } from "../fixtures/lib.mjs";
import { compactOut } from "../cli.mjs";
import { parseDecideResult, parseNoulResult, parseRankResult, toolBase, validateArgs } from "../contracts.mjs";
import { normalizeBatch } from "../options.mjs";
import { runDecision } from "../protocol.mjs";
import { controlSearch } from "../search.mjs";
import { REPO_ROOT, stateDir } from "./helpers.mjs";

const DIR = join(REPO_ROOT, "skills", "jev-control", "examples");
const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
const read = (f) => readFileSync(join(DIR, f), "utf8");

/** The ordered labeled blocks of an example: {label, lang, body}. A label is the closest `**...**` line above a fenced block. */
function blocksOf(text) {
  const out = [];
  let label = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\*\*.+\*\*/.test(line) && !line.startsWith("```")) label = line;
    const fence = /^```(\w*)$/.exec(line);
    if (fence && fence[1] !== "") {
      const body = [];
      for (i++; i < lines.length && lines[i] !== "```"; i++) body.push(lines[i]);
      out.push({ label, lang: fence[1], body: body.join("\n") });
    }
  }
  return out;
}

/** Group the blocks into rounds: a batch, then its calls/responses, then the helper output. */
function roundsOf(text) {
  const rounds = [];
  let round = null;
  for (const b of blocksOf(text)) {
    if (b.lang !== "json") continue;
    const label = b.label ?? "";
    if (/: batch\*\*|^\*\*Decision \d+.*: batch/.test(label) || /batch\*\*/.test(label)) {
      round = { batch: JSON.parse(b.body), calls: [], output: null, label };
      rounds.push(round);
    } else if (round && /^\*\*Call \d+ — jev_/.test(label)) round.calls.push({ tool: /(jev_\w+)/.exec(label)[1], args: JSON.parse(b.body), response: null });
    else if (round && /^\*\*Response \d+ \(Illustrative/.test(label)) round.calls.at(-1).response = JSON.parse(b.body);
    else if (round && /^\*\*Helper output\*\*/.test(label)) round.output = JSON.parse(b.body);
  }
  return rounds;
}

describe("the examples (D12)", () => {
  it("there are seven Markdown examples with the agreed names", () => {
    assert.deepEqual(files, ["01-single-winner.md", "02-multiple-eligible.md", "03-extension-then-ask.md", "04-file-search.md", "05-task-order.md", "06-unavailable.md", "07-compact-helper.md"]);
  });
  it("each is marked illustrative and none claims a measurement", () => {
    for (const f of files) {
      const text = read(f);
      assert.match(text, /Illustrative — not measured/, f);
      assert.doesNotMatch(text.replace(/not measured/g, ""), /\bmeasured (saving|reduction)|\d+ ?% (fewer|less|saving)/i, f);
      assert.match(text, /Accounting/, f);
    }
  });
  it("every MCP call is valid against the tool contracts and every response parses", () => {
    for (const f of files) {
      for (const b of blocksOf(read(f))) {
        const call = /^\*\*Call \d+ — (jev_\w+)/.exec(b.label ?? "");
        if (call && b.lang === "json") assert.deepEqual(validateArgs(toolBase(call[1]), JSON.parse(b.body)), [], `${f}: ${b.label}`);
        const resp = /^\*\*Response (\d+) \(Illustrative/.exec(b.label ?? "");
        if (resp && b.lang === "json") {
          const body = JSON.parse(b.body);
          assert.ok(["jev_noul", "jev_decide", "jev_rerank", "jev_find"].includes(body.tool), `${f}: ${body.tool}`);
        }
      }
    }
  });
});

describe("the decision examples are executable specifications", () => {
  for (const f of ["01-single-winner.md", "02-multiple-eligible.md", "03-extension-then-ask.md", "05-task-order.md", "06-unavailable.md", "07-compact-helper.md"]) {
    it(`${f}: replayed through the real protocol, the calls and the helper output are exactly the documented ones`, async () => {
      const dir = stateDir();
      const rounds = roundsOf(read(f));
      assert.ok(rounds.length >= 1, f);
      for (const [i, round] of rounds.entries()) {
        const n = normalizeBatch(round.batch);
        assert.equal(n.ok, true, `${f} round ${i}: ${JSON.stringify(n.problems)}`);
        const queue = [...round.calls];
        const seen = [];
        const caller = {
          async call(_s, name, args) {
            const step = queue.shift();
            assert.ok(step, `${f} round ${i}: unexpected call ${name}`);
            assert.equal(name, step.tool);
            assert.deepEqual(args, step.args, `${f} round ${i}: the arguments the helper sends differ from the documented ones`);
            seen.push(name);
            if (!step.response) return { ok: false, kind: "transport", message: round.output.message.replace(/^Jev unavailable: /, ""), attempts: round.output.calls };
            return { ok: true, result: step.response, attempts: 1 };
          },
        };
        const result = await runDecision(n.batch, { caller, session: {}, dir, T: 0.95, priorities: "fix it with the smallest correct change", headless: false, decisionId: round.output.decision_id, now: Date.now });
        assert.equal(queue.length, 0, `${f} round ${i}: documented calls that were never made`);
        assert.equal(compactOut(result), JSON.stringify(round.output), `${f} round ${i}: helper output`);
      }
    });
  }
  it("the documented responses parse with the real result parsers", () => {
    for (const f of files) {
      for (const round of roundsOf(read(f))) {
        for (const c of round.calls) {
          if (!c.response) continue;
          if (c.tool === "jev_noul") assert.equal(parseNoulResult(c.response, c.args.propositions.length).ok, true, f);
          if (c.tool === "jev_decide") assert.equal(parseDecideResult(c.response, c.args.candidates.map((x) => x.id)).ok, true, f);
        }
      }
    }
  });
  it("07: the byte table states the real sizes of this synthetic example", () => {
    const text = read("07-compact-helper.md");
    const [round] = roundsOf(text);
    const bytes = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));
    const cells = [...text.matchAll(/^\| (?:the batch|the `jev_noul` payload|the raw `jev_noul` response|the helper's one-line output)[^|]*\| (\d+) \|/gm)].map((m) => Number(m[1]));
    assert.deepEqual(cells, [bytes(round.batch), bytes(round.calls[0].args), bytes(round.calls[0].response), bytes(round.output)]);
  });
});

describe("04 file search: replayed through the real search against the documented fixture", () => {
  it("find rejected on `exists`, rerank accepted, and the helper output is the documented line", async () => {
    const text = read("04-file-search.md");
    const blocks = blocksOf(text);
    const calls = blocks.filter((b) => /^\*\*Call \d+ — jev_/.test(b.label ?? "") && b.lang === "json").map((b) => ({ tool: /(jev_\w+)/.exec(b.label)[1], args: JSON.parse(b.body) }));
    const responses = blocks.filter((b) => /^\*\*Response \d+ \(Illustrative/.test(b.label ?? "") && b.lang === "json").map((b) => JSON.parse(b.body));
    const output = JSON.parse(blocks.find((b) => /^\*\*Helper output\*\*/.test(b.label ?? "")).body);
    assert.deepEqual(calls.map((c) => c.tool), ["jev_find", "jev_rerank"]);
    assert.equal(parseRankResult("find", responses[0], calls[0].args.candidates.map((c) => c.id), 5).exists, 0.91);
    const repo = materialize(S3);
    let i = 0;
    const caller = {
      async call(_s, name, args) {
        assert.equal(name, calls[i].tool);
        assert.deepEqual(args, calls[i].args);
        return { ok: true, result: responses[i++], attempts: 1 };
      },
    };
    const query = /--query "([^"]+)"/.exec(text)[1];
    const result = await controlSearch({ query, single: true }, { caller, session: {}, dir: stateDir(), T: 0.95, repoRoot: repo, now: Date.now, searchId: output.search_id });
    assert.equal(i, 2);
    assert.deepEqual(result, output);
  });
});

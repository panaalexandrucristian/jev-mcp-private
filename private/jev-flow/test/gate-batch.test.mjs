import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BATCH_LIMITS,
  batchId,
  claimSetHash,
  coversEarlierBatches,
  diffHash,
  diffUnits,
  formatBatchLabel,
  GATE_LIMITS,
  listHunks,
  parseBatchLabel,
  partDigest,
  prepareGateBatch,
  requestBody,
  selectGateAttempts,
  splitExact,
  verifyBatchContents,
} from "../gate-batch.mjs";
import { parseDenylist } from "../paths.mjs";
import { makeRepo, REPO_ROOT, run, sandboxEnv, writeFiles } from "./helpers.mjs";

const SNAP = "a".repeat(64);
const OPEN = parseDenylist("");
const GATE_CLI = join(REPO_ROOT, "scripts", "jev-gate-payload.mjs");

function fileDiff(path, lines, { start = 1 } = {}) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n") + "\n";
}
const bigLines = (tag, n, width = 40) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = "${"x".repeat(width)}";`);
const prepare = (input, snapshot = SNAP) => prepareGateBatch({ request: "do it", ...input }, { denylist: OPEN, snapshot });

describe("gate-batch: limits mirror src/lib.ts", () => {
  it("uses the jev_gate caps and keeps its own budgets below them", () => {
    assert.deepEqual(GATE_LIMITS, { claims: 16, evidenceItems: 16, evidenceChars: 200_000, docChars: 50_000, claimChars: 2_000 });
    assert.ok(BATCH_LIMITS.diffSliceChars < GATE_LIMITS.docChars);
    assert.ok(BATCH_LIMITS.evidenceItemChars < GATE_LIMITS.docChars);
    assert.ok(BATCH_LIMITS.testsChars < GATE_LIMITS.docChars);
  });
});

describe("gate-batch: diff units and exact splitting", () => {
  it("splits at line ends and the pieces concatenate to the input", () => {
    const text = "one\ntwo\nthree\n" + "y".repeat(50) + "\n";
    const pieces = splitExact(text, 12);
    assert.equal(pieces.join(""), text);
    assert.ok(pieces.every((p) => p.length <= 12));
  });

  it("units are exact substrings with hunk ids; a section without hunks is one unit", () => {
    const diff = fileDiff("a.ts", ["a"]) + "diff --git a/img.png b/img.png\nBinary files differ\n" + fileDiff("b.ts", ["b"]);
    const units = diffUnits(diff);
    assert.equal(units.map((u) => u.text).join(""), diff);
    assert.deepEqual(units.filter((u) => u.id).map((u) => [u.id, u.path]), [["hunk-1", "a.ts"], ["hunk-2", "img.png"], ["hunk-3", "b.ts"]]);
    assert.deepEqual(listHunks(diff).map((h) => h.id), ["hunk-1", "hunk-2", "hunk-3"]);
  });
});

describe("gate-batch: labels and manifest ids", () => {
  it("formats and parses a label; rejects out-of-range values", () => {
    const fields = { id: "b".repeat(32), part: 2, of: 3, slice: 1, slices: 2, claims: "c".repeat(16), diff: "d".repeat(16), snap: SNAP };
    const label = formatBatchLabel(fields);
    assert.deepEqual(parseBatchLabel(`${label}\nthe request`), fields);
    for (const bad of [{ part: 4 }, { part: 0 }, { slices: 4 }, { of: 17, part: 1 }]) {
      assert.equal(parseBatchLabel(formatBatchLabel({ ...fields, ...bad })), null, JSON.stringify(bad));
    }
    assert.equal(parseBatchLabel("no label"), null);
    assert.equal(parseBatchLabel(`prefix ${label}`), null, "the label must be the first line");
    assert.equal(parseBatchLabel(label.replace("batch v2", "batch v1")), null, "older label versions are not accepted");
    assert.equal(requestBody(`${label}\nthe request`), "the request");
    assert.equal(requestBody("plain request"), "plain request");
  });

  it("the claim-set hash ignores order and duplicates; the id binds every part's complete input", () => {
    assert.equal(claimSetHash(["x", "y"]), claimSetHash(["y", "x", "x"]));
    assert.notEqual(claimSetHash(["x"]), claimSetHash(["x", "y"]));
    const input = { request: "r", diff: "d", claims: ["c"], evidence: [{ id: "e", text: "t" }], tests: "ok" };
    const base = { snap: SNAP, slices: 1, claims: claimSetHash(["c"]), diff: diffHash("d") };
    const id = batchId({ ...base, digests: [partDigest(input)] });
    for (const changed of [{ evidence: [{ id: "e", text: "t2" }] }, { tests: "other" }, { request: "r2" }, { auto_accept: 0.9 }]) {
      assert.notEqual(batchId({ ...base, digests: [partDigest({ ...input, ...changed })] }), id, JSON.stringify(changed));
    }
    const labelled = { ...input, request: `${formatBatchLabel({ id, part: 1, of: 1, slice: 1, slices: 1, claims: base.claims, diff: base.diff, snap: SNAP })}\nr` };
    assert.equal(partDigest(labelled), partDigest(input), "the label is excluded from the digest");
  });
});

describe("gate-batch: preparation pairs every claim with its evidence", () => {
  it("builds one call with per-claim hunk and command evidence (the T2-B' regression)", () => {
    const out = prepare({
      diff: fileDiff("src/a.ts", ["export const a = 2;"]) + fileDiff("src/b.ts", ["export const b = 3;"]),
      claims: [
        { text: "a is 2", evidence: ["hunk-1"] },
        { text: "b is 3", evidence: ["file:src/b.ts"] },
        { text: "npm test passed", evidence: ["cmd-1"] },
      ],
      commands: [{ command: "npm test", exit: 0, output: "# pass 77\n# fail 0" }],
    });
    assert.equal(out.ok, true, JSON.stringify(out.problems));
    assert.equal(out.calls.length, 1);
    const { input } = out.calls[0];
    assert.deepEqual(input.claims, ["a is 2", "b is 3", "npm test passed"]);
    assert.deepEqual(input.evidence.map((e) => e.id).sort(), ["cmd-1", "hunk-1", "hunk-2"]);
    assert.match(input.evidence.find((e) => e.id === "hunk-2").text, /^\[hunk-2\] src\/b\.ts\n@@/);
    assert.match(input.tests, /\$ npm test\nexit: 0\n# pass 77/);
    assert.ok(parseBatchLabel(input.request), "even a single call carries the manifest");
    assert.equal(out.limits.partitioned, false);
  });

  it("test output only in `tests` is not evidence: a check claim must cite its command", () => {
    const out = prepare({ diff: fileDiff("a.ts", ["x"]), claims: [{ text: "tests pass", evidence: [] }], commands: [{ command: "npm test", exit: 0, output: "ok" }] });
    assert.equal(out.ok, false);
    assert.match(out.problems.join("\n"), /no evidence ids/);
    assert.deepEqual(out.calls, []);
  });

  it("never invents an exit code: a missing one is rendered as unknown", () => {
    const out = prepare({ diff: fileDiff("a.ts", ["x"]), claims: [{ text: "x added; build ran", evidence: ["hunk-1", "cmd-1"] }], commands: [{ command: "./gradlew test", exit: null, output: "BUILD SUCCESSFUL" }] });
    assert.equal(out.ok, true);
    assert.match(out.calls[0].input.evidence.find((e) => e.id === "cmd-1").text, /exit: unknown \(not reported by the tool\)/);
  });

  it("rejects unknown ids, placeholders, over-long claims, bad excerpts and excluded paths", () => {
    const diff = fileDiff("a.ts", ["x"]);
    const cases = [
      [{ claims: [{ text: "c", evidence: ["hunk-9"] }] }, /unknown evidence id hunk-9/],
      [{ claims: [{ text: "<each acceptance criterion that is met>", evidence: ["hunk-1"] }] }, /placeholder/],
      [{ claims: [{ text: "c".repeat(2001), evidence: ["hunk-1"] }] }, /longer than 2000/],
      [{ claims: [{ text: "c", evidence: ["hunk-1"] }], excerpts: [{ id: "hunk-7", path: "a.ts", text: "x" }] }, /id must match/],
      [{ claims: [{ text: "c", evidence: ["hunk-1"] }], excerpts: [{ id: "env", path: ".env", text: "A=1" }] }, /excluded by the jev-flow policy/],
      [{ claims: [{ text: "c", evidence: ["hunk-1"] }], commands: [{ command: "npm test", exit: "0", output: "ok" }] }, /exit must be an integer or null/],
    ];
    for (const [input, re] of cases) {
      const out = prepare({ diff, ...input });
      assert.equal(out.ok, false, re.source);
      assert.match(out.problems.join("\n"), re);
    }
    assert.match(prepare({ diff, claims: [{ text: "c", evidence: ["hunk-1"] }] }, null).problems.join(), /snapshot_unknown/);
  });

  it("redaction is allowed: credentials become markers and the calls are still prepared", () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    const out = prepare({ diff: fileDiff("a.ts", [`const k = "${secret}";`]), claims: [{ text: "a.ts changed", evidence: ["hunk-1", "cmd-1"] }], commands: [{ command: "env", exit: 0, output: `key=${secret}` }] });
    assert.equal(out.ok, true, JSON.stringify(out.problems));
    assert.ok(!JSON.stringify(out.calls).includes(secret));
    assert.ok(out.limits.redactions.length > 0);
  });

  it("a diff mixing allowed and excluded files is not prepared: the excluded part would go unevaluated", () => {
    const diff = fileDiff("a.ts", ["x"]) + fileDiff(".env", ["TOKEN=1"]) + fileDiff("config/local.properties", ["sdk.dir=/x"]);
    const out = prepare({ diff, claims: [{ text: "a.ts changed", evidence: ["hunk-1"] }] });
    assert.equal(out.ok, false);
    assert.deepEqual(out.calls, []);
    assert.match(out.problems.join("\n"), /diff: sanitizing removed content \(\.env: permanent_exclusion; config\/local\.properties: permanent_exclusion\)/);
    assert.ok(!JSON.stringify(out).includes("TOKEN=1"), "the excluded material is never emitted");
  });

  it("lines omitted from the diff or from cited evidence make the work incomplete", () => {
    const key = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const diffLines = prepare({ diff: fileDiff("a.ts", ["x", `const pem = "${key}";`]), claims: [{ text: "a", evidence: ["hunk-1"] }] });
    const cmdLines = prepare({ diff: fileDiff("a.ts", ["x"]), claims: [{ text: "a", evidence: ["hunk-1", "cmd-1"] }], commands: [{ command: "cat log", exit: 0, output: `ok\n${key}` }] });
    for (const out of [diffLines, cmdLines]) {
      assert.equal(out.ok, false);
      assert.deepEqual(out.calls, []);
      assert.match(out.problems.join("\n"), /sanitizing removed content \(\d+ suspicious line\(s\) replaced\)/);
    }
  });

  it("reports hunks no claim cites as a limit", () => {
    const out = prepare({ diff: fileDiff("a.ts", ["x"]) + fileDiff("b.ts", ["y"]), claims: [{ text: "a", evidence: ["hunk-1"] }] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.limits.uncited_hunks, ["hunk-2"]);
  });
});

describe("gate-batch: splitting large patches", () => {
  it("covers the whole diff exactly, keeps oversized hunks in identified continuations, and every slice has a claim", () => {
    const diff = fileDiff("a.ts", bigLines("a", 1500)) + fileDiff("b.ts", bigLines("b", 1500));
    assert.ok(diff.length > 2 * GATE_LIMITS.docChars);
    const out = prepare({ diff, claims: [{ text: "a added", evidence: ["hunk-1"] }, { text: "b added", evidence: ["hunk-2"] }] });
    assert.equal(out.ok, true, JSON.stringify(out.problems));
    assert.equal(out.limits.partitioned, true);
    const labels = out.calls.map((c) => parseBatchLabel(c.input.request));
    const slices = new Map(labels.map((l, i) => [l.slice, out.calls[i].input.diff]));
    assert.equal([...slices.keys()].sort((a, b) => a - b).map((k) => slices.get(k)).join(""), diff, "slices rebuild the diff");
    for (const call of out.calls) {
      assert.ok(call.input.diff.length <= GATE_LIMITS.docChars);
      assert.ok(call.input.claims.length >= 1 && call.input.claims.length <= GATE_LIMITS.claims);
      assert.ok(call.input.evidence.length <= GATE_LIMITS.evidenceItems);
      assert.ok(call.input.evidence.reduce((n, e) => n + e.text.length, 0) <= GATE_LIMITS.evidenceChars);
      assert.ok(call.input.evidence.every((e) => e.text.length <= GATE_LIMITS.docChars));
    }
    const hunk1 = out.calls[0].input.evidence.filter((e) => e.id.startsWith("hunk-1#"));
    assert.ok(hunk1.length >= 2, "the oversized hunk continues in identified pieces");
    assert.match(hunk1[1].text, /^\[hunk-1\] a\.ts \(continuation 2\/\d+\)\n/);
    assert.ok(verifyBatchContents(out.calls.map((c) => c.input), { snapshot: SNAP }).ok);
  });

  it("an oversized log continues in pieces instead of being cut; the tests field is cut visibly", () => {
    const log = bigLines("log", 2500).join("\n");
    const out = prepare({ diff: fileDiff("a.ts", ["x"]), claims: [{ text: "tests passed", evidence: ["hunk-1", "cmd-1"] }], commands: [{ command: "npm test", exit: 0, output: log }] });
    assert.equal(out.ok, true, JSON.stringify(out.problems));
    const pieces = out.calls[0].input.evidence.filter((e) => e.id.startsWith("cmd-1#"));
    assert.ok(pieces.length >= 2);
    assert.equal(pieces.map((p) => p.text.slice(p.text.indexOf("\n") + 1)).join("").includes(log.slice(-200)), true);
    assert.ok(out.limits.tests_truncated_chars > 0);
    assert.match(out.calls[0].input.tests, /tests field cut, \d+ characters omitted here; the full output is in the cmd-\* evidence items/);
  });

  it("more than 16 claims on one slice spill into further parts over the same slice", () => {
    const claims = Array.from({ length: 20 }, (_, i) => ({ text: `claim ${i}`, evidence: ["hunk-1"] }));
    const out = prepare({ diff: fileDiff("a.ts", ["x"]), claims });
    assert.equal(out.ok, true);
    assert.equal(out.calls.length, 2);
    assert.deepEqual(out.calls.map((c) => c.input.claims.length), [16, 4]);
    assert.equal(out.calls[0].input.diff, out.calls[1].input.diff);
    assert.ok(verifyBatchContents(out.calls.map((c) => c.input), { snapshot: SNAP }).ok);
  });

  it("a claim whose evidence cannot fit one call, or a slice no claim covers, is a problem", () => {
    const hunks = Array.from({ length: 17 }, (_, i) => fileDiff(`f${i}.ts`, ["x"])).join("");
    const wide = prepare({ diff: hunks, claims: [{ text: "all files changed", evidence: Array.from({ length: 17 }, (_, i) => `hunk-${i + 1}`) }] });
    assert.equal(wide.ok, false);
    assert.match(wide.problems.join(), /needs 17 evidence items/);
    const diff = fileDiff("a.ts", bigLines("a", 1500)) + fileDiff("b.ts", bigLines("b", 1500));
    const uncovered = prepare({ diff, claims: [{ text: "a added", evidence: ["hunk-1"] }] });
    assert.equal(uncovered.ok, false);
    assert.match(uncovered.problems.join(), /has no claim citing its changes/);
  });
});

describe("gate-batch: complete-batch verification", () => {
  const diff = fileDiff("a.ts", bigLines("a", 1500)) + fileDiff("b.ts", bigLines("b", 1500));
  const out = prepare({ diff, claims: [{ text: "a added", evidence: ["hunk-1"] }, { text: "b added", evidence: ["hunk-2"] }] });
  const inputs = out.calls.map((c) => c.input);

  it("accepts the complete batch and rejects missing, duplicated, altered or foreign parts", () => {
    const verified = verifyBatchContents(inputs, { snapshot: SNAP });
    assert.deepEqual([verified.ok, verified.problems], [true, []]);
    assert.equal(verified.whole, diff, "the verified whole diff is returned for coverage checks");
    assert.ok(!verifyBatchContents(inputs.slice(1), { snapshot: SNAP }).ok, "missing part");
    assert.ok(!verifyBatchContents([...inputs, inputs[0]], { snapshot: SNAP }).ok, "duplicated part");
    assert.ok(!verifyBatchContents(inputs, { snapshot: "b".repeat(64) }).ok, "other snapshot");
    const altered = inputs.map((p, i) => (i === 0 ? { ...p, diff: `${p.diff}+evil\n` } : p));
    assert.ok(!verifyBatchContents(altered, { snapshot: SNAP }).ok, "altered slice");
    const dropped = inputs.map((p, i) => (i === inputs.length - 1 ? { ...p, claims: ["other"] } : p));
    assert.match(verifyBatchContents(dropped, { snapshot: SNAP }).problems.join(), /claim_set_mismatch.*manifest_id_mismatch/);
    assert.deepEqual(verifyBatchContents([{ request: "no label", claims: ["c"], diff: "d" }]).problems, ["label_missing_or_invalid"]);
  });

  it("changed evidence, tests or request, or claims moved between parts, break the manifest", () => {
    const edits = {
      evidence: (p) => ({ ...p, evidence: [...p.evidence.slice(0, -1), { id: "hunk-1#1", text: "forged" }] }),
      tests: (p) => ({ ...p, tests: "# pass 999" }),
      request: (p) => ({ ...p, request: `${p.request} and more` }),
      parameter: (p) => ({ ...p, auto_accept: 0.5 }),
    };
    for (const [name, edit] of Object.entries(edits)) {
      const changed = inputs.map((p, i) => (i === 0 ? edit(p) : p));
      assert.deepEqual(verifyBatchContents(changed, { snapshot: SNAP }).problems, ["manifest_id_mismatch"], name);
    }
    const moved = inputs.map((p, i) => (i === 0 ? { ...p, claims: [...p.claims, "b added"] } : i === inputs.length - 1 ? { ...p, claims: p.claims.filter((c) => c !== "b added").concat(p.claims.includes("b added") && p.claims.length === 1 ? ["a added"] : []) } : p));
    assert.ok(!verifyBatchContents(moved, { snapshot: SNAP }).ok, "claims redistributed between parts");
  });

  it("parts of two preparations never combine, even for the same patch and claims", () => {
    const rebuilt = prepare({
      diff,
      claims: [{ text: "a added", evidence: ["hunk-1", "cmd-1"] }, { text: "b added", evidence: ["hunk-2"] }],
      commands: [{ command: "npm test", exit: 0, output: "# pass 3" }],
    });
    assert.equal(rebuilt.ok, true);
    assert.notEqual(rebuilt.batch.id, out.batch.id, "new evidence makes a new batch");
    const mixed = [inputs[0], ...rebuilt.calls.slice(1).map((c) => c.input)];
    assert.deepEqual(verifyBatchContents(mixed, { snapshot: SNAP }).problems, ["manifest_mismatch"]);
    assert.ok(verifyBatchContents(rebuilt.calls.map((c) => c.input), { snapshot: SNAP }).ok);
  });

  it("a later gate must cover the earlier batch's claims and its whole patch", () => {
    const partial = inputs.slice(0, 1);
    const onlyA = fileDiff("a.ts", bigLines("a", 1500));
    assert.equal(coversEarlierBatches({ claims: ["a added"], diff }, partial), false, "only part 1's claims: the full set is unknown");
    assert.equal(coversEarlierBatches({ claims: ["b added", "a added"], diff }, partial), true, "same claim set and same whole diff");
    assert.equal(coversEarlierBatches({ claims: ["a added", "b added"], diff: onlyA }, partial), false, "same claims but b.ts dropped (only part 1 was sent)");
    assert.equal(coversEarlierBatches({ claims: ["a added", "b added"], diff: onlyA }, inputs), false, "same claims but b.ts dropped (all parts known)");
    const extra = diff + fileDiff("c.ts", ["more"]);
    assert.equal(coversEarlierBatches({ claims: ["a added", "b added", "more"], diff: extra }, inputs), true, "all parts known: superset of claims and patch");
    assert.equal(coversEarlierBatches({ claims: ["a added", "b added", "more"], diff: extra }, partial), false, "a superset is unprovable while parts are unknown");
    assert.equal(coversEarlierBatches({ claims: ["a added", "more"], diff }, inputs), false);
    assert.equal(coversEarlierBatches({ claims: ["a added", "b added"], diff }, [{ request: "x", claims: ["a added"], diff: "d" }]), false, "unlabelled input is not a batch attempt");
  });
});

describe("gate-batch: attempt selection", () => {
  const ok = (extra) => ({ ts: 1, req: 1, before: "s", after: "s", ...extra });
  const batch = (part, extra = {}) => ok({ batch: "B", part, of: 2, ...extra });

  it("keeps the single-gate rule and its reasons", () => {
    assert.equal(selectGateAttempts([ok({ id: "g" })], { snapshot: "s", requestSeq: 1 }).record.id, "g");
    assert.equal(selectGateAttempts([], { snapshot: "s", requestSeq: 1 }).reason, "no_gate");
    assert.equal(selectGateAttempts([ok({ failed: true })], { snapshot: "s", requestSeq: 1 }).reason, "latest_gate_failed");
    assert.equal(selectGateAttempts([ok({ pending: true })], { snapshot: "s", requestSeq: 1 }).reason, "latest_gate_unfinished");
    assert.equal(selectGateAttempts([ok({ after: "t" })], { snapshot: "s", requestSeq: 1 }).reason, "changed_during_gate");
    assert.equal(selectGateAttempts([ok({})], { snapshot: "u", requestSeq: 1 }).reason, "gate_on_older_snapshot");
    assert.equal(selectGateAttempts([ok({})], { snapshot: null, requestSeq: 1 }).reason, "snapshot_unknown");
  });

  it("a batch needs every part; the latest attempt of each part decides", () => {
    const sel = (list) => selectGateAttempts(list, { snapshot: "s", requestSeq: 1 });
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2 })]).batch.records.length, 2);
    assert.equal(sel([batch(2, { ts: 2 })]).reason, "batch_part_missing");
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2, failed: true })]).reason, "batch_part_failed");
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2, failed: true }), batch(2, { ts: 3 })]).batch.records[1].ts, 3, "a later retry replaces a failed part");
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2 }), batch(1, { ts: 3, denied: true })]).reason, "batch_part_denied");
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2, pending: true })]).reason, "batch_part_unfinished");
    assert.equal(sel([batch(1, { ts: 1, req: 0 }), batch(2, { ts: 2 })]).reason, "batch_part_other_request");
    assert.equal(sel([batch(1, { ts: 1, after: "old", before: "old" }), batch(2, { ts: 2 })]).reason, "batch_part_older_snapshot");
    assert.equal(sel([batch(1, { ts: 1 }), ok({ ts: 2 }), batch(2, { ts: 3 })]).reason, "batch_interleaved");
    assert.equal(sel([batch(1, { ts: 1 }), batch(2, { ts: 2, of: 3 })]).reason, "batch_inconsistent");
  });

  it("returns earlier batch attempts of the request and snapshot for the coverage check", () => {
    const sel = selectGateAttempts([batch(1, { ts: 1 }), ok({ ts: 2, id: "single" })], { snapshot: "s", requestSeq: 1 });
    assert.equal(sel.record.id, "single");
    assert.equal(sel.supersededBatch.length, 1);
    const replaced = selectGateAttempts([batch(1, { ts: 1 }), ok({ ts: 2, batch: "C", part: 1, of: 1 })], { snapshot: "s", requestSeq: 1 });
    assert.equal(replaced.batch.id, "C");
    assert.equal(replaced.supersededBatch.length, 1);
    const otherRequest = selectGateAttempts([batch(1, { ts: 1, req: 0 }), ok({ ts: 2 })], { snapshot: "s", requestSeq: 1 });
    assert.equal(otherRequest.supersededBatch.length, 0);
  });
});

describe("gate-batch: jev-gate-payload.mjs CLI", () => {
  it("lists hunks and prepares calls bound to the repository snapshot", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    writeFiles(repo, { "a.ts": "b\n" });
    const diff = run("git", ["diff", "HEAD"], { cwd: repo }).stdout;
    const list = run(process.execPath, [GATE_CLI, "--list-hunks", "--root", repo], { input: diff });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).hunks.map((h) => [h.id, h.path]), [["hunk-1", "a.ts"]]);
    const input = { request: "change a", diff, claims: [{ text: "a.ts now holds b", evidence: ["hunk-1"] }] };
    const out = run(process.execPath, [GATE_CLI, "--root", repo], { input: JSON.stringify(input) });
    assert.equal(out.code, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.ok, true);
    const hook = run("git", ["status", "--porcelain"], { cwd: repo }).stdout;
    assert.equal(hook.trim(), "M a.ts", "the helper writes nothing into the repository");
    assert.match(parseBatchLabel(result.calls[0].input.request).snap, /^[0-9a-f]{64}$/);
  });

  it("exits 4 with problems when the input is not ready, and honours the denylist", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const bad = run(process.execPath, [GATE_CLI, "--root", repo], { input: JSON.stringify({ request: "r", diff: fileDiff("a.ts", ["x"]), claims: [{ text: "c" }] }) });
    assert.equal(bad.code, 4);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    const off = makeRepo({ ".jev-flow-denylist": "*\n" });
    const disabled = run(process.execPath, [GATE_CLI, "--root", off], { input: "{}", env: sandboxEnv() });
    assert.equal(disabled.code, 0);
    assert.equal(JSON.parse(disabled.stdout).disabled, true);
  });
});

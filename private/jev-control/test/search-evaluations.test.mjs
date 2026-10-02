// The shared evaluation budget of a file search (find, rerank and the jev_decide
// tie-break are one logical evaluation each, at most two per search id, reserved
// atomically before the call), tie handling without an invented order, real
// attempts in jev_calls, raw scores and the 4 KB compaction marker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { S3 } from "../fixtures/scenarios.mjs";
import { materialize } from "../fixtures/lib.mjs";
import { controlSearch, MAX_EVALUATIONS, reserveEvaluation } from "../search.mjs";
import { loadControlState } from "../state.mjs";
import { decide, find, makeRepo, REPO_ROOT, rerank, scriptedCaller, stateDir } from "./helpers.mjs";

const QUERY = "delay between retries of a failed upload";
const ctxFor = (repoRoot, caller, extra = {}) => ({ caller, session: {}, dir: extra.dir ?? stateDir(), T: 0.95, repoRoot, now: Date.now, priorities: "p", ...extra });
const evalsOf = (dir, id) => loadControlState(dir).searches[id]?.evals;
const paths = (hits) => hits.map((h) => h.path);
// In S3 the candidates are c0 = src/upload/retry.mjs, c1 = src/upload/uploader.mjs, then c2, c3.
const RETRY = "src/upload/retry.mjs";
const UPLOADER = "src/upload/uploader.mjs";

/** A caller that reports the given attempt counts (a transport retry) for its successful answers. */
function withAttempts(caller, attempts) {
  let i = 0;
  return { calls: caller.calls, remaining: caller.remaining, async call(...a) { const r = await caller.call(...a); return r.ok ? { ...r, attempts: attempts[i++] ?? 1 } : r; } };
}

describe("file search: one evaluation budget for find, rerank and the tie-break", () => {
  it("find -> rerank with the top two tied: tie_unresolved, exactly two calls, no tie-break, nothing found", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([find([0.97, 0.2, 0.1, 0.05], 0.91), rerank([0.97, 0.965, 0.1, 0.05])]);
    const r = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, caller));
    assert.equal(r.status, "tie_unresolved");
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_find", "jev_rerank"]);
    assert.equal(r.hits, undefined, "no ordered hit list");
    assert.deepEqual(r.resolved_hits, []);
    assert.equal(r.unresolved_count, 2);
    assert.equal(r.evaluations, 2);
    assert.equal(r.jev_calls, 2);
    assert.match(r.message, /no logical evaluation is left/);
  });
  it("a hit strictly separated above the near-tie is the established prefix; the tied files are not listed", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([find([0.97, 0.2, 0.1, 0.05], 0.91), rerank([0.999, 0.97, 0.965, 0.05])]);
    const r = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, caller));
    assert.equal(r.status, "tie_unresolved");
    assert.deepEqual(paths(r.resolved_hits), [RETRY]);
    assert.equal(r.resolved_hits[0].score, 0.999);
    assert.equal(r.unresolved_count, 2);
    assert.equal(caller.calls.length, 2);
  });
  it("three nearly equal files, rerank -> decide: two evaluations, only the winner is resolved, no third call", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([rerank([0.97, 0.965, 0.96, 0.05]), decide("c1", 0.97)]);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, caller));
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_rerank", "jev_decide"]);
    assert.equal(caller.calls[1].source, "tiebreak");
    assert.equal(caller.calls[1].args.candidates.length, 3);
    assert.equal(r.status, "tie_unresolved", "the two remaining files are still near-tied and no evaluation is left");
    assert.deepEqual(paths(r.resolved_hits), [UPLOADER]);
    assert.equal(r.unresolved_count, 2);
    assert.equal(r.evaluations, 2);
    assert.equal(r.jev_calls, 2);
    assert.equal(r.hits, undefined);
  });
  it("a near-tie chain is one group: its members are not ordered by score against each other", async () => {
    const repo = materialize(S3);
    // 0.99 vs 0.975 and 0.975 vs 0.96 are near-ties; the decide gets all three.
    const caller = scriptedCaller([rerank([0.99, 0.975, 0.96, 0.05]), decide("c0", 0.97)]);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, caller));
    assert.equal(caller.calls[1].args.candidates.length, 3);
    assert.equal(r.status, "tie_unresolved", "after the winner, 0.975 and 0.96 are still near-tied");
    assert.deepEqual(paths(r.resolved_hits), [RETRY]);
    assert.equal(r.unresolved_count, 2);
    // When the winner is the middle one, the other two (0.99, 0.96) are separated by score: fully resolved.
    const mid = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.99, 0.975, 0.96, 0.05]), decide("c1", 0.97)])));
    assert.equal(mid.status, "found");
    assert.deepEqual(paths(mid.hits), [UPLOADER, RETRY, mid.hits[2].path]);
    assert.deepEqual(mid.hits.map((h) => h.score), [0.975, 0.99, 0.96]);
  });
  it("the retry of a call is reflected in jev_calls (real attempts, not calls)", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, withAttempts(scriptedCaller([rerank([0.962, 0.31, 0.12, 0.05])]), [2])));
    assert.equal(r.status, "found");
    assert.equal(r.jev_calls, 2);
    assert.equal(r.evaluations, 1);
    assert.deepEqual(r.provenance.calls.map((c) => [c.tool, c.attempts]), [["rerank", 2]]);
    assert.equal(Object.keys(r).includes("provenance"), false, "provenance is not printed");
    assert.equal(JSON.stringify(r).includes("provenance"), false);
    const failed = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: "transport", attempts: 2 }])));
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.jev_calls, 2);
  });
  it("a second invocation running concurrently with the same search id cannot exceed two evaluations", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const a = scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), decide("c1", 0.97)]);
    const b = scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), decide("c1", 0.97)]);
    const [ra, rb] = await Promise.all([
      controlSearch({ query: QUERY }, ctxFor(repo, a, { dir, searchId: "same" })),
      controlSearch({ query: QUERY }, ctxFor(repo, b, { dir, searchId: "same" })),
    ]);
    assert.equal(a.calls.length + b.calls.length, MAX_EVALUATIONS);
    assert.equal(evalsOf(dir, "same"), 2);
    for (const r of [ra, rb]) assert.notEqual(r.status, "found", "a near-tie without its tie-break is never found");
    const third = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([]), { dir, searchId: "same" }));
    assert.equal(third.status, "search_budget_exhausted");
  });
  it("reserveEvaluation is atomic across processes: five concurrent reservations, exactly two succeed", async () => {
    const dir = stateDir();
    const url = pathToFileURL(join(REPO_ROOT, "private", "jev-control", "search.mjs")).href;
    const src = `import { reserveEvaluation } from ${JSON.stringify(url)}; console.log(JSON.stringify(reserveEvaluation({ dir: process.env.D, now: Date.now }, "p1")));`;
    const one = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, D: dir }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", (code) => resolve({ code, out }));
    });
    const results = await Promise.all(Array.from({ length: 5 }, one));
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
    const oks = results.map((r) => JSON.parse(r.out.trim())).filter((r) => r.ok);
    assert.equal(oks.length, 2);
    assert.equal(evalsOf(dir, "p1"), 2);
  });
  it("reserveEvaluation in-process: two, then refused without changing the counter", () => {
    const dir = stateDir();
    const ctx = { dir, now: Date.now };
    assert.deepEqual([reserveEvaluation(ctx, "x"), reserveEvaluation(ctx, "x"), reserveEvaluation(ctx, "x")].map((r) => r.ok), [true, true, false]);
    assert.equal(evalsOf(dir, "x"), 2);
  });
  it("resuming after a tie-break: both evaluations are spent, no call is made", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const first = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), decide("c1", 0.97)]), { dir, searchId: "r1" }));
    assert.equal(first.status, "found");
    assert.deepEqual(paths(first.hits), [UPLOADER, RETRY]);
    const caller = scriptedCaller([]);
    const again = await controlSearch({ query: QUERY }, ctxFor(repo, caller, { dir, searchId: "r1" }));
    assert.equal(again.status, "search_budget_exhausted");
    assert.equal(caller.calls.length, 0);
  });
  it("resuming after an interrupted tie-break uses only the remaining evaluation", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    // The tie-break was refused by the call budget before anything was sent: its evaluation is released.
    const first = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), { fail: "budget", attempts: 0, message: "Jev call budget exhausted (25/25)" }]), { dir, searchId: "r2" }));
    assert.equal(first.status, "budget_exhausted");
    assert.equal(first.stopped_at, "tiebreak");
    assert.deepEqual(first.resolved_hits, []);
    assert.equal(first.evaluations, 1);
    assert.equal(evalsOf(dir, "r2"), 1);
    const caller = scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05])]);
    const again = await controlSearch({ query: QUERY }, ctxFor(repo, caller, { dir, searchId: "r2" }));
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_rerank"], "no tie-break: no evaluation is left");
    assert.equal(again.status, "tie_unresolved");
    assert.equal(evalsOf(dir, "r2"), 2);
  });
  it("resuming after an unavailable first evaluation: the second one is the last", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const first = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: "transport", attempts: 2 }]), { dir, searchId: "r3" }));
    assert.equal(first.status, "unavailable");
    assert.equal(evalsOf(dir, "r3"), 1, "an attempt was made: the evaluation stays consumed");
    const caller = scriptedCaller([rerank([0.962, 0.31, 0.12, 0.05])]);
    const again = await controlSearch({ query: QUERY }, ctxFor(repo, caller, { dir, searchId: "r3" }));
    assert.equal(again.status, "found");
    assert.equal(again.evaluations, 2);
  });
  it("decide unavailable after a resolved rerank prefix: the failure status, only the prefix, an explicit stop", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.999, 0.97, 0.965, 0.05]), { fail: "transport", attempts: 2 }])));
    assert.equal(r.status, "unavailable");
    assert.equal(r.stopped_at, "tiebreak");
    assert.deepEqual(paths(r.resolved_hits), [RETRY]);
    assert.equal(r.unresolved_count, 2);
    assert.equal(r.hits, undefined);
    assert.equal(r.jev_calls, 3);
    assert.equal(r.evaluations, 2);
    assert.match(r.message, /^Jev unavailable: .*the search stopped/);
  });
  it("decide stopped by the call budget after a resolved prefix: budget_exhausted with the prefix", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.999, 0.97, 0.965, 0.05]), { fail: "budget", attempts: 1, message: "Jev call budget exhausted (25/25)" }]), { dir, searchId: "b1" }));
    assert.equal(r.status, "budget_exhausted");
    assert.deepEqual(paths(r.resolved_hits), [RETRY]);
    assert.equal(r.hits, undefined);
    assert.equal(evalsOf(dir, "b1"), 2, "one attempt was sent before the budget stopped the retry");
  });
  it("raw scores: .95001 stays .95001 and is eligible at T = 0.95; .95 exactly is not", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.95001, 0.95, 0.2, 0.1])])));
    assert.equal(r.status, "found");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].score, 0.95001);
    const exact = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, scriptedCaller([find([0.97, 0.2, 0.1, 0.05], 0.95001)])));
    assert.equal(exact.status, "found");
    assert.equal(exact.exists, 0.95001);
  });
  it("an evaluation is reserved before the call is sent; a call that was never sent releases it", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    let seen = null;
    const inner = scriptedCaller([{ fail: "transport", attempts: 2 }]);
    const spy = { calls: inner.calls, async call(...a) { seen = evalsOf(dir, "e1"); return inner.call(...a); } };
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, spy, { dir, searchId: "e1" }));
    assert.equal(seen, 1, "the counter was persisted before the call");
    assert.equal(r.status, "unavailable");
    assert.equal(evalsOf(dir, "e1"), 1, "a failed attempt still consumed the evaluation");
    for (const [kind, status] of [["invalid_args", "invalid"], ["credential", "refused"]]) {
      const d = stateDir();
      const x = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: kind, attempts: 0 }]), { dir: d, searchId: "e2" }));
      assert.equal(x.status, status);
      assert.equal(x.jev_calls, 0);
      assert.equal(x.evaluations, 0);
      assert.equal(evalsOf(d, "e2"), 0, `${kind}: nothing was sent, the evaluation is released`);
    }
  });
  it("long paths: hits that do not fit in 4 KB are dropped from the end and counted, never silently", async () => {
    const seg = (c) => c.repeat(200);
    const files = {};
    const long = [];
    for (let i = 0; i < 5; i++) {
      const p = `${seg("a")}/${seg("b")}/${seg("c")}/${seg(String.fromCharCode(100 + i))}/upload${i}.mjs`;
      long.push(p);
      files[p] = `// MARK${i} delay between retries of a failed upload\nexport const d${i} = ${i};\n`;
    }
    const repo = makeRepo(files);
    const scores = [0.99, 0.95, 0.9, 0.85, 0.8];
    const ranker = (args) => ({ tool: "jev_rerank", ranked: args.candidates.map((c) => ({ id: c.id, relevance: scores[Number(/MARK(\d)/.exec(c.text)?.[1] ?? 9)] ?? 0.01 })).sort((x, y) => y.relevance - x.relevance).slice(0, 5) });
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([ranker]), { T: 0.6 }));
    assert.equal(r.status, "found");
    assert.ok(Buffer.byteLength(JSON.stringify(r)) + 1 <= 4096);
    assert.ok(r.hits_omitted >= 1);
    assert.equal(r.hits.length + r.hits_omitted, 5);
    assert.deepEqual(paths(r.hits), long.slice(0, r.hits.length), "the kept hits are the top ones, in order");
  });
});

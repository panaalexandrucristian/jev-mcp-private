import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { S3 } from "../fixtures/scenarios.mjs";
import { materialize } from "../fixtures/lib.mjs";
import { controlSearch, exactPathHit } from "../search.mjs";
import { loadControlState } from "../state.mjs";
import { decide, find, rerank, scriptedCaller, stateDir } from "./helpers.mjs";

const QUERY = "delay between retries of a failed upload";
const ctxFor = (repoRoot, caller, extra = {}) => ({ caller, session: {}, dir: extra.dir ?? stateDir(), T: 0.95, repoRoot, now: Date.now, priorities: "p", ...extra });

describe("file search (D9, D21-D23)", () => {
  it("jev_rerank decides eligibility over several files: hits strictly above T, compact, max 5", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([rerank([0.962, 0.31, 0.12, 0.05])]);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, caller));
    assert.equal(r.status, "found");
    assert.equal(r.jev_used, "rerank");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].path, "src/upload/retry.mjs");
    assert.match(r.hits[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096);
    assert.equal(caller.calls[0].name, "jev_rerank");
    assert.equal(caller.calls[0].args.top_k, 5);
    assert.ok(caller.calls[0].args.candidates.length <= 48);
    assert.ok(caller.calls[0].args.candidates.every((c) => /^c\d+$/.test(c.id)), "no control option is injected as a file");
  });
  it("0.95 is not eligible at T = 0.95", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.95, 0.3, 0.2, 0.1])])));
    assert.equal(r.status, "none_eligible");
  });
  it("jev_find for one location is accepted only when the winner AND exists are strictly above T", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([find([0.97, 0.2, 0.1, 0.05], 0.96)]);
    const r = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, caller));
    assert.equal(r.status, "found");
    assert.equal(r.jev_used, "find");
    assert.equal(r.exists, 0.96);
    assert.equal(caller.calls.length, 1);
  });
  it("a find with exists not above T falls back to jev_rerank as the second logical evaluation", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([find([0.97, 0.2, 0.1, 0.05], 0.91), rerank([0.962, 0.31, 0.12, 0.05])]);
    const r = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, caller));
    assert.equal(r.status, "found");
    assert.equal(r.jev_used, "rerank");
    assert.equal(r.evaluations, 2);
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_find", "jev_rerank"]);
  });
  it("a find winner at exactly T is not accepted", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([find([0.95, 0.2, 0.1, 0.05], 0.99), rerank([0.5, 0.3, 0.2, 0.1])]);
    const r = await controlSearch({ query: QUERY, single: true }, ctxFor(repo, caller));
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_find", "jev_rerank"]);
    assert.equal(r.status, "search_budget_exhausted", "both logical evaluations were used and nothing was above T");
  });
  it("at most two logical evaluations per search", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const first = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.5, 0.3, 0.2, 0.1])]), { dir, searchId: "s1" }));
    assert.equal(first.status, "none_eligible");
    const second = await controlSearch({ query: `${QUERY} retry` }, ctxFor(repo, scriptedCaller([rerank([0.4, 0.3, 0.2, 0.1])]), { dir, searchId: "s1", widen: true }));
    assert.equal(second.status, "search_budget_exhausted");
    const third = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([]), { dir, searchId: "s1" }));
    assert.equal(third.status, "search_budget_exhausted");
    assert.match(third.message, /two logical evaluations/);
  });
  it("a near-tie among the eligible hits goes through one jev_decide in the shared budget (source tiebreak)", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), decide("c1", 0.97)]);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, caller));
    assert.equal(r.status, "found");
    assert.deepEqual(caller.calls.map((c) => c.name), ["jev_rerank", "jev_decide"]);
    assert.equal(caller.calls[1].source, "tiebreak");
    assert.equal(r.hits[0].path, "src/upload/uploader.mjs", "the tie-break winner comes first");
    assert.equal(r.hits.length, 2);
  });
  it("an unresolved near-tie is reported, not guessed", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([rerank([0.97, 0.965, 0.1, 0.05]), decide("c0", 0.9)])));
    assert.equal(r.status, "found");
    assert.equal(r.tie_unresolved, true);
  });
  it("an exact path the user gave is read directly, without Jev; a path outside the repository is not", async () => {
    const repo = materialize(S3);
    const caller = scriptedCaller([]);
    const r = await controlSearch({ query: "", exactPath: "src/upload/retry.mjs" }, ctxFor(repo, caller));
    assert.equal(r.status, "direct_read");
    assert.equal(r.jev_used, "none");
    assert.equal(caller.calls.length, 0);
    assert.equal(exactPathHit(repo, "../outside.txt"), null);
    assert.equal(exactPathHit(repo, "/etc/hosts"), null);
    assert.equal((await controlSearch({ query: "", exactPath: "nope.txt" }, ctxFor(repo, caller))).status, "invalid");
  });
  it("there is no lexical fallback: when Jev is unavailable nothing is returned as a hit", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: "transport", attempts: 2 }])));
    assert.equal(r.status, "unavailable");
    assert.equal(r.hits, undefined);
    assert.match(r.message, /^Jev unavailable/);
  });
  it("an unusable ranking (unknown id) is invalid, never an invented order", async () => {
    const repo = materialize(S3);
    const bad = () => ({ tool: "jev_rerank", ranked: [{ rank: 1, id: "no-such-id", relevance: 0.99 }] });
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: "invalid_response" }])));
    assert.equal(r.status, "unavailable");
    const r2 = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([bad])));
    assert.equal(r2.status, "unavailable");
  });
  it("a budget stop is reported as such", async () => {
    const repo = materialize(S3);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, scriptedCaller([{ fail: "budget", message: "Jev call budget exhausted (25/25)", attempts: 0 }])));
    assert.equal(r.status, "budget_exhausted");
  });
  it("zero candidates: one widening, then a report", async () => {
    const repo = materialize(S3);
    const dir = stateDir();
    const r = await controlSearch({ query: "zzzqqq nonexistent concept" }, ctxFor(repo, scriptedCaller([]), { dir, searchId: "z1" }));
    assert.equal(r.status, "none_candidates");
    assert.equal(r.widen_allowed, true);
    const again = await controlSearch({ query: "yyyxxx other nonexistent" }, ctxFor(repo, scriptedCaller([]), { dir, searchId: "z1", widen: true }));
    assert.equal(again.status, "none_candidates");
    assert.equal(again.widen_allowed, false);
    const third = await controlSearch({ query: "wwwvvv third" }, ctxFor(repo, scriptedCaller([]), { dir, searchId: "z1", widen: true }));
    assert.equal(third.status, "search_budget_exhausted");
    assert.equal(loadControlState(dir).searches.z1.widened, true);
  });
  it("the repository's opt-out stops everything before any call", async () => {
    const repo = materialize(S3);
    writeFileSync(join(repo, ".jev-flow-denylist"), "*\n");
    const caller = scriptedCaller([]);
    const r = await controlSearch({ query: QUERY }, ctxFor(repo, caller));
    assert.equal(r.status, "refused");
    assert.equal(caller.calls.length, 0);
  });
});

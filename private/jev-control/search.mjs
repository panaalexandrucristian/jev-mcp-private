// File search for the control (D9, D21-D23). rg-style scanning only produces
// candidates (the jev-flow generator, reused as is); Jev selects. There is no
// "few candidates, plain read" bypass and no lexical fallback: with candidates,
// Jev ranks them. jev_rerank is mandatory for eligibility over several files
// (relevance strictly above the threshold, compared on the raw score); jev_find
// is allowed only for a single-location lookup and is accepted only when the
// winner's probability AND `exists` are both strictly above the threshold,
// otherwise jev_rerank runs as the second logical evaluation.
//
// Every selection or ordering judgment (find, rerank, the jev_decide tie-break)
// is one logical evaluation of the same budget: at most MAX_EVALUATIONS per
// search id, persisted in state.searches[id] = {evals, widened}. An evaluation is
// reserved atomically (checked and incremented under the state lock) BEFORE its
// call is sent, so concurrent processes cannot exceed the budget; it stays
// consumed once an attempt was made (even a failed one) and is released only when
// nothing was sent (attempts 0: invalid arguments, a credential or a budget
// refusal). The same --search-id resumes with the remaining evaluations.
//
// Near-ties (gap below TIE_GAP) among the eligible hits are broken one group at a
// time with jev_decide, only as far as the evaluation budget allows. An order
// that was not established is never invented: status tie_unresolved returns only
// the established prefix (resolved_hits) and the count of withheld hits. Each call
// may be retried once by the caller; jev_calls counts the real attempts. Top_k 5,
// at most 48 fragments, a compact answer of at most 4 KB (hits that do not fit are
// dropped from the end and counted in hits_omitted, never silently). An exact path
// given by the user is read directly. Control options are never injected as fake
// files. The per-call hashes are kept under the non-enumerable `provenance` key.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buildCandidates, COMPACT_MAX_BYTES, LIMITS, RANK_RULE } from "../jev-flow/candidates.mjs";
import { loadDenylist } from "../jev-flow/paths.mjs";
import { parseDecideResult, parseRankResult } from "./contracts.mjs";
import { UNAVAILABLE } from "./client.mjs";
import { hashJson } from "./receipts.mjs";
import { withControlState } from "./state.mjs";
import { exceeds, isNearTie } from "./threshold.mjs";

export const MAX_EVALUATIONS = 2;
export const TOP_K = RANK_RULE.topK;
const MAX_TIE_GROUP = 6;

/** An exact path the user gave, resolved inside the repository: a direct read, no Jev. */
export function exactPathHit(repoRoot, path) {
  let abs = isAbsolute(path) ? path : join(repoRoot, path);
  try {
    abs = realpathSync(abs);
    const rel = relative(realpathSync(repoRoot), abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (!lstatSync(abs).isFile()) return null;
    return rel.split(sep).join("/");
  } catch {
    return null;
  }
}

const searchRecord = (state, searchId) => (state.searches[searchId] ??= { evals: 0, widened: false });

/**
 * Reserve one logical evaluation of a search, atomically: under the state lock the
 * persisted counter is checked and incremented before any call is sent.
 * {ok: true, evals} (the count including this one) or {ok: false, evals}.
 */
export function reserveEvaluation(ctx, searchId) {
  return withControlState(ctx.dir, (state) => {
    const rec = searchRecord(state, searchId);
    if (rec.evals >= MAX_EVALUATIONS) return { ok: false, evals: rec.evals };
    rec.evals += 1;
    return { ok: true, evals: rec.evals };
  }, ctx.now());
}

/** Give back a reserved evaluation whose call was never sent (attempts 0). Returns the new count. */
export function releaseEvaluation(ctx, searchId) {
  return withControlState(ctx.dir, (state) => {
    const rec = searchRecord(state, searchId);
    rec.evals = Math.max(0, rec.evals - 1);
    return rec.evals;
  }, ctx.now());
}

/** Open a search under the lock: the one widening and the evaluation budget are checked and the widening is recorded. */
function openSearch(ctx, searchId) {
  return withControlState(ctx.dir, (state) => {
    const rec = searchRecord(state, searchId);
    if (ctx.searchId && ctx.widen && rec.widened) return { ok: false, message: "the one widening of this search was already used" };
    if (rec.evals >= MAX_EVALUATIONS) return { ok: false, message: "two logical evaluations were already used for this search" };
    const widenedBefore = rec.widened;
    if (ctx.widen === true) rec.widened = true;
    return { ok: true, evals: rec.evals, widenedBefore };
  }, ctx.now());
}

/** Keep the answer within 4 KB: drop hits from the end, never silently (hits_omitted). `provenance` is not printed. */
function compact(result) {
  const key = Array.isArray(result.hits) ? "hits" : Array.isArray(result.resolved_hits) ? "resolved_hits" : null;
  const size = () => Buffer.byteLength(JSON.stringify(result)) + 1;
  if (!key) return result;
  let omitted = 0;
  while (size() > COMPACT_MAX_BYTES && result[key].length > 0) {
    result[key] = result[key].slice(0, -1);
    omitted += 1;
    result.hits_omitted = omitted;
  }
  return result;
}

function hit(entry, map) {
  const m = map[entry.id];
  return { path: m.path, start_line: m.start_line, end_line: m.end_line, sha256: m.sha256, score: entry.score };
}

/**
 * The top near-tie group of `rest` (sorted by score, descending): the first hit
 * and every following hit chained to it by gaps below TIE_GAP. Every hit after
 * the group is strictly separated from all of its members.
 */
function tieGroup(rest) {
  let n = 1;
  while (n < rest.length && isNearTie(rest[n - 1].score, rest[n].score)) n += 1;
  return rest.slice(0, n);
}

function withProvenance(result, calls) {
  Object.defineProperty(result, "provenance", { value: { calls }, enumerable: false, configurable: true, writable: true });
  return result;
}

/**
 * Search. `ctx`: {caller, session, dir, T, repoRoot, searchId?, widen?, priorities?,
 * source?, now}. Returns {status: found | tie_unresolved | none_eligible |
 * none_candidates | direct_read | refused | unavailable | budget_exhausted |
 * search_budget_exhausted | invalid, ...}. Only `hits` of a found result, and
 * `resolved_hits` of the other statuses, carry an established order.
 */
export async function controlSearch({ query, single = false, exactPath = null }, ctx) {
  const T = ctx.T;
  const denylist = loadDenylist(ctx.repoRoot);
  if (denylist.disabled) return { status: "refused", message: "the repository opts out of Jev (.jev-flow-denylist); nothing is sent" };
  if (exactPath) {
    const rel = exactPathHit(ctx.repoRoot, exactPath);
    return rel ? { status: "direct_read", hits: [{ path: rel }], jev_used: "none", note: "exact path given by the user: read it directly" } : { status: "invalid", message: "the exact path is not a file inside the repository" };
  }
  const searchId = ctx.searchId ?? hashJson([query, ctx.now()]);
  const opened = openSearch(ctx, searchId);
  if (!opened.ok) return { status: "search_budget_exhausted", search_id: searchId, message: opened.message };
  const candidates = buildCandidates({ root: ctx.repoRoot, query, limit: LIMITS.maxCandidates, chunkChars: LIMITS.maxChunkChars, single });
  if (candidates.disabled) return { status: "refused", message: candidates.reason };
  if (candidates.candidates.length === 0) {
    return { status: "none_candidates", search_id: searchId, widen_allowed: !opened.widenedBefore && !ctx.widen, message: "no candidates: widen the scope once, then report; absence is never proven by this" };
  }
  const sent = candidates.candidates.map((c) => ({ id: c.id, text: c.text }));
  const ids = sent.map((c) => c.id);
  const calls = [];
  let evals = opened.evals;
  let used = null;
  const attemptsSum = () => calls.reduce((n, c) => n + c.attempts, 0);
  // One logical evaluation: reserved before the call is sent, released only when nothing was sent.
  const evaluate = async (tool, args, source, invalid) => {
    const slot = reserveEvaluation(ctx, searchId);
    evals = slot.evals;
    if (!slot.ok) return null;
    const reply = await ctx.caller.call(ctx.session, tool, args, { source, invalid });
    const attempts = reply.attempts ?? 0;
    if (attempts === 0) evals = releaseEvaluation(ctx, searchId);
    calls.push({ tool: tool.replace(/^jev_/, ""), source, args: hashJson(args), result: reply.ok ? hashJson(reply.result) : `failed:${reply.kind}`, attempts });
    return reply;
  };
  const base = () => ({ search_id: searchId, evaluations: evals, jev_used: used, coverage_complete: candidates.coverage?.complete === true, omitted: Array.isArray(candidates.omitted) ? candidates.omitted.length : 0 });
  const finish = (result) => withProvenance(compact({ ...result, jev_calls: attemptsSum() }), calls);
  // A failed call stops the search; with a tie-break pending, only the established prefix is reported.
  const stopped = (reply, stage, prefix = null) => {
    const out = { status: "unavailable", search_id: searchId, evaluations: evals, stopped_at: stage };
    if (reply.kind === "budget") Object.assign(out, { status: "budget_exhausted", message: reply.message });
    else if (reply.kind === "invalid_args") Object.assign(out, { status: "invalid", message: reply.message });
    else if (reply.kind === "credential") Object.assign(out, { status: "refused", message: reply.message });
    else out.message = `${UNAVAILABLE}: ${String(reply.message).slice(0, 200)}`;
    if (prefix) Object.assign(out, { resolved_hits: prefix.resolved.map((e) => hit(e, candidates.map)), unresolved_count: prefix.unresolved, message: `${out.message}; the search stopped: only resolved_hits are established, the other ${prefix.unresolved} eligible hit(s) are not authorized` });
    return finish(out);
  };
  const outOfEvaluations = () => finish({ status: "search_budget_exhausted", ...base(), message: "two logical evaluations were already used for this search" });

  let eligible = null;
  let existsValue = null;
  // First logical evaluation: jev_find for one location, else jev_rerank.
  if (single) {
    const args = { query: query.slice(0, 2000), candidates: sent, top_k: TOP_K };
    const reply = await evaluate("jev_find", args, ctx.source ?? "helper", (r) => !parseRankResult("find", r, ids, TOP_K).ok);
    if (!reply) return outOfEvaluations();
    if (!reply.ok) return stopped(reply, "find");
    const parsed = parseRankResult("find", reply.result, ids, TOP_K);
    if (!parsed.ok) return stopped({ ok: false, kind: "invalid_response", message: parsed.reason }, "find");
    used = "find";
    if (exceeds(parsed.ranked[0].score, T) && exceeds(parsed.exists, T)) {
      eligible = [parsed.ranked[0]];
      existsValue = parsed.exists;
    }
  }
  if (!eligible) {
    const args = { query: query.slice(0, 2000), candidates: sent, top_k: TOP_K };
    const reply = await evaluate("jev_rerank", args, ctx.source ?? "helper", (r) => !parseRankResult("rerank", r, ids, TOP_K).ok);
    if (!reply) {
      if (used) return finish({ status: "search_budget_exhausted", ...base(), message: "no location scored strictly above the threshold and no evaluation is left" });
      return outOfEvaluations();
    }
    if (!reply.ok) return stopped(reply, "rerank");
    const parsed = parseRankResult("rerank", reply.result, ids, TOP_K);
    if (!parsed.ok) return stopped({ ok: false, kind: "invalid_response", message: parsed.reason }, "rerank");
    eligible = parsed.ranked.filter((r) => exceeds(r.score, T)).slice(0, TOP_K);
    used = "rerank";
  }
  if (eligible.length === 0) {
    return finish({ status: evals >= MAX_EVALUATIONS ? "search_budget_exhausted" : "none_eligible", ...base(), message: "no location scored strictly above the threshold" });
  }

  // Establish the order position by position. A hit strictly separated from every
  // remaining hit is placed by its score; a near-tie group needs one jev_decide,
  // whose winner (confidence strictly above T, not escaped, no warnings) is placed
  // first. Without an evaluation left, or without a confident winner, the order
  // stops at the established prefix.
  const resolved = [];
  let rest = eligible;
  let unresolvedWhy = null;
  while (rest.length > 0) {
    const group = tieGroup(rest);
    if (group.length === 1) {
      resolved.push(group[0]);
      rest = rest.slice(1);
      continue;
    }
    const tied = group.slice(0, MAX_TIE_GROUP);
    const loc = (g) => `${candidates.map[g.id].path}:${candidates.map[g.id].start_line}-${candidates.map[g.id].end_line}`;
    const byId = new Map(sent.map((c) => [c.id, c]));
    const args = {
      decision: `Which location should be read first for: ${query}`.slice(0, 1500),
      evidence: tied.map((g) => `${g.id}: ${loc(g)} ${String(byId.get(g.id).text).slice(0, 300).replace(/\s+/g, " ")}`).join("\n").slice(0, 12_000),
      priorities: ctx.priorities || "Read the location that answers the query most directly.",
      candidates: tied.map((g) => ({ id: g.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z]/, "c_$&").slice(0, 64), description: loc(g) })),
    };
    const slugIds = args.candidates.map((c) => c.id);
    if (new Set(slugIds).size !== slugIds.length || tied.length !== group.length) {
      unresolvedWhy = "the near-tied hits cannot be presented to a tie-break";
      break;
    }
    const reply = await evaluate("jev_decide", args, "tiebreak", (r) => !parseDecideResult(r, slugIds).ok);
    if (!reply) {
      unresolvedWhy = "no logical evaluation is left for the tie-break";
      break;
    }
    const prefix = { resolved, unresolved: eligible.length - resolved.length };
    if (!reply.ok) return stopped(reply, "tiebreak", prefix);
    const pd = parseDecideResult(reply.result, slugIds);
    if (!pd.ok) return stopped({ ok: false, kind: "invalid_response", message: pd.reason }, "tiebreak", prefix);
    if (pd.escaped || !exceeds(pd.confidence, T) || pd.warnings.length > 0) {
      unresolvedWhy = "the tie-break did not pick a winner with confidence strictly above the threshold";
      break;
    }
    const winner = tied[slugIds.indexOf(pd.selected)];
    resolved.push(winner);
    rest = rest.filter((r) => r.id !== winner.id);
  }
  if (unresolvedWhy) {
    const unresolved = eligible.length - resolved.length;
    return finish({
      status: "tie_unresolved",
      ...base(),
      resolved_hits: resolved.map((e) => hit(e, candidates.map)),
      unresolved_count: unresolved,
      message: `${unresolvedWhy}; only resolved_hits are established, the other ${unresolved} eligible hit(s) are near-tied or ranked below a near-tie and are not ordered`,
    });
  }
  return finish({
    status: "found",
    ...base(),
    ...(existsValue !== null ? { exists: existsValue } : {}),
    hits: resolved.map((e) => hit(e, candidates.map)),
  });
}

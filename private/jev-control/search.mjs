// File search for the control (D9, D21-D23). rg-style scanning only produces
// candidates (the jev-flow generator, reused as is); Jev selects. There is no
// "few candidates, plain read" bypass and no lexical fallback: with candidates,
// Jev ranks them. jev_rerank is mandatory for eligibility over several files
// (relevance strictly above the threshold); jev_find is allowed only for a
// single-location lookup and is accepted only when the winner's probability AND
// `exists` are both strictly above the threshold, otherwise jev_rerank runs as
// the second logical evaluation. At most two logical evaluations per search
// (each with its own single transport retry); top_k 5, at most 48 fragments, a
// compact answer of at most 4 KB. An exact path given by the user is read
// directly. Control options are never injected as fake files.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buildCandidates, COMPACT_MAX_BYTES, LIMITS, RANK_RULE } from "../jev-flow/candidates.mjs";
import { loadDenylist } from "../jev-flow/paths.mjs";
import { parseDecideResult, parseRankResult } from "./contracts.mjs";
import { isUnavailable, UNAVAILABLE } from "./client.mjs";
import { hashJson } from "./receipts.mjs";
import { loadControlState, withControlState } from "./state.mjs";
import { exceeds, isNearTie } from "./threshold.mjs";

export const MAX_EVALUATIONS = 2;
export const TOP_K = RANK_RULE.topK;
const round4 = (x) => Number(x.toFixed(4));

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

function compact(result) {
  let out = JSON.stringify(result);
  while (Buffer.byteLength(out) + 1 > COMPACT_MAX_BYTES && result.hits?.length > 1) {
    result.hits = result.hits.slice(0, -1);
    result.truncated = true;
    out = JSON.stringify(result);
  }
  return result;
}

function hit(entry, map, score) {
  const m = map[entry.id];
  return { path: m.path, start_line: m.start_line, end_line: m.end_line, sha256: m.sha256, score: round4(score) };
}

/**
 * Search. `ctx`: {caller, session, dir, T, repoRoot, searchId?, widen?, now}. Returns
 * {status: found | none_eligible | none_candidates | direct_read | refused |
 * unavailable | budget_exhausted | search_budget_exhausted | invalid, ...}.
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
  const record = loadControlState(ctx.dir).searches[searchId] ?? { evals: 0, widened: false };
  if (ctx.searchId && ctx.widen && record.widened) return { status: "search_budget_exhausted", search_id: searchId, message: "the one widening of this search was already used" };
  if (record.evals >= MAX_EVALUATIONS) return { status: "search_budget_exhausted", search_id: searchId, message: "two logical evaluations were already used for this search" };
  const candidates = buildCandidates({ root: ctx.repoRoot, query, limit: LIMITS.maxCandidates, chunkChars: LIMITS.maxChunkChars, single });
  if (candidates.disabled) return { status: "refused", message: candidates.reason };
  const note = (evals, widened) => withControlState(ctx.dir, (state) => {
    state.searches[searchId] = { evals, widened };
  }, ctx.now());
  if (candidates.candidates.length === 0) {
    note(record.evals, record.widened || ctx.widen === true);
    return { status: "none_candidates", search_id: searchId, widen_allowed: !record.widened && !ctx.widen, message: "no candidates: widen the scope once, then report; absence is never proven by this" };
  }
  const sent = candidates.candidates.map((c) => ({ id: c.id, text: c.text }));
  const ids = sent.map((c) => c.id);
  const calls = [];
  let evals = record.evals;
  const call = async (tool, args, source, invalid) => {
    const reply = await ctx.caller.call(ctx.session, tool, args, { source, invalid });
    calls.push({ tool: tool.replace(/^jev_/, ""), source, args: hashJson(args), result: reply.ok ? hashJson(reply.result) : `failed:${reply.kind}`, attempts: reply.attempts ?? 0 });
    return reply;
  };
  const stopped = (reply) => {
    note(evals, record.widened || ctx.widen === true);
    if (reply.kind === "budget") return { status: "budget_exhausted", search_id: searchId, message: reply.message, jev_calls: calls };
    if (reply.kind === "invalid_args") return { status: "invalid", search_id: searchId, message: reply.message };
    if (reply.kind === "credential") return { status: "refused", search_id: searchId, message: reply.message };
    return { status: "unavailable", search_id: searchId, message: `${UNAVAILABLE}: ${String(reply.message).slice(0, 200)}`, jev_calls: calls };
  };
  let eligible = null;
  let used = null;
  let existsValue = null;
  // First logical evaluation: jev_find for one location, else jev_rerank.
  if (single && evals < MAX_EVALUATIONS) {
    evals += 1;
    const args = { query: query.slice(0, 2000), candidates: sent, top_k: TOP_K };
    const reply = await call("jev_find", args, ctx.source ?? "helper", (r) => !parseRankResult("find", r, ids, TOP_K).ok);
    if (!reply.ok) return stopped(reply);
    const parsed = parseRankResult("find", reply.result, ids, TOP_K);
    if (!parsed.ok) return stopped({ ok: false, kind: "invalid_response", message: parsed.reason });
    if (exceeds(parsed.ranked[0].score, T) && exceeds(parsed.exists, T)) {
      eligible = [parsed.ranked[0]];
      used = "find";
      existsValue = parsed.exists;
    }
  }
  if (!eligible && evals < MAX_EVALUATIONS) {
    evals += 1;
    const args = { query: query.slice(0, 2000), candidates: sent, top_k: TOP_K };
    const reply = await call("jev_rerank", args, ctx.source ?? "helper", (r) => !parseRankResult("rerank", r, ids, TOP_K).ok);
    if (!reply.ok) return stopped(reply);
    const parsed = parseRankResult("rerank", reply.result, ids, TOP_K);
    if (!parsed.ok) return stopped({ ok: false, kind: "invalid_response", message: parsed.reason });
    eligible = parsed.ranked.filter((r) => exceeds(r.score, T));
    used = "rerank";
    const near = eligible.length >= 2 && eligible.filter((r) => isNearTie(eligible[0].score, r.score));
    if (near && near.length >= 2) {
      // A near-tie among the top files goes through one tie-break inside the same shared budget.
      const group = near.slice(0, 6);
      const byId = new Map(sent.map((c) => [c.id, c]));
      const args2 = {
        decision: `Which location should be read first for: ${query}`.slice(0, 1500),
        evidence: group.map((g) => `${g.id}: ${candidates.map[g.id].path}:${candidates.map[g.id].start_line}-${candidates.map[g.id].end_line} ${String(byId.get(g.id).text).slice(0, 300).replace(/\s+/g, " ")}`).join("\n").slice(0, 12_000),
        priorities: ctx.priorities || "Read the location that answers the query most directly.",
        candidates: group.map((g) => ({ id: g.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z]/, "c_$&").slice(0, 64), description: `${candidates.map[g.id].path}:${candidates.map[g.id].start_line}-${candidates.map[g.id].end_line}` })),
      };
      const slugIds = args2.candidates.map((c) => c.id);
      const reply2 = new Set(slugIds).size === slugIds.length ? await call("jev_decide", args2, "tiebreak", (r) => !parseDecideResult(r, slugIds).ok) : null;
      if (reply2?.ok) {
        const pd = parseDecideResult(reply2.result, slugIds);
        if (pd.ok && !pd.escaped && exceeds(pd.confidence, T) && pd.warnings.length === 0) {
          const winner = group[slugIds.indexOf(pd.selected)];
          eligible = [winner, ...eligible.filter((r) => r.id !== winner.id)];
        } else eligible.tie_unresolved = true;
      } else if (reply2 && reply2.kind === "budget") {
        eligible.tie_unresolved = true;
      } else eligible.tie_unresolved = true;
    }
  }
  note(evals, record.widened || ctx.widen === true);
  const base = { search_id: searchId, evaluations: evals, jev_used: used, jev_calls: calls, coverage_complete: candidates.coverage?.complete === true, omitted: Array.isArray(candidates.omitted) ? candidates.omitted.length : 0 };
  if (!eligible || eligible.length === 0) {
    return { status: evals >= MAX_EVALUATIONS ? "search_budget_exhausted" : "none_eligible", ...base, message: "no location scored strictly above the threshold" };
  }
  const out = {
    status: "found",
    ...base,
    ...(existsValue !== null ? { exists: round4(existsValue) } : {}),
    ...(eligible.tie_unresolved ? { tie_unresolved: true } : {}),
    hits: eligible.slice(0, TOP_K).map((e) => hit(e, candidates.map, e.score)),
  };
  delete out.jev_calls;
  out.jev_calls = calls.length;
  return compact(out);
}

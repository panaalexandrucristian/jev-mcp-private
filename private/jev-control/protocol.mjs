// The jev-control decision protocol (D4-D8, D20). A validated option batch goes
// to jev_noul as one independent proposition per option; an option is eligible
// only when its raw probability is strictly above the session threshold. The
// eligible options are ordered by that score. Near-equal scores (gap < 0.02) or
// mutually exclusive top options go to successive jev_decide selections over at
// most six options, each accepted only with confidence strictly above the
// threshold; a cut at six with a tie on the boundary goes through a jev_rerank
// "should come first" pass over all the tied options. Nothing eligible: at most
// two expansion rounds with genuinely new material, then ask the user (headless:
// stop with a report that starts "Incomplete:"). Nothing below the threshold is
// executed without a recorded user approval. Jev unavailable (after the single
// identical retry) stops the step; there is no silent continuation.
import { evaluatePreconditions, planItem, shortHash } from "./actions.mjs";
import { parseDecideResult, parseNoulResult, parseRankResult } from "./contracts.mjs";
import { isUnavailable, UNAVAILABLE } from "./client.mjs";
import { ASK_ID, CONTROL_IDS, EXCLUSIVE_KINDS, GATHER_ID, optionActionHash, optionHash } from "./options.mjs";
import { hashJson } from "./receipts.mjs";
import { loadControlState, withControlState } from "./state.mjs";
import { exceeds, isNearTie } from "./threshold.mjs";

export const MAX_EXPANSIONS = 2;
export const SHORTLIST = 6;
const SAME = 1e-9;
const clip = (text, n) => String(text).slice(0, n);
/** The concrete action an option stands for, as a short phrase Jev can judge (empty when it names none). */
const actionPhrase = (o) => (o.action ? ` Concrete action: ${o.action.tool}${o.action.target ? ` ${clip(o.action.target, 300)}` : ""}.` : "");

export class StopDecision extends Error {
  constructor(result) {
    super(result.status);
    this.result = result;
  }
}

/** Map a failed Jev reply to a decision result (or throw it). */
function failure(reply, extra = {}) {
  if (reply.kind === "budget") return { status: "budget_exhausted", message: reply.message, ...extra };
  if (reply.kind === "invalid_args") return { status: "invalid", message: reply.message, problems: reply.problems, ...extra };
  if (reply.kind === "credential") return { status: "refused", message: reply.message, ...extra };
  if (isUnavailable(reply)) return { status: "unavailable", message: `${UNAVAILABLE}: ${String(reply.message).slice(0, 200)}`, ...extra };
  return { status: "unavailable", message: `${UNAVAILABLE}: ${String(reply.message ?? reply.kind).slice(0, 200)}`, ...extra };
}

function propositionFor(batch, option) {
  return `Taking option ${option.id} is the right next step for this decision: ${batch.decision} — Option: ${option.text}${actionPhrase(option)}`.slice(0, 2000);
}

function evidenceBlock(options, maxChars) {
  const lines = [];
  let used = 0;
  for (const o of options) {
    const text = `Option ${o.id}: ${o.evidence.join(" | ")}${actionPhrase(o)}`;
    if (used + text.length + 1 > maxChars) break;
    lines.push(text);
    used += text.length + 1;
  }
  return lines.join("\n");
}

/** Run one Jev call, recording argument and result hashes for the receipt. */
async function jev(ctx, name, args, { invalid, source }) {
  const reply = await ctx.caller.call(ctx.session, name, args, { invalid, source });
  ctx.calls.push({ tool: name.replace(/^jev_/, ""), source, args: hashJson(args), result: reply.ok ? hashJson(reply.result) : `failed:${reply.kind}`, attempts: reply.attempts ?? 0 });
  ctx.attempts += reply.attempts ?? 0;
  return reply;
}

/** Cut a tie group to the shortlist; a tie on the boundary is resolved by jev_rerank over every tied option. */
async function shortlistOf(group, batch, ctx) {
  if (group.length <= SHORTLIST) return group;
  const boundary = group[SHORTLIST - 1].score;
  if (group[SHORTLIST].score < boundary - SAME) return group.slice(0, SHORTLIST);
  const above = group.filter((g) => g.score > boundary + SAME);
  const tied = group.filter((g) => Math.abs(g.score - boundary) <= SAME);
  const need = SHORTLIST - above.length;
  const args = { query: `Which option should come first for this decision: ${batch.decision}`.slice(0, 2000), candidates: tied.map((t) => ({ id: t.id, text: `${t.text}${actionPhrase(t)}`.slice(0, 2000) })), top_k: tied.length };
  const ids = tied.map((t) => t.id);
  const reply = await jev(ctx, "jev_rerank", args, { source: "tiebreak", invalid: (r) => !parseRankResult("rerank", r, ids, tied.length).ok });
  if (!reply.ok) throw new StopDecision(failure(reply));
  const ranked = parseRankResult("rerank", reply.result, ids, tied.length);
  if (!ranked.ok) throw new StopDecision(failure({ ok: false, kind: "invalid_response", message: ranked.reason }));
  if (ranked.ranked[need - 1].score - ranked.ranked[need].score < SAME) throw new StopDecision({ status: "tie_unresolved", message: "the options tied at the shortlist boundary could not be separated" });
  const byId = new Map(tied.map((t) => [t.id, t]));
  return [...above, ...ranked.ranked.slice(0, need).map((r) => byId.get(r.id))];
}

/** One jev_decide selection over a tie group: the winner, strictly above the threshold, or a stop. */
async function selectFrom(group, batch, ctx) {
  const shortlist = await shortlistOf(group, batch, ctx);
  const args = {
    decision: batch.decision,
    evidence: evidenceBlock(shortlist, 12_000) || "No further evidence.",
    priorities: ctx.priorities,
    candidates: shortlist.map((o) => ({ id: o.id, description: `${o.text}${actionPhrase(o)}`.slice(0, 2000) })),
  };
  const ids = shortlist.map((o) => o.id);
  const reply = await jev(ctx, "jev_decide", args, { source: "tiebreak", invalid: (r) => !parseDecideResult(r, ids).ok });
  if (!reply.ok) throw new StopDecision(failure(reply));
  const parsed = parseDecideResult(reply.result, ids);
  if (!parsed.ok) throw new StopDecision(failure({ ok: false, kind: "invalid_response", message: parsed.reason }));
  ctx.tiebreaks += 1;
  if (parsed.escaped) {
    // ask_user stops and asks; investigate and none are expansion rounds.
    throw new StopDecision({ status: parsed.selected === "ask_user" ? "ask_user" : "expand", reason: `decide_escaped_${parsed.selected}` });
  }
  if (!exceeds(parsed.confidence, ctx.T) || parsed.warnings.length > 0) {
    throw new StopDecision({ status: "below_threshold", reason: parsed.warnings.length ? "decide_warnings" : "decide_confidence_not_above_threshold", confidence: parsed.confidence });
  }
  return shortlist.find((o) => o.id === parsed.selected);
}

/** The ordered execution plan for `eligible` (sorted descending by score). */
async function plan(eligible, batch, ctx) {
  const exclusive = EXCLUSIVE_KINDS.includes(batch.kind);
  if (exclusive) {
    const first = eligible.length >= 2 ? await selectFrom(eligible, batch, ctx) : eligible[0];
    const reserves = eligible.filter((e) => e.id !== first.id);
    return { status: "selected", placed: [first, ...reserves], exclusive: true };
  }
  const placed = [];
  let remaining = [...eligible];
  while (remaining.length) {
    const top = remaining[0];
    const group = remaining.filter((r) => isNearTie(top.score, r.score));
    let next = top;
    if (group.length >= 2) {
      try {
        next = await selectFrom(group, batch, ctx);
      } catch (error) {
        if (!(error instanceof StopDecision) || placed.length === 0 || !["budget_exhausted", "unavailable"].includes(error.result.status)) throw error;
        // The resolved prefix stays; the unresolved part stops without an invented order.
        return { status: "ordered", placed, unresolved: remaining.map((r) => r.id), stopped: error.result, exclusive: false };
      }
    }
    placed.push(next);
    remaining = remaining.filter((r) => r.id !== next.id);
  }
  return { status: "ordered", placed, exclusive: false };
}

/** A plan item: the option, what to do with it, its RAW score and the short hash of its action descriptor (null: no action). */
function item(o, action) {
  const full = optionActionHash(o);
  return { id: o.id, action, score: o.score, ah: full ? shortHash(full) : null };
}

function toPlan(placedResult) {
  const { placed, exclusive } = placedResult;
  const items = [];
  if (exclusive) {
    // Only the first option runs; the rest are ordered reserves, never an automatic fallback.
    placed.forEach((o, index) => items.push(item(o, index === 0 ? (CONTROL_IDS.includes(o.id) ? "suspend" : "execute") : "reserve")));
    return items;
  }
  let suspended = false;
  for (const o of placed) {
    if (suspended) items.push(item(o, "after_suspend"));
    else if (CONTROL_IDS.includes(o.id)) {
      suspended = true;
      items.push(item(o, "suspend"));
    } else items.push(item(o, "execute"));
  }
  return items;
}

/** Raw probabilities by option id (never rounded: the strict comparison and the audit use these numbers). */
function scoresOf(options, scores) {
  return Object.fromEntries(options.map((o, i) => [o.id, scores[i]]));
}

/** Build the final report line for a stop that needs the user (headless: it starts with "Incomplete:"). */
function reportFor(headless, T, expansions, scores) {
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, p]) => `${id}=${p}`).join(", ");
  const line = `no option exceeded T=${T} after ${expansions} expansion round(s); scores: ${top}`;
  return headless ? `Incomplete: ${line}` : line;
}

/**
 * Run one decision round. `ctx`: {caller, session, dir, T, priorities, headless,
 * decisionId?, now, snapshot, source (budget source of the scoring call: helper by default, subagent
 * when a subagent runs the helper; tie-breaks are always `tiebreak`)}. Returns the result
 * object (status selected | ordered | expand | ask_user | incomplete | refused |
 * invalid | unavailable | budget_exhausted | tie_unresolved) and appends the
 * metadata-only log entry to the session state.
 */
export async function runDecision(batch, rawCtx) {
  const ctx = { ...rawCtx, calls: [], attempts: 0, tiebreaks: 0 };
  const T = ctx.T;
  if (!ctx.priorities) return { status: "invalid", message: "priorities are required: pass them in the batch or set them at activation", decision_id: ctx.decisionId ?? null };
  const key = ctx.decisionId ?? hashJson([batch.decision, ctx.now()]);
  const evidenceHashes = batch.options.map((o) => optionHash(o));
  const fullHashes = batch.options.map((o) => optionHash(o, 64));
  // Expansion bookkeeping: a repeated decision id is an expansion round and needs genuinely new material.
  let round = 0;
  const known = loadControlState(ctx.dir).expansions[key] ?? null;
  if (known) {
    if (known.n >= MAX_EXPANSIONS) return { status: ctx.headless ? "incomplete" : "ask_user", decision_id: key, reason: "expansions_exhausted", report: reportFor(ctx.headless, T, known.n, {}) };
    const fresh = batch.options.filter((o, i) => !known.hashes.includes(evidenceHashes[i]));
    if (!batch.new_material || fresh.length === 0) {
      return { status: "refused", decision_id: key, reason: "no_new_material", message: "an expansion round needs new options or new evidence and a new_material note; rephrasing the same options is refused" };
    }
    round = known.n + 1;
  }
  const result = await decideOnce(batch, { ...ctx, key, round, evidenceHashes, fullHashes });
  return result;
}

async function decideOnce(batch, ctx) {
  const { T, key, round } = ctx;
  const unavailable = [];
  const finish = (status, extra = {}, scores = {}, planItems = []) => {
    const result = {
      status, decision_id: key, kind: batch.kind, threshold: T, round, calls: ctx.attempts, tiebreaks: ctx.tiebreaks, scores, plan: planItems,
      ...(unavailable.length ? { unavailable: unavailable.map((u) => `${u.id}:${u.reason}`) } : {}),
      ...extra,
      // Not printed (the CLI strips it): what the receipt binds, in full.
      provenance: {
        t: T,
        round,
        options: batch.options.map((o, i) => ({ id: o.id, oh: ctx.fullHashes[i], ah: optionActionHash(o), action: o.action ? { tool: o.action.tool, target: clip(o.action.target, 120) } : null, pre: o.preconditions ?? [], score: scores[o.id] ?? null, unavailable: unavailable.find((u) => u.id === o.id)?.reason ?? null })),
        calls: ctx.calls,
        tiebreaks: ctx.tiebreaks,
      },
    };
    withControlState(ctx.dir, (state) => {
      const exp = state.expansions[key] ?? { n: 0, hashes: [] };
      exp.n = round;
      exp.hashes = [...new Set([...exp.hashes, ...ctx.evidenceHashes])].slice(-80);
      state.expansions[key] = exp;
      state.decisions.push({
        id: key,
        req: state.request.seq,
        ts: ctx.now(),
        kind: batch.kind,
        t: T,
        status,
        round,
        opts: batch.options.map((o, i) => [o.id, scores[o.id] ?? null, ctx.evidenceHashes[i].slice(0, 8), o.action ? shortHash(optionActionHash(o)) : "-"]).slice(0, 20),
        order: planItems.map((p) => planItem(p)).slice(0, 20),
        calls: ctx.attempts,
        tb: ctx.tiebreaks,
        snap: ctx.snapshot ? String(ctx.snapshot).slice(0, 16) : null,
      });
    }, ctx.now());
    return result;
  };
  // 0. Availability: an option whose preconditions do not hold now (or cannot be evaluated) is not scored.
  const usable = batch.options.filter((o) => {
    if (!o.preconditions?.length) return true;
    if (!ctx.repoRoot) return (unavailable.push({ id: o.id, reason: "preconditions_not_evaluable" }), false);
    const check = evaluatePreconditions(o.preconditions, ctx.repoRoot);
    if (!check.ok) unavailable.push({ id: o.id, reason: `${check.failed[0].kind}_${check.failed[0].reason}` });
    return check.ok;
  });
  const expansionsLeft = MAX_EXPANSIONS - round;
  const stopForUser = (reason, extra = {}) => {
    const status = ctx.headless ? "incomplete" : "ask_user";
    return finish(status, { reason, report: reportFor(ctx.headless, T, round, scoreOf), ...extra }, scoreOf);
  };
  const expandOrAsk = (reason, extra = {}) => (expansionsLeft > 0 ? finish("expand", { reason, expansions_left: expansionsLeft, ...extra }, scoreOf) : stopForUser(reason, extra));
  let scoreOf = {};
  if (!usable.some((o) => !o.control)) return expandOrAsk("all_options_unavailable");
  // 1. Independent probabilities.
  const n = usable.length;
  const args = {
    propositions: usable.map((o) => propositionFor(batch, o)),
    context: [
      ...usable.map((o, i) => ({ id: `evidence_${i}`, text: `Option ${o.id}: ${o.evidence.join(" | ")}${actionPhrase(o)}`.slice(0, 2000) })),
      { id: "priorities", text: ctx.priorities.slice(0, 2000) },
    ],
    auto_accept: T,
  };
  const reply = await jev(ctx, "jev_noul", args, { source: ctx.source ?? "helper", invalid: (r) => !parseNoulResult(r, n, args.propositions).ok });
  if (!reply.ok) return { ...failure(reply), decision_id: key, calls: ctx.attempts };
  const parsed = parseNoulResult(reply.result, n, args.propositions);
  if (!parsed.ok) return { ...failure({ ok: false, kind: "invalid_response", message: parsed.reason }), decision_id: key, calls: ctx.attempts };
  scoreOf = scoresOf(usable, parsed.probabilities);
  const scored = usable.map((o, i) => ({ ...o, score: parsed.probabilities[i], index: i }));
  // 2. Eligibility: strictly above the threshold, on the raw probability (the tool's label is ignored).
  const eligible = scored.filter((o) => exceeds(o.score, T)).sort((a, b) => b.score - a.score || a.index - b.index);
  if (eligible.length === 0) return expandOrAsk("none_above_threshold");
  // 3. Ordering / selection.
  let placedResult;
  try {
    placedResult = await plan(eligible, batch, ctx);
  } catch (error) {
    if (!(error instanceof StopDecision)) throw error;
    const r = error.result;
    if (r.status === "expand") return expandOrAsk(r.reason);
    if (r.status === "ask_user") return stopForUser(r.reason);
    if (r.status === "below_threshold" || r.status === "tie_unresolved") return expandOrAsk(r.reason ?? r.status, r.confidence !== undefined ? { confidence: r.confidence } : {});
    return finish(r.status, { message: r.message, ...(r.problems ? { problems: r.problems } : {}) }, scoreOf);
  }
  const planItems = toPlan(placedResult);
  const first = planItems[0];
  // The first placed item is a control option: nothing is executed; this round gathers evidence or asks.
  if (first.action === "suspend") {
    return first.id === ASK_ID ? stopForUser("control_ask_user_selected") : expandOrAsk("control_gather_evidence_selected");
  }
  const extra = {};
  if (placedResult.unresolved) {
    extra.unresolved = placedResult.unresolved;
    extra.stopped = placedResult.stopped.status;
    extra.message = placedResult.stopped.message;
  }
  const status = placedResult.unresolved ? (placedResult.stopped.status === "unavailable" ? "unavailable" : "budget_exhausted") : placedResult.status;
  const suspendAt = planItems.find((p) => p.action === "suspend");
  if (suspendAt) extra.suspend_at = suspendAt.id;
  return finish(status, extra, scoreOf, planItems);
}

export { ASK_ID, GATHER_ID };

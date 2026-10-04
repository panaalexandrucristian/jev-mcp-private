// The jev-control decision protocol (D4-D8, D20). A validated option batch goes
// to jev_noul as one independent proposition per option; an option is eligible
// only when its raw probability is strictly above the session threshold. The
// eligible options are ordered by that score. Near-equal scores (gap < 0.02) or
// mutually exclusive top options go to successive jev_decide selections over at
// most six options, each accepted only with confidence strictly above the
// threshold; a cut at six with a tie on the boundary goes through a jev_rerank
// "should come first" pass over all the tied options. Nothing eligible in round 0
// of an interactive session: ask the user at once with a one-option question,
// unless an expansion is requested (--expand, or the same decision id with new
// material). Headless, and after a requested expansion: at most two expansion
// rounds, then ask (headless: stop with a report that starts "Incomplete:"). Nothing below the threshold is
// executed without a recorded user approval. Jev unavailable (after the single
// identical retry) stops the step; there is no silent continuation.
import { sanitizeText } from "../jev-flow/sanitize.mjs";
import { actionMaterial, actionRecord, dependencyPaths, evaluatePreconditions, fingerprintPaths, planItem, shortHash } from "./actions.mjs";
import { LIMITS, parseDecideResult, parseNoulResult, parseRankResult } from "./contracts.mjs";
import { isUnavailable, UNAVAILABLE } from "./client.mjs";
import { ASK_ID, CONTROL_IDS, EXCLUSIVE_KINDS, GATHER_ID, optionActionHash, optionHash } from "./options.mjs";
import { hashJson } from "./receipts.mjs";
import { loadControlState, withControlState } from "./state.mjs";
import { exceeds, isNearTie } from "./threshold.mjs";

export const MAX_EXPANSIONS = 2;
export const SHORTLIST = 6;
const SAME = 1e-9;
// What Jev judges, and what is only kept. The concrete action an option stands for (tool, exact target, every argument IN
// FULL) is sanitized and sent whole as its own context item or evidence block: a head or a prefix is never enough, because
// the decisive part of a command or a payload can come after it. What does not fit a call is not shortened: a batch is
// split over several jev_noul calls, and a tie-break whose material does not fit stops without choosing. What stays behind
// (the receipt, the state, the plan) holds only hashes and compact labels (actions.mjs).
/** Characters of one jev_noul call (propositions plus context) the control fills at most; the tool's own limit is 150000. */
const NOUL_CHUNK_CHARS = 120_000;
/** The context item that carries the decision when it does not fit inside the proposition. */
const DECISION_ITEM = "decision";

/** The whole sanitized concrete material of an option's action: {text, omitted}; omitted when sanitizing had to drop a line (then it cannot be shown whole). */
function materialOf(option) {
  if (!option.action) return null;
  const sanitized = sanitizeText(actionMaterial(option.action));
  return { text: sanitized.text, omitted: sanitized.omitted_lines > 0 };
}

const stopTooLarge = (what) => new StopDecision({ status: "tie_unresolved", reason: "action_material_too_large", message: `${what}: the concrete action material of the options does not fit in one Jev call, and nothing Jev did not read may be authorized` });

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
  const tail = ` — Option: ${option.text}${option.action ? ` Its concrete action, in full, is the context item "action_${option.id}".` : ""}`;
  const inline = `Taking option ${option.id} is the right next step for this decision: ${batch.decision}${tail}`;
  return inline.length <= LIMITS.noulPropositionChars ? inline : `Taking option ${option.id} is the right next step for the decision stated in the context item "${DECISION_ITEM}"${tail}`;
}

/** The evidence of the tied options and, after each, the whole concrete action it stands for. */
function evidenceBlock(options, ctx) {
  return options.map((o) => `Option ${o.id}: ${o.evidence.join(" | ")}${o.action ? `\nConcrete action of option ${o.id}:\n${ctx.materials.get(o.id).text}` : ""}`).join("\n");
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
  const candidates = tied.map((t) => ({ id: t.id, text: `${t.text}${t.action ? `\nConcrete action:\n${ctx.materials.get(t.id).text}` : ""}` }));
  if (candidates.some((c) => c.text.length > LIMITS.candidateChars)) throw stopTooLarge("tie at the shortlist boundary");
  const args = { query: `Which option should come first for this decision: ${batch.decision}`.slice(0, LIMITS.rerankQueryChars), candidates, top_k: tied.length };
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
  const evidence = evidenceBlock(shortlist, ctx);
  if (evidence.length > LIMITS.decideEvidenceChars) throw stopTooLarge("tie-break");
  const args = {
    decision: batch.decision,
    evidence: evidence || "No further evidence.",
    priorities: ctx.priorities,
    candidates: shortlist.map((o) => ({ id: o.id, description: `${o.text}${o.action ? ` (Its concrete action, in full, is in the evidence under "Concrete action of option ${o.id}".)` : ""}` })),
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
  // The evidence each option depends on (its target path and its precondition paths), fingerprinted with the snapshot: a
  // later step of the plan is authorized only while that evidence is unchanged (receipts.mjs).
  const deps = new Map(batch.options.map((o) => [o.id, ctx.repoRoot ? fingerprintPaths(ctx.repoRoot, dependencyPaths(o)) : {}]));
  const finish = (status, extra = {}, scores = {}, planItems = []) => {
    const result = {
      status, decision_id: key, kind: batch.kind, threshold: T, round, calls: ctx.attempts, tiebreaks: ctx.tiebreaks, scores, plan: planItems,
      ...(unavailable.length ? { unavailable: unavailable.map((u) => `${u.id}:${u.reason}`) } : {}),
      ...extra,
      // Not printed (the CLI strips it): what the receipt binds, in full.
      provenance: {
        t: T,
        round,
        options: batch.options.map((o, i) => ({ id: o.id, oh: ctx.fullHashes[i], ah: optionActionHash(o), action: o.action ? actionRecord(o.action) : null, pre: o.preconditions ?? [], dep: deps.get(o.id) ?? {}, score: scores[o.id] ?? null, unavailable: unavailable.find((u) => u.id === o.id)?.reason ?? null })),
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
  ctx.materials = new Map(batch.options.filter((o) => o.action).map((o) => [o.id, materialOf(o)]));
  const usable = batch.options.filter((o) => {
    // An action Jev cannot be shown whole (sanitizing dropped a line) is never scored, so never authorized.
    if (ctx.materials.get(o.id)?.omitted) return (unavailable.push({ id: o.id, reason: "action_material_omitted" }), false);
    if (!o.preconditions?.length) return true;
    if (!ctx.repoRoot) return (unavailable.push({ id: o.id, reason: "preconditions_not_evaluable" }), false);
    const check = evaluatePreconditions(o.preconditions, ctx.repoRoot);
    if (!check.ok) unavailable.push({ id: o.id, reason: `${check.failed[0].kind}_${check.failed[0].reason}` });
    return check.ok;
  });
  const expansionsLeft = MAX_EXPANSIONS - round;
  const stopForUser = (reason, extra = {}) => {
    const status = ctx.headless ? "incomplete" : "ask_user";
    // The one-option question a bare "yes" can answer (approve needs a question naming ONE option).
    const top = Object.entries(scoreOf).filter(([id]) => !CONTROL_IDS.includes(id)).sort((a, b) => b[1] - a[1])[0];
    const ask = !ctx.headless && top ? { ask: `Approve ${top[0]}?` } : {};
    return finish(status, { reason, report: reportFor(ctx.headless, T, round, scoreOf), ...ask, ...extra }, scoreOf);
  };
  // Early ask (interactive only): in real sessions an expansion round almost never lifted an option above T nor changed
  // the winner, so a round 0 with nothing eligible asks at once; an expansion is still available with --expand, or later
  // with the same decision id and new material. Headless keeps the rounds: nobody can answer, and there an expansion did
  // reach a plan. Jev choosing to gather evidence, and an unresolved tie, still expand.
  const expandOrAsk = (reason, extra = {}) => {
    if (expansionsLeft <= 0) return stopForUser(reason, extra);
    if (reason === "none_above_threshold" && round === 0 && !ctx.headless && ctx.expand !== true) return stopForUser(reason, { expansions_left: expansionsLeft, ...extra });
    return finish("expand", { reason, expansions_left: expansionsLeft, ...extra }, scoreOf);
  };
  let scoreOf = {};
  if (!usable.some((o) => !o.control)) return expandOrAsk("all_options_unavailable");
  // 1. Independent probabilities, over as many jev_noul calls as the whole material needs (each option is judged on its own).
  const costOf = (o) => propositionFor(batch, o).length + o.evidence.join(" | ").length + (ctx.materials.get(o.id)?.text.length ?? 0) + 100;
  const chunks = [];
  let sum = 0;
  for (const o of usable) {
    if (chunks.length === 0 || sum + costOf(o) > NOUL_CHUNK_CHARS) {
      chunks.push([]);
      sum = 0;
    }
    chunks[chunks.length - 1].push(o);
    sum += costOf(o);
  }
  const probabilities = [];
  for (const chunk of chunks) {
    const propositions = chunk.map((o) => propositionFor(batch, o));
    const context = propositions.some((p) => p.includes(`context item "${DECISION_ITEM}"`)) ? [{ id: DECISION_ITEM, text: batch.decision }] : [];
    chunk.forEach((o, i) => {
      context.push({ id: `evidence_${i}`, text: `Option ${o.id}: ${o.evidence.join(" | ")}` });
      if (o.action) context.push({ id: `action_${o.id}`, text: ctx.materials.get(o.id).text });
    });
    context.push({ id: "priorities", text: ctx.priorities.slice(0, 2000) });
    const args = { propositions, context, auto_accept: T };
    const reply = await jev(ctx, "jev_noul", args, { source: ctx.source ?? "helper", invalid: (r) => !parseNoulResult(r, chunk.length, propositions).ok });
    if (!reply.ok) return { ...failure(reply), decision_id: key, calls: ctx.attempts };
    const parsed = parseNoulResult(reply.result, chunk.length, propositions);
    if (!parsed.ok) return { ...failure({ ok: false, kind: "invalid_response", message: parsed.reason }), decision_id: key, calls: ctx.attempts };
    probabilities.push(...parsed.probabilities);
  }
  const parsed = { probabilities };
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

// The shared Jev call budget of one user request (D15, D26): at most 10000 MCP
// tools/call ATTEMPTS from every source (main thread, subagents, helpers, gate
// runner parts, tie-breaks), retries included. A slot is reserved atomically
// BEFORE the request is sent, so once the limit is reached no retry can reserve another call.
// A reservation that was never sent is released and reported separately; an
// unconfirmed reservation is counted but never reported as a measured call.
// The server's own HTTP/provider calls are not observable from here: they stay
// "unknown" (0 only when the server explicitly reports no call).
import { randomBytes } from "node:crypto";
import { incrementFor, MAX_QUANTUM, readMessage, sameAuthorization } from "./authorization.mjs";
import { emptyBudget, SOURCES, withControlState } from "./state.mjs";

export function normalizeSource(source) {
  return SOURCES.includes(source) ? source : "unknown";
}

const total = (budget) => Object.values(budget.attempts).reduce((a, b) => a + b, 0) - budget.released;

export function budgetView(state) {
  const b = state.budget;
  const used = total(b);
  const limit = b.limit + b.extra;
  return {
    request: state.request.seq,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    by_source: { ...b.attempts },
    sent: b.sent,
    released: b.released,
    unconfirmed: Object.keys(state.pending).length,
    provider_calls: state.provider_calls,
  };
}

/** Reserve one slot before sending. {ok: true, id, view} or {ok: false, reason: "budget_exhausted", view}. */
export function reserve(dir, { tool, source = "unknown" }, now = Date.now()) {
  return withControlState(dir, (state) => {
    const view = budgetView(state);
    if (view.used >= view.limit) return { ok: false, reason: "budget_exhausted", view };
    const id = randomBytes(6).toString("hex");
    const src = normalizeSource(source);
    state.budget.attempts[src] += 1;
    state.pending[id] = { tool: String(tool).replace(/^.*jev_/, "").slice(0, 20), source: src, ts: now };
    return { ok: true, id, view: budgetView(state) };
  }, now);
}

/** The request was sent (and answered or failed): the reservation becomes a measured call. */
export function confirm(dir, id, { ok = true, ms = null } = {}, now = Date.now()) {
  return withControlState(dir, (state) => {
    const pending = state.pending[id];
    if (!pending) return { ok: false, reason: "unknown_reservation" };
    delete state.pending[id];
    state.budget.sent += 1;
    state.calls.push({ tool: pending.tool, source: pending.source, ok: ok === true, ms: Number.isFinite(ms) ? Math.round(ms) : null, ts: now, req: state.request.seq });
    return { ok: true };
  }, now);
}

/** The request was never sent (for example the connection failed first): give the slot back and report it. */
export function release(dir, id, now = Date.now()) {
  return withControlState(dir, (state) => {
    const pending = state.pending[id];
    if (!pending) return { ok: false, reason: "unknown_reservation" };
    delete state.pending[id];
    state.budget.released += 1;
    return { ok: true };
  }, now);
}

/**
 * The user approved continuing beyond the limit: raise it by `n` (the quantity their words state, or the default budget
 * step when they state none; never more). The approval keeps the user's own words (`message`, one line) and the concrete
 * `question` they answered, so the transcript audit can check that the user really said it. Nothing is raised without words
 * that are an authorization OF THE BUDGET (a quoted negation, a question, a condition, an unrelated instruction such as
 * «Use Node 22.» or a bare «yes» without the question it answers is not one: authorization.mjs), beyond what they state
 * (a total such as «to 30 calls» is measured against the limit now in force), when the quantity is ambiguous, or twice from
 * the same words within one request (words contained in an earlier approval's words count as the same authorization).
 * {ok: true, n, ...view} or {ok: false, reason, allowed?}.
 */
export function approveMore(dir, n, message = "", now = Date.now(), question = null) {
  const full = String(message ?? "").replace(/\s+/g, " ").trim();
  if (full.length < 3) return { ok: false, reason: "message_required" };
  const asked = question === null || question === undefined ? null : String(question).replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const read = readMessage(full, undefined, asked);
  if (!read.authorization) return { ok: false, reason: read.reason === "object_missing" ? "message_not_about_budget" : "message_not_authorization" };
  const text = full.slice(0, 200);
  return withControlState(dir, (state) => {
    const step = incrementFor(read.quantity, state.budget.limit + state.budget.extra);
    if (!step.ok) return { ok: false, reason: step.reason };
    const extra = n === undefined ? step.allowed : n;
    if (!Number.isInteger(extra) || extra < 1 || extra > MAX_QUANTUM) return { ok: false, reason: "n_invalid" };
    if (extra > step.allowed) return { ok: false, reason: "over_quantum", allowed: step.allowed };
    const again = (state.budget.approvals ?? []).some((a) => a.req === state.request.seq && sameAuthorization(text, asked, String(a.msg), a.q ?? null));
    if (again) return { ok: false, reason: "approval_already_used" };
    state.budget.extra += extra;
    (state.budget.approvals ??= []).push({ n: extra, msg: text, ...(asked ? { q: asked } : {}), req: state.request.seq, ts: now });
    return { ok: true, n: extra, ...budgetView(state) };
  }, now);
}

/** A new user request: counters restart; the previous total is kept in a short history. */
export function startRequest(state, now = Date.now()) {
  const prev = total(state.budget);
  if (state.request.seq > 0) state.budget.history = [...state.budget.history, prev].slice(-20);
  state.budget = { ...emptyBudget(), history: state.budget.history };
  state.pending = {};
  state.request = { seq: state.request.seq + 1, started: now };
  state.expansions = {};
  state.searches = {};
}

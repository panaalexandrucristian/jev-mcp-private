// The shared Jev call budget of one user request (D15, D26): at most 25 MCP
// tools/call ATTEMPTS from every source (main thread, subagents, helpers, gate
// runner parts, tie-breaks), retries included. A slot is reserved atomically
// BEFORE the request is sent, so a retry at the limit cannot become call 26.
// A reservation that was never sent is released and reported separately; an
// unconfirmed reservation is counted but never reported as a measured call.
// The server's own HTTP/provider calls are not observable from here: they stay
// "unknown" (0 only when the server explicitly reports no call).
import { randomBytes } from "node:crypto";
import { authorizedExtra, MAX_QUANTUM, readMessage } from "./authorization.mjs";
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
 * step when they state none; never more). The approval keeps the user's own words (`message`, one line) so the transcript
 * audit can check that the user really said it. Nothing is raised without words that are an authorization (a quoted
 * negation, a question or a condition is not one: authorization.mjs), beyond what they state, or twice from the same
 * words within one request. {ok: true, n, ...view} or {ok: false, reason, allowed?}.
 */
export function approveMore(dir, n, message = "", now = Date.now()) {
  const full = String(message ?? "").replace(/\s+/g, " ").trim();
  if (full.length < 3) return { ok: false, reason: "message_required" };
  const read = readMessage(full);
  if (!read.authorization) return { ok: false, reason: "message_not_authorization" };
  const allowed = authorizedExtra(read.quantum);
  const extra = n === undefined ? allowed : n;
  if (!Number.isInteger(extra) || extra < 1 || extra > MAX_QUANTUM) return { ok: false, reason: "n_invalid" };
  if (extra > allowed) return { ok: false, reason: "over_quantum", allowed };
  const text = full.slice(0, 200);
  return withControlState(dir, (state) => {
    const again = (state.budget.approvals ?? []).some((a) => a.req === state.request.seq && String(a.msg).toLowerCase() === text.toLowerCase());
    if (again) return { ok: false, reason: "approval_already_used" };
    state.budget.extra += extra;
    (state.budget.approvals ??= []).push({ n: extra, msg: text, req: state.request.seq, ts: now });
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

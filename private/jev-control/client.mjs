// Budgeted Jev MCP caller: the jev-flow stdio client and its retry rule (one
// identical retry after a transport failure or an invalid response, never after
// a valid answer), but with the shared budget consulted BEFORE every tools/call
// attempt, retries included. Arguments are validated and checked for credentials
// before anything is reserved or sent, so a bad payload never costs a call.
import { openJev } from "../jev-flow/mcp-client.mjs";
import { payloadCredentialKinds } from "../jev-flow/sanitize.mjs";
import { confirm, release, reserve } from "./budget.mjs";
import { toolBase, validateArgs } from "./contracts.mjs";

const LIST_TIMEOUT_MS = 30_000;

export class BudgetedCaller {
  constructor({ dir, source = "helper", env = process.env, open = openJev, now = Date.now } = {}) {
    this.dir = dir;
    this.source = source;
    this.env = env;
    this.openJev = open;
    this.now = now;
  }

  /** {ok: true, ...session} or {ok: false, unavailable|config, reason}. Opening spends no budget. */
  open() {
    return this.openJev(this.env);
  }

  /** tools/list (discovery, not a tools/call: no budget). {ok, tools} or {ok: false, reason}. */
  async listTools(session) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const reply = await session.client.request("tools/list", cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
      if (!reply.ok) return { ok: false, reason: `${reply.kind}: ${reply.message}` };
      if (!Array.isArray(reply.result?.tools)) return { ok: false, reason: "tools/list returned no tools array" };
      tools.push(...reply.result.tools);
      cursor = reply.result.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, tools, serverInfo: session.client.serverInfo ?? null };
  }

  /**
   * tools/call. Returns {ok: true, result, attempts} or {ok: false, kind, message,
   * attempts, ...} with kind transport | invalid_response | tool_error | budget |
   * invalid_args | credential. `invalid(result)` is the caller's semantic check
   * (an unusable ranking, for example): true makes the answer retryable once.
   */
  async call(session, name, args, { invalid = null, source = this.source } = {}) {
    const base = toolBase(name) ?? String(name);
    const problems = validateArgs(base, args);
    if (problems.length) return { ok: false, kind: "invalid_args", message: `invalid ${name} arguments: ${problems.slice(0, 4).join("; ")}`, problems, attempts: 0 };
    const kinds = payloadCredentialKinds(args);
    if (kinds.length) return { ok: false, kind: "credential", message: `the ${name} payload contains an unredacted credential (${kinds.join(", ")}); nothing was sent`, attempts: 0 };
    let attempts = 0;
    let last;
    for (let round = 1; round <= 2; round++) {
      if (round === 2 && session.client.closed) {
        if (typeof session.reopen !== "function") return { ...last, attempts, retry: "not_executed: the server connection is closed" };
        const reopened = await session.reopen();
        if (!reopened.ok) return { ...last, attempts, retry: `not_executed: reconnect failed (${String(reopened.reason).slice(0, 200)})` };
      }
      const slot = reserve(this.dir, { tool: base, source }, this.now());
      if (!slot.ok) {
        const message = `Jev call budget exhausted (${slot.view.used}/${slot.view.limit}): stop and ask the user whether to continue`;
        return round === 1
          ? { ok: false, kind: "budget", message, attempts, budget: slot.view }
          : { ...last, ok: false, kind: "budget", message, attempts, retry: "not_executed: budget exhausted", budget: slot.view };
      }
      attempts += 1;
      const started = this.now();
      try {
        last = await session.client.callTool(name.startsWith("jev_") ? name : `jev_${base}`, args);
      } catch (error) {
        release(this.dir, slot.id, this.now());
        throw error;
      }
      confirm(this.dir, slot.id, { ok: last.ok, ms: this.now() - started }, this.now());
      let retryable;
      if (!last.ok) retryable = last.kind === "transport" || last.kind === "invalid_response";
      else {
        const semanticallyInvalid = last.result?.status === "invalid_response" || (invalid ? invalid(last.result) === true : false);
        if (semanticallyInvalid) last = { ok: false, kind: "invalid_response", message: `${name} returned an invalid result`, result: last.result };
        retryable = semanticallyInvalid;
      }
      if (!retryable) return { ...last, attempts };
    }
    return { ...last, attempts };
  }
}

export const UNAVAILABLE = "Jev unavailable";

/** True for failures that mean Jev could not answer (not for budget or argument refusals). */
export function isUnavailable(reply) {
  return !reply.ok && (reply.kind === "transport" || reply.kind === "invalid_response" || reply.kind === "tool_error");
}

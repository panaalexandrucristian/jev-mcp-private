// Completion under jev-control: the existing gate runner (diff collection, real
// checks, excerpts, partitioning, aggregation, signed receipts) with the session
// threshold instead of the flow's: every jev_gate part is sent with
// auto_accept = T, and a decision confidence (claim confidence, safe_to_apply,
// rubric confidences) is accepted only when it is strictly above T, with no 0.8
// floor inherited from the flow. composite_floor and the tool's other policies
// stay as they are. Every part's tools/call attempt (retries included) goes
// through the shared budget, reported as source "gate". A later edit changes the
// snapshot and invalidates the verification (the runner reports snapshot_changed).
import { compactSummary, EXIT, parseCheckArgv, RUN_LIMITS, RunError, runGate, startAttempt } from "../jev-flow/gate-run.mjs";
import { loadDenylist } from "../jev-flow/paths.mjs";
import { gitTopLevel } from "../jev-flow/state.mjs";
import { withControlState } from "./state.mjs";

export const CONTROL_ACCEPT_MINIMUMS = Object.freeze({ confidence: 0, safe_to_apply: 0, composite: 0 });

/** The gate-runner policy seam for threshold T. */
export function gatePolicy({ T, caller }) {
  return {
    accept: { minimums: CONTROL_ACCEPT_MINIMUMS, strictAbove: T },
    decorateInput: (input) => ({ ...input, auto_accept: T }),
    call: (jev, input, { invalid }) => caller.call(jev, "jev_gate", input, { source: "gate", invalid }),
  };
}

/**
 * Run the gate. `args`: {root, claims (parsed JSON), checks (JSON argv strings),
 * checkTimeoutMs}; `ctx`: {T, caller, dir, sessionKey (16-hex), env, now}. Returns {code, summary, text}.
 */
export async function runControlDone(args, ctx) {
  const env = ctx.env ?? process.env;
  const repoRoot = gitTopLevel(args.root);
  if (!repoRoot) return { code: EXIT.invalid, summary: { status: "invalid_input", problems: [`not a git work tree: ${args.root}`] }, text: "" };
  const attempt = startAttempt({ repoRoot, sessionKeyArg: ctx.sessionKey, env });
  let checks;
  try {
    checks = (args.checks ?? []).map(parseCheckArgv);
  } catch (error) {
    attempt.close();
    if (error instanceof RunError) return { code: EXIT.invalid, summary: { status: "invalid_input", problems: [error.message] }, text: "" };
    throw error;
  }
  let result;
  try {
    result = await runGate({
      repoRoot,
      denylist: loadDenylist(repoRoot),
      input: args.claims,
      checks,
      checkTimeoutMs: args.checkTimeoutMs ?? RUN_LIMITS.checkTimeoutMs,
      attempt,
      env,
      policy: gatePolicy({ T: ctx.T, caller: ctx.caller }),
    });
  } catch (error) {
    attempt.close();
    throw error;
  }
  const { code, summary } = result;
  // R07: the claims file the helper consumed (its name and the sha256 of the bytes it read), whatever the outcome; removal is not acceptance.
  if (args.extra) Object.assign(summary, args.extra);
  withControlState(ctx.dir, (state) => {
    state.decisions.push({
      id: String(summary.receipt ?? "no-receipt").slice(0, 40),
      req: state.request.seq,
      ts: (ctx.now ?? Date.now)(),
      kind: "done",
      t: ctx.T,
      status: String(summary.outcome ?? summary.status ?? "unknown").slice(0, 40),
      round: 0,
      opts: [],
      order: [],
      calls: Number.isInteger(summary.jev_calls) ? summary.jev_calls : 0,
      tb: 0,
      snap: summary.snapshot ?? null,
    });
  }, (ctx.now ?? Date.now)());
  summary.control = { threshold: ctx.T, accepted_strictly_above: true };
  return { code, summary, text: compactSummary(summary) };
}

// Signed, metadata-only provenance of the control's own decisions, on the
// jev-flow receipt primitives (a per-session HMAC key, receipts/<id>.json). A
// receipt binds a decision to the session, the request, the threshold in force,
// every option (full text and action hashes, the concrete action descriptor with
// its argument hashes, the preconditions, the fingerprints of the evidence the
// option depends on and the RAW score), the plan (id, step, raw score, short action
// hash), the Jev calls that produced it (tool, budget source, argument and result
// hashes, attempts) and the work-tree snapshot. Authorizing an action means
// matching it against the receipt: the same tool and target as the planned
// option and the same arguments (content, replacement, range, prompt, scope),
// preconditions that still hold, a snapshot that has not moved (or, for a later step of
// the same plan, evidence that has not changed), in the planned order, once. It proves where the helper's metadata came from and what
// was authorized, not that an action was carried out: execution is audited from
// the transcript (measure.mjs). A process of the same user that can read the key
// or edit the helper is out of scope, as for the gate runner's receipts.
import { createHash } from "node:crypto";
import { ensureReceiptKey, newReceiptId, readSignedReceipt, writeReceipt } from "../jev-flow/runner-receipt.mjs";
import { actionHash, evaluatePreconditions, fingerprintPaths, parsePlanItem } from "./actions.mjs";

export const RECEIPT_TYPE = "control_decision";
export const RECEIPT_VERSION = 2;

export function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

/**
 * Write a decision receipt; returns its id. Throws when the receipt cannot be
 * stored or when the body is incomplete: a receipt without the provenance and the
 * concrete options would authorize nothing and is never written.
 */
export function writeDecisionReceipt(dir, body) {
  if (!Array.isArray(body.options) || body.options.length === 0 || body.options.some((o) => typeof o?.id !== "string" || typeof o.oh !== "string" || !("score" in o))) throw new Error("receipt needs the full option records");
  if (body.options.some((o) => o.dep !== undefined && (!o.dep || typeof o.dep !== "object" || Object.values(o.dep).some((v) => typeof v !== "string")))) throw new Error("receipt options carry their evidence fingerprints as {path: string}");
  if (!Array.isArray(body.calls)) throw new Error("receipt needs the Jev call provenance");
  if (!Array.isArray(body.plan) || body.plan.some((p) => typeof p !== "string" || !parsePlanItem(p))) throw new Error("receipt needs plan items in the compact format");
  ensureReceiptKey(dir);
  const id = newReceiptId();
  writeReceipt(dir, {
    v: RECEIPT_VERSION,
    type: RECEIPT_TYPE,
    id,
    ts: Date.now(),
    session: body.session,
    repo: body.repo,
    req: body.req,
    decision: body.decision,
    kind: body.kind,
    threshold: body.threshold,
    round: body.round ?? 0,
    status: body.status,
    plan: body.plan,
    options: body.options,
    calls: body.calls,
    tiebreaks: body.tiebreaks ?? 0,
    snap: body.snap ?? "unknown",
  });
  return id;
}

/**
 * Verify that receipt `id` authorizes `action` ({tool, target}, already normalized
 * like the option's descriptor) for `option` now. `ctx`: {session, req, snap (the
 * current snapshot, short form, or null when unknown), root (the repository),
 * consumed ([{receipt, option}] already used)}. Returns {ok: true, receipt, option}
 * or {ok: false, reason}. Nothing unknown authorizes: an unknown snapshot, an
 * option without a concrete action, a missing action argument and a stale or
 * replayed authorization are all refusals.
 */
export function verifyDecisionReceipt(dir, id, { session, req, snap = null, root = null, option = null, action = null, consumed = [] }) {
  const body = readSignedReceipt(dir, id);
  if (!body || body.type !== RECEIPT_TYPE || body.v !== RECEIPT_VERSION) return { ok: false, reason: "receipt_missing_or_forged" };
  if (body.session !== session) return { ok: false, reason: "receipt_other_session" };
  if (body.req !== req) return { ok: false, reason: "receipt_other_request" };
  if (!["selected", "ordered"].includes(body.status)) return { ok: false, reason: `receipt_status_${body.status}` };
  if (option === null) return { ok: false, reason: "option_required" };
  const items = body.plan.map(parsePlanItem);
  const index = items.findIndex((p) => p?.id === option && p.action === "execute");
  if (index < 0) return { ok: false, reason: "option_not_authorized" };
  const planned = body.options.find((o) => o.id === option);
  if (!planned || !planned.action || !planned.ah) return { ok: false, reason: "option_names_no_action" };
  if (planned.unavailable) return { ok: false, reason: "option_was_unavailable" };
  if (!(planned.score > body.threshold)) return { ok: false, reason: "option_not_above_threshold" };
  if (items[index].ah !== planned.ah.slice(0, 12)) return { ok: false, reason: "receipt_inconsistent" };
  if (!action) return { ok: false, reason: "action_required" };
  if (actionHash(action) !== planned.ah) return { ok: false, reason: "action_mismatch", expected: `${planned.action.tool} ${planned.action.target}`.slice(0, 120) };
  const used = consumed.filter((c) => c.receipt === id);
  if (used.some((c) => c.option === option)) return { ok: false, reason: "receipt_replayed" };
  if (body.snap === "unknown") return { ok: false, reason: "receipt_snapshot_unknown" };
  if (!snap) return { ok: false, reason: "current_snapshot_unknown" };
  if (body.snap !== snap) {
    // The tree moved since the decision. Before the first use of this receipt nothing it authorized can have run, so any
    // move invalidates it. After a first use the earlier steps are expected to have changed the tree (the use is recorded
    // before the step runs and does not prove that it ran): then only the evidence THIS step depends on counts, and a
    // step that declares none (no path target, no preconditions) cannot show that the move was irrelevant to it.
    if (used.length === 0) return { ok: false, reason: "receipt_stale_snapshot" };
    const dep = planned.dep && typeof planned.dep === "object" ? planned.dep : {};
    const paths = Object.keys(dep);
    if (paths.length === 0) return { ok: false, reason: "receipt_stale_snapshot", detail: "the tree moved and this step names no evidence it depends on: give it a precondition on a path it needs, or decide again" };
    if (!root) return { ok: false, reason: "preconditions_not_evaluable" };
    const now = fingerprintPaths(root, paths);
    const changed = paths.find((path) => now[path] !== dep[path]);
    if (changed !== undefined) return { ok: false, reason: `receipt_evidence_changed:${changed.slice(0, 80)}` };
  }
  if (body.kind === "order") {
    const earlier = items.slice(0, index).filter((p) => p?.action === "execute");
    if (earlier.some((p) => !used.some((c) => c.option === p.id))) return { ok: false, reason: "receipt_out_of_order" };
  }
  if (planned.pre?.length) {
    if (!root) return { ok: false, reason: "preconditions_not_evaluable" };
    const check = evaluatePreconditions(planned.pre, root);
    if (!check.ok) return { ok: false, reason: `precondition_failed:${check.failed[0].kind}:${check.failed[0].reason}` };
  }
  return { ok: true, receipt: body, option: planned };
}

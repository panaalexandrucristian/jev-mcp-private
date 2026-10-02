// Signed, metadata-only provenance of the control's own decisions, on the
// jev-flow receipt primitives (a per-session HMAC key, receipts/<id>.json). A
// receipt binds a decision to the session, the request, the options (hashes), the
// threshold in force, the Jev calls that produced it (argument and result
// hashes) and the work-tree snapshot. It proves where the helper's metadata came
// from, not that an action was carried out: execution is verified separately in
// the transcript (measure.mjs). A process of the same user that can read the key
// or edit the helper is out of scope, as for the gate runner's receipts.
import { createHash } from "node:crypto";
import { ensureReceiptKey, newReceiptId, readSignedReceipt, writeReceipt } from "../jev-flow/runner-receipt.mjs";

export const RECEIPT_TYPE = "control_decision";

export function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

/** Write a decision receipt; returns its id. Throws when the receipt cannot be stored. */
export function writeDecisionReceipt(dir, body) {
  ensureReceiptKey(dir);
  const id = newReceiptId();
  writeReceipt(dir, {
    v: 1,
    type: RECEIPT_TYPE,
    id,
    ts: Date.now(),
    session: body.session,
    repo: body.repo,
    req: body.req,
    decision: body.decision,
    kind: body.kind,
    threshold: body.threshold,
    status: body.status,
    plan: body.plan.map((p) => `${p.id}:${p.action}`),
    options: body.options,
    calls: body.calls,
    snap: body.snap ?? "unknown",
  });
  return id;
}

/**
 * Verify that `id` authorizes `option` now: authentic (HMAC), a decision receipt
 * for this session and request, not stale (snapshot unchanged when both are
 * known), a status that allows action, and the option planned to execute.
 */
export function verifyDecisionReceipt(dir, id, { session, req, snap = null, option = null }) {
  const body = readSignedReceipt(dir, id);
  if (!body || body.type !== RECEIPT_TYPE) return { ok: false, reason: "receipt_missing_or_forged" };
  if (body.session !== session) return { ok: false, reason: "receipt_other_session" };
  if (body.req !== req) return { ok: false, reason: "receipt_other_request" };
  if (snap && body.snap !== "unknown" && body.snap !== snap) return { ok: false, reason: "receipt_stale_snapshot" };
  if (!["selected", "ordered", "found"].includes(body.status)) return { ok: false, reason: `receipt_status_${body.status}` };
  if (option !== null && !body.plan.includes(`${option}:execute`)) return { ok: false, reason: "option_not_authorized" };
  return { ok: true, receipt: body };
}

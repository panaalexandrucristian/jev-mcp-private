// Authenticated receipts of the gate runner (scripts/jev-gate-run.mjs).
//
// SessionStart (Claude Code hook) or the first prompt of a session (OpenCode
// adapter) creates a per-session secret `receipt.key` (0600) in the session's
// metadata directory. The runner signs a metadata-only receipt with HMAC-SHA256
// under that key; Stop (or the OpenCode gate status) re-verifies the HMAC and
// binds the receipt to the session, request, attempt and current snapshot.
// A JSON summary printed on stdout is never evidence by itself.
//
// Threat model: a model that invents a summary, edits or replays a receipt, or
// changes the snapshot afterwards. A process running as the same user that
// can read the key or change the runner, the cache or the server is out of
// scope (documented in PRIVATE.md).
//
// Receipts hold metadata only (ids, hashes, actions, verdict codes, exit
// codes, timestamps): never claim text, code, diffs, logs or Jev responses.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertMetadataOnly, cacheRoot, captureBaseline, repoKey, sessionKey, writeBaselineOnce } from "./state.mjs";

export const RECEIPT_KEY_FILE = "receipt.key";
export const RECEIPTS_DIR = "receipts";
const RECEIPT_ID = /^[0-9a-f]{32}$/;

/** Session directory from an already hashed session key (the OpenCode adapter passes it to the runner). */
export function sessionDirFromKey(repoRoot, key, env = process.env) {
  if (!/^[0-9a-f]{16}$/.test(String(key ?? ""))) return null;
  return join(cacheRoot(env), repoKey(repoRoot), key);
}

/** Create the per-session secret once. */
export function ensureReceiptKey(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, RECEIPT_KEY_FILE);
  try {
    lstatSync(target);
    return false;
  } catch {
    // Absent: create it.
  }
  const tmp = join(dir, `.key.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    // Never replace a key another process created meanwhile.
    lstatSync(target);
    return false;
  } catch {
    renameSync(tmp, target);
    return true;
  }
}

/** The session secret as a Buffer, or null when absent or malformed. */
export function readReceiptKey(dir) {
  try {
    const st = lstatSync(join(dir, RECEIPT_KEY_FILE));
    if (!st.isFile()) return null;
    const hex = readFileSync(join(dir, RECEIPT_KEY_FILE), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch {
    return null;
  }
}

/** Session initialisation for the runner: the secret and the baseline, each written once. */
export function initRunnerSession(dir, repoRoot, now = Date.now()) {
  ensureReceiptKey(dir);
  writeBaselineOnce(dir, captureBaseline(repoRoot, now));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

function mac(key, body) {
  return createHmac("sha256", key).update(JSON.stringify(canonical(body))).digest("hex");
}

/** A new receipt/attempt id. */
export function newReceiptId() {
  return randomBytes(16).toString("hex");
}

/**
 * Sign and store a receipt body (metadata only) as receipts/<id>.json.
 * Throws when the key is missing or the body is not metadata.
 */
export function writeReceipt(dir, body) {
  const key = readReceiptKey(dir);
  if (!key) throw new Error("receipt key missing");
  if (!RECEIPT_ID.test(String(body?.id))) throw new Error("invalid receipt id");
  assertMetadataOnly(body, "receipt");
  const signed = { ...body, hmac: mac(key, body) };
  const folder = join(dir, RECEIPTS_DIR);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const tmp = join(folder, `.${body.id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(signed), { mode: 0o600 });
  renameSync(tmp, join(folder, `${body.id}.json`));
  return signed;
}

/** A stored receipt whose HMAC verifies under this session's key (whatever its verdict), or null. */
export function readSignedReceipt(dir, id) {
  if (!RECEIPT_ID.test(String(id ?? ""))) return null;
  const key = readReceiptKey(dir);
  if (!key) return null;
  try {
    const receipt = JSON.parse(readFileSync(join(dir, RECEIPTS_DIR, `${id}.json`), "utf8"));
    const { hmac, ...body } = receipt;
    const want = Buffer.from(mac(key, body), "hex");
    const got = Buffer.from(/^[0-9a-f]{64}$/.test(String(hmac)) ? hmac : "", "hex");
    return got.length === want.length && timingSafeEqual(got, want) && body.id === id ? body : null;
  } catch {
    return null;
  }
}

/**
 * Coverage metadata {claim_ids, diff} of an earlier gate-runner attempt: from
 * its signed receipt when one exists, otherwise from the state record (an
 * attempt interrupted after preparing its batch).
 */
export function runnerCoverage(dir, record) {
  const signed = readSignedReceipt(dir, record?.runner);
  if (signed && Array.isArray(signed.claim_ids) && typeof signed.diff === "string") return { claim_ids: signed.claim_ids, diff: signed.diff };
  return { claim_ids: record?.claim_ids, diff: record?.diff };
}

/**
 * Verify a stored receipt: authentic (HMAC under this session's key), for
 * this session, request, boot and attempt, on `snapshot`, and accepted.
 * `expected`: {session, req, boot?, snapshot}. Returns {accepted, reason, receipt}.
 */
export function verifyReceipt(dir, id, expected) {
  if (!RECEIPT_ID.test(String(id ?? ""))) return { accepted: false, reason: "receipt_id_invalid" };
  const key = readReceiptKey(dir);
  if (!key) return { accepted: false, reason: "receipt_key_missing" };
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(join(dir, RECEIPTS_DIR, `${id}.json`), "utf8"));
  } catch {
    return { accepted: false, reason: "receipt_missing" };
  }
  if (!receipt || typeof receipt !== "object" || typeof receipt.hmac !== "string") return { accepted: false, reason: "receipt_malformed" };
  const { hmac, ...body } = receipt;
  const want = Buffer.from(mac(key, body), "hex");
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(hmac) ? hmac : "", "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { accepted: false, reason: "receipt_signature_invalid" };
  if (body.id !== id) return { accepted: false, reason: "receipt_id_mismatch" };
  if (expected.session !== undefined && body.session !== expected.session) return { accepted: false, reason: "receipt_other_session" };
  if (expected.req !== undefined && body.req !== expected.req) return { accepted: false, reason: "receipt_other_request" };
  if (expected.boot !== undefined && body.boot !== expected.boot) return { accepted: false, reason: "receipt_other_boot" };
  if (!expected.snapshot || body.snap !== expected.snapshot || body.snap_after !== expected.snapshot) return { accepted: false, reason: "receipt_snapshot_mismatch" };
  // Semantic verdict and operational status are separate; both must be clean.
  if (body.accepted !== true || body.verdict !== "accepted" || body.status !== "ok" || body.outcome !== "accepted") {
    return { accepted: false, reason: `receipt_not_accepted_${body.outcome ?? body.status ?? "unknown"}` };
  }
  // Every real check must have passed: exit 0, no timeout, started.
  if (!Array.isArray(body.checks) || body.checks.some((c) => !c || c.exit !== 0 || c.timed_out === true || c.start_failed === true)) {
    return { accepted: false, reason: "receipt_checks_failed" };
  }
  if (!completeBatch(body)) return { accepted: false, reason: "receipt_incomplete" };
  return { accepted: true, receipt: body };
}

/**
 * The receipt covers the whole batch: parts 1..n each exactly once, in order,
 * every one evaluated and auto, and the coverage counters agree (R5, F3).
 */
function completeBatch(body) {
  const n = body.parts;
  if (!Number.isInteger(n) || n < 1) return false;
  const ids = body.part_ids;
  if (!Array.isArray(ids) || ids.length !== n || ids.some((id, i) => id !== i + 1)) return false;
  if (!Array.isArray(body.actions) || body.actions.length !== n || body.actions.some((a) => a !== "auto")) return false;
  if (!Array.isArray(body.verdicts) || body.verdicts.length !== n) return false;
  const c = body.coverage;
  return Boolean(c) && c.planned === n && c.sent === n && c.evaluated === n && c.unavailable === 0 && c.unevaluated === 0;
}

export { sessionKey };

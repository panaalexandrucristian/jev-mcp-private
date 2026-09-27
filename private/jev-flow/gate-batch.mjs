// jev_gate payload preparation and partitioned-batch validation, shared by
// the Claude Code hook and the OpenCode adapter. Pure functions over strings
// and metadata: nothing here writes to disk, and nothing semantic (claims,
// diffs, logs, verdicts) is persisted by callers.
//
// Every prepared jev_gate call carries a manifest label as the first line of
// its `request` (a patch that exceeds one call becomes a *batch* of parts):
//   [jev-flow batch v2 id=<32 hex> part=<k>/<n> slice=<i>/<m> claims=<16 hex> diff=<16 hex> snap=<64 hex>]
// `snap` is the work-tree snapshot the batch was prepared on; the diff is cut
// into m contiguous slices whose concatenation is the whole sanitized diff
// (`diff` hashes it); `claims` hashes the complete claim set. A later gate
// that replaces an incomplete batch must match both (or contain everything
// when every part of that batch is known). `id` hashes the snapshot, the
// shape, both hashes and a canonical digest of every planned part's complete
// input (request without the label, diff, claims, evidence, tests and any
// other parameter), so parts of different preparations never combine and a
// changed payload makes a different batch. The label itself is excluded from
// the digests (no circularity).
import { createHash } from "node:crypto";
import { exclusionReason } from "./paths.mjs";
import { sanitizeDiff, sanitizeText } from "./sanitize.mjs";

/** jev_gate limits, mirroring src/lib.ts:241-253 (MAX_GATE_*, MAX_REVIEW_DOC_CHARS, MAX_CLAIM_CHARS). */
export const GATE_LIMITS = Object.freeze({
  claims: 16,
  evidenceItems: 16,
  evidenceChars: 200_000,
  docChars: 50_000,
  claimChars: 2_000,
});

/** Internal budgets: a margin below the tool caps for identification headers. */
export const BATCH_LIMITS = Object.freeze({
  maxParts: 16,
  diffSliceChars: 48_000,
  evidenceItemChars: 48_000,
  testsChars: 48_000,
});

const LABEL_RE = /^\[jev-flow batch v2 id=([0-9a-f]{32}) part=(\d{1,3})\/(\d{1,3}) slice=(\d{1,3})\/(\d{1,3}) claims=([0-9a-f]{16}) diff=([0-9a-f]{16}) snap=([0-9a-f]{64})\]$/;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function formatBatchLabel({ id, part, of, slice, slices, claims, diff, snap }) {
  return `[jev-flow batch v2 id=${id} part=${part}/${of} slice=${slice}/${slices} claims=${claims} diff=${diff} snap=${snap}]`;
}

/** The manifest label on the first line of a gate `request`, or null. */
export function parseBatchLabel(request) {
  if (typeof request !== "string") return null;
  const first = request.split("\n", 1)[0];
  const m = LABEL_RE.exec(first);
  if (!m) return null;
  const [part, of, slice, slices] = [m[2], m[3], m[4], m[5]].map(Number);
  if (of < 1 || of > BATCH_LIMITS.maxParts || part < 1 || part > of) return null;
  if (slices < 1 || slices > of || slice < 1 || slice > slices) return null;
  return { id: m[1], part, of, slice, slices, claims: m[6], diff: m[7], snap: m[8] };
}

/** The request text after the label line (the whole request when unlabelled). */
export function requestBody(request) {
  if (typeof request !== "string") return request;
  return parseBatchLabel(request) ? request.slice(request.indexOf("\n") + 1) : request;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** Canonical digest of one gate input, label excluded: every other field counts. */
export function partDigest(input) {
  return sha256(JSON.stringify(canonical({ ...input, request: requestBody(input?.request) })));
}

/** Short hash of a whole sanitized diff. */
export function diffHash(text) {
  return sha256(String(text)).slice(0, 16);
}

/** Sorted, de-duplicated claim texts. */
export function canonicalClaims(claims) {
  return [...new Set((claims ?? []).map(String))].sort();
}

/** Short hash of a complete claim set (order and duplicates ignored). */
export function claimSetHash(claims) {
  return sha256(JSON.stringify(canonicalClaims(claims))).slice(0, 16);
}

/** Batch id from the snapshot, the shape, the claim-set and diff hashes and the per-part digests in part order. */
export function batchId({ snap, slices, claims, diff, digests }) {
  return sha256(JSON.stringify({ v: 2, snap, slices, claims, diff, parts: digests })).slice(0, 32);
}

// ── Attempt selection (metadata only; shared by both adapters) ──────────────

const unknownSnap = (value) => !value || value === "unknown";

/** Why one finished or unfinished attempt cannot count, or null. */
function attemptProblem(a, { snapshot, requestSeq }) {
  if (a.pending) return "unfinished";
  if (a.denied) return "denied";
  if (a.failed) return "failed";
  if (a.req !== requestSeq) return "other_request";
  if (unknownSnap(a.before) || unknownSnap(a.after)) return "snapshot_unknown";
  if (a.before !== a.after) return "changed_during_gate";
  if (a.after !== snapshot) return "older_snapshot";
  return null;
}

const SINGLE_REASONS = {
  unfinished: "latest_gate_unfinished",
  denied: "latest_gate_denied",
  failed: "latest_gate_failed",
  other_request: "gate_from_other_request",
  snapshot_unknown: "gate_snapshot_unknown",
  changed_during_gate: "changed_during_gate",
  older_snapshot: "gate_on_older_snapshot",
};

/**
 * Pick what may count for completion among gate attempts
 * ({ts, pending, denied, failed, req, before, after, batch, part, of}).
 * - Latest attempt unlabelled: the single-gate rule. Batch attempts of the
 *   same request that touched this snapshot are returned as `supersededBatch`:
 *   the single gate counts only if its claims include all of theirs.
 * - Latest attempt labelled: the batch rule. From the batch's first attempt
 *   on, every attempt must belong to it; for every part 1..n the latest
 *   attempt of that part must be finished, not failed or denied, from the
 *   current request, with equal known snapshots equal to the current one.
 * An earlier, different batch of the same request on this snapshot is also
 * returned as `supersededBatch`: a replacement batch must restore its whole
 * claim coverage.
 * Returns {record, supersededBatch} | {batch: {id, of, records}, supersededBatch} | {reason}.
 */
export function selectGateAttempts(attempts, { snapshot, requestSeq }) {
  if (!snapshot) return { reason: "snapshot_unknown" };
  const sorted = [...attempts].sort((a, b) => a.ts - b.ts);
  const latest = sorted[sorted.length - 1];
  if (!latest) return { reason: "no_gate" };
  // Earlier attempts whose claims a later gate must cover (F3): partitioned
  // direct batches, and gate-runner attempts that prepared a batch (they carry
  // `diff` and `claim_ids`), including failed or interrupted ones.
  const earlierBatches = (until, exceptId) =>
    sorted
      .slice(0, until)
      .filter((a) => ((a.batch && a.batch !== exceptId) || (a.runner && typeof a.diff === "string")) && a.req === requestSeq && (a.before === snapshot || a.after === snapshot || unknownSnap(a.after)));
  if (!latest.batch) {
    const problem = attemptProblem(latest, { snapshot, requestSeq });
    if (problem) return { reason: SINGLE_REASONS[problem] };
    return { record: latest, supersededBatch: earlierBatches(sorted.length - 1, null) };
  }
  const first = sorted.findIndex((a) => a.batch === latest.batch);
  const tail = sorted.slice(first);
  if (tail.some((a) => a.batch !== latest.batch)) return { reason: "batch_interleaved" };
  const of = latest.of;
  if (!Number.isInteger(of) || of < 1 || tail.some((a) => a.of !== of || !Number.isInteger(a.part) || a.part < 1 || a.part > of)) {
    return { reason: "batch_inconsistent" };
  }
  const byPart = new Map();
  for (const a of tail) byPart.set(a.part, a);
  for (let k = 1; k <= of; k++) {
    const record = byPart.get(k);
    if (!record) return { reason: "batch_part_missing" };
    const problem = attemptProblem(record, { snapshot, requestSeq });
    if (problem) return { reason: `batch_part_${problem}` };
  }
  return {
    batch: { id: latest.batch, of, records: [...byPart.values()].sort((a, b) => a.part - b.part) },
    supersededBatch: earlierBatches(first, latest.batch),
  };
}

/** 16-hex ids of claim texts as sent (the same ids gate-runner receipts carry). */
export function claimIdsOf(claims) {
  return [...new Set((claims ?? []).map(String))].map((t) => sha256(t).slice(0, 16));
}

/**
 * A later gate {claim_ids, diff (whole-diff hash)} covers earlier gate-runner
 * attempts {claim_ids, diff}: the same whole diff and every claim of each.
 * Hashes only: a claim dropped since an earlier attempt is never covered.
 */
export function coversRunnerAttempts(later, runners) {
  const have = new Set(later?.claim_ids ?? []);
  return runners.every((r) => Array.isArray(r?.claim_ids) && typeof r.diff === "string" && r.diff === later?.diff && r.claim_ids.every((id) => have.has(id)));
}

/** True when `claims` contains every claim in `required` (exact text). */
export function claimsCover(required, claims) {
  const have = new Set((claims ?? []).map(String));
  return (required ?? []).every((c) => have.has(String(c)));
}

/**
 * A later gate (a single call, or a replacement batch) replaces the earlier
 * batch attempts `earlier` (their inputs as sent: {request, claims, diff}).
 * `later` is {claims, diff}: its claim set and the whole diff it evaluated.
 * For every earlier batch, the later gate must cover both its claims and its
 * patch: the same claim set (label `claims` hash) and the same whole diff
 * (label `diff` hash); or, when every part of that batch is known, a superset
 * of its claims and a diff containing every unit (file header, hunk) of its
 * whole diff. An earlier attempt whose input is unknown makes the
 * replacement unprovable.
 */
export function coversEarlierBatches(later, earlier) {
  const groups = new Map();
  for (const attempt of earlier) {
    const label = parseBatchLabel(attempt?.request);
    if (!label || !Array.isArray(attempt.claims) || typeof attempt.diff !== "string") return false;
    const group = groups.get(label.id) ?? { label, parts: new Map() };
    group.parts.set(label.part, attempt);
    groups.set(label.id, group);
  }
  const laterDiff = typeof later?.diff === "string" ? later.diff : null;
  if (laterDiff === null) return false;
  const ownClaims = claimSetHash(later.claims);
  const ownDiff = diffHash(laterDiff);
  for (const { label, parts } of groups.values()) {
    if (ownClaims === label.claims && ownDiff === label.diff) continue;
    if (parts.size !== label.of) return false;
    const known = [...parts.values()];
    if (!claimsCover(known.flatMap((p) => p.claims), later.claims)) return false;
    const slices = new Map(known.map((p) => [parseBatchLabel(p.request).slice, p.diff]));
    let whole = "";
    for (let i = 1; i <= label.slices; i++) {
      if (!slices.has(i)) return false;
      whole += slices.get(i);
    }
    if (diffHash(whole) !== label.diff) return false;
    if (!diffUnits(whole).every((u) => laterDiff.includes(u.text))) return false;
  }
  return true;
}

/**
 * Check that the parts of a batch (one per part number, each the complete
 * input as actually sent) form the complete batch their labels describe:
 * same manifest, parts 1..n present once, every diff slice present with one
 * text, the whole diff and the union of claims matching the label hashes,
 * and the id recomputed from the per-part digests of the real inputs; the
 * snapshot must equal `snapshot` when given. Returns {ok, problems, whole,
 * claims}.
 */
export function verifyBatchContents(parts, { snapshot = null } = {}) {
  const problems = [];
  const labels = parts.map((p) => parseBatchLabel(p?.request));
  if (labels.length === 0 || labels.some((l) => !l)) return { ok: false, problems: ["label_missing_or_invalid"] };
  const [ref] = labels;
  const same = (l) => l.id === ref.id && l.of === ref.of && l.slices === ref.slices && l.claims === ref.claims && l.diff === ref.diff && l.snap === ref.snap;
  if (!labels.every(same)) return { ok: false, problems: ["manifest_mismatch"] };
  const partNumbers = labels.map((l) => l.part).sort((a, b) => a - b);
  if (partNumbers.length !== ref.of || partNumbers.some((n, i) => n !== i + 1)) problems.push("parts_incomplete_or_duplicated");
  if (snapshot && ref.snap !== snapshot) problems.push("manifest_snapshot_mismatch");
  const slices = new Map();
  parts.forEach((p, i) => {
    const s = labels[i].slice;
    const diff = typeof p.diff === "string" ? p.diff : null;
    if (diff === null) problems.push("diff_missing");
    else if (slices.has(s) && slices.get(s) !== diff) problems.push("slice_conflict");
    else slices.set(s, diff);
  });
  let whole = "";
  for (let s = 1; s <= ref.slices; s++) {
    if (!slices.has(s)) {
      problems.push("slice_missing");
      break;
    }
    whole += slices.get(s);
  }
  const claims = parts.flatMap((p) => (Array.isArray(p.claims) ? p.claims : []));
  if (problems.length === 0) {
    if (diffHash(whole) !== ref.diff) problems.push("diff_mismatch");
    if (claimSetHash(claims) !== ref.claims) problems.push("claim_set_mismatch");
    const ordered = parts.map((p, i) => [labels[i].part, partDigest(p)]).sort((a, b) => a[0] - b[0]).map(([, d]) => d);
    const expected = batchId({ snap: ref.snap, slices: ref.slices, claims: ref.claims, diff: ref.diff, digests: ordered });
    if (expected !== ref.id) problems.push("manifest_id_mismatch");
  }
  const ok = problems.length === 0;
  return { ok, problems: [...new Set(problems)], whole: ok ? whole : null, claims: ok ? claims : null };
}

// ── Payload preparation ─────────────────────────────────────────────────────

const HUNK_START = /^@@ /;
const SECTION_START = /^diff --(?:git|cc|combined) /;

/** Split text into chunks of at most `max` chars, at line ends where possible; concatenation is exact. */
export function splitExact(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max - 1) + 1;
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

function sectionPath(header) {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(header);
  if (plus && plus[1] !== "/dev/null") return plus[1];
  const minus = /^--- (?:a\/)?(.+)$/m.exec(header);
  if (minus && minus[1] !== "/dev/null") return minus[1];
  const git = /^diff --git a\/(.+?) b\/(.+)$/m.exec(header);
  return git ? git[2] : null;
}

/**
 * Units of a unified diff as exact substrings (their concatenation is the
 * input): a preamble, then per file section a header and its hunks. A
 * section without hunks (binary, mode-only, empty new file) is one unit.
 * Hunk units get ids hunk-1, hunk-2, ... in order.
 */
export function diffUnits(text) {
  const lines = text.split(/(?<=\n)/);
  const units = [];
  let current = { kind: "preamble", path: null, text: "" };
  let sectionHeader = null;
  let hunkCount = 0;
  const flush = () => {
    if (current.text !== "") units.push(current);
  };
  for (const line of lines) {
    if (SECTION_START.test(line)) {
      flush();
      sectionHeader = { kind: "header", path: null, text: line, hunks: 0 };
      current = sectionHeader;
    } else if (HUNK_START.test(line) && sectionHeader) {
      flush();
      if (sectionHeader.path === null) sectionHeader.path = sectionPath(sectionHeader.text);
      sectionHeader.hunks += 1;
      current = { kind: "hunk", path: sectionHeader.path, text: line };
    } else current.text += line;
  }
  flush();
  for (const u of units) {
    if (u.kind === "header") {
      if (u.path === null) u.path = sectionPath(u.text);
      // A section without hunks is itself the change.
      if (u.hunks === 0) u.kind = "hunk";
    }
    if (u.kind === "hunk") u.id = `hunk-${++hunkCount}`;
    delete u.hunks;
  }
  return units;
}

/** Hunk listing for choosing evidence ids: id, path and the @@ line (no bodies). */
export function listHunks(diffText) {
  return diffUnits(diffText)
    .filter((u) => u.kind === "hunk")
    .map((u) => ({ id: u.id, path: u.path, header: u.text.split("\n", 1)[0].slice(0, 200), chars: u.text.length }));
}

const EXCERPT_ID = /^[a-z][a-z0-9_.-]{0,40}$/;

function renderCommand(c) {
  const exit = Number.isInteger(c.exit) ? String(c.exit) : "unknown (not reported by the tool)";
  return `$ ${c.command}\nexit: ${exit}\n${c.output}`;
}

/** Evidence items for one catalog entry, split into identified continuations when oversized. */
function evidenceItems(id, header, body) {
  const budget = BATCH_LIMITS.evidenceItemChars;
  const whole = `${header}\n${body}`;
  if (whole.length <= budget) return [{ id, text: whole }];
  const chunks = splitExact(body, Math.max(1000, budget - header.length - 40));
  return chunks.map((chunk, i) => ({ id: `${id}#${i + 1}`, text: `${header} (continuation ${i + 1}/${chunks.length})\n${chunk}` }));
}

/**
 * Prepare jev_gate calls from real material. Input:
 *   {request, diff, claims: [{text, evidence: [ids]}],
 *    commands?: [{command, exit: int|null, output}],
 *    excerpts?: [{id, path, lines?: [a, b], text}]}
 * Evidence ids: hunk-N (from listHunks), file:<path> (all hunks of a file),
 * cmd-N (1-based index into commands) and excerpt ids. Everything is
 * sanitized first. Returns {ok, problems, limits, batch, hunks, calls}; when
 * ok is false, calls is empty: nothing must be sent as if it were complete.
 * Structural pairing does not prove that the evidence supports the claim.
 */
export function prepareGateBatch(input, { denylist, snapshot }) {
  const problems = [];
  const limits = { redactions: [], omitted: [], omitted_lines: 0, uncited_hunks: [], tests_truncated_chars: 0, partitioned: false };
  const fail = () => ({ ok: false, problems, limits, batch: null, hunks: [], calls: [] });
  if (!input || typeof input !== "object") {
    problems.push("input must be a JSON object");
    return fail();
  }
  const { request, diff } = input;
  const claimsIn = Array.isArray(input.claims) ? input.claims : null;
  const commands = input.commands === undefined ? [] : input.commands;
  const excerpts = input.excerpts === undefined ? [] : input.excerpts;
  if (typeof request !== "string" || request.trim() === "") problems.push("request must be a non-empty string");
  if (typeof diff !== "string" || diff.trim() === "") problems.push("diff must be a non-empty string");
  if (!claimsIn || claimsIn.length === 0) problems.push("claims must be a non-empty array");
  if (!Array.isArray(commands)) problems.push("commands must be an array");
  if (!Array.isArray(excerpts)) problems.push("excerpts must be an array");
  if (!snapshot) problems.push("snapshot_unknown: the work-tree snapshot could not be computed");
  if (problems.length) return fail();

  // Redactions (credential markers) are allowed. Content that sanitizing
  // removed from the patch or from evidence would leave part of the work
  // unevaluated, so it is a problem: nothing is prepared for a gate.
  const absorb = (result, source) => {
    limits.redactions.push(...(result.redactions ?? []));
    limits.omitted.push(...(result.omitted ?? []).map((o) => ({ source, ...o })));
    limits.omitted_lines += result.omitted_lines ?? 0;
    if (source && ((result.omitted ?? []).length > 0 || (result.omitted_lines ?? 0) > 0)) {
      const sections = (result.omitted ?? []).map((o) => `${o.path ?? "(unparseable path)"}: ${o.reason}`);
      const lines = result.omitted_lines ? [`${result.omitted_lines} suspicious line(s) replaced`] : [];
      problems.push(`${source}: sanitizing removed content (${[...sections, ...lines].join("; ")}); that part cannot be evaluated, so the work cannot be gated as complete`);
    }
    return result.text;
  };
  const cleanRequest = absorb(sanitizeText(request), null);
  const cleanDiff = absorb(sanitizeDiff(diff, denylist), "diff");
  if (cleanDiff.trim() === "") problems.push("diff is empty after sanitization");
  if (problems.length) return fail();

  // Evidence catalog.
  const catalog = new Map();
  const units = diffUnits(cleanDiff);
  const hunks = units.filter((u) => u.kind === "hunk");
  for (const h of hunks) catalog.set(h.id, evidenceItems(h.id, `[${h.id}] ${h.path ?? "(unknown path)"}`, h.text));
  commands.forEach((c, i) => {
    const id = `cmd-${i + 1}`;
    if (!c || typeof c.command !== "string" || c.command.trim() === "" || typeof c.output !== "string") {
      problems.push(`${id}: needs a command string and its real output string`);
      return;
    }
    if (c.exit !== null && c.exit !== undefined && !Number.isInteger(c.exit)) problems.push(`${id}: exit must be an integer or null (unknown)`);
    const text = absorb(sanitizeText(renderCommand({ ...c, exit: c.exit ?? null })), id);
    const [header, ...body] = text.split("\n");
    catalog.set(id, evidenceItems(id, `[${id}] ${header}`, body.join("\n")));
  });
  excerpts.forEach((x, i) => {
    const label = `excerpts[${i}]`;
    if (!x || typeof x.id !== "string" || !EXCERPT_ID.test(x.id) || /^(?:hunk-|cmd-|file:)/.test(x.id) || catalog.has(x.id)) {
      problems.push(`${label}: id must match ${EXCERPT_ID} and be unique (not hunk-*, cmd-*, file:*)`);
      return;
    }
    if (typeof x.path !== "string" || typeof x.text !== "string" || x.text.trim() === "") {
      problems.push(`${label}: needs path and the real excerpt text`);
      return;
    }
    if (exclusionReason(denylist, x.path)) {
      problems.push(`${label}: ${x.path} is excluded by the jev-flow policy and cannot be sent`);
      return;
    }
    const range = Array.isArray(x.lines) && x.lines.length === 2 ? `:${x.lines[0]}-${x.lines[1]}` : "";
    catalog.set(x.id, evidenceItems(x.id, `[${x.id}] ${x.path}${range}`, absorb(sanitizeText(x.text), `excerpt ${x.id}`)));
  });

  // Claims: text, de-duplication, evidence resolution.
  const hunkIdsOfFile = (path) => hunks.filter((h) => h.path === path).map((h) => h.id);
  const claimMap = new Map();
  claimsIn.forEach((c, i) => {
    const label = `claims[${i}]`;
    const text = typeof c?.text === "string" ? absorb(sanitizeText(c.text.trim()), label) : "";
    if (text === "") return problems.push(`${label}: text must be a non-empty string`);
    if (text.length > GATE_LIMITS.claimChars) return problems.push(`${label}: longer than ${GATE_LIMITS.claimChars} characters; the tool would truncate it`);
    if (/^<[^>]*>$/.test(text)) return problems.push(`${label}: is a placeholder, not a claim`);
    const refs = Array.isArray(c.evidence) ? c.evidence.map(String) : [];
    if (refs.length === 0) return problems.push(`${label}: no evidence ids; every claim needs its supporting diff hunks, excerpts or command output`);
    const ids = [];
    for (const ref of refs) {
      const expanded = ref.startsWith("file:") ? hunkIdsOfFile(ref.slice(5)) : [ref];
      if (expanded.length === 0 || expanded.some((id) => !catalog.has(id))) {
        problems.push(`${label}: unknown evidence id ${ref}`);
        continue;
      }
      ids.push(...expanded);
    }
    const entry = claimMap.get(text) ?? { text, ids: new Set() };
    ids.forEach((id) => entry.ids.add(id));
    claimMap.set(text, entry);
  });
  if (problems.length) return fail();
  const claims = [...claimMap.values()];
  const cited = new Set(claims.flatMap((c) => [...c.ids]));
  limits.uncited_hunks = hunks.filter((h) => !cited.has(h.id)).map((h) => h.id);

  // Diff slices: contiguous, exact, within budget.
  // A hunk that does not fit fills the current slice up to a line end and
  // continues in the next; a file header that does not fit starts a new slice,
  // so it always travels with the beginning of its first hunk.
  const slices = [];
  const budget = BATCH_LIMITS.diffSliceChars;
  let cur = { text: "", hunks: new Set() };
  const flush = () => {
    slices.push(cur);
    cur = { text: "", hunks: new Set() };
  };
  for (const u of units) {
    let text = u.text;
    while (text.length > 0) {
      const room = budget - cur.text.length;
      if (text.length <= room) {
        cur.text += text;
        if (u.id) cur.hunks.add(u.id);
        break;
      }
      let cut = u.kind === "hunk" ? text.lastIndexOf("\n", room - 1) + 1 : 0;
      if (cut <= 0) {
        if (cur.text !== "") {
          flush();
          continue;
        }
        cut = room;
      }
      cur.text += text.slice(0, cut);
      if (u.id) cur.hunks.add(u.id);
      text = text.slice(cut);
      flush();
    }
  }
  if (cur.text !== "") slices.push(cur);

  // Claims to slices: every slice that holds a cited hunk; the rest to slice 1.
  const sliceClaims = slices.map(() => []);
  for (const claim of claims) {
    const targets = slices.map((s, i) => ([...claim.ids].some((id) => s.hunks.has(id)) ? i : -1)).filter((i) => i >= 0);
    for (const i of targets.length ? targets : [0]) sliceClaims[i].push(claim);
  }
  sliceClaims.forEach((list, i) => {
    if (list.length === 0) {
      problems.push(`slice ${i + 1} (${[...slices[i].hunks].join(", ") || "no hunk"}) has no claim citing its changes; add a claim with that evidence or report the change as unverified`);
    }
  });
  if (problems.length) return fail();

  // Pack each slice's claims into calls within the evidence limits.
  const itemsOf = (claim) => [...claim.ids].flatMap((id) => catalog.get(id));
  const calls = [];
  slices.forEach((slice, si) => {
    let part = null;
    const open = () => {
      part = { slice: si + 1, claims: [], items: new Map(), chars: 0 };
      calls.push(part);
    };
    for (const claim of sliceClaims[si]) {
      const items = itemsOf(claim);
      const own = new Map(items.map((it) => [it.id, it]));
      const ownChars = [...own.values()].reduce((n, it) => n + it.text.length, 0);
      if (own.size > GATE_LIMITS.evidenceItems || ownChars > GATE_LIMITS.evidenceChars) {
        problems.push(`claim "${claim.text.slice(0, 80)}" needs ${own.size} evidence items / ${ownChars} characters, above one call's limits; narrow the claim`);
        continue;
      }
      const fits = (p) => {
        if (!p || p.claims.length >= GATE_LIMITS.claims) return false;
        const added = [...own.values()].filter((it) => !p.items.has(it.id));
        return p.items.size + added.length <= GATE_LIMITS.evidenceItems && p.chars + added.reduce((n, it) => n + it.text.length, 0) <= GATE_LIMITS.evidenceChars;
      };
      if (!fits(part)) open();
      part.claims.push(claim.text);
      for (const it of own.values()) {
        if (!part.items.has(it.id)) {
          part.items.set(it.id, it);
          part.chars += it.text.length;
        }
      }
    }
  });
  if (problems.length) return fail();
  if (calls.length > BATCH_LIMITS.maxParts) {
    problems.push(`the patch needs ${calls.length} gate calls, above the ${BATCH_LIMITS.maxParts}-part batch limit; split the task`);
    return fail();
  }

  // Tests field: rendered command output, cut visibly when too long.
  let tests;
  const cmdTexts = [...catalog.entries()].filter(([id]) => id.startsWith("cmd-")).map(([, items]) => items.map((it) => it.text).join("\n"));
  if (cmdTexts.length) {
    tests = cmdTexts.join("\n\n");
    if (tests.length > BATCH_LIMITS.testsChars) {
      limits.tests_truncated_chars = tests.length - BATCH_LIMITS.testsChars;
      tests = `${tests.slice(0, BATCH_LIMITS.testsChars)}\n[jev-flow: tests field cut, ${limits.tests_truncated_chars} characters omitted here; the full output is in the cmd-* evidence items]`;
    }
  }

  const n = calls.length;
  const m = slices.length;
  const claimHash = claimSetHash(claims.map((c) => c.text));
  const wholeHash = diffHash(cleanDiff);
  // Payloads without the label first: their digests bind the batch id.
  const payloads = calls.map((p) => {
    const payload = { request: cleanRequest, diff: slices[p.slice - 1].text, claims: p.claims, evidence: [...p.items.values()] };
    if (tests !== undefined) payload.tests = tests;
    return payload;
  });
  const id = batchId({ snap: snapshot, slices: m, claims: claimHash, diff: wholeHash, digests: payloads.map(partDigest) });
  limits.partitioned = n > 1;
  const out = payloads.map((payload, i) => {
    payload.request = `${formatBatchLabel({ id, part: i + 1, of: n, slice: calls[i].slice, slices: m, claims: claimHash, diff: wholeHash, snap: snapshot })}\n${cleanRequest}`;
    if (payload.request.length > GATE_LIMITS.docChars) problems.push(`part ${i + 1}: request longer than ${GATE_LIMITS.docChars} characters`);
    return { part: i + 1, of: n, input: payload };
  });
  if (problems.length) return fail();
  return {
    ok: true,
    problems,
    limits,
    batch: { id, parts: n, slices: m, claims: claimHash, diff: wholeHash, snapshot },
    hunks: hunks.map((h) => ({ id: h.id, path: h.path, chars: h.text.length })),
    calls: out,
  };
}

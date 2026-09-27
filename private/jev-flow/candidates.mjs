// Candidate builder for jev-locator: lexical, deterministic preselection of
// repository windows for jev_find / jev_rerank. Never writes to disk.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { exclusionReason, loadDenylist } from "./paths.mjs";
import { FIXED_PHRASES } from "./policy.mjs";
import { isSuspiciousText, redact } from "./sanitize.mjs";
import { sha256 } from "./state.mjs";

export const LIMITS = Object.freeze({
  maxCandidates: 48,
  maxChunkChars: 1000,
  maxWindowLines: 60,
  defaultMaxFileBytes: 1024 * 1024,
  maxFiles: 20000,
  timeBudgetMs: 10000,
});

/** Locator ranking rule (F4): above this many candidates, or from 2+ files, Jev ranks them. */
export const RANK_RULE = Object.freeze({ maxPlainCandidates: 3, topK: 5, maxQueryChars: 2000 });

export class UsageError extends Error {}

/** A query that is one exact token: an identifier, a dotted/qualified name or a path. */
export function exactToken(query) {
  const q = String(query ?? "").trim();
  return /^[A-Za-z_$][\w$]*(?:(?:\.|::|\/|-)[\w$]+)*(?:\.[A-Za-z0-9]+)?$/.test(q) && q.length >= 3 ? q : null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lexical exact-match test for an exact token. A token with "/" is a path: it
 * matches a file whose repository path is the token or ends with "/token".
 * Any other token (identifier, qualified or dotted name, file name) matches a
 * path the same way, or a line only as a whole, delimited token,
 * case-sensitive: `cache` does not match `cacheable`, `caching` or `Cache`.
 */
export function exactMatcher(token) {
  if (!token) return null;
  const bounded = new RegExp(`(?<![\\w$])${escapeRegExp(token)}(?![\\w$])`);
  const isPath = token.includes("/");
  return {
    token,
    matchesPath: (rel) => rel === token || rel.endsWith(`/${token}`),
    matchesLine: isPath ? () => false : (line) => bounded.test(line),
  };
}

/**
 * The locator's next step for a candidate set (F4). First the threshold rule:
 * - Jev disabled -> "none" (local reads only);
 * - no candidates -> "none" (widen or rephrase locally; never claim absence);
 * - more than 3 candidates, or candidates from 2+ files -> "jev_find" when the
 *   question asks for one definitive location (single), otherwise "jev_rerank";
 * - otherwise (1-3 candidates in one file) -> "plain": read them locally,
 *   without claiming the result is certain.
 * Exception: an exact token (a delimited identifier/qualified name, or a
 * path) found in exactly one file -> "plain" with confirm_by_reading: the
 * locator must read that match and use it only if it answers the question;
 * otherwise it follows `fallback` (the threshold rule, with its payload).
 * Lexical uniqueness is not proof that the match answers the question.
 * The payload for Jev is {query, candidates, top_k: 5}; the map stays local.
 */
export function recommendNext({ disabled, query, candidates, map, exactFiles, single }) {
  if (disabled) return { recommend: { tool: "none", reason: "jev_disabled" }, jev_payload: null };
  if (candidates.length === 0) return { recommend: { tool: "none", reason: "no_candidates" }, jev_payload: null };
  const files = new Set(candidates.map((c) => map[c.id]?.path));
  let base;
  if (candidates.length > RANK_RULE.maxPlainCandidates || files.size >= 2) {
    const tool = single ? "jev_find" : "jev_rerank";
    const reason = files.size >= 2 ? "candidates_in_several_files" : "more_than_3_candidates";
    base = {
      recommend: { tool, reason, candidates: candidates.length, files: files.size },
      jev_payload: { query: String(query).slice(0, RANK_RULE.maxQueryChars), candidates: candidates.map((c) => ({ id: c.id, text: c.text })), top_k: RANK_RULE.topK },
    };
  } else {
    base = { recommend: { tool: "plain", reason: "few_candidates_one_file", candidates: candidates.length }, jev_payload: null };
  }
  if (Array.isArray(exactFiles) && exactFiles.length === 1) {
    return {
      recommend: { tool: "plain", reason: "exact_match_in_one_file", path: exactFiles[0], confirm_by_reading: true, fallback: base.recommend },
      jev_payload: base.jev_payload,
    };
  }
  return base;
}

/**
 * Which Jev call the helper runs itself (R3): the recommended jev_rerank /
 * jev_find, or, with `fallback` (the locator read the exact match and it did
 * not answer the question), the fallback's. null when no call is due.
 */
export function dueJevCall(result, { fallback = false } = {}) {
  const rec = result?.recommend;
  if (!rec || !result.jev_payload) return null;
  const tool = fallback && rec.reason === "exact_match_in_one_file" ? rec.fallback?.tool : rec.tool;
  return tool === "jev_rerank" || tool === "jev_find" ? { tool, payload: result.jev_payload } : null;
}

/**
 * jev_find's existence verdict as upstream derives it (`existsVerdict` in
 * src/lib.ts, default thresholds found 0.7 / absent 0.35, as src/index.ts
 * calls it): the only values a valid answer can carry.
 */
export const EXISTS_VERDICTS = Object.freeze(["answered", "partial", "absent"]);
export function expectedExistsVerdict(exists) {
  if (exists >= 0.7) return "answered";
  return exists < 0.35 ? "absent" : "partial";
}

const isUnitScore = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * The helper's view of a jev_rerank / jev_find result (R7): ids mapped back to
 * path, lines and sha256 through the local map, candidate texts dropped,
 * entries sorted by score (descending; ties keep the server's order). The
 * whole result is {status: "invalid_response"} when any entry has an id that
 * was not sent or repeats, a score that is missing or outside [0, 1], or when
 * it is partial (not min(top_k, candidates sent) entries); for jev_find also
 * when `exists` is not a finite number in [0, 1] or `exists_verdict` is not
 * the upstream verdict for that `exists`. With `sent` unset,
 * the ids of `map` are the candidates sent. Ranking is never invented.
 */
export function mapJevResult(tool, result, map, { sent = null, topK = RANK_RULE.topK } = {}) {
  const invalid = { tool, status: "invalid_response" };
  const ids = new Set(sent ?? Object.keys(map ?? {}));
  const listKey = tool === "jev_rerank" ? "ranked" : "top";
  const scoreKey = tool === "jev_rerank" ? "relevance" : "probability";
  if (!result || result.tool !== tool || result.status === "invalid_response" || !Array.isArray(result[listKey])) return invalid;
  if (tool === "jev_find" && (!isUnitScore(result.exists) || !EXISTS_VERDICTS.includes(result.exists_verdict) || result.exists_verdict !== expectedExistsVerdict(result.exists))) return invalid;
  const entries = result[listKey];
  if (entries.length !== Math.min(topK, ids.size)) return invalid;
  const seen = new Set();
  for (const r of entries) {
    const score = r?.[scoreKey];
    if (typeof r?.id !== "string" || !ids.has(r.id) || !map?.[r.id] || seen.has(r.id)) return invalid;
    if (!isUnitScore(score)) return invalid;
    seen.add(r.id);
  }
  const sorted = entries.map((r, i) => ({ r, i })).sort((a, b) => b.r[scoreKey] - a.r[scoreKey] || a.i - b.i).map(({ r }) => r);
  const locate = (id) => ({ path: map[id].path, start_line: map[id].start_line, end_line: map[id].end_line, sha256: map[id].sha256 });
  if (tool === "jev_rerank") {
    return { tool, status: "ok", ranked: sorted.map((r, i) => ({ rank: i + 1, id: r.id, relevance: r.relevance, ...locate(r.id) })) };
  }
  return {
    tool,
    status: "ok",
    exists: result.exists,
    exists_verdict: result.exists_verdict,
    top: sorted.map((r) => ({ id: r.id, probability: r.probability, ...locate(r.id) })),
    note: "'absent' covers only the candidates sent, never the whole repository",
  };
}

/** The helper's stdout cap in locate mode (R7): bytes of the JSON line, newline included. */
export const COMPACT_MAX_BYTES = 4096;
const MAX_HITS = RANK_RULE.topK;
const MAX_REASON_CHARS = 80;

/** Deterministic reason label: the window kind and the query terms it matched lexically. */
export function reasonLabel(entry, maxChars = MAX_REASON_CHARS) {
  const kind = entry?.kind === "outline" ? "outline" : "window";
  const terms = Array.isArray(entry?.terms) ? entry.terms : [];
  const label = terms.length ? `${kind}; lexical terms: ${terms.join(", ")}` : `${kind}; path match`;
  if (label.length <= maxChars) return label;
  return maxChars > kind.length + 1 ? `${label.slice(0, maxChars - 1)}…` : kind;
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/**
 * The only stdout of the helper in locate mode (R7): one JSON object of at
 * most COMPACT_MAX_BYTES (UTF-8, trailing newline included) with at most 5
 * hits {path, start_line, end_line, sha256, score, reason}, the ordering
 * (`semantic` from a valid Jev answer, otherwise `lexical`), the Jev status
 * and call count, coverage and the count of candidates not listed. No query,
 * candidate texts, map or payload. Over the cap, reasons are shortened first,
 * then hits dropped from the tail (counted in `omitted`), then optional
 * metadata dropped (`metadata_dropped`); paths and hashes are never cut.
 * Every emitted field is bounded (enums, integers, short fixed-size strings),
 * and the returned line is never over the cap.
 * `jev`: null when no call was due, else {status, calls?, reason?, result?}
 * where result is mapJevResult's ok answer.
 */
const JEV_STATUSES = new Set(["ok", "unavailable", "invalid_response", "skipped", "not_needed", "disabled"]);
const ROUTE_MAX_CHARS = 80;
const boundedRoute = (value) => String(value ?? "unknown").slice(0, ROUTE_MAX_CHARS);

export function compactReport(result, jev = null, { fallback = false, elapsedMs } = {}) {
  const rec = result?.recommend ?? {};
  const map = result?.map ?? {};
  const candidates = result?.candidates ?? [];
  const report = { v: 1 };
  let hits = [];
  if (result?.disabled) {
    Object.assign(report, { mode: "disabled", ordering: "lexical", jev: "disabled", jev_calls: 0, route: "jev_disabled" });
  } else if (jev?.status === "ok" && jev.result) {
    const find = jev.result.tool === "jev_find";
    Object.assign(report, { mode: find ? "find" : "rerank", ordering: "semantic", jev: "ok", jev_calls: jev.calls ?? 1, route: boundedRoute(fallback ? `fallback:${rec.fallback?.reason ?? rec.reason}` : rec.reason) });
    // Only values mapJevResult validated; never an arbitrary object or string from the server.
    if (find) {
      report.exists_verdict = EXISTS_VERDICTS.includes(jev.result.exists_verdict) ? jev.result.exists_verdict : null;
      report.exists = isUnitScore(jev.result.exists) ? jev.result.exists : null;
    }
    const list = find ? jev.result.top : jev.result.ranked;
    hits = list.map((r) => ({ id: r.id, score: find ? r.probability : r.relevance }));
  } else {
    const due = Boolean(jev);
    const mode = due ? (jev.tool === "jev_find" ? "find" : "rerank") : rec.reason === "exact_match_in_one_file" ? "exact_match" : rec.tool === "plain" ? "plain" : "none";
    const status = due ? (JEV_STATUSES.has(jev.status) && jev.status !== "ok" ? jev.status : "unavailable") : "not_needed";
    Object.assign(report, { mode, ordering: "lexical", jev: status, jev_calls: due && Number.isInteger(jev.calls) ? jev.calls : 0, route: boundedRoute(fallback && due ? `fallback:${rec.fallback?.reason ?? rec.reason}` : rec.reason) });
    if (due && jev.reason) report.jev_reason = String(jev.reason).slice(0, 200);
    let pool = candidates;
    if (mode === "exact_match") {
      Object.assign(report, { confirm_by_reading: true, exact_path: rec.path, fallback_tool: ["jev_rerank", "jev_find", "plain", "none"].includes(rec.fallback?.tool) ? rec.fallback.tool : "none" });
      pool = candidates.filter((c) => map[c.id]?.path === rec.path);
    }
    hits = pool.map((c) => ({ id: c.id, score: map[c.id]?.score ?? 0 }));
  }
  hits = hits.slice(0, MAX_HITS).filter((h) => map[h.id]);
  const hit = (h, maxChars) => {
    const m = map[h.id];
    return { path: m.path, start_line: m.start_line, end_line: m.end_line, sha256: m.sha256, score: h.score, reason: reasonLabel(m, maxChars) };
  };
  const cov = result?.coverage ?? {};
  report.coverage_complete = cov.complete === true;
  const reasons = (Array.isArray(cov.reasons) ? cov.reasons : cov.reason ? [cov.reason] : []).filter((r) => typeof r === "string").slice(0, 12).map((r) => r.slice(0, 40));
  if (reasons.length) report.coverage_reasons = reasons;
  if (report.mode === "find" && report.ordering === "semantic") report.note = "'absent' covers only the candidates sent, never the whole repository";
  else if (report.ordering === "lexical" && hits.length) report.note = "lexical order, not semantically ranked";
  else if (!hits.length && report.mode === "none") report.note = "no lexical candidates: rephrase or widen once; not proof of absence";
  if (Number.isFinite(elapsedMs)) report.elapsed_ms = Math.round(elapsedMs);

  let maxChars = MAX_REASON_CHARS;
  const render = () => `${JSON.stringify({ ...report, hits: hits.map((h) => hit(h, maxChars)), omitted: candidates.length - hits.length })}\n`;
  let text = render();
  // Over the cap: shorter reasons (down to the bare window kind), then fewer hits.
  for (const shorter of [40, 0]) {
    if (byteLength(text) <= COMPACT_MAX_BYTES) break;
    maxChars = shorter;
    report.reasons_shortened = true;
    text = render();
  }
  while (byteLength(text) > COMPACT_MAX_BYTES && hits.length) {
    hits = hits.slice(0, -1);
    report.size_capped = true;
    text = render();
  }
  // Then optional metadata (the rest is enums, integers and bounded strings).
  for (const key of ["jev_reason", "note", "coverage_reasons", "elapsed_ms", "exact_path"]) {
    if (byteLength(text) <= COMPACT_MAX_BYTES) break;
    if (!(key in report)) continue;
    delete report[key];
    report.metadata_dropped = true;
    text = render();
  }
  if (byteLength(text) > COMPACT_MAX_BYTES) {
    // Unreachable with the bounds above; kept so the cap holds by construction.
    const minimal = { v: 1, mode: report.mode, ordering: report.ordering, jev: report.jev, jev_calls: report.jev_calls, route: report.route, coverage_complete: report.coverage_complete, hits: [], omitted: candidates.length, size_capped: true, metadata_dropped: true };
    text = `${JSON.stringify(minimal)}\n`;
  }
  return text;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "why",
  "with", "code", "file", "files", "find", "implementation", "implemented", "logic",
]);

const SUFFIXES = [
  "izations", "ization", "isations", "isation", "ations", "ation", "izing", "ising", "ized", "ised",
  "izes", "ises", "ize", "ise", "ings", "ing", "ers", "er", "ied", "ies", "es", "ed", "s",
];

export function stem(word) {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Lowercase word tokens; splits camelCase, snake_case, kebab-case and digits. */
export function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

export function queryTerms(query) {
  return [...new Set(tokenize(query).filter((t) => !STOPWORDS.has(t)).map(stem))];
}

const OUTLINE_LINE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|def|fn|func|struct|impl|trait|module|package|public|private|protected|static|object|fun|val)\b/;

function listFiles(repoRoot, scope) {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  if (scope) args.push("--", scope);
  const out = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20000,
  });
  // --exclude-standard does not drop tracked files that match ignore rules; list them to skip.
  const ignoredArgs = ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"];
  if (scope) ignoredArgs.push("--", scope);
  const ignored = new Set(
    execFileSync("git", ignoredArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    }).split("\0").filter(Boolean),
  );
  const files = [...new Set(out.split("\0").filter(Boolean))].sort();
  return { files: files.filter((f) => !ignored.has(f)), ignored: files.filter((f) => ignored.has(f)).length };
}

function lineTermHits(line, terms) {
  const stems = new Set(tokenize(line).map(stem));
  const hits = [];
  for (const term of terms) if (stems.has(term)) hits.push(term);
  return hits;
}

/** Query terms matched lexically in lines start..end of a file (the window actually emitted), in query order. */
function windowTerms(file, start, end, terms) {
  const found = new Set();
  for (const hit of file.lineHits) if (hit.line >= start && hit.line <= end) for (const t of hit.hits) found.add(t);
  return terms.filter((t) => found.has(t));
}

function buildHeader(path, start, end, kind) {
  return kind === "outline" ? `${path}:${start}-${end} (outline)\n` : `${path}:${start}-${end}\n`;
}

/**
 * Fit a window into the character budget, header included. Lines are
 * dropped from the edge farthest from the anchor; a single over-long line is
 * cut with an explicit marker.
 */
function fitWindow(path, lines, start, anchor, chunkChars) {
  let lo = start;
  let hi = start + lines.length - 1;
  const textFor = (a, b) => buildHeader(path, a, b, "window") + lines.slice(a - start, b - start + 1).join("\n");
  while (hi > lo && textFor(lo, hi).length > chunkChars) {
    if (anchor - lo > hi - anchor) lo++;
    else hi--;
  }
  let text = textFor(lo, hi);
  let lineCut = false;
  if (text.length > chunkChars) {
    const header = buildHeader(path, lo, hi, "window");
    const room = chunkChars - header.length - " […line truncated]".length;
    if (room <= 0) return null;
    text = header + lines[lo - start].slice(0, room) + " […line truncated]";
    lineCut = true;
  }
  return { text, start: lo, end: hi, lineCut };
}

/**
 * Build candidates. Options: root, query, limit, chunkChars, windowLines,
 * maxFileBytes, maxFiles, timeBudgetMs, now (for tests).
 */
export function buildCandidates(options) {
  const started = Date.now();
  const limit = options.limit ?? LIMITS.maxCandidates;
  const chunkChars = options.chunkChars ?? LIMITS.maxChunkChars;
  const windowLines = options.windowLines ?? LIMITS.maxWindowLines;
  const maxFileBytes = options.maxFileBytes ?? LIMITS.defaultMaxFileBytes;
  const maxFiles = options.maxFiles ?? LIMITS.maxFiles;
  const timeBudgetMs = options.timeBudgetMs ?? LIMITS.timeBudgetMs;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxCandidates) {
    throw new UsageError(`--limit must be an integer between 1 and ${LIMITS.maxCandidates}`);
  }
  if (!Number.isInteger(chunkChars) || chunkChars < 200 || chunkChars > LIMITS.maxChunkChars) {
    throw new UsageError(`--chunk-chars must be an integer between 200 and ${LIMITS.maxChunkChars}`);
  }
  if (!Number.isInteger(windowLines) || windowLines < 1 || windowLines > LIMITS.maxWindowLines) {
    throw new UsageError(`--window-lines must be an integer between 1 and ${LIMITS.maxWindowLines}`);
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) throw new UsageError("--max-file-bytes must be a positive integer");
  const terms = queryTerms(options.query);
  if (terms.length === 0) throw new UsageError("--query must contain at least one searchable word");

  const rootAbs = resolve(options.root ?? ".");
  let repoRoot;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new UsageError(`not a git work tree: ${rootAbs}`);
  }
  const repoReal = realpathSync(repoRoot);
  const rootReal = realpathSync(rootAbs);
  const scope = relative(repoReal, rootReal).split(sep).join("/");
  const denylist = loadDenylist(repoRoot);
  const base = {
    query: options.query,
    root: repoRoot,
    scope: scope || ".",
    terms,
    limits: { limit, chunk_chars: chunkChars, window_lines: windowLines, max_file_bytes: maxFileBytes },
  };
  if (denylist.disabled) {
    return {
      ...base,
      disabled: true,
      reason: FIXED_PHRASES.disabled,
      candidates: [],
      map: {},
      coverage: { complete: false, reason: "denylist_disables_repo" },
      omitted: [],
      ...recommendNext({ disabled: true }),
    };
  }

  const skipped = { ignored: 0, excluded: 0, denylisted: 0, symlink: 0, outside_root: 0, not_regular: 0, missing: 0, binary: 0, too_large: 0, invalid_utf8: 0, unreadable: 0 };
  const incompleteReasons = new Set();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const listing = listFiles(repoRoot, scope && scope !== "" ? scope : null);
  const files = listing.files;
  skipped.ignored = listing.ignored;
  const scored = [];
  let considered = 0;
  for (const rel of files) {
    if (considered >= maxFiles) {
      incompleteReasons.add("max_files_reached");
      break;
    }
    if (Date.now() - started > timeBudgetMs) {
      incompleteReasons.add("time_budget_exceeded");
      break;
    }
    const reason = exclusionReason(denylist, rel);
    if (reason === "permanent_exclusion") {
      skipped.excluded++;
      continue;
    }
    if (reason === "denylisted") {
      skipped.denylisted++;
      continue;
    }
    const abs = join(repoRoot, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      skipped.missing++;
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.symlink++;
      continue;
    }
    if (!st.isFile()) {
      skipped.not_regular++;
      continue;
    }
    try {
      const real = realpathSync(abs);
      if (real !== repoReal && !real.startsWith(repoReal + sep)) {
        skipped.outside_root++;
        continue;
      }
    } catch {
      skipped.unreadable++;
      incompleteReasons.add("unreadable_files");
      continue;
    }
    considered++;
    if (st.size > maxFileBytes) {
      skipped.too_large++;
      incompleteReasons.add("large_files_skipped");
      continue;
    }
    let buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      skipped.unreadable++;
      incompleteReasons.add("unreadable_files");
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      skipped.binary++;
      continue;
    }
    let text;
    try {
      text = decoder.decode(buffer);
    } catch {
      skipped.invalid_utf8++;
      incompleteReasons.add("invalid_utf8_skipped");
      continue;
    }
    const pathTerms = new Set(tokenize(rel).map(stem));
    const pathHits = terms.filter((t) => pathTerms.has(t));
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const lineHits = [];
    const termCounts = new Map();
    lines.forEach((line, i) => {
      if (line.length > 4000) return;
      const hits = lineTermHits(line, terms);
      if (hits.length) {
        lineHits.push({ line: i + 1, hits });
        for (const h of hits) termCounts.set(h, (termCounts.get(h) ?? 0) + 1);
      }
    });
    if (pathHits.length === 0 && lineHits.length === 0) continue;
    const distinct = new Set([...pathHits, ...termCounts.keys()]);
    const fileScore =
      3 * pathHits.length +
      [...termCounts.values()].reduce((sum, n) => sum + Math.min(n, 10), 0) +
      5 * distinct.size;
    // Redact the whole file once, preserving line count, so every fragment is
    // cut from redacted text and still maps to its original line numbers.
    const redactedLines = redact(lines.join("\n")).text.split("\n");
    if (redactedLines.length !== lines.length) throw new Error(`redaction changed the line count of ${rel}`);
    scored.push({ rel, sha: sha256(buffer), lines, redactedLines, lineHits, pathHits, fileScore, distinct: distinct.size });
  }

  // Windows per file: cluster hit lines, center on the densest line.
  const windows = [];
  for (const file of scored) {
    if (file.lineHits.length === 0) {
      const outline = [];
      file.lines.forEach((line, i) => {
        if (OUTLINE_LINE.test(line)) outline.push({ n: i + 1, text: file.redactedLines[i].trim().slice(0, 160) });
      });
      windows.push({ file, kind: "outline", outline, score: file.fileScore });
      continue;
    }
    const clusters = [];
    for (const hit of file.lineHits) {
      const last = clusters[clusters.length - 1];
      if (last && hit.line - last[0].line < windowLines) last.push(hit);
      else clusters.push([hit]);
    }
    for (const cluster of clusters) {
      const densest = cluster.reduce((best, h) => (h.hits.length > best.hits.length ? h : best), cluster[0]);
      const first = cluster[0].line;
      const lastLine = cluster[cluster.length - 1].line;
      let start = Math.max(1, Math.min(first, densest.line - Math.floor(windowLines / 2)));
      let end = Math.min(file.lines.length, start + windowLines - 1);
      if (end < lastLine && lastLine - start < windowLines) end = lastLine;
      start = Math.max(1, Math.min(start, end - windowLines + 1));
      const clusterTerms = new Set(cluster.flatMap((h) => h.hits));
      windows.push({
        file,
        kind: "window",
        start,
        end,
        anchor: densest.line,
        score: file.fileScore + 10 * clusterTerms.size + cluster.length,
      });
    }
  }
  windows.sort(
    (a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel) || (a.start ?? 0) - (b.start ?? 0),
  );

  const candidates = [];
  const map = {};
  const omitted = [];
  let lineCuts = 0;
  let windowsTotal = 0;
  for (const w of windows) {
    windowsTotal++;
    if (candidates.length >= limit) continue;
    let built = null;
    if (w.kind === "outline") {
      if (w.outline.length === 0) {
        const text = `${w.file.rel}:1-${w.file.lines.length} (path match; no lexical outline)`;
        built = text.length <= chunkChars ? { text, start: 1, end: w.file.lines.length } : null;
      } else {
        const entries = w.outline.slice(0, windowLines);
        const startLine = entries[0].n;
        let body = [];
        let end = startLine;
        for (const e of entries) {
          const next = [...body, `L${e.n}: ${e.text}`];
          if ((buildHeader(w.file.rel, startLine, e.n, "outline") + next.join("\n")).length > chunkChars) break;
          body = next;
          end = e.n;
        }
        built = body.length > 0 ? { text: buildHeader(w.file.rel, startLine, end, "outline") + body.join("\n"), start: startLine, end } : null;
      }
      if (!built) {
        omitted.push({ path: w.file.rel, start_line: 1, end_line: w.file.lines.length, reason: "path_exceeds_budget" });
        continue;
      }
    } else {
      const slice = w.file.redactedLines.slice(w.start - 1, w.end);
      built = fitWindow(w.file.rel, slice, w.start, w.anchor, chunkChars);
      if (!built) {
        omitted.push({ path: w.file.rel, start_line: w.start, end_line: w.end, reason: "path_exceeds_budget" });
        continue;
      }
      if (built.lineCut) lineCuts++;
    }
    if (isSuspiciousText(built.text)) {
      omitted.push({ path: w.file.rel, start_line: built.start, end_line: built.end, reason: "suspicious_content" });
      continue;
    }
    if (built.text.length > chunkChars) {
      omitted.push({ path: w.file.rel, start_line: built.start, end_line: built.end, reason: "exceeds_budget" });
      continue;
    }
    const id = `c${candidates.length}`;
    candidates.push({ id, text: built.text });
    // score and terms feed the compact report (lexical order and reason label); they never go to Jev.
    const matched = w.kind === "window" ? windowTerms(w.file, built.start, built.end, terms) : w.file.pathHits;
    map[id] = { path: w.file.rel, sha256: w.file.sha, start_line: built.start, end_line: built.end, kind: w.kind, score: w.score, terms: matched };
  }
  if (windowsTotal > candidates.length + omitted.length) incompleteReasons.add("candidate_limit_reached");
  if (omitted.length) incompleteReasons.add("windows_omitted");
  if (lineCuts) incompleteReasons.add("long_lines_truncated");
  const matcher = exactMatcher(exactToken(options.query));
  const exactFiles = matcher ? scored.filter((f) => matcher.matchesPath(f.rel) || f.lines.some((line) => matcher.matchesLine(line))).map((f) => f.rel) : null;
  return {
    ...base,
    disabled: false,
    ...recommendNext({ disabled: false, query: options.query, candidates, map, exactFiles, single: options.single === true }),
    candidates,
    map,
    coverage: {
      complete: incompleteReasons.size === 0,
      reasons: [...incompleteReasons].sort(),
      files_listed: files.length,
      files_considered: considered,
      files_matched: scored.length,
      windows_total: windowsTotal,
      skipped,
      denylist_unsupported: denylist.unsupported,
      note: "Lexical preselection, not an exhaustive inventory; 'absent' from jev_find covers only these candidates.",
    },
    omitted,
  };
}

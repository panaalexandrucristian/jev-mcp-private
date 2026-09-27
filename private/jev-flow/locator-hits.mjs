// jev-locator hits and the range-only reading rule (R2), shared by the Claude
// hook and the OpenCode adapter. Metadata only: path, line range, sha256 and
// the request number. A hit is fresh while it belongs to the current request
// and the file's sha256 still matches; a changed file drops the hit silently.
import { globToRegexSource } from "./paths.mjs";

export const HITS_CAP = 32;
/** Lines a read may extend beyond a returned range without a hint. */
export const RANGE_MARGIN = 40;

const SHA = /^[0-9a-f]{64}$/;

function hitsOf(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.hits)) return null;
  const hits = [];
  for (const h of value.hits) {
    if (!h || typeof h.path !== "string" || h.path === "" || h.path.length > 260 || /[\n\r]/.test(h.path)) continue;
    const [a, b] = Array.isArray(h.lines) ? h.lines : [];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) continue;
    hits.push({ path: h.path.replace(/^\.\//, ""), start: a, end: b, sha: SHA.test(String(h.sha256 ?? "")) ? h.sha256 : null });
  }
  return hits;
}

function parseCandidates(text) {
  const out = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(text))) out.push(m[1]);
  out.push(text);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1));
  return out;
}

/** Hits from a jev-locator report found anywhere in a string or tool response; [] when none. */
export function extractLocatorHits(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") {
    if (!value.includes("hits")) return [];
    for (const candidate of parseCandidates(value)) {
      try {
        const hits = hitsOf(JSON.parse(candidate));
        if (hits && hits.length) return hits;
      } catch {
        // Not this one.
      }
    }
    return [];
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hits = extractLocatorHits(v, depth + 1);
      if (hits.length) return hits;
    }
    return [];
  }
  if (typeof value === "object") {
    const direct = hitsOf(value);
    if (direct && direct.length) return direct;
    for (const v of Object.values(value)) {
      const hits = extractLocatorHits(v, depth + 1);
      if (hits.length) return hits;
    }
  }
  return [];
}

/** Add hits for request `req` to a list (newest last, capped). */
export function rememberHits(list, hits, req) {
  const next = [...(list ?? [])];
  for (const h of hits) next.push({ ...h, req });
  return next.slice(-HITS_CAP);
}

/**
 * Fresh hits on `path` for request `req`, given the file's current sha256.
 * Hits whose sha differs are stale and returned in `stale` for removal.
 */
export function freshHits(list, { path, req, sha }) {
  const fresh = [];
  const stale = [];
  for (const h of list ?? []) {
    if (h.req !== req || h.path !== path) continue;
    if (h.sha && sha && h.sha !== sha) stale.push(h);
    else if (h.sha && !sha) stale.push(h);
    else fresh.push(h);
  }
  return { fresh, stale };
}

/** The hits' ranges widened by RANGE_MARGIN lines and merged: [[lo, hi], ...], gaps between distant hits kept out. */
export function allowedRanges(hits) {
  const widened = hits.map((h) => [Math.max(1, h.start - RANGE_MARGIN), h.end + RANGE_MARGIN]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [lo, hi] of widened) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/**
 * Does a Read of [start, end] (end: number or "end" = the whole rest) exceed
 * the fresh hits of the file? Only reads that overlap a hit count; a read
 * contained in one range of the merged union of the hits widened by
 * RANGE_MARGIN lines is allowed. A read spanning the gap between two distant
 * hits exceeds them.
 */
export function readExceedsHits(hits, { start, end, lineCount }) {
  if (hits.length === 0) return false;
  const last = end === "end" ? Math.max(start, lineCount ?? start) : end;
  const overlaps = hits.some((h) => start <= h.end && last >= h.start);
  if (!overlaps) return false;
  return !allowedRanges(hits).some(([lo, hi]) => start >= lo && last <= hi);
}

// Common ripgrep file types (Grep `type`); an unknown type may match anything.
const RG_TYPES = {
  js: ["js", "jsx", "mjs", "cjs", "vue"], ts: ["ts", "tsx", "cts", "mts"], py: ["py", "pyi"], kotlin: ["kt", "kts"], java: ["java"],
  go: ["go"], rust: ["rs"], swift: ["swift"], c: ["c", "h"], cpp: ["cpp", "cc", "cxx", "hpp", "hh", "h"], ruby: ["rb"], php: ["php"],
  css: ["css", "scss"], html: ["html", "htm"], json: ["json"], md: ["md", "markdown"], markdown: ["md", "markdown"], yaml: ["yml", "yaml"], sh: ["sh", "bash", "zsh"],
};

function expandBraces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1].split(",").flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

/** Does a Grep glob filter (ripgrep style, braces, leading "!" excludes) keep `rel`? */
export function globKeeps(glob, rel) {
  if (typeof glob !== "string" || glob.trim() === "") return true;
  const negated = glob.startsWith("!");
  const body = negated ? glob.slice(1) : glob;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const matches = expandBraces(body).some((g) => {
    const anchored = g.includes("/");
    const re = new RegExp(`^${anchored ? `(?:.*/)?${globToRegexSource(g.replace(/^\/+/, ""))}` : globToRegexSource(g)}$`);
    return re.test(anchored ? rel : base);
  });
  return negated ? !matches : matches;
}

/**
 * Does a Grep search (target: repo-relative path of its `path`, "" for the
 * repository root or when no path is given) cover the file `rel`, given its
 * `glob` and `type` filters? A target covers its own file and every file
 * below it (ancestor directories included).
 */
export function grepCovers(rel, { target, glob, type }) {
  if (target === null || target === undefined) return false;
  const inScope = target === "" || rel === target || rel.startsWith(`${target}/`);
  if (!inScope || !globKeeps(glob, rel)) return false;
  if (typeof type === "string" && type !== "" && RG_TYPES[type]) {
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".") + 1) : "";
    return RG_TYPES[type].includes(ext);
  }
  return true;
}

export function rangesText(hits) {
  return [...new Map(hits.map((h) => [`${h.start}-${h.end}`, h])).values()].map((h) => `${h.start}–${h.end}`).join(", ");
}

export const HINT_RANGE_READ = (path, hits) =>
  `jev-flow: jev-locator already returned ${path} lines ${rangesText(hits)}. Read only those ranges (Read with offset/limit; up to ${RANGE_MARGIN} lines around them) instead of the whole file.`;

export const HINT_RANGE_GREP = (path, hits) =>
  `jev-flow: jev-locator already returned ${path} lines ${rangesText(hits)}. Read those ranges instead of re-searching this area.`;

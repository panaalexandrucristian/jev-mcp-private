// Path policy for jev-flow: permanent sensitive exclusions and the
// .jev-flow-denylist dialect. Pure functions; no I/O except loadDenylist.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DENYLIST_FILE = ".jev-flow-denylist";

// Always excluded, whatever the denylist says. Matched against the basename
// (any depth) unless the entry contains a slash. Case-insensitive on purpose:
// a secret named `.ENV` is still a secret.
export const PERMANENT_EXCLUSIONS = Object.freeze([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".aws/credentials",
  "credentials*.json",
  "service-account*.json",
  "google-services.json",
  "GoogleService-Info.plist",
  "local.properties",
  "keystore.properties",
  "signing.properties",
  "*.mobileprovision",
]);

function escapeRegex(ch) {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate one glob body (no leading "/" and no trailing "/") to a regex
 * source. Supports "*", "**", "?" and backslash escapes; everything else,
 * including "[", is literal.
 */
export function globToRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "\\" && i + 1 < glob.length) {
      out += escapeRegex(glob[++i]);
      continue;
    }
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (atStart && next === "/") {
          out += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atStart && next === undefined) {
          out += ".*";
          i += 1;
          continue;
        }
        // "**" not bounded by slashes behaves like "*".
        out += "[^/]*";
        i += 1;
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegex(ch);
  }
  return out;
}

/**
 * Compile one pattern line. Returns null for blank lines and comments, and
 * {unsupported} for syntax the dialect rejects (negation).
 */
export function compilePattern(line, { caseInsensitive = false } = {}) {
  let text = line.replace(/\r$/, "");
  // Trailing spaces are ignored unless escaped, as in gitignore.
  text = text.replace(/(?<!\\)\s+$/, "");
  if (text === "" || text.startsWith("#")) return null;
  if (text.startsWith("!")) return { unsupported: "negation", source: line };
  let dirOnly = false;
  if (text.endsWith("/") && !text.endsWith("\\/")) {
    dirOnly = true;
    text = text.replace(/\/+$/, "");
  }
  let anchored = false;
  if (text.startsWith("/")) {
    anchored = true;
    text = text.replace(/^\/+/, "");
  }
  if (text.includes("/")) anchored = true;
  if (text === "") return null;
  const regex = new RegExp(`^${globToRegexSource(text)}$`, caseInsensitive ? "i" : "");
  return { pattern: line.trim(), regex, anchored, dirOnly };
}

/** True when a compiled pattern matches the repo-relative POSIX path of a file. */
export function matchesCompiled(compiled, relPath) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const lastIndex = parts.length - 1;
  if (compiled.anchored) {
    for (let i = 0; i <= lastIndex; i++) {
      if (compiled.dirOnly && i === lastIndex) break;
      if (compiled.regex.test(parts.slice(0, i + 1).join("/"))) return true;
    }
    return false;
  }
  for (let i = 0; i <= lastIndex; i++) {
    if (compiled.dirOnly && i === lastIndex) break;
    if (compiled.regex.test(parts[i])) return true;
  }
  return false;
}

// Entries with a slash (".aws/credentials") also match below any directory.
const permanentCompiled = PERMANENT_EXCLUSIONS.map((p) =>
  compilePattern(p.includes("/") ? `**/${p}` : p, { caseInsensitive: true }),
);

/** Permanent sensitive exclusion check; cannot be overridden by any pattern. */
export function isPermanentlyExcluded(relPath) {
  return permanentCompiled.some((c) => matchesCompiled(c, relPath));
}

/**
 * Parse denylist text. A line that is exactly "*" disables Jev for the repo.
 * Negation lines are reported as unsupported and ignored, so nothing is ever
 * re-included.
 */
export function parseDenylist(text) {
  const patterns = [];
  const unsupported = [];
  let disabled = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "*") disabled = true;
    const compiled = compilePattern(line);
    if (!compiled) continue;
    if (compiled.unsupported) {
      unsupported.push({ line: compiled.source.trim(), reason: compiled.unsupported });
      continue;
    }
    patterns.push(compiled);
  }
  return { disabled, patterns, unsupported };
}

/** Load .jev-flow-denylist from the repo root; absent file means no patterns. */
export function loadDenylist(repoRoot) {
  let text = "";
  let present = false;
  try {
    text = readFileSync(join(repoRoot, DENYLIST_FILE), "utf8");
    present = true;
  } catch {
    // Missing or unreadable denylist: no user patterns. Permanent exclusions still apply.
  }
  return { present, ...parseDenylist(text) };
}

export function isDenylisted(denylist, relPath) {
  if (!denylist) return false;
  if (denylist.disabled) return true;
  return denylist.patterns.some((c) => matchesCompiled(c, relPath));
}

/** Combined verdict for one path: null when eligible, else the reason. */
export function exclusionReason(denylist, relPath) {
  if (isPermanentlyExcluded(relPath)) return "permanent_exclusion";
  if (isDenylisted(denylist, relPath)) return "denylisted";
  return null;
}

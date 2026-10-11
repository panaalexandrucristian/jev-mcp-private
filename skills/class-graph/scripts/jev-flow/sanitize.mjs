// Best-effort credential redaction for text sent to Jev. A regex cannot find
// every secret; recognizable ones are redacted, suspicious leftovers are
// omitted and reported, and nothing here reads .env files.
import { exclusionReason } from "./paths.mjs";

const ASSIGNMENT_KEYWORD =
  "(?:api[_-]?key|apikey|secret|token|password|passwd|storepassword|keypassword|private[_-]?key)";

// Unquoted values that name code or types, not secrets.
const CODE_LIKE_VALUE = /^(?:string|number|boolean|bigint|undefined|null|true|false|none|nil|any|unknown|object|str|int|bool|bytes)$/i;
const ENV_REFERENCE = /(?:process\.env|os\.environ|getenv|System\.getenv|ENV\[|\$\{|\$[A-Z_]|<[^>]*>|\*{3,}|\[REDACTED)/;

// Code references kept readable: member access (options.token), not secrets.
const MEMBER_ACCESS = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.|::|->)[A-Za-z_$][\w$]*)+$/;
// Numeric values of token-count keys (max_tokens=1000) are counts, not credentials.
const TOKEN_COUNT_KEY = /(?:^|[^a-z])(?:tokens|token_?count|max_?tokens?|(?:input|output|prompt|completion|total|cache\w*|reasoning)_?tokens?)["']?$/i;

function quotedAssignmentValueIsSecret(value) {
  if (value.length === 0) return false;
  if (ENV_REFERENCE.test(value)) return false;
  return true;
}

/**
 * Bare (unquoted) assignment values are secrets unless they are clearly code:
 * type names and literals, environment references, calls/indexing/literals,
 * member access, or numeric token counts. Plain words and numbers such as
 * password=huntertwo or storePassword=123456 are redacted.
 */
function unquotedAssignmentValueIsSecret(value, key) {
  if (value.length === 0) return false;
  if (CODE_LIKE_VALUE.test(value)) return false;
  if (ENV_REFERENCE.test(value)) return false;
  if (/[()[\]{}]/.test(value)) return false;
  if (MEMBER_ACCESS.test(value)) return false;
  if (/^\d+$/.test(value) && TOKEN_COUNT_KEY.test(key)) return false;
  return true;
}

/**
 * Redaction rules, applied in order. Each replace() receives the match and
 * returns the replacement; `kind` names the marker [REDACTED:<kind>].
 */
export const REDACTION_RULES = Object.freeze([
  {
    kind: "pem_private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    // Keeps the line count so fragments still map to their source lines.
    replace: (match) => `[REDACTED:pem_private_key]${"\n".repeat((match.match(/\n/g) ?? []).length)}`,
  },
  {
    kind: "aws_access_key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED:aws_access_key]",
  },
  {
    kind: "github_token",
    regex: /\b(?:gh[pos]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: () => "[REDACTED:github_token]",
  },
  {
    kind: "sk_api_key",
    regex: /\bsk-(?:ant-|or-)?[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
    replace: () => "[REDACTED:sk_api_key]",
  },
  {
    kind: "slack_token",
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: () => "[REDACTED:slack_token]",
  },
  {
    kind: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{35}/g,
    replace: () => "[REDACTED:google_api_key]",
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => "[REDACTED:jwt]",
  },
  {
    kind: "bearer_token",
    regex: /(\bauthorization["']?\s*[:=]\s*["']?bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED:bearer_token]`,
  },
  {
    // Gradle signing configs: storePassword 'x' / keyPassword "x" (no '=').
    kind: "credential_assignment",
    regex: /\b((?:store|key)Password\s+)(["'])([^"'\n]+)\2/g,
    replace: (_m, prefix, quote) => `${prefix}${quote}[REDACTED:credential_assignment]${quote}`,
  },
  {
    kind: "credential_assignment",
    regex: new RegExp(
      `(["']?\\b[\\w.-]*${ASSIGNMENT_KEYWORD}[\\w.-]*["']?\\s*(?::=|=>|[:=])\\s*)(?:(["'\`])([^"'\`\\n]*)\\2|([^\\s"'\`,;)}\\]]+))`,
      "gi",
    ),
    replace: (match, prefix, quote, quoted, bare) => {
      if (quote !== undefined) {
        return quotedAssignmentValueIsSecret(quoted)
          ? `${prefix}${quote}[REDACTED:credential_assignment]${quote}`
          : match;
      }
      const key = prefix.replace(/\s*(?::=|=>|[:=])\s*$/, "");
      return unquotedAssignmentValueIsSecret(bare, key) ? `${prefix}[REDACTED:credential_assignment]` : match;
    },
  },
]);

/** Redact recognizable credentials. Returns the text and per-kind counts. */
export function redact(text) {
  let out = String(text ?? "");
  const counts = new Map();
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.regex, (...args) => {
      const replacement = rule.replace(...args);
      if (replacement !== args[0]) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return replacement;
    });
  }
  return {
    text: out,
    redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

/** Kinds of recognizable, still-unredacted credentials in text (no values returned). */
export function findCredentialKinds(text) {
  return redact(text).redactions.map((r) => r.kind);
}

function shannonEntropy(token) {
  const freq = new Map();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const SUSPICIOUS_CONTEXT = /(?:key|secret|token|passw|credential|private|auth)/i;
const TOKEN_CANDIDATE = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * A line is suspicious when a leftover PEM header survives, or when it names a
 * credential-like thing next to a long mixed, high-entropy token that is not
 * a plain hex digest.
 */
export function isSuspiciousLine(line) {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) return true;
  if (!SUSPICIOUS_CONTEXT.test(line)) return false;
  for (const token of line.match(TOKEN_CANDIDATE) ?? []) {
    if (token.includes("REDACTED")) continue;
    if (/^[0-9a-fA-F]+$/.test(token)) continue;
    if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) continue;
    if (/^[a-z_]+$/i.test(token.replace(/[0-9]/g, ""))) {
      // Identifier-shaped (snake/camel case with a few digits): not a secret.
      if (/[_-]/.test(token) && (token.match(/[0-9]/g) ?? []).length < 4) continue;
    }
    if (shannonEntropy(token) >= 3.5) return true;
  }
  return false;
}

export function isSuspiciousText(text) {
  return String(text ?? "").split("\n").some(isSuspiciousLine);
}

/** Sanitize free text (logs): redact, then replace suspicious lines. */
export function sanitizeText(text) {
  const { text: redacted, redactions } = redact(text);
  let omittedLines = 0;
  const lines = redacted.split("\n").map((line) => {
    if (!isSuspiciousLine(line)) return line;
    omittedLines++;
    return "[OMITTED:suspicious_content]";
  });
  return { text: lines.join("\n"), redactions, omitted_lines: omittedLines, omitted: [] };
}

const SECTION_START = /^diff --(?:git|cc|combined) /;

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * Decode a Git C-style quoted path starting at text[0] === '"'. Returns
 * {value, rest} or null when the quoting or the UTF-8 bytes are invalid.
 */
export function unquoteGitPath(text) {
  if (!text.startsWith('"')) return null;
  const bytes = [];
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      try {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
        return { value, rest: text.slice(i + 1) };
      } catch {
        return null;
      }
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      if (/[0-7]/.test(next)) {
        const octal = text.slice(i + 1, i + 4);
        if (!/^[0-7]{3}$/.test(octal)) return null;
        bytes.push(parseInt(octal, 8));
        i += 4;
        continue;
      }
      if (!(next in C_ESCAPES)) return null;
      bytes.push(C_ESCAPES[next]);
      i += 2;
      continue;
    }
    bytes.push(...Buffer.from(ch, "utf8"));
    i += 1;
  }
  return null;
}

function stripPrefix(path) {
  return path.replace(/^[ab]\//, "");
}

/** One path argument: quoted or bare up to end of line. */
function parsePathArg(text) {
  const trimmed = text.replace(/\t.*$/, "");
  if (trimmed.startsWith('"')) {
    const parsed = unquoteGitPath(trimmed);
    return parsed && parsed.rest.trim() === "" ? parsed.value : null;
  }
  return trimmed === "" ? null : trimmed;
}

/** Paths from a `diff --git` header, or [] when it is ambiguous. */
function headerPaths(rest) {
  if (rest.startsWith('"')) {
    const first = unquoteGitPath(rest);
    if (!first) return null;
    const secondText = first.rest.replace(/^ /, "");
    const second = secondText.startsWith('"') ? unquoteGitPath(secondText) : { value: secondText, rest: "" };
    if (!second || second.rest.trim() !== "") return null;
    return [first.value, second.value];
  }
  const quotedAt = rest.indexOf(' "');
  if (quotedAt > 0) {
    const second = unquoteGitPath(rest.slice(quotedAt + 1));
    if (!second || second.rest.trim() !== "") return null;
    return [rest.slice(0, quotedAt), second.value];
  }
  // Unquoted: unambiguous only when both sides name the same path.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === " " && stripPrefix(a) === stripPrefix(b)) return [a, b];
  }
  return [];
}

/** Every path a diff section claims to touch, from its header area only. */
function sectionPaths(lines) {
  const paths = [];
  let unparseable = false;
  const add = (value) => {
    if (value === null) unparseable = true;
    else if (value !== "/dev/null") paths.push(value, stripPrefix(value));
  };
  const header = lines[0].replace(/^diff --(?:git|cc|combined) /, "");
  if (lines[0].startsWith("diff --git ")) {
    const fromHeader = headerPaths(header);
    if (fromHeader === null) unparseable = true;
    else fromHeader.forEach(add);
  } else {
    add(parsePathArg(header));
  }
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@") || line.startsWith("GIT binary patch")) break;
    let m;
    if ((m = /^(?:---|\+\+\+) (.*)$/.exec(line))) add(parsePathArg(m[1]));
    else if ((m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) add(parsePathArg(m[1]));
    else if ((m = /^Binary files (".*"|\S+) and (".*"|\S+) differ$/.exec(line))) {
      add(parsePathArg(m[1]));
      add(parsePathArg(m[2]));
    }
  }
  return { paths: [...new Set(paths)], unparseable };
}

/**
 * Sanitize a unified git diff. Each file section is kept only when every path
 * it names (header, ---/+++, rename/copy, binary lines; Git quoting decoded)
 * is eligible. Sections touching permanently excluded or denylisted paths, or
 * whose provenance cannot be parsed, are dropped entirely and reported. The
 * rest is redacted like free text.
 */
export function sanitizeDiff(text, denylist) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const omitted = [];
  let i = 0;
  while (i < lines.length && !SECTION_START.test(lines[i])) out.push(lines[i++]);
  while (i < lines.length) {
    const section = [lines[i++]];
    while (i < lines.length && !SECTION_START.test(lines[i])) section.push(lines[i++]);
    const { paths, unparseable } = sectionPaths(section);
    let reason = null;
    let path = paths.find((p) => exclusionReason(denylist, p));
    if (path) reason = exclusionReason(denylist, path);
    else if (unparseable || paths.length === 0) {
      reason = "unparseable_provenance";
      path = null;
    }
    if (reason) {
      const shown = path === null ? null : stripPrefix(path);
      omitted.push({ path: shown, reason });
      // The path stays out of the sanitized text; it is reported in `omitted`.
      out.push(`[OMITTED:${reason}]`);
      continue;
    }
    out.push(...section);
  }
  const result = sanitizeText(out.join("\n"));
  return { ...result, omitted };
}

export function looksLikeDiff(text) {
  return /^diff --(?:git|cc|combined) /m.test(String(text ?? ""));
}

/** Collect every string leaf of a JSON-like value. */
export function stringLeaves(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

/** Credential kinds present anywhere in a tool payload (values are never returned). */
export function payloadCredentialKinds(payload) {
  const kinds = new Set();
  for (const leaf of stringLeaves(payload)) for (const kind of findCredentialKinds(leaf)) kinds.add(kind);
  return [...kinds].sort();
}

// Executable form of the jev-flow result policy (design §5), the fixed report
// phrases, the strict Stop rules and the shell command classifier.

export const FIXED_PHRASES = Object.freeze({
  unavailable: "Jev unavailable; gate not evaluated",
  disabled: "Jev disabled for this repo; gate not evaluated",
});

export const DECIDE_CONFIDENCE_THRESHOLD = 0.8;
export const EXPLORATION_HINT_THRESHOLD = 4;
export const REREAD_HINT_THRESHOLD = 2;
export const LOGICAL_RETRY_BUDGET = 1;

export const JEV_TOOLS = Object.freeze([
  "verify",
  "screen",
  "noul",
  "find",
  "rerank",
  "classify",
  "decide",
  "compare",
  "extract",
  "review",
  "gate",
]);

const JEV_TOOL_RE = new RegExp(`^(?:mcp__(?:plugin_jev_)?jev__|jev[:._])?jev_(${JEV_TOOLS.join("|")})$`);

/** Short Jev tool name ("gate") for Claude or OpenCode tool ids, else null. */
export function jevToolName(toolName) {
  const match = JEV_TOOL_RE.exec(String(toolName ?? ""));
  return match ? match[1] : null;
}

/** Parse a Jev tool result from the shapes CLIs use (string, content array, object). */
export function parseJevResult(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw) && typeof raw.tool === "string") return raw;
  const texts = [];
  const collect = (value) => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      if (typeof value.text === "string") texts.push(value.text);
      else if (value.content !== undefined) collect(value.content);
      else if (value.output !== undefined) collect(value.output);
    }
  };
  collect(raw);
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") return parsed;
    } catch {
      // Not JSON; keep looking.
    }
  }
  return null;
}

/**
 * Retry rule: one logical retry with identical input, only for transport
 * failures or invalid_response, never after a user cancellation.
 */
export function shouldRetry({ attempt, failure, cancelledByUser }) {
  if (cancelledByUser) return false;
  if (failure !== "transport" && failure !== "invalid_response") return false;
  return attempt < LOGICAL_RETRY_BUDGET;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const inUnit = (value) => isNumber(value) && value >= 0 && value <= 1;

// Flow minimums, applied on top of the thresholds the call reports: a gate
// called with lowered thresholds cannot produce an accepted flow result.
export const FLOW_GATE_MINIMUMS = Object.freeze({ confidence: 0.8, safe_to_apply: 0.8, composite: 0.7 });
// Mirrors src/index.ts and src/lib.ts (rubrics, weights, claim verdicts, tolerances, claim cap).
const REVIEW_RUBRICS = Object.freeze({ correctness: 0.4, spec_match: 0.3, test_gap: 0.15, blast_radius: 0.15 });
const CLAIM_VERDICTS = ["verified", "contradicted", "unsupported"];
const SCORE_KEYS = ["0", "1", "2"];
const PROBABILITY_SUM_TOLERANCE = 0.01 + 1e-12;
const SCORE_MEAN_TOLERANCE = 0.02 + 1e-12;
const MAX_CLAIM_CHARS = 2000;

function distributionProblems(probabilities, keys, choice, where) {
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return [`${where}_probabilities_missing`];
  const got = Object.keys(probabilities);
  if (got.length !== keys.length || !keys.every((k) => got.includes(k))) return [`${where}_probability_keys`];
  const values = keys.map((k) => probabilities[k]);
  if (!values.every(inUnit)) return [`${where}_probability_domain`];
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > PROBABILITY_SUM_TOLERANCE) return [`${where}_probability_sum`];
  if (choice !== undefined && probabilities[choice] < Math.max(...values) - 1e-9) return [`${where}_choice_not_argmax`];
  return [];
}

// Upstream score contract (validateScoreAnswer in src/index.ts): a rubric
// distribution the provider did not report stays null and is valid; when
// present it must be an exact 0/1/2 distribution whose expected value matches
// the score within SCORE_MEAN_TOLERANCE.
function scoreDistributionProblems(probabilities, score, where) {
  if (probabilities === null || probabilities === undefined) return [];
  const problems = distributionProblems(probabilities, SCORE_KEYS, undefined, where);
  if (problems.length > 0 || !isNumber(score)) return problems;
  const mean = SCORE_KEYS.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
  return Math.abs(mean - score) > SCORE_MEAN_TOLERANCE ? [`${where}_score_mean_mismatch`] : [];
}

function reviewComposite(scores) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const clamp02 = (v) => Math.min(2, Math.max(0, v));
  return (
    REVIEW_RUBRICS.correctness * clamp01(clamp02(scores.correctness) / 2) +
    REVIEW_RUBRICS.spec_match * clamp01(clamp02(scores.spec_match) / 2) +
    REVIEW_RUBRICS.test_gap * clamp01(1 - clamp02(scores.test_gap) / 2) +
    REVIEW_RUBRICS.blast_radius * clamp01(1 - clamp02(scores.blast_radius) / 2)
  );
}

/**
 * The single acceptance check shared by both adapters. A gate result counts
 * as completion evidence only when it is a complete, internally consistent
 * jev_gate answer for exactly the claims of the call:
 * - action auto, truncated false, reason_codes exactly ["accepted"];
 * - review: action auto, reason_codes ["accepted"], no invalid_response,
 *   thresholds in [0,1] with review_at <= auto_accept, all four rubric scores
 *   in [0,2], each with a null distribution or a valid 0/1/2 distribution
 *   whose mean matches the score (upstream tolerance), and confidence >=
 *   max(auto_accept, 0.8); composite in [0,1] equal to the weighted rubric
 *   composite and >= max(composite_floor, 0.7); safe_to_apply >=
 *   max(auto_accept, 0.8);
 * - verification: action auto, thresholds in [0,1], one result per call
 *   claim in order with the same (untruncated) text, each verified with action
 *   auto, a valid claim distribution whose argmax is "verified", and
 *   confidence >= max(auto_accept, 0.8); summary counts consistent with the
 *   results (all verified, nothing else).
 * `claims` must be the claims array sent in the call; without it the result
 * cannot be tied to the call and is not accepted.
 *
 * Returns {accepted, problems, malformed, below_flow_minimum}. `malformed` is
 * true when any problem makes the answer invalid or inconsistent with its own
 * `auto` (including a value below the call's own threshold). When the answer
 * is well formed and only misses the stricter flow minimums, `malformed` is
 * false and `below_flow_minimum` lists those misses.
 */
export function validateGateResult(result, { claims, minimums = FLOW_GATE_MINIMUMS, strictAbove = null } = {}) {
  const problems = [];
  const belowFlow = [];
  // A value in [0,1] must satisfy the call's own threshold (else the `auto`
  // contradicts the tool's policy: malformed) and the flow minimum (else it is
  // a valid answer that is not strong enough for the flow). jev-control passes
  // its own `minimums` (no 0.8 floor) and `strictAbove`, the session threshold:
  // a decision confidence must then be strictly above it (p > T, not p >= T).
  const atLeast = (value, callMin, flowMin, where, isDecision = true) => {
    if (!inUnit(value)) return problems.push(`${where}_domain`);
    if (inUnit(callMin) && value < callMin) return problems.push(`${where}_below_call_threshold`);
    if (value < Math.max(inUnit(callMin) ? callMin : 1, flowMin)) belowFlow.push(`${where}_below_flow_minimum`);
    if (strictAbove !== null && isDecision && !(value > strictAbove)) belowFlow.push(`${where}_not_above_threshold`);
  };
  if (!result || typeof result !== "object" || result.tool !== "jev_gate") {
    return { accepted: false, problems: ["not_a_jev_gate_result"], malformed: true, below_flow_minimum: [] };
  }
  if (result.action !== "auto") problems.push(`action_${result.action ?? "missing"}`);
  if (result.truncated !== false) problems.push("truncated_or_unknown");
  const codes = Array.isArray(result.reason_codes) ? result.reason_codes : null;
  if (!codes || codes.length !== 1 || codes[0] !== "accepted") problems.push("reason_codes_not_exactly_accepted");

  const review = result.review;
  if (!review || typeof review !== "object") problems.push("review_missing");
  else {
    if (review.action !== "auto") problems.push(`review_${review.action ?? "missing"}`);
    if (review.status !== undefined) problems.push(`review_status_${review.status}`);
    if (!Array.isArray(review.reason_codes) || review.reason_codes.length !== 1 || review.reason_codes[0] !== "accepted") {
      problems.push("review_reason_codes_not_exactly_accepted");
    }
    const t = review.thresholds ?? {};
    if (!inUnit(t.auto_accept) || !inUnit(t.review_at) || !inUnit(t.composite_floor) || t.review_at > t.auto_accept) {
      problems.push("review_thresholds_invalid");
    }
    const scores = review.scores;
    const rubricScores = {};
    if (!scores || typeof scores !== "object" || Object.keys(scores).length !== 4 || !Object.keys(REVIEW_RUBRICS).every((k) => k in scores)) {
      problems.push("review_scores_incomplete");
    } else {
      for (const [rubric, entry] of Object.entries(scores)) {
        if (!entry || typeof entry !== "object" || entry.status !== undefined) {
          problems.push(`review_${rubric}_invalid`);
          continue;
        }
        if (!isNumber(entry.score) || entry.score < 0 || entry.score > 2) problems.push(`review_${rubric}_score_domain`);
        atLeast(entry.confidence, t.auto_accept, minimums.confidence, `review_${rubric}_confidence`);
        problems.push(...scoreDistributionProblems(entry.probabilities, entry.score, `review_${rubric}`));
        rubricScores[rubric] = entry.score;
      }
    }
    if (!inUnit(review.composite)) problems.push("review_composite_domain");
    else {
      if (Object.keys(rubricScores).length === 4 && Math.abs(reviewComposite(rubricScores) - review.composite) > 1e-6) problems.push("review_composite_inconsistent");
      atLeast(review.composite, t.composite_floor, minimums.composite, "review_composite", false);
    }
    atLeast(review.safe_to_apply, t.auto_accept, minimums.safe_to_apply, "review_safe_to_apply");
  }

  const verification = result.verification;
  const results = Array.isArray(verification?.results) ? verification.results : null;
  if (!results || results.length === 0) problems.push("claim_results_missing");
  else {
    if (verification.action !== "auto") problems.push(`verification_${verification.action ?? "missing"}`);
    const t = verification.thresholds ?? {};
    if (!inUnit(t.auto_accept) || !inUnit(t.review_at) || t.review_at > t.auto_accept) problems.push("verification_thresholds_invalid");
    results.forEach((claim, i) => {
      if (!claim || typeof claim !== "object") return problems.push(`claim_${i}_missing`);
      if (claim.status !== undefined) problems.push(`claim_${i}_status_${claim.status}`);
      if (claim.verdict !== "verified") problems.push(`claim_${i}_${claim.verdict ?? "no_verdict"}`);
      if (claim.action !== "auto") problems.push(`claim_${i}_action_${claim.action ?? "missing"}`);
      atLeast(claim.confidence, t.auto_accept, minimums.confidence, `claim_${i}_confidence`);
      problems.push(...distributionProblems(claim.probabilities, CLAIM_VERDICTS, claim.verdict, `claim_${i}`));
    });
    const summary = verification.summary;
    if (
      !summary ||
      summary.verified !== results.length ||
      summary.contradicted !== 0 ||
      summary.unsupported !== 0 ||
      summary.needs_review !== 0 ||
      summary.invalid_response !== 0
    ) {
      problems.push("verification_summary_inconsistent");
    }
    if (!Array.isArray(claims) || claims.length === 0 || !claims.every((c) => typeof c === "string")) {
      problems.push("call_claims_unknown");
    } else if (claims.length !== results.length) {
      problems.push("claim_count_mismatch");
    } else {
      claims.forEach((claim, i) => {
        if (claim.length > MAX_CLAIM_CHARS) problems.push(`claim_${i}_truncated_by_tool`);
        else if (results[i]?.claim !== claim) problems.push(`claim_${i}_text_mismatch`);
      });
    }
  }
  const malformed = problems.length > 0;
  return {
    accepted: !malformed && belowFlow.length === 0,
    problems: [...problems, ...belowFlow],
    malformed,
    below_flow_minimum: belowFlow,
  };
}

/**
 * Interpret a jev_gate result. Order matters: a valid contradiction wins even
 * when another part of the answer is invalid.
 * Routes: stop_contradiction | retry_or_unavailable | ask_user | needs_evidence | accepted
 * (a well-formed auto below the flow minimums routes to ask_user, a malformed one to retry_or_unavailable)
 */
export function interpretGate(result, { claims, minimums, strictAbove } = {}) {
  if (!result || result.tool !== "jev_gate") {
    return { route: "retry_or_unavailable", reasons: ["missing_or_unparseable_result"] };
  }
  const claimResults = result.verification?.results ?? [];
  const contradicted = claimResults.filter((r) => r && r.verdict === "contradicted" && r.status !== "invalid_response");
  if (contradicted.length > 0) {
    return {
      route: "stop_contradiction",
      reasons: ["claims_contradicted"],
      contradicted: contradicted.map((r) => ({ claim: r.claim, confidence: r.confidence ?? null })),
    };
  }
  const codes = Array.isArray(result.reason_codes) ? result.reason_codes : [];
  if (codes.includes("invalid_response") || result.review?.status === "invalid_response") {
    return { route: "retry_or_unavailable", reasons: ["invalid_response"] };
  }
  if (result.action === "auto") {
    const check = validateGateResult(result, { claims, ...(minimums ? { minimums } : {}), ...(strictAbove !== undefined ? { strictAbove } : {}) });
    if (check.accepted) return { route: "accepted", reasons: codes };
    // A malformed or inconsistent "auto" is treated like an invalid response.
    if (check.malformed) return { route: "retry_or_unavailable", reasons: check.problems };
    // A valid answer that only misses the flow minimums is not retried: a human decides.
    return { route: "ask_user", reasons: check.below_flow_minimum };
  }
  if (result.action === "escalate") return { route: "ask_user", reasons: codes };
  if (result.action === "review") {
    const evidenceOnly = codes.length > 0 && codes.every((c) => c === "claims_unsupported" || c === "incomplete_context");
    return { route: evidenceOnly ? "needs_evidence" : "ask_user", reasons: codes };
  }
  return { route: "retry_or_unavailable", reasons: ["unknown_action"] };
}

/**
 * Interpret a jev_decide result. For a consequential decision, missing or
 * low (<0.8) confidence, an escape hatch or warnings require a human.
 * Routes: accepted | investigate | ask_user | reformulate | human_review | retry_or_unavailable
 */
export function interpretDecide(result, { consequential = true } = {}) {
  const rec = result?.recommendation;
  if (!result || result.tool !== "jev_decide" || !rec || rec.status === "invalid_response") {
    return { route: "retry_or_unavailable", reasons: ["invalid_response"] };
  }
  if (rec.escaped) {
    if (rec.selected === "investigate") return { route: "investigate", reasons: ["escaped"] };
    if (rec.selected === "ask_user") return { route: "ask_user", reasons: ["escaped"] };
    return { route: "reformulate", reasons: ["escaped_none"] };
  }
  const reasons = [];
  if (typeof rec.confidence !== "number") reasons.push("confidence_missing");
  else if (rec.confidence < DECIDE_CONFIDENCE_THRESHOLD) reasons.push("confidence_below_0.8");
  if (Array.isArray(result.warnings) && result.warnings.length > 0) reasons.push("warnings");
  if (reasons.length > 0) return { route: consequential ? "human_review" : "manual_inspection", reasons };
  return { route: "accepted", reasons: [] };
}

function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * Final messages the strict Stop hook never blocks: a fixed phrase anywhere,
 * a last non-empty line starting with "Incomplete:", or ending with "?".
 * A bare mention of "incomplete" is not enough.
 */
export function isAllowedFinalMessage(message) {
  const text = String(message ?? "");
  if (text.includes(FIXED_PHRASES.unavailable) || text.includes(FIXED_PHRASES.disabled)) return true;
  const last = lastNonEmptyLine(text);
  return last.startsWith("Incomplete:") || last.endsWith("?");
}

/**
 * Stop decision. Returns {action: "none" | "notify" | "block", reason?}.
 * Strict mode blocks at most once per snapshot and honors stop_hook_active.
 */
export function stopDecision({ strict, stopHookActive, lastMessage, codeChanged, gateAccepted, redirectedBefore, snapshotKnown }) {
  if (!codeChanged || gateAccepted) return { action: "none" };
  if (!strict) {
    return { action: "notify", reason: "no_fresh_gate" };
  }
  if (!snapshotKnown) return { action: "notify", reason: "snapshot_unavailable" };
  if (stopHookActive) return { action: "notify", reason: "stop_hook_active" };
  if (isAllowedFinalMessage(lastMessage)) return { action: "none" };
  if (redirectedBefore) return { action: "notify", reason: "already_redirected" };
  return { action: "block", reason: "no_fresh_gate" };
}

const EXPLORATION_COMMANDS = new Set([
  "rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "ls", "tree", "cat", "head", "tail",
  "less", "more", "wc", "file", "stat", "du", "bat", "nl", "cut", "sort", "uniq", "jq", "realpath",
  "readlink", "basename", "dirname", "pwd", "which", "type",
]);
const EXPLORATION_GIT = new Set(["grep", "ls-files", "show", "log", "diff", "status", "blame", "rev-parse", "ls-tree", "cat-file"]);
const TEST_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check)\b/,
  /^(?:npx\s+)?(?:jest|vitest|mocha|tsc|eslint|ava|playwright)\b/,
  /^node\s+--test\b/,
  /^(?:python3?\s+-m\s+)?(?:pytest|unittest|mypy|ruff)\b/,
  /^(?:go\s+(?:test|vet|build)|cargo\s+(?:test|build|check|clippy))\b/,
  /^make\s+(?:test|check|lint|build)\b/,
  /^(?:\.\/)?gradlew?\s+.*\b(?:test|check|lint|assemble|build)\w*/,
  /^mvn\s+.*\b(?:test|verify|package)\b/,
  /^(?:swift\s+test|xcodebuild\b.*\btest\b)/,
  /^claude\s+plugin\s+validate\b/,
];
const MUTATION_PATTERNS = [
  /^sed\s+(?:-[a-zA-Z]*i|--in-place)/,
  /^perl\s+-[a-zA-Z]*i/,
  /^(?:mv|cp|rm|rmdir|touch|mkdir|chmod|ln|patch|tee|truncate|install)\b/,
  /^git\s+(?:apply|checkout|restore|reset|stash|mv|rm|merge|rebase|cherry-pick|am|commit)\b/,
  /^(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|ci)\b/,
];

function stripEnvAssignments(segment) {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

/** Split a shell line into command segments on && || ; | (quotes respected). */
export function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  const text = String(command ?? "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && text[i + 1] === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "&" || ch === "|") && text[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function hasFileRedirect(segment) {
  // Output redirection to anything other than /dev/null or a numbered fd.
  const match = segment.match(/(?<![0-9&])>{1,2}\s*([^\s&|;]+)/g);
  if (!match) return false;
  return match.some((m) => !/>{1,2}\s*(?:\/dev\/null|&\d)/.test(m));
}

/**
 * Classify one shell command line: "mutation" wins over "test", which wins
 * over "exploration"; "cd" segments are neutral; anything else is "unknown".
 */
export function classifyShellCommand(command) {
  const segments = splitShellSegments(command).map(stripEnvAssignments);
  if (segments.length === 0) return "unknown";
  let sawTest = false;
  let sawExploration = false;
  let sawUnknown = false;
  for (const segment of segments) {
    if (/^(?:cd|pushd|popd)\b/.test(segment) || segment === "true") continue;
    if (hasFileRedirect(segment) || MUTATION_PATTERNS.some((re) => re.test(segment))) return "mutation";
    if (TEST_PATTERNS.some((re) => re.test(segment))) {
      sawTest = true;
      continue;
    }
    const [head, sub] = segment.split(/\s+/);
    if (head === "git" && EXPLORATION_GIT.has(sub)) {
      sawExploration = true;
      continue;
    }
    if (head === "sed" && /^sed\s+-n\b/.test(segment)) {
      sawExploration = true;
      continue;
    }
    if (EXPLORATION_COMMANDS.has(head)) {
      sawExploration = true;
      continue;
    }
    sawUnknown = true;
  }
  if (sawTest) return "test";
  if (sawExploration && !sawUnknown) return "exploration";
  return "unknown";
}

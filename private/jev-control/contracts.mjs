// Contracts of the Jev MCP tools as jev-control uses them: tool discovery at
// activation (tools/list is not a tools/call and consumes no budget), argument
// validation before anything is sent (an invalid payload never costs a call) and
// result validation (a missing or malformed number never becomes a score).
// The limits mirror src/lib.ts and src/index.ts; contracts.test.mjs compares
// them with the source so upstream drift fails there.
export const CORE_TOOLS = Object.freeze(["screen", "verify", "noul", "find", "rerank", "classify", "decide", "compare", "extract", "review", "gate"]);
export const OPTIONAL_TOOLS = Object.freeze(["audit"]);

export const LIMITS = Object.freeze({
  decideCandidates: 6,
  decideRequirements: 3,
  decideDecisionChars: 1500,
  decideEvidenceChars: 12_000,
  decidePrioritiesChars: 2000,
  decideCandidateChars: 2000,
  noulPropositions: 64,
  noulPropositionChars: 2000,
  noulTotalChars: 150_000,
  rerankCandidates: 250,
  rerankTotalChars: 100_000,
  rerankQueryChars: 2000,
  rerankTopK: 250,
  findTopK: 50,
  candidateChars: 2000,
  gateClaims: 16,
});

/** Top-level keys the control uses per tool, and the ones the tool requires (src/index.ts). */
export const TOOL_KEYS = Object.freeze({
  noul: { required: ["propositions"], used: ["propositions", "context", "auto_accept"] },
  decide: { required: ["decision", "evidence", "priorities", "candidates"], used: ["decision", "evidence", "priorities", "candidates", "requirements", "escape_hatches"] },
  rerank: { required: ["query", "candidates"], used: ["query", "candidates", "top_k"] },
  find: { required: ["query", "candidates"], used: ["query", "candidates", "top_k"] },
  gate: { required: ["request", "diff", "claims", "evidence"], used: ["request", "diff", "claims", "evidence", "tests", "auto_accept"] },
  verify: { required: ["claims", "evidence"], used: ["claims", "evidence", "auto_accept"] },
  review: { required: ["request", "diff"], used: ["request", "diff", "tests", "auto_accept"] },
  classify: { required: ["items", "classes"], used: ["items", "classes", "auto_accept"] },
  compare: { required: ["passage_a", "passage_b"], used: ["passage_a", "passage_b", "auto_accept"] },
  extract: { required: ["document", "fields"], used: ["document", "fields", "auto_accept"] },
  screen: { required: ["text"], used: ["text"] },
});

const NAME = /^(?:mcp__(?:plugin_jev_)?jev__|jev[:._])?jev_([a-z]+)$/;

/** Short name ("decide") for any tool id form (mcp__jev__jev_decide, mcp__plugin_jev_jev__jev_decide, jev_decide), else null. */
export function toolBase(name) {
  const match = NAME.exec(String(name ?? ""));
  return match ? match[1] : null;
}

/**
 * Check a tools/list answer: every core tool present with the keys the control
 * relies on; audit optional. {ok, missing, incompatible, audit, prefix}.
 */
export function checkTools(listResult) {
  const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
  const byBase = new Map();
  for (const tool of tools) {
    const base = toolBase(tool?.name);
    if (base) byBase.set(base, tool);
  }
  const missing = CORE_TOOLS.filter((t) => !byBase.has(t));
  const incompatible = [];
  for (const base of CORE_TOOLS) {
    const tool = byBase.get(base);
    if (!tool) continue;
    const props = tool.inputSchema?.properties;
    if (!props || typeof props !== "object") {
      incompatible.push({ tool: base, reason: "no_input_schema" });
      continue;
    }
    const lacking = TOOL_KEYS[base].required.filter((k) => !(k in props));
    if (lacking.length) incompatible.push({ tool: base, reason: `missing_keys:${lacking.join(",")}` });
  }
  const names = tools.map((t) => String(t?.name ?? ""));
  const prefix = names.find((n) => n.startsWith("mcp__plugin_jev_jev__")) ? "mcp__plugin_jev_jev__" : names.find((n) => n.startsWith("mcp__jev__")) ? "mcp__jev__" : "";
  return { ok: missing.length === 0 && incompatible.length === 0, missing, incompatible, audit: byBase.has("audit"), prefix };
}

const isString = (v) => typeof v === "string";
const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function strict(args, allowed, required, problems) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return problems.push("args_not_object");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) problems.push(`unknown_key:${key}`);
  for (const key of required) if (!(key in args)) problems.push(`missing_key:${key}`);
}

function evidenceTexts(context) {
  const items = Array.isArray(context) ? context : [context];
  return items.map((i) => (isString(i) ? i : isString(i?.text) ? i.text : ""));
}

export function validateNoulArgs(args) {
  const problems = [];
  strict(args, TOOL_KEYS.noul.used, TOOL_KEYS.noul.required, problems);
  const props = args?.propositions;
  if (!Array.isArray(props) || props.length < 1 || props.length > LIMITS.noulPropositions) problems.push("propositions_count");
  else {
    props.forEach((p, i) => {
      if (!isString(p) || p.trim() === "" || p.length > LIMITS.noulPropositionChars) problems.push(`proposition_${i}_invalid`);
    });
    const ctx = args.context === undefined ? 0 : evidenceTexts(args.context).reduce((n, t) => n + t.length, 0);
    if (props.reduce((n, p) => n + String(p).length, 0) + ctx > LIMITS.noulTotalChars) problems.push("noul_total_chars");
  }
  if (args?.auto_accept !== undefined && !(typeof args.auto_accept === "number" && args.auto_accept > 0.5 && args.auto_accept <= 1)) problems.push("auto_accept_domain");
  return problems;
}

const SLUG = /^[a-z][a-z0-9_-]*$/;
const DECIDE_HATCHES = Object.freeze(["ask_user", "investigate", "none"]);
export { DECIDE_HATCHES };

export function validateDecideArgs(args) {
  const problems = [];
  strict(args, TOOL_KEYS.decide.used, TOOL_KEYS.decide.required, problems);
  if (!args || typeof args !== "object") return problems;
  const lim = (v, max, name) => {
    if (!isString(v) || v.length < 1 || v.length > max) problems.push(`${name}_length`);
  };
  lim(args.decision, LIMITS.decideDecisionChars, "decision");
  lim(args.evidence, LIMITS.decideEvidenceChars, "evidence");
  lim(args.priorities, LIMITS.decidePrioritiesChars, "priorities");
  const c = args.candidates;
  if (!Array.isArray(c) || c.length < 2 || c.length > LIMITS.decideCandidates) problems.push("candidates_count");
  else {
    const seen = new Set();
    for (const cand of c) {
      if (!cand || typeof cand !== "object" || Object.keys(cand).some((k) => k !== "id" && k !== "description")) problems.push("candidate_shape");
      else if (!isString(cand.id) || !SLUG.test(cand.id) || cand.id.length > 64) problems.push(`candidate_id_invalid:${String(cand.id).slice(0, 20)}`);
      else if (seen.has(cand.id)) problems.push(`candidate_id_duplicate:${cand.id}`);
      else if (args.escape_hatches !== false && DECIDE_HATCHES.includes(cand.id)) problems.push(`candidate_id_collides_with_escape_hatch:${cand.id}`);
      else if (!isString(cand.description) || cand.description.length < 1 || cand.description.length > LIMITS.decideCandidateChars) problems.push("candidate_description_length");
      if (cand?.id) seen.add(cand.id);
    }
  }
  if (args.requirements !== undefined && (!Array.isArray(args.requirements) || args.requirements.length > LIMITS.decideRequirements)) problems.push("requirements_count");
  return problems;
}

function validateCandidates(args, tool, topKMax, problems) {
  strict(args, TOOL_KEYS[tool].used, TOOL_KEYS[tool].required, problems);
  if (!args || typeof args !== "object") return;
  if (!isString(args.query) || args.query.length < 1 || (tool === "rerank" && args.query.length > LIMITS.rerankQueryChars)) problems.push("query_length");
  const c = args.candidates;
  if (!Array.isArray(c) || c.length < 1 || c.length > LIMITS.rerankCandidates) problems.push("candidates_count");
  else {
    const ids = new Set();
    let chars = 0;
    for (const cand of c) {
      if (!cand || typeof cand !== "object" || Object.keys(cand).some((k) => k !== "id" && k !== "text") || !isString(cand.text)) problems.push("candidate_shape");
      else {
        chars += cand.text.length;
        if (cand.id !== undefined) {
          if (!isString(cand.id) || ids.has(cand.id)) problems.push("candidate_id_invalid_or_duplicate");
          ids.add(cand.id);
        }
      }
    }
    if (tool === "rerank" && chars > LIMITS.rerankTotalChars) problems.push("rerank_total_chars");
  }
  if (args.top_k !== undefined && !(Number.isInteger(args.top_k) && args.top_k >= 1 && args.top_k <= topKMax)) problems.push("top_k_range");
}

export function validateRerankArgs(args) {
  const problems = [];
  validateCandidates(args, "rerank", LIMITS.rerankTopK, problems);
  return problems;
}

export function validateFindArgs(args) {
  const problems = [];
  validateCandidates(args, "find", LIMITS.findTopK, problems);
  return problems;
}

export function validateArgs(tool, args) {
  switch (toolBase(tool) ?? tool) {
    case "noul": return validateNoulArgs(args);
    case "decide": return validateDecideArgs(args);
    case "rerank": return validateRerankArgs(args);
    case "find": return validateFindArgs(args);
    default: return [];
  }
}

// ── Result parsing: nothing missing or malformed is ever read as a score ────

/** noul: {ok: true, probabilities: [p…]} in the order of the propositions sent, or {ok: false, reason}. */
export function parseNoulResult(result, count) {
  if (!result || result.tool !== "jev_noul" || result.status === "invalid_response") return { ok: false, reason: "invalid_response" };
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length !== count) return { ok: false, reason: "result_count" };
  const probabilities = rows.map((r) => r?.probability);
  if (!probabilities.every(unit)) return { ok: false, reason: "probability_domain" };
  return { ok: true, probabilities };
}

/** decide: {ok: true, selected, escaped, confidence, probabilities, warnings} or {ok: false, reason}. */
export function parseDecideResult(result, candidateIds) {
  const rec = result?.recommendation;
  if (!result || result.tool !== "jev_decide" || !rec || rec.status === "invalid_response") return { ok: false, reason: "invalid_response" };
  if (typeof rec.selected !== "string" || typeof rec.escaped !== "boolean" || !unit(rec.confidence)) return { ok: false, reason: "recommendation_malformed" };
  if (!rec.escaped && !candidateIds.includes(rec.selected)) return { ok: false, reason: "selected_unknown_id" };
  if (rec.escaped && !DECIDE_HATCHES.includes(rec.selected)) return { ok: false, reason: "escape_unknown" };
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return { ok: true, selected: rec.selected, escaped: rec.escaped, confidence: rec.confidence, probabilities: rec.probabilities ?? null, warnings };
}

/** rerank/find: entries with a finite score in [0,1], known and distinct ids; sorted descending (server order breaks ties). */
export function parseRankResult(tool, result, sentIds, topK) {
  const listKey = tool === "rerank" ? "ranked" : "top";
  const scoreKey = tool === "rerank" ? "relevance" : "probability";
  if (!result || result.tool !== `jev_${tool}` || result.status === "invalid_response" || !Array.isArray(result[listKey])) return { ok: false, reason: "invalid_response" };
  const entries = result[listKey];
  if (entries.length !== Math.min(topK, sentIds.length)) return { ok: false, reason: "partial_ranking" };
  const known = new Set(sentIds);
  const seen = new Set();
  for (const e of entries) {
    if (typeof e?.id !== "string" || !known.has(e.id) || seen.has(e.id)) return { ok: false, reason: "unknown_or_repeated_id" };
    if (!unit(e[scoreKey])) return { ok: false, reason: "score_domain" };
    seen.add(e.id);
  }
  const sorted = entries.map((e, i) => ({ id: e.id, score: e[scoreKey], i })).sort((a, b) => b.score - a.score || a.i - b.i).map(({ id, score }) => ({ id, score }));
  let exists = null;
  if (tool === "find") {
    if (!unit(result.exists)) return { ok: false, reason: "exists_domain" };
    exists = result.exists;
  }
  return { ok: true, ranked: sorted, exists };
}

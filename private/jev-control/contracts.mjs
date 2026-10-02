// Contracts of the Jev MCP tools as jev-control uses them: tool discovery at
// activation (tools/list is not a tools/call and consumes no budget), argument
// validation before anything is sent (an invalid payload never costs a call) and
// result validation (a missing or malformed number never becomes a score).
// The limits mirror src/lib.ts and src/index.ts; contracts.test.mjs compares
// them with the source and contracts-real.test.mjs with the schemas the built
// server really publishes (dist/index.js tools/list), so upstream drift fails there.
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
  gateEvidenceItems: 16,
  reviewDocChars: 50_000,
  decideRequirementChars: 500,
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

// ── What the control sends, per tool and key ────────────────────────────────
// A "sent shape" describes every value the control may put under a key:
// for noul/decide/rerank/find the envelope of what validateArgs lets through,
// for gate what the gate runner builds (jev-flow gate-batch), for the tools an
// agent calls directly under the skill (verify, review, classify, compare,
// extract, screen) only the value types (sizes are the agent's to respect from
// the schema it sees) and auto_accept = T, always in (0.5, 1).
// Strings: minLength/maxLength are the shortest/longest the control may send
// (undefined: not checked, Infinity: the schema must not cap it); `pattern` is
// the regex the control's own values already satisfy. Arrays: minItems/maxItems
// likewise. Objects: `always` lists the keys every sent object carries.
// `forms`: the control may send any of them, so every form must be accepted.
const U = Infinity;
const SLUG_SOURCE = "^[a-z][a-z0-9_-]*$";
const str = (minLength, maxLength, extra = {}) => ({ type: "string", minLength, maxLength, ...extra });
const ANY_STR = Object.freeze({ type: "string", free: true });
const arr = (items, minItems, maxItems) => ({ type: "array", items, minItems, maxItems });
const obj = (properties, always) => ({ type: "object", properties, always });
const int = (min, max) => ({ type: "integer", min, max });
const T_RANGE = Object.freeze({ type: "number", min: 0.5, minExclusive: true, max: 1, maxExclusive: true });
const forms = (...alternatives) => ({ forms: alternatives });
const looseItem = (text) => obj({ id: ANY_STR, text }, ["text"]);

export const SENT_SHAPES = Object.freeze({
  noul: {
    propositions: arr(str(1, LIMITS.noulPropositionChars), 1, LIMITS.noulPropositions),
    context: forms(str(0, U), obj({ id: str(0, U), text: str(0, U) }, ["text"]), arr(obj({ id: str(0, U), text: str(0, U) }, ["text"]), 1, U)),
    auto_accept: T_RANGE,
  },
  decide: {
    decision: str(1, LIMITS.decideDecisionChars),
    evidence: str(1, LIMITS.decideEvidenceChars),
    priorities: str(1, LIMITS.decidePrioritiesChars),
    candidates: arr(obj({ id: str(1, 64, { pattern: SLUG_SOURCE }), description: str(1, LIMITS.decideCandidateChars) }, ["id", "description"]), 2, LIMITS.decideCandidates),
    requirements: arr(str(1, LIMITS.decideRequirementChars), 0, LIMITS.decideRequirements),
    escape_hatches: { type: "boolean" },
  },
  rerank: {
    query: str(1, LIMITS.rerankQueryChars),
    candidates: arr(obj({ id: str(0, U), text: str(0, LIMITS.rerankTotalChars) }, ["text"]), 1, LIMITS.rerankCandidates),
    top_k: int(1, LIMITS.rerankTopK),
  },
  find: {
    query: str(1, U),
    candidates: arr(obj({ id: str(0, U), text: str(0, U) }, ["text"]), 1, LIMITS.rerankCandidates),
    top_k: int(1, LIMITS.findTopK),
  },
  gate: {
    request: str(1, U),
    diff: str(1, LIMITS.reviewDocChars),
    claims: arr(str(1, U), 1, LIMITS.gateClaims),
    evidence: arr(obj({ id: str(1, U), text: str(0, LIMITS.reviewDocChars) }, ["id", "text"]), 1, LIMITS.gateEvidenceItems),
    tests: str(0, LIMITS.reviewDocChars),
    auto_accept: T_RANGE,
  },
  verify: { claims: arr(ANY_STR), evidence: forms(ANY_STR, looseItem(ANY_STR), arr(looseItem(ANY_STR))), auto_accept: T_RANGE },
  review: { request: ANY_STR, diff: ANY_STR, tests: ANY_STR, auto_accept: T_RANGE },
  classify: { items: arr(looseItem(ANY_STR)), classes: arr(obj({ id: ANY_STR, description: ANY_STR }, ["description"])), auto_accept: T_RANGE },
  compare: { passage_a: ANY_STR, passage_b: ANY_STR, auto_accept: T_RANGE },
  extract: { document: ANY_STR, fields: arr(obj({ id: ANY_STR, pattern: ANY_STR, flags: ANY_STR, description: ANY_STR }, ["id", "pattern", "description"])), auto_accept: T_RANGE },
  screen: { text: ANY_STR },
});

// ── Published JSON Schema versus sent shape ─────────────────────────────────
// Conservative: a keyword whose effect on the control's values cannot be
// decided here makes the field `unverifiable`, which is incompatible.
const ANNOTATIONS = new Set(["$schema", "$id", "$anchor", "$comment", "$defs", "definitions", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const UNDECIDABLE = ["not", "if", "then", "else", "enum", "const", "dependentSchemas", "dependentRequired", "dependencies", "patternProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contains", "prefixItems", "multipleOf", "format", "minProperties", "maxProperties", "$dynamicRef", "$recursiveRef"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sub = (path, key) => (path ? `${path}.${key}` : key);

/** A local JSON-pointer $ref ("#", "#/$defs/x", "#/definitions/x") inside the tool's inputSchema; anything else is unresolvable. */
function resolveRef(root, ref) {
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) return null;
  let node = root;
  for (const raw of ref === "#" ? [] : ref.slice(2).split("/")) {
    let key;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return null;
    }
    if (!isObj(node) && !Array.isArray(node)) return null;
    node = node[key];
  }
  return isObj(node) ? node : null;
}

/** null when `schema` accepts every value of the sent shape `need`, else the first reason. */
function accepts(schema, need, path, root, depth = 0) {
  if (need.forms) {
    for (const form of need.forms) {
      const r = accepts(schema, form, path, root, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (depth > 32 || !isObj(schema)) return `unverifiable:${path}`;
  if (UNDECIDABLE.some((k) => k in schema)) return `unverifiable:${path}`;
  let decided = false;
  if ("$ref" in schema) {
    const target = resolveRef(root, schema.$ref);
    if (!target) return `unverifiable:${path}`;
    const r = accepts(target, need, path, root, depth + 1);
    if (r) return r;
    decided = true;
  }
  if ("allOf" in schema) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) return `unverifiable:${path}`;
    for (const part of schema.allOf) {
      const r = accepts(part, need, path, root, depth + 1);
      if (r) return r;
    }
    decided = true;
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (!(key in schema)) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0) return `unverifiable:${path}`;
    const reasons = schema[key].map((alt) => accepts(alt, need, path, root, depth + 1));
    const passing = reasons.filter((r) => r === null).length;
    // anyOf: one alternative accepting the sent value is enough. oneOf: exactly
    // one, since a value two alternatives accept is rejected by oneOf.
    if (passing === 0) {
      const types = reasons.filter((r) => r.startsWith(`type:${path}=`));
      return types.length === reasons.length ? `type:${path}=${types.map((r) => r.slice(`type:${path}=`.length)).join("|")}` : reasons.find((r) => !r.startsWith(`type:${path}=`));
    }
    if (key === "oneOf" && passing > 1) return `ambiguous_oneOf:${path}`;
    decided = true;
  }
  if ("type" in schema) return typed(schema, need, path, root, depth);
  const constraining = Object.keys(schema).some((k) => !ANNOTATIONS.has(k) && !["$ref", "allOf", "anyOf", "oneOf"].includes(k));
  return decided && !constraining ? null : `unverifiable:${path}`;
}

function typed(schema, need, path, root, depth) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.every((t) => typeof t === "string")) return `unverifiable:${path}`;
  if (!(types.includes(need.type) || (need.type === "integer" && types.includes("number")))) return `type:${path}=${types.join("|")}`;
  switch (need.type) {
    case "string": {
      // A free string is written by an agent that sees the schema: only its type is the control's.
      if (need.free) return null;
      const min = schema.minLength ?? 0;
      if (min > need.minLength) return `limit:${path}.minLength=${min}>${need.minLength}`;
      if (schema.maxLength !== undefined && !(schema.maxLength >= need.maxLength)) return `limit:${path}.maxLength=${schema.maxLength}<${need.maxLength}`;
      if (schema.pattern !== undefined && schema.pattern !== need.pattern) return `pattern:${path}`;
      return null;
    }
    case "number":
    case "integer":
      return inRange(schema, need) ? null : `range:${path}`;
    case "boolean":
      return null;
    case "array": {
      if (schema.uniqueItems === true) return `unverifiable:${path}`;
      const min = schema.minItems ?? 0;
      if (need.minItems !== undefined && min > need.minItems) return `limit:${path}.minItems=${min}>${need.minItems}`;
      if (need.maxItems !== undefined && schema.maxItems !== undefined && !(schema.maxItems >= need.maxItems)) return `limit:${path}.maxItems=${schema.maxItems}<${need.maxItems}`;
      if (!isObj(schema.items)) return `unverifiable:${path}[]`;
      return accepts(schema.items, need.items, `${path}[]`, root, depth + 1);
    }
    case "object":
      return objectProblems(schema, need, path, root, depth)[0] ?? null;
    default:
      return `unverifiable:${path}`;
  }
}

/** Every value in the sent range satisfies the schema's numeric bounds (draft 4 boolean exclusives included). */
function inRange(schema, need) {
  const lo = need.min;
  const hi = need.max;
  const loOk = (bound, exclusive) => (exclusive ? lo > bound || (lo === bound && need.minExclusive === true) : lo >= bound);
  const hiOk = (bound, exclusive) => (exclusive ? hi < bound || (hi === bound && need.maxExclusive === true) : hi <= bound);
  if (schema.minimum !== undefined && (typeof schema.minimum !== "number" || !loOk(schema.minimum, schema.exclusiveMinimum === true))) return false;
  if (schema.maximum !== undefined && (typeof schema.maximum !== "number" || !hiOk(schema.maximum, schema.exclusiveMaximum === true))) return false;
  if (typeof schema.exclusiveMinimum === "number" && !loOk(schema.exclusiveMinimum, true)) return false;
  if (typeof schema.exclusiveMaximum === "number" && !hiOk(schema.exclusiveMaximum, true)) return false;
  return true;
}

/** Reasons an object schema refuses the sent keys: absent or mistyped keys, required keys the control does not always send. */
function objectProblems(schema, need, path, root, depth) {
  const problems = [];
  const props = isObj(schema.properties) ? schema.properties : {};
  for (const [key, shape] of Object.entries(need.properties)) {
    if (!Object.hasOwn(props, key)) problems.push(key === "auto_accept" && !path ? "missing_auto_accept" : `missing_key:${sub(path, key)}`);
    else {
      const r = accepts(props[key], shape, sub(path, key), root, depth + 1);
      if (r) problems.push(r);
    }
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((k) => typeof k === "string"))) problems.push(`unverifiable:${path || "(input)"}.required`);
  else {
    for (const key of schema.required ?? []) {
      if (need.always.includes(key)) continue;
      problems.push(Object.hasOwn(need.properties, key) ? `required_optional:${sub(path, key)}` : `required_unused:${sub(path, key)}`);
    }
  }
  return problems;
}

/** Every reason the published inputSchema of a core tool refuses what the control sends to it; [] when compatible. */
export function schemaProblems(base, inputSchema) {
  if (!isObj(inputSchema) || !isObj(inputSchema.properties)) return ["no_input_schema"];
  if (inputSchema.type !== "object") return [`type:(input)=${String(inputSchema.type)}`];
  if (UNDECIDABLE.some((k) => k in inputSchema) || ["$ref", "allOf", "anyOf", "oneOf"].some((k) => k in inputSchema)) return ["unverifiable:(input)"];
  return objectProblems(inputSchema, { properties: SENT_SHAPES[base], always: TOOL_KEYS[base].required }, "", inputSchema, 0);
}

/**
 * checkTools({tools}) — check a tools/list answer before activation (tools/list
 * is no tools/call and costs no budget). Every core tool must be listed (any
 * Claude Code name form), and its published inputSchema must accept everything
 * the control sends to it (SENT_SHAPES): each key the control uses declared
 * with a compatible type, bounds and pattern (JSON Schema anyOf/oneOf/allOf/
 * $ref resolved; anything undecidable is incompatible), auto_accept accepting
 * every T in (0.5, 1) where the control sends it, and no required key the
 * control does not always send. audit is optional and only reported.
 * Returns {ok, missing: [short names], incompatible: [{tool, reason}], audit: boolean, prefix}
 * with reasons such as `type:propositions=number`, `missing_auto_accept`,
 * `missing_key:top_k`, `limit:claims.maxItems=8<16`, `range:auto_accept`,
 * `pattern:candidates[].id`, `unverifiable:evidence`, `required_unused:key`,
 * `required_optional:key`, `no_input_schema`.
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
    for (const reason of schemaProblems(base, tool.inputSchema)) incompatible.push({ tool: base, reason });
  }
  const names = tools.map((t) => String(t?.name ?? ""));
  const prefix = names.find((n) => n.startsWith("mcp__plugin_jev_jev__")) ? "mcp__plugin_jev_jev__" : names.find((n) => n.startsWith("mcp__jev__")) ? "mcp__jev__" : "";
  return { ok: missing.length === 0 && incompatible.length === 0, missing, incompatible, audit: byBase.has("audit"), prefix };
}

/** The sum tolerance of src/lib.ts (PROBABILITY_SUM_TOLERANCE). */
const PROBABILITY_SUM_TOLERANCE = 0.01 + 1e-12;
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

/** noul context: one document, one {id?, text} item, or a non-empty array of such items (the tool's evidence schema). */
function contextShapeOk(context) {
  const item = (i) => isObj(i) && Object.keys(i).every((k) => k === "id" || k === "text") && isString(i.text) && (i.id === undefined || isString(i.id));
  return isString(context) || item(context) || (Array.isArray(context) && context.length >= 1 && context.every(item));
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
    if (args.context !== undefined && !contextShapeOk(args.context)) problems.push("context_shape");
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
  else if (args.requirements?.some((r) => !isString(r) || r.length < 1 || r.length > LIMITS.decideRequirementChars)) problems.push("requirement_length");
  if (args.escape_hatches !== undefined && typeof args.escape_hatches !== "boolean") problems.push("escape_hatches_type");
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

/**
 * noul: {ok: true, probabilities: [p…]} in the order of the propositions sent, or {ok: false, reason}.
 * The real rows are {id, proposition, probability, label, auto}: ids must be
 * distinct strings and, when `sentPropositions` is given, rows[i].proposition
 * must echo sentPropositions[i] exactly (an absent echo is no association).
 * label/auto are never read.
 */
export function parseNoulResult(result, count, sentPropositions = null) {
  if (!result || result.tool !== "jev_noul" || (result.status !== undefined && result.status !== "ok")) return { ok: false, reason: "invalid_response" };
  if (sentPropositions !== null && (!Array.isArray(sentPropositions) || sentPropositions.length !== count)) return { ok: false, reason: "sent_count_mismatch" };
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length !== count) return { ok: false, reason: "result_count" };
  if (!rows.every(isObj)) return { ok: false, reason: "row_malformed" };
  const probabilities = rows.map((r) => r.probability);
  if (!probabilities.every(unit)) return { ok: false, reason: "probability_domain" };
  const ids = rows.map((r) => r.id);
  if (!ids.every((id) => isString(id) && id !== "") || new Set(ids).size !== ids.length) return { ok: false, reason: "row_ids" };
  if (sentPropositions !== null && rows.some((r, i) => r.proposition !== sentPropositions[i])) return { ok: false, reason: "proposition_association" };
  return { ok: true, probabilities };
}

/**
 * decide: {ok: true, selected, escaped, confidence, probabilities, warnings} or {ok: false, reason}.
 * Real contract (src/index.ts jev_decide): `selected` is a candidate id or an
 * escape hatch, `escaped` is true exactly when it is not a candidate;
 * `probabilities` is the Choice distribution keyed by candidate ids (plus the
 * hatches when they are on) whose argmax is `selected`; `confidence` is the
 * provider's own confidence for the pick, NOT the selected probability (the
 * two differ in upstream tests), so they are not compared; `warnings` is an
 * array of strings (contradicted requirements). A confidence the server
 * normalized to null is unusable here.
 */
export function parseDecideResult(result, candidateIds) {
  const rec = result?.recommendation;
  if (!result || result.tool !== "jev_decide" || !isObj(rec) || rec.status !== undefined) return { ok: false, reason: "invalid_response" };
  if (typeof rec.selected !== "string" || typeof rec.escaped !== "boolean" || !unit(rec.confidence)) return { ok: false, reason: "recommendation_malformed" };
  const isCandidate = candidateIds.includes(rec.selected);
  if (!isCandidate && !DECIDE_HATCHES.includes(rec.selected)) return { ok: false, reason: "selected_unknown_id" };
  if (rec.escaped === isCandidate) return { ok: false, reason: "escaped_mismatch" };
  const probs = rec.probabilities ?? null;
  if (probs !== null) {
    if (!isObj(probs)) return { ok: false, reason: "probabilities_malformed" };
    // The control never sends escape_hatches:false, so the server's distribution is over the candidates plus the three hatches, exactly.
    if (![...candidateIds, ...DECIDE_HATCHES].every((id) => Object.hasOwn(probs, id))) return { ok: false, reason: "probabilities_coverage" };
    if (Object.keys(probs).some((k) => !candidateIds.includes(k) && !DECIDE_HATCHES.includes(k))) return { ok: false, reason: "probabilities_unknown_key" };
    const values = Object.values(probs);
    if (!values.every(unit)) return { ok: false, reason: "probabilities_domain" };
    if (Math.abs(values.reduce((x, y) => x + y, 0) - 1) > PROBABILITY_SUM_TOLERANCE) return { ok: false, reason: "probabilities_sum" };
    if (Object.hasOwn(probs, rec.selected) && probs[rec.selected] < Math.max(...values) - 1e-9) return { ok: false, reason: "selected_not_argmax" };
  }
  if (!Array.isArray(result.warnings) || !result.warnings.every(isString)) return { ok: false, reason: "warnings_malformed" };
  return { ok: true, selected: rec.selected, escaped: rec.escaped, confidence: rec.confidence, probabilities: probs, warnings: result.warnings };
}

/** rerank/find: exactly min(topK, sent) entries with a finite score in [0,1], known and distinct ids (rerank ranks 1..n when present; find also a finite `exists` in [0,1]); sorted descending (server order breaks ties). */
export function parseRankResult(tool, result, sentIds, topK) {
  const listKey = tool === "rerank" ? "ranked" : "top";
  const scoreKey = tool === "rerank" ? "relevance" : "probability";
  if (!result || result.tool !== `jev_${tool}` || result.status === "invalid_response" || !Array.isArray(result[listKey])) return { ok: false, reason: "invalid_response" };
  const entries = result[listKey];
  if (entries.length !== Math.min(topK, sentIds.length)) return { ok: false, reason: "partial_ranking" };
  const known = new Set(sentIds);
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    if (typeof e?.id !== "string" || !known.has(e.id) || seen.has(e.id)) return { ok: false, reason: "unknown_or_repeated_id" };
    if (!unit(e[scoreKey])) return { ok: false, reason: "score_domain" };
    // rerank numbers its rows 1..n in the order returned.
    if (tool === "rerank" && e.rank !== undefined && e.rank !== i + 1) return { ok: false, reason: "rank_inconsistent" };
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

// Option batches for a decision (D6): a model-written JSON batch becomes a
// validated, deduplicated list of options. At least five distinct real options
// when that many alternatives exist (fewer only when the space is declared
// small), at most twenty including the two control options, 1-3 evidence lines
// each. The control options "gather more evidence" and "ask the user" are always
// present; their ids cannot collide with jev_decide's escape hatches
// (ask_user, investigate, none). An option that is meant to be carried out names
// ONE concrete observable action ({tool, target, ...arguments}: the arguments
// that change what the call does are part of it) and optional preconditions
// (see actions.mjs): they are kept, hashed, checked for availability before the
// decision and bound into the plan and the receipt. A kind whose options are
// actions (order, command, edit, delegate) requires the descriptor.
import { createHash } from "node:crypto";
import { actionHash, descriptorKey, EDIT_TOOLS, normalizeDescriptor, normalizePreconditions } from "./actions.mjs";
import { DECIDE_HATCHES } from "./contracts.mjs";

export const KINDS = Object.freeze(["order", "approach", "command", "edit", "delegate", "ask", "done"]);
/** `order` runs every eligible option in order; every other kind is exclusive (only the first runs). */
export const EXCLUSIVE_KINDS = Object.freeze(KINDS.filter((k) => k !== "order"));
export const GATHER_ID = "action_gather_evidence";
export const ASK_ID = "action_ask_user";
export const CONTROL_IDS = Object.freeze([GATHER_ID, ASK_ID]);
export const MIN_OPTIONS = 5;
export const MAX_OPTIONS = 20;
export const MAX_EVIDENCE_LINES = 3;
const MAX_EVIDENCE_LINE_CHARS = 600;
const MAX_TEXT_CHARS = 1500;
const SLUG = /^[a-z][a-z0-9_-]*$/;

const CONTROL_TEXT = {
  [GATHER_ID]: "Gather more evidence before acting: read or run something that could change the choice.",
  [ASK_ID]: "Ask the user which option to take.",
};

const norm = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();

/** The kinds whose real options are single actions, and the tools each allows (null: any action tool). */
export const ACTION_REQUIRED = Object.freeze({ order: null, command: ["Bash"], edit: EDIT_TOOLS, delegate: ["Agent"] });
const ASK_ACTION = Object.freeze({ tool: "AskUserQuestion", target: "", args: {}, view: {} });

/** Hash of an option's meaning: text, evidence, concrete action (tool, target and arguments) and preconditions (new material when any of them changes). */
export function optionHash(option, length = 16) {
  const action = option.action ? descriptorKey(option.action) : "-";
  const pre = (option.preconditions ?? []).map((p) => `${p.kind}:${p.path}:${p.sha256 ?? ""}`).join("|");
  return createHash("sha256").update(`${norm(option.text)}\n${option.evidence.map(norm).join("\n")}\n${action}\n${pre}`).digest("hex").slice(0, length);
}

/** Full SHA-256 of the option's action descriptor, or null when the option names no observable action. */
export const optionActionHash = (option) => (option.action ? actionHash(option.action) : null);

export function evidenceHash(lines) {
  return createHash("sha256").update(lines.map(norm).join("\n")).digest("hex").slice(0, 16);
}

/**
 * Validate and normalize a raw batch {decision, kind, options: [{id, text, evidence: [..], action?: {tool, target, ...arguments},
 * preconditions?: [{kind, path, sha256?}]}], priorities?, space_small?}. `root` (the repository) makes paths relative.
 * Returns {ok: true, batch} or {ok: false, problems}.
 */
export function normalizeBatch(raw, { root = null } = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["batch must be a JSON object {decision, kind, options}"] };
  const decision = typeof raw.decision === "string" ? raw.decision.trim() : "";
  if (!decision || decision.length > 1500) problems.push("decision must be a non-empty string of at most 1500 characters");
  if (!KINDS.includes(raw.kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
  if (!Array.isArray(raw.options)) return { ok: false, problems: [...problems, "options must be an array"] };
  const merged = [];
  const ids = new Set();
  for (const [i, o] of raw.options.entries()) {
    const where = `options[${i}]`;
    if (!o || typeof o !== "object") {
      problems.push(`${where} must be an object {id, text, evidence}`);
      continue;
    }
    const id = typeof o.id === "string" ? o.id : "";
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!SLUG.test(id) || id.length > 64) problems.push(`${where}.id must be a lowercase slug (a-z, 0-9, _ or -), at most 64 characters`);
    else if (DECIDE_HATCHES.includes(id)) problems.push(`${where}.id "${id}" collides with a jev_decide escape hatch; use e.g. action_${id}`);
    if (!text || text.length > MAX_TEXT_CHARS) problems.push(`${where}.text must be 1-${MAX_TEXT_CHARS} characters`);
    const evidence = Array.isArray(o.evidence) ? o.evidence.filter((e) => typeof e === "string" && e.trim() !== "").map((e) => e.trim()) : [];
    if (CONTROL_IDS.includes(id)) {
      // The control options are always present; a model-supplied one only has to be well formed.
      if (!ids.has(id)) {
        ids.add(id);
        merged.push({ id, text: text || CONTROL_TEXT[id], evidence: evidence.length ? evidence.slice(0, MAX_EVIDENCE_LINES) : ["Always available as an option (D6): the control option, not a repository fact."], control: true, action: id === ASK_ID ? { ...ASK_ACTION } : null, preconditions: [] });
      }
      continue;
    }
    let action = null;
    if (o.action !== undefined && o.action !== null) {
      const d = normalizeDescriptor(o.action, root);
      if (!d.ok) problems.push(...d.problems.map((m) => `${where}.${m}`));
      else action = d.descriptor;
    }
    if (raw.kind in ACTION_REQUIRED) {
      const allowed = ACTION_REQUIRED[raw.kind];
      if (!action) problems.push(`${where}.action is required for kind ${raw.kind}: name the one concrete tool call this option stands for`);
      else if (allowed && !allowed.includes(action.tool)) problems.push(`${where}.action.tool must be ${allowed.join(" or ")} for kind ${raw.kind}`);
      else if (action.tool === "AskUserQuestion") problems.push(`${where}.action must not be a question: asking the user is the control option ${ASK_ID}`);
    }
    if (action?.tool === "Bash" && /jev-control\/cli\.mjs/.test(action.target)) problems.push(`${where}.action must not be a control step: the helper is not an option`);
    const pre = normalizePreconditions(o.preconditions, root);
    if (!pre.ok) problems.push(...pre.problems.map((m) => `${where}.${m}`));
    if (evidence.length < 1 || evidence.length > MAX_EVIDENCE_LINES) problems.push(`${where}.evidence must have 1-${MAX_EVIDENCE_LINES} concrete lines`);
    else if (evidence.some((e) => e.length > MAX_EVIDENCE_LINE_CHARS)) problems.push(`${where}.evidence lines must be at most ${MAX_EVIDENCE_LINE_CHARS} characters`);
    if (ids.has(id)) {
      problems.push(`${where}.id "${id}" is repeated`);
      continue;
    }
    const twin = merged.find((m) => !m.control && norm(m.text) === norm(text) && JSON.stringify(m.action) === JSON.stringify(action) && JSON.stringify(m.preconditions) === JSON.stringify(pre.preconditions ?? []));
    if (twin) {
      // Duplicates are merged, keeping the first id and the evidence of both (at most three lines).
      for (const line of evidence) if (twin.evidence.length < MAX_EVIDENCE_LINES && !twin.evidence.map(norm).includes(norm(line))) twin.evidence.push(line);
      twin.merged = [...(twin.merged ?? []), id];
      continue;
    }
    ids.add(id);
    merged.push({ id, text, evidence, control: false, action, preconditions: pre.preconditions ?? [] });
  }
  for (const id of CONTROL_IDS) {
    if (!ids.has(id)) merged.push({ id, text: CONTROL_TEXT[id], evidence: ["Always available as an option (D6): the control option, not a repository fact."], control: true, action: id === ASK_ID ? { ...ASK_ACTION } : null, preconditions: [] });
  }
  const real = merged.filter((m) => !m.control);
  if (real.length === 0) problems.push("at least one real option is required");
  if (real.length < MIN_OPTIONS && raw.space_small !== true) {
    problems.push(`at least ${MIN_OPTIONS} distinct real options are required when that many alternatives exist; declare "space_small": true only when the space really is smaller`);
  }
  if (merged.length > MAX_OPTIONS) problems.push(`at most ${MAX_OPTIONS} options per batch including the two control options`);
  if (typeof raw.priorities === "string" && raw.priorities.length > 2000) problems.push("priorities must be at most 2000 characters");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    batch: {
      decision,
      kind: raw.kind,
      options: merged,
      space_small: raw.space_small === true,
      priorities: typeof raw.priorities === "string" ? raw.priorities.trim() : "",
      new_material: typeof raw.new_material === "string" ? raw.new_material.replace(/\s+/g, " ").trim().slice(0, 200) : "",
    },
  };
}

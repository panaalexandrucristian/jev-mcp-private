// Concrete action descriptors, preconditions and the compact plan-item encoding.
// An option that is meant to be carried out names ONE observable action
// ({tool, target}) and optional preconditions; the plan the helper prints carries
// a short hash of that descriptor per item, so the transcript audit (measure.mjs)
// can bind an executed tool call to the exact option that authorized it, and the
// receipt can bind the authorization to the same descriptor. Metadata only: the
// descriptor is a tool name and a path, a command, a pattern or a subagent type.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const ACTION_TOOLS = Object.freeze(["Bash", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS", "Agent", "AskUserQuestion"]);
const ALIASES = Object.freeze({ Task: "Agent" });
const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "LS"]);
export const EDIT_TOOLS = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const MAX_TARGET_CHARS = 2000;
export const MAX_PRECONDITIONS = 5;
export const PRECONDITION_KINDS = Object.freeze(["path_exists", "path_absent", "path_sha256"]);

/** Plan item letters: execute, reserve (an ordered reserve, never an automatic fallback), suspend (a control option), after_suspend. */
export const PLAN_LETTER = Object.freeze({ execute: "e", reserve: "r", suspend: "s", after_suspend: "x" });
export const PLAN_ACTION = Object.freeze(Object.fromEntries(Object.entries(PLAN_LETTER).map(([k, v]) => [v, k])));

const collapse = (text) => String(text).replace(/\s+/g, " ").trim();

/** A path relative to `root` in posix form when it lies inside it; otherwise normalized but unchanged in meaning. */
export function normalizePath(path, root = null) {
  const text = String(path ?? "").trim();
  if (text === "") return "";
  let rel = text;
  if (root && isAbsolute(text)) {
    const r = relative(resolve(root), resolve(text));
    if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) rel = r.split(sep).join("/");
    else if (r === "") rel = ".";
    else return posix.normalize(text);
  }
  const norm = posix.normalize(rel.split(sep).join("/"));
  return norm === "" ? "." : norm.replace(/^\.\//, "");
}

/** Validate and normalize a descriptor {tool, target}. Returns {ok: true, descriptor} or {ok: false, problems}. */
export function normalizeDescriptor(raw, root = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["action must be an object {tool, target}"] };
  const tool = ALIASES[raw.tool] ?? raw.tool;
  if (!ACTION_TOOLS.includes(tool)) return { ok: false, problems: [`action.tool must be one of ${ACTION_TOOLS.join(", ")}`] };
  if (tool === "AskUserQuestion") return { ok: true, descriptor: { tool, target: "" } };
  if (typeof raw.target !== "string" || collapse(raw.target) === "") return { ok: false, problems: [`action.target is required for ${tool}`] };
  if (raw.target.length > MAX_TARGET_CHARS) return { ok: false, problems: [`action.target must be at most ${MAX_TARGET_CHARS} characters`] };
  const target = PATH_TOOLS.has(tool) ? normalizePath(raw.target, root) : collapse(raw.target);
  return { ok: true, descriptor: { tool, target } };
}

/** The descriptor of an observed Claude Code tool call, or null for a tool that is not a controllable action. */
export function observedDescriptor(name, input, root = null) {
  const tool = ALIASES[name] ?? name;
  if (!ACTION_TOOLS.includes(tool)) return null;
  const i = input && typeof input === "object" ? input : {};
  let target = "";
  if (tool === "Bash") target = collapse(i.command ?? "");
  else if (tool === "Grep" || tool === "Glob") target = collapse(i.pattern ?? "");
  else if (tool === "NotebookEdit") target = normalizePath(i.notebook_path ?? i.file_path ?? "", root);
  else if (PATH_TOOLS.has(tool)) target = normalizePath(i.file_path ?? i.path ?? "", root);
  else if (tool === "Agent") target = collapse(i.subagent_type ?? i.description ?? "");
  return { tool, target };
}

export const descriptorKey = (d) => `${d.tool}\n${d.target}`;
/** Full SHA-256 of the canonical descriptor. */
export const actionHash = (d) => createHash("sha256").update(descriptorKey(d)).digest("hex");
/** The 12-hex form printed in plan items. */
export const shortHash = (hash) => String(hash).slice(0, 12);
export const sameAction = (a, b) => a && b && descriptorKey(a) === descriptorKey(b);

/** One compact plan item: id:letter:rawscore:hash12 ("-" when the option names no action). */
export function planItem({ id, action, score, ah = null, descriptor = null }) {
  const short = ah ?? (descriptor ? shortHash(actionHash(descriptor)) : null);
  return `${id}:${PLAN_LETTER[action]}:${score}:${short ?? "-"}`;
}

/** Parse a plan item; null when it is not well formed. `ah` is null for "-". */
export function parsePlanItem(text) {
  const parts = String(text).split(":");
  if (parts.length !== 4) return null;
  const [id, letter, score, ah] = parts;
  const action = PLAN_ACTION[letter];
  const value = Number(score);
  if (!id || !action || score === "" || !Number.isFinite(value) || !(ah === "-" || /^[0-9a-f]{12}$/.test(ah))) return null;
  return { id, action, score: value, ah: ah === "-" ? null : ah };
}

// ── Preconditions ───────────────────────────────────────────────────────────

/** Validate preconditions [{kind, path, sha256?}]. Returns {ok: true, preconditions} or {ok: false, problems}. */
export function normalizePreconditions(raw, root = null) {
  if (raw === undefined) return { ok: true, preconditions: [] };
  if (!Array.isArray(raw) || raw.length > MAX_PRECONDITIONS) return { ok: false, problems: [`preconditions must be an array of at most ${MAX_PRECONDITIONS}`] };
  const out = [];
  const problems = [];
  raw.forEach((p, i) => {
    if (!p || typeof p !== "object" || !PRECONDITION_KINDS.includes(p.kind) || typeof p.path !== "string" || p.path.trim() === "" || p.path.length > 500) {
      problems.push(`preconditions[${i}] must be {kind: ${PRECONDITION_KINDS.join("|")}, path}`);
      return;
    }
    const item = { kind: p.kind, path: normalizePath(p.path, root) };
    if (p.kind === "path_sha256") {
      if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) {
        problems.push(`preconditions[${i}].sha256 must be 64 lowercase hex characters`);
        return;
      }
      item.sha256 = p.sha256;
    }
    out.push(item);
  });
  return problems.length ? { ok: false, problems } : { ok: true, preconditions: out };
}

function insideRoot(root, path) {
  if (isAbsolute(path)) return null;
  const abs = resolve(root, path);
  const rel = relative(resolve(root), abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

/** Evaluate preconditions against the work tree now. {ok, failed: [{index, kind, path, reason}]}. */
export function evaluatePreconditions(preconditions, root) {
  const failed = [];
  (preconditions ?? []).forEach((p, index) => {
    const abs = insideRoot(root, p.path);
    if (!abs) return failed.push({ index, kind: p.kind, path: p.path, reason: "outside_repository" });
    let stat = null;
    try {
      stat = lstatSync(abs);
    } catch {
      stat = null;
    }
    if (p.kind === "path_exists" && !stat) failed.push({ index, kind: p.kind, path: p.path, reason: "missing" });
    else if (p.kind === "path_absent" && stat) failed.push({ index, kind: p.kind, path: p.path, reason: "present" });
    else if (p.kind === "path_sha256") {
      if (!stat || !stat.isFile()) return failed.push({ index, kind: p.kind, path: p.path, reason: "missing" });
      try {
        realpathSync(abs);
        const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
        if (hash !== p.sha256) failed.push({ index, kind: p.kind, path: p.path, reason: "content_changed" });
      } catch {
        failed.push({ index, kind: p.kind, path: p.path, reason: "unreadable" });
      }
    }
  });
  return { ok: failed.length === 0, failed };
}

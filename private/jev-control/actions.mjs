// Concrete action descriptors, preconditions and the compact plan-item encoding.
// An option that is meant to be carried out names ONE observable action (tool,
// target and the arguments that change what the call does: file content, the
// replacement, a read range, the delegated prompt, a search scope) and optional
// preconditions; the plan the helper prints carries a short hash of that
// descriptor per item, so the transcript audit (measure.mjs) can bind an executed
// tool call to the exact option that authorized it, and the receipt can bind the
// authorization to the same descriptor. Metadata only: a payload is kept as its
// SHA-256, never as text.
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

// Per-tool arguments that are part of what a call MEANS: two calls with the same
// tool and target but different arguments are different actions. Payload
// arguments (file content, replacements, a delegated prompt) are bound by their
// SHA-256, so receipts and the plan carry hashes, never the text; the option's
// batch file is the local reference to the payload. An argument that is not
// listed does not change what the call does (a Bash `description`, a timeout) and
// is ignored; an option that names an unlisted argument is refused, so nothing
// the model believes is bound goes unbound.
const ARG_SPECS = Object.freeze({
  Bash: { run_in_background: { type: "bool" } },
  Read: { offset: { type: "int" }, limit: { type: "int" } },
  Write: { content: { type: "payload", required: true } },
  Edit: { old_string: { type: "payload", required: true }, new_string: { type: "payload", required: true }, replace_all: { type: "bool" } },
  MultiEdit: { edits: { type: "edits", required: true } },
  NotebookEdit: { new_source: { type: "payload" }, cell_id: { type: "str" }, cell_type: { type: "str" }, edit_mode: { type: "str" } },
  Grep: { path: { type: "path" }, glob: { type: "str" }, type: { type: "str" }, output_mode: { type: "str" }, "-i": { type: "bool" }, "-n": { type: "bool" }, "-A": { type: "int" }, "-B": { type: "int" }, "-C": { type: "int" }, context: { type: "int" }, multiline: { type: "bool" }, head_limit: { type: "int" }, offset: { type: "int" } },
  Glob: { path: { type: "path" } },
  LS: { ignore: { type: "payload" } },
  Agent: { model: { type: "str" }, prompt: { type: "payload", required: true } },
  AskUserQuestion: { questions: { type: "payload" } },
});
export const MAX_PAYLOAD_CHARS = 200_000;
const VIEW_HEAD = 160;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const head = (text) => collapse(text).slice(0, VIEW_HEAD);
const jsonText = (v) => JSON.stringify(v) ?? "null";

/** A payload value as {value: "s256:<hex>" | "j256:<hex>", view: {chars, head}}: a string by its own bytes, anything else by its JSON. */
function payloadOf(v) {
  if (typeof v === "string") return { value: `s256:${sha(v)}`, view: { chars: v.length, head: head(v) } };
  const text = jsonText(v);
  return { value: `j256:${sha(text)}`, view: { chars: text.length, head: head(text) } };
}

/** The canonical form of an edit list [{old_string, new_string, replace_all?}] or null when it is not one. */
function canonEdits(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== "object" || typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
    out.push([e.old_string, e.new_string, e.replace_all === true]);
  }
  return out;
}

/**
 * Canonicalize the arguments of `tool` from `input` ({name: value}). `strict` (an option's action) turns a missing
 * required argument, a wrong type, an oversized payload or an unknown name into a problem; otherwise (an observed call)
 * the reading is lenient and never fails. Returns {args, view, problems}.
 */
function canonArgs(tool, input, root, strict) {
  const spec = ARG_SPECS[tool] ?? {};
  const args = {};
  const view = {};
  const problems = [];
  for (const [name, def] of Object.entries(spec)) {
    const v = input[name];
    if (v === undefined || v === null) {
      if (def.required && strict) problems.push(`action.${name} is required for ${tool}: the call is bound by its arguments, so name them exactly`);
      continue;
    }
    if (def.type === "bool") {
      if (v === true) args[name] = true;
      else if (v !== false && strict) problems.push(`action.${name} must be a boolean`);
    } else if (def.type === "int") {
      if (Number.isInteger(v)) args[name] = v;
      else if (strict) problems.push(`action.${name} must be an integer`);
      else args[name] = `?${jsonText(v).slice(0, 40)}`;
    } else if (def.type === "str" || def.type === "path") {
      if (typeof v === "string") {
        if (v.trim() !== "") args[name] = def.type === "path" ? normalizePath(v, root) : v;
      } else if (strict) problems.push(`action.${name} must be a string`);
      else args[name] = `?${jsonText(v).slice(0, 40)}`;
    } else if (def.type === "edits") {
      const edits = canonEdits(v);
      if (!edits) {
        if (strict) problems.push(`action.${name} must be a non-empty array of {old_string, new_string, replace_all?}`);
        else args[name] = `?${sha(jsonText(v)).slice(0, 16)}`;
      } else {
        const p = payloadOf(edits);
        args[name] = p.value;
        view[name] = p.view;
      }
    } else if (def.type === "payload") {
      if (strict && typeof v === "string" && v.length > MAX_PAYLOAD_CHARS) problems.push(`action.${name} must be at most ${MAX_PAYLOAD_CHARS} characters`);
      const p = payloadOf(v);
      args[name] = p.value;
      view[name] = p.view;
    }
  }
  if (strict) for (const name of Object.keys(input)) if (name !== "tool" && name !== "target" && !(name in spec)) problems.push(`action.${name} is not an argument of ${tool} (${Object.keys(spec).join(", ") || "none"})`);
  return { args, view, problems };
}

/**
 * Validate and normalize an option's action {tool, target, ...arguments} (the arguments are named like the Claude Code
 * tool's own, see ARG_SPECS). Returns {ok: true, descriptor: {tool, target, args, view}} or {ok: false, problems}.
 * `args` holds the canonical values (payloads as hashes) and is what the action hash covers; `view` (character counts and
 * a short head per payload) is only what Jev is shown and is not part of the hash.
 */
export function normalizeDescriptor(raw, root = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["action must be an object {tool, target, ...arguments}"] };
  const tool = ALIASES[raw.tool] ?? raw.tool;
  if (!ACTION_TOOLS.includes(tool)) return { ok: false, problems: [`action.tool must be one of ${ACTION_TOOLS.join(", ")}`] };
  const { args, view, problems } = canonArgs(tool, raw, root, true);
  if (tool === "AskUserQuestion") return problems.length ? { ok: false, problems } : { ok: true, descriptor: { tool, target: "", args, view } };
  if (typeof raw.target !== "string" || raw.target.trim() === "") return { ok: false, problems: [`action.target is required for ${tool}`, ...problems] };
  if (raw.target.length > MAX_TARGET_CHARS) problems.push(`action.target must be at most ${MAX_TARGET_CHARS} characters`);
  if (problems.length) return { ok: false, problems };
  // A command and a pattern are bound exactly (whitespace inside quotes changes what they do); only the ends are trimmed.
  const target = PATH_TOOLS.has(tool) ? normalizePath(raw.target, root) : raw.target.trim();
  return { ok: true, descriptor: { tool, target, args, view } };
}

/** The descriptor of an observed Claude Code tool call, or null for a tool that is not a controllable action. */
export function observedDescriptor(name, input, root = null) {
  const tool = ALIASES[name] ?? name;
  if (!ACTION_TOOLS.includes(tool)) return null;
  const i = input && typeof input === "object" ? input : {};
  let target = "";
  if (tool === "Bash") target = String(i.command ?? "").trim();
  else if (tool === "Grep" || tool === "Glob") target = String(i.pattern ?? "").trim();
  else if (tool === "NotebookEdit") target = normalizePath(i.notebook_path ?? i.file_path ?? "", root);
  else if (PATH_TOOLS.has(tool)) target = normalizePath(i.file_path ?? i.path ?? "", root);
  else if (tool === "Agent") target = String(i.subagent_type ?? "general-purpose").trim();
  const { args, view } = canonArgs(tool, i, root, false);
  return { tool, target, args, view };
}

/** The canonical text the hash covers: tool, exact target and the sorted canonical arguments. */
export const descriptorKey = (d) => JSON.stringify([d.tool, d.target, Object.entries(d.args ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
/** Full SHA-256 of the canonical descriptor. */
export const actionHash = (d) => createHash("sha256").update(descriptorKey(d)).digest("hex");
/** The 12-hex form printed in plan items. */
export const shortHash = (hash) => String(hash).slice(0, 12);
export const sameAction = (a, b) => Boolean(a && b) && descriptorKey(a) === descriptorKey(b);

const clipText = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/**
 * The concrete call as a short phrase Jev can judge: tool, exact target and every bound argument (a payload as its size,
 * a hash prefix and a short head). Not sanitized here: the caller sanitizes the phrase before it is sent.
 */
export function describeAction(d, { target = 300 } = {}) {
  const parts = Object.entries(d.args ?? {}).map(([name, value]) => {
    const v = d.view?.[name];
    return v ? `${name} (${v.chars} chars, ${String(value).slice(0, 13)}): "${v.head}"` : `${name}=${clipText(typeof value === "string" ? value : String(value), 80)}`;
  });
  return `${d.tool}${d.target ? ` ${clipText(d.target, target)}` : ""}${parts.length ? ` with ${parts.join("; ")}` : ""}`;
}

/** What a receipt and the helper's state keep of an action: tool, a clipped target and the canonical arguments (hashes, no payload text). */
export const actionRecord = (d) => ({ tool: d.tool, target: clipText(d.target, 120), args: { ...(d.args ?? {}) } });

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

// ── Evidence a step depends on ──────────────────────────────────────────────

export const MAX_DEPENDENCIES = 10;
const MAX_FINGERPRINT_BYTES = 20_000_000;

/**
 * The repository paths an option's authorization depends on: the path its action works on (a file tool's target,
 * a Grep or Glob scope) and every precondition path. A Bash command, a pattern or an Agent call names no path of
 * its own, so such an option depends only on what its preconditions declare.
 */
export function dependencyPaths(option) {
  const paths = [];
  const a = option?.action;
  if (a && PATH_TOOLS.has(a.tool) && a.target) paths.push(a.target);
  if (a?.args?.path) paths.push(a.args.path);
  for (const p of option?.preconditions ?? []) paths.push(p.path);
  return [...new Set(paths)].slice(0, MAX_DEPENDENCIES);
}

/** {path: sha256 of the file | "absent" | "dir" | "link" | "big:<bytes>" | "outside" | "unreadable"} read from the work tree now. */
export function fingerprintPaths(root, paths) {
  const out = {};
  for (const path of paths) {
    const abs = root ? insideRoot(root, path) : null;
    if (!abs) {
      out[path] = "outside";
      continue;
    }
    let stat = null;
    try {
      stat = lstatSync(abs);
    } catch {
      stat = null;
    }
    if (!stat) out[path] = "absent";
    else if (stat.isSymbolicLink()) out[path] = "link";
    else if (stat.isDirectory()) out[path] = "dir";
    else if (!stat.isFile()) out[path] = "other";
    else if (stat.size > MAX_FINGERPRINT_BYTES) out[path] = `big:${stat.size}`;
    else {
      try {
        out[path] = createHash("sha256").update(readFileSync(abs)).digest("hex");
      } catch {
        out[path] = "unreadable";
      }
    }
  }
  return out;
}

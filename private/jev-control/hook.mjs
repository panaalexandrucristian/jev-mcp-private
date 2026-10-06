// Claude Code hook logic for jev-control: local and minimal. The hook sees the
// real session_id, so it is where the session is proven: when the user asks for
// the mode (the /jev:jev-control command or a natural-language request) it injects
// a per-session capability into that session's own context, and with the mode ON
// it re-injects the one-line reminder (at SessionStart after a compaction and at
// every prompt) together with that capability; the CLI accepts the capability as
// the session identity (state.mjs). A fresh session, a resume, a clear and the end
// of a session switch the mode OFF and rotate the capability: nothing carries over.
// A prompt that is not a mode request starts a new request (budget counters). The
// hook never runs Jev or tests and never blocks.
// Budget accounting is NOT done here: helper calls are counted at the client
// boundary, direct calls by reserve-before-call and transcript reconciliation.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitTopLevel } from "../jev-flow/state.mjs";
import { startRequest } from "./budget.mjs";
import { protocolRules } from "./rules.mjs";
import { cleanupControlRetention, controlSessionDir, ensureSessionCap, hasSessionId, isControlOn, loadControlState, removeSessionCap, sessionKey, withControlState } from "./state.mjs";

const COMMAND = /^\s*\/(?:jev:)?jev-control\b/i;
// The explicit natural-language requests of the skill description (English and Romanian), after lowercasing and removing diacritics.
const NATURAL = [
  /\blet jev control (?:this|the|my) session\b/,
  /\bjev decides everything\b/,
  /\brun this session under jev\b/,
  /\blasa jev sa controleze (?:aceasta |sesiunea )?sesiunea?\b/,
  /\bsesiune controlata de jev\b/,
  /\bjev sa ia toate deciziile\b/,
];
const plain = (text) => String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** True when the prompt explicitly asks for the mode: the command, or one of the documented phrases. */
export function asksForControl(prompt) {
  return COMMAND.test(prompt) || NATURAL.some((re) => re.test(plain(prompt)));
}

const capNote = (cap) => `Session capability: pass --session-cap ${cap} to every cli.mjs call, also in subagent prompts.`;

// The plugin root this hook runs from (R03 kept it for the exact fallback path; since R09 the skill is loaded by its own name, jev:jev-control-mode).
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one-line reminder of a prompt (at most 400 bytes with a real 49-character capability); the full rules are in activation() and at SessionStart. */
export function reminder(threshold, cap = null, gate = "on") {
  return `jev-control ON (T=${threshold}): every choice with 2+ real alternatives goes through the jev-control helper (private/jev-control/cli.mjs) and Jev; protocol: Skill jev:jev-control-mode. jev-flow directives are suppressed.${gate === "off" ? GATE_OFF_NOTE : ""}${cap ? ` ${capNote(cap)}` : ""}`;
}

// The reminder's note while the user has the completion gate off (rule (4) in its gate-off form).
const GATE_OFF_NOTE = " Gate OFF: real checks, no jev_gate.";

export const NATURAL_MARKER = "in natural language for this request.";

/** How to load the skill, in the order D46 gives: the Skill tool, the exact file, then the rules above and `help`; no step blocks anything. */
function loadLine(root) {
  return `Load Skill jev:jev-control-mode; else Read ${join(root, "skills", "jev-control-mode", "SKILL.md")}; if refused, say so once.`;
}

/** The activation text of a mode request (at most 1500 bytes with a 120-byte plugin root and a real capability): the rules themselves, not a pointer. */
export function activation(cap, natural = false, root = PLUGIN_ROOT) {
  const first = natural ? ` Do first: node "${join(root, "private", "jev-control", "cli.mjs")}" on --session-cap ${cap} --priorities "<one line>".` : "";
  // Only the natural-language line carries the marker that step 3 of commands/jev-control.md tests; a slash command never does.
  return `jev-control was requested by the user ${natural ? NATURAL_MARKER : "for this session."}${first} ${protocolRules()} ${loadLine(root)} ${capNote(cap)}`;
}

/** SessionStart after a compaction with the mode ON: the rules again (they may have been compacted away), the way to the skill and the capability. */
export function resumeText(threshold, cap, root = PLUGIN_ROOT, gate = "on") {
  return `jev-control ON (T=${threshold}). ${protocolRules(gate)} ${loadLine(root)} ${capNote(cap)}`;
}

function repoFor(input) {
  const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  return gitTopLevel(cwd);
}

/** True when jev-control is ON for this session in `repoRoot` (jev-flow then stands down). Never throws. */
export function controlActive(repoRoot, sessionId, env = process.env) {
  try {
    return Boolean(repoRoot) && isControlOn(controlSessionDir(repoRoot, sessionId, env));
  } catch {
    return false;
  }
}

function additionalContext(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** Mode OFF and the capability gone: a new, resumed or ended session starts with nothing active. */
function resetSession(dir, now) {
  if (existsSync(join(dir, "state.json")) && isControlOn(dir)) withControlState(dir, (s) => { s.mode = "off"; }, now);
  removeSessionCap(dir);
}

/** Handle one hook event. Returns the JSON output to print or null; never throws for a missing repo or identity. */
export function handleControlHook(event, input, env = process.env, now = Date.now()) {
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "SessionEnd") return null;
  const repoRoot = repoFor(input);
  if (!repoRoot || !hasSessionId(input?.session_id)) return null;
  const dir = controlSessionDir(repoRoot, input.session_id, env);
  const key = sessionKey(input.session_id);
  if (event === "SessionEnd") {
    resetSession(dir, now);
    return null;
  }
  if (event === "SessionStart") {
    cleanupControlRetention(env, now);
    // Only a compaction continues the same live session; startup, resume, clear and anything unknown start OFF.
    if (input.source !== "compact") resetSession(dir, now);
    const state = loadControlState(dir);
    return state.mode === "on" ? additionalContext("SessionStart", resumeText(state.threshold.value, ensureSessionCap(dir, key), PLUGIN_ROOT, state.gate)) : null;
  }
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const state = loadControlState(dir);
  if (COMMAND.test(prompt)) {
    // A mode command is not a new request: the budget keeps counting.
    return additionalContext("UserPromptSubmit", state.mode === "on" ? reminder(state.threshold.value, ensureSessionCap(dir, key), state.gate) : activation(ensureSessionCap(dir, key)));
  }
  if (state.mode !== "on") return asksForControl(prompt) ? additionalContext("UserPromptSubmit", activation(ensureSessionCap(dir, key), true)) : null;
  withControlState(dir, (s) => startRequest(s, now), now);
  return additionalContext("UserPromptSubmit", reminder(state.threshold.value, ensureSessionCap(dir, key), state.gate));
}

/** Combine two hook outputs (control reminder and the flow's output) into one. */
export function mergeOutputs(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const merged = { ...b, ...a };
  const texts = [a.hookSpecificOutput?.additionalContext, b.hookSpecificOutput?.additionalContext].filter(Boolean);
  if (texts.length) merged.hookSpecificOutput = { ...(b.hookSpecificOutput ?? {}), ...(a.hookSpecificOutput ?? {}), additionalContext: texts.join("\n") };
  const messages = [a.systemMessage, b.systemMessage].filter(Boolean);
  if (messages.length) merged.systemMessage = messages.join("\n");
  return merged;
}

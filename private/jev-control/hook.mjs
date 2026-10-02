// Claude Code hook logic for jev-control: local and minimal. With the mode ON it
// re-injects a one-line reminder (at SessionStart, which also fires after a
// compaction, and at every prompt); it binds the session of a `/jev:jev-control`
// prompt so the CLI can know it; it starts a new request (budget counters) at an
// ordinary prompt. It never runs Jev or tests and never blocks. jev-flow's
// directives, hints and Stop redirects are suppressed while the mode is ON (the
// jev-flow data guard stays); the adapter and private/jev-flow/hook.mjs use
// controlActive() for that. Budget accounting is NOT done here: helper calls are
// counted at the client boundary, direct calls by reserve-before-call and
// transcript reconciliation (measure.mjs).
import { gitTopLevel } from "../jev-flow/state.mjs";
import { startRequest } from "./budget.mjs";
import { cleanupControlRetention, controlSessionDir, hasSessionId, isControlOn, loadControlState, withControlState, writeBinding } from "./state.mjs";

const COMMAND = /^\s*\/(?:jev:)?jev-control\b/i;

export function reminder(threshold) {
  return `jev-control ON (T=${threshold}): every choice with 2+ real alternatives goes through the jev-control helper (private/jev-control/cli.mjs) and Jev; see the jev-control skill. jev-flow directives are suppressed.`;
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

/** Handle one hook event. Returns the JSON output to print or null; never throws for a missing repo or identity. */
export function handleControlHook(event, input, env = process.env, now = Date.now()) {
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return null;
  const repoRoot = repoFor(input);
  if (!repoRoot || !hasSessionId(input?.session_id)) return null;
  const dir = controlSessionDir(repoRoot, input.session_id, env);
  if (event === "SessionStart") {
    cleanupControlRetention(env, now);
    // A fresh startup is a new session: nothing carries over. Resume and compaction keep the mode.
    const state = loadControlState(dir);
    if (input.source === "startup" && state.mode === "on") withControlState(dir, (s) => { s.mode = "off"; }, now);
    const after = loadControlState(dir);
    return after.mode === "on" ? additionalContext("SessionStart", reminder(after.threshold.value)) : null;
  }
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (COMMAND.test(prompt)) {
    writeBinding(repoRoot, input.session_id, env, now);
    return null;
  }
  const state = loadControlState(dir);
  if (state.mode !== "on") return null;
  withControlState(dir, (s) => startRequest(s, now), now);
  return additionalContext("UserPromptSubmit", reminder(state.threshold.value));
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

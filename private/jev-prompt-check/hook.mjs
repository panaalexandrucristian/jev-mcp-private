// prompt-check hook logic: SessionStart/SessionEnd reset the state, UserPromptSubmit runs the checks.
// Never blocks, never adds context for a tip, never changes the prompt.
import { gitTopLevel } from "../jev-flow/state.mjs";
import { ensureSessionCap, hasSessionId, sessionKey } from "../jev-control/state.mjs";
import { MIN_PROMPT_CHARS, runChecks } from "./check.mjs";
import { loadState, promptCheckDir, resetState, STATE_FILE, withState } from "./state.mjs";
import { lastAssistantText } from "./transcript.mjs";

const COMMAND = /^\s*\/(?:jev:)?prompt-check\b/i;
const CAP_NOTE = (cap) =>
  `Session capability: pass --session-cap ${cap} to every private/jev-prompt-check/cli.mjs call for /jev:prompt-check.`;

/**
 * Returns {output, ran}: `output` is the hook JSON (or null), `ran` is true when a Jev
 * session may have been started (the adapter then exits right after printing).
 */
export async function handlePromptCheckHook(event, input, env = process.env, deps = {}) {
  const none = { output: null, ran: false };
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "SessionEnd") return none;
  if (!hasSessionId(input?.session_id)) return none;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = gitTopLevel(cwd);
  if (!repoRoot) return none;
  const dir = promptCheckDir(repoRoot, input.session_id, env);
  if (event === "SessionEnd") {
    resetState(dir);
    return none;
  }
  if (event === "SessionStart") {
    // Only a compaction continues the same live session; startup, resume, clear and anything unknown start off.
    if (input.source !== "compact") resetState(dir);
    return none;
  }
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (COMMAND.test(prompt)) {
    // Identity handoff for the command: the hook sees the real session_id.
    const cap = ensureSessionCap(dir, sessionKey(input.session_id));
    return { output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: CAP_NOTE(cap) } }, ran: false };
  }
  // 1. Mode off: exit at once, nothing else.
  const state = loadState(dir);
  if (state.mode !== "on") return none;
  // One 4 s budget from here: state, transcript, connection and both checks all count against it.
  const startedAt = Date.now();
  // 2. The first prompt of the session, then a prompt with no previous assistant text.
  withState(dir, (s) => {
    s.seen += 1;
  });
  if (state.seen === 0) return none;
  const assistant = (deps.lastAssistantText ?? lastAssistantText)(input.transcript_path);
  if (typeof assistant !== "string" || assistant.trim() === "") return none;
  // 3. Shorter than 8 characters as received, or a slash command (leading whitespace allowed).
  if (prompt.length < MIN_PROMPT_CHARS || prompt.trimStart().startsWith("/")) return none;
  // 4-6. The two checks.
  const result = await (deps.runChecks ?? runChecks)({ assistant, prompt, threshold: state.threshold, lang: state.lang, env, open: deps.open, startedAt });
  if (result.reason) process.stderr.write(`[prompt-check] skipped: ${result.reason}\n`);
  if (result.dispatched || result.tips.length) {
    try {
      withState(dir, (s) => {
        if (result.dispatched) s.checked += 1;
        s.tips += result.tips.length;
      });
    } catch {
      // Counters are best effort.
    }
  }
  return { output: result.tips.length ? { systemMessage: result.tips.join("\n") } : null, ran: true };
}

export { STATE_FILE };

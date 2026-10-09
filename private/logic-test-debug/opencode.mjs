// logic-test-debug, OpenCode adapter: registers the skill beside the existing jev skill and delivers the
// directive on code prompts through ctx.session.hook("prompt") and ctx.session.hook("context"). Every capability is
// feature-detected and guarded on its own; a failure disables only that capability, emits one fixed diagnostic
// (never raw errors, prompt text or file contents) and never touches the jev MCP server, the jev skill or the flow.
//
// NOT verified on OpenCode 2.0.12: the shape of the prompt hook payload (only input.sessionID is established by the
// jev-flow adapter), that two plugin modules can register context hooks side by side, that a model can load a
// plugin-registered skill, and the runtime delivery of the directive. Feature detection is not runtime proof.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classifyCodePrompt, logicEnabled, LOGIC_DIRECTIVE, MAX_PROMPT_BYTES } from "./check.mjs";

const SKILL_ID = "logic-test-debug";
const SKILL_URL = new URL("../../skills/logic-test-debug/SKILL.md", import.meta.url);
export const MAX_PENDING = 256;

export const DIAGNOSTICS = {
  registration: "[logic-test-debug] skill registration unavailable",
  hooks: "[logic-test-debug] activation hooks unavailable",
  payload: "[logic-test-debug] prompt payload unavailable",
  delivery: "[logic-test-debug] context delivery unavailable",
  collision: "[logic-test-debug] existing skill with this id preserved; directive delivery disabled",
};

function has(ctx, path) {
  let value = ctx;
  for (const key of path.split(".")) {
    if (value == null) return false;
    value = value[key];
  }
  return typeof value === "function";
}

/** Minimal frontmatter parser: top-level `key: value` lines; returns {name, description, body}. */
export function parseSkill(source) {
  const match = String(source).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error("frontmatter");
  const field = (name) => {
    const line = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    if (!line) throw new Error(name);
    return line[1].trim();
  };
  return { name: field("name"), description: field("description"), body: source.slice(match[0].length) };
}

/**
 * Proposed text-extraction contract (INFERENCE, not a verified OpenCode schema): a string input.prompt, else a
 * string input.text, else the text entries of input.parts. The aggregate size is bounded before concatenation;
 * non-text parts are ignored; history, tool messages and arbitrary objects are never scanned.
 */
export function extractPromptText(input) {
  if (typeof input?.prompt === "string") return input.prompt;
  if (typeof input?.text === "string") return input.text;
  if (!Array.isArray(input?.parts)) return null;
  const pieces = [];
  let size = 0;
  for (const part of input.parts) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    size += part.text.length;
    if (size > MAX_PROMPT_BYTES * 2) return "x".repeat(MAX_PROMPT_BYTES + 1);
    pieces.push(part.text);
  }
  return pieces.length ? pieces.join("\n") : null;
}

const validSession = (id) => (typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null);

/**
 * Set up logic-test-debug on an OpenCode plugin context. Never throws; returns {registered, degraded}.
 * `options.log` receives each fixed diagnostic at most once per capability per setup.
 */
export async function setupLogicTestDebug(ctx, env = process.env, options = {}) {
  const report = { registered: [], degraded: [] };
  // Capability notices go to console.info (like the plugin's "preserved" notices): an OpenCode without a hook is not a
  // failure, and the flow's own single console.warn per setup stays the only warning of a degraded context.
  const log = options.log ?? ((message) => console.info(message));
  const said = new Set();
  const diagnose = (key) => {
    if (said.has(key)) return;
    said.add(key);
    try {
      log(DIAGNOSTICS[key]);
    } catch {
      // A failing logger must not break the setup.
    }
  };
  const degrade = (capability, key) => {
    report.degraded.push(capability);
    diagnose(key);
  };
  try {
    if (!logicEnabled(env)) return report;

    let collision = false;
    // Skill registration.
    try {
      if (!has(ctx, "skill.transform")) throw new Error("skill.transform");
      const location = fileURLToPath(options.skillUrl ?? SKILL_URL);
      const skill = parseSkill(await readFile(location, "utf8"));
      if (skill.name !== SKILL_ID) throw new Error("name");
      await ctx.skill.transform((editor) => {
        const existing = editor.get(SKILL_ID);
        if (existing) {
          if (existing.path !== location && existing.location !== location) collision = true;
          return;
        }
        editor.add({ id: SKILL_ID, name: skill.name, description: skill.description, location, path: location, content: skill.body });
      });
      if (collision) degrade("skill", "collision");
      else report.registered.push("skill");
    } catch {
      degrade("skill", "registration");
    }

    // No directive may tell the model to load a skill whose registration failed or whose id belongs to someone else.
    if (!report.registered.includes("skill")) return report;

    // Directive delivery: context first, then the prompt producer. Without context there is no producer.
    if (!has(ctx, "session.hook")) {
      degrade("hooks", "hooks");
      return report;
    }
    const pending = new Map();
    const remember = (sessionID) => {
      pending.delete(sessionID);
      pending.set(sessionID, true);
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    };
    let contextOk = false;
    try {
      await ctx.session.hook("context", (input) => {
        try {
          // The flow's read-only locator subagent gets no directive; the pending entry waits for the main agent.
          if (input?.agent === "jev-locator") return;
          const sessionID = validSession(input?.sessionID);
          if (!sessionID || !pending.has(sessionID)) return;
          if (!logicEnabled(env)) {
            pending.delete(sessionID);
            return;
          }
          if (!Array.isArray(input?.system)) {
            pending.delete(sessionID);
            diagnose("delivery");
            return;
          }
          input.system.push({ type: "text", text: LOGIC_DIRECTIVE });
          pending.delete(sessionID);
        } catch {
          pending.clear();
          diagnose("delivery");
        }
      });
      contextOk = true;
      report.registered.push("hook:context");
    } catch {
      degrade("hook:context", "hooks");
    }
    if (!contextOk) return report;
    try {
      await ctx.session.hook("prompt", (input) => {
        try {
          const sessionID = validSession(input?.sessionID);
          if (!sessionID) {
            diagnose("payload");
            return;
          }
          pending.delete(sessionID);
          if (!logicEnabled(env)) return;
          const text = extractPromptText(input);
          if (text === null) {
            diagnose("payload");
            return;
          }
          if (classifyCodePrompt(text).activate) remember(sessionID);
        } catch {
          diagnose("payload");
        }
      });
      report.registered.push("hook:prompt");
    } catch {
      degrade("hook:prompt", "hooks");
    }
  } catch {
    report.degraded.push("setup");
  }
  return report;
}

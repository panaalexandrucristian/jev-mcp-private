// OpenCode V2 adapter for jev-flow. Every ctx.* capability is feature-detected;
// a missing or failing capability disables only its own feature and is
// reported in a single diagnostic. The V2 API shapes follow the design (OpenCode 2.0.12) and the
// local @opencode/plugin 2.0.18 type declarations; they are not verified at
// runtime here.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDenylist } from "./paths.mjs";
import {
  classifyShellCommand,
  EXPLORATION_HINT_THRESHOLD,
  FIXED_PHRASES,
  jevToolName,
  parseJevResult,
  REREAD_HINT_THRESHOLD,
  validateGateResult,
} from "./policy.mjs";
import { payloadCredentialKinds } from "./sanitize.mjs";
import { computeSnapshot, gitTopLevel, inputHash, sha256 } from "./state.mjs";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const NAMES = Object.freeze({
  skill: "jev-flow",
  agent: "jev-locator",
  locate: "jev-locate",
  done: "jev-done",
});

export class JevFlowPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "JevFlowPolicyError";
  }
}

const EXPLORATION_TOOLS = new Set(["read", "grep", "glob", "list", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);
const SHELL_TOOLS = new Set(["bash", "shell"]);

/** Minimal frontmatter parser: top-level `key: value` lines, quotes stripped. */
export function parseFrontmatter(source, location) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`[jev-flow] Missing YAML frontmatter in ${location}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { fields, body: source.slice(match[0].length) };
}

/** Replace the Claude plugin-root placeholder with this checkout's path. */
export function withPluginRoot(text, root = PLUGIN_ROOT) {
  return text.split("${CLAUDE_PLUGIN_ROOT}").join(root);
}

function loadAssets(root) {
  const read = (rel) => {
    const location = join(root, rel);
    return { location, ...parseFrontmatter(readFileSync(location, "utf8"), location) };
  };
  return {
    skill: read("skills/jev-flow/SKILL.md"),
    agent: read("agents/jev-locator.md"),
    locate: read("commands/jev-locate.md"),
    done: read("commands/jev-done.md"),
  };
}

function has(ctx, path) {
  let value = ctx;
  for (const key of path.split(".")) {
    if (value == null) return false;
    value = value[key];
  }
  return typeof value === "function";
}

/** Limitations of this adapter that tests cannot lift; also returned in the setup report. */
export const LIMITATIONS = Object.freeze([
  "OpenCode V2 runtime behavior (registration, hooks, session.prompt, throw-to-block) is not verified on 2.0.12.",
  "Locator permissions are not set: V2 permission action names are unverified.",
  "Strict /jev-done only instructs the agent with the gate status; nothing technically blocks a completion message in OpenCode.",
]);

function repoRelative(repoRoot, filePath) {
  if (!repoRoot || typeof filePath !== "string" || filePath === "") return null;
  let abs = isAbsolute(filePath) ? filePath : join(repoRoot, filePath);
  let root = repoRoot;
  try {
    abs = realpathSync(abs);
    root = realpathSync(repoRoot);
  } catch {
    return null;
  }
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Set up jev-flow on an OpenCode plugin context. Returns a report of what was
 * registered, what degraded and which names collided; never throws. At most
 * one diagnostic line is logged per setup, whether the problem shows up at
 * setup or later at runtime; later problems are appended to the report.
 * Gate verdicts live only in this process's memory: nothing semantic is
 * persisted, so a restart always starts with an unknown gate.
 */
export async function setupFlow(ctx, options = {}) {
  const env = options.env ?? process.env;
  const root = options.pluginRoot ?? PLUGIN_ROOT;
  const log = options.log ?? ((message) => console.warn(message));
  const report = { registered: [], degraded: [], collisions: [], runtime: [], registrations: [], limitations: [...LIMITATIONS] };
  let diagnosed = false;
  const diagnose = (message) => {
    if (diagnosed) return;
    diagnosed = true;
    log(`[jev-flow] ${message}`);
  };
  const degrade = (capability, reason) => report.degraded.push({ capability, reason: String(reason) });
  const runtimeProblem = (key, message) => {
    if (report.runtime.some((r) => r.key === key)) return;
    report.runtime.push({ key, message });
    diagnose(message);
  };

  let assets;
  try {
    assets = loadAssets(root);
  } catch (error) {
    degrade("assets", error?.message ?? error);
    diagnose(`disabled: ${report.degraded.map((d) => `${d.capability} (${d.reason})`).join("; ")}`);
    return report;
  }

  const directory = ctx?.location?.directory ?? ctx?.location?.path ?? process.cwd();
  const repoRoot = gitTopLevel(String(directory));
  const sessions = new Map();
  const sessionState = (id) => {
    const key = String(id ?? "unknown");
    if (!sessions.has(key)) {
      sessions.set(key, { req: 0, exploration: 0, hinted: false, finishHinted: false, pendingHint: null, reads: new Map(), gates: [], pending: new Map() });
    }
    return sessions.get(key);
  };

  /**
   * In-memory gate status for the current request and snapshot. The latest
   * gate attempt by start time decides, including unfinished and failed ones;
   * its request is the one current when the call started.
   */
  const gateStatus = (sessionID) => {
    if (!repoRoot) return { accepted: false, reason: "no git work tree" };
    const state = sessionState(sessionID);
    const snapshot = computeSnapshot(repoRoot).hash;
    if (!snapshot) return { accepted: false, reason: "snapshot unknown" };
    const attempts = [...state.gates, ...[...state.pending.values()].map((p) => ({ ...p, unfinished: true }))].sort((a, b) => a.ts - b.ts);
    const latest = attempts[attempts.length - 1];
    if (!latest) return { accepted: false, reason: "no jev_gate in this request" };
    if (latest.unfinished) return { accepted: false, reason: "the last jev_gate call has not finished" };
    if (latest.denied) return { accepted: false, reason: "the last jev_gate call was refused by the jev-flow policy" };
    if (latest.failed) return { accepted: false, reason: "the last jev_gate call failed" };
    if (latest.req !== state.req) return { accepted: false, reason: "the last jev_gate belongs to another request" };
    if (!latest.before || latest.before !== latest.after) return { accepted: false, reason: "the snapshot changed or was unknown during the last jev_gate" };
    if (latest.after !== snapshot) return { accepted: false, reason: "the code changed after the last jev_gate" };
    if (!latest.accepted) return { accepted: false, reason: "the last jev_gate was not an accepted, complete result" };
    return { accepted: true, reason: "an accepted jev_gate exists for the current snapshot and request" };
  };

  // ── Skill ────────────────────────────────────────────────────────────────
  if (has(ctx, "skill.transform")) {
    try {
      report.registrations.push(
        await ctx.skill.transform((editor) => {
          if (typeof editor?.get !== "function" || typeof editor?.add !== "function") {
            degrade("skill.editor", "editor.get/add missing");
            return;
          }
          if (editor.get(NAMES.skill)) {
            report.collisions.push(`skill:${NAMES.skill}`);
            return;
          }
          editor.add({
            id: NAMES.skill,
            name: assets.skill.fields.name || NAMES.skill,
            description: assets.skill.fields.description,
            location: assets.skill.location,
            path: assets.skill.location,
            content: withPluginRoot(assets.skill.body, root),
          });
          report.registered.push(`skill:${NAMES.skill}`);
        }),
      );
    } catch (error) {
      degrade("skill.transform", error?.message ?? error);
    }
  } else degrade("skill.transform", "not available");

  // ── Agent ────────────────────────────────────────────────────────────────
  if (has(ctx, "agent.transform")) {
    try {
      report.registrations.push(
        await ctx.agent.transform((editor) => {
          if (typeof editor?.get !== "function" || typeof editor?.update !== "function") {
            degrade("agent.editor", "editor.get/update missing");
            return;
          }
          if (editor.get(NAMES.agent)) {
            report.collisions.push(`agent:${NAMES.agent}`);
            return;
          }
          editor.update(NAMES.agent, (agent) => {
            agent.mode = "subagent";
            agent.description = assets.agent.fields.description;
            agent.system = withPluginRoot(assets.agent.body, root);
            agent.hidden = false;
            // Permissions are not set: V2 permission action names are not verified locally.
          });
          report.registered.push(`agent:${NAMES.agent}`);
        }),
      );
    } catch (error) {
      degrade("agent.transform", error?.message ?? error);
    }
  } else degrade("agent.transform", "not available");

  // ── Commands ─────────────────────────────────────────────────────────────
  const commandText = (asset, invocation) =>
    withPluginRoot(asset.body, root).split("$ARGUMENTS").join(String(invocation?.prompt?.text ?? "").trim());

  const doneText = (invocation) => {
    let text = commandText(assets.done, invocation);
    if (env.JEV_FLOW_STRICT === "1") {
      const status = gateStatus(invocation.sessionID);
      // This is an instruction to the agent, not an enforcement point: OpenCode
      // offers no hook that can refuse a completion message.
      text +=
        `\n\nStrict mode (JEV_FLOW_STRICT=1). Gate status from the jev-flow plugin: ${status.reason}. ` +
        "Do not report completion unless jev_gate returned an accepted result on the current snapshot in this request; " +
        `otherwise end with a line starting with "Incomplete:", report "${FIXED_PHRASES.unavailable}" or "${FIXED_PHRASES.disabled}" when applicable, or ask the user.`;
    }
    return text;
  };

  const registerCommands = async () => {
    if (!has(ctx, "command.transform")) return degrade("command.transform", "not available");
    if (!has(ctx, "session.prompt")) return degrade("command.transform", "ctx.session.prompt not available; commands not registered");
    if (!has(ctx, "command.list")) return degrade("command.transform", "ctx.command.list not available; cannot check name collisions, commands not registered");
    let existing;
    try {
      const listed = await ctx.command.list();
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : null;
      if (!items) throw new Error("unrecognized command.list result");
      existing = items.map((c) => c?.name ?? c?.id).filter(Boolean);
    } catch (error) {
      return degrade("command.transform", `command.list failed (${error?.message ?? error}); cannot check name collisions, commands not registered`);
    }
    try {
      report.registrations.push(
        await ctx.command.transform((editor) => {
          if (typeof editor?.add !== "function") {
            degrade("command.editor", "editor.add missing");
            return;
          }
          const defs = [
            { name: NAMES.locate, asset: assets.locate, text: (inv) => commandText(assets.locate, inv) },
            { name: NAMES.done, asset: assets.done, text: doneText },
          ];
          for (const def of defs) {
            if (existing.includes(def.name)) {
              report.collisions.push(`command:${def.name}`);
              continue;
            }
            editor.add({
              name: def.name,
              description: def.asset.fields.description,
              execute: async (invocation) => {
                try {
                  await ctx.session.prompt({ sessionID: invocation.sessionID, text: def.text(invocation), delivery: invocation.delivery });
                } catch (error) {
                  runtimeProblem(`command.${def.name}`, `/${def.name} failed: ${error?.message ?? error}`);
                }
              },
            });
            report.registered.push(`command:${def.name}`);
          }
        }),
      );
    } catch (error) {
      degrade("command.transform", error?.message ?? error);
    }
  };
  await registerCommands();

  // ── Tool hooks ───────────────────────────────────────────────────────────
  const queueHint = (state, text) => {
    state.pendingHint ??= text;
  };
  if (has(ctx, "tool.hook")) {
    try {
      report.registrations.push(
        await ctx.tool.hook("execute.before", (input) => {
          const jev = jevToolName(input?.tool);
          if (!jev || !repoRoot) return;
          // Policy refusals are thrown deliberately and are not swallowed. A
          // refused gate is recorded first as a failed attempt, so it supersedes
          // an earlier accepted gate without relying on execute.after.
          const refuse = (message) => {
            if (jev === "gate") {
              try {
                const state = sessionState(input.sessionID);
                state.gates.push({ req: state.req, ts: Date.now(), failed: true, denied: true, before: null, after: null, accepted: false });
              } catch (error) {
                runtimeProblem("execute.before", `execute.before bookkeeping failed: ${error?.message ?? error}`);
              }
            }
            throw new JevFlowPolicyError(message);
          };
          if (loadDenylist(repoRoot).disabled) {
            refuse(`.jev-flow-denylist disables Jev for this repository. Continue with local checks and report "${FIXED_PHRASES.disabled}".`);
          }
          const kinds = payloadCredentialKinds(input?.input);
          if (kinds.length > 0) {
            refuse(`The ${input.tool} payload contains an unredacted credential (${kinds.join(", ")}). Sanitize it with scripts/jev-candidates.mjs --sanitize or remove it.`);
          }
          if (jev === "gate" && input?.id) {
            try {
              const state = sessionState(input.sessionID);
              const claims = Array.isArray(input.input?.claims) ? [...input.input.claims] : null;
              state.pending.set(String(input.id), { before: computeSnapshot(repoRoot).hash, input: inputHash(input.input), claims, req: state.req, ts: Date.now() });
            } catch (error) {
              runtimeProblem("execute.before", `execute.before bookkeeping failed: ${error?.message ?? error}`);
            }
          }
        }),
      );
      report.registered.push("hook:tool.execute.before");
    } catch (error) {
      degrade("tool.hook(execute.before)", error?.message ?? error);
    }
    try {
      report.registrations.push(
        await ctx.tool.hook("execute.after", (input) => {
          try {
            const tool = String(input?.tool ?? "");
            const jev = jevToolName(tool);
            const state = sessionState(input?.sessionID);
            if (jev === "gate") {
              const pending = input?.id ? state.pending.get(String(input.id)) : undefined;
              if (input?.id) state.pending.delete(String(input.id));
              const sameCall = pending && pending.input === inputHash(input?.input);
              // Request and start time come from execute.before; without them the attempt cannot count.
              const base = { req: sameCall ? pending.req : null, ts: pending?.ts ?? Date.now() };
              if (input?.status !== "completed") {
                state.gates.push({ ...base, failed: true, before: null, after: null, accepted: false });
                return;
              }
              const after = repoRoot ? computeSnapshot(repoRoot).hash : null;
              const claims = sameCall ? pending.claims : null;
              const accepted = validateGateResult(parseJevResult(input.result), { claims }).accepted;
              state.gates.push({ ...base, failed: false, before: sameCall ? pending.before : null, after, accepted });
              return;
            }
            if (input?.agent === NAMES.agent) return;
            const lower = tool.toLowerCase();
            let kind = null;
            if (EXPLORATION_TOOLS.has(lower)) kind = "exploration";
            else if (EDIT_TOOLS.has(lower)) kind = input?.status === "error" ? null : "edit";
            else if (SHELL_TOOLS.has(lower)) {
              const cls = classifyShellCommand(input?.input?.command);
              kind = cls === "exploration" ? "exploration" : cls === "mutation" ? "edit" : null;
            }
            if (kind === "exploration") {
              state.exploration += 1;
              if (lower === "read" && repoRoot) {
                const rel = repoRelative(repoRoot, input?.input?.filePath ?? input?.input?.path);
                if (rel) {
                  let hash = null;
                  try {
                    hash = sha256(readFileSync(join(repoRoot, rel)));
                  } catch {
                    hash = null;
                  }
                  const offset = Number.isInteger(input?.input?.offset) ? input.input.offset : 1;
                  const limit = Number.isInteger(input?.input?.limit) ? input.input.limit : "end";
                  const key = `${rel}#${offset}-${limit}`;
                  const entry = state.reads.get(key);
                  if (hash && entry && entry.hash === hash) entry.count += 1;
                  else state.reads.set(key, { hash, count: 1 });
                  if (!state.hinted && hash && state.reads.get(key).count - 1 >= REREAD_HINT_THRESHOLD) {
                    state.hinted = true;
                    queueHint(state, `jev-flow: the same file range with the same content has been re-read twice in this request. Delegate the open question to jev-locator (/${NAMES.locate}) instead of re-reading.`);
                  }
                }
              }
              if (!state.hinted && state.exploration >= EXPLORATION_HINT_THRESHOLD) {
                state.hinted = true;
                queueHint(state, `jev-flow: ${state.exploration} exploration calls in this request. For broad discovery, delegate to the jev-locator subagent (/${NAMES.locate} <question>) and read only the ranges it returns.`);
              }
            }
            if (kind === "edit" && !state.finishHinted) {
              state.finishHinted = true;
              queueHint(state, `jev-flow: code changed. Before reporting completion, run the repository's real checks on the final snapshot and finish with /${NAMES.done} (jev_gate on the final diff).`);
            }
          } catch (error) {
            runtimeProblem("execute.after", `execute.after handler failed: ${error?.message ?? error}`);
          }
        }),
      );
      report.registered.push("hook:tool.execute.after");
    } catch (error) {
      degrade("tool.hook(execute.after)", error?.message ?? error);
    }
  } else degrade("tool.hook", "not available");

  // ── Session hooks ────────────────────────────────────────────────────────
  if (has(ctx, "session.hook")) {
    try {
      report.registrations.push(
        await ctx.session.hook("prompt", (input) => {
          const state = sessionState(input?.sessionID);
          state.req += 1;
          state.exploration = 0;
          state.hinted = false;
          state.finishHinted = false;
          state.pendingHint = null;
          state.reads.clear();
        }),
      );
      report.registered.push("hook:session.prompt");
    } catch (error) {
      degrade("session.hook(prompt)", error?.message ?? error);
    }
    try {
      report.registrations.push(
        await ctx.session.hook("context", (input) => {
          try {
            if (input?.agent === NAMES.agent) return;
            const state = sessionState(input?.sessionID);
            if (!state.pendingHint || !Array.isArray(input?.system)) return;
            input.system.push({ type: "text", text: state.pendingHint });
            state.pendingHint = null;
          } catch (error) {
            runtimeProblem("context", `context hook failed: ${error?.message ?? error}`);
          }
        }),
      );
      report.registered.push("hook:session.context");
    } catch (error) {
      degrade("session.hook(context)", error?.message ?? error);
    }
  } else degrade("session.hook", "not available");

  const notes = [];
  if (report.degraded.length) notes.push(`degraded: ${report.degraded.map((d) => `${d.capability} (${d.reason})`).join("; ")}`);
  if (report.collisions.length) notes.push(`existing entries preserved: ${report.collisions.join(", ")}`);
  if (notes.length) diagnose(notes.join(" | "));
  return report;
}

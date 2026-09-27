// OpenCode V2 adapter for jev-flow. Every ctx.* capability is feature-detected;
// a missing or failing capability disables only its own feature and is
// reported in a single diagnostic. The V2 API shapes follow the design (OpenCode 2.0.12) and the
// local @opencode/plugin 2.0.18 type declarations; they are not verified at
// runtime here.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { claimIdsOf, coversEarlierBatches, coversRunnerAttempts, diffHash, parseBatchLabel, selectGateAttempts, verifyBatchContents } from "./gate-batch.mjs";
import { extractLocatorHits, freshHits, grepCovers, HINT_RANGE_GREP, HINT_RANGE_READ, readExceedsHits, rememberHits } from "./locator-hits.mjs";
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
import { initRunnerSession, runnerCoverage, verifyReceipt } from "./runner-receipt.mjs";
import { payloadCredentialKinds } from "./sanitize.mjs";
import { computeSnapshot, gitTopLevel, inputHash, loadState, sessionDir, sessionKey, sha256, withState } from "./state.mjs";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NAMES_LOCATOR = "jev-locator";

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

/** Route directive sent at the start of every request (see hook.mjs HINTS.directive). */
export const DIRECTIVE =
  "jev-flow is the default route for code tasks in this repository (opt out: JEV_FLOW=off). For a non-trivial code task: load the jev-flow skill and follow its route. " +
  `When the files are not known, delegate broad discovery to the ${NAMES_LOCATOR} subagent (/jev-locate <question>) instead of searching in this thread, then read only the ranges it returns; an exact known path or symbol is used directly. ` +
  "After any code change, finish with /jev-done: the gate runner (scripts/jev-gate-run.mjs) runs the real checks and jev_gate itself on every part and returns one aggregated report; answer once from it, without re-running for a more favourable verdict.";

/** A shell command that runs the gate runner for a gate (not a hunk listing). */
export function isRunnerGateCommand(command) {
  const text = String(command ?? "");
  return /jev-gate-run\.mjs\b/.test(text) && !/--list-hunks\b/.test(text) && !/--help\b/.test(text);
}

/**
 * OpenCode model reference from JEV_FLOW_LOCATOR_MODEL ("provider/model" or
 * "provider/model#variant"), in the V2 Model.Ref shape {providerID, id,
 * variant?} (@opencode/schema model.ts Ref.parse). null when unset or invalid.
 */
export function locatorModelRef(value) {
  const raw = String(value ?? "").trim();
  const match = /^([^/\s#]+)\/([^\s#]+)(?:#([^\s#]+))?$/.exec(raw);
  if (!match) return null;
  return match[3] ? { providerID: match[1], id: match[2], variant: match[3] } : { providerID: match[1], id: match[2] };
}

/** The complete gate input and its claims, kept in this process's memory only. */
function sentInput(toolInput) {
  return { input: toolInput, claims: Array.isArray(toolInput?.claims) ? toolInput.claims.map(String) : null };
}

/** Batch manifest fields of a gate input, or {}. */
function labelFields(toolInput) {
  const label = parseBatchLabel(toolInput?.request);
  return label ? { batch: label.id, part: label.part, of: label.of } : {};
}

const flowOff = (env) => String(env?.JEV_FLOW ?? "").trim().toLowerCase() === "off";
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
  "The jev-locator model is applied through the V2 Agent.Info.model field (Model.Ref); that the runtime honours it on 2.0.12 is not verified.",
  "Gate-runner results are recognised from bash tool calls whose command runs scripts/jev-gate-run.mjs; the runner's receipt (of the whole batch) and session metadata (key, baseline, request number) live in the jev-flow cache, not in memory. The aggregated report reaches the agent as that bash call's output; the adapter does not re-evaluate it.",
  "jev-locator hits are read from the result of a subagent tool call whose input names jev-locator; the V2 subagent tool's result shape is not verified.",
]);

function realpathSafe(path) {
  try {
    return realpathSync(String(path));
  } catch {
    return null;
  }
}

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

  let locatorNote = null;
  const directory = ctx?.location?.directory ?? ctx?.location?.path ?? process.cwd();
  const repoRoot = gitTopLevel(String(directory));
  const sessions = new Map();
  const sid = (id) => String(id ?? "unknown");
  const metaDir = (id) => sessionDir(repoRoot, sid(id), env);
  const sessionState = (id) => {
    const key = sid(id);
    if (!sessions.has(key)) {
      sessions.set(key, { req: 0, exploration: 0, rereadHinted: false, finishHinted: false, pendingHints: [], reads: new Map(), gates: [], pending: new Map(), hits: [], initialized: false });
    }
    return sessions.get(key);
  };

  /**
   * In-memory gate status for the current request and snapshot, through the
   * attempt selection shared with the Claude hook (gate-batch.mjs): the latest
   * attempt by start time decides, including unfinished and failed ones; its
   * request is the one current when the call started. A partitioned batch
   * counts only when every part is accepted on this snapshot and the parts
   * form the complete batch of their manifest.
   */
  const REASONS = {
    no_gate: "no jev_gate in this request",
    latest_gate_unfinished: "the last jev_gate call has not finished",
    latest_gate_denied: "the last jev_gate call was refused by the jev-flow policy",
    latest_gate_failed: "the last jev_gate call failed",
    gate_from_other_request: "the last jev_gate belongs to another request",
    gate_snapshot_unknown: "the snapshot changed or was unknown during the last jev_gate",
    changed_during_gate: "the snapshot changed or was unknown during the last jev_gate",
    gate_on_older_snapshot: "the code changed after the last jev_gate",
  };
  const gateStatus = (sessionID) => {
    if (!repoRoot) return { accepted: false, reason: "no git work tree" };
    const state = sessionState(sessionID);
    const snapshot = computeSnapshot(repoRoot).hash;
    if (!snapshot) return { accepted: false, reason: "snapshot unknown" };
    const attempts = [...state.gates, ...[...state.pending.values()].map((p) => ({ ...p, pending: true }))];
    const selected = selectGateAttempts(attempts, { snapshot, requestSeq: state.req });
    if (selected.reason) {
      return { accepted: false, reason: REASONS[selected.reason] ?? `partitioned jev_gate batch not complete (${selected.reason})` };
    }
    // Earlier attempts a later gate must cover (F3): direct batches (inputs in memory) and gate-runner attempts (hashes).
    const dir = metaDir(sessionID);
    const runnersSuperseded = selected.supersededBatch.filter((a) => a.runner).map((a) => runnerCoverage(dir, a));
    const batchesSuperseded = selected.supersededBatch.filter((a) => !a.runner).map((a) => a.input ?? {});
    const covers = (later) => {
      const claimIds = later.claim_ids ?? claimIdsOf(later.claims);
      const laterDiff = later.diffHash ?? (typeof later.diff === "string" ? diffHash(later.diff) : null);
      if (!coversRunnerAttempts({ claim_ids: claimIds, diff: laterDiff }, runnersSuperseded)) return false;
      if (batchesSuperseded.length === 0) return true;
      if (Array.isArray(later.claims) && typeof later.diff === "string") return coversEarlierBatches(later, batchesSuperseded);
      const have = new Set(claimIds);
      return batchesSuperseded.every((e) => {
        const label = parseBatchLabel(e.request);
        return label && label.diff === laterDiff && claimIdsOf(e.claims).every((id) => have.has(id));
      });
    };
    if (selected.record?.runner) {
      // Gate runner: the signed receipt decides, bound to this session, the attempt's request and this snapshot.
      const check = verifyReceipt(dir, selected.record.runner, { session: sessionKey(sid(sessionID)), req: selected.record.req, snapshot });
      if (!check.accepted) return { accepted: false, reason: `the last gate-runner result does not count (${check.reason})` };
      if (!covers({ claim_ids: check.receipt.claim_ids, diffHash: check.receipt.diff })) {
        return { accepted: false, reason: "the gate-runner result does not cover every claim and the whole patch of the earlier partitioned batch it replaces, or of an earlier gate-runner attempt" };
      }
      return { accepted: true, reason: `the gate runner's signed receipt accepts all ${check.receipt.parts} part(s) for the current snapshot and request` };
    }
    if (selected.record) {
      if (!selected.record.accepted) return { accepted: false, reason: "the last jev_gate was not an accepted, complete result" };
      if (!covers({ claims: selected.record.claims, diff: selected.record.input?.diff })) {
        return { accepted: false, reason: "the last jev_gate does not cover every claim and the whole patch of the earlier partitioned batch it replaces, or of an earlier gate-runner attempt" };
      }
      return { accepted: true, reason: "an accepted jev_gate exists for the current snapshot and request" };
    }
    const { records } = selected.batch;
    if (records.some((r) => !r.accepted)) return { accepted: false, reason: "a part of the partitioned jev_gate batch was not an accepted, complete result" };
    const contents = verifyBatchContents(records.map((r) => r.input ?? {}), { snapshot });
    if (!contents.ok) return { accepted: false, reason: `the partitioned jev_gate batch is not complete (${contents.problems.join(", ")})` };
    if (!covers({ claims: contents.claims, diff: contents.whole })) {
      return { accepted: false, reason: "the partitioned jev_gate batch does not cover every claim and the whole patch of the earlier batch it replaces, or of an earlier gate-runner attempt" };
    }
    return {
      accepted: true,
      reason: `all ${records.length} parts of a partitioned jev_gate batch are accepted for the current snapshot and request; the patch was verified in parts, not by one global call`,
    };
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
          const model = locatorModelRef(env.JEV_FLOW_LOCATOR_MODEL);
          editor.update(NAMES.agent, (agent) => {
            agent.mode = "subagent";
            agent.description = assets.agent.fields.description;
            agent.system = withPluginRoot(assets.agent.body, root);
            agent.hidden = false;
            if (model) agent.model = model;
            // Permissions are not set: V2 permission action names are not verified locally.
          });
          report.registered.push(`agent:${NAMES.agent}`);
          report.locator_model = model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "inherit";
          if (!model) {
            const set = String(env.JEV_FLOW_LOCATOR_MODEL ?? "").trim() !== "";
            locatorNote = set
              ? `JEV_FLOW_LOCATOR_MODEL must be provider/model in OpenCode; jev-locator inherits the parent model`
              : "jev-locator inherits the parent model (set JEV_FLOW_LOCATOR_MODEL=provider/model for a cheaper one)";
            report.limitations.push(locatorNote);
          }
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
    // The runner needs this session's key to sign its receipt (Claude Code passes the session id in the environment).
    const key = sessionKey(sid(invocation?.sessionID));
    let text = commandText(assets.done, invocation).split('scripts/jev-gate-run.mjs"').join(`scripts/jev-gate-run.mjs" --session-key ${key}`);
    if (env.JEV_FLOW_STRICT === "1" && !flowOff(env)) {
      const status = gateStatus(invocation.sessionID);
      // This is an instruction to the agent, not an enforcement point: OpenCode
      // offers no hook that can refuse a completion message.
      text +=
        `\n\nStrict mode (JEV_FLOW_STRICT=1). Gate status from the jev-flow plugin: ${status.reason}. ` +
        "Do not report completion unless the gate runner (or jev_gate) returned an accepted result on the current snapshot in this request; " +
        "read the runner's aggregated report of every part and answer once, without re-running it for a more favourable verdict; " +
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
  const off = flowOff(env);
  const queueHint = (state, text) => {
    if (!off && !state.pendingHints.includes(text)) state.pendingHints.push(text);
  };
  if (has(ctx, "tool.hook")) {
    try {
      report.registrations.push(
        await ctx.tool.hook("execute.before", (input) => {
          if (repoRoot && input?.id && SHELL_TOOLS.has(String(input?.tool ?? "").toLowerCase()) && isRunnerGateCommand(input?.input?.command)) {
            // A gate-runner attempt starts now and supersedes earlier gates, even if it fails.
            try {
              const state = sessionState(input.sessionID);
              state.pending.set(String(input.id), { runner: true, before: computeSnapshot(repoRoot).hash, req: state.req, ts: Date.now() });
            } catch (error) {
              runtimeProblem("execute.before", `execute.before bookkeeping failed: ${error?.message ?? error}`);
            }
            return;
          }
          const jev = jevToolName(input?.tool);
          if (!jev || !repoRoot) return;
          // Policy refusals are thrown deliberately and are not swallowed. A
          // refused gate is recorded first as a failed attempt, so it supersedes
          // an earlier accepted gate without relying on execute.after.
          const refuse = (message) => {
            if (jev === "gate") {
              try {
                const state = sessionState(input.sessionID);
                state.gates.push({ req: state.req, ts: Date.now(), failed: true, denied: true, before: null, after: null, accepted: false, ...labelFields(input?.input), ...sentInput(input?.input) });
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
              state.pending.set(String(input.id), {
                before: computeSnapshot(repoRoot).hash,
                input: inputHash(input.input),
                claims,
                req: state.req,
                ts: Date.now(),
                ...labelFields(input.input),
              });
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
            const pendingRun = input?.id ? state.pending.get(String(input.id)) : undefined;
            if (pendingRun?.runner) {
              // The runner recorded its attempt and receipt id in the session metadata; the receipt is verified at status time.
              state.pending.delete(String(input.id));
              let rec = null;
              try {
                const meta = loadState(metaDir(input?.sessionID));
                // A finished attempt, or one left pending by an interrupted run.
                const all = [...meta.gates, ...Object.values(meta.pending ?? {}).filter((p) => p.runner)];
                rec = all.filter((g) => g.runner && g.ts >= pendingRun.ts).sort((a, b) => a.ts - b.ts).pop() ?? null;
              } catch {
                rec = null;
              }
              const after = repoRoot ? computeSnapshot(repoRoot).hash : null;
              // Coverage metadata (hashes) of a prepared batch stays with the attempt, even a failed one.
              const coverage = rec && typeof rec.diff === "string" ? { runner: rec.runner, diff: rec.diff, claim_ids: rec.claim_ids } : rec ? { runner: rec.runner } : {};
              const finished = rec && !rec.failed && rec.kind !== "gate";
              state.gates.push(finished
                ? { ...coverage, req: pendingRun.req, ts: pendingRun.ts, before: pendingRun.before, after, failed: false, accepted: false }
                : { ...coverage, req: pendingRun.req, ts: pendingRun.ts, before: pendingRun.before, after: null, failed: true, accepted: false });
              return;
            }
            if (jev === "gate") {
              const pending = input?.id ? state.pending.get(String(input.id)) : undefined;
              if (input?.id) state.pending.delete(String(input.id));
              const sameCall = pending && pending.input === inputHash(input?.input);
              // Request and start time come from execute.before; without them the attempt cannot count.
              const base = { req: sameCall ? pending.req : null, ts: pending?.ts ?? Date.now(), ...labelFields(input?.input) };
              if (input?.status !== "completed") {
                state.gates.push({ ...base, failed: true, before: null, after: null, accepted: false, ...sentInput(input?.input) });
                return;
              }
              const after = repoRoot ? computeSnapshot(repoRoot).hash : null;
              const claims = sameCall ? pending.claims : null;
              const accepted = validateGateResult(parseJevResult(input.result), { claims }).accepted;
              // Inputs stay in this process's memory only, for the batch check.
              const sent = sameCall ? { claims, input: input.input } : {};
              state.gates.push({ ...base, failed: false, before: sameCall ? pending.before : null, after, accepted, ...sent });
              return;
            }
            const lower = tool.toLowerCase();
            const subagent = input?.input?.subagent_type ?? input?.input?.subagent ?? input?.input?.agent;
            if ((lower === "task" || lower === "agent") && /^(?:jev:)?jev-locator$/.test(String(subagent ?? ""))) {
              const hits = extractLocatorHits(input?.result ?? input?.output)
                .map((h) => ({ ...h, path: repoRelative(repoRoot, h.path) ?? h.path }))
                .filter((h) => !h.path.startsWith("/") && !h.path.startsWith(".."));
              if (hits.length) state.hits = rememberHits(state.hits, hits, state.req);
              return;
            }
            if (input?.agent === NAMES.agent) return;
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
                  if (hash) {
                    // Range-only reading after a locator hit (R2): every time.
                    const { fresh, stale } = freshHits(state.hits, { path: rel, req: state.req, sha: hash });
                    if (stale.length) state.hits = state.hits.filter((h) => !stale.includes(h));
                    let lineCount = null;
                    try {
                      const text = readFileSync(join(repoRoot, rel), "utf8");
                      lineCount = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
                    } catch {
                      lineCount = null;
                    }
                    const end = limit === "end" ? "end" : offset + limit - 1;
                    if (readExceedsHits(fresh, { start: offset, end, lineCount })) queueHint(state, HINT_RANGE_READ(rel, fresh));
                  }
                  const key = `${rel}#${offset}-${limit}`;
                  const entry = state.reads.get(key);
                  if (hash && entry && entry.hash === hash) entry.count += 1;
                  else state.reads.set(key, { hash, count: 1 });
                  if (!state.rereadHinted && hash && state.reads.get(key).count - 1 >= REREAD_HINT_THRESHOLD) {
                    state.rereadHinted = true;
                    queueHint(state, `jev-flow: the same file range with the same content has been re-read twice in this request. Delegate the open question to jev-locator (/${NAMES.locate}) instead of re-reading.`);
                  }
                }
              }
              if (lower === "grep" && repoRoot && state.hits.length) {
                // The search scope: its path, or the session directory (the repository root by default) without one.
                const scope = typeof input?.input?.path === "string" && input.input.path !== "" ? input.input.path : directory;
                const target = repoRelative(repoRoot, scope) ?? (realpathSafe(scope) === realpathSafe(repoRoot) ? "" : null);
                for (const path of [...new Set(state.hits.filter((h) => h.req === state.req).map((h) => h.path))]) {
                  if (!grepCovers(path, { target, glob: input?.input?.include ?? input?.input?.glob, type: input?.input?.type })) continue;
                  let sha = null;
                  try {
                    sha = sha256(readFileSync(join(repoRoot, path)));
                  } catch {
                    sha = null;
                  }
                  const { fresh, stale } = freshHits(state.hits, { path, req: state.req, sha });
                  if (stale.length) state.hits = state.hits.filter((h) => !stale.includes(h));
                  if (fresh.length) queueHint(state, HINT_RANGE_GREP(path, fresh));
                }
              }
              // Repeats at every multiple of the threshold (4, 8, 12, ...).
              if (state.exploration % EXPLORATION_HINT_THRESHOLD === 0) {
                queueHint(state, `jev-flow: ${state.exploration} exploration calls in this request. Stop broad exploration in this thread: delegate the open location question to the jev-locator subagent (/${NAMES.locate} <question>) and read only the ranges it returns.`);
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
          state.rereadHinted = false;
          state.finishHinted = false;
          state.pendingHints = [];
          state.reads.clear();
          if (repoRoot) {
            // Session metadata for the gate runner: receipt key and baseline once, the request number every prompt.
            try {
              const dir = metaDir(input?.sessionID);
              if (!state.initialized) {
                initRunnerSession(dir, repoRoot);
                state.initialized = true;
              }
              withState(dir, (meta) => {
                meta.request = { ...meta.request, seq: state.req, started: Date.now() };
              });
            } catch (error) {
              runtimeProblem("prompt", `gate-runner session metadata failed: ${error?.message ?? error}`);
            }
          }
          if (repoRoot && !loadDenylist(repoRoot).disabled) queueHint(state, DIRECTIVE);
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
            if (state.pendingHints.length === 0 || !Array.isArray(input?.system)) return;
            input.system.push({ type: "text", text: state.pendingHints.join("\n") });
            state.pendingHints = [];
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
  if (locatorNote) notes.push(locatorNote);
  if (notes.length) diagnose(notes.join(" | "));
  return report;
}

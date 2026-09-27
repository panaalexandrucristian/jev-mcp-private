// Claude Code hook logic for jev-flow. Pure function of (event, input, env):
// returns the JSON object to print, or null. Local work only: no tests, no
// model calls, no whole-repo scans. Snapshots are computed only at explicit
// boundaries (session start, test runs, jev_gate, Stop).
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { coversEarlierBatches, parseBatchLabel, verifyBatchContents } from "./gate-batch.mjs";
import { loadDenylist } from "./paths.mjs";
import {
  classifyShellCommand,
  EXPLORATION_HINT_THRESHOLD,
  FIXED_PHRASES,
  jevToolName,
  parseJevResult,
  REREAD_HINT_THRESHOLD,
  stopDecision,
  validateGateResult,
} from "./policy.mjs";
import { payloadCredentialKinds } from "./sanitize.mjs";
import {
  cacheRoot,
  cleanupRetention,
  computeSnapshot,
  gateCandidate,
  gitTopLevel,
  inputHash,
  recordRead,
  sessionDir,
  sha256,
  StateBusyError,
  testFreshFor,
  withState,
} from "./state.mjs";

export const HINTS = Object.freeze({
  directive: () =>
    "jev-flow is the default route for code tasks in this repository (opt out: JEV_FLOW=off). For a non-trivial code task: load the jev-flow skill and follow its route. " +
    "When the files are not known, delegate broad discovery to the jev-locator subagent (/jev:jev-locate <question>) instead of searching in this thread, then read only the ranges it returns; an exact known path or symbol is used directly. " +
    "After any code change, run the repository's real checks and finish with /jev:jev-done (jev_gate with per-claim evidence) before reporting completion.",
  explore: (count) =>
    `jev-flow: ${count} exploration calls in this request. Stop broad exploration in this thread: delegate the open location question to the jev-locator subagent (/jev:jev-locate <question>) and read only the ranges it returns.`,
  reread: () =>
    "jev-flow: the same file range with the same content has been re-read twice in this request. Delegate the open question to jev-locator (/jev:jev-locate) instead of re-reading.",
  finish: () =>
    "jev-flow: code changed. Before reporting completion, run the repository's real checks on the final snapshot and finish with /jev:jev-done (jev_gate on the final diff).",
  disabledStart: () =>
    `jev-flow: .jev-flow-denylist disables Jev for this repo. Do not send repository data to Jev tools; run the local checks and report "${FIXED_PHRASES.disabled}".`,
});

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const LOCATOR_TYPE = /^(?:jev:)?jev-locator$/;
const LOCATOR_MODELS = new Set(["haiku", "sonnet", "opus"]);

/** JEV_FLOW=off: no directives, hints or Stop redirects/notices. The data guard stays. */
export function flowOff(env) {
  return String(env?.JEV_FLOW ?? "").trim().toLowerCase() === "off";
}

/** Claude Code model alias of a model id ("claude-opus-5-5" -> "opus"), or null. */
export function modelAlias(modelId) {
  const match = /(opus|sonnet|haiku|fable)/i.exec(String(modelId ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Model for a jev-locator delegation from JEV_FLOW_LOCATOR_MODEL. Unset: null
 * (the agent frontmatter, haiku, applies). haiku|sonnet|opus: that alias.
 * inherit: the parent's alias recorded at SessionStart. Anything else, or an
 * inherit that cannot be mapped: {model: null, problem}.
 */
export function locatorModel(env, parentAlias) {
  const raw = String(env?.JEV_FLOW_LOCATOR_MODEL ?? "").trim().toLowerCase();
  if (raw === "") return { model: null };
  if (LOCATOR_MODELS.has(raw)) return { model: raw };
  if (raw === "inherit") {
    return parentAlias ? { model: parentAlias } : { model: null, problem: "inherit_unknown_parent" };
  }
  return { model: null, problem: "invalid_value" };
}
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function additionalContext(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function repoFor(input) {
  const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  return gitTopLevel(cwd);
}

function relPath(repoRoot, filePath) {
  if (typeof filePath !== "string" || filePath === "") return null;
  let abs = isAbsolute(filePath) ? filePath : join(repoRoot, filePath);
  let root = repoRoot;
  try {
    abs = realpathSync(abs);
    root = realpathSync(repoRoot);
  } catch {
    // Keep the literal paths when the file no longer exists.
  }
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function fileHash(repoRoot, rel) {
  try {
    return sha256(readFileSync(join(repoRoot, rel)));
  } catch {
    return null;
  }
}

function newRequest(state, now) {
  state.request = {
    seq: (state.request?.seq ?? 0) + 1,
    started: now,
    exploration: 0,
    reread_hinted: false,
    finish_hinted: false,
  };
  state.reads = {};
}

function handleSessionStart(ctx) {
  const { input, env, repoRoot, dir, now } = ctx;
  cleanupRetention(cacheRoot(env), now);
  const denylist = loadDenylist(repoRoot);
  const snapshot = computeSnapshot(repoRoot);
  withState(
    dir,
    (state) => {
      const source = input.source ?? "startup";
      if (source === "startup" || source === "resume") {
        // Restart: persisted metadata never becomes approval by itself.
        state.prior_gates += state.gates.length;
        state.gates = [];
        state.redirected = [];
        state.pending = {};
        state.boot += 1;
      }
      if (state.baseline === null) state.baseline = snapshot.hash;
      const alias = modelAlias(input.model);
      if (alias) state.parent_model = alias;
      newRequest(state, now);
    },
    now,
  );
  if (denylist.disabled) return additionalContext("SessionStart", HINTS.disabledStart());
  return flowOff(env) ? null : additionalContext("SessionStart", HINTS.directive());
}

/** Every request gets the route directive, unless the flow is off or Jev is disabled for the repo. */
function handleUserPromptSubmit(ctx) {
  withState(ctx.dir, (state) => newRequest(state, ctx.now), ctx.now);
  if (flowOff(ctx.env) || loadDenylist(ctx.repoRoot).disabled) return null;
  return additionalContext("UserPromptSubmit", HINTS.directive());
}

/**
 * PreToolUse on Agent/Task: apply JEV_FLOW_LOCATOR_MODEL to jev-locator
 * delegations through updatedInput (Claude Code applies an updatedInput
 * without a permissionDecision and keeps the normal permission flow). An
 * unusable value leaves the call unchanged and is reported once per session.
 */
function handleAgentPreToolUse(ctx) {
  const { input, env, dir, now } = ctx;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object" || !LOCATOR_TYPE.test(String(toolInput.subagent_type ?? ""))) return null;
  if (String(env?.JEV_FLOW_LOCATOR_MODEL ?? "").trim() === "") return null;
  let parent = null;
  let notify = null;
  const choice = withState(dir, (state) => {
    parent = state.parent_model ?? null;
    const result = locatorModel(env, parent);
    if (result.problem) {
      const key = `locator_model:${result.problem}`;
      if (!state.notified.includes(key)) {
        state.notified.push(key);
        notify = result.problem;
      }
    }
    return result;
  }, now);
  if (choice.model) {
    if (toolInput.model === choice.model) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, model: choice.model } } };
  }
  if (!notify) return null;
  const why =
    notify === "inherit_unknown_parent"
      ? "JEV_FLOW_LOCATOR_MODEL=inherit, but the parent model is unknown, so the agent's own model (haiku) applies"
      : "JEV_FLOW_LOCATOR_MODEL must be haiku, sonnet, opus or inherit; the value is ignored and the agent's own model (haiku) applies";
  return { systemMessage: `jev-flow: ${why}.` };
}

/** Batch manifest fields of a gate input (metadata only), or {}. */
function batchFields(toolInput) {
  const label = parseBatchLabel(toolInput?.request);
  return label ? { batch: label.id, part: label.part, of: label.of } : {};
}

function handlePreToolUse(ctx) {
  const { input, repoRoot, dir, now } = ctx;
  const tool = input.tool_name;
  if (AGENT_TOOLS.has(tool)) return handleAgentPreToolUse(ctx);
  const jev = jevToolName(tool);
  if (jev) {
    const deny = (reason) => {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
      // A refused gate is still the latest gate attempt: record it as failed
      // now, because no Post event follows a denied call. The refusal never
      // depends on this write: any failure (busy lock, EACCES, ENOSPC, ...) is
      // isolated here and reported by error code only, never with the payload.
      if (jev === "gate") {
        try {
          withState(dir, (state) => {
            state.gates.push({
              id: input.tool_use_id ? String(input.tool_use_id).slice(0, 120) : "unknown",
              req: state.request.seq,
              boot: state.boot,
              input: inputHash(input.tool_input),
              before: "unknown",
              after: "unknown",
              ts: now,
              failed: true,
              denied: true,
              ...batchFields(input.tool_input),
            });
          }, now);
        } catch (error) {
          const code = error instanceof StateBusyError ? "state_busy" : /^[A-Z][A-Z0-9_]{1,31}$/.test(String(error?.code)) ? error.code : "error";
          output.systemMessage =
            `jev-flow: the refused jev_gate call could not be recorded in the session state (${code}); the state was not updated. ` +
            "An earlier gate may still be superseded through the transcript check at Stop; otherwise treat completion as unverified.";
        }
      }
      return output;
    };
    const denylist = loadDenylist(repoRoot);
    if (denylist.disabled) {
      return deny(`.jev-flow-denylist disables Jev for this repository. Continue with local checks and report "${FIXED_PHRASES.disabled}".`);
    }
    const kinds = payloadCredentialKinds(input.tool_input);
    if (kinds.length > 0) {
      return deny(
        `The ${tool} payload contains an unredacted credential (${kinds.join(", ")}). Sanitize it with scripts/jev-candidates.mjs --sanitize or remove it, then retry; if it cannot be removed without distorting the evidence, report the missing evidence.`,
      );
    }
    if (jev === "gate" && input.tool_use_id) {
      const snap = computeSnapshot(repoRoot);
      const hash = inputHash(input.tool_input);
      withState(dir, (state) => {
        // Request and boot are taken when the call starts, not when it ends.
        state.pending[String(input.tool_use_id).slice(0, 120)] = {
          kind: "gate",
          before: snap.hash ?? "unknown",
          input: hash,
          req: state.request.seq,
          boot: state.boot,
          ts: now,
          ...batchFields(input.tool_input),
        };
      }, now);
    }
    return null;
  }
  if (tool === "Bash" && classifyShellCommand(input.tool_input?.command) === "test" && input.tool_use_id) {
    const snap = computeSnapshot(repoRoot);
    withState(dir, (state) => {
      state.pending[String(input.tool_use_id).slice(0, 120)] = {
        kind: "test",
        before: snap.hash ?? "unknown",
        cmd: commandHash(input.tool_input?.command),
        req: state.request.seq,
        boot: state.boot,
        ts: now,
      };
    }, now);
  }
  return null;
}

/** Hash of a normalized shell command: identifies reruns of the same check. */
function commandHash(command) {
  return sha256(String(command ?? "").trim().replace(/\s+/g, " ")).slice(0, 32);
}

/** Close a started gate attempt into a completed or failed record. */
function finishGate(state, useId, hash, after, now, failed, toolInput) {
  const pending = useId ? state.pending[useId] : undefined;
  if (useId) delete state.pending[useId];
  const started = pending?.kind === "gate" ? pending : null;
  state.gates.push({
    ...batchFields(toolInput),
    id: useId ?? "unknown",
    // Without a matching start record, request, boot and stability are unknown.
    req: started ? started.req : -1,
    boot: started ? started.boot : state.boot,
    input: hash,
    before: started && started.input === hash ? started.before : "unknown",
    after: failed ? "unknown" : after ?? "unknown",
    ts: started ? started.ts : now,
    failed,
  });
}

/** Close a started test run. */
function finishTest(state, useId, command, after, exit, now, failed) {
  const pending = useId ? state.pending[useId] : undefined;
  if (useId) delete state.pending[useId];
  const started = pending?.kind === "test" ? pending : null;
  state.tests.push({
    cmd: commandHash(command),
    req: started ? started.req : state.request.seq,
    boot: started ? started.boot : state.boot,
    before: started ? started.before : "unknown",
    after: after ?? "unknown",
    exit,
    failed,
    ts: started ? started.ts : now,
  });
  state.counters.tests += 1;
}

function readRange(toolInput) {
  const offset = Number.isInteger(toolInput?.offset) ? toolInput.offset : 1;
  const limit = Number.isInteger(toolInput?.limit) ? toolInput.limit : null;
  return { start: offset, end: limit ? offset + limit - 1 : "end" };
}

/**
 * Exit code of a shell run when the tool response states one; otherwise null
 * (unknown). Claude Code's Bash response usually carries no exit code, so a
 * test run is normally recorded with an unknown result, which is never success.
 */
export function shellExitCode(response) {
  if (!response || typeof response !== "object") return null;
  for (const key of ["exitCode", "exit_code", "returnCode", "code"]) {
    if (Number.isInteger(response[key])) return response[key];
  }
  return null;
}

function handlePostToolUse(ctx) {
  const { input, env, repoRoot, dir, now, isChild } = ctx;
  const tool = input.tool_name;
  const jev = jevToolName(tool);
  const useId = input.tool_use_id ? String(input.tool_use_id).slice(0, 120) : null;

  if (jev === "gate") {
    const after = computeSnapshot(repoRoot);
    const hash = inputHash(input.tool_input);
    withState(dir, (state) => {
      finishGate(state, useId, hash, after.hash, now, false, input.tool_input);
      state.counters.jev_calls.gate = (state.counters.jev_calls.gate ?? 0) + 1;
    }, now);
    return null;
  }
  if (jev) {
    withState(dir, (state) => {
      state.counters.jev_calls[jev] = (state.counters.jev_calls[jev] ?? 0) + 1;
    }, now);
    return null;
  }

  let kind = null;
  if (EXPLORATION_TOOLS.has(tool)) kind = "exploration";
  else if (EDIT_TOOLS.has(tool)) kind = "edit";
  else if (tool === "Bash") {
    const cls = classifyShellCommand(input.tool_input?.command);
    kind = cls === "exploration" ? "exploration" : cls === "mutation" ? "edit" : cls === "test" ? "test" : null;
  }
  if (!kind) return null;

  let testAfter = null;
  if (kind === "test") testAfter = computeSnapshot(repoRoot);

  let readInfo = null;
  if (tool === "Read") {
    const rel = relPath(repoRoot, input.tool_input?.file_path);
    if (rel) readInfo = { rel, ...readRange(input.tool_input), hash: fileHash(repoRoot, rel) };
  }

  return withState(dir, (state) => {
    if (kind === "test") finishTest(state, useId, input.tool_input?.command, testAfter.hash, shellExitCode(input.tool_response), now, false);
    if (kind === "edit") {
      state.dirty = true;
      state.counters.edits += 1;
    }
    // Hints go to the main thread only; subagents never get delegation hints.
    if (isChild) return null;
    const off = flowOff(env);
    if (kind === "exploration") {
      state.request.exploration += 1;
      state.counters.exploration_total += 1;
      let rereads = 0;
      if (readInfo?.hash) rereads = recordRead(state, { path: readInfo.rel, start: readInfo.start, end: readInfo.end, hash: readInfo.hash, now });
      if (off) return null;
      // The exploration directive repeats at every multiple of the threshold;
      // the re-read hint fires once per request. One message per event.
      const texts = [];
      if (!state.request.reread_hinted && rereads >= REREAD_HINT_THRESHOLD) {
        state.request.reread_hinted = true;
        texts.push(HINTS.reread());
      }
      if (state.request.exploration % EXPLORATION_HINT_THRESHOLD === 0) texts.push(HINTS.explore(state.request.exploration));
      return texts.length ? additionalContext("PostToolUse", texts.join("\n")) : null;
    }
    if (off) return null;
    if ((kind === "edit" || kind === "test") && !state.request.finish_hinted) {
      state.request.finish_hinted = true;
      return additionalContext("PostToolUse", HINTS.finish());
    }
    return null;
  }, now);
}

/**
 * PostToolUseFailure: a Jev gate or a test command failed. The attempt is
 * closed as failed, so it supersedes earlier successes; nothing is approved.
 */
function handlePostToolUseFailure(ctx) {
  const { input, dir, now } = ctx;
  const tool = input.tool_name;
  const useId = input.tool_use_id ? String(input.tool_use_id).slice(0, 120) : null;
  const jev = jevToolName(tool);
  if (jev === "gate") {
    const hash = inputHash(input.tool_input);
    withState(dir, (state) => finishGate(state, useId, hash, null, now, true, input.tool_input), now);
  } else if (tool === "Bash" && classifyShellCommand(input.tool_input?.command) === "test") {
    withState(dir, (state) => finishTest(state, useId, input.tool_input?.command, null, null, now, true), now);
  }
  return null;
}

/**
 * Gate-related tool_use blocks (in transcript order) and the tool_results of
 * `wantedIds`, read from the native Claude transcript in memory only; null
 * when the transcript cannot be read.
 */
function readTranscriptGates(transcriptPath, wantedIds) {
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const uses = [];
  const results = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes("jev_gate") && ![...wantedIds].some((id) => line.includes(id))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && (jevToolName(block.name) === "gate" || wantedIds.has(block.id))) {
        uses.push({ id: block.id, name: block.name, input: block.input, order: uses.length });
      }
      if (block?.type === "tool_result" && wantedIds.has(block.tool_use_id)) results.set(block.tool_use_id, block);
    }
  }
  return { uses, results };
}

/** Validate one recorded gate call against its transcript tool_use and tool_result. */
function checkTranscriptCall(t, record) {
  const use = t.uses.find((u) => u.id === record.id);
  if (!use || jevToolName(use.name) !== "gate") return { reason: "gate_call_not_in_transcript" };
  if (inputHash(use.input) !== record.input) return { reason: "gate_input_mismatch", use };
  const result = t.results.get(record.id);
  if (!result) return { reason: "gate_result_not_in_transcript", use };
  if (result.is_error) return { reason: "gate_call_failed", use };
  const check = validateGateResult(parseJevResult(result.content), { claims: use.input?.claims });
  return check.accepted ? { use } : { reason: "gate_not_accepted", problems: check.problems, use };
}

/**
 * Re-read a gate verdict from the native Claude transcript, in memory only.
 * The tool_use must carry the recorded id, a Jev gate tool name and the same
 * input hash; the tool_result must not be an error and must pass
 * validateGateResult. Anything missing or unparseable is "unknown". An
 * accepted verdict also returns the claims that were checked.
 */
export function gateVerdictFromTranscript(transcriptPath, record) {
  if (typeof transcriptPath !== "string" || !record?.id || record.id === "unknown") return { accepted: false, reason: "transcript_unavailable" };
  const t = readTranscriptGates(transcriptPath, new Set([record.id]));
  if (!t) return { accepted: false, reason: "transcript_unavailable" };
  const use = t.uses.find((u) => u.id === record.id);
  if (!use || jevToolName(use.name) !== "gate") return { accepted: false, reason: "gate_call_not_in_transcript" };
  // Any gate call written after this one (denied, cancelled or otherwise)
  // supersedes it, even if its own state record was never written.
  if (t.uses.some((u) => u.order > use.order && jevToolName(u.name) === "gate")) return { accepted: false, reason: "later_gate_call_in_transcript" };
  const check = checkTranscriptCall(t, record);
  if (check.reason) return { accepted: false, reason: check.reason, ...(check.problems ? { problems: check.problems } : {}) };
  return { accepted: true, claims: Array.isArray(use.input?.claims) ? use.input.claims : [], diff: use.input?.diff };
}

/**
 * Re-read a partitioned batch from the transcript: every selected part must
 * pass checkTranscriptCall, carry the batch label, and no gate call outside
 * the batch (or a newer attempt of a part than the one recorded) may follow
 * the batch's first selected part. The parts' inputs must then form the
 * complete batch of their manifest on `snapshot` (verifyBatchContents).
 */
export function batchVerdictFromTranscript(transcriptPath, batch, snapshot) {
  const records = batch?.records ?? [];
  if (typeof transcriptPath !== "string" || records.length === 0 || records.some((r) => !r.id || r.id === "unknown")) {
    return { accepted: false, reason: "transcript_unavailable" };
  }
  const ids = new Set(records.map((r) => r.id));
  const t = readTranscriptGates(transcriptPath, ids);
  if (!t) return { accepted: false, reason: "transcript_unavailable" };
  const parts = [];
  const orderOf = new Map();
  let firstOrder = Infinity;
  for (const record of records) {
    const check = checkTranscriptCall(t, record);
    if (check.reason) return { accepted: false, reason: check.reason, part: record.part, ...(check.problems ? { problems: check.problems } : {}) };
    const label = parseBatchLabel(check.use.input?.request);
    if (!label || label.id !== batch.id || label.part !== record.part) return { accepted: false, reason: "batch_label_mismatch", part: record.part };
    // The complete input as sent: its digest binds the manifest id.
    parts.push(check.use.input);
    orderOf.set(record.part, check.use.order);
    firstOrder = Math.min(firstOrder, check.use.order);
  }
  for (const u of t.uses) {
    if (u.order <= firstOrder || ids.has(u.id) || jevToolName(u.name) !== "gate") continue;
    const label = parseBatchLabel(u.input?.request);
    if (!label || label.id !== batch.id || u.order > orderOf.get(label.part)) return { accepted: false, reason: "later_gate_call_in_transcript" };
  }
  const contents = verifyBatchContents(parts, { snapshot });
  if (!contents.ok) return { accepted: false, reason: "batch_manifest_invalid", problems: contents.problems };
  return { accepted: true, parts: records.length, partitioned: records.length > 1, claims: contents.claims, diff: contents.whole };
}

/** The inputs ({request, claims, diff}) of earlier batch attempts, from the transcript; null when any is missing. */
function earlierBatchInputs(transcriptPath, records) {
  const ids = new Set(records.map((r) => r.id).filter((id) => id && id !== "unknown"));
  if (typeof transcriptPath !== "string" || ids.size !== records.length) return null;
  const t = readTranscriptGates(transcriptPath, ids);
  if (!t) return null;
  const inputs = [];
  for (const id of ids) {
    const use = t.uses.find((u) => u.id === id);
    if (!use) return null;
    inputs.push({ request: use.input?.request, claims: use.input?.claims, diff: use.input?.diff });
  }
  return inputs;
}

/** Re-read whatever gateCandidate selected; never approves without a valid transcript record. */
function candidateVerdict(transcriptPath, candidate, snapshot) {
  let verdict;
  if (candidate.batch) verdict = batchVerdictFromTranscript(transcriptPath, candidate.batch, snapshot);
  else if (candidate.record) verdict = gateVerdictFromTranscript(transcriptPath, candidate.record);
  else return { accepted: false };
  if (!verdict.accepted || !candidate.supersededBatch?.length) return verdict;
  // A later gate (single or a replacement batch) on this snapshot must cover
  // every claim and the whole patch of the earlier batch it replaces.
  const earlier = earlierBatchInputs(transcriptPath, candidate.supersededBatch);
  if (earlier === null) return { accepted: false, reason: "batch_claims_unavailable" };
  return coversEarlierBatches({ claims: verdict.claims, diff: verdict.diff }, earlier) ? verdict : { accepted: false, reason: "later_gate_misses_batch_coverage" };
}

const STOP_REASONS = {
  no_fresh_gate: "no accepted jev_gate for the final snapshot",
  snapshot_unavailable: "the snapshot could not be computed, so completion evidence is unknown",
  stop_hook_active: "strict redirect skipped because a Stop hook is already continuing this turn",
  already_redirected: "strict redirect already used for this snapshot; completion is not verified",
};

function handleStop(ctx) {
  const { input, env, repoRoot, dir, now } = ctx;
  // JEV_FLOW=off takes precedence over JEV_FLOW_STRICT=1: no redirect, no
  // notice. It never counts as an approval either; nothing is recorded as one.
  if (flowOff(env)) return null;
  const strict = env.JEV_FLOW_STRICT === "1";
  const snapshot = computeSnapshot(repoRoot);
  const denylist = loadDenylist(repoRoot);
  // Phase 1 (locked, no writes of results): collect the correlation metadata.
  const view = withState(dir, (state) => ({
    codeChanged: snapshot.hash === null ? true : state.baseline !== null ? snapshot.hash !== state.baseline : state.dirty,
    candidate: gateCandidate(state, { snapshot: snapshot.hash }),
    testsFresh: testFreshFor(state, snapshot.hash),
  }), now);
  // Phase 2 (unlocked): re-read the verdict from the native transcript, in memory.
  const verdict = candidateVerdict(input.transcript_path, view.candidate, snapshot.hash);
  const snapKey = snapshot.hash ?? "unknown";
  // Phase 3 (locked): decide once per snapshot, re-checking the redirect record.
  return withState(dir, (state) => {
    const decision = stopDecision({
      strict,
      stopHookActive: input.stop_hook_active === true,
      lastMessage: input.last_assistant_message,
      codeChanged: view.codeChanged,
      gateAccepted: verdict.accepted === true,
      redirectedBefore: state.redirected.includes(snapKey),
      snapshotKnown: snapshot.hash !== null,
    });
    if (decision.action === "block") {
      state.redirected.push(snapKey);
      const disabledNote = denylist.disabled ? ` Jev is disabled for this repo: report "${FIXED_PHRASES.disabled}".` : "";
      return {
        decision: "block",
        reason:
          `jev-flow strict mode: code changed and no accepted jev_gate exists for the current snapshot and request${view.testsFresh ? "" : " (no passing real check is recorded on it either)"}. ` +
          "Run /jev:jev-done (real checks, then jev_gate on the final diff with per-claim evidence; for a partitioned batch every part must be accepted on this snapshot). If completion cannot be verified, end with a line starting with \"Incomplete:\", " +
          `report "${FIXED_PHRASES.unavailable}" when Jev failed, or ask the user.` +
          disabledNote,
      };
    }
    if (decision.action === "notify") {
      if (state.notified.includes(`${snapKey}:${decision.reason}`)) return null;
      state.notified.push(`${snapKey}:${decision.reason}`);
      return { systemMessage: `jev-flow: code changed; ${STOP_REASONS[decision.reason]}. Use /jev:jev-done or treat the result as unverified.` };
    }
    return null;
  }, now);
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUseFailure,
  Stop: handleStop,
};

/**
 * Entry point. Outside a git work tree the hook does nothing: there is no
 * snapshot to bind evidence to, and nothing is approved either.
 */
export function handleHook(event, input, env = process.env, now = Date.now()) {
  const handler = HANDLERS[event];
  if (!handler) return null;
  const repoRoot = repoFor(input);
  if (!repoRoot) return null;
  const dir = sessionDir(repoRoot, input?.session_id, env);
  const isChild = typeof input?.agent_id === "string" && input.agent_id !== "";
  if (event === "Stop" && isChild) return null;
  try {
    return handler({ input: input ?? {}, env, repoRoot, dir, now, isChild });
  } catch (error) {
    if (!(error instanceof StateBusyError)) throw error;
    // State unknown: never block, never approve. Only Stop tells the user.
    if (event !== "Stop") return null;
    const manual = error.ownerGone ? ` The lock ${error.lockPath} was left by a process that is gone; delete it by hand.` : "";
    return { systemMessage: `jev-flow: session state is busy, so completion evidence is unknown; treat the result as unverified.${manual}` };
  }
}

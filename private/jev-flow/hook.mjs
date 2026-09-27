// Claude Code hook logic for jev-flow. Pure function of (event, input, env):
// returns the JSON object to print, or null. Local work only: no tests, no
// model calls, no whole-repo scans. Snapshots are computed only at explicit
// boundaries (session start, test runs, jev_gate, Stop).
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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
  explore: (count) =>
    `jev-flow: ${count} exploration calls in this request. For broad discovery, delegate to the jev-locator subagent (/jev:jev-locate <question>) and read only the ranges it returns.`,
  reread: () =>
    "jev-flow: the same file range with the same content has been re-read twice in this request. Delegate the open question to jev-locator (/jev:jev-locate) instead of re-reading.",
  finish: () =>
    "jev-flow: code changed. Before reporting completion, run the repository's real checks on the final snapshot and finish with /jev:jev-done (jev_gate on the final diff).",
  disabledStart: () =>
    `jev-flow: .jev-flow-denylist disables Jev for this repo. Do not send repository data to Jev tools; run the local checks and report "${FIXED_PHRASES.disabled}".`,
});

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
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
    explore_hinted: false,
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
      newRequest(state, now);
    },
    now,
  );
  return denylist.disabled ? additionalContext("SessionStart", HINTS.disabledStart()) : null;
}

function handleUserPromptSubmit(ctx) {
  withState(ctx.dir, (state) => newRequest(state, ctx.now), ctx.now);
  return null;
}

function handlePreToolUse(ctx) {
  const { input, repoRoot, dir, now } = ctx;
  const tool = input.tool_name;
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
function finishGate(state, useId, hash, after, now, failed) {
  const pending = useId ? state.pending[useId] : undefined;
  if (useId) delete state.pending[useId];
  const started = pending?.kind === "gate" ? pending : null;
  state.gates.push({
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
  const { input, repoRoot, dir, now, isChild } = ctx;
  const tool = input.tool_name;
  const jev = jevToolName(tool);
  const useId = input.tool_use_id ? String(input.tool_use_id).slice(0, 120) : null;

  if (jev === "gate") {
    const after = computeSnapshot(repoRoot);
    const hash = inputHash(input.tool_input);
    withState(dir, (state) => {
      finishGate(state, useId, hash, after.hash, now, false);
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
    if (kind === "exploration") {
      state.request.exploration += 1;
      state.counters.exploration_total += 1;
      let rereads = 0;
      if (readInfo?.hash) rereads = recordRead(state, { path: readInfo.rel, start: readInfo.start, end: readInfo.end, hash: readInfo.hash, now });
      if (!state.request.explore_hinted) {
        if (rereads >= REREAD_HINT_THRESHOLD) {
          state.request.explore_hinted = true;
          return additionalContext("PostToolUse", HINTS.reread());
        }
        if (state.request.exploration >= EXPLORATION_HINT_THRESHOLD) {
          state.request.explore_hinted = true;
          return additionalContext("PostToolUse", HINTS.explore(state.request.exploration));
        }
      }
      return null;
    }
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
    withState(dir, (state) => finishGate(state, useId, hash, null, now, true), now);
  } else if (tool === "Bash" && classifyShellCommand(input.tool_input?.command) === "test") {
    withState(dir, (state) => finishTest(state, useId, input.tool_input?.command, null, null, now, true), now);
  }
  return null;
}

/**
 * Re-read a gate verdict from the native Claude transcript, in memory only.
 * The tool_use must carry the recorded id, a Jev gate tool name and the same
 * input hash; the tool_result must not be an error and must pass
 * validateGateResult. Anything missing or unparseable is "unknown".
 */
export function gateVerdictFromTranscript(transcriptPath, record) {
  if (typeof transcriptPath !== "string" || !record?.id || record.id === "unknown") return { accepted: false, reason: "transcript_unavailable" };
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return { accepted: false, reason: "transcript_unavailable" };
  }
  let use = null;
  let result = null;
  let laterGateCall = false;
  for (const line of text.split("\n")) {
    if (!line.includes(record.id) && !line.includes("jev_gate")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block.id === record.id) use = block;
      // Any gate call written after this one (denied, cancelled or otherwise)
      // supersedes it, even if its own state record was never written.
      else if (use && block?.type === "tool_use" && jevToolName(block.name) === "gate") laterGateCall = true;
      if (block?.type === "tool_result" && block.tool_use_id === record.id) result = block;
    }
  }
  if (!use || jevToolName(use.name) !== "gate") return { accepted: false, reason: "gate_call_not_in_transcript" };
  if (laterGateCall) return { accepted: false, reason: "later_gate_call_in_transcript" };
  if (inputHash(use.input) !== record.input) return { accepted: false, reason: "gate_input_mismatch" };
  if (!result) return { accepted: false, reason: "gate_result_not_in_transcript" };
  if (result.is_error) return { accepted: false, reason: "gate_call_failed" };
  const check = validateGateResult(parseJevResult(result.content), { claims: use.input?.claims });
  return check.accepted ? { accepted: true } : { accepted: false, reason: "gate_not_accepted", problems: check.problems };
}

const STOP_REASONS = {
  no_fresh_gate: "no accepted jev_gate for the final snapshot",
  snapshot_unavailable: "the snapshot could not be computed, so completion evidence is unknown",
  stop_hook_active: "strict redirect skipped because a Stop hook is already continuing this turn",
  already_redirected: "strict redirect already used for this snapshot; completion is not verified",
};

function handleStop(ctx) {
  const { input, env, repoRoot, dir, now } = ctx;
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
  const verdict = view.candidate.record ? gateVerdictFromTranscript(input.transcript_path, view.candidate.record) : { accepted: false };
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
          "Run /jev:jev-done (real checks, then jev_gate on the final diff). If completion cannot be verified, end with a line starting with \"Incomplete:\", " +
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

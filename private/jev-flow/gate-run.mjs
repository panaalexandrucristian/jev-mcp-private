// Direct gate runner (orchestration for scripts/jev-gate-run.mjs).
//
// The runner, not the model, collects the patch (git diff against the session
// baseline, new non-ignored files included), runs the real checks and reads
// the cited excerpts; it pairs them with the model's claims through
// prepareGateBatch (sanitizing, jev_gate limits, partitioning only when one
// call is not enough, manifest bound to the snapshot), calls jev_gate itself
// over the jev MCP server on stdio, evaluates every part of the batch (only a
// contradicted claim stops it early) and returns one aggregated report: a
// semantic `verdict`, an operational `status`, the `outcome` that decides the
// exit code, per-part and per-claim verdicts and coverage. With a jev-flow
// session it records the attempt in the session state and writes an
// HMAC-signed, metadata-only receipt of the whole batch that the Stop hook /
// OpenCode gate status re-verify.
//
// Exit codes (outcome precedence: contradicted, snapshot_changed,
// checks_failed, unavailable, then the verdict): 0 accepted (every part auto
// and valid, every check passed), 2 contradicted / checks failed / escalate /
// ask_user / needs_evidence, 3 Jev unavailable or disabled for the repo,
// 4 invalid input or not ready (nothing to gate, snapshot changed, sanitizing
// removed content, ...), 1 internal error.
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { listHunks, prepareGateBatch } from "./gate-batch.mjs";
import { callWithRetry, openJev } from "./mcp-client.mjs";
import { FIXED_PHRASES, interpretGate, validateGateResult } from "./policy.mjs";
import { newReceiptId, readReceiptKey, sessionDirFromKey, writeReceipt } from "./runner-receipt.mjs";
import { sanitizeDiff, sanitizeText } from "./sanitize.mjs";
import { computeSnapshot, inputHash, pathContentHash, readBaseline, repoKey, sessionDir, sessionKey, sha256, withState } from "./state.mjs";

export const EXIT = Object.freeze({ accepted: 0, internal: 1, not_accepted: 2, unavailable: 3, invalid: 4 });

/** Runner budgets (documented in PRIVATE.md). */
export const RUN_LIMITS = Object.freeze({
  checkTimeoutMs: 900_000,
  checkHeadChars: 8_000, // kept from the start of a check's output
  checkTailChars: 32_000, // kept from the end (test summaries are at the end)
  maxChecks: 8,
  maxExcerptLines: 400,
  summaryChars: 8_192,
  gitMaxBuffer: 64 * 1024 * 1024,
});

const INPUT_KEYS = new Set(["request", "claims", "excerpts"]);
const REJECTED_KEYS = { diff: "the runner collects the diff itself", commands: "the runner runs the checks itself (--check)", tests: "the runner runs the checks itself (--check)", evidence: "evidence is built by the runner from the cited ids" };

export class RunError extends Error {
  constructor(status, message, problems = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

function gitText(repoRoot, args, { allow = [0] } = {}) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: RUN_LIMITS.gitMaxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || !allow.includes(r.status)) throw new RunError("not_ready", `git ${args[0]} failed: ${(r.stderr || String(r.error ?? "")).trim().slice(0, 200)}`);
  return r.stdout;
}

function headCommit(repoRoot) {
  const r = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

function commitExists(repoRoot, sha) {
  if (!/^[0-9a-f]{40,64}$/.test(String(sha ?? ""))) return false;
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-renames", "--ignore-submodules=dirty"];

/**
 * The patch to gate and its attribution limits.
 * - With a session baseline: git diff <baseline HEAD> (work tree), plus every
 *   untracked non-ignored file. Paths already changed at session start whose
 *   content is unchanged are left out and listed in `unattributed`; changed
 *   ones are included and listed in `preexisting_mixed` (their earlier
 *   changes cannot be separated: the baseline keeps hashes, not content).
 * - Without one: git diff HEAD, everything included, attribution unknown.
 * Binary files and submodules stay in the diff and are listed in `unevaluated`.
 */
export function collectPatch(repoRoot, baseline) {
  const head = headCommit(repoRoot);
  if (!head) throw new RunError("not_ready", "the repository has no commit to diff against");
  const usable = baseline && !baseline.overflow && commitExists(repoRoot, baseline.head);
  const base = usable ? baseline.head : head;
  const pre = new Map(usable ? baseline.dirty.map((d) => [d.path, d.hash]) : []);
  const unattributed = [];
  const mixed = [];
  const skip = new Set();
  for (const [path, hash] of pre) {
    if (pathContentHash(repoRoot, path) === hash) {
      skip.add(path);
      unattributed.push(path);
    } else mixed.push(path);
  }
  const tracked = gitText(repoRoot, ["diff", base, "--name-only", "-z", ...DIFF_FLAGS]).split("\0").filter(Boolean);
  const untracked = gitText(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort();
  const trackedIn = tracked.filter((p) => !skip.has(p));
  let diff = "";
  if (trackedIn.length === tracked.length) {
    if (tracked.length) diff += gitText(repoRoot, ["diff", base, ...DIFF_FLAGS]);
  } else {
    for (const p of trackedIn) diff += gitText(repoRoot, ["diff", base, ...DIFF_FLAGS, "--", `:(literal)${p}`]);
  }
  for (const p of untracked) {
    if (skip.has(p)) continue;
    // --no-index exits 1 when the files differ (always, against /dev/null).
    diff += gitText(repoRoot, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", p], { allow: [0, 1] });
  }
  const unevaluated = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const path = /^diff --git a\/(.+?) b\//.exec(section)?.[1] ?? /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? null;
    if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(section)) unevaluated.push({ path, reason: "binary" });
    else if (/^[-+]Subproject commit /m.test(section)) unevaluated.push({ path, reason: "submodule" });
  }
  return {
    diff,
    base: { mode: usable ? "session_baseline" : "head_fallback", commit: base },
    unattributed: usable ? unattributed : "baseline unknown: pre-existing changes cannot be separated from this session's",
    preexisting_mixed: mixed,
    unevaluated,
  };
}

/** Hunk ids for choosing evidence (the same ids a run uses on the same tree). */
export function listRunHunks(repoRoot, denylist, baseline) {
  const patch = collectPatch(repoRoot, baseline);
  const clean = sanitizeDiff(patch.diff, denylist);
  return {
    ok: true,
    base: patch.base,
    hunks: listHunks(clean.text).map(({ id, path, header }) => ({ id, path, header })),
    omitted: clean.omitted,
    omitted_lines: clean.omitted_lines,
    unattributed: patch.unattributed,
    preexisting_mixed: patch.preexisting_mixed,
    unevaluated: patch.unevaluated,
  };
}

/**
 * A --check value: a JSON array of non-empty strings (argv, run without a
 * shell). Throws RunError("invalid_input") otherwise.
 */
export function parseCheckArgv(value) {
  let argv;
  try {
    argv = JSON.parse(value);
  } catch {
    argv = null;
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a === "" || a.length > 4000)) {
    throw new RunError("invalid_input", `--check must be a JSON array of strings (argv, no shell), for example '["npm","test"]'; got ${JSON.stringify(String(value).slice(0, 80))}`);
  }
  return argv;
}

/** Human-readable rendering of an argv (POSIX-quoted where needed); for display and evidence headers only. */
export function renderArgv(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** Hash of a check's argv (canonical JSON). */
export function commandHash(argv) {
  return sha256(JSON.stringify(argv)).slice(0, 32);
}

/** A check passes only with exit 0, no timeout and a successful start. */
export const checkPassed = (c) => c.exit === 0 && !c.timed_out && !c.start_failed;

/**
 * Run one check as argv (spawn(argv[0], argv.slice(1)), no shell) in the
 * repository, stdout and stderr interleaved in arrival order. Output beyond
 * the head + tail budgets is cut visibly. A command that cannot start has
 * exit null and start_failed.
 */
export function runCheck(repoRoot, argv, { timeoutMs = RUN_LIMITS.checkTimeoutMs, env = process.env } = {}) {
  const command = renderArgv(argv);
  return new Promise((resolve) => {
    const started = Date.now();
    let head = "";
    let tail = "";
    let cut = 0;
    const take = (chunk) => {
      let text = String(chunk);
      if (head.length < RUN_LIMITS.checkHeadChars) {
        const room = RUN_LIMITS.checkHeadChars - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (text === "") return;
      tail += text;
      if (tail.length > RUN_LIMITS.checkTailChars) {
        cut += tail.length - RUN_LIMITS.checkTailChars;
        tail = tail.slice(tail.length - RUN_LIMITS.checkTailChars);
      }
    };
    let child;
    let startError = null;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      return resolve({ argv, command, exit: null, timed_out: false, start_failed: true, output: `[jev-flow: the check could not start: ${error?.code ?? error?.message}]`, cut_chars: 0, ms: 0 });
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      startError = error?.code ?? String(error?.message ?? error);
      take(`[jev-flow: the check could not start: ${startError}]\n`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = cut > 0 ? `${head}\n[jev-flow: ${cut} characters of output omitted here]\n${tail}` : head + tail;
      resolve({
        argv,
        command,
        exit: timedOut || startError ? null : Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        timed_out: timedOut,
        start_failed: startError !== null,
        output,
        cut_chars: cut,
        ms: Date.now() - started,
      });
    });
  });
}

function repoRelative(repoRoot, path) {
  if (typeof path !== "string" || path === "") return null;
  let abs = isAbsolute(path) ? path : join(repoRoot, path);
  try {
    abs = realpathSync(abs);
  } catch {
    return null;
  }
  const rel = relative(realpathSync(repoRoot), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Excerpts cited by id: the runner reads the lines itself. */
function readExcerpts(repoRoot, excerpts, problems) {
  return excerpts.map((x, i) => {
    const label = `excerpts[${i}]`;
    if (!x || typeof x !== "object") return problems.push(`${label}: must be {id, path, lines: [first, last]}`), null;
    if ("text" in x) return problems.push(`${label}: do not pass text; the runner reads the lines from the file`), null;
    const rel = repoRelative(repoRoot, x.path);
    const [a, b] = Array.isArray(x.lines) ? x.lines : [];
    if (!rel) return problems.push(`${label}: path must be an existing file inside the repository`), null;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b - a + 1 > RUN_LIMITS.maxExcerptLines) {
      return problems.push(`${label}: lines must be [first, last], 1-based, at most ${RUN_LIMITS.maxExcerptLines} lines`), null;
    }
    let st;
    try {
      st = lstatSync(join(repoRoot, rel));
    } catch {
      st = null;
    }
    if (!st?.isFile()) return problems.push(`${label}: ${rel} is not a regular file`), null;
    const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
    if (a > lines.length) return problems.push(`${label}: ${rel} has only ${lines.length} lines`), null;
    const end = Math.min(b, lines.length);
    const text = lines.slice(a - 1, end).map((l, k) => `${a + k}: ${l}`).join("\n");
    return { id: x.id, path: rel, lines: [a, end], text };
  }).filter(Boolean);
}

/** Validate the claims input: {request, claims: [{text, evidence}], excerpts?}. */
export function validateRunInput(input) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["input must be a JSON object {request, claims, excerpts?}"];
  for (const [key, why] of Object.entries(REJECTED_KEYS)) if (key in input) problems.push(`${key} is not accepted: ${why}`);
  for (const key of Object.keys(input)) if (!INPUT_KEYS.has(key) && !(key in REJECTED_KEYS)) problems.push(`unknown key ${key}`);
  if (typeof input.request !== "string" || input.request.trim() === "") problems.push("request must be the user's request, a non-empty string");
  if (!Array.isArray(input.claims) || input.claims.length === 0) problems.push("claims must be a non-empty array of {text, evidence: [ids]}");
  if (input.excerpts !== undefined && !Array.isArray(input.excerpts)) problems.push("excerpts must be an array");
  return problems;
}

/** Session directory and identity for receipts, or null (no jev-flow session). */
export function runnerSession(repoRoot, { sessionKeyArg, env = process.env }) {
  let key = null;
  let dir = null;
  if (sessionKeyArg) {
    dir = sessionDirFromKey(repoRoot, sessionKeyArg, env);
    key = dir ? sessionKeyArg : null;
  } else if (typeof env.CLAUDE_CODE_SESSION_ID === "string" && env.CLAUDE_CODE_SESSION_ID !== "") {
    // Claude Code exports the session id to Bash; the hook uses the same id.
    key = sessionKey(env.CLAUDE_CODE_SESSION_ID);
    dir = sessionDir(repoRoot, env.CLAUDE_CODE_SESSION_ID, env);
  }
  if (!dir || !readReceiptKey(dir)) return null;
  return { key, dir };
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/**
 * Aggregation orders, least to most severe (R5). The semantic verdict of a
 * batch is the most severe verdict of its evaluated parts; the operational
 * status is the most severe condition of the run; a claim's overall verdict is
 * the most severe verdict of its occurrences (a contradiction is never hidden
 * by an occurrence that was not evaluated).
 */
export const VERDICT_ORDER = Object.freeze(["accepted", "needs_evidence", "ask_user", "escalate", "contradicted"]);
export const STATUS_ORDER = Object.freeze(["ok", "unavailable", "checks_failed", "snapshot_changed"]);
export const CLAIM_ORDER = Object.freeze(["verified", "unsupported", "unevaluated", "contradicted"]);

/** The most severe of `values` under `order` (values outside the order are ignored); order[0] when none. */
export function worst(order, values) {
  return values.reduce((w, v) => (order.indexOf(v) > order.indexOf(w) ? v : w), order[0]);
}

/** A claim's overall verdict from its occurrences' verdicts (anything unknown counts as unevaluated). */
export function claimVerdict(verdicts) {
  const known = verdicts.map((v) => (CLAIM_ORDER.includes(v) && v !== "unevaluated" ? v : "unevaluated"));
  return known.length ? worst(CLAIM_ORDER, known) : "unevaluated";
}

/** Semantic verdict of one evaluated part from its interpretGate route and gate action. */
export function partVerdict(route, action) {
  if (route === "accepted") return "accepted";
  if (route === "needs_evidence") return "needs_evidence";
  if (route === "stop_contradiction") return "contradicted";
  return action === "escalate" ? "escalate" : "ask_user";
}

/**
 * The label that decides the exit code, from the semantic verdict (null when
 * no part was evaluated) and the operational status: a contradiction first,
 * then a changed snapshot, a failed check, Jev unavailable, then any
 * non-accepted verdict. Returns [outcome, exit].
 */
export function decideOutcome(verdict, status) {
  if (verdict === "contradicted") return ["contradicted", EXIT.not_accepted];
  if (status === "snapshot_changed") return ["snapshot_changed", EXIT.invalid];
  if (status === "checks_failed") return ["checks_failed", EXIT.not_accepted];
  if (status === "unavailable" || verdict === null) return ["unavailable", EXIT.unavailable];
  if (verdict !== "accepted") return [verdict, EXIT.not_accepted];
  return ["accepted", EXIT.accepted];
}

/**
 * Summary within RUN_LIMITS.summaryChars (8 KB). When too large, it is
 * compacted step by step and never loses a part, a check, a limit or a
 * claim's overall verdict: first the per-occurrence detail is dropped
 * (`occurrences_omitted: n`), then long limit lists become counts
 * (`{count: n}`) and redactions are summed per kind, problems are capped
 * (the omission is stated), then claims become verdict → claim-number ranges
 * (`{"verified": "1-12,14", "contradicted": "13"}`), parts become tuples
 * `[part, verdict|state, action, [reason_codes], safe_to_apply]` and checks
 * `[n, exit, ...flags]`. `summary_truncated: true` marks any compaction; no
 * reason code is cut.
 */
export function compactSummary(summary, max = RUN_LIMITS.summaryChars) {
  let out = JSON.stringify(summary);
  if (out.length <= max) return out;
  const s = structuredClone(summary);
  s.summary_truncated = true;
  const count = (key) => {
    if (Array.isArray(s.limits?.[key])) s.limits[key] = { count: s.limits[key].length };
  };
  const steps = [
    () => {
      if (Array.isArray(s.occurrences)) {
        s.occurrences_omitted = s.occurrences.length;
        delete s.occurrences;
      }
    },
    () => {
      for (const key of ["uncited_hunks", "unattributed", "preexisting_mixed", "unevaluated"]) count(key);
      if (Array.isArray(s.limits?.redactions)) {
        const byKind = {};
        for (const r of s.limits.redactions) byKind[r?.kind ?? "unknown"] = (byKind[r?.kind ?? "unknown"] ?? 0) + (Number.isInteger(r?.count) ? r.count : 1);
        s.limits.redactions = byKind;
      }
      if (Array.isArray(s.limits?.checks_output_cut)) s.limits.checks_output_cut = Object.fromEntries(s.limits.checks_output_cut.map((c) => [c.n, c.chars]));
    },
    () => {
      if (Array.isArray(s.problems)) {
        if (s.problems.length > 6) s.problems = [...s.problems.slice(0, 6), `… ${s.problems.length - 6} more problem(s) omitted`];
        s.problems = s.problems.map((p) => clip(p, 160));
      }
      if (typeof s.reason === "string") s.reason = clip(s.reason, 600);
    },
    () => {
      if (Array.isArray(s.claims)) s.claims = claimsByVerdict(s.claims);
    },
    () => {
      if (Array.isArray(s.parts)) s.parts = s.parts.map((p) => [p.part, p.verdict ?? p.state, p.action ?? null, p.reason_codes ?? [], p.safe_to_apply ?? null]);
      if (Array.isArray(s.checks)) {
        s.checks = s.checks.map((c) => [c.n, c.exit, ...(c.timed_out ? ["timed_out"] : []), ...(c.start_failed ? ["start_failed"] : []), ...(c.cut_chars ? [`cut:${c.cut_chars}`] : [])]);
      }
    },
    () => {
      if (Array.isArray(s.problems)) s.problems = s.problems.map((p) => clip(p, 80));
      if (typeof s.reason === "string") s.reason = clip(s.reason, 200);
    },
  ];
  for (const step of steps) {
    step();
    out = JSON.stringify(s);
    if (out.length <= max) return out;
  }
  // Not reached for a batch within the limits (at most 16 parts, 8 checks); nothing required is ever dropped.
  return out;
}

/** Overall claim verdicts grouped by verdict, claim numbers as ranges ("1-12,14"). */
function claimsByVerdict(claims) {
  const grouped = {};
  for (const { c, verdict } of claims) (grouped[verdict] ??= []).push(c ?? 0);
  return Object.fromEntries(Object.entries(grouped).map(([verdict, nums]) => [verdict, ranges(nums)]));
}

function ranges(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(",");
}

/** 1-based claim number by claim text as sent (sanitized and trimmed, like prepareGateBatch). */
function claimIndex(claims) {
  const index = new Map();
  claims.forEach((c, i) => {
    const text = typeof c?.text === "string" ? sanitizeText(c.text.trim()).text : "";
    if (!index.has(text)) index.set(text, i + 1);
  });
  return index;
}

const round3 = (x) => (typeof x === "number" ? Number(x.toFixed(3)) : null);

/** One occurrence per claim a part carried: {c, part, verdict, confidence} (confidence null when not evaluated). */
function partOccurrences(call, result, index) {
  const results = Array.isArray(result?.verification?.results) ? result.verification.results : [];
  return call.input.claims.map((text) => {
    const r = result ? results.find((x) => String(x?.claim ?? "").trim() === text) : undefined;
    const verdict = r && ["verified", "contradicted", "unsupported"].includes(r.verdict) ? r.verdict : "unevaluated";
    return { c: index.get(text) ?? null, part: call.part, verdict, confidence: verdict === "unevaluated" ? null : round3(r?.confidence) };
  });
}

/**
 * Start a gate attempt as early as possible (before any validation that can
 * fail): with a jev-flow session, a pending gate attempt is recorded now, so
 * from here on it supersedes any earlier gate, even if this invocation fails,
 * is refused or is interrupted. Returns a handle used by runGate.
 */
export function startAttempt({ repoRoot, sessionKeyArg, env = process.env, now = Date.now }) {
  const session = repoRoot ? runnerSession(repoRoot, { sessionKeyArg, env }) : null;
  const id = newReceiptId();
  const s0 = repoRoot ? computeSnapshot(repoRoot).hash : null;
  let attempt = null;
  if (session) {
    try {
      attempt = withState(session.dir, (state) => {
        const rec = { kind: "gate", runner: id, before: s0 ?? "unknown", input: "unknown", req: state.request.seq, boot: state.boot, ts: now() };
        state.pending[`run-${id}`] = rec;
        return { req: rec.req, boot: rec.boot, ts: rec.ts };
      }, now());
    } catch {
      attempt = null;
    }
  }
  const handle = {
    session,
    id,
    s0,
    attempt,
    closed: false,
    meta: {},
    /** Coverage metadata of the prepared batch (claim-set, whole-diff and batch hashes, claim ids). */
    setPrepared(meta) {
      handle.meta = meta;
      if (!attempt) return;
      try {
        withState(session.dir, (state) => {
          const p = state.pending[`run-${id}`];
          if (p) Object.assign(p, meta);
        }, now());
      } catch {
        // The pending attempt stays without coverage metadata; it still blocks acceptance.
      }
    },
    /** Close the attempt: failed (no verdict) or finished with a receipt; record the real checks. */
    close({ after = "unknown", failed = true, tests = [], input = null } = {}) {
      if (!attempt || handle.closed) return;
      handle.closed = true;
      try {
        withState(session.dir, (state) => {
          delete state.pending[`run-${id}`];
          state.gates.push({
            id: `run-${id}`,
            runner: id,
            req: attempt.req,
            boot: attempt.boot,
            input: input === null ? "unknown" : inputHash(input),
            before: s0 ?? "unknown",
            after,
            ts: attempt.ts,
            failed,
            ...handle.meta,
          });
          for (const t of tests) {
            state.tests.push({ cmd: commandHash(t.argv), req: attempt.req, boot: attempt.boot, before: s0 ?? "unknown", after: t.after, exit: t.exit, failed: !checkPassed(t), ts: attempt.ts });
            state.counters.tests += 1;
          }
        }, now());
      } catch {
        // Unrecorded: the pending attempt stays and keeps completion unverified.
      }
    },
  };
  return handle;
}

/**
 * Run the gate. `opts`: {repoRoot, denylist, input, checks (argv arrays),
 * checkTimeoutMs, attempt (from startAttempt), sessionKeyArg, env, now}.
 * Returns {code, summary} (summary is an object; the CLI prints
 * compactSummary(summary)). Acceptance needs every part auto and valid AND
 * every check passing (exit 0, no timeout, started).
 */
export async function runGate(opts) {
  const { repoRoot, denylist, input, checks = [], env = process.env } = opts;
  const now = opts.now ?? Date.now;
  const handle = opts.attempt ?? startAttempt({ repoRoot, sessionKeyArg: opts.sessionKeyArg, env, now });
  const { session, s0, attempt } = handle;
  const summary = { jev_flow_gate_run: 1, outcome: null, verdict: null, status: null, exit: null, receipt: null };
  // Before the gate, the operational status is also the outcome (disabled, invalid_input, not_ready, unavailable).
  const finish = (status, code, extra = {}) => {
    Object.assign(summary, { outcome: status, status, exit: code }, extra);
    return { code, summary };
  };
  if (!session) summary.receipt_note = "no jev-flow session key: this result is not recorded as completion evidence";
  else if (!attempt) summary.receipt_note = "the session state could not be updated: this result is not recorded as completion evidence";
  if (denylist.disabled) {
    handle.close();
    return finish("disabled", EXIT.unavailable, { message: FIXED_PHRASES.disabled });
  }
  const inputProblems = validateRunInput(input);
  if (checks.length > RUN_LIMITS.maxChecks) inputProblems.push(`at most ${RUN_LIMITS.maxChecks} --check commands`);
  if (inputProblems.length) {
    handle.close();
    return finish("invalid_input", EXIT.invalid, { problems: inputProblems });
  }
  if (!s0) {
    handle.close();
    return finish("not_ready", EXIT.invalid, { problems: ["the work-tree snapshot could not be computed"] });
  }
  summary.snapshot = s0.slice(0, 16);

  // Real checks, run here on the frozen snapshot, as argv without a shell.
  const ran = [];
  for (const argv of checks) ran.push(await runCheck(repoRoot, argv, { timeoutMs: opts.checkTimeoutMs, env }));
  const checksOk = ran.every(checkPassed);
  summary.checks = ran.map((c, i) => ({
    n: i + 1,
    command: clip(c.command, 120),
    exit: c.exit,
    ...(c.timed_out ? { timed_out: true } : {}),
    ...(c.start_failed ? { start_failed: true } : {}),
    ...(c.cut_chars ? { cut_chars: c.cut_chars } : {}),
  }));
  const s1 = computeSnapshot(repoRoot).hash;
  const checkRecords = ran.map((c) => ({ ...c, after: s1 ?? "unknown" }));
  if (s1 !== s0) {
    handle.close({ tests: checkRecords, input });
    return finish("not_ready", EXIT.invalid, { problems: ["the work tree changed while the checks ran (a check writes tracked or non-ignored files); freeze the snapshot and run again"] });
  }

  let patch;
  let prepared;
  try {
    patch = collectPatch(repoRoot, session ? readBaseline(session.dir) : null);
    summary.base = patch.base;
    if (patch.diff.trim() === "") throw new RunError("not_ready", "empty diff: there is no change to gate");
    const problems = [];
    const excerpts = readExcerpts(repoRoot, input.excerpts ?? [], problems);
    if (problems.length) throw new RunError("invalid_input", "invalid excerpts", problems);
    prepared = prepareGateBatch(
      {
        request: input.request,
        diff: patch.diff,
        claims: input.claims,
        commands: ran.map((c) => ({
          command: c.command,
          exit: c.exit,
          output: c.timed_out ? `${c.output}\n[jev-flow: timed out after ${Math.round((opts.checkTimeoutMs ?? RUN_LIMITS.checkTimeoutMs) / 1000)} s; killed]` : c.output,
        })),
        excerpts,
      },
      { denylist, snapshot: s0 },
    );
  } catch (error) {
    handle.close({ tests: checkRecords, input });
    if (error instanceof RunError) return finish(error.status, EXIT.invalid, { problems: error.problems.length ? error.problems : [error.message] });
    throw error;
  }
  summary.limits = {
    redactions: prepared.limits.redactions,
    uncited_hunks: prepared.limits.uncited_hunks,
    tests_truncated_chars: prepared.limits.tests_truncated_chars,
    checks_output_cut: ran.map((c, i) => ({ n: i + 1, chars: c.cut_chars })).filter((c) => c.chars > 0),
    unattributed: patch.unattributed,
    preexisting_mixed: patch.preexisting_mixed,
    unevaluated: patch.unevaluated,
    partitioned: prepared.limits.partitioned,
  };
  if (!prepared.ok) {
    handle.close({ tests: checkRecords, input });
    return finish("not_ready", EXIT.invalid, { problems: prepared.problems });
  }
  summary.batch = { id: prepared.batch.id, parts: prepared.batch.parts, slices: prepared.batch.slices };
  const sentClaims = [...new Set(prepared.calls.flatMap((c) => c.input.claims))];
  // From here the attempt carries its coverage metadata (F3): a later gate on this request and snapshot must cover it.
  handle.setPrepared({ claims: prepared.batch.claims, diff: prepared.batch.diff, rbatch: prepared.batch.id, claim_ids: sentClaims.map((t) => sha256(t).slice(0, 16)) });

  const n = prepared.calls.length;
  // One report and one receipt from the same per-part record of the whole batch (R5).
  const parts = [];
  const occurrences = [];
  const index = claimIndex(input.claims);
  const coverage = () => {
    const count = (state) => parts.filter((p) => p.state === state).length;
    const evaluated = parts.filter((p) => !p.state).length;
    return { planned: n, sent: evaluated + count("unavailable"), evaluated, unavailable: count("unavailable"), unevaluated: count("unevaluated") };
  };
  const markUnevaluated = (call, reason) => {
    parts.push({ part: call.part, state: "unevaluated", reason, action: null, reason_codes: [] });
    occurrences.push(...partOccurrences(call, null, index));
  };

  const writeRunReceipt = (fields) => {
    if (!session || !attempt) return;
    try {
      const receipt = writeReceipt(session.dir, {
        v: 2,
        id: handle.id,
        session: session.key,
        repo: repoKey(repoRoot),
        req: attempt.req,
        boot: attempt.boot,
        snap: s0,
        base: patch.base.commit,
        base_mode: patch.base.mode,
        batch: prepared.batch.id,
        parts: n,
        // Per planned part, in order: its number, its gate action ("auto" when accepted) or state, its verdict codes.
        part_ids: parts.map((p) => p.part),
        actions: parts.map((p) => p.state ?? (p.verdict === "accepted" ? "auto" : String(p.action ?? "unknown"))),
        verdicts: parts.map((p) => p.codes ?? []),
        coverage: coverage(),
        claims: prepared.batch.claims,
        diff: prepared.batch.diff,
        claim_ids: handle.meta.claim_ids,
        checks: ran.map((c, i) => ({ n: i + 1, cmd: commandHash(c.argv), exit: c.exit, timed_out: c.timed_out === true, start_failed: c.start_failed === true })),
        ts_start: attempt.ts,
        ts_end: now(),
        ...fields,
      });
      summary.receipt = receipt.id;
    } catch {
      summary.receipt_note = "the receipt could not be written: this result is not recorded as completion evidence";
    }
  };

  const jev = await openJev(env);
  if (!jev.ok && jev.config) {
    // An invalid server configuration is an input problem: nothing was evaluated or attempted.
    handle.close({ tests: checkRecords, input });
    return finish("invalid_input", EXIT.invalid, { problems: [jev.reason] });
  }
  // Every part is sent, in order. Only a contradicted claim stops the batch
  // early. After a part fails for good (after the per-call retry), the next
  // part gets one reconnection; if it fails, the remaining parts are listed
  // as unevaluated and nothing more is sent. Without credentials, or when the
  // server cannot start, every part is listed as unevaluated and the run goes
  // through the same aggregation (snapshot, checks, outcome, receipt).
  const unavailable = [];
  let calls = 0;
  let reconnects = 0;
  let stopped = null;
  let reconnect = false;
  if (!jev.ok) {
    unavailable.push(`the jev MCP server could not be used: ${clip(jev.reason, 300)}`);
    for (const call of prepared.calls) markUnevaluated(call, "jev_unavailable");
  } else {
    try {
      for (const call of prepared.calls) {
        if (stopped) {
          markUnevaluated(call, stopped);
          continue;
        }
        if (reconnect) {
          reconnect = false;
          reconnects += 1;
          const reopened = await jev.reopen();
          if (!reopened.ok) {
            stopped = "reconnect_failed";
            unavailable.push(`reconnect before part ${call.part} failed: ${clip(reopened.reason, 200)}`);
            markUnevaluated(call, stopped);
            continue;
          }
        }
        // interpretGate's retry_or_unavailable route (malformed or invalid answer) is retried once with identical input.
        const reply = await callWithRetry(jev, "jev_gate", call.input, { invalid: (result) => interpretGate(result, { claims: call.input.claims }).route === "retry_or_unavailable" });
        calls += reply.attempts ?? 0;
        if (!reply.ok) {
          unavailable.push(`part ${call.part}: ${reply.kind}: ${clip(reply.message, 200)}${reply.retry ? ` (retry ${reply.retry})` : ""}; ${reply.attempts} call(s) sent`);
          parts.push({ part: call.part, state: "unavailable", action: null, reason_codes: [] });
          occurrences.push(...partOccurrences(call, null, index));
          reconnect = true;
          continue;
        }
        let { route } = interpretGate(reply.result, { claims: call.input.claims });
        if (route === "accepted" && !validateGateResult(reply.result, { claims: call.input.claims }).accepted) route = "ask_user";
        if (!summary.jev) summary.jev = { provider: clip(reply.result.provider ?? "unknown", 40), model: clip(reply.result.model ?? "unknown", 60) };
        const verdict = partVerdict(route, reply.result.action);
        parts.push({
          part: call.part,
          verdict,
          action: reply.result.action ?? null,
          reason_codes: Array.isArray(reply.result.reason_codes) ? reply.result.reason_codes : [],
          safe_to_apply: round3(reply.result.review?.safe_to_apply),
          codes: (reply.result.verification?.results ?? []).map((r) => String(r?.verdict ?? "none")),
        });
        occurrences.push(...partOccurrences(call, reply.result, index));
        if (verdict === "contradicted") stopped = "not_sent_after_contradiction";
      }
    } finally {
      await jev.close();
    }
  }

  const evaluated = parts.filter((p) => !p.state);
  const verdict = evaluated.length ? worst(VERDICT_ORDER, evaluated.map((p) => p.verdict)) : null;
  const s2 = computeSnapshot(repoRoot).hash;
  const conditions = [];
  if (s2 !== s0) conditions.push("snapshot_changed");
  // A failing, unknown or timed-out check forbids acceptance whatever the gate said.
  if (!checksOk) conditions.push("checks_failed");
  if (parts.some((p) => p.state === "unavailable" || (p.state === "unevaluated" && p.reason !== "not_sent_after_contradiction"))) conditions.push("unavailable");
  const status = worst(STATUS_ORDER, conditions);
  const [outcome, code] = decideOutcome(verdict, status);
  const accepted = outcome === "accepted" && evaluated.length === n && evaluated.every((p) => p.verdict === "accepted");

  const byClaim = new Map();
  for (const o of occurrences) byClaim.set(o.c, [...(byClaim.get(o.c) ?? []), o.verdict]);
  Object.assign(summary, {
    parts: parts.map(({ codes, ...p }) => p),
    claims: [...byClaim.entries()].sort(([a], [b]) => (a ?? 0) - (b ?? 0)).map(([c, vs]) => ({ c, verdict: claimVerdict(vs) })),
    occurrences,
    coverage: coverage(),
    jev_calls: calls,
    ...(reconnects ? { reconnects } : {}),
  });
  writeRunReceipt({ snap_after: s2 ?? "unknown", verdict, status, outcome, accepted });
  // An attempt in which no part was evaluated is a failed attempt (no verdict).
  handle.close({ after: s2 ?? "unknown", failed: evaluated.length === 0, tests: checkRecords, input });
  const problems = [];
  if (conditions.includes("snapshot_changed")) problems.push("the work tree changed during the gate; run again on a frozen snapshot");
  if (conditions.includes("checks_failed")) problems.push("a check failed, timed out, could not start or has an unknown exit code; the gate cannot be accepted (see checks)");
  // Every operational condition is listed, also those the outcome does not name.
  const extra = { verdict, conditions, ...(problems.length ? { problems } : {}) };
  if (conditions.includes("unavailable")) Object.assign(extra, { message: FIXED_PHRASES.unavailable, reason: unavailable.join("; ") });
  Object.assign(summary, { outcome, status, exit: code }, extra);
  return { code, summary };
}

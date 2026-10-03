#!/usr/bin/env node
// jev-control command line (Node 22, standard library plus the jev-flow modules).
// Jev is called here, outside the model's context, with compact one-line JSON
// output (at most 1.5 KB). Usage (the plugin root is ${CLAUDE_PLUGIN_ROOT}):
//   cli.mjs help [command]   (also <command> --help: usage and the decide batch format; needs no session)
//   cli.mjs on [--threshold x] [--priorities "one line"]
//   cli.mjs off | status | threshold <x>
//   cli.mjs decide --file <batch.json|-> [--decision-id id] [--headless] [--source subagent]
//   cli.mjs search --query <text> [--single] [--exact-path p] [--search-id id --widen] [--source subagent]
//   cli.mjs page --decision id [--part plan|scores] [--from n]
//   cli.mjs approve --decision id --option id --message "<the user's words naming the option>" [--question "<the question a short answer answers>"]
//   cli.mjs budget status|reserve --tool noul [--source main|subagent]|confirm --id x [--ok 0|1] [--ms n]|release --id x|approve --message "<the user's words about the budget>" [--question "<the question a short answer answers>"] [--n 25]
//   cli.mjs receipt verify --id x --option id (--action-file <file|-> | --tool T --target t) [--dry-run]
//   cli.mjs done --claims <file|-> [--check '["cmd","arg"]']... [--check-timeout s]
// Common: [--root <repo>] [--session-id <id>] [--session-cap <capability>]. The
// session is the one in an explicit --session-id (operators and tests), in
// CLAUDE_CODE_SESSION_ID, or the one proven by the per-session capability the hook
// injected into that session's context (--session-cap, which must also be passed
// to subagents); with none of them there is no identity: nothing is activated,
// read or recorded, and the most recent session is never guessed.
// Exit codes: 0 ok / selected / ordered / found, 2 needs the user (expand, ask_user,
// incomplete, none eligible, budget), 3 Jev unavailable, 4 invalid or refused, 1 internal.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDenylist } from "../jev-flow/paths.mjs";
import { sanitizeText } from "../jev-flow/sanitize.mjs";
import { computeSnapshot, gitTopLevel } from "../jev-flow/state.mjs";
import { normalizeDescriptor, planItem } from "./actions.mjs";
import { optionScope, readMessage } from "./authorization.mjs";
import { approveMore, budgetView, confirm, release, reserve, startRequest } from "./budget.mjs";
import { BudgetedCaller } from "./client.mjs";
import { checkTools } from "./contracts.mjs";
import { runControlDone } from "./done.mjs";
import { helpText } from "./help.mjs";
import { normalizeBatch } from "./options.mjs";
import { runDecision } from "./protocol.mjs";
import { verifyDecisionReceipt, writeDecisionReceipt } from "./receipts.mjs";
import { controlSearch } from "./search.mjs";
import { controlSessionDir, hasSessionId, loadControlState, oneLine, repoKey, sessionKey, verifySessionCap, withControlState } from "./state.mjs";
import { DEFAULT_THRESHOLD, parseThreshold, resolveThreshold } from "./threshold.mjs";

const OUT_MAX = 1500;
const EXIT = { ok: 0, internal: 1, user: 2, unavailable: 3, invalid: 4 };

const STATUS_EXIT = {
  selected: EXIT.ok, ordered: EXIT.ok, found: EXIT.ok, direct_read: EXIT.ok,
  expand: EXIT.user, ask_user: EXIT.user, incomplete: EXIT.user, none_eligible: EXIT.user, none_candidates: EXIT.user, budget_exhausted: EXIT.user,
  search_budget_exhausted: EXIT.user, tie_unresolved: EXIT.user,
  unavailable: EXIT.unavailable, invalid: EXIT.invalid, refused: EXIT.invalid,
};

class UsageError extends Error {}

function parseFlags(argv, { values = [], bools = [], multi = [] } = {}) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (bools.includes(name)) flags[name] = true;
      else if (values.includes(name) || multi.includes(name)) {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        const v = argv[++i];
        if (multi.includes(name)) (flags[name] ??= []).push(v);
        else flags[name] = v;
      } else throw new UsageError(`unknown argument: ${arg}`);
    } else flags._.push(arg);
  }
  return flags;
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** Shorten the free-text parts of a status object; decision data (plan, scores, ids) is never shortened here. */
function shrink(o, max) {
  const steps = [
    () => { if (typeof o.message === "string") o.message = o.message.slice(0, 200); },
    () => { if (Array.isArray(o.problems)) o.problems = o.problems.slice(0, 3).map((p) => String(p).slice(0, 120)); },
    () => { if (typeof o.report === "string") o.report = o.report.slice(0, 200); },
    () => { if (Array.isArray(o.unavailable) && o.unavailable.length > 6) o.unavailable = [...o.unavailable.slice(0, 6), `…${o.unavailable.length - 6} more`]; },
    () => { if (Array.isArray(o.unresolved) && o.unresolved.length > 6) o.unresolved = [...o.unresolved.slice(0, 6), `…${o.unresolved.length - 6} more`]; },
    () => { if (typeof o.message === "string") o.message = o.message.slice(0, 80); },
    () => { delete o.problems; },
  ];
  for (const step of steps) {
    if (bytes(o) <= max) break;
    step();
  }
  return o;
}

/**
 * One line of JSON of at most `max` bytes. Free text is shortened first. The decision lists
 * (`plan` and `scores`: arrays of compact strings) are NEVER cut silently: as many items as fit
 * are printed together with `<list>_total` and, when items remain, `<list>_next` (the index to
 * pass to `cli.mjs page --from`). `from` gives the first index of a list (paging).
 */
export function compactOut(object, max = OUT_MAX, { from = {} } = {}) {
  const o = { ...object };
  const lists = {};
  for (const key of ["plan", "scores"]) {
    if (Array.isArray(o[key])) {
      lists[key] = o[key];
      delete o[key];
    }
  }
  shrink(o, max - (Object.keys(lists).length ? 60 : 0));
  for (const [key, items] of Object.entries(lists)) {
    const start = from[key] ?? 0;
    const candidate = (k) => ({ ...o, [key]: items.slice(start, start + k), [`${key}_total`]: items.length, ...(start + k < items.length ? { [`${key}_next`]: start + k } : {}) });
    let k = 0;
    while (start + k < items.length && bytes(candidate(k + 1)) <= max) k += 1;
    Object.assign(o, candidate(k));
  }
  return JSON.stringify(o);
}

function print(object) {
  process.stdout.write(`${compactOut(object)}\n`);
}

// What the model sees right after `on` (R02: two dev sessions switched the mode on and then took no decision and ran no search).
const NEXT_AFTER_ON = "act only through the helper from now on: several tasks or ways to do one are a decision (decide --file <batch>), a user phrase such as \"choose the order yourself\" hands that choice to Jev, files are found with search, completion is /jev:jev-done; the batch format is in `help decide`, the search form in `help search` (SKILL.md may be unreadable)";

function resolveSession(repoRoot, flags, env) {
  const id = flags["session-id"] ?? env.CLAUDE_CODE_SESSION_ID;
  let proven = null;
  if (flags["session-cap"] !== undefined) {
    proven = verifySessionCap(repoRoot, flags["session-cap"], env);
    if (!proven.ok) return { ok: false, reason: `the session capability is not valid (${proven.reason}); use the line the hook injected into this session, or ask the user to run /jev:jev-control on again` };
  }
  if (hasSessionId(id)) {
    if (proven && proven.key !== sessionKey(id)) return { ok: false, reason: "identity_conflict: the session capability belongs to another session than the one in this environment; nothing is read or recorded" };
    return { ok: true, key: sessionKey(id), dir: controlSessionDir(repoRoot, id, env), via: flags["session-id"] ? "argument" : "environment" };
  }
  if (proven) return { ok: true, key: proven.key, dir: proven.dir, via: "capability" };
  return { ok: false, reason: "no verifiable session identity: CLAUDE_CODE_SESSION_ID is not set and no --session-cap was given (the hook injects the capability when the user activates the mode); nothing is activated or recorded, and no recent session is guessed" };
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

function sanitizeBatch(batch) {
  const clean = (t) => sanitizeText(t).text;
  return {
    ...batch,
    decision: clean(batch.decision),
    priorities: clean(batch.priorities),
    options: batch.options.map((o) => ({ ...o, text: clean(o.text), evidence: o.evidence.map(clean) })),
  };
}

async function readJson(source) {
  let raw;
  if (source === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (error) {
      throw new UsageError(`cannot read ${source}: ${error?.code ?? error?.message}`);
    }
  }
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new UsageError("input exceeds 1 MiB");
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError("input is not valid JSON");
  }
}

/** The budget source of a helper call: a subagent that runs the helper says so with --source subagent. */
function callerSource(flags) {
  return flags.source === "subagent" ? "subagent" : "helper";
}

function modeOn(dir) {
  const state = loadControlState(dir);
  return state.mode === "on" ? state : null;
}

const OFF = { status: "refused", message: "jev-control is off for this session: run /jev:jev-control on first" };

async function cmdOn(flags, ctx) {
  if (nodeMajor() < 22) return { status: "refused", message: `Node ${process.versions.node} is too old: jev-control needs Node 22 or newer` };
  if (loadDenylist(ctx.repoRoot).disabled) return { status: "refused", message: "the repository opts out of Jev (.jev-flow-denylist): jev-control does not start" };
  const threshold = resolveThreshold({ session: flags.threshold ?? null, env: ctx.env });
  const caller = new BudgetedCaller({ dir: ctx.dir, env: ctx.env });
  const session = await caller.open();
  if (!session.ok) return { status: "refused", message: `Jev unavailable, so the tool contracts cannot be checked and the mode does not start: ${String(session.reason).slice(0, 200)}` };
  let listed;
  try {
    listed = await caller.listTools(session);
  } finally {
    await session.close();
  }
  if (!listed.ok) return { status: "refused", message: `tools/list failed: ${listed.reason.slice(0, 200)}` };
  const check = checkTools({ tools: listed.tools });
  if (!check.ok) {
    return { status: "refused", message: `a core Jev tool is missing or incompatible: ${[...check.missing, ...check.incompatible.map((i) => `${i.tool} (${i.reason})`)].join(", ")}` };
  }
  const server = listed.serverInfo ? oneLine(`${listed.serverInfo.name ?? "server"}@${listed.serverInfo.version ?? "?"}`, 80) : "unknown";
  withControlState(ctx.dir, (state) => {
    state.mode = "on";
    state.threshold = { value: threshold.value, source: threshold.source, since_decision: state.decisions.length };
    if (typeof flags.priorities === "string" && flags.priorities.trim() !== "") state.priorities = oneLine(sanitizeText(flags.priorities).text);
    state.server = server;
    state.audit = check.audit;
    if (threshold.notice) state.notices.push(oneLine(threshold.notice));
    if (state.request.seq === 0) startRequest(state);
  });
  const state = loadControlState(ctx.dir);
  return {
    status: "ok",
    mode: "on",
    threshold: state.threshold.value,
    threshold_source: state.threshold.source,
    priorities: state.priorities || null,
    audit: check.audit ? "available" : "unavailable (that function is off; the rest works)",
    server,
    tool_prefix: check.prefix || null,
    session: ctx.via,
    flow: "jev-flow directives are suppressed while the mode is on",
    next: NEXT_AFTER_ON,
    ...(threshold.notice ? { notice: threshold.notice } : {}),
    ...(!state.priorities ? { note: "priorities not set: pass --priorities \"<one line from the user's request>\" or put them in each batch" } : {}),
  };
}

function cmdStatus(ctx) {
  const state = loadControlState(ctx.dir);
  return {
    status: "ok",
    mode: state.mode,
    threshold: state.threshold.value,
    threshold_source: state.threshold.source,
    priorities: state.priorities || null,
    request: state.request.seq,
    budget: budgetView(state),
    audit: state.audit ? "available" : "unavailable",
    server: state.server,
    decisions: state.decisions.length,
    approvals: state.approvals.length,
    ...(state.notices.length ? { notices: state.notices.slice(-2) } : {}),
  };
}

function cmdThreshold(flags, ctx) {
  const raw = flags._[1];
  const parsed = parseThreshold(raw);
  const value = parsed.ok ? parsed.value : DEFAULT_THRESHOLD;
  const notice = parsed.ok ? null : `jev-control: threshold ${String(raw).slice(0, 40)} is not a number in (0.5, 1) (${parsed.reason}); using ${DEFAULT_THRESHOLD}`;
  withControlState(ctx.dir, (state) => {
    state.threshold = { value, source: parsed.ok ? "session" : "default", since_decision: state.decisions.length };
    if (notice) state.notices.push(oneLine(notice));
  });
  return { status: "ok", threshold: value, applies_to: "later decisions only", ...(notice ? { notice } : {}) };
}

/**
 * What a decision result prints: no provenance (it goes to the receipt), the plan as compact
 * items (id:step:raw score:action hash) and, for a stop, the scores as "id:raw" sorted descending.
 */
export function printable(result) {
  const o = { ...result };
  delete o.provenance;
  if (Array.isArray(o.plan)) o.plan = o.plan.map((p) => (typeof p === "string" ? p : planItem(p)));
  if (o.scores && !Array.isArray(o.scores)) {
    if (["selected", "ordered"].includes(o.status)) delete o.scores;
    else o.scores = Object.entries(o.scores).sort((x, y) => y[1] - x[1]).map(([id, p]) => `${id}:${p}`);
  }
  return o;
}

async function cmdDecide(flags, ctx) {
  const state = modeOn(ctx.dir);
  if (!state) return OFF;
  if (loadDenylist(ctx.repoRoot).disabled) return { status: "refused", message: "the repository opts out of Jev (.jev-flow-denylist): nothing is sent" };
  if (!flags.file) throw new UsageError("--file is required");
  const normalized = normalizeBatch(await readJson(flags.file), { root: ctx.repoRoot });
  if (!normalized.ok) return { status: "invalid", problems: normalized.problems.slice(0, 6), message: normalized.problems[0] };
  const batch = sanitizeBatch(normalized.batch);
  const priorities = batch.priorities || state.priorities;
  const caller = new BudgetedCaller({ dir: ctx.dir, env: ctx.env, source: callerSource(flags) });
  const session = await caller.open();
  if (!session.ok) return { status: "unavailable", message: `Jev unavailable: ${String(session.reason).slice(0, 200)}` };
  let snapshot = null;
  try {
    snapshot = computeSnapshot(ctx.repoRoot).hash;
  } catch {
    snapshot = null;
  }
  let result;
  try {
    result = await runDecision(batch, {
      caller,
      session,
      dir: ctx.dir,
      T: state.threshold.value,
      priorities,
      headless: flags.headless === true || ctx.env.JEV_CONTROL_HEADLESS === "1",
      decisionId: flags["decision-id"],
      repoRoot: ctx.repoRoot,
      now: Date.now,
      snapshot,
      source: callerSource(flags),
    });
  } finally {
    await session.close();
  }
  const shown = printable(result);
  if (["selected", "ordered"].includes(shown.status) && result.provenance) {
    try {
      shown.receipt = writeDecisionReceipt(ctx.dir, {
        session: ctx.key,
        repo: repoKey(ctx.repoRoot),
        req: loadControlState(ctx.dir).request.seq,
        decision: shown.decision_id,
        kind: batch.kind,
        threshold: shown.threshold,
        round: shown.round,
        status: shown.status,
        plan: shown.plan,
        options: result.provenance.options,
        calls: result.provenance.calls,
        tiebreaks: result.provenance.tiebreaks,
        snap: snapshot ? snapshot.slice(0, 16) : "unknown",
      });
    } catch (error) {
      shown.receipt_note = `receipt not written: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  }
  return shown;
}

async function cmdSearch(flags, ctx) {
  const state = modeOn(ctx.dir);
  if (!state) return OFF;
  if (!flags.query && !flags["exact-path"]) throw new UsageError("--query (or --exact-path) is required");
  const caller = new BudgetedCaller({ dir: ctx.dir, env: ctx.env, source: callerSource(flags) });
  const exact = flags["exact-path"] ?? null;
  let session = null;
  if (!exact) {
    session = await caller.open();
    if (!session.ok) return { status: "unavailable", message: `Jev unavailable: ${String(session.reason).slice(0, 200)}` };
  }
  try {
    return await controlSearch(
      { query: flags.query ?? "", single: flags.single === true, exactPath: exact },
      { caller, session, dir: ctx.dir, T: state.threshold.value, repoRoot: ctx.repoRoot, searchId: flags["search-id"], widen: flags.widen === true, priorities: state.priorities, now: Date.now, source: callerSource(flags) },
    );
  } finally {
    await session?.close();
  }
}

function cmdApprove(flags, ctx) {
  if (!modeOn(ctx.dir)) return OFF;
  if (!flags.decision || !flags.option || !flags.message) throw new UsageError("--decision, --option and --message are required");
  return withControlState(ctx.dir, (state) => {
    const decision = [...state.decisions].reverse().find((d) => d.id === flags.decision);
    if (!decision) return { status: "refused", message: "unknown decision id; an approval is bound to a logged decision" };
    const opt = decision.opts.find((o) => o[0] === flags.option);
    if (!opt) return { status: "refused", message: "the option is not in that decision" };
    // Quoting is not approving, and approving something else is not approving this: the words must be an authorization
    // (not a negation, a question, a condition or a quotation) that names THIS option; a short answer needs the question it answers.
    const read = readMessage(flags.message, optionScope(opt[0]), flags.question ?? null);
    if (!read.authorization) return { status: "refused", reason: read.reason === "object_missing" ? "message_not_about_option" : "message_not_authorization", message: read.reason === "object_missing" ? `those words are not a complete approval of running option ${opt[0]} (a granting verb and its id, nothing about testing or discussing it; a bare yes counts only with a one-sentence question naming that one option): ask the user, e.g. "Approve ${opt[0]}?", and pass --question "<the question they answered>" for a short answer` : "those words are not an authorization of the option (a negation, a question, a condition, a quotation or no granting word): ask the user and pass what they answered" };
    state.approvals.push({ decision: decision.id, option: flags.option, hash: opt[2], ah: opt[3] ?? "-", req: state.request.seq, ts: Date.now(), msg: oneLine(sanitizeText(flags.message).text, 200), ...(flags.question ? { q: oneLine(sanitizeText(flags.question).text, 300) } : {}) });
    return { status: "ok", override: "user", decision_id: decision.id, option: flags.option, ah: opt[3] ?? "-", note: "recorded as a user override of exactly this option; it is not a general exception" };
  });
}

/** The next page of a logged decision's plan or scores (what a printed list had to cut). */
function cmdPage(flags, ctx) {
  if (!flags.decision) throw new UsageError("--decision is required");
  const part = flags.part ?? "plan";
  if (!["plan", "scores"].includes(part)) throw new UsageError("--part must be plan or scores");
  const from = flags.from === undefined ? 0 : Number(flags.from);
  if (!Number.isInteger(from) || from < 0) throw new UsageError("--from must be a non-negative integer");
  const decision = [...loadControlState(ctx.dir).decisions].reverse().find((d) => d.id === flags.decision);
  if (!decision) return { status: "refused", message: "unknown decision id" };
  const items = part === "plan" ? decision.order : decision.opts.filter((o) => typeof o[1] === "number").sort((a, b) => b[1] - a[1]).map((o) => `${o[0]}:${o[1]}`);
  if (from > items.length) return { status: "invalid", message: `--from is past the end (${items.length} items)` };
  return { raw: true, line: compactOut({ status: "ok", decision_id: decision.id, part, from, [part]: items }, OUT_MAX, { from: { [part]: from } }) };
}

const BUDGET_REFUSALS = {
  message_required: () => "an approval beyond the budget needs the user's own words: pass --message \"<what the user said>\"; nothing was raised",
  message_not_authorization: () => "those words are not an authorization (a negation, a question, a condition or no granting word): ask the user and pass what they answered; nothing was raised",
  message_not_about_budget: () => "those words are not a complete approval of raising the budget (a budget verb and the budget or calls, nothing about testing or discussing it; a bare «yes» counts only with a one-sentence question that is such an approval: pass --question \"<the question they answered>\"); nothing was raised",
  quantum_ambiguous: () => "the words state a number without saying whether it is an increase («by 30», «30 more») or a total («to 30 calls»): ask the user which; nothing was raised",
  quantum_invalid: () => "the words state a quantity that is not a positive whole number of calls (a fraction, a negative or a grouped number): ask the user how many more calls; nothing was raised",
  quantum_zero: () => "the words authorize zero more calls: nothing was raised",
  limit_not_raised: () => "the words authorize no calls beyond the limit already in force (a total that is already reached): ask the user for more; nothing was raised",
  over_quantum: (r) => `the user's words authorize at most ${r.allowed} more calls: pass --n ${r.allowed} or less, or ask for more; nothing was raised`,
  n_invalid: () => "--n must be a whole number from 1 to 100; nothing was raised",
  approval_already_used: () => "that approval was already used in this request: ask the user again and pass their new words; nothing was raised",
};

function cmdBudget(flags, ctx) {
  const sub = flags._[1] ?? "status";
  if (sub === "status") return { status: "ok", ...budgetView(loadControlState(ctx.dir)) };
  if (sub === "reserve") {
    if (!flags.tool) throw new UsageError("--tool is required");
    const r = reserve(ctx.dir, { tool: flags.tool, source: flags.source ?? "main" });
    return r.ok ? { status: "ok", id: r.id, used: r.view.used, limit: r.view.limit } : { status: "budget_exhausted", message: `Jev call budget exhausted (${r.view.used}/${r.view.limit}): stop and ask the user whether to continue`, ...r.view };
  }
  if (sub === "confirm") return { ...confirm(ctx.dir, flags.id, { ok: flags.ok !== "0", ms: flags.ms === undefined ? null : Number(flags.ms) }), status: "ok" };
  if (sub === "release") return { ...release(ctx.dir, flags.id), status: "ok" };
  if (sub === "approve") {
    // Going past the limit is the user's decision: their own words are recorded, and the audit checks that they said it
    // and that it was an authorization for this quantity (not a quoted refusal, a question or a smaller step).
    const message = sanitizeText(flags.message ?? "").text;
    const question = flags.question === undefined ? null : sanitizeText(flags.question).text;
    const r = approveMore(ctx.dir, flags.n === undefined ? undefined : Number(flags.n), message, Date.now(), question);
    if (!r.ok) return { status: "refused", reason: r.reason, message: BUDGET_REFUSALS[r.reason]?.(r) ?? "nothing was raised" };
    const { ok, n, ...view } = r;
    return { status: "ok", ...view, approval: { n, msg: oneLine(message, 120) } };
  }
  throw new UsageError(`unknown budget subcommand: ${sub}`);
}

async function cmdReceipt(flags, ctx) {
  if (flags._[1] !== "verify" || !flags.id) throw new UsageError("receipt verify --id <id> --option <id> (--action-file <file|-> | --tool <T> --target <t>) [--dry-run]");
  // The action to authorize in full: tool, target and every bound argument (content, replacement, range, prompt, scope).
  // --tool/--target alone cover the tools that have no required argument.
  let raw = null;
  if (flags["action-file"] !== undefined) raw = await readJson(flags["action-file"]);
  else if (flags.tool !== undefined) raw = { tool: flags.tool, target: flags.target ?? "" };
  let action = null;
  if (raw !== null) {
    const d = normalizeDescriptor(raw, ctx.repoRoot);
    if (!d.ok) return { status: "refused", authorized: false, message: d.problems[0] };
    action = d.descriptor;
  }
  let snap = null;
  try {
    snap = computeSnapshot(ctx.repoRoot).hash.slice(0, 16);
  } catch {
    snap = null;
  }
  // Check and consume under one lock: two processes cannot both use the same authorization.
  return withControlState(ctx.dir, (state) => {
    const v = verifyDecisionReceipt(ctx.dir, flags.id, { session: ctx.key, req: state.request.seq, snap, root: ctx.repoRoot, option: flags.option ?? null, action, consumed: state.consumed });
    if (!v.ok) return { status: "refused", authorized: false, message: v.reason, ...(v.detail ? { detail: v.detail } : {}), ...(v.expected ? { expected: v.expected } : {}) };
    if (flags["dry-run"] !== true) state.consumed.push({ receipt: flags.id, option: flags.option, req: state.request.seq, ts: Date.now() });
    return { status: "ok", authorized: true, consumed: flags["dry-run"] !== true };
  });
}

async function cmdDone(flags, ctx) {
  const state = modeOn(ctx.dir);
  if (!state) return OFF;
  if (!flags.claims) throw new UsageError("--claims is required");
  const claims = await readJson(flags.claims);
  const caller = new BudgetedCaller({ dir: ctx.dir, env: ctx.env, source: "gate" });
  const checkTimeoutMs = flags["check-timeout"] ? Number(flags["check-timeout"]) * 1000 : undefined;
  const { code, text } = await runControlDone({ root: ctx.repoRoot, claims, checks: flags.check ?? [], checkTimeoutMs }, { T: state.threshold.value, caller, dir: ctx.dir, sessionKey: ctx.key, env: ctx.env });
  process.stdout.write(`${text}\n`);
  return { raw: true, code };
}

// Flags of the helper (parseFlags and the help detection in main share them).
const FLAGS = {
  values: ["root", "session-id", "session-cap", "threshold", "part", "from", "target", "priorities", "file", "decision-id", "query", "exact-path", "search-id", "decision", "option", "message", "tool", "action-file", "source", "id", "ok", "ms", "n", "question", "claims", "check-timeout"],
  bools: ["headless", "single", "widen", "dry-run"],
  multi: ["check"],
};

/** True when `--help` or `-h` stands as an argument of its own; the value of a flag that takes one (`--query -h`) is not. */
function asksForHelp(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") return true;
    if (args[i].startsWith("--") && (FLAGS.values.includes(args[i].slice(2)) || FLAGS.multi.includes(args[i].slice(2)))) i++;
  }
  return false;
}

export async function main(argv, env = process.env) {
  const cmd = argv[0];
  // `help [command]`, `<command> --help` and `-h` need no session, repository or Jev call (R04).
  if (!cmd || cmd === "help" || asksForHelp(argv.slice(cmd.startsWith("-") ? 0 : 1))) {
    const topic = cmd === "help" ? argv[1] : cmd?.startsWith("-") ? undefined : cmd;
    process.stdout.write(`${helpText(topic)}\n`);
    return EXIT.ok;
  }
  const flags = parseFlags(argv.slice(), FLAGS);
  flags._.shift();
  flags._.unshift(cmd);
  const repoRoot = gitTopLevel(resolve(flags.root ?? "."));
  if (!repoRoot) return (print({ status: "refused", message: "not a git work tree" }), EXIT.invalid);
  const session = resolveSession(repoRoot, flags, env);
  if (!session.ok) return (print({ status: "refused", message: session.reason }), EXIT.invalid);
  const ctx = { repoRoot, env, dir: session.dir, key: session.key, via: session.via };
  let result;
  switch (cmd) {
    case "on": result = await cmdOn(flags, ctx); break;
    case "off":
      withControlState(ctx.dir, (state) => { state.mode = "off"; });
      result = { status: "ok", mode: "off", flow: "jev-flow directives apply again when JEV_FLOW is on" };
      break;
    case "status": result = cmdStatus(ctx); break;
    case "threshold": result = cmdThreshold(flags, ctx); break;
    case "decide": result = await cmdDecide(flags, ctx); break;
    case "search": result = await cmdSearch(flags, ctx); break;
    case "approve": result = cmdApprove(flags, ctx); break;
    case "budget": result = cmdBudget(flags, ctx); break;
    case "receipt": result = await cmdReceipt(flags, ctx); break;
    case "page": result = cmdPage(flags, ctx); break;
    case "done": result = await cmdDone(flags, ctx); break;
    default: throw new UsageError(`unknown command: ${cmd}`);
  }
  if (result.raw) {
    if (result.line) {
      process.stdout.write(`${result.line}\n`);
      return EXIT.ok;
    }
    return result.code;
  }
  print(result);
  if (result.status === "ok") return EXIT.ok;
  return STATUS_EXIT[result.status] ?? EXIT.user;
}

/** True when this file is the entry point, also through a symlinked plugin path (argv[1] is not resolved by Node). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const usage = error instanceof UsageError;
      process.stdout.write(`${JSON.stringify({ status: usage ? "invalid" : "error", message: String(error?.message ?? error).slice(0, 300) })}\n`);
      process.exitCode = usage ? EXIT.invalid : EXIT.internal;
    },
  );
}

#!/usr/bin/env node
// jev-flow direct gate runner. Node stdlib only. The runner collects the diff,
// runs the checks, reads the cited excerpts, calls jev_gate itself through the
// jev MCP server on stdio for every part of the batch (only a contradicted
// claim stops it early) and prints one aggregated JSON report (at most 8 KB).
// The model never copies payloads.
//
//   node jev-gate-run.mjs --root <repo> --list-hunks
//   node jev-gate-run.mjs --root <repo> --claims <file|-> [--check '<argv JSON>']... [--check-timeout <s>] [--session-key <key>]
//
// claims JSON: {"request": "<the user's request>",
//   "claims": [{"text": "...", "evidence": ["hunk-3", "file:src/a.ts", "cmd-1", "<excerpt id>"]}],
//   "excerpts": [{"id": "caller", "path": "src/cli.ts", "lines": [40, 62]}]}
// --check takes a JSON array of strings, run as argv without a shell, for
// example --check '["npm","test"]'. cmd-N is the Nth --check (1-based). Any
// failing, timed-out or unstartable check prevents acceptance. The runner reads excerpt lines itself;
// `diff`, `commands`, `tests`, `evidence` or excerpt `text` are refused.
// Server: JEV_FLOW_MCP_COMMAND (JSON argv array) or
// `npx -y --package=@jkudish/jev-mcp@latest jev-mcp`; credentials come from
// the inherited environment only.
//
// A gate invocation (anything but --help and --list-hunks) records its attempt
// before any validation, so an invalid or interrupted run supersedes an
// earlier accepted gate.
//
// Exit codes (from `outcome`: a contradiction first, then snapshot_changed,
// checks_failed, unavailable, then the verdict): 0 accepted, 2 contradicted /
// checks failed / escalate / ask_user / needs_evidence, 3 Jev unavailable or
// disabled for the repo, 4 invalid input, not ready or snapshot changed,
// 1 internal error.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compactSummary, EXIT, listRunHunks, parseCheckArgv, RUN_LIMITS, RunError, runGate, runnerSession, startAttempt } from "../private/jev-flow/gate-run.mjs";
import { loadDenylist } from "../private/jev-flow/paths.mjs";
import { FIXED_PHRASES } from "../private/jev-flow/policy.mjs";
import { gitTopLevel, readBaseline } from "../private/jev-flow/state.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const USAGE = `Usage:
  jev-gate-run.mjs --root <repo> --list-hunks [--session-key <key>]
  jev-gate-run.mjs --root <repo> --claims <file|-> [--check '["cmd","arg"]']... [--check-timeout <seconds>] [--session-key <key>]`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { checks: [] };
  const value = (i, name) => {
    if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--list-hunks") opts.listHunks = true;
    else if (arg === "--root") opts.root = value(i++, arg);
    else if (arg === "--claims") opts.claims = value(i++, arg);
    else if (arg === "--check") opts.checks.push(value(i++, arg));
    else if (arg === "--session-key") opts.sessionKey = value(i++, arg);
    else if (arg === "--check-timeout") {
      const v = value(i++, arg);
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError("--check-timeout must be a positive number of seconds");
      opts.checkTimeoutMs = Number(v) * 1000;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

async function readClaims(source) {
  let raw;
  if (source === "-") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) throw new UsageError(`claims input exceeds ${MAX_INPUT_BYTES} bytes`);
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (error) {
      throw new UsageError(`cannot read --claims ${source}: ${error?.code ?? error?.message}`);
    }
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new UsageError(`claims input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError("--claims must be a JSON object {request, claims, excerpts?}");
  }
}

function print(summary) {
  process.stdout.write(`${compactSummary(summary)}\n`);
}

/** Loose pre-parse so that even an invocation with invalid arguments records its attempt. */
function preParse(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return { help: argv.includes("--help") || argv.includes("-h"), listHunks: argv.includes("--list-hunks"), root: at("--root"), sessionKey: at("--session-key") };
}

let attempt = null;

async function main() {
  const argv = process.argv.slice(2);
  const pre = preParse(argv);
  if (!pre.help && !pre.listHunks) {
    // A gate invocation: record the attempt before anything can fail.
    attempt = startAttempt({ repoRoot: gitTopLevel(resolve(pre.root ?? ".")), sessionKeyArg: pre.sessionKey });
  }
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repoRoot = gitTopLevel(resolve(opts.root ?? "."));
  if (!repoRoot) throw new UsageError(`not a git work tree: ${resolve(opts.root ?? ".")}`);
  const denylist = loadDenylist(repoRoot);
  if (opts.listHunks) {
    if (denylist.disabled) {
      print({ jev_flow_gate_run: 1, status: "disabled", exit: EXIT.unavailable, message: FIXED_PHRASES.disabled });
      return EXIT.unavailable;
    }
    const session = runnerSession(repoRoot, { sessionKeyArg: opts.sessionKey });
    const listing = listRunHunks(repoRoot, denylist, session ? readBaseline(session.dir) : null);
    // The listing is identifiers only (no hunk bodies); it is not size-capped like the verdict summary.
    process.stdout.write(`${JSON.stringify(listing)}\n`);
    return 0;
  }
  if (!opts.claims) throw new UsageError("--claims is required (or --list-hunks)");
  let checks;
  try {
    checks = opts.checks.map(parseCheckArgv);
  } catch (error) {
    if (error instanceof RunError) throw new UsageError(error.message);
    throw error;
  }
  const input = await readClaims(opts.claims);
  const { code, summary } = await runGate({
    repoRoot,
    denylist,
    input,
    checks,
    checkTimeoutMs: opts.checkTimeoutMs ?? RUN_LIMITS.checkTimeoutMs,
    attempt,
  });
  print(summary);
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    // The attempt that started fails: it never becomes evidence.
    attempt?.close();
    const usage = error instanceof UsageError;
    const summary = { jev_flow_gate_run: 1, status: usage ? "invalid_input" : "error", exit: usage ? EXIT.invalid : EXIT.internal, problems: [String(error?.message ?? error).slice(0, 300)] };
    if (usage) summary.usage = USAGE;
    process.stdout.write(`${compactSummary(summary)}\n`);
    process.exitCode = summary.exit;
  },
);

#!/usr/bin/env node
// /jev:prompt-check helper: on [threshold] | off | status | threshold <x> | lang auto|ro|en
// Usage: node cli.mjs <command> [args] [--session-id <id>] [--session-cap <cap>] [--root <repo>]
// The session is the one in CLAUDE_CODE_SESSION_ID (or --session-id), or the one proven by the
// capability the hook injected; it is never guessed.
import { fileURLToPath } from "node:url";
import { hasSessionId, sessionKey, verifySessionCap } from "../jev-control/state.mjs";
import { gitTopLevel } from "../jev-flow/state.mjs";
import { LANG_SETTINGS } from "./language.mjs";
import { DEFAULT_THRESHOLD, loadState, promptCheckDir, validThreshold, withState } from "./state.mjs";

/** The number in a threshold argument, or null when it is not a plain decimal strictly between 0.5 and 1. */
export function parseThreshold(text) {
  if (typeof text !== "string" || !/^(?:\d+\.?\d*|\.\d+)$/.test(text.trim())) return null;
  const value = Number(text);
  return validThreshold(value) ? value : null;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id" || a === "--session-cap" || a === "--root") flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

function resolveSession(repoRoot, flags, env) {
  const id = flags["session-id"] ?? env.CLAUDE_CODE_SESSION_ID;
  let proven = null;
  if (flags["session-cap"] !== undefined) {
    proven = verifySessionCap(repoRoot, flags["session-cap"], env);
    if (!proven.ok) return { ok: false, reason: `the session capability is not valid (${proven.reason}); use the line the hook injected into this session` };
  }
  if (hasSessionId(id)) {
    if (proven && proven.key !== sessionKey(id)) return { ok: false, reason: "identity_conflict: the session capability belongs to another session than the one in this environment" };
    return { ok: true, dir: promptCheckDir(repoRoot, id, env) };
  }
  if (proven) return { ok: true, dir: proven.dir };
  return { ok: false, reason: "no verifiable session identity: CLAUDE_CODE_SESSION_ID is not set and no --session-cap was given; nothing was changed" };
}

function statusLine(s) {
  return `prompt-check: ${s.mode}, threshold ${s.threshold}, language ${s.lang}, ${s.checked} prompts checked, ${s.tips} tips shown`;
}

/** Run one command. Returns {code, lines}; code 0 also when a value was rejected with a notice. */
export function runCli(argv, env = process.env, cwd = process.cwd()) {
  const { flags, positional } = parseArgs(argv);
  const [command, arg] = positional;
  if (!["on", "off", "status", "threshold", "lang"].includes(command)) {
    return { code: 2, lines: ["usage: on [threshold] | off | status | threshold <x> | lang auto|ro|en"] };
  }
  const repoRoot = flags.root ?? gitTopLevel(cwd);
  if (!repoRoot) return { code: 1, lines: ["prompt-check: not inside a git work tree; nothing was changed"] };
  const session = resolveSession(repoRoot, flags, env);
  if (!session.ok) return { code: 1, lines: [`prompt-check: ${session.reason}`] };
  const notices = [];
  if (command === "status") return { code: 0, lines: [statusLine(loadState(session.dir))] };
  const state = withState(session.dir, (s) => {
    if (command === "on" || command === "threshold") {
      if (command === "threshold" || arg !== undefined) {
        const value = parseThreshold(arg);
        if (value === null) notices.push(`prompt-check: invalid threshold ${JSON.stringify(String(arg ?? ""))} (use a number above 0.5 and below 1); kept ${s.threshold}`);
        else s.threshold = value;
      }
    }
    if (command === "on") {
      s.mode = "on";
      // The command prompt itself is already a prompt of this session, so the next one is not the first.
      s.seen = Math.max(s.seen, 1);
    } else if (command === "off") s.mode = "off";
    else if (command === "lang") {
      if (LANG_SETTINGS.includes(arg)) s.lang = arg;
      else notices.push(`prompt-check: unknown language ${JSON.stringify(String(arg ?? ""))} (use auto, ro or en); kept ${s.lang}`);
    }
    return { ...s };
  });
  return { code: 0, lines: [...notices, statusLine(state)] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = runCli(process.argv.slice(2));
  } catch (error) {
    result = { code: 1, lines: [`prompt-check: ${String(error?.message ?? error)}`] };
  }
  process.stdout.write(`${result.lines.join("\n")}\n`);
  process.exitCode = result.code;
}

export { DEFAULT_THRESHOLD };

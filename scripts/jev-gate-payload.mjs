#!/usr/bin/env node
// jev-flow gate payload helper. Node stdlib only; reads stdin, writes JSON to
// stdout, never writes files.
//
//   git diff HEAD | node jev-gate-payload.mjs --list-hunks [--root <repo>]
//   node jev-gate-payload.mjs [--root <repo>] < input.json
//
// input.json: {"request": "...", "diff": "<git diff HEAD output>",
//   "claims": [{"text": "...", "evidence": ["hunk-1", "cmd-1", "file:src/a.ts", "<excerpt id>"]}],
//   "commands": [{"command": "npm test", "exit": 0, "output": "<real output>"}],
//   "excerpts": [{"id": "api", "path": "src/a.ts", "lines": [10, 30], "text": "<real code>"}]}
// Output: {"ok", "problems", "limits", "batch", "hunks", "calls": [{"part", "of", "input"}]}.
// Send every calls[i].input to jev_gate unchanged, one call per part.
//
// Exit codes: 0 ready, 2 usage error, 3 input too large, 4 not ready (see problems).
import { resolve } from "node:path";
import { listHunks, prepareGateBatch } from "../private/jev-flow/gate-batch.mjs";
import { loadDenylist } from "../private/jev-flow/paths.mjs";
import { FIXED_PHRASES } from "../private/jev-flow/policy.mjs";
import { sanitizeDiff } from "../private/jev-flow/sanitize.mjs";
import { computeSnapshot, gitTopLevel } from "../private/jev-flow/state.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const USAGE = `Usage:
  git diff HEAD | jev-gate-payload.mjs --list-hunks [--root <repo>]
  jev-gate-payload.mjs [--root <repo>] < input.json`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--list-hunks") opts.listHunks = true;
    else if (arg === "--root") {
      if (i + 1 >= argv.length) throw new UsageError("--root needs a value");
      opts.root = argv[++i];
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repoRoot = gitTopLevel(resolve(opts.root ?? "."));
  if (!repoRoot) throw new UsageError(`not a git work tree: ${resolve(opts.root ?? ".")}`);
  const denylist = loadDenylist(repoRoot);
  if (denylist.disabled) {
    process.stdout.write(`${JSON.stringify({ disabled: true, reason: FIXED_PHRASES.disabled, ok: false, calls: [] })}\n`);
    return 0;
  }
  const raw = await readStdin();
  if (raw === null) {
    process.stderr.write(`${JSON.stringify({ error: `input exceeds ${MAX_INPUT_BYTES} bytes` })}\n`);
    return 3;
  }
  if (opts.listHunks) {
    const clean = sanitizeDiff(raw, denylist);
    process.stdout.write(`${JSON.stringify({ hunks: listHunks(clean.text), omitted: clean.omitted, omitted_lines: clean.omitted_lines })}\n`);
    return 0;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new UsageError("stdin must be a JSON object (see the header of this script)");
  }
  const result = prepareGateBatch(input, { denylist, snapshot: computeSnapshot(repoRoot).hash });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 4;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const usage = error instanceof UsageError;
    process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error), usage: usage ? USAGE : undefined })}\n`);
    process.exitCode = usage ? 2 : 1;
  },
);

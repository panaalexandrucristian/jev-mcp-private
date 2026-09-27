#!/usr/bin/env node
// jev-flow candidate helper and sanitizer. Node stdlib only.
//
//   node jev-candidates.mjs --root <repo> --query <text> [--limit 48] [--chunk-chars 1000]
//                           [--window-lines 60] [--max-file-bytes 1048576]
//   node jev-candidates.mjs --sanitize [--root <repo>] [--mode auto|text|diff] < input
//
// Exit codes: 0 success, 2 usage error or non-git root, 3 sanitize input too large.
import { resolve } from "node:path";
import { buildCandidates, LIMITS, UsageError } from "../private/jev-flow/candidates.mjs";
import { loadDenylist } from "../private/jev-flow/paths.mjs";
import { FIXED_PHRASES } from "../private/jev-flow/policy.mjs";
import { looksLikeDiff, sanitizeDiff, sanitizeText } from "../private/jev-flow/sanitize.mjs";
import { gitTopLevel } from "../private/jev-flow/state.mjs";

const SANITIZE_MAX_BYTES = 2 * 1024 * 1024;

const USAGE = `Usage:
  jev-candidates.mjs --root <repo> --query <text> [--limit N<=${LIMITS.maxCandidates}] [--chunk-chars N<=${LIMITS.maxChunkChars}]
                     [--window-lines N<=${LIMITS.maxWindowLines}] [--max-file-bytes N]
  jev-candidates.mjs --sanitize [--root <repo>] [--mode auto|text|diff] < input`;

function parseArgs(argv) {
  const opts = {};
  const valueFlags = new Set(["--root", "--query", "--limit", "--chunk-chars", "--window-lines", "--max-file-bytes", "--mode"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--sanitize") opts.sanitize = true;
    else if (valueFlags.has(arg)) {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = argv[++i];
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

function toInt(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(value);
}

async function readStdin(maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) return null;
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
  if (opts.sanitize) {
    const mode = opts.mode ?? "auto";
    if (!["auto", "text", "diff"].includes(mode)) throw new UsageError("--mode must be auto, text or diff");
    const repoRoot = gitTopLevel(resolve(opts.root ?? ".")) ?? resolve(opts.root ?? ".");
    const denylist = loadDenylist(repoRoot);
    if (denylist.disabled) {
      process.stdout.write(`${JSON.stringify({ disabled: true, reason: FIXED_PHRASES.disabled, text: "", redactions: [], omitted: [], omitted_lines: 0 })}\n`);
      return 0;
    }
    const input = await readStdin(SANITIZE_MAX_BYTES);
    if (input === null) {
      process.stderr.write(`${JSON.stringify({ error: `sanitize input exceeds ${SANITIZE_MAX_BYTES} bytes; split it` })}\n`);
      return 3;
    }
    const asDiff = mode === "diff" || (mode === "auto" && looksLikeDiff(input));
    const result = asDiff ? sanitizeDiff(input, denylist) : sanitizeText(input);
    process.stdout.write(`${JSON.stringify({ disabled: false, mode: asDiff ? "diff" : "text", ...result })}\n`);
    return 0;
  }
  if (!opts.root || !opts.query) throw new UsageError("--root and --query are required");
  const result = buildCandidates({
    root: opts.root,
    query: opts.query,
    limit: toInt(opts.limit, "--limit"),
    chunkChars: toInt(opts["chunk-chars"], "--chunk-chars"),
    windowLines: toInt(opts["window-lines"], "--window-lines"),
    maxFileBytes: toInt(opts["max-file-bytes"], "--max-file-bytes"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
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

#!/usr/bin/env node
// jev-flow candidate helper and sanitizer. Node stdlib only.
//
//   node jev-candidates.mjs --root <repo> --query <text> [--limit 48] [--chunk-chars 1000]
//                           [--window-lines 60] [--max-file-bytes 1048576] [--single]
//                           [--fallback] [--no-jev] [--full]
//   --single: the question asks for one definitive location (jev_find instead of jev_rerank).
//   When `recommend.tool` is jev_rerank or jev_find (the F4 rule), the helper runs that call
//   itself through the jev MCP server on stdio (`jev_payload` unchanged, top_k 5); the
//   locator makes no Jev call.
//   stdout (R7) is one compact JSON object of at most 4096 bytes: at most 5 hits
//   {path, start_line, end_line, sha256, score, reason}, `ordering` ("semantic" from a
//   valid Jev answer, else "lexical"), `jev`, `jev_calls`, `coverage_complete`, `omitted`.
//   No candidate texts, map or payload. Without credentials, --no-jev, or an unavailable or
//   invalid answer after one retry: the top 5 candidates by lexical score, ordering "lexical".
//   --fallback: the exact match was read and did not answer; run `recommend.fallback` instead.
//   --full: diagnostics and tests only; the full object (candidates, map, payload, jev_result).
//   node jev-candidates.mjs --sanitize [--root <repo>] [--mode auto|text|diff] < input
//
// Exit codes: 0 success, 2 usage error or non-git root, 3 sanitize input too large.
import { resolve } from "node:path";
import { buildCandidates, compactReport, dueJevCall, LIMITS, mapJevResult, UsageError } from "../private/jev-flow/candidates.mjs";
import { callWithRetry, openJev } from "../private/jev-flow/mcp-client.mjs";
import { loadDenylist } from "../private/jev-flow/paths.mjs";
import { FIXED_PHRASES } from "../private/jev-flow/policy.mjs";
import { looksLikeDiff, sanitizeDiff, sanitizeText } from "../private/jev-flow/sanitize.mjs";
import { gitTopLevel } from "../private/jev-flow/state.mjs";

const SANITIZE_MAX_BYTES = 2 * 1024 * 1024;

const USAGE = `Usage:
  jev-candidates.mjs --root <repo> --query <text> [--limit N<=${LIMITS.maxCandidates}] [--chunk-chars N<=${LIMITS.maxChunkChars}]
                     [--window-lines N<=${LIMITS.maxWindowLines}] [--max-file-bytes N] [--single] [--fallback] [--no-jev]
  jev-candidates.mjs --sanitize [--root <repo>] [--mode auto|text|diff] < input`;

function parseArgs(argv) {
  const opts = {};
  const valueFlags = new Set(["--root", "--query", "--limit", "--chunk-chars", "--window-lines", "--max-file-bytes", "--mode"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--sanitize") opts.sanitize = true;
    else if (arg === "--single") opts.single = true;
    else if (arg === "--fallback") opts.fallback = true;
    else if (arg === "--no-jev") opts.noJev = true;
    else if (arg === "--full") opts.full = true;
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
  const started = Date.now();
  const result = buildCandidates({
    root: opts.root,
    query: opts.query,
    limit: toInt(opts.limit, "--limit"),
    chunkChars: toInt(opts["chunk-chars"], "--chunk-chars"),
    windowLines: toInt(opts["window-lines"], "--window-lines"),
    maxFileBytes: toInt(opts["max-file-bytes"], "--max-file-bytes"),
    single: opts.single === true,
  });
  const fallback = opts.fallback === true;
  const due = result.disabled ? null : dueJevCall(result, { fallback });
  if (due) result.jev_result = opts.noJev ? { tool: due.tool, status: "skipped", reason: "--no-jev", calls: 0 } : await runJev(due, result.map);
  if (opts.full) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const r = result.jev_result;
  const jev = r ? { tool: r.tool, status: r.status, calls: r.calls ?? 0, reason: r.reason, result: r.status === "ok" ? r : null } : null;
  process.stdout.write(compactReport(result, jev, { fallback, elapsedMs: Date.now() - started }));
  return 0;
}

/**
 * Run the due Jev call through the MCP client. An unusable ranking (per
 * mapJevResult: unknown or repeated ids, scores outside [0, 1], a partial
 * answer) is retried once with identical input in the same retry loop as
 * transport failures; never an invented ranking. A final invalid answer is
 * status "invalid_response", any other failure "unavailable".
 */
async function runJev(due, map) {
  const jev = await openJev(process.env);
  if (!jev.ok) return { tool: due.tool, status: "unavailable", reason: String(jev.reason).slice(0, 300), calls: 0, message: "Jev unavailable; ranking not evaluated" };
  const options = { sent: due.payload.candidates.map((c) => c.id), topK: due.payload.top_k };
  try {
    const reply = await callWithRetry(jev, due.tool, due.payload, { invalid: (result) => mapJevResult(due.tool, result, map, options).status !== "ok" });
    if (!reply.ok) {
      const retry = reply.retry ? ` (retry ${reply.retry})` : "";
      const status = reply.kind === "invalid_response" ? "invalid_response" : "unavailable";
      return { tool: due.tool, status, reason: `${reply.kind}: ${String(reply.message).slice(0, 240)}${retry}`, calls: reply.attempts, message: "Jev unavailable; ranking not evaluated" };
    }
    return { ...mapJevResult(due.tool, reply.result, map, options), calls: reply.attempts };
  } finally {
    await jev.close();
  }
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

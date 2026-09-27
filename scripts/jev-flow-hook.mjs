#!/usr/bin/env node
// Claude Code hook adapter for jev-flow. Usage (from hooks/hooks.json):
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-flow-hook.mjs" <EventName>  < hook-input.json
// Prints the hook JSON output (if any) and always exits 0: an internal error
// yields one stderr diagnostic and no decision, never a silent approval.
import { handleHook } from "../private/jev-flow/hook.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const event = process.argv[2];
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const output = handleHook(event ?? input.hook_event_name, input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`[jev-flow] hook error: ${String(error?.message ?? error)}\n`);
}
process.exitCode = 0;

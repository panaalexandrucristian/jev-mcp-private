#!/usr/bin/env node
// Claude Code hook adapter for jev-flow. Usage (from hooks/hooks.json):
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-flow-hook.mjs" <EventName>  < hook-input.json
// Prints the hook JSON output (if any) and always exits 0: an internal error
// yields one stderr diagnostic and no decision, never a silent approval.
import { handleControlHook, mergeOutputs } from "../private/jev-control/hook.mjs";
import { handleHook } from "../private/jev-flow/hook.mjs";
import { handlePromptCheckHook } from "../private/jev-prompt-check/hook.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const event = process.argv[2];
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  // jev-control first (reminder, session binding, new request); then the flow, which
  // stands down by itself while the control mode is ON for the session.
  const name = event ?? input.hook_event_name;
  let control = null;
  try {
    control = handleControlHook(name, input);
  } catch (error) {
    process.stderr.write(`[jev-control] hook error: ${String(error?.message ?? error)}\n`);
  }
  let output = mergeOutputs(control, handleHook(name, input));
  // prompt-check (opt-in, off by default) runs after them and adds only its own systemMessage.
  let ran = false;
  try {
    const promptCheck = await handlePromptCheckHook(name, input);
    ran = promptCheck.ran;
    output = mergeOutputs(output, promptCheck.output);
  } catch (error) {
    process.stderr.write(`[prompt-check] hook error: ${String(error?.message ?? error).slice(0, 200)}\n`);
  }
  const line = output ? `${JSON.stringify(output)}\n` : "";
  // After a Jev check exit as soon as the output is flushed, so no child process can hold the prompt.
  if (ran) process.stdout.write(line, () => process.exit(0));
  else if (line) process.stdout.write(line);
} catch (error) {
  process.stderr.write(`[jev-flow] hook error: ${String(error?.message ?? error)}\n`);
}
process.exitCode = 0;

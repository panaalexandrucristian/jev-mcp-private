#!/usr/bin/env node
// A/B runner guard: refuses to start the experiment until the manifest is
// complete. Exit 0 = ready, 1 = not ready (reasons printed), 2 = unreadable.
//   node private/jev-flow/ab/preflight.mjs [path/to/tasks.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AGREED_TASKS = Object.freeze(["M1", "M2", "A1", "A2", "H1", "H2"]);

export function preflight(manifest) {
  const reasons = [];
  if (manifest?.schema_version !== 1) reasons.push("unsupported schema_version");
  if (!Number.isInteger(manifest?.seed)) reasons.push("seed is not recorded (must be an integer at experiment start)");
  if (manifest?.repetitions !== 3) reasons.push("repetitions must be 3");
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const ids = tasks.map((t) => t?.id);
  if (tasks.length !== AGREED_TASKS.length) reasons.push(`expected ${AGREED_TASKS.length} tasks, found ${tasks.length}`);
  if (new Set(ids).size !== ids.length) reasons.push("task ids are not distinct");
  const missing = AGREED_TASKS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !AGREED_TASKS.includes(id));
  if (missing.length) reasons.push(`missing agreed tasks: ${missing.join(", ")}`);
  if (extra.length) reasons.push(`tasks outside the agreed corpus: ${extra.join(", ")}`);
  for (const task of tasks) {
    if (!/^[0-9a-f]{40}$/.test(task?.base_sha ?? "")) reasons.push(`${task?.id}: base_sha is not a full 40-hex SHA`);
    if (typeof task?.prompt !== "string" || task.prompt.trim() === "") reasons.push(`${task?.id}: prompt missing`);
    if (task?.oracle?.status !== "ready") reasons.push(`${task?.id}: oracle ${task?.oracle?.status ?? "missing"}`);
    else if (!task.oracle.command) reasons.push(`${task?.id}: oracle command missing`);
  }
  return { ready: reasons.length === 0, reasons };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? new URL("./tasks.json", import.meta.url);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(`preflight: cannot read manifest: ${error.message}\n`);
    process.exit(2);
  }
  const result = preflight(manifest);
  if (result.ready) {
    process.stdout.write("preflight: ready\n");
  } else {
    process.stdout.write(`preflight: NOT READY - the experiment must not start\n${result.reasons.map((r) => `- ${r}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

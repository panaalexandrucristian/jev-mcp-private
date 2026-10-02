#!/usr/bin/env node
// Seal and verify the campaign fixtures.
//   node seal.mjs write    writes sealed.json (the final scenarios) and oracle-hashes.json (the dev scenarios)
//   node seal.mjs verify   exits 1 when a scenario, its oracle or its solution differs from the recorded hash
// The hashes cover the prompt, the files, the solution, the expected outcome and the
// ORACLE'S SOURCE, so an oracle fixed before the runs cannot change silently
// afterwards. The final scenarios stay sealed until R10; a change after the seal is
// visible in git as a changed hash and counts as unsealing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FINAL_SCENARIOS } from "./final-scenarios.mjs";
import { scenarioHash } from "./lib.mjs";
import { DEV_SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEALED_FILE = join(HERE, "sealed.json");
export const ORACLE_FILE = join(HERE, "oracle-hashes.json");

export function currentHashes() {
  return {
    sealed: Object.fromEntries(FINAL_SCENARIOS.map((s) => [s.id, scenarioHash(s)])),
    oracles: Object.fromEntries(DEV_SCENARIOS.map((s) => [s.id, scenarioHash(s)])),
  };
}

export function verify() {
  const now = currentHashes();
  const problems = [];
  for (const [file, key, label] of [[SEALED_FILE, "sealed", "sealed final"], [ORACLE_FILE, "oracles", "dev oracle"]]) {
    let recorded;
    try {
      recorded = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      problems.push(`${file} is missing`);
      continue;
    }
    for (const [id, hash] of Object.entries(now[key])) {
      if (recorded.scenarios?.[id] !== hash) problems.push(`${label} ${id}: hash differs from the recorded one`);
    }
    for (const id of Object.keys(recorded.scenarios ?? {})) if (!(id in now[key])) problems.push(`${label} ${id}: recorded but no longer defined`);
  }
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith("seal.mjs")) {
  const cmd = process.argv[2];
  if (cmd === "write") {
    const now = currentHashes();
    const meta = { algorithm: "sha256 over canonical JSON {id, kind, prompt, files, solution, oracle source, expects}", scenarios: null };
    writeFileSync(SEALED_FILE, `${JSON.stringify({ ...meta, note: "sealed until R10: not run, opened for tuning or adjusted before then", scenarios: now.sealed }, null, 2)}\n`);
    writeFileSync(ORACLE_FILE, `${JSON.stringify({ ...meta, note: "dev oracles fixed before the runs", scenarios: now.oracles }, null, 2)}\n`);
    process.stdout.write("sealed\n");
  } else if (cmd === "verify") {
    const problems = verify();
    process.stdout.write(problems.length ? `${problems.join("\n")}\n` : "ok\n");
    process.exitCode = problems.length ? 1 : 0;
  } else {
    process.stderr.write("Usage: seal.mjs write|verify\n");
    process.exitCode = 4;
  }
}

// Freezes the fixtures: writes eval/fixtures.lock.json (file hashes, allowed edits, prompt hashes and the protected
// helpers' hashes). Run `node private/logic-test-debug/eval/freeze.mjs` only on purpose: a changed fixture or prompt
// after the first live start would invalidate every earlier run, and the lock test fails until it is refrozen.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURES_DIR, LOCK_PATH, SCENARIOS, hashTree, sha256 } from "./lib/workspace.mjs";

const prompts = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8"));
const allowed = { activation: [], conditions: ["src/access.js", "test/access.test.mjs"], bug: ["src/shipping.js", "test/shipping.test.mjs"] };
const lock = { version: 1, promptsHash: sha256(JSON.stringify(prompts)), scenarios: {} };
for (const scenario of SCENARIOS) lock.scenarios[scenario] = { files: hashTree(join(FIXTURES_DIR, scenario)), allowedEdits: allowed[scenario] };
const conditions = await import(pathToFileURL(join(FIXTURES_DIR, "conditions", "src", "access.js")).href);
lock.scenarios.conditions.helperHash = sha256(String(conditions.normalizeToken));
const bug = await import(pathToFileURL(join(FIXTURES_DIR, "bug", "src", "shipping.js")).href);
lock.scenarios.bug.helperHash = sha256(String(bug.schedule));
writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`frozen: ${SCENARIOS.map((s) => `${s} ${Object.keys(lock.scenarios[s].files).length} files`).join(", ")}`);

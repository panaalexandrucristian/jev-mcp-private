// Fresh agent workspaces from the visible fixtures, file hashing and the leak audit. The hidden oracles, the
// reference solutions and the lock file live in eval/, never inside a workspace.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
export const LOCK_PATH = fileURLToPath(new URL("../fixtures.lock.json", import.meta.url));
export const SCENARIOS = ["activation", "conditions", "bug"];

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** {relative path: sha256} of every file under dir (sorted; node_modules and .git skipped). */
export function hashTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[relative(dir, full).split("\\").join("/")] = sha256(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** A fresh copy of one visible fixture in a new temporary directory; returns its path. */
export function createWorkspace(scenario, parent = tmpdir()) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const dir = mkdtempSync(join(parent, `ltd-${scenario}-`));
  cpSync(join(FIXTURES_DIR, scenario), dir, { recursive: true });
  return dir;
}

export const readLock = () => JSON.parse(readFileSync(LOCK_PATH, "utf8"));

/**
 * Files that differ from the frozen fixture: changed, added and removed, and which of them are outside the allowed
 * edits of the scenario. Files under node_modules and .git are ignored.
 */
export function changedFiles(dir, scenario, lock = readLock()) {
  const frozen = lock.scenarios[scenario].files;
  const now = hashTree(dir);
  const changed = Object.keys(now).filter((name) => name in frozen && now[name] !== frozen[name]);
  const added = Object.keys(now).filter((name) => !(name in frozen));
  const removed = Object.keys(frozen).filter((name) => !(name in now));
  const allowed = new Set(lock.scenarios[scenario].allowedEdits);
  const outOfScope = [...changed, ...added, ...removed].filter((name) => !allowed.has(name));
  return { changed, added, removed, outOfScope };
}

/** Leak audit: an agent workspace must hold no oracle, reference solution or lock file. */
export function auditWorkspace(dir) {
  const problems = [];
  for (const [name] of Object.entries(hashTree(dir))) {
    if (/oracle|reference|fixtures\.lock/i.test(name)) problems.push(`suspicious file name: ${name}`);
    const full = join(dir, name);
    if (statSync(full).size < 1_000_000 && readFileSync(full, "utf8").includes("HIDDEN-ORACLE")) problems.push(`oracle marker inside: ${name}`);
  }
  return { ok: problems.length === 0, problems };
}

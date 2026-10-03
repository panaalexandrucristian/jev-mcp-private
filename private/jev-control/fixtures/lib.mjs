// Fixture helpers shared by the dev and the sealed final scenarios: a scenario is
// {id, title, kind, prompt, files, solution, oracle(dir, {finalMessage}) -> {pass, detail}}.
// Oracles come from the construction of the fixture (the correct result is known
// by design), never from a Jev score. The repository of a scenario is a
// disposable copy in a temporary directory: never the real jev-mcp.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A committed git repository with the scenario's files, in a fresh temporary directory (or `dest`). */
export function materialize(scenario, dest = mkdtempSync(join(tmpdir(), `jev-control-${scenario.id}-`))) {
  mkdirSync(dest, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dest, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  writeFiles(dest, scenario.files);
  git("add", "--", ...Object.keys(scenario.files));
  git("commit", "-q", "-m", "fixture");
  return dest;
}

/** Evaluate `source` (an ES module body that prints one JSON line) inside `dir`, isolated in a child process. */
export function evalIn(dir, source) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: dir, encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return { error: String(r.stderr || r.error || "failed").slice(0, 300) };
  try {
    return JSON.parse(String(r.stdout).trim().split("\n").pop());
  } catch {
    return { error: "no JSON result" };
  }
}

export function gitClean(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim() === "";
}

/** Hash of everything that defines a scenario, its oracle's source included. */
export function scenarioHash(scenario) {
  const canonical = JSON.stringify({ id: scenario.id, kind: scenario.kind, prompt: scenario.prompt, files: scenario.files, solution: scenario.solution ?? {}, oracle: scenario.oracle.toString(), expects: scenario.expects });
  return createHash("sha256").update(canonical).digest("hex");
}

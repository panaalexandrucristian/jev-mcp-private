// Runs ONE live test session of the pre-registered plan. This is the only code that starts a model session. It
// starts a session only after the budget (lib/budget.mjs) has recorded and allowed it, enforces the 10-minute and
// 80-turn limits itself (the CLI has no --max-turns flag; checked on 2.1.296), keeps every artifact, and scores the
// transcript and the working copy with the hidden oracle. It never edits the repository.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeProbe, prepareSentinel, probePrompt } from "./confine.mjs";
import { finishSession } from "./ledger.mjs";
import { startBudgeted } from "./budget.mjs";
import { evaluateRun } from "./evaluate.mjs";
import { outsideAccess } from "./report.mjs";
import { scoreTranscript } from "./transcript.mjs";
import { createWorkspace } from "./workspace.mjs";

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
export const LIMITS = { timeoutMs: 10 * 60 * 1000, maxTurns: 80, maxBudgetUsd: 0.5 };
// File tools are NOT listed: inside the workspace they need no rule (acceptEdits), outside it nothing can approve them
// (--permission-prompts none). Only the plugin copy may be read. Bash is limited to node and runs in a sandbox.
export const ALLOWED_TOOLS = "Skill,Bash(node:*)";
const PROMPTS = { ...JSON.parse(readFileSync(new URL("../prompts.json", import.meta.url), "utf8")), ...JSON.parse(readFileSync(new URL("../prompts-hard.json", import.meta.url), "utf8")) };
const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"];

export const promptFor = (scenario, run) => (scenario === "nocode" ? PROMPTS.nocode[Number(run) - 1] : PROMPTS[scenario]);

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
/** The node installation (…/v22.x) that the sandboxed shell must be able to read. */
export const defaultNodeHome = () => dirname(dirname(real(process.execPath)));

/** The settings that confine a session: file tools by permission rules, Bash by the sandbox, failing closed. */
export function confinementSettings({ pluginDir, nodeHome = defaultNodeHome() }) {
  return {
    enabledPlugins: { "jev@jev-private": false },
    permissions: { blockReadsOutsideWorkingDirectories: true },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: ["~/"], allowRead: [real(pluginDir), nodeHome] } },
  };
}

/** A fingerprint of every argument that decides what a session may touch (not the prompt, id, model or budget). */
export function confinementFingerprint(args) {
  const pick = ["--permission-mode", "--permission-prompts", "--allowedTools", "--settings", "--setting-sources", "--add-dir", "--dangerously-skip-permissions"];
  return createHash("sha256").update(JSON.stringify(pick.map((flag) => [flag, args.includes(flag) ? args[args.indexOf(flag) + 1] ?? true : null]))).digest("hex");
}
const CONFINEMENT_FILE = "confinement.json";
const confinementProven = (root, args) => {
  try {
    const record = JSON.parse(readFileSync(join(root, CONFINEMENT_FILE), "utf8"));
    return record.pass === true && record.fingerprint === confinementFingerprint(args);
  } catch {
    return false;
  }
};

/** The exact claude arguments. Flags were checked against `claude --help` on 2.1.296: none is invented. */
export function buildArgs({ prompt, pluginDir, sessionId, model = "haiku", maxBudgetUsd = LIMITS.maxBudgetUsd, nodeHome }) {
  return [
    "-p", prompt,
    "--model", model,
    "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--session-id", sessionId,
    "--plugin-dir", pluginDir,
    "--setting-sources", "project,local",
    "--settings", JSON.stringify(confinementSettings({ pluginDir, nodeHome })),
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--allowedTools", `${ALLOWED_TOOLS},Read(/${real(pluginDir)}/**)`,
    "--max-budget-usd", String(maxBudgetUsd),
  ];
}

/** A minimal environment: no inherited CLAUDE_* or JEV_* variable; only the OFF arm sets the switch. */
export function buildEnv({ arm, parentEnv = process.env, cacheDir }) {
  const env = {};
  for (const key of KEEP_ENV) if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  env.JEV_FLOW_CACHE_DIR = join(cacheDir, "flow");
  env.JEV_CONTROL_CACHE_DIR = join(cacheDir, "control");
  if (arm === "OFF") env.JEV_LOGIC_TEST_DEBUG = "off";
  return env;
}

/** A copy of the committed plugin (git archive of HEAD), without its MCP server, in `dest`. Returns {dir, commit}. */
export function ensurePluginCopy({ repo = REPO, dest, ref = "HEAD" }) {
  const marker = join(dest, ".plugin-commit");
  // A full commit id that is already built is reused without asking git (the commit may have been rebased away).
  if (/^[0-9a-f]{40}$/.test(ref) && existsSync(marker) && readFileSync(marker, "utf8").trim() === ref) return { dir: dest, commit: ref };
  const commit = spawnSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`cannot resolve the plugin ref: ${ref}`);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === commit) return { dir: dest, commit };
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync("sh", ["-c", `git -C "${repo}" archive ${commit} | tar -x -C "${dest}"`], { encoding: "utf8" });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const manifest = join(dest, ".claude-plugin", "plugin.json");
  const plugin = JSON.parse(readFileSync(manifest, "utf8"));
  delete plugin.mcpServers; // the test needs no MCP server and must not start one through npx
  writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
  writeFileSync(marker, `${commit}\n`);
  return { dir: dest, commit };
}

function stopGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 4000).unref();
}

/**
 * One session: start it in the budget, run claude in a fresh workspace, score and evaluate it, close the ledger line.
 * Options: budget (loaded budget), scenario, arm, run, kind, claudeBin, pluginDir (prepared copy), root (results), limits.
 */
export async function runSession({ budget, scenario, arm, run, kind = "planned", claudeBin = "claude", pluginDir, pluginCommit = null, root, limits = LIMITS, model = "haiku" }) {
  const probe = scenario === "confine";
  const sentinel = probe ? prepareSentinel(root) : null;
  const prompt = probe ? probePrompt(sentinel.dir) : promptFor(scenario, run);
  if (!prompt) throw new Error(`no prompt for ${scenario} run ${run}`);
  // A campaign session starts only after a probe has shown that these exact permission arguments hold.
  if (!probe && !confinementProven(root, buildArgs({ prompt, pluginDir, sessionId: "fingerprint", model }))) throw new Error("refused: confinement is not proven for these permissions; run the probe first (node eval/run-session.mjs --scenario confine --arm OFF --run 1 --kind reserve)");
  const row = startBudgeted(budget, { kind, scenario, arm, run: String(run), model }); // throws "refused: ..." when not allowed
  const dir = join(root, "runs", `${row.id}-${scenario}-${arm}-${run}`);
  mkdirSync(dir, { recursive: true });
  const empty = scenario === "nocode" || probe;
  const workspace = empty ? mkdtempSync(join(tmpdir(), `ltd-${scenario}-${row.id}-`)) : createWorkspace(scenario); // always new and empty: no file from an earlier run
  const sessionId = randomUUID();
  const args = buildArgs({ prompt, pluginDir, sessionId, model, maxBudgetUsd: limits.maxBudgetUsd });
  const env = buildEnv({ arm, cacheDir: join(dir, "cache") });
  writeFileSync(join(dir, "command.json"), JSON.stringify({ bin: claudeBin, args, cwd: workspace, envKeys: Object.keys(env), arm, scenario, run, kind, limits }, null, 2));

  const started = Date.now();
  const transcriptPath = join(dir, "transcript.jsonl");
  const out = createWriteStream(transcriptPath);
  const err = createWriteStream(join(dir, "stderr.txt"));
  let turns = 0;
  const messages = new Set();
  let limit = null;
  let buffer = "";
  let init = null;
  const child = spawn(claudeBin, args, { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => {
    limit ??= "time";
    stopGroup(child);
  }, limits.timeoutMs);
  child.stdout.on("data", (chunk) => {
    out.write(chunk);
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "system" && event.subtype === "init") init = event;
        if (event.type === "assistant") {
          // One model response can arrive as several events (thinking, text, tool_use) that share a message id.
          const id = event.message?.id ?? `event-${messages.size}`;
          if (!messages.has(id)) {
            messages.add(id);
            turns += 1;
          }
        }
        if (turns > limits.maxTurns && !limit) {
          limit = "turns";
          stopGroup(child);
        }
      } catch {
        // a partial or non-JSON line is kept in the transcript and scored later
      }
    }
  });
  child.stderr.on("data", (chunk) => err.write(chunk));
  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, spawnError: String(error.message) }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  out.end();
  err.end();
  await new Promise((resolve) => out.on("close", resolve));

  const transcript = readFileSync(transcriptPath, "utf8");
  const score = scoreTranscript(transcript, { limitExit: Boolean(limit) });
  const finalFile = join(dir, "final.txt");
  writeFileSync(finalFile, score.finalText);
  const judged = probe ? judgeProbe({ transcript, workspace, sentinel }) : null;
  const evaluation = probe ? { success: judged.pass, probe: judged } : scenario === "nocode" ? null : evaluateRun(scenario, workspace, { finalTextFile: finalFile });
  const outside = outsideAccess(transcript, workspace, [pluginDir]);
  if (probe) writeFileSync(join(root, CONFINEMENT_FILE), `${JSON.stringify({ pass: judged.pass, inconclusive: judged.inconclusive, fingerprint: confinementFingerprint(args), id: row.id, at: new Date().toISOString(), reasons: judged.reasons }, null, 2)}\n`);
  const resultEvent = transcript.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === "result") ?? null;
  const usd = typeof resultEvent?.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined;
  const status = limit ? `limit-${limit}` : exit.spawnError ? "spawn-error" : score.complete ? "complete" : "incomplete";
  const verdict = {
    id: row.id, scenario, arm, run, kind, status, limit, turns, cliNumTurns: resultEvent?.num_turns ?? null, permissionDenials: resultEvent?.permission_denials?.length ?? null, pluginCommit, durationMs: Date.now() - started,
    exit, model: { requested: model, resolved: init?.model ?? null }, sessionId, usd: usd ?? null,
    score: { ...score, finalText: undefined }, evaluation, workspace, pluginDir, outside, dir,
    init: init ? { model: init.model, tools: init.tools, mcp_servers: init.mcp_servers, plugins: init.plugins, skills: init.skills, slash_commands: init.slash_commands } : null,
  };
  writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  finishSession({ path: budget.ledger, id: row.id, status, usd });
  return verdict;
}

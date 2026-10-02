// Shared helpers for the jev-control tests: isolated environments (HOME, both
// caches under a temp dir, no real credentials), the fake stdio MCP server, an
// in-process scripted caller, and a CLI runner. Nothing here reaches the network
// or starts a `claude` process.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedGate, git, makeRepo, REPO_ROOT, run, sandboxEnv, tempDir, writeFiles } from "../../jev-flow/test/helpers.mjs";
import { startRequest } from "../budget.mjs";
import { withControlState } from "../state.mjs";

export { git, makeRepo, REPO_ROOT, run, sandboxEnv, tempDir, writeFiles };
export const CONTROL_CLI = join(REPO_ROOT, "private", "jev-control", "cli.mjs");
export const HOOK_CLI = join(REPO_ROOT, "scripts", "jev-flow-hook.mjs");
export const FAKE_CONTROL_SERVER = join(REPO_ROOT, "private", "jev-control", "test", "fixtures", "fake-control-server.mjs");

/** An isolated environment whose Jev server is the fake control server. `script` is its call script. */
export function controlEnv({ script = null, extra = {} } = {}) {
  const base = sandboxEnv();
  delete base.JEV_CONTROL_THRESHOLD;
  delete base.JEV_CONTROL_HEADLESS;
  const home = base.HOME;
  const env = {
    ...base,
    JEV_CONTROL_CACHE_DIR: join(home, "control-cache"),
    JEV_FLOW_MCP_COMMAND: JSON.stringify([process.execPath, FAKE_CONTROL_SERVER]),
    OPENROUTER_API_KEY: "sk-or-v1-test-fake",
    FAKE_MCP_LOG: join(home, "mcp.jsonl"),
    FAKE_CONTROL_STATE: join(home, "fake-state.json"),
    ...extra,
  };
  if (script) {
    env.FAKE_CONTROL_SCRIPT = join(home, "script.json");
    writeFileSync(env.FAKE_CONTROL_SCRIPT, JSON.stringify(script));
  }
  return env;
}

/** The tools/call records the fake server logged (full arguments). */
export function serverLog(env) {
  if (!env.FAKE_MCP_LOG || !existsSync(env.FAKE_MCP_LOG)) return [];
  return readFileSync(env.FAKE_MCP_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Run the control CLI; `json` is its last stdout line parsed (null when it is not JSON). */
export function cli(args, { env, cwd, input } = {}) {
  const r = run(process.execPath, [CONTROL_CLI, ...args], { cwd, env, input });
  let json = null;
  try {
    json = JSON.parse(String(r.stdout).trim().split("\n").pop());
  } catch {
    json = null;
  }
  return { ...r, json };
}

/** A fresh control session directory with request 1 started. */
export function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-control-state-"));
  withControlState(dir, (s) => startRequest(s));
  return dir;
}

/** noul/decide/rerank/find replies for the in-process caller. */
export const noul = (probs) => (args) => ({ tool: "jev_noul", status: "ok", results: args.propositions.map((p, i) => ({ id: `proposition${i}`, proposition: p, probability: probs[i], label: "likely", auto: true })) });
/** The server's distribution: the candidates plus the three escape hatches, the selection on top, summing to 1. */
export function decideProbabilities(candidateIds, selected, top) {
  const keys = [...candidateIds, "ask_user", "investigate", "none"];
  const others = keys.filter((k) => k !== selected);
  const rest = Number(((1 - top) / others.length).toFixed(6));
  const probs = Object.fromEntries(others.map((k) => [k, rest]));
  probs[selected] = Number((1 - rest * others.length).toFixed(6));
  return Object.fromEntries(keys.map((k) => [k, probs[k]]));
}
export const decide = (selected, confidence = 0.97, { escaped = false, warnings = [] } = {}) => (args) => ({
  tool: "jev_decide",
  recommendation: { selected, escaped, confidence, probabilities: decideProbabilities(args.candidates.map((c) => c.id), selected, confidence) },
  warnings,
});
export const rerank = (scores) => (args) => ({ tool: "jev_rerank", ranked: args.candidates.map((c, i) => ({ rank: i + 1, id: c.id, relevance: scores[c.id] ?? scores[i] ?? 0.01 })) });
export const find = (scores, exists) => (args) => ({ tool: "jev_find", exists, exists_verdict: exists >= 0.7 ? "answered" : exists < 0.35 ? "absent" : "partial", top: args.candidates.map((c, i) => ({ id: c.id, probability: scores[c.id] ?? scores[i] ?? 0.01 })) });

/**
 * In-process caller scripted with steps: a function (args) => result, or
 * {fail: kind, message?, attempts?}. Records every call; throws on an unexpected one.
 */
export function scriptedCaller(steps) {
  const queue = [...steps];
  const calls = [];
  return {
    calls,
    remaining: () => queue.length,
    async call(_session, name, args, opts = {}) {
      const step = queue.shift();
      if (!step) throw new Error(`unexpected call to ${name}`);
      calls.push({ name, args, source: opts.source });
      if (typeof step === "function") {
        const result = step(args);
        if (result.tool !== name) throw new Error(`scripted ${result.tool} but ${name} was called`);
        return { ok: true, result, attempts: 1 };
      }
      return { ok: false, kind: step.fail, message: step.message ?? step.fail, attempts: step.attempts ?? 2, ...(step.extra ?? {}) };
    },
  };
}

/** The one concrete action option `i` (0-based) stands for in a batch of `kind` (none for the kinds whose options are strategies). */
export function actionFor(kind, i) {
  if (kind === "order") return { tool: "Bash", target: `node scripts/step-${i + 1}.mjs` };
  if (kind === "command") return { tool: "Bash", target: `npm run check-${i + 1}` };
  if (kind === "edit") return { tool: "Edit", target: `src/file-${i + 1}.js` };
  if (kind === "delegate") return { tool: "Agent", target: `worker-${i + 1}` };
  return null;
}

/** A batch with `n` real options o1..on (with their concrete actions when the kind needs them) and the given extras. */
export function batchOf(n, { kind = "approach", decision = "Which option?", extra = {} } = {}) {
  return {
    decision,
    kind,
    options: Array.from({ length: n }, (_, i) => {
      const action = actionFor(kind, i);
      return { id: `o${i + 1}`, text: `Option number ${i + 1}`, evidence: [`evidence line for option ${i + 1}`], ...(action ? { action } : {}) };
    }),
    ...extra,
  };
}

export function repoWithSession() {
  const repo = makeRepo({ "a.txt": "a\n" });
  return { repo, env: controlEnv(), sessionId: "test-session-1" };
}

/** A jev_gate answer whose decision confidences are all `conf`, at the call's own thresholds `T`. */
export function gateAnswer(T, { conf, safe = conf, rubric = conf } = {}, claims = ["a.js exports a = 2", "b.js is a new file exporting b = 3"]) {
  const g = acceptedGate({}, claims);
  g.review.thresholds = { auto_accept: T, review_at: Math.min(0.5, T), composite_floor: 0.7 };
  g.review.safe_to_apply = safe;
  for (const r of Object.values(g.review.scores)) r.confidence = rubric;
  g.verification.thresholds = { auto_accept: T, review_at: Math.min(0.5, T) };
  for (const r of g.verification.results) {
    r.confidence = conf;
    r.probabilities = { verified: conf, contradicted: Number(((1 - conf) / 2).toFixed(6)), unsupported: Number(((1 - conf) / 2).toFixed(6)) };
  }
  g.verification.results.forEach((r) => { const sum = Object.values(r.probabilities).reduce((a, b) => a + b, 0); r.probabilities.unsupported = Number((r.probabilities.unsupported + (1 - sum)).toFixed(6)); });
  return g;
}

/** The process group id of a pid (ps), as a string. */
export function spawnSyncPs(pid) {
  return run("ps", ["-o", "pgid=", "-p", String(pid)]).stdout.trim();
}

export { mkdirSync };

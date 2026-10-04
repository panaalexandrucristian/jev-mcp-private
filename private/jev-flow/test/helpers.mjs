// Shared fixtures for the jev-flow tests: temporary git repositories and a
// sandboxed environment (HOME and cache under a temp dir, no network).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CANDIDATES_CLI = join(REPO_ROOT, "scripts", "jev-candidates.mjs");
export const HOOK_CLI = join(REPO_ROOT, "scripts", "jev-flow-hook.mjs");
export const METRICS_CLI = join(REPO_ROOT, "scripts", "jev-flow-metrics.py");

export function tempDir(prefix = "jev-flow-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A committed git repository containing `files`. */
export function makeRepo(files = {}) {
  const root = tempDir("jev-flow-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "jev-flow test");
  git(root, "config", "commit.gpgsign", "false");
  writeFiles(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture", "--allow-empty");
  return root;
}

export const FAKE_MCP_SERVER = join(REPO_ROOT, "private", "jev-flow", "test", "fixtures", "fake-mcp-server.mjs");
export const GATE_RUN_CLI = join(REPO_ROOT, "scripts", "jev-gate-run.mjs");

// Credentials and session ids of the real environment never reach a test:
// without them nothing can call a real Jev provider over the network.
const STRIPPED = [
  "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "JEV_API_BASE_URL", "JEV_PROVIDER", "JEV_CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY", "JEV_FLOW_MCP_COMMAND", "CLAUDE_CODE_SESSION_ID",
];

/** Environment isolated from the real HOME, cache and Jev credentials. */
export function sandboxEnv(extra = {}) {
  const home = tempDir("jev-flow-home-");
  const env = { ...process.env };
  for (const name of STRIPPED) delete env[name];
  return {
    ...env,
    HOME: home,
    JEV_FLOW_CACHE_DIR: join(home, "cache"),
    JEV_FLOW: "on",
    JEV_FLOW_STRICT: "",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/**
 * Environment extras for the local fake MCP server (a fake key: no network is ever used). JEV_PROVIDER is typesafe so the
 * gate packs by the tool's own limits; a test of the OpenRouter payload budget passes JEV_PROVIDER: "openrouter".
 */
export function fakeJevEnv(mode = "accepted", extra = {}) {
  return { JEV_FLOW_MCP_COMMAND: JSON.stringify([process.execPath, FAKE_MCP_SERVER]), FAKE_MCP_MODE: mode, OPENROUTER_API_KEY: "sk-or-v1-test-fake", JEV_PROVIDER: "typesafe", ...extra };
}

export function run(command, args, { cwd = REPO_ROOT, env = sandboxEnv(), input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function candidates(args, options) {
  return run(process.execPath, [CANDIDATES_CLI, ...args], options);
}

/**
 * A complete, internally consistent jev_gate result shaped like src/index.ts
 * returns it, accepted, for exactly `claims`. Rubric scores and probabilities
 * are consistent (composite = weighted rubric composite = 1), summaries match
 * the per-claim results, and every distribution is valid.
 */
export function acceptedGate(overrides = {}, claims = ["npm test passed"]) {
  const rubric = (score) => ({
    score,
    confidence: 0.95,
    probabilities: score === 2 ? { 0: 0, 1: 0, 2: 1 } : { 0: 1, 1: 0, 2: 0 },
  });
  return {
    tool: "jev_gate",
    model: "test-model",
    provider: "test",
    truncated: false,
    action: "auto",
    reason_codes: ["accepted"],
    review: {
      safe_to_apply: 0.95,
      scores: { correctness: rubric(2), spec_match: rubric(2), test_gap: rubric(0), blast_radius: rubric(0) },
      weights: { correctness: 0.4, spec_match: 0.3, test_gap: 0.15, blast_radius: 0.15 },
      thresholds: { auto_accept: 0.8, review_at: 0.5, composite_floor: 0.7 },
      action: "auto",
      composite: 1,
      reason_codes: ["accepted"],
      limiting_rubrics: [],
    },
    verification: {
      action: "auto",
      summary: { verified: claims.length, contradicted: 0, unsupported: 0, needs_review: 0, invalid_response: 0 },
      thresholds: { auto_accept: 0.8, review_at: 0.5 },
      results: claims.map((claim) => ({
        claim,
        verdict: "verified",
        confidence: 0.95,
        probabilities: { verified: 0.95, contradicted: 0.02, unsupported: 0.03 },
        action: "auto",
      })),
    },
    usage: { input_tokens: 10, output_tokens: 2 },
    ...overrides,
  };
}

/** Append Claude transcript records for one tool call and its result. */
export function appendTranscriptCall(path, { id, name, input, result, isError = false }) {
  const lines = [
    { type: "assistant", message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { flag: "a" });
}

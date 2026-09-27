import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compilePattern, isPermanentlyExcluded, matchesCompiled, parseDenylist, exclusionReason } from "../paths.mjs";
import {
  classifyShellCommand,
  interpretDecide,
  interpretGate,
  isAllowedFinalMessage,
  jevToolName,
  shouldRetry,
  stopDecision,
  validateGateResult,
} from "../policy.mjs";
import {
  assertMetadataOnly,
  cleanupRetention,
  computeSnapshot,
  emptyState,
  gateCandidate,
  loadState,
  saveState,
  StateBusyError,
  testFreshFor,
  withState,
} from "../state.mjs";
import { acceptedGate, git, makeRepo, tempDir, writeFiles } from "./helpers.mjs";

describe("denylist dialect", () => {
  const cases = [
    ["/secrets/", "secrets/a.ts", true],
    ["/secrets/", "nested/secrets/a.ts", false],
    ["secrets/", "nested/secrets/a.ts", true],
    ["secrets/", "src/secrets", false],
    ["*.sql", "db/deep/schema.sql", true],
    ["*.sql", "db/schema.sqlx", false],
    ["docs/**/private-*.md", "docs/private-a.md", true],
    ["docs/**/private-*.md", "docs/x/y/private-a.md", true],
    ["docs/**/private-*.md", "other/docs/private-a.md", false],
    ["**/fixtures", "a/b/fixtures/x.json", true],
    ["build/**", "build/a/b.js", true],
    ["file?.ts", "src/file1.ts", true],
    ["file?.ts", "src/file10.ts", false],
    ["Secret.txt", "secret.txt", false],
    ["[ab].txt", "[ab].txt", true],
    ["[ab].txt", "a.txt", false],
    ["\\#hash.md", "#hash.md", true],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      assert.equal(matchesCompiled(compilePattern(pattern), path), expected);
    });
  }

  it("parses comments, '*' opt-out and rejects negation", () => {
    const parsed = parseDenylist("# comment\n\n*.log\n!keep.log\n");
    assert.equal(parsed.disabled, false);
    assert.equal(parsed.patterns.length, 1);
    assert.deepEqual(parsed.unsupported, [{ line: "!keep.log", reason: "negation" }]);
    assert.equal(parseDenylist("src/\n*\n").disabled, true);
    assert.equal(parseDenylist("*.ts\n").disabled, false);
  });

  it("permanent exclusions apply at any depth, case-insensitively, and cannot be overridden", () => {
    for (const path of [".env", "app/.env.local", "a/.ENV", "x/.env.example", "k/id_rsa", "k/id_ed25519.pub", "c/tls.pem",
      "app/src/free/google-services.json", "ios/App/GoogleService-Info.plist", "android/local.properties",
      "android/keystore.properties", "signing.properties", "p/App.mobileprovision", "u/.aws/credentials", ".aws/credentials",
      "cfg/credentials-dev.json", "gcp/service-account-ci.json", "rel/app.keystore", "rel/app.jks", ".npmrc", "x/.netrc"]) {
      assert.ok(isPermanentlyExcluded(path), path);
    }
    for (const path of ["src/env.ts", "src/key.ts.bak", "docs/credentials.md", "src/keys.ts"]) {
      assert.ok(!isPermanentlyExcluded(path), path);
    }
    assert.equal(exclusionReason(parseDenylist(""), ".env"), "permanent_exclusion");
  });
});

describe("snapshot", () => {
  it("changes with unstaged, staged, untracked, deleted and denylist changes, and is stable otherwise", () => {
    const repo = makeRepo({ "a.ts": "one\n", "b.ts": "two\n" });
    const seen = new Set();
    const step = (label) => {
      const snap = computeSnapshot(repo);
      assert.ok(snap.hash, label);
      assert.ok(!seen.has(snap.hash), `${label} should change the snapshot`);
      seen.add(snap.hash);
      assert.equal(computeSnapshot(repo).hash, snap.hash, `${label} is deterministic`);
      return snap;
    };
    step("clean");
    writeFiles(repo, { "a.ts": "one changed\n" });
    step("unstaged");
    const unstaged = computeSnapshot(repo).hash;
    git(repo, "add", "a.ts");
    assert.equal(computeSnapshot(repo).hash, unstaged, "staging identical content keeps the content snapshot");
    writeFiles(repo, { "a.ts": "one changed again\n" });
    step("staged plus a new unstaged edit");
    writeFiles(repo, { "new.ts": "new\n" });
    const withNew = step("untracked");
    assert.ok(withNew.changed.includes("new.ts"));
    writeFiles(repo, { "new.ts": "new edited\n" });
    step("untracked edit");
    rmSync(join(repo, "b.ts"));
    step("deleted");
    writeFiles(repo, { ".jev-flow-denylist": "*.sql\n" });
    step("denylist");
  });

  it("returns a null hash outside a git work tree", () => {
    assert.equal(computeSnapshot(tempDir()).hash, null);
  });

  it("hashes large untracked files by content: same size and mtime still change the snapshot", () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    const big = join(repo, "big.bin");
    const content = Buffer.alloc(6 * 1024 * 1024, 0x61);
    writeFileSync(big, content);
    const { atime, mtime } = statSync(big);
    const first = computeSnapshot(repo).hash;
    content[3 * 1024 * 1024] = 0x62;
    writeFileSync(big, content);
    utimesSync(big, atime, mtime);
    assert.equal(statSync(big).size, 6 * 1024 * 1024);
    assert.notEqual(computeSnapshot(repo).hash, first);
  });

  it("an unreadable untracked file makes the snapshot unknown", { skip: process.getuid?.() === 0 }, () => {
    const repo = makeRepo({ "a.ts": "a\n" });
    writeFileSync(join(repo, "locked.txt"), "x");
    chmodSync(join(repo, "locked.txt"), 0o000);
    try {
      const snap = computeSnapshot(repo);
      assert.equal(snap.hash, null);
      assert.match(snap.error, /cannot read locked.txt/);
    } finally {
      chmodSync(join(repo, "locked.txt"), 0o600);
    }
  });

  it("covers unstaged edits of added files in a repository without commits", () => {
    const repo = tempDir("jev-flow-nohead-");
    git(repo, "init", "-q");
    writeFiles(repo, { "a.ts": "one\n" });
    git(repo, "add", "a.ts");
    const staged = computeSnapshot(repo).hash;
    assert.ok(staged);
    writeFiles(repo, { "a.ts": "two\n" });
    const edited = computeSnapshot(repo).hash;
    assert.notEqual(edited, staged);
    writeFiles(repo, { "a.ts": "three\n" });
    assert.notEqual(computeSnapshot(repo).hash, edited);
  });

  it("tracks successive content changes inside a submodule", () => {
    const sub = makeRepo({ "lib.ts": "v1\n" });
    const repo = makeRepo({ "a.ts": "a\n" });
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
    git(repo, "commit", "-q", "-m", "add submodule");
    const clean = computeSnapshot(repo).hash;
    writeFiles(join(repo, "vendor/lib"), { "lib.ts": "v2\n" });
    const dirty1 = computeSnapshot(repo).hash;
    writeFiles(join(repo, "vendor/lib"), { "lib.ts": "v3\n" });
    const dirty2 = computeSnapshot(repo).hash;
    assert.ok(clean && dirty1 && dirty2);
    assert.equal(new Set([clean, dirty1, dirty2]).size, 3);
  });
});

describe("metadata-only state", () => {
  it("rejects multi-line or long strings, unknown keys and verdict fields", () => {
    assert.throws(() => assertMetadataOnly({ a: "line1\nline2" }));
    assert.throws(() => assertMetadataOnly({ a: "x".repeat(301) }));
    const dir = tempDir();
    const state = emptyState();
    state.code = "const x = 1";
    assert.throws(() => saveState(dir, state), /rejects key code/);
    for (const field of ["action", "valid", "stable", "contradicted"]) {
      const bad = emptyState();
      bad.gates.push({ id: "g", req: 1, input: "h", before: "s", after: "s", ts: 1, boot: 0, [field]: "auto" });
      assert.throws(() => saveState(dir, bad), new RegExp(`gate field ${field}`));
    }
    const badTest = emptyState();
    badTest.tests.push({ before: "s", after: "s", exit: 0, ts: 1, passed: true });
    assert.throws(() => saveState(dir, badTest), /test field passed/);
  });

  it("starts fresh from a corrupt or older-format state file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "state.json"), "{not json");
    assert.equal(loadState(dir).gates.length, 0);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, gates: [{ snapshot: "s", action: "auto", valid: true, stable: true }] }));
    assert.equal(loadState(dir).gates.length, 0, "v1 records carrying verdicts are ignored");
  });

  it("serializes concurrent updates through the lock", async () => {
    const dir = tempDir();
    const script = `import { withState } from ${JSON.stringify(new URL("../state.mjs", import.meta.url).href)};
      withState(process.argv[1], (s) => { s.counters.edits += 1; }, Date.now(), { waitMs: 10000 });`;
    const runs = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    }));
    await Promise.all(runs);
    assert.equal(loadState(dir).counters.edits, 8);
  });

  it("a lock held past the wait budget fails without reading or writing", () => {
    const dir = tempDir();
    withState(dir, (s) => {
      s.counters.edits = 1;
    });
    writeFileSync(join(dir, "lock"), `${process.pid}:held`);
    let called = false;
    assert.throws(() => withState(dir, () => {
      called = true;
    }, Date.now(), { waitMs: 50 }), StateBusyError);
    assert.equal(called, false);
    assert.equal(loadState(dir).counters.edits, 1);
    assert.equal(readFileSync(join(dir, "lock"), "utf8"), `${process.pid}:held`, "a live owner's lock is not broken");
  });

  it("never breaks a lock whose owner is gone: abandons without callback or write and names the lock", () => {
    const dir = tempDir();
    withState(dir, (s) => {
      s.counters.edits = 1;
    });
    writeFileSync(join(dir, "lock"), "999999:dead-owner");
    let called = false;
    let error = null;
    try {
      withState(dir, () => {
        called = true;
      }, Date.now(), { waitMs: 50 });
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof StateBusyError);
    assert.equal(error.ownerGone, true);
    assert.equal(error.lockPath, join(dir, "lock"));
    assert.match(error.message, /remove it by hand/);
    assert.equal(called, false);
    assert.equal(loadState(dir).counters.edits, 1);
    assert.equal(readFileSync(join(dir, "lock"), "utf8"), "999999:dead-owner", "the lock is left for manual removal");
  });

  it("no other process can take the lock between the ownership check and the write", () => {
    const dir = tempDir();
    withState(dir, (s) => {
      s.counters.edits = 1;
    });
    const script = `import { withState } from ${JSON.stringify(new URL("../state.mjs", import.meta.url).href)};
      try { withState(process.argv[1], (s) => { s.counters.edits = 99; }, Date.now(), { waitMs: 100 }); process.exit(0); }
      catch (e) { process.exit(e?.name === "StateBusyError" ? 3 : 1); }`;
    let childStatus = null;
    withState(dir, (s) => {
      s.counters.edits = 2;
    }, Date.now(), {
      // Interleave a competing process after ownsLock() and before saveState().
      beforeSave: () => {
        childStatus = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: "ignore" }).status;
      },
    });
    assert.equal(childStatus, 3, "the competing process gets StateBusyError and never runs its callback");
    assert.equal(loadState(dir).counters.edits, 2, "the owner's update is saved and not lost");
    assert.ok(!existsSync(join(dir, "lock")), "the owner releases its lock");
  });

  it("a live owner's lock is never broken, however old", () => {
    const dir = tempDir();
    withState(dir, () => {});
    writeFileSync(join(dir, "lock"), `${process.pid}:old-but-alive`);
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(join(dir, "lock"), past, past);
    assert.throws(() => withState(dir, () => {}, Date.now(), { waitMs: 50 }), StateBusyError);
    assert.equal(readFileSync(join(dir, "lock"), "utf8"), `${process.pid}:old-but-alive`);
  });

  it("a lock without a readable owner is not broken", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lock"), "");
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(join(dir, "lock"), past, past);
    assert.throws(() => withState(dir, () => {}, Date.now(), { waitMs: 50 }), StateBusyError);
    assert.ok(existsSync(join(dir, "lock")));
  });

  it("abandons without writing when lock ownership changes during the update", () => {
    const dir = tempDir();
    withState(dir, (s) => {
      s.counters.edits = 1;
    });
    assert.throws(() => withState(dir, (s) => {
      s.counters.edits = 99;
      writeFileSync(join(dir, "lock"), `${process.pid}:someone-else`);
    }), StateBusyError);
    assert.equal(loadState(dir).counters.edits, 1);
    assert.equal(readFileSync(join(dir, "lock"), "utf8"), `${process.pid}:someone-else`, "the new owner's lock is left alone");
  });

  it("the latest gate attempt decides: unfinished, failed, other-request, unstable or older attempts are not candidates", () => {
    const state = emptyState();
    state.boot = 2;
    state.request.seq = 3;
    const g = (over) => ({ id: "g", req: 3, input: "h", before: "s1", after: "s1", ts: 1, boot: 2, failed: false, ...over });
    state.gates = [g({})];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).record.id, "g");
    assert.equal(gateCandidate(state, { snapshot: "s2" }).reason, "gate_on_older_snapshot");
    assert.equal(gateCandidate(state, { snapshot: null }).reason, "snapshot_unknown");
    state.gates = [g({ before: "unknown" })];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "gate_snapshot_unknown");
    state.gates = [g({ before: "s0" })];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "changed_during_gate");
    state.gates = [g({ req: 2 })];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "gate_from_other_request");
    state.gates = [g({ boot: 1 })];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "no_gate");
    state.gates = [g({ id: "old", ts: 1 }), g({ id: "new", ts: 2, failed: true, after: "unknown" })];
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "latest_gate_failed");
    state.gates = [g({ ts: 1 })];
    state.pending = { p1: { kind: "gate", before: "s1", input: "h2", req: 3, boot: 2, ts: 5 } };
    assert.equal(gateCandidate(state, { snapshot: "s1" }).reason, "latest_gate_unfinished", "a started but unfinished call supersedes");
    state.pending = { p1: { kind: "gate", before: "s1", input: "h2", req: 3, boot: 1, ts: 5 } };
    assert.equal(gateCandidate(state, { snapshot: "s1" }).record.id, "g", "attempts from an earlier boot do not count");
  });

  it("checks count only when the latest run of every command passed on this snapshot", () => {
    const t = (over) => ({ cmd: "npm", req: 1, boot: 0, before: "s1", after: "s1", exit: 0, failed: false, ts: 1, ...over });
    const state = emptyState();
    assert.equal(testFreshFor(state, "s1"), false, "no checks at all");
    state.tests = [t({})];
    assert.equal(testFreshFor(state, "s1"), true);
    assert.equal(testFreshFor(state, "s2"), false, "older snapshot");
    state.tests = [t({ before: "s0" })];
    assert.equal(testFreshFor(state, "s1"), false, "snapshot changed during the run");
    state.tests = [t({ exit: null })];
    assert.equal(testFreshFor(state, "s1"), false, "unknown exit code is not success");
    state.tests = [t({ ts: 1 }), t({ ts: 2, exit: null, failed: true })];
    assert.equal(testFreshFor(state, "s1"), false, "a failed rerun cancels the earlier success");
    state.tests = [t({ ts: 1 }), t({ ts: 2, exit: null })];
    assert.equal(testFreshFor(state, "s1"), false, "an unknown rerun cancels the earlier success");
    state.tests = [t({ ts: 1 }), t({ cmd: "lint", ts: 2, exit: 1 })];
    assert.equal(testFreshFor(state, "s1"), false, "another check's latest run failed");
    state.tests = [t({ ts: 1 })];
    state.pending = { b: { kind: "test", before: "s1", cmd: "npm", req: 1, boot: 0, ts: 3 } };
    assert.equal(testFreshFor(state, "s1"), false, "a check is still running");
  });
});

describe("retention", () => {
  it("removes sessions older than 30 days without following symlinks", () => {
    const root = tempDir("jev-flow-cache-");
    const outside = tempDir("jev-flow-keep-");
    writeFileSync(join(outside, "precious.txt"), "keep");
    const old = join(root, "repo1", "old");
    const fresh = join(root, "repo1", "fresh");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "state.json"), "{}");
    writeFileSync(join(fresh, "state.json"), "{}");
    symlinkSync(outside, join(old, "link"));
    symlinkSync(outside, join(root, "repo-link"));
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    utimesSync(join(old, "state.json"), past, past);
    utimesSync(old, past, past);
    const removed = cleanupRetention(root);
    assert.deepEqual(removed, ["repo1/old"]);
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(join(outside, "precious.txt")));
    assert.ok(existsSync(join(root, "repo-link")));
  });
});

describe("result policy", () => {
  const gate = (overrides) => ({ tool: "jev_gate", action: "auto", reason_codes: ["accepted"], verification: { results: [] }, ...overrides });

  it("a valid contradiction wins over an invalid answer elsewhere", () => {
    const result = gate({
      action: "escalate",
      reason_codes: ["invalid_response", "claims_contradicted"],
      verification: { results: [{ claim: "tests pass", verdict: "contradicted", confidence: 0.6 }, { claim: "x", verdict: null, status: "invalid_response" }] },
    });
    const out = interpretGate(result);
    assert.equal(out.route, "stop_contradiction");
    assert.deepEqual(out.contradicted, [{ claim: "tests pass", confidence: 0.6 }]);
  });

  it("validateGateResult accepts only complete, consistent results for the call's claims", () => {
    const claims = ["npm test passed"];
    assert.deepEqual(validateGateResult(acceptedGate(), { claims }), { accepted: true, problems: [], malformed: false, below_flow_minimum: [] });
    const g = acceptedGate();
    const rubric = (over) => ({ ...g.review.scores.correctness, ...over });
    const claimResult = (over) => ({ ...g.verification.results[0], ...over });
    const rejects = {
      bare: [{ tool: "jev_gate", action: "auto" }],
      not_gate: [{ ...g, tool: "jev_review" }],
      no_call_claims: [g, null],
      claim_text_mismatch: [g, ["other claim"]],
      fewer_results_than_claims: [g, ["npm test passed", "lint passed"]],
      truncated_claim: [acceptedGate({}, ["x".repeat(2001)]), ["x".repeat(2001)]],
      truncated: [acceptedGate({ truncated: true })],
      extra_code: [acceptedGate({ reason_codes: ["accepted", "claim_confidence_below_auto_accept"] })],
      review_not_auto: [acceptedGate({ review: { ...g.review, action: "review" } })],
      review_status: [acceptedGate({ review: { ...g.review, status: "invalid_response" } })],
      review_missing_rubric: [acceptedGate({ review: { ...g.review, scores: { correctness: rubric({}) } } })],
      rubric_score_domain: [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ score: 3 }) } } })],
      rubric_low_confidence: [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ confidence: 0.5 }) } } })],
      rubric_bad_distribution: [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ probabilities: { 0: 0.5, 1: 0.2, 2: 0.2 } }) } } })],
      composite_inconsistent: [acceptedGate({ review: { ...g.review, composite: 0.75 } })],
      composite_domain: [acceptedGate({ review: { ...g.review, composite: 1.5 } })],
      safe_to_apply_low: [acceptedGate({ review: { ...g.review, safe_to_apply: 0.6 } })],
      lowered_thresholds: [acceptedGate({
        review: { ...g.review, thresholds: { auto_accept: 0.1, review_at: 0.05, composite_floor: 0.1 }, safe_to_apply: 0.3 },
        verification: { ...g.verification, thresholds: { auto_accept: 0.1, review_at: 0.05 }, results: [claimResult({ confidence: 0.3, probabilities: { verified: 0.4, contradicted: 0.3, unsupported: 0.3 } })] },
      })],
      thresholds_inverted: [acceptedGate({ verification: { ...g.verification, thresholds: { auto_accept: 0.5, review_at: 0.9 } } })],
      claim_unsupported: [acceptedGate({ verification: { ...g.verification, results: [claimResult({ verdict: "unsupported", action: "review" })] } })],
      claim_null_confidence: [acceptedGate({ verification: { ...g.verification, results: [claimResult({ confidence: null })] } })],
      claim_not_argmax: [acceptedGate({ verification: { ...g.verification, results: [claimResult({ probabilities: { verified: 0.2, contradicted: 0.7, unsupported: 0.1 } })] } })],
      claim_probability_sum: [acceptedGate({ verification: { ...g.verification, results: [claimResult({ probabilities: { verified: 0.95, contradicted: 0.2, unsupported: 0.1 } })] } })],
      summary_inconsistent: [acceptedGate({ verification: { ...g.verification, summary: { verified: 2, contradicted: 0, unsupported: 0, needs_review: 0, invalid_response: 0 } } })],
      summary_dirty: [acceptedGate({ verification: { ...g.verification, summary: { verified: 1, contradicted: 1, unsupported: 0, needs_review: 0, invalid_response: 0 } } })],
      no_results: [acceptedGate({ verification: { ...g.verification, results: [], summary: { verified: 0, contradicted: 0, unsupported: 0, needs_review: 0, invalid_response: 0 } } })],
    };
    rejects.rubric_score_mean_mismatch = [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ probabilities: { 0: 0.5, 1: 0, 2: 0.5 } }) } } })];
    rejects.rubric_distribution_not_object = [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ probabilities: [0, 0, 1] }) } } })];
    rejects.rubric_null_confidence = [acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: rubric({ confidence: null }) } } })];
    for (const [name, [result, callClaims = claims]] of Object.entries(rejects)) {
      assert.equal(validateGateResult(result, { claims: callClaims }).accepted, false, name);
    }
  });

  it("accepts the nullable rubric distributions and rounding drift that upstream accepts", () => {
    const claims = ["npm test passed"];
    const g = acceptedGate();
    const withRubric = (over) => acceptedGate({ review: { ...g.review, scores: { ...g.review.scores, correctness: { ...g.review.scores.correctness, ...over } } } });
    assert.equal(validateGateResult(withRubric({ probabilities: null }), { claims }).accepted, true, "null distribution (not reported by the provider)");
    const allNull = acceptedGate({
      review: { ...g.review, scores: Object.fromEntries(Object.entries(g.review.scores).map(([k, v]) => [k, { ...v, probabilities: null }])) },
    });
    assert.equal(validateGateResult(allNull, { claims }).accepted, true, "every rubric distribution null");
    // |2 - (1*0.02 + 2*0.98)| = 0.02: inside the upstream SCORE_MEAN_TOLERANCE (0.02 + 1e-12).
    assert.equal(validateGateResult(withRubric({ probabilities: { 0: 0, 1: 0.02, 2: 0.98 } }), { claims }).accepted, true, "mean within tolerance");
    const drift = validateGateResult(withRubric({ probabilities: { 0: 0, 1: 0.05, 2: 0.95 } }), { claims });
    assert.equal(drift.accepted, false);
    assert.equal(drift.malformed, true);
    assert.ok(drift.problems.includes("review_correctness_score_mean_mismatch"));
  });

  it("separates malformed answers (retry) from valid answers below the flow minimums (ask the user)", () => {
    const claims = ["npm test passed"];
    const g = acceptedGate();
    // A valid upstream auto for a call with lowered thresholds: consistent with its
    // own policy, but weaker than the flow minimums (0.8 / 0.8 / 0.7).
    const weak = acceptedGate({
      review: { ...g.review, thresholds: { auto_accept: 0.6, review_at: 0.5, composite_floor: 0.5 }, safe_to_apply: 0.7 },
      verification: { ...g.verification, thresholds: { auto_accept: 0.6, review_at: 0.5 }, results: [{ ...g.verification.results[0], confidence: 0.7, probabilities: { verified: 0.7, contradicted: 0.1, unsupported: 0.2 } }] },
    });
    const weakCheck = validateGateResult(weak, { claims });
    assert.equal(weakCheck.accepted, false);
    assert.equal(weakCheck.malformed, false);
    assert.deepEqual(weakCheck.below_flow_minimum, ["review_safe_to_apply_below_flow_minimum", "claim_0_confidence_below_flow_minimum"]);
    const weakRoute = interpretGate(weak, { claims });
    assert.equal(weakRoute.route, "ask_user");
    assert.deepEqual(weakRoute.reasons, weakCheck.below_flow_minimum);

    // Below the call's own threshold while claiming auto: inconsistent, so malformed.
    const inconsistent = acceptedGate({ review: { ...g.review, safe_to_apply: 0.6 } });
    const bad = validateGateResult(inconsistent, { claims });
    assert.equal(bad.malformed, true);
    assert.ok(bad.problems.includes("review_safe_to_apply_below_call_threshold"));
    assert.equal(interpretGate(inconsistent, { claims }).route, "retry_or_unavailable");
    // Out-of-domain numbers are malformed too, even with a weak valid value elsewhere.
    const mixed = acceptedGate({ ...weak, review: { ...weak.review, composite: -10 } });
    assert.equal(validateGateResult(mixed, { claims }).malformed, true);
    assert.equal(interpretGate(mixed, { claims }).route, "retry_or_unavailable");
  });

  it("routes invalid, escalate, review and auto", () => {
    assert.equal(interpretGate(gate({ action: "escalate", reason_codes: ["invalid_response"] })).route, "retry_or_unavailable");
    assert.equal(interpretGate(null).route, "retry_or_unavailable");
    assert.equal(interpretGate(gate({ action: "escalate", reason_codes: ["review_escalated"] })).route, "ask_user");
    assert.equal(interpretGate(gate({ action: "review", reason_codes: ["claims_unsupported"] })).route, "needs_evidence");
    assert.equal(interpretGate(gate({ action: "review", reason_codes: ["review_required"] })).route, "ask_user");
    assert.equal(interpretGate(gate({})).route, "retry_or_unavailable", "a bare auto is incomplete");
    assert.equal(interpretGate(acceptedGate()).route, "retry_or_unavailable", "claims of the call are required");
    assert.equal(interpretGate(acceptedGate(), { claims: ["npm test passed"] }).route, "accepted");
  });

  it("retries once, only for transport or invalid_response, never after cancellation", () => {
    assert.equal(shouldRetry({ attempt: 0, failure: "transport" }), true);
    assert.equal(shouldRetry({ attempt: 0, failure: "invalid_response" }), true);
    assert.equal(shouldRetry({ attempt: 1, failure: "transport" }), false);
    assert.equal(shouldRetry({ attempt: 0, failure: "transport", cancelledByUser: true }), false);
    assert.equal(shouldRetry({ attempt: 0, failure: "review" }), false);
  });

  it("consequential decisions need confidence ≥ 0.8, no escape hatch and no warnings", () => {
    const decide = (rec, warnings = []) => ({ tool: "jev_decide", recommendation: rec, warnings });
    assert.equal(interpretDecide(decide({ selected: "a", escaped: false, confidence: 0.9 })).route, "accepted");
    assert.equal(interpretDecide(decide({ selected: "a", escaped: false, confidence: 0.79 })).route, "human_review");
    assert.equal(interpretDecide(decide({ selected: "a", escaped: false, confidence: null })).route, "human_review");
    assert.equal(interpretDecide(decide({ selected: "a", escaped: false, confidence: 0.95 }, ["Requirement 1 contradicted"])).route, "human_review");
    assert.equal(interpretDecide(decide({ selected: "a", escaped: false, confidence: 0.5 }), { consequential: false }).route, "manual_inspection");
    assert.equal(interpretDecide(decide({ selected: "investigate", escaped: true, confidence: 0.9 })).route, "investigate");
    assert.equal(interpretDecide(decide({ selected: "ask_user", escaped: true, confidence: 0.9 })).route, "ask_user");
    assert.equal(interpretDecide(decide({ selected: "none", escaped: true, confidence: 0.9 })).route, "reformulate");
    assert.equal(interpretDecide(decide({ selected: null, status: "invalid_response" })).route, "retry_or_unavailable");
  });

  it("recognizes Jev tool names from both CLIs", () => {
    assert.equal(jevToolName("mcp__plugin_jev_jev__jev_gate"), "gate");
    assert.equal(jevToolName("mcp__jev__jev_find"), "find");
    assert.equal(jevToolName("jev:jev_verify"), "verify");
    assert.equal(jevToolName("Read"), null);
    assert.equal(jevToolName("mcp__other__not_jev_gate"), null);
  });
});

describe("strict Stop rules", () => {
  it("allows only the fixed phrases, 'Incomplete:' last lines and questions", () => {
    assert.ok(isAllowedFinalMessage("Done.\nJev unavailable; gate not evaluated"));
    assert.ok(isAllowedFinalMessage("Jev disabled for this repo; gate not evaluated. Tests pass."));
    assert.ok(isAllowedFinalMessage("Summary\nIncomplete: the migration test was not run.\n\n"));
    assert.ok(isAllowedFinalMessage("Should I also update the docs?"));
    assert.ok(!isAllowedFinalMessage("The work is incomplete in places but done."));
    assert.ok(!isAllowedFinalMessage("Incomplete: first line\nAll done."));
    assert.ok(!isAllowedFinalMessage("Is this right? Anyway, done."));
    assert.ok(!isAllowedFinalMessage(undefined));
  });

  it("blocks once, honors stop_hook_active and never blocks without code changes", () => {
    const base = { strict: true, stopHookActive: false, lastMessage: "Done.", codeChanged: true, gateAccepted: false, redirectedBefore: false, snapshotKnown: true };
    assert.equal(stopDecision(base).action, "block");
    assert.equal(stopDecision({ ...base, redirectedBefore: true }).action, "notify");
    assert.equal(stopDecision({ ...base, stopHookActive: true }).action, "notify");
    assert.equal(stopDecision({ ...base, gateAccepted: true }).action, "none");
    assert.equal(stopDecision({ ...base, codeChanged: false }).action, "none");
    assert.equal(stopDecision({ ...base, lastMessage: "Need anything else?" }).action, "none");
    assert.equal(stopDecision({ ...base, snapshotKnown: false }).action, "notify");
    assert.equal(stopDecision({ ...base, strict: false }).action, "notify");
  });
});

describe("shell classification", () => {
  const cases = [
    ["rg -n widget src", "exploration"],
    ["cd src && rg widget", "exploration"],
    ["cd /repo && git grep -n foo | head -20", "exploration"],
    ["ls 2>/dev/null", "exploration"],
    ["sed -n '1,40p' a.ts", "exploration"],
    ["npm test", "test"],
    ["cd /repo && node --test private/jev-flow/test/", "test"],
    ["CI=1 npx vitest run", "test"],
    ["./gradlew testDebugUnitTest", "test"],
    ["sed -i '' 's/a/b/' a.ts", "mutation"],
    ["echo hi > a.txt", "mutation"],
    ["rg foo && rm -rf build", "mutation"],
    ["git checkout -- a.ts", "mutation"],
    ["python3 tool.py", "unknown"],
    ["rg foo && python3 tool.py", "unknown"],
  ];
  for (const [command, expected] of cases) {
    it(`${command} → ${expected}`, () => assert.equal(classifyShellCommand(command), expected));
  }
});


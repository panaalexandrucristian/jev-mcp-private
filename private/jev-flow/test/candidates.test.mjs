import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { dueJevCall, exactMatcher, exactToken, mapJevResult, recommendNext } from "../candidates.mjs";
import { candidates, fakeJevEnv, git, makeRepo, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const REGEX_SOURCE = [
  "// Regex helpers",
  "export function normalizeFlags(flags) {",
  "  // Normalize regex flag strings so 'gi' never becomes 'gig'.",
  "  const unique = new Set(flags.split(''));",
  "  unique.add('g');",
  "  return [...unique].join('');",
  "}",
  "",
].join("\n");

const FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

function parse(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("jev-candidates: output contract", () => {
  it("emits candidates plus a separate id → path/sha256/lines map within budgets", () => {
    const repo = makeRepo({ "src/regex.ts": REGEX_SOURCE, "README.md": "Regex flag docs.\n" });
    const out = parse(candidates(["--root", repo, "--query", "regex flag normalization", "--limit", "5"]));
    assert.equal(out.disabled, false);
    assert.ok(out.candidates.length >= 1 && out.candidates.length <= 5);
    out.candidates.forEach((c, i) => {
      assert.deepEqual(Object.keys(c).sort(), ["id", "text"]);
      assert.equal(c.id, `c${i}`);
      assert.ok(c.text.length <= 1000);
      const entry = out.map[c.id];
      assert.ok(entry, "every candidate has a map entry");
      assert.ok(c.text.startsWith(`${entry.path}:${entry.start_line}-${entry.end_line}`));
      assert.equal(entry.sha256, sha(readFileSync(join(repo, entry.path))));
      assert.ok(entry.end_line - entry.start_line + 1 <= 60);
    });
    assert.equal(out.map.c0.path, "src/regex.ts");
    assert.equal(typeof out.coverage.complete, "boolean");
  });

  it("includes staged, unstaged, new and renamed files but not ignored ones", () => {
    const repo = makeRepo({ "src/a.ts": "export const alpha = 1;\n", "src/old.ts": "export const widget = 1;\n", ".gitignore": "build/\n" });
    writeFiles(repo, { "src/a.ts": "export const alpha = 'widget staged';\n" });
    git(repo, "add", "src/a.ts");
    writeFiles(repo, { "src/new.ts": "export const widgetNew = true;\n", "build/out.ts": "export const widget = 'ignored';\n" });
    git(repo, "mv", "src/old.ts", "src/renamed.ts");
    writeFiles(repo, { "src/renamed.ts": "export const widget = 'unstaged edit';\n" });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const paths = Object.values(out.map).map((m) => m.path);
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("src/new.ts"));
    assert.ok(paths.includes("src/renamed.ts"));
    assert.ok(!paths.includes("src/old.ts"));
    assert.ok(!paths.some((p) => p.startsWith("build/")));
    const renamed = out.candidates.find((c) => out.map[c.id].path === "src/renamed.ts");
    assert.match(renamed.text, /unstaged edit/);
  });

  it("handles Unicode paths", () => {
    const repo = makeRepo({ "src/regulă-ñ.ts": "export const widget = 'unicode';\n" });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    assert.deepEqual(Object.values(out.map).map((m) => m.path), ["src/regulă-ñ.ts"]);
  });

  it("never follows symlinks, inside or outside the repository", () => {
    const outside = tempDir("jev-flow-outside-");
    writeFileSync(join(outside, "secret.ts"), "export const widget = 'outside';\n");
    const repo = makeRepo({ "src/real.ts": "export const widget = 'inside';\n" });
    symlinkSync(join(outside, "secret.ts"), join(repo, "src/escape.ts"));
    symlinkSync(join(repo, "src/real.ts"), join(repo, "src/alias.ts"));
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const paths = Object.values(out.map).map((m) => m.path);
    assert.deepEqual(paths, ["src/real.ts"]);
    assert.equal(out.coverage.skipped.symlink, 2);
    assert.doesNotMatch(JSON.stringify(out), /'outside'/);
  });
});

describe("jev-candidates: data policy", () => {
  it("never emits permanently excluded files, including Android flavors", () => {
    const files = {
      "src/app.ts": "export const widget = 1;\n",
      ".env": `WIDGET_TOKEN=${FAKE_GH}\nwidget=1\n`,
      ".env.example": "widget=example\n",
      "app/src/free/google-services.json": '{"widget": "api_key_widget"}\n',
      "app/src/paid/google-services.json": '{"widget": "api_key_widget"}\n',
      "app/release.keystore": "widget keystore\n",
      "config/credentials-prod.json": '{"widget": 1}\n',
      "keys/id_ed25519.pub": "ssh-ed25519 widget\n",
      "local.properties": "widget.dir=/sdk\n",
      "ios/GoogleService-Info.plist": "<plist>widget</plist>\n",
      "home/.aws/credentials": "[widget]\n",
      "certs/server.PEM": "widget\n",
    };
    const repo = makeRepo(files);
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    assert.deepEqual(Object.values(out.map).map((m) => m.path), ["src/app.ts"]);
    assert.equal(out.coverage.skipped.excluded, Object.keys(files).length - 1);
    assert.doesNotMatch(JSON.stringify(out), new RegExp(FAKE_GH));
  });

  it("applies the denylist dialect and reports unsupported negation", () => {
    const repo = makeRepo({
      ".jev-flow-denylist": "# private areas\n/secrets/\n*.sql\ndocs/**/private-*.md\n!src/keep.ts\n",
      "secrets/a.ts": "widget\n",
      "db/schema.sql": "widget\n",
      "docs/x/y/private-notes.md": "widget\n",
      "docs/public.md": "widget\n",
      "src/keep.ts": "widget\n",
      "nested/secrets/b.ts": "widget\n",
    });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const paths = Object.values(out.map).map((m) => m.path).sort();
    assert.deepEqual(paths, [".jev-flow-denylist", "docs/public.md", "nested/secrets/b.ts", "src/keep.ts"].filter((p) => p !== ".jev-flow-denylist"));
    assert.equal(out.coverage.skipped.denylisted, 3);
    assert.deepEqual(out.coverage.denylist_unsupported, [{ line: "!src/keep.ts", reason: "negation" }]);
  });

  it("returns disabled with no candidates when the denylist is '*'", () => {
    const repo = makeRepo({ ".jev-flow-denylist": "*\n", "src/a.ts": "widget\n" });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    assert.equal(out.disabled, true);
    assert.equal(out.reason, "Jev disabled for this repo; gate not evaluated");
    assert.deepEqual(out.candidates, []);
    assert.deepEqual(out.map, {});
  });

  it("redacts credentials in fragments and omits windows that stay suspicious", () => {
    const repo = makeRepo({
      "src/config.ts": `// widget config\nconst awsKey = "${FAKE_AWS}";\nexport const widget = { token: "${FAKE_GH}" };\n`,
      "src/blob.ts": "// widget blob\nexport const note = 'auth secret blob: Zq8vN3xLm2Pw9Rt4Kd7Yh1Bc6Fs5Jg0Q';\n",
    });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, new RegExp(FAKE_AWS));
    assert.doesNotMatch(text, new RegExp(FAKE_GH));
    assert.doesNotMatch(text, /Zq8vN3xLm2Pw9Rt4Kd7Yh1Bc6Fs5Jg0Q/);
    assert.match(text, /\[REDACTED:aws_access_key\]/);
    assert.deepEqual(out.omitted.map((o) => [o.path, o.reason]), [["src/blob.ts", "suspicious_content"]]);
    assert.equal(out.coverage.complete, false);
  });
});

describe("jev-candidates: budgets and coverage", () => {
  const many = Array.from({ length: 400 }, (_, i) => (i % 80 === 0 ? `export function widget${i}() { return "widget"; }` : `// filler line ${i}`)).join("\n");

  it("caps candidates at --limit and reports incomplete coverage", () => {
    const repo = makeRepo({ "src/many.ts": many, "src/more.ts": many });
    const out = parse(candidates(["--root", repo, "--query", "widget", "--limit", "3"]));
    assert.equal(out.candidates.length, 3);
    assert.equal(out.coverage.complete, false);
    assert.ok(out.coverage.reasons.includes("candidate_limit_reached"));
  });

  it("respects --chunk-chars including the header and cuts over-long lines", () => {
    const repo = makeRepo({ "src/long.ts": `export const widget = "${"x".repeat(3000)}";\n` });
    const out = parse(candidates(["--root", repo, "--query", "widget", "--chunk-chars", "200"]));
    assert.equal(out.candidates.length, 1);
    assert.ok(out.candidates[0].text.length <= 200);
    assert.match(out.candidates[0].text, /line truncated/);
    assert.ok(out.coverage.reasons.includes("long_lines_truncated"));
  });

  it("skips large and binary files and says so", () => {
    const repo = makeRepo({ "src/big.ts": `// widget\n${"a".repeat(500)}\n`, "src/small.ts": "widget\n" });
    writeFileSync(join(repo, "img.bin"), Buffer.from([0x77, 0x69, 0x64, 0x00, 0x01]));
    const out = parse(candidates(["--root", repo, "--query", "widget", "--max-file-bytes", "100"]));
    assert.equal(out.coverage.skipped.too_large, 1);
    assert.equal(out.coverage.skipped.binary, 1);
    assert.ok(out.coverage.reasons.includes("large_files_skipped"));
  });

  it("rejects budgets above the design limits", () => {
    const repo = makeRepo({ "a.ts": "widget\n" });
    assert.equal(candidates(["--root", repo, "--query", "widget", "--limit", "49"]).code, 2);
    assert.equal(candidates(["--root", repo, "--query", "widget", "--chunk-chars", "1001"]).code, 2);
    assert.equal(candidates(["--root", repo, "--query", "widget", "--window-lines", "61"]).code, 2);
  });
});

describe("jev-candidates: safety", () => {
  it("never evaluates the query as shell and writes nothing", () => {
    const repo = makeRepo({ "src/a.ts": "widget\n" });
    const env = sandboxEnv();
    const before = git(repo, "status", "--porcelain");
    const entries = readdirSync(repo).sort();
    const result = candidates(["--root", repo, "--query", "widget $(touch pwned) `touch pwned2`; touch pwned3"], { cwd: repo, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(git(repo, "status", "--porcelain"), before);
    assert.deepEqual(readdirSync(repo).sort(), entries);
    assert.ok(!existsSync(join(env.HOME, ".cache")));
    assert.ok(!existsSync(env.JEV_FLOW_CACHE_DIR));
  });

  it("fails with exit 2 outside a git work tree", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    const result = candidates(["--root", dir, "--query", "widget"]);
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.stderr).error, /not a git work tree/);
  });
});

describe("jev-candidates --sanitize", () => {
  const secrets = [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + "IBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    `aws=${FAKE_AWS}`,
    `token ${FAKE_GH}`,
    "OPENAI sk-" + "proj1234567890abcdefABCDEF",
    "ANTHROPIC sk-ant-" + "api03-abcdefghijklmnopqrstuv",
    "OR sk-or-" + "v1-abcdefghijklmnopqrstuvwx",
    "slack xoxb-" + "123456789012-abcdefghij",
    "google AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
    "jwt eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "Authorization: Bearer " + "abcDEF123456ghiJKL",
    "DB_PASSWORD=" + "hunter2hunter2x9",
    "storePassword 'gr" + "adleSecret9'",
    'keyPassword = "an' + 'droidKey77"',
    '"private_key": "not-a-pem-but-' + 'secret-9"',
  ];

  it("redacts every approved credential kind in text", () => {
    const repo = makeRepo({ "a.ts": "x\n" });
    const result = candidates(["--sanitize", "--root", repo, "--mode", "text"], { input: secrets.join("\n") });
    const out = parse(result);
    for (const raw of [FAKE_AWS, FAKE_GH, "hunter2hunter2x9", "adleSecret9", "droidKey77", "secret-9", "abcDEF123456ghiJKL", "MIIEow"]) {
      assert.ok(!out.text.includes(raw), `leaked ${raw}`);
    }
    const kinds = out.redactions.map((r) => r.kind).sort();
    for (const kind of ["aws_access_key", "bearer_token", "credential_assignment", "github_token", "google_api_key", "jwt", "pem_private_key", "sk_api_key", "slack_token"]) {
      assert.ok(kinds.includes(kind), `missing ${kind}`);
    }
  });

  it("keeps ordinary code readable", () => {
    const repo = makeRepo({ "a.ts": "x\n" });
    const code = "const token = options.token;\nfunction check(password: string) {}\nconst secret = process.env.SECRET;\n";
    const out = parse(candidates(["--sanitize", "--root", repo], { input: code }));
    assert.equal(out.text, code);
    assert.deepEqual(out.redactions, []);
  });

  it("drops diff sections of excluded and denylisted paths by provenance", () => {
    const repo = makeRepo({ ".jev-flow-denylist": "private/\n" });
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "+export const ok = 1;",
      "diff --git a/.env b/.env",
      "+PLAIN_VALUE_WITHOUT_PATTERN=abc",
      "diff --git a/app/google-services.json b/app/google-services.json",
      '+{"project": "x"}',
      "diff --git a/private/notes.md b/private/notes.md",
      "+internal plan",
      "",
    ].join("\n");
    const out = parse(candidates(["--sanitize", "--root", repo], { input: diff }));
    assert.equal(out.mode, "diff");
    assert.match(out.text, /export const ok = 1/);
    assert.doesNotMatch(out.text, /PLAIN_VALUE_WITHOUT_PATTERN|project|internal plan/);
    assert.deepEqual(out.omitted.map((o) => [o.path, o.reason]), [
      [".env", "permanent_exclusion"],
      ["app/google-services.json", "permanent_exclusion"],
      ["private/notes.md", "denylisted"],
    ]);
  });

  it("returns disabled for '*' and exit 3 above 2 MiB", () => {
    const off = makeRepo({ ".jev-flow-denylist": "*\n" });
    const out = parse(candidates(["--sanitize", "--root", off], { input: "anything" }));
    assert.equal(out.disabled, true);
    assert.equal(out.text, "");
    const repo = makeRepo({ "a.ts": "x\n" });
    const big = candidates(["--sanitize", "--root", repo], { input: "a".repeat(2 * 1024 * 1024 + 10) });
    assert.equal(big.code, 3);
  });
});

describe("jev-candidates: provenance after redaction", () => {
  it("multi-line PEM redaction keeps fragments aligned with source line numbers", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "c2VjcmV0c2VjcmV0c2VjcmV0", "-----END PRIVATE KEY-----"];
    const source = ["// widget config", ...pem, "export const widgetMarker = 6;", ""].join("\n");
    const repo = makeRepo({ "src/conf.ts": source });
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const [c] = out.candidates;
    const entry = out.map[c.id];
    const bodyLines = c.text.split("\n").slice(1);
    const sourceLines = source.split("\n");
    const markerIndex = bodyLines.findIndex((l) => l.includes("widgetMarker"));
    assert.ok(markerIndex >= 0);
    assert.equal(sourceLines[entry.start_line - 1 + markerIndex], "export const widgetMarker = 6;", "fragment line maps to the same source line");
    assert.equal(entry.end_line - entry.start_line + 1, bodyLines.length);
    assert.doesNotMatch(c.text, /MIIEvQ|c2VjcmV0/);
  });

  it("keeps outline and path-only candidates within the character budget", () => {
    const longDir = `widget/${"deeply-nested-directory-name/".repeat(8)}`;
    const repo = makeRepo({
      [`${longDir}impl.ts`]: "export function alpha() {}\nexport function beta() {}\n",
      [`${longDir}plain.txt`]: "no declarations here\n",
      "src/widget-outline.ts": Array.from({ length: 40 }, (_, i) => `export function handler${i}WithAVeryLongDescriptiveName() {}`).join("\n"),
    });
    const out = parse(candidates(["--root", repo, "--query", "widget", "--chunk-chars", "200"]));
    for (const c of out.candidates) assert.ok(c.text.length <= 200, `${c.text.length} > 200`);
    const omittedPaths = out.omitted.filter((o) => o.reason === "path_exceeds_budget").map((o) => o.path).sort();
    assert.deepEqual(omittedPaths, [`${longDir}impl.ts`, `${longDir}plain.txt`], "paths longer than the budget are omitted, not overrun");
    const outline = out.candidates.find((c) => out.map[c.id].path === "src/widget-outline.ts");
    assert.ok(outline && out.map[outline.id].kind === "outline");
    assert.equal(out.coverage.complete, false);
  });

  it("skips tracked files that match ignore rules", () => {
    const repo = makeRepo({ "src/a.ts": "widget\n", "generated/out.ts": "widget\n" });
    writeFileSync(join(repo, ".gitignore"), "generated/\n");
    const out = parse(candidates(["--root", repo, "--query", "widget"]));
    const paths = Object.values(out.map).map((m) => m.path);
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(!paths.includes("generated/out.ts"));
    assert.equal(out.coverage.skipped.ignored, 1);
  });
});

describe("sanitize: diff provenance and assignments", () => {
  const sanitize = (repo, input, mode = "auto") => parse(candidates(["--sanitize", "--root", repo, "--mode", mode], { input }));

  it("decodes Git-quoted paths, including octal UTF-8 escapes, before checking provenance", () => {
    const repo = makeRepo({ "a.ts": "x\n" });
    const diff = [
      'diff --git "a/.env" "b/.env"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/.env"',
      "@@ -0,0 +1 @@",
      "+PLAIN_VALUE_WITHOUT_PATTERN=abc",
      'diff --git "a/app/\\303\\244pp/google-services.json" "b/app/\\303\\244pp/google-services.json"',
      '--- "a/app/\\303\\244pp/google-services.json"',
      '+++ "b/app/\\303\\244pp/google-services.json"',
      "@@ -1 +1 @@",
      '+{"project": "unicode-hidden"}',
      'diff --git "a/src/t\\303\\244b.ts" "b/src/t\\303\\244b.ts"',
      '--- "a/src/t\\303\\244b.ts"',
      '+++ "b/src/t\\303\\244b.ts"',
      "@@ -1 +1 @@",
      "+export const ok = 1;",
      "",
    ].join("\n");
    const out = sanitize(repo, diff);
    assert.equal(out.mode, "diff");
    assert.doesNotMatch(out.text, /PLAIN_VALUE_WITHOUT_PATTERN|unicode-hidden/);
    assert.match(out.text, /export const ok = 1/);
    assert.deepEqual(out.omitted.map((o) => [o.path, o.reason]), [
      [".env", "permanent_exclusion"],
      ["app/äpp/google-services.json", "permanent_exclusion"],
    ]);
  });

  it("checks both sides of renames and new files", () => {
    const repo = makeRepo({ ".jev-flow-denylist": "private/\n" });
    const diff = [
      "diff --git a/src/config.ts b/private/config.ts",
      "similarity index 90%",
      "rename from src/config.ts",
      "rename to private/config.ts",
      "@@ -1 +1 @@",
      "+moved private content",
      "diff --git a/notes/.env.local b/notes/.env.local",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes/.env.local",
      "@@ -0,0 +1 @@",
      "+LOCAL=1",
      "",
    ].join("\n");
    const out = sanitize(repo, diff);
    assert.doesNotMatch(out.text, /moved private content|LOCAL=1/);
    assert.deepEqual(out.omitted.map((o) => o.reason), ["denylisted", "permanent_exclusion"]);
  });

  it("drops sections whose provenance cannot be parsed", () => {
    const repo = makeRepo({ "a.ts": "x\n" });
    const diff = ['diff --git "a/broken\\q" "b/broken"', "@@ -1 +1 @@", "+hidden-if-unparsed", ""].join("\n");
    const out = sanitize(repo, diff);
    assert.doesNotMatch(out.text, /hidden-if-unparsed/);
    assert.deepEqual(out.omitted, [{ path: null, reason: "unparseable_provenance" }]);
  });

  it("redacts alphabetic, numeric and short assignment values but keeps code references", () => {
    const repo = makeRepo({ "a.ts": "x\n" });
    const secrets = ["password=huntertwo", "storePassword=123456", "api_key=allalphabeticsecretvalue", "token: x"];
    const out = sanitize(repo, secrets.join("\n"), "text");
    for (const line of secrets) assert.ok(!out.text.includes(line), line);
    assert.equal(out.text.split("\n").filter((l) => l.includes("[REDACTED:credential_assignment]")).length, 4);
    const code = "const token = options.token;\nmax_tokens=1000\nfunction check(password: string) {}\nconst secret = z.string();\n";
    assert.equal(sanitize(repo, code, "text").text, code);
  });
});

describe("jev-candidates: locator ranking rule (F4)", () => {
  /** A file with `n` separate hit windows for "widget parser". */
  const windows = (n) => Array.from({ length: n }, (_, i) => [`export function widgetParser${i}(input) {`, "  return input;", "}", ...Array(70).fill("// filler")].join("\n")).join("\n") + "\n";
  const run = (files, args = []) => parse(candidates(["--root", makeRepo(files), "--query", "widget parser", ...args]));

  it("1 to 3 candidates in one file: plain reads, no Jev payload", () => {
    for (const n of [1, 3]) {
      const out = run({ "src/w.ts": windows(n) });
      assert.equal(out.candidates.length, n);
      assert.deepEqual(out.recommend, { tool: "plain", reason: "few_candidates_one_file", candidates: n });
      assert.equal(out.jev_payload, null);
    }
  });

  it("more than 3 candidates, even from one file: jev_rerank with top_k 5", () => {
    const out = run({ "src/w.ts": windows(4) });
    assert.equal(out.candidates.length, 4);
    assert.equal(out.recommend.tool, "jev_rerank");
    assert.equal(out.recommend.reason, "more_than_3_candidates");
    assert.equal(out.jev_payload.top_k, 5);
    assert.deepEqual(out.jev_payload.candidates, out.candidates, "the payload is the helper's own candidates");
    assert.ok(!JSON.stringify(out.jev_payload).includes("src/w.ts\"") && !("map" in out.jev_payload), "the map stays local");
  });

  it("candidates from two files: jev_rerank; with --single: jev_find", () => {
    const files = { "src/a.ts": windows(1), "src/b.ts": windows(1) };
    const out = run(files);
    assert.deepEqual([out.recommend.tool, out.recommend.reason, out.recommend.files], ["jev_rerank", "candidates_in_several_files", 2]);
    const single = run(files, ["--single"]);
    assert.equal(single.recommend.tool, "jev_find");
    assert.deepEqual(Object.keys(single.jev_payload), ["query", "candidates", "top_k"]);
  });

  it("an exact symbol found as a whole token in exactly one file: plain, to be confirmed by reading, with the threshold rule as fallback", () => {
    const repo = makeRepo({ "src/a.ts": windows(5), "src/b.ts": "export const other = 1;\n" });
    const out = parse(candidates(["--root", repo, "--query", "widgetParser3"]));
    assert.deepEqual(out.recommend, {
      tool: "plain",
      reason: "exact_match_in_one_file",
      path: "src/a.ts",
      confirm_by_reading: true,
      fallback: { tool: "jev_rerank", reason: "more_than_3_candidates", candidates: 5, files: 1 },
    });
    assert.equal(out.jev_payload.top_k, 5, "if reading does not confirm the match, the fallback payload is ready");
    // A verified real match: the only whole-token occurrence of the symbol is its definition.
    const hit = out.candidates.find((c) => out.map[c.id].path === "src/a.ts");
    assert.match(hit.text, /export function widgetParser3\(input\)/);
    const both = makeRepo({ "src/a.ts": windows(1), "src/b.ts": "import { widgetParser0 } from './a';\n" });
    assert.equal(parse(candidates(["--root", both, "--query", "widgetParser0"])).recommend.tool, "jev_rerank", "the symbol is in two files");
  });

  it("a substring is not an exact match: cache vs cacheable/caching in two files keeps the threshold rule (regression)", () => {
    const repo = makeRepo({
      "src/a.ts": "// Cache policy\nexport const cacheable = true;\n",
      "src/b.ts": "// Cache warmup\nexport let caching = false;\n",
    });
    const out = parse(candidates(["--root", repo, "--query", "cache"]));
    assert.equal(out.candidates.length, 2, "both files are lexical candidates for the word cache");
    assert.notEqual(out.recommend.reason, "exact_match_in_one_file", "cacheable contains the substring cache, but is not the identifier cache");
    assert.equal(out.recommend.tool, "jev_rerank");
    assert.equal(out.recommend.reason, "candidates_in_several_files");
    assert.equal(out.jev_payload.top_k, 5);
    const m = exactMatcher("cache");
    assert.deepEqual(["const cacheable = 1", "let caching", "// Cache", "const cache = new Map()", "this.cache.get(k)"].map((l) => m.matchesLine(l)), [false, false, false, true, true]);
  });

  it("when the exact match does not answer the question, the fallback carries the Jev payload", () => {
    const repo = makeRepo({ "src/a.ts": "export const cache = new Map();\n", "src/b.ts": "// Cache warming\nexport function warm() {}\n", "src/c.ts": "// Cache eviction\nexport function evict() {}\n" });
    const out = parse(candidates(["--root", repo, "--query", "cache"]));
    assert.equal(out.recommend.reason, "exact_match_in_one_file", "only a.ts has the case-sensitive whole token cache; the others say Cache");
    assert.equal(out.recommend.confirm_by_reading, true);
    assert.equal(out.recommend.path, "src/a.ts");
    assert.equal(out.recommend.fallback.tool, "jev_rerank");
    assert.deepEqual(Object.keys(out.jev_payload), ["query", "candidates", "top_k"]);
  });

  it("paths match only as a whole path suffix", () => {
    const m = exactMatcher("app/Main.kt");
    assert.equal(m.matchesPath("src/app/Main.kt"), true);
    assert.equal(m.matchesPath("src/myapp/Main.kt"), false);
    assert.equal(m.matchesLine("import app/Main.kt"), false, "a path is not matched inside file contents");
  });

  it("zero candidates and a disabled repo recommend no Jev call and claim nothing", () => {
    const none = run({ "src/a.ts": "export const unrelated = 1;\n" });
    assert.deepEqual(none.recommend, { tool: "none", reason: "no_candidates" });
    const off = parse(candidates(["--root", makeRepo({ ".jev-flow-denylist": "*\n", "a.ts": "widget parser\n" }), "--query", "widget parser"]));
    assert.deepEqual(off.recommend, { tool: "none", reason: "jev_disabled" });
    assert.equal(off.jev_payload, null);
  });

  it("exact tokens are identifiers, qualified names or paths; prose is not", () => {
    for (const q of ["widgetParser", "Foo.bar", "src/app/Main.kt", "a::b"]) assert.equal(exactToken(q), q);
    for (const q of ["where is the parser", "ab", ""]) assert.equal(exactToken(q), null);
    const long = "q".repeat(3000);
    const rec = recommendNext({ disabled: false, query: long, candidates: [1, 2, 3, 4].map((i) => ({ id: `c${i}`, text: "t" })), map: {}, exactFiles: null });
    assert.equal(rec.jev_payload.query.length, 2000, "the query fits jev_rerank's 2,000-character cap");
  });
});

describe("candidates: the helper runs the ranking itself (R3)", () => {
  const readLog = (path) => {
    try {
      return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const many = () => {
    const files = {};
    for (let i = 0; i < 6; i++) files[`src/m${i}.ts`] = `export function parseWidgetFlag${i}(value) {\n  return value.trim();\n}\n`;
    return makeRepo(files);
  };
  const withFake = (mode = "accepted", extra = {}) => {
    const log = join(tempDir("jev-flow-cand-log-"), "calls.jsonl");
    return { log, env: sandboxEnv({ ...fakeJevEnv(mode, { FAKE_MCP_LOG: log }), ...extra }) };
  };

  it("runs jev_rerank with top_k 5 and the payload unchanged, and returns ranked ranges", () => {
    const repo = many();
    const { log, env } = withFake();
    const res = candidates(["--root", repo, "--query", "parse widget flag"], { env });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.recommend.tool, "jev_rerank");
    const calls = readLog(log).filter((r) => r.method === "tools/call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "jev_rerank");
    assert.deepEqual(calls[0].args, out.jev_payload, "sent exactly as returned");
    assert.equal(calls[0].args.top_k, 5);
    assert.equal(out.jev_result.status, "ok");
    assert.equal(out.jev_result.ranked.length, 5);
    for (const r of out.jev_result.ranked) {
      assert.deepEqual([r.path, r.start_line, r.end_line, r.sha256], [out.map[r.id].path, out.map[r.id].start_line, out.map[r.id].end_line, out.map[r.id].sha256]);
      assert.equal(r.text, undefined, "candidate texts are dropped");
    }
  });

  it("runs jev_find for --single; makes no call for plain, exact-match or disabled results", () => {
    const repo = many();
    const a = withFake();
    const single = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag", "--single"], { env: a.env }).stdout);
    assert.equal(single.jev_result.tool, "jev_find");
    assert.equal(single.jev_result.exists_verdict, "present");
    assert.deepEqual(readLog(a.log).filter((r) => r.method === "tools/call").map((r) => r.name), ["jev_find"]);

    const few = makeRepo({ "src/a.ts": "export function widgetParser() {}\n" });
    const b = withFake();
    const plain = JSON.parse(candidates(["--root", few, "--query", "widget parser"], { env: b.env }).stdout);
    assert.equal(plain.recommend.tool, "plain");
    assert.equal(plain.jev_result, undefined);
    assert.deepEqual(readLog(b.log), [], "no server started");
  });

  it("an exact match is read first; --fallback runs the fallback ranking itself", () => {
    const repo = makeRepo({ "src/a.ts": "export const cache = new Map();\n", "src/b.ts": "// Cache warming\nexport function warm() {}\n", "src/c.ts": "// Cache eviction\nexport function evict() {}\n" });
    const { log, env } = withFake();
    const first = JSON.parse(candidates(["--root", repo, "--query", "cache"], { env }).stdout);
    assert.equal(first.recommend.reason, "exact_match_in_one_file");
    assert.equal(first.jev_result, undefined);
    assert.deepEqual(readLog(log), []);
    const second = JSON.parse(candidates(["--root", repo, "--query", "cache", "--fallback"], { env }).stdout);
    assert.equal(second.jev_result.tool, first.recommend.fallback.tool);
    assert.equal(second.jev_result.status, "ok");
  });

  it("reports unavailability instead of inventing a ranking: no credentials, --no-jev, invalid twice", () => {
    const repo = many();
    const none = withFake("accepted", { OPENROUTER_API_KEY: "" });
    const out1 = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag"], { env: none.env }).stdout);
    assert.equal(out1.jev_result.status, "unavailable");
    assert.deepEqual(readLog(none.log), [], "nothing spawned without credentials");
    assert.ok(out1.jev_payload, "the payload stays for the locator's own tool");

    const skip = withFake();
    const out2 = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag", "--no-jev"], { env: skip.env }).stdout);
    assert.equal(out2.jev_result.status, "skipped");
    assert.deepEqual(readLog(skip.log), []);

    const bad = withFake("invalid");
    const out3 = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag"], { env: bad.env }).stdout);
    assert.equal(out3.jev_result.status, "unavailable");
    assert.equal(readLog(bad.log).filter((r) => r.method === "tools/call").length, 2, "one retry");

    // An unusable ranking (ids not among the candidates) is retried once in the same loop.
    const state = () => join(tempDir("jev-flow-state-"), "s.json");
    const first = withFake("accepted", { FAKE_MCP_MALFORMED: "first", FAKE_MCP_STATE: state() });
    const out4 = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag"], { env: first.env }).stdout);
    assert.deepEqual([out4.jev_result.status, out4.jev_result.calls], ["ok", 2]);
    assert.equal(readLog(first.log).filter((r) => r.method === "tools/call").length, 2);
    const always = withFake("accepted", { FAKE_MCP_MALFORMED: "always", FAKE_MCP_STATE: state() });
    const out5 = JSON.parse(candidates(["--root", repo, "--query", "parse widget flag"], { env: always.env }).stdout);
    assert.deepEqual([out5.jev_result.status, out5.jev_result.calls], ["unavailable", 2]);
    assert.equal(readLog(always.log).filter((r) => r.method === "tools/call").length, 2);
  });

  it("maps results through the local map and rejects malformed ones", () => {
    const map = { c0: { path: "a.ts", start_line: 1, end_line: 9, sha256: "s" } };
    assert.deepEqual(mapJevResult("jev_rerank", { tool: "jev_rerank", ranked: [{ rank: 1, id: "c0", relevance: 0.9 }, { rank: 2, id: "zz", relevance: 0.1 }] }, map).ranked, [{ rank: 1, id: "c0", relevance: 0.9, path: "a.ts", start_line: 1, end_line: 9, sha256: "s" }]);
    assert.equal(mapJevResult("jev_rerank", { tool: "jev_rerank", ranked: null, status: "invalid_response" }, map).status, "invalid_response");
    assert.equal(mapJevResult("jev_rerank", { tool: "jev_find", top: [] }, map).status, "invalid_response");
    assert.equal(dueJevCall({ recommend: { tool: "plain", reason: "few_candidates_one_file" }, jev_payload: null }), null);
  });
});

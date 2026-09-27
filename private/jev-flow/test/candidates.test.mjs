import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { candidates, git, makeRepo, sandboxEnv, tempDir, writeFiles } from "./helpers.mjs";

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

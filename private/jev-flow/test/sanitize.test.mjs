import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDenylist } from "../paths.mjs";
import { isSuspiciousLine, sanitizeDiff, sanitizeText } from "../sanitize.mjs";

// Built from parts so no scanner reads these as real credentials.
const BLOB = "Zq8vN3xLm2Pw9Rt4Kd7Yh1Bc6Fs5Jg0Q";
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY12"].join("/");

describe("isSuspiciousLine and file paths", () => {
  it("does not treat a path with digits next to a credential-like word as a secret", () => {
    for (const line of [
      "$ node /Users/me/Dev/jev-mcp-rel0138/private/jev-flow/test/check.mjs hello 3",
      "$ node /Users/me/Dev/jev-mcp-rel0138/private/jev-flow/test/check.mjs hello 3 --stderr to-stderr",
      "at load (/home/ci/work/app2/src/auth/session-store/index.js:12:3)",
      "src/app2/auth/LoginActivity/handler: compiled",
      "diff --git a/app/src/main/java/com/example2/auth/LoginActivity.kt b/app/src/main/java/com/example2/auth/LoginActivity.kt",
      "/private/var/folders/hj/token-cache/T/AndroidStudioProjects/App2/build",
    ]) assert.equal(isSuspiciousLine(line), false, line);
  });

  it("keeps the diff header and the check command line when the repo path has digits", () => {
    const header = "diff --git a/app2/src/auth/LoginActivity.kt b/app2/src/auth/LoginActivity.kt";
    const diff = [header, "--- a/app2/src/auth/LoginActivity.kt", "+++ b/app2/src/auth/LoginActivity.kt", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const out = sanitizeDiff(diff, parseDenylist(""));
    assert.equal(out.omitted_lines, 0);
    assert.ok(out.text.includes(header));
    const cmd = sanitizeText("[cmd-1] $ node /Users/me/Dev/jev-mcp-rel0138/private/jev-flow/test/check.mjs hello 3\nexit: 3\n");
    assert.equal(cmd.omitted_lines, 0);
  });

  it("still flags a long mixed token next to a credential-like word", () => {
    assert.equal(isSuspiciousLine(`auth secret blob: ${BLOB}`), true);
    assert.equal(isSuspiciousLine(`token ${BLOB}`), true);
  });

  it("still flags a base64 secret that happens to contain slashes", () => {
    assert.equal(isSuspiciousLine(`aws secret ${AWS_SECRET}`), true);
    assert.equal(isSuspiciousLine(`secret=${AWS_SECRET}`), true);
  });

  it("still flags a long secret used as a path segment", () => {
    assert.equal(isSuspiciousLine(`/home/me/secret/${BLOB}`), true);
    assert.equal(isSuspiciousLine(`/home/me/secret/${BLOB.toLowerCase()}9`), true);
    assert.equal(isSuspiciousLine(`GET /v1/keys/${BLOB}/rotate`), true);
  });

  it("replaces only the suspicious line of a log, not the path lines around it", () => {
    const log = ["$ node /Users/me/Dev/jev-mcp-rel0138/private/jev-flow/test/check.mjs 3", `auth secret blob: ${BLOB}`, "exit: 3"].join("\n");
    const out = sanitizeText(log);
    assert.equal(out.omitted_lines, 1);
    assert.deepEqual(out.text.split("\n").map((l) => l === "[OMITTED:suspicious_content]"), [false, true, false]);
  });
});

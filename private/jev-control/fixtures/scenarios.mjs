// Development scenarios S1-S4 (R01-R09). Each is a tiny disposable Node repository
// with alternatives that are plausible and a known-correct outcome by construction.
import { evalIn, gitClean } from "./lib.mjs";

export const S1 = {
  id: "s1-bug-several-files",
  title: "Off-by-one page count with several plausible modules",
  kind: "dev",
  expects: "edit",
  prompt: "Reports show one extra, empty page whenever the number of items is an exact multiple of the page size (10 items with page size 5 prints \"Page 1 of 3\"). Fix it, keep the public API unchanged and make `node --test` pass.",
  files: {
    "package.json": '{"name":"fixture-s1","type":"module","private":true}\n',
    "src/pagination.mjs": "// Page arithmetic shared by the CLI and the report.\nexport function pageCount(items, pageSize) {\n  if (items <= 0) return 0;\n  return Math.floor(items / pageSize) + 1;\n}\n\nexport function pageOffset(page, pageSize) {\n  return (page - 1) * pageSize;\n}\n",
    "src/report.mjs": "import { pageCount } from \"./pagination.mjs\";\n\nexport function pageLabel(items, pageSize, page) {\n  return `Page ${page} of ${pageCount(items, pageSize)}`;\n}\n",
    "src/cli.mjs": "import { pageLabel } from \"./report.mjs\";\n\nexport function summary(items, pageSize) {\n  return [1, 2, 3].map((p) => pageLabel(items, pageSize, p)).slice(0, 1).join(\"\\n\");\n}\n",
    "src/utils/math.mjs": "export const ceilDiv = (a, b) => Math.ceil(a / b);\nexport const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));\n",
    "test/pagination.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { pageCount } from \"../src/pagination.mjs\";\n\ntest(\"exact multiples\", () => {\n  assert.equal(pageCount(10, 5), 2);\n});\n\ntest(\"remainders and empties\", () => {\n  assert.equal(pageCount(11, 5), 3);\n  assert.equal(pageCount(1, 5), 1);\n  assert.equal(pageCount(0, 5), 0);\n});\n",
  },
  solution: { "src/pagination.mjs": "// Page arithmetic shared by the CLI and the report.\nexport function pageCount(items, pageSize) {\n  if (items <= 0) return 0;\n  return Math.ceil(items / pageSize);\n}\n\nexport function pageOffset(page, pageSize) {\n  return (page - 1) * pageSize;\n}\n" },
  oracle(dir) {
    const r = evalIn(dir, 'import { pageCount, pageOffset } from "./src/pagination.mjs"; import { pageLabel } from "./src/report.mjs"; console.log(JSON.stringify({ a: pageCount(10, 5), b: pageCount(11, 5), c: pageCount(1, 5), d: pageCount(0, 5), e: pageOffset(2, 5), f: pageLabel(10, 5, 1), g: typeof pageLabel }));');
    const pass = !r.error && r.a === 2 && r.b === 3 && r.c === 1 && r.d === 0 && r.e === 5 && r.f === "Page 1 of 2" && r.g === "function";
    return { pass, detail: r.error ?? JSON.stringify(r) };
  },
};

export const S2 = {
  id: "s2-ordered-tasks",
  title: "Four tasks with one dependency (schema first, then its consumers)",
  kind: "dev",
  expects: "edit",
  prompt: "Do these four things: (a) add a changelog line `- users now expose displayName` to CHANGELOG.md; (b) update src/greeting.mjs to use the new field; (c) update test/greeting.test.mjs to the new field; (d) rename the `fullname` field of createUser in src/user.mjs to `displayName`. Choose the order yourself, finish all four and make `node --test` pass.",
  files: {
    "package.json": '{"name":"fixture-s2","type":"module","private":true}\n',
    "CHANGELOG.md": "# Changelog\n\n- initial release\n",
    "src/user.mjs": "export function createUser(first, last) {\n  return { id: `${first}.${last}`.toLowerCase(), fullname: `${first} ${last}` };\n}\n",
    "src/greeting.mjs": "export function greeting(user) {\n  return `Hello, ${user.fullname}!`;\n}\n",
    "test/greeting.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { greeting } from \"../src/greeting.mjs\";\nimport { createUser } from \"../src/user.mjs\";\n\ntest(\"greets by full name\", () => {\n  assert.equal(greeting(createUser(\"Ada\", \"Lovelace\")), \"Hello, Ada Lovelace!\");\n});\n",
  },
  solution: {
    "CHANGELOG.md": "# Changelog\n\n- initial release\n- users now expose displayName\n",
    "src/user.mjs": "export function createUser(first, last) {\n  return { id: `${first}.${last}`.toLowerCase(), displayName: `${first} ${last}` };\n}\n",
    "src/greeting.mjs": "export function greeting(user) {\n  return `Hello, ${user.displayName}!`;\n}\n",
    "test/greeting.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { greeting } from \"../src/greeting.mjs\";\nimport { createUser } from \"../src/user.mjs\";\n\ntest(\"greets by displayName\", () => {\n  const user = createUser(\"Ada\", \"Lovelace\");\n  assert.equal(user.displayName, \"Ada Lovelace\");\n  assert.equal(greeting(user), \"Hello, Ada Lovelace!\");\n});\n",
  },
  oracle(dir) {
    const r = evalIn(dir, 'import { readFileSync } from "node:fs"; import { createUser } from "./src/user.mjs"; import { greeting } from "./src/greeting.mjs"; const u = createUser("Ada","Lovelace"); console.log(JSON.stringify({ dn: u.displayName, fn: "fullname" in u, g: greeting(u), log: readFileSync("CHANGELOG.md","utf8").includes("- users now expose displayName"), test: readFileSync("test/greeting.test.mjs","utf8").includes("displayName") }));');
    const pass = !r.error && r.dn === "Ada Lovelace" && r.fn === false && r.g === "Hello, Ada Lovelace!" && r.log === true && r.test === true;
    return { pass, detail: r.error ?? JSON.stringify(r) };
  },
};

export const S3 = {
  id: "s3-ambiguous-search",
  title: "Which of several backoff definitions governs failed uploads",
  kind: "dev",
  expects: "answer",
  answer: { path: "src/upload/retry.mjs", lines: [6, 9] },
  prompt: "Where is the delay between retries of a FAILED UPLOAD computed? Answer with the file path and the line range of the function. Do not change any file.",
  files: {
    "package.json": '{"name":"fixture-s3","type":"module","private":true}\n',
    "src/net/backoff.mjs": "// Delay for polling the status endpoint, not for uploads.\nexport function pollBackoffMs(attempt) {\n  return Math.min(30_000, 500 * 2 ** attempt);\n}\n",
    "src/jobs/schedule.mjs": "// Delay before the nightly job is retried by the scheduler.\nexport function jobRetryDelay(attempt) {\n  return 60_000 * (attempt + 1);\n}\n",
    "src/upload/retry.mjs": "// Retry policy of the uploader.\nconst BASE_MS = 250;\nconst MAX_MS = 8_000;\n\n// Delay in ms before the next attempt of a failed upload.\nexport function uploadRetryDelay(attempt) {\n  const exp = BASE_MS * 2 ** attempt;\n  return Math.min(MAX_MS, exp);\n}\n",
    "src/upload/uploader.mjs": "import { uploadRetryDelay } from \"./retry.mjs\";\n\nexport async function upload(send, payload, attempts = 4) {\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await send(payload);\n    } catch (error) {\n      if (i === attempts - 1) throw error;\n      await new Promise((r) => setTimeout(r, uploadRetryDelay(i)));\n    }\n  }\n}\n",
  },
  solution: {},
  oracle(dir, { finalMessage = "" } = {}) {
    const mentionsPath = finalMessage.includes("src/upload/retry.mjs");
    const wrongPath = /src\/(net\/backoff|jobs\/schedule)\.mjs/.test(finalMessage) && !mentionsPath;
    const ranges = [...finalMessage.matchAll(/(\d+)\s*[-–]\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const overlaps = ranges.some(([a, b]) => a <= 9 && b >= 6);
    return { pass: mentionsPath && !wrongPath && overlaps && gitClean(dir), detail: JSON.stringify({ mentionsPath, wrongPath, overlaps, clean: gitClean(dir) }) };
  },
};

export const S4 = {
  id: "s4-missing-requirement",
  title: "The request omits a choice that only the user can make",
  kind: "dev",
  expects: "incomplete",
  prompt: "Add a `--format` option to the report command in src/cli.mjs so reports can be exported. I did not say which output formats are wanted or which one is the default; do what is right.",
  files: {
    "package.json": '{"name":"fixture-s4","type":"module","private":true}\n',
    "src/cli.mjs": "import { render } from \"./report.mjs\";\n\nexport function main(argv, rows) {\n  const mode = argv.includes(\"--summary\") ? \"summary\" : \"full\";\n  return render(rows, mode);\n}\n",
    "src/report.mjs": "export function render(rows, mode) {\n  if (mode === \"summary\") return `${rows.length} rows`;\n  return rows.map((r) => `${r.name}: ${r.total}`).join(\"\\n\");\n}\n",
    "README.md": "# Reports\n\nThe report command prints plain text. Exports for finance (CSV) and for the dashboard (JSON) are both planned; nothing is decided.\n",
  },
  solution: {},
  oracle(dir, { finalMessage = "" } = {}) {
    const incomplete = /^Incomplete:/.test(String(finalMessage).trim().split("\n").pop().trim()) || /^Incomplete:/.test(String(finalMessage).trim());
    return { pass: incomplete && gitClean(dir), detail: JSON.stringify({ incomplete, clean: gitClean(dir) }) };
  },
};

export const DEV_SCENARIOS = [S1, S2, S3, S4];

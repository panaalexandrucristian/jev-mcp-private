// SEALED final scenarios F1-F2 (R10). They are written before the campaign, their
// hashes are committed in sealed.json, and nothing here is run in a live session,
// read to adjust the control, or tuned against results before R10. After R10 no
// adjustment is made. Custody is described in CUSTODY.md.
import { evalIn, gitClean } from "./lib.mjs";

export const F1 = {
  id: "f1-ambiguous-ttl",
  title: "Which TTL governs the session cache",
  kind: "final",
  expects: "answer",
  answer: { path: "src/session/ttl.mjs", lines: [5, 8] },
  prompt: "Where is the expiry time of a cached USER SESSION computed? Answer with the file path and the line range of the function. Do not change any file.",
  files: {
    "package.json": '{"name":"fixture-f1","type":"module","private":true}\n',
    "src/http/cache.mjs": "// TTL of cached HTTP responses (static assets).\nexport function responseTtlSeconds(kind) {\n  return kind === \"asset\" ? 86_400 : 60;\n}\n",
    "src/token/ttl.mjs": "// Lifetime of API tokens.\nexport function tokenTtlSeconds(scope) {\n  return scope === \"admin\" ? 900 : 3_600;\n}\n",
    "src/session/ttl.mjs": "// Session cache policy.\nconst IDLE = 1_800;\n\n// Expiry (epoch seconds) of a cached user session.\nexport function sessionExpiry(lastSeen) {\n  return lastSeen + IDLE;\n}\n",
    "src/session/store.mjs": "import { sessionExpiry } from \"./ttl.mjs\";\n\nexport const store = new Map();\nexport function touch(id, now) {\n  store.set(id, sessionExpiry(now));\n}\n",
  },
  solution: {},
  oracle(dir, { finalMessage = "" } = {}) {
    const mentionsPath = finalMessage.includes("src/session/ttl.mjs");
    const wrongPath = /src\/(http\/cache|token\/ttl)\.mjs/.test(finalMessage) && !mentionsPath;
    const ranges = [...finalMessage.matchAll(/(\d+)\s*[-–]\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const overlaps = ranges.some(([a, b]) => a <= 8 && b >= 5);
    return { pass: mentionsPath && !wrongPath && overlaps && gitClean(dir), detail: JSON.stringify({ mentionsPath, wrongPath, overlaps, clean: gitClean(dir) }) };
  },
};

export const F2 = {
  id: "f2-inclusive-range",
  title: "Inclusive range length with several plausible modules",
  kind: "final",
  expects: "edit",
  prompt: "`rangeLength(1, 5)` returns 4 but the range 1..5 contains 5 numbers, and the schedule summary is off by one for the same reason. Fix it, keep the public API unchanged and make `node --test` pass.",
  files: {
    "package.json": '{"name":"fixture-f2","type":"module","private":true}\n',
    "src/range.mjs": "export function rangeLength(start, end) {\n  return end - start;\n}\n\nexport function inRange(value, start, end) {\n  return value >= start && value <= end;\n}\n",
    "src/schedule.mjs": "import { rangeLength } from \"./range.mjs\";\n\nexport function slots(startHour, endHour) {\n  return rangeLength(startHour, endHour);\n}\n",
    "src/format.mjs": "export const plural = (n, word) => `${n} ${word}${n === 1 ? \"\" : \"s\"}`;\n",
    "test/range.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { rangeLength } from \"../src/range.mjs\";\n\ntest(\"inclusive length\", () => {\n  assert.equal(rangeLength(1, 5), 5);\n  assert.equal(rangeLength(3, 3), 1);\n});\n",
  },
  solution: { "src/range.mjs": "export function rangeLength(start, end) {\n  return end - start + 1;\n}\n\nexport function inRange(value, start, end) {\n  return value >= start && value <= end;\n}\n" },
  oracle(dir) {
    const r = evalIn(dir, 'import { rangeLength, inRange } from "./src/range.mjs"; import { slots } from "./src/schedule.mjs"; console.log(JSON.stringify({ a: rangeLength(1, 5), b: rangeLength(3, 3), c: slots(9, 17), d: inRange(5, 1, 5) }));');
    const pass = !r.error && r.a === 5 && r.b === 1 && r.c === 9 && r.d === true;
    return { pass, detail: r.error ?? JSON.stringify(r) };
  },
};

export const FINAL_SCENARIOS = [F1, F2];

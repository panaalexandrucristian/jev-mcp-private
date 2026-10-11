#!/usr/bin/env node
// Round 4, C12: does the instruction "independent calls in the same turn; write and run a script in one call" cut the model calls? 3 pairs, Sonnet, confined. Task and arms: eval/c12-task.md.
//   SMOKE=1: one Haiku session on arm B (harness check only, not a measurement).
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDir, runSession } from "../lib/confined.mjs";
import { save } from "../lib/results.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "/Users/apana/Dev/council-runs/2026-10-11/class-graph-find-def-stages/ledger.json";
const SMOKE = !!process.env.SMOKE;
const MODEL = SMOKE ? "haiku" : (process.env.MODEL ?? "sonnet");
const CAP = Number(process.env.CAP_USD ?? (SMOKE ? 0.05 : 0.15));
const ARMS = SMOKE ? ["B"] : ["A", "B", "A", "B", "A", "B"];
const task = readFileSync(join(ROOT, "eval", "c12-task.md"), "utf8");
const block = (heading) => { const m = new RegExp(`## ${heading}[^\\n]*\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``).exec(task); if (!m) throw new Error(`no block ${heading}`); return m[1]; };
const PROMPT_A = block("Arm A prompt"), EXTRA_B = block("Arm B extra");

function copyProject(dest) {
  const r = spawnSync("rsync", ["-a", "--exclude", "eval/results", "--exclude", "eval/results-r2", "--exclude", "node_modules", "--exclude", ".git", `${ROOT}/`, `${dest}/`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr}`);
}
/** Expected answers, computed from the copy. */
function expected(project) {
  const sh = (cmd) => spawnSync("sh", ["-c", cmd], { cwd: project, encoding: "utf8" }).stdout.trim();
  return { lines: Number(sh("wc -l < ui-digest.mjs")), shrink: sh("grep -n 'function shrink' img-shrink.mjs | head -1").split(":")[0], exit: "3", mjs: Number(sh("find . -name '*.mjs' | wc -l")) };
}
function judge(answer, exp) {
  const line = (n) => answer.split("\n").find((l) => new RegExp(`^\\s*(\\*\\*)?${n}[.)]`).test(l)) ?? "";
  return { q1: new RegExp(`\\b${exp.lines}\\b`).test(line(1)), q2: /img-shrink\.mjs/.test(line(2)) && new RegExp(`\\b${exp.shrink}\\b`).test(line(2)), q3: /\b3\b/.test(line(3)), q4: new RegExp(`\\b${exp.mjs}\\b`).test(line(4)) };
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
if (ledger.spent + ARMS.length * CAP > ledger.ceiling) { console.error("ledger ceiling would be exceeded"); process.exit(3); }
mkdirSync(join(ROOT, "eval", "results-r2", "raw"), { recursive: true });
const records = [];
for (const [i, arm] of ARMS.entries()) {
  const dir = makeDir("c12");
  const project = join(dir, "project"); mkdirSync(project); copyProject(project);
  const exp = expected(project);
  const prompt = arm === "B" ? `${PROMPT_A}\n\n${EXTRA_B}` : PROMPT_A;
  const r = await runSession({ dir, prompt, model: MODEL, cap: CAP, tools: "Bash,Read,Grep,Glob", allowedTools: ["Bash", `Read(/${dir}/**)`, `Grep(/${dir}/**)`, `Glob(/${dir}/**)`], rawFile: join(ROOT, "eval", "results-r2", "raw", `c12-${SMOKE ? "smoke" : `${arm}${Math.floor(i / 2) + 1}`}.jsonl`) });
  const j = judge(r.answer, exp);
  const rec = { arm, n: Math.floor(i / 2) + 1, ...r, expected: exp, judged: j, allRight: Object.values(j).every(Boolean) };
  records.push(rec);
  ledger.spent = Math.round((ledger.spent + (r.cost ?? CAP)) * 1e6) / 1e6; ledger.sessions.push({ label: "ctx4-c12", tag: `${arm}${rec.n}`, cost: r.cost ?? CAP });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`${arm}${rec.n} ${r.subtype} modelCalls=${r.modelCalls} toolCalls=${r.toolCalls} maxInOneTurn=${r.maxToolsInOneTurn} tools=[${[...new Set(r.tools)]}] right=${rec.allRight} ${JSON.stringify(j)} denials=${r.denials} toolErrors=${r.toolErrors} cost=${r.cost}\n   expected ${JSON.stringify(exp)}\n   answer: ${r.answer.replace(/\s+/g, " ").slice(0, 300)}`);
  if (SMOKE) console.log(JSON.stringify({ bash: r.bashCommands }, null, 1));
  rmSync(dir, { recursive: true, force: true });
}
if (!SMOKE) {
  const pairs = [1, 2, 3].map((n) => { const a = records.find((r) => r.arm === "A" && r.n === n), b = records.find((r) => r.arm === "B" && r.n === n); return { n, aCalls: a.modelCalls, bCalls: b.modelCalls, saved: a.modelCalls - b.modelCalls, bothRight: a.allRight && b.allRight }; });
  const meetsGate = pairs.filter((p) => p.saved >= 2 && p.bothRight).length;
  const meanA = records.filter((r) => r.arm === "A").reduce((s, r) => s + r.modelCalls, 0) / 3;
  const gate = { pairs, pairsWithAtLeast2FewerCallsAndSameRightAnswer: `${meetsGate} of 3 (gate >= 2)`, meanModelCallsA: meanA, floorNote: meanA <= 3 ? "arm A averages 3 calls or fewer: no room to save 2 calls" : "room exists" };
  save("C12", { note: `${MODEL}, confined, 3 pairs, ledger ${ledger.spent} of ${ledger.ceiling}`, records, gate });
  console.log(JSON.stringify(gate, null, 1));
}
console.log(`ledger: spent ${ledger.spent} of ${ledger.ceiling}`);

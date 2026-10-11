#!/usr/bin/env node
// Round 4, C11: would the model USE ui-step? Six confined Sonnet sessions (3 pairs, interleaved A1 B1 A2 B2 A3 B3) on the stand-in device (recorded screens, no real device).
//   arm A: the existing note (skills/android-cli/references/interact.md, whole file); arm B: the same note plus ONE line naming ui-step.
//   SMOKE=1: one Haiku session with a trivial command check (harness check only, not a measurement).
// Rules: EVAL-RULES-4.md (addendum). Task: go to the myDG Wallet tab and say which reward card is complete. Right answer: "Spend $30, Earn $5".
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASH_ALLOW, makeDir, runSession } from "../lib/confined.mjs";
import { save } from "../lib/results.mjs";
import { makeStandIn } from "./stand-in/make-stand-in.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ASSETS = process.env.EMU_ASSETS ?? "/private/tmp/claude-501/-Users-apana-Dev-jev-mcp/33d1616c-4c12-4439-927c-8368bbf1212c/scratchpad/emu";
const NOTE = readFileSync("/Users/apana/.claude/skills/android-cli/references/interact.md", "utf8");
const LEDGER = "/Users/apana/Dev/council-runs/2026-10-11/class-graph-find-def-stages/ledger.json";
const SMOKE = !!process.env.SMOKE;
const MODEL = SMOKE ? "haiku" : (process.env.MODEL ?? "sonnet");
const CAP = Number(process.env.CAP_USD ?? (SMOKE ? 0.05 : 0.15));
const ARMS = SMOKE ? ["B"] : ["A", "B", "A", "B", "A", "B"];
const RIGHT = /Spend \$30,? Earn \$5/i;

const ruleLine = (tools) => `Navigation shortcut: run \`node ${tools}/ui-step.mjs --tap "<label>" [--region top|bottom]\` (or \`--back\`, \`--swipe\`, or no action to read the current screen). It taps, waits until the screen stops changing and prints a one-line-per-element digest of the new screen; add \`--shot <file>.jpg\` to also get a 540 px screenshot to Read.`;
function promptFor(arm, tools) {
  if (SMOKE) return `Run these two commands and report their first line each: \`android layout --flat | head -c 150\` and \`node ${tools}/ui-step.mjs\`. Then answer DONE.`;
  return `You control an Android device from the shell with the commands in the note below. The device is connected and the app is open on its home screen.\n\nNOTE\n${NOTE}${arm === "B" ? `\n${ruleLine(tools)}\n` : ""}\nTASK: Go to the myDG Wallet tab and tell me which reward card is shown as complete (earned). Answer in one line with the card's title. Do not tap anything that changes the account (Activate, Add, Clip, Redeem, Send, Verify, Edit, Save, Checkout).`;
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
if (ledger.spent + ARMS.length * CAP > ledger.ceiling) { console.error("ledger ceiling would be exceeded"); process.exit(3); }
mkdirSync(join(ROOT, "eval", "results-r2", "raw"), { recursive: true });
const records = [];
for (const [i, arm] of ARMS.entries()) {
  const dir = makeDir("c11");
  const stand = makeStandIn(ASSETS, dir);
  const tools = join(dir, "tools"); mkdirSync(tools);
  for (const f of ["ui-step.mjs", "ui-digest.mjs", "img-shrink.mjs"]) copyFileSync(join(ROOT, f), join(tools, f));
  const allowed = [...BASH_ALLOW, `Read(/${dir}/**)`];
  const r = await runSession({ dir, prompt: promptFor(arm, tools), model: MODEL, cap: CAP, tools: "Bash,Read", allowedTools: allowed, extraPath: stand.bin, rawFile: join(ROOT, "eval", "results-r2", "raw", `c11-${SMOKE ? "smoke" : `${arm}${Math.floor(i / 2) + 1}`}.jsonl`) });
  const shim = existsSync(stand.log) ? readFileSync(stand.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const finalScreen = existsSync(stand.state) ? JSON.parse(readFileSync(stand.state, "utf8")).screen : "home";
  const rec = {
    arm, n: Math.floor(i / 2) + 1, ...r, usedUiStep: r.bashCommands.some((c) => /ui-step/.test(c)), uiStepCommands: r.bashCommands.filter((c) => /ui-step/.test(c)).length,
    directLayoutCalls: r.bashCommands.filter((c) => /android\s+layout/.test(c)).length, shimLayoutReads: shim.filter((l) => l.call === "android layout").length, shimTaps: shim.filter((l) => l.call === "adb tap").length, shimNoops: shim.filter((l) => l.noop).length,
    screenshotsRead: r.reads.filter((p) => /\.(png|jpg)$/.test(p)).length, finalScreen, answerRight: RIGHT.test(r.answer),
  };
  records.push(rec);
  ledger.spent = Math.round((ledger.spent + (r.cost ?? CAP)) * 1e6) / 1e6; ledger.sessions.push({ label: "ctx4-c11", tag: `${arm}${rec.n}`, cost: r.cost ?? CAP });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`${arm}${rec.n} ${r.subtype} modelCalls=${r.modelCalls} tools=${r.toolCalls} uiStep=${rec.usedUiStep}(${rec.uiStepCommands}) layoutDirect=${rec.directLayoutCalls} shots=${rec.screenshotsRead} screen=${finalScreen} right=${rec.answerRight} denials=${r.denials} toolErrors=${r.toolErrors} cost=${r.cost}\n   answer: ${r.answer.replace(/\s+/g, " ").slice(0, 160)}`);
  if (SMOKE) console.log(JSON.stringify({ bash: r.bashCommands, answer: r.answer }, null, 1));
  rmSync(dir, { recursive: true, force: true });
}
if (!SMOKE) {
  const by = (arm) => records.filter((r) => r.arm === arm);
  const sum = (arm, key) => by(arm).reduce((s, r) => s + (r[key] ?? 0), 0);
  const gate = { armBUsesUiStepIn: `${by("B").filter((r) => r.usedUiStep).length} of 3 (gate >= 2)`, armAUsesUiStepIn: `${by("A").filter((r) => r.usedUiStep).length} of 3 (gate <= 1, trivial: arm A is not told about ui-step)`, armBAnswersRight: `${by("B").filter((r) => r.answerRight).length} of 3`, armAAnswersRight: `${by("A").filter((r) => r.answerRight).length} of 3` };
  save("C11", { note: `${MODEL}, confined, stand-in device, ledger ${ledger.spent} of ${ledger.ceiling}`, records, gate, totals: { A: { modelCalls: sum("A", "modelCalls"), toolCalls: sum("A", "toolCalls"), cost: sum("A", "cost") }, B: { modelCalls: sum("B", "modelCalls"), toolCalls: sum("B", "toolCalls"), cost: sum("B", "cost") } } });
  console.log(JSON.stringify(gate, null, 1));
}
console.log(`ledger: spent ${ledger.spent} of ${ledger.ceiling}`);

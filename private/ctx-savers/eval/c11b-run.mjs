#!/usr/bin/env node
// Round 4, C11b: the INSTALLED note (open default, ~ path) with a 4-step task. Six confined Sonnet sessions (A1 B1 A2 B2 A3 B3) on the stand-in device.
//   arm B: ~/.claude/skills/android-cli/references/interact.md exactly as installed; arm A: the same file without the line that names ui-step.
//   SMOKE=1: one Haiku session that runs the installed ui-step through the sandbox (harness check only, not a measurement).
// Rules: EVAL-RULES-4.md (addendum C11b).
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASH_ALLOW, makeDir, runSession } from "../lib/confined.mjs";
import { save } from "../lib/results.mjs";
import { makeStandIn } from "./stand-in/make-stand-in.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ASSETS = process.env.EMU_ASSETS ?? "/private/tmp/claude-501/-Users-apana-Dev-jev-mcp/33d1616c-4c12-4439-927c-8368bbf1212c/scratchpad/emu";
const SCRIPTS = join(homedir(), ".claude/skills/android-cli/scripts");
const NOTE_B = readFileSync(join(homedir(), ".claude/skills/android-cli/references/interact.md"), "utf8");
const NOTE_A = NOTE_B.split("\n").filter((l) => !/ui-step/.test(l)).join("\n");
if (/ui-step/.test(NOTE_A) || !/ui-step/.test(NOTE_B) || NOTE_B.split("\n").filter((l) => /ui-step/.test(l)).length !== 1) { console.error("the installed note does not have exactly one ui-step line"); process.exit(3); }
const LEDGER = "/Users/apana/Dev/council-runs/2026-10-11/class-graph-find-def-stages/ledger.json";
const SMOKE = !!process.env.SMOKE;
const MODEL = SMOKE ? "haiku" : (process.env.MODEL ?? "sonnet");
const CAP = Number(process.env.CAP_USD ?? (SMOKE ? 0.05 : 0.15));
const ARMS = SMOKE ? ["B"] : ["A", "B", "A", "B", "A", "B"];
const CHECKS = [/\b4\b/, /4\.27/, /0\.00|0 items/i, /Spend \$30,? Earn \$5/i];

const TASK = `TASK (read-only; do not tap anything that changes the account: Activate, Add, Clip, Redeem, Send, Verify, Edit, Save, Checkout):\n1. Open the Deals tab, then its Rewards sub-tab: what number is in brackets after "Available Rewards"?\n2. Open the List tab: what is the estimated total?\n3. Open the Cart tab: what is the total shown?\n4. Open the myDG Wallet tab: what is the title of the reward card shown as complete?\nAnswer in exactly four lines, "1. ..." to "4. ...".`;
const promptFor = (arm) => SMOKE
  ? `Run \`node ~/.claude/skills/android-cli/scripts/ui-step.mjs\` and report its first output line, then answer DONE.`
  : `You control an Android device from the shell with the commands in the note below. The device is connected and the app is open on its home screen.\n\nNOTE\n${arm === "B" ? NOTE_B : NOTE_A}\n${TASK}`;
function score(answer) {
  const lines = answer.split("\n"); const items = [1, 2, 3, 4].map((n) => lines.find((l) => new RegExp(`^\\s*${n}[.)]`).test(l)) ?? "");
  return items.map((t, i) => CHECKS[i].test(t));
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
if (ledger.spent + ARMS.length * CAP > ledger.ceiling) { console.error("ledger ceiling would be exceeded"); process.exit(3); }
mkdirSync(join(ROOT, "eval", "results-r2", "raw"), { recursive: true });
const records = [];
for (const [i, arm] of ARMS.entries()) {
  const dir = makeDir("c11b");
  const stand = makeStandIn(ASSETS, dir);
  const raw = join(ROOT, "eval", "results-r2", "raw", `c11b-${SMOKE ? "smoke" : `${arm}${Math.floor(i / 2) + 1}`}.jsonl`);
  const r = await runSession({ dir, prompt: promptFor(arm), model: MODEL, cap: CAP, tools: "Bash,Read", allowedTools: [...BASH_ALLOW, `Read(/${dir}/**)`], extraPath: stand.bin, extraRead: [SCRIPTS], rawFile: raw });
  const shim = existsSync(stand.log) ? readFileSync(stand.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const finalScreen = existsSync(stand.state) ? JSON.parse(readFileSync(stand.state, "utf8")).screen : "home";
  const rawText = existsSync(raw) ? readFileSync(raw, "utf8") : "";
  const refusals = (rawText.match(/ui-step: STOP/g) ?? []).length;
  const right = score(r.answer);
  const rec = {
    arm, n: Math.floor(i / 2) + 1, ...r, usedUiStep: r.bashCommands.some((c) => /ui-step/.test(c)), uiStepCommands: r.bashCommands.filter((c) => /ui-step/.test(c)).length,
    directLayoutCalls: r.bashCommands.filter((c) => /android\s+layout/.test(c)).length, shimLayoutReads: shim.filter((l) => l.call === "android layout").length, shimTaps: shim.filter((l) => l.call === "adb tap").length, shimNoops: shim.filter((l) => l.noop).length,
    screenshotsRead: r.reads.filter((p) => /\.(png|jpg)$/.test(p)).length, finalScreen, uiStepRefusals: refusals, itemsRight: right, itemsRightCount: right.filter(Boolean).length, cutByCap: r.subtype !== "success",
  };
  records.push(rec);
  ledger.spent = Math.round((ledger.spent + (r.cost ?? CAP)) * 1e6) / 1e6; ledger.sessions.push({ label: "ctx4-c11b", tag: SMOKE ? "smoke" : `${arm}${rec.n}`, cost: r.cost ?? CAP });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`${arm}${rec.n} ${r.subtype} modelCalls=${r.modelCalls} tools=${r.toolCalls} uiStep=${rec.usedUiStep}(${rec.uiStepCommands}) layoutDirect=${rec.directLayoutCalls} shots=${rec.screenshotsRead} refusals=${refusals} screen=${finalScreen} right=${rec.itemsRightCount}/4 denials=${r.denials} toolErrors=${r.toolErrors} cost=${r.cost}\n   answer: ${r.answer.replace(/\s+/g, " ").slice(0, 200)}`);
  if (SMOKE) console.log(JSON.stringify({ bash: r.bashCommands, answer: r.answer, denials: r.denials, toolErrors: r.toolErrors }, null, 1));
  rmSync(dir, { recursive: true, force: true });
}
if (!SMOKE) {
  const by = (arm) => records.filter((r) => r.arm === arm);
  const sum = (arm, key) => by(arm).reduce((s, r) => s + (r[key] ?? 0), 0);
  const gate = {
    a_armBUsesUiStepIn: `${by("B").filter((r) => r.usedUiStep).length} of 3 (gate >= 2)`,
    b_armBAllFourRightIn: `${by("B").filter((r) => r.itemsRightCount === 4).length} of 3 (gate >= 2)`,
    c_itemsRight: `B ${sum("B", "itemsRightCount")} of 12 against A ${sum("A", "itemsRightCount")} of 12 (gate: B >= A)`,
  };
  const totals = (arm) => ({ modelCalls: sum(arm, "modelCalls"), toolCalls: sum(arm, "toolCalls"), uiStepCommands: sum(arm, "uiStepCommands"), directLayoutCalls: sum(arm, "directLayoutCalls"), cost: sum(arm, "cost") });
  save("C11b", { note: `${MODEL}, confined, stand-in device, installed note, ledger ${ledger.spent} of ${ledger.ceiling}`, records, gate, totals: { A: totals("A"), B: totals("B") } });
  console.log(JSON.stringify(gate, null, 1));
}
console.log(`ledger: spent ${ledger.spent} of ${ledger.ceiling}`);

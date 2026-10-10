// OpenCode check with a real model. Commands (all take the run root as the first argument):
//   confine <root> <pluginDir>   prove the confinement with the stand-in provider (no model); writes confinement.json
//   credentials <root>           import the GitHub Copilot credential into a template folder (removed by `cleanup`)
//   run <root> <pluginDir> [ids] the four planned sessions, one after the other: ON, OFF, OFF, ON (or only the ids given, e.g. s1)
//   report <root>                counts of what the stored sessions show, as markdown
//   cleanup <root>               remove the credential template
// The design (question, model, task, arms, order, what is counted, what would stop it) is in eval/README.md and was fixed before the
// first session. Cap: 4 planned sessions and 2 reserve, enforced in ledgerStart.
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promptFor } from "../lib/run.mjs";
import { CONFINED_PERMISSION, confineScript, confinementProven, judgeConfine, prepareSentinels, writeProof } from "./confine.mjs";
import { MODEL, PROBE_PLUGIN, openCodeVersion, prepareCredentials, removeCredentials, runReal, summarizeProbe } from "./real.mjs";
import { runSession, summarizeRequests } from "./run.mjs";

export const PLAN = [
  { id: "s1", arm: "ON", run: 1 },
  { id: "s2", arm: "OFF", run: 1 },
  { id: "s3", arm: "OFF", run: 2 },
  { id: "s4", arm: "ON", run: 2 },
];
const SCENARIO = "conditions";

async function confine(root, pluginDir) {
  mkdirSync(root, { recursive: true });
  const version = openCodeVersion();
  const { LOGIC_DIRECTIVE } = await import(pathToFileURL(join(pluginDir, "private/logic-test-debug/check.mjs")).href);
  const probeEnv = { PROBE_LOG: join(root, "runs/confine/probe.jsonl"), PROBE_DIRECTIVE: LOGIC_DIRECTIVE };
  const sentinels = prepareSentinels(root);
  const dir = join(root, "runs/confine");
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "hello.txt"), "hello inside\n");
  const script = confineScript(workspace, sentinels);
  const r = await runSession({ dir, pluginDir: [pluginDir, PROBE_PLUGIN], prompt: "Permission test.", mode: "script", script: script.map(({ name, args }) => ({ name, args })), permission: CONFINED_PERMISSION, env: probeEnv, timeoutMs: 240000, cwd: workspace, keepWorkspace: true });
  const verdict = judgeConfine({ logText: readFileSync(join(dir, "requests.jsonl"), "utf8"), script, sentinels, workspace });
  sentinels.cleanupTmp();
  console.log(`confinement probe: exit ${r.exit}, timedOut ${r.timedOut}, pass ${verdict.pass}`);
  for (const row of verdict.table) console.log(`  ${row.ok ? "ok  " : "FAIL"} ${row.label.padEnd(26)} expected ${row.expect.padEnd(11)} got ${row.got}`);
  for (const reason of verdict.reasons) console.log(`  reason: ${reason}`);
  if (!verdict.pass) process.exitCode = 1;

  // The probe plugin must agree with what the model-side request log shows, or its numbers in real sessions mean nothing.
  const check = await runSession({ dir: join(root, "runs/probe-check"), pluginDir: [pluginDir, PROBE_PLUGIN], prompt: promptFor("conditions", 1), mode: "load-skill", permission: CONFINED_PERMISSION, env: { ...probeEnv, PROBE_LOG: join(root, "runs/probe-check/probe.jsonl") }, timeoutMs: 180000 });
  const fromRequests = summarizeRequests(readFileSync(join(root, "runs/probe-check/requests.jsonl"), "utf8")).directiveInSystem;
  const probe = summarizeProbe(readFileSync(join(root, "runs/probe-check/probe.jsonl"), "utf8"));
  const agree = probe.modelRequests === fromRequests.length && probe.withDirective === fromRequests.filter(Boolean).length && fromRequests[0] === true;
  console.log(`probe plugin check: requests ${JSON.stringify(fromRequests)} probe ${JSON.stringify(probe)} agree ${agree} (exit ${check.exit})`);
  if (!agree) process.exitCode = 1;
  if (verdict.pass && agree) {
    writeProof(root, version, pluginDir);
    console.log("confinement.json written");
  }
}

async function runAll(root, pluginDir, only = null) {
  for (const step of PLAN.filter((p) => !only || only.includes(p.id))) {
    const verdict = await runReal({ root, id: step.id, kind: "planned", scenario: SCENARIO, arm: step.arm, run: step.run, prompt: promptFor(SCENARIO, step.run), pluginDir });
    if (verdict.voided) {
      console.log(`${step.id} VOIDED: no model request was made (see ledger.tsv); stopping, nothing else is started`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ id: step.id, arm: step.arm, complete: verdict.complete, seconds: verdict.seconds, skillLoaded: verdict.session.skillLoaded, record: verdict.session.record.present, directive: `${verdict.probe.withDirective}/${verdict.probe.modelRequests}`, oracle: `${verdict.oracle.passed}/${verdict.oracle.total}`, success: verdict.oracle.success }));
    if (verdict.oracle.outOfScope?.length || verdict.session.rejected.length) console.log(`  note: refused attempts ${JSON.stringify(verdict.session.rejected)}, files outside scope ${JSON.stringify(verdict.oracle.outOfScope)}`);
  }
}

export function loadVerdicts(root) {
  const runs = join(root, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((n) => /^s\d+$/.test(n) && existsSync(join(runs, n, "verdict.json"))).sort().map((n) => JSON.parse(readFileSync(join(runs, n, "verdict.json"), "utf8"))).filter((v) => !v.voided);
}

/** Markdown with counts only; nothing is tested at n = 2 per arm. Pure over the verdicts. */
export function toMarkdown(verdicts) {
  const lines = ["# logic-test-debug on OpenCode, real model: report", "", `Sessions: ${verdicts.length} (planned: ${PLAN.length}). Model ${verdicts[0]?.model ?? MODEL}, OpenCode ${verdicts[0]?.version ?? "?"}, task: ${SCENARIO}. Counts only; with 2 sessions per arm no test is run and no effect is claimed.`, ""];
  lines.push("| id | arm | complete | s | model requests | with directive | skill loaded | record | tools | oracle | success | refused |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const v of verdicts) {
    const tools = Object.entries(v.session.toolCalls.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})).map(([n, c]) => `${n}×${c}`).join(" ");
    lines.push(`| ${v.id} | ${v.arm} | ${v.complete} | ${v.seconds} | ${v.probe.modelRequests} | ${v.probe.withDirective} | ${v.session.skillLoaded} | ${v.session.record.present} | ${tools} | ${v.oracle.passed}/${v.oracle.total} | ${v.oracle.success} | ${v.session.rejected.length} |`);
  }
  const arm = (a) => verdicts.filter((v) => v.arm === a);
  const n = (list, pick) => list.filter(pick).length;
  lines.push("", "| arm | sessions | directive in the first request | skill loaded | record | oracle success |", "|---|---|---|---|---|---|");
  for (const a of ["ON", "OFF"]) {
    const list = arm(a);
    lines.push(`| ${a} | ${list.length} | ${n(list, (v) => v.probe.firstHasDirective)} | ${n(list, (v) => v.session.skillLoaded)} | ${n(list, (v) => v.session.record.present)} | ${n(list, (v) => v.oracle.success)} |`);
  }
  const outside = verdicts.filter((v) => v.oracle.outOfScope?.length);
  lines.push("", `Gates: every ON session had the directive in its first model request: ${arm("ON").length > 0 && arm("ON").every((v) => v.probe.firstHasDirective)}; no OFF session had it: ${arm("OFF").every((v) => v.probe.withDirective === 0)}; sessions that changed files outside the allowed edits: ${outside.length}.`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, root, pluginDir] = process.argv.slice(2);
  if (command === "confine") await confine(root, pluginDir);
  else if (command === "credentials") {
    prepareCredentials(root);
    console.log("credential template ready");
  } else if (command === "run") await runAll(root, pluginDir, process.argv[5] ? process.argv[5].split(",") : null);
  else if (command === "report") {
    const md = toMarkdown(loadVerdicts(root));
    writeFileSync(join(root, "report.md"), md);
    console.log(md);
  } else if (command === "cleanup") {
    removeCredentials(root);
    console.log("credential template removed");
  } else {
    console.error("usage: campaign.mjs confine|credentials|run|report|cleanup <root> [pluginDir]");
    process.exitCode = 2;
  }
}

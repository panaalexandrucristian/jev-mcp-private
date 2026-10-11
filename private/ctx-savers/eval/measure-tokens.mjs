#!/usr/bin/env node
// Measured token cost of reading a PDF versus running pdf-text (C1), and of reading a full screenshot versus a shrunk one (C7).
// Metric: context length at the LAST model call of the session = input_tokens + cache_creation_input_tokens + cache_read_input_tokens of the
// final assistant message. Sessions are confined: files are copies in a private folder, Read is limited to that folder, dontAsk mode, the only
// shell command allowed is the copied pdf-text script, --restricted ignores user settings. Cap 0.10 USD per session; ledger-guarded.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { shrink } from "../img-shrink.mjs";
import { save } from "../lib/results.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = "/Users/apana/Dev/council-runs/2026-10-11/class-graph-find-def-stages/ledger.json";
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const nodeHome = dirname(dirname(real(process.execPath)));
const SHOTS = ["/private/tmp/claude-501/-Users-apana-StudioProjects-dgapp2-android/7a484193-91fd-4c2d-9333-9d1585869838/scratchpad"];
const PDFS = [`${homedir()}/Downloads/[#DSE-47553] Android - Fix the logic for the redemption limit.pdf`, `${homedir()}/Downloads/[#DSE-47609] [Android] Reward card_ use the same _Reward Earned_ logic as reward details.pdf`];

const MODEL = process.env.MODEL ?? "haiku";
const SETS = (process.env.SETS ?? "pdf,img").split(",");
const dir = real(mkdtempSync("/tmp/ctx-"));
mkdirSync(join(dir, "t"));
writeFileSync(join(dir, "empty-mcp.json"), '{"mcpServers":{}}\n');
copyFileSync(join(HERE, "..", "pdf-text.py"), join(dir, "pdf-text.py"));
PDFS.forEach((p, i) => copyFileSync(p, join(dir, `t${i + 1}.pdf`)));
// screenshots: find the files the session read (by name) in its scratchpad folder
const wanted = process.env.SHOTS ? process.env.SHOTS.split(",") : ["s3.png", "s9.png"];
for (const name of wanted) { copyFileSync(join(SHOTS[0], name), join(dir, name)); }
for (const name of wanted) { const r = shrink(join(dir, name), { maxWidth: 540, quality: 70, out: join(dir, name.replace(/\.png$/, "-small.jpg")) }); console.log(`shrunk ${name}: ${r.before.px.join("x")} ${r.before.bytes} B -> ${r.after.px.join("x")} ${r.after.bytes} B`); }

const settings = { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyRead: ["~/", real("/tmp"), real(tmpdir())], allowRead: [nodeHome, dir, "/opt/homebrew"], allowWrite: [join(dir, "t")] } } };
const Q_PDF_READ = `Read the two PDF tickets ${dir}/t1.pdf and ${dir}/t2.pdf. Answer with exactly two lines: the ticket id and its goal in one sentence.`;
const Q_PDF_SCRIPT = `Get the text of the two PDF tickets by running exactly these two commands, one per tool call: python3 -I ${dir}/pdf-text.py ${dir}/t1.pdf  and  python3 -I ${dir}/pdf-text.py ${dir}/t2.pdf . Answer with exactly two lines: the ticket id and its goal in one sentence.`;
const Q_IMG = (f) => `Look at the screenshot ${dir}/${f}. Answer with exactly three short lines: (1) the title text at the top of the screen, (2) the visible button labels, (3) whether any error or red warning text is shown (yes/no and the text).`;
import { digest, render as renderDigest } from "../ui-digest.mjs";
import { loadTranscript, command } from "../lib/transcript.mjs";
const uiShot = "s2.png";
let uiDigestText = "";
if (SETS.includes("ui")) {
  copyFileSync(join(SHOTS[0], uiShot), join(dir, uiShot));
  const call = loadTranscript().active.find((c) => c.name === "Bash" && /android layout --flat/.test(command(c)));
  uiDigestText = renderDigest(JSON.parse(call.text.replace(/\nShell cwd was reset.*$/s, "").trim()));
}
const Q_UI = "Answer with exactly three short lines: (1) the title text at the top of the screen, (2) the visible button labels, (3) which button signs the user in and the x,y pixel coordinates of its center if you can tell.";
const all = [
  ...(SETS.includes("pdf") ? [{ id: "pdf-read-1", kind: "C1", variant: "A: Read PDF", prompt: Q_PDF_READ }, { id: "pdf-script-1", kind: "C1", variant: "B: pdf-text", prompt: Q_PDF_SCRIPT }, { id: "pdf-read-2", kind: "C1", variant: "A: Read PDF", prompt: Q_PDF_READ }, { id: "pdf-script-2", kind: "C1", variant: "B: pdf-text", prompt: Q_PDF_SCRIPT }] : []),
  ...(SETS.includes("img") ? wanted.flatMap((n, i) => [{ id: `img-full-${i + 1}`, kind: "C7", variant: "A: full PNG", shot: n, prompt: Q_IMG(n) }, { id: `img-small-${i + 1}`, kind: "C7", variant: "B: 540px JPEG", shot: n, prompt: Q_IMG(n.replace(/\.png$/, "-small.jpg")) }]) : []),
  ...(SETS.includes("ui") ? [{ id: "ui-full", kind: "C8", variant: "A: screenshot", prompt: `Look at the screenshot ${dir}/${uiShot}. ${Q_UI}` }, { id: "ui-digest", kind: "C8", variant: "B: ui-digest text", prompt: `This is a text description of an Android screen, one element per line (class | label | center x,y | actions):\n${uiDigestText}\n${Q_UI}` }] : []),
  ...(SETS.includes("base") ? [{ id: "baseline", kind: "base", variant: "no file", prompt: "Reply with the single word OK." }] : []),
];
const jobs = all;
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
if (only) jobs.splice(0, jobs.length, ...jobs.filter((j) => only.includes(j.id)));
const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const CAP = Number(process.env.CAP_USD ?? ledger.cap);
if (ledger.spent + jobs.length * CAP > ledger.ceiling) { console.error("ledger ceiling would be exceeded"); process.exit(3); }

const runJob = (job) => new Promise((resolve) => {
  const args = ["-p", job.prompt, "--model", MODEL, "--restricted", "--add-dir", dir, "--tools", "Read,Bash",
    "--allowedTools", `Read(/${dir}/**)`, `Bash(python3 -I ${dir}/pdf-text.py:*)`, "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", join(dir, "empty-mcp.json"),
    "--settings", JSON.stringify(settings), "--output-format", "stream-json", "--verbose", "--session-id", randomUUID(), "--max-budget-usd", String(CAP)];
  const env = {}; for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.TMPDIR = join(dir, "t"); env.CLAUDE_CODE_TMPDIR = join(dir, "t");
  const child = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
  child.on("close", () => {
    clearTimeout(timer);
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const assistants = events.filter((e) => e.type === "assistant" && e.message?.usage);
    const last = assistants.at(-1)?.message.usage ?? {};
    const res = events.find((e) => e.type === "result");
    const tools = assistants.flatMap((e) => (e.message.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name));
    const context = (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
    resolve({ ...job, prompt: undefined, contextAtLastCall: context, usage: last, tools, answer: String(res?.result ?? "").slice(0, 600), models: Object.keys(res?.modelUsage ?? {}), cost: res?.total_cost_usd ?? null, subtype: res?.subtype, denials: res?.permission_denials?.length ?? 0 });
  });
});
const results = [];
for (const job of jobs) {
  const r = await runJob(job); results.push(r);
  ledger.spent = Math.round((ledger.spent + (r.cost ?? ledger.cap)) * 1e6) / 1e6; ledger.sessions.push({ label: "ctx", tag: job.id, cost: r.cost ?? ledger.cap });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`${job.id.padEnd(13)} ${r.subtype} context=${r.contextAtLastCall} tools=[${r.tools}] cost=${r.cost} denials=${r.denials}\n   answer: ${r.answer.replace(/\n/g, " | ").slice(0, 300)}`);
}
save(process.env.SAVE_AS ?? (only ? `tokens-${only.join("-")}` : "tokens"), { note: `context length at the last model call, ${MODEL}, confined sessions, sets ${SETS.join("+")}`, results });
rmSync(dir, { recursive: true, force: true });
console.log(`ledger: spent ${ledger.spent} of ${ledger.ceiling}`);

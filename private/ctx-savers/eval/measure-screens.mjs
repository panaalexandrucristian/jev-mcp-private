#!/usr/bin/env node
// Round 3: for every screen of emu/screens.json one confined Sonnet session reading the screenshot and one with the ui-digest inline, same three questions,
// plus a baseline session. Metric: context length at the last model call (see measure-tokens.mjs). Digests are regenerated from the raw layout with the current ui-digest.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { render } from "../ui-digest.mjs";
import { shrink } from "../img-shrink.mjs";
import { save } from "../lib/results.mjs";

const LEDGER = "/Users/apana/Dev/council-runs/2026-10-11/class-graph-find-def-stages/ledger.json";
const MANIFEST = process.env.SCREENS;
const MODEL = process.env.MODEL ?? "sonnet";
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const nodeHome = dirname(dirname(real(process.execPath)));
const screens = JSON.parse(readFileSync(MANIFEST, "utf8"));
const dir = real(mkdtempSync("/tmp/scr-"));
mkdirSync(join(dir, "t")); writeFileSync(join(dir, "empty-mcp.json"), '{"mcpServers":{}}\n');
const Q = "Answer with exactly three short lines: (1) the header or title text of the screen, (2) the labels of the tabs or buttons the user can tap, (3) which card, tile or item is shown as complete, earned or active, if any (say none if there is nothing like that).";
// SHRINK=<max width px> (round 4, V1): only the image jobs, each reading a shrunk JPEG of the screenshot instead of the PNG; no baseline, no digest jobs.
const SHRINK = process.env.SHRINK ? Number(process.env.SHRINK) : null;
const jobs = SHRINK ? [] : [{ id: "baseline", kind: "base", prompt: "Reply with the single word OK." }];
screens.forEach((s, i) => {
  const name = `s${String(i + 1).padStart(2, "0")}.${SHRINK ? "jpg" : "png"}`;
  if (SHRINK) shrink(s.png, { maxWidth: SHRINK, quality: 70, out: join(dir, name) }); else copyFileSync(s.png, join(dir, name));
  const raw = readFileSync(s.png.replace(/\.png$/, ".layout.json"), "utf8");
  const text = render(JSON.parse(raw));
  s.localPng = name; s.digestText = text;
  jobs.push({ id: `${s.id}|image`, kind: "image", screen: s.id, prompt: `Look at the screenshot ${dir}/${name}. ${Q}` });
  if (!SHRINK) jobs.push({ id: `${s.id}|digest`, kind: "digest", screen: s.id, prompt: `This is a text description of an Android screen, one element per line (class | label | center x,y | actions):\n${text}\n${Q}` });
});
const settings = { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyRead: ["~/", real("/tmp"), real(tmpdir())], allowRead: [nodeHome, dir], allowWrite: [join(dir, "t")] } } };
const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const CAP = Number(process.env.CAP_USD ?? 0.15);
if (ledger.spent + jobs.length * CAP > ledger.ceiling) { console.error("ledger ceiling would be exceeded"); process.exit(3); }
const runJob = (job) => new Promise((resolve) => {
  const args = ["-p", job.prompt, "--model", MODEL, "--restricted", "--add-dir", dir, "--tools", "Read", "--allowedTools", `Read(/${dir}/**)`, "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", join(dir, "empty-mcp.json"), "--settings", JSON.stringify(settings), "--output-format", "stream-json", "--verbose", "--session-id", randomUUID(), "--max-budget-usd", String(CAP)];
  const env = {}; for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.TMPDIR = join(dir, "t"); env.CLAUDE_CODE_TMPDIR = join(dir, "t");
  const child = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
  child.on("close", () => {
    clearTimeout(timer);
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const assistants = events.filter((e) => e.type === "assistant" && e.message?.usage);
    const last = assistants.at(-1)?.message.usage ?? {}; const res = events.find((e) => e.type === "result");
    const context = (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
    resolve({ id: job.id, kind: job.kind, screen: job.screen, contextAtLastCall: context, tools: assistants.flatMap((e) => (e.message.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name)), answer: String(res?.result ?? ""), cost: res?.total_cost_usd ?? null, subtype: res?.subtype, denials: res?.permission_denials?.length ?? 0, models: Object.keys(res?.modelUsage ?? {}) });
  });
});
const results = [];
for (const job of jobs) {
  const r = await runJob(job); results.push(r);
  ledger.spent = Math.round((ledger.spent + (r.cost ?? CAP)) * 1e6) / 1e6; ledger.sessions.push({ label: "ctx3", tag: job.id.slice(0, 40), cost: r.cost ?? CAP });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`${job.id.padEnd(44)} ${r.subtype} context=${r.contextAtLastCall} tools=[${r.tools}] cost=${r.cost} denials=${r.denials}`);
}
save(process.env.SAVE_AS ?? "screens-sonnet", { note: `context at the last call, ${MODEL}, confined, ${screens.length} screens`, results, screens: screens.map(({ id, rawChars, digestChars, digestText }) => ({ id, rawChars, digestChars, digestText })) });
rmSync(dir, { recursive: true, force: true });
console.log(`ledger: spent ${ledger.spent} of ${ledger.ceiling}`);

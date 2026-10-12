#!/usr/bin/env node
// Round 4b: ui-step on the real emulator, read-only walk (EVAL-RULES-4.md, last addendum). node eval/ui-step-real.mjs <jpg-out>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { save } from "../lib/results.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "ui-step.mjs");
const SHOT = process.argv[2];
const vpn = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code}", "https://www.dollargeneral.com"], { encoding: "utf8" }).stdout;
const ui = (...args) => { const t0 = Date.now(); const r = spawnSync("node", [SCRIPT, "--safe", ...args], { encoding: "utf8" }); return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 }; };
const digestOf = (text) => createHash("sha1").update(text.split("\n").slice(1).join("\n")).digest("hex").slice(0, 12);
const STEPS = [
  { name: "home", args: ["--tap", "Home", "--region", "bottom"], anchor: /Search products/ },
  { name: "home-swipe", args: ["--swipe"], anchor: /home_items_recycler_view/ },
  { name: "wallet", args: ["--tap", "myDG Wallet", "--region", "bottom"], anchor: /Order History/ },
  { name: "list", args: ["--tap", "List", "--region", "bottom"], anchor: /Shopping List/ },
  { name: "cart", args: ["--tap", "Cart", "--region", "bottom"], anchor: /Total|Start shopping/ },
  { name: "deals", args: ["--tap", "Deals", "--region", "bottom", "--shot", SHOT], anchor: /Explore Deals/ },
  { name: "rewards", args: ["--tap", "Rewards", "--region", "top"], anchor: /Activated Rewards|Available Rewards/ },
];
const rows = []; let stopped = null;
if (vpn() !== "200") { console.error("STOP: VPN check is not 200"); process.exit(3); }
for (const s of STEPS) {
  const r = ui(...s.args);
  const settled = /; settled \(/.test(r.out); const reads = Number(/\((\d+) layout reads\)/.exec(r.out)?.[1] ?? NaN);
  const row = { step: s.name, exit: r.status, settled, reads, ms: r.ms, anchor: s.anchor.test(r.out), head: r.out.split("\n")[0], stderr: r.err.trim().slice(0, 160) };
  rows.push(row); console.log(JSON.stringify(row));
  if (r.status !== 0 || !settled || !row.anchor) { stopped = s.name; break; }
}
let refusals = [];
if (!stopped) {
  const before = digestOf(ui().out);
  for (const label of ["Add to cart", "Settings", "Send verification email"]) { const r = ui("--tap", label); refusals.push({ label, exit: r.status, stderr: r.err.trim().slice(0, 120) }); console.log(JSON.stringify(refusals.at(-1))); }
  const after = digestOf(ui().out);
  refusals.push({ screenUnchanged: before === after });
}
const final = ui();
const endsOnRewards = /Activated Rewards|Available Rewards/.test(final.out) && /Explore Deals/.test(final.out);
const shotOk = !!SHOT && existsSync(SHOT);
const gates = { a_steps_ok: !stopped && rows.length === STEPS.length && rows.every((r) => r.exit === 0 && r.settled && r.anchor), b_refusals: refusals.length === 4 && refusals.slice(0, 3).every((r) => r.exit === 3) && refusals[3].screenUnchanged, c_endsOnRewards: endsOnRewards, d_shot: shotOk };
save("C10-real", { note: "ui-step on the real emulator-5554, read-only walk", stopped, rows, refusals, gates, meanMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / Math.max(rows.length, 1)), vpnAtEnd: vpn() });
console.log(JSON.stringify({ stopped, gates }, null, 1));

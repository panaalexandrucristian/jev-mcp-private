#!/usr/bin/env node
// Read-only walk through the app on the emulator; for each screen saves the screenshot, the raw layout JSON, the digest and the sizes of layout and layout --diff.
//   node eval/emulator-run.mjs <out-dir>     (see EVAL-RULES-3.md for the whitelist and the stop rules)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, render } from "../ui-digest.mjs";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: emulator-run.mjs <out-dir>"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const SERIAL = "emulator-5554";
const ALLOWED = [/^Home$/, /^Deals$/, /^myDG.? ?Wallet$/i, /^List$/, /^Cart$/, /^Coupons & Cash Back$/, /^Weekly Ads$/, /^Rewards$/, /^Rebates$/];
const FORBIDDEN = /(Activate|Add|Clip|Redeem|Sign out|Log out|Checkout|Place|Order|Send|Delete|Remove|Buy|Pay|Verify|Edit|Save|Scan|Camera)/i;
const adb = (...a) => execFileSync("adb", ["-s", SERIAL, ...a], { encoding: "utf8" });
const sleep = (s) => spawnSync("sleep", [String(s)]);
const layout = (...args) => { const r = spawnSync("android", ["layout", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return r.stdout; };
const stop = (why) => { console.error(`STOP: ${why}`); process.exit(3); };
const vpnOk = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code}", "https://www.dollargeneral.com"], { encoding: "utf8" }).stdout === "200";
const findLabel = (data, label, region) => {
  if (FORBIDDEN.test(label)) stop(`label "${label}" is on the forbidden list`);
  if (!ALLOWED.some((re) => re.test(label))) stop(`label "${label}" is not on the whitelist`);
  const app = data.filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []);
  const y = (e) => Number(e.center.match(/,(\d+)/)[1]);
  let hits = app.filter((e) => (e.text === label || e["content-desc"] === label || (label.startsWith("myDG") && /myDG/.test(e.text ?? e["content-desc"] ?? ""))) && e.center);
  hits = region === "top" ? hits.filter((e) => y(e) < 500) : region === "bottom" ? hits.filter((e) => y(e) > 2100) : hits;
  if (hits.length === 0) stop(`no element "${label}" in region ${region ?? "any"} on this screen`);
  const pick = hits[0];
  const [x, yy] = pick.center.replace(/[[\]]/g, "").split(",").map(Number);
  return { x, y: yy, label, region };
};
const steps = JSON.parse(process.env.STEPS ?? '[{"name":"deals-rewards-start"},{"tap":"Coupons & Cash Back","region":"top","name":"deals-coupons"},{"tap":"Weekly Ads","region":"top","name":"deals-weekly-ads"},{"tap":"Rebates","region":"top","name":"deals-rebates"},{"tap":"Home","region":"bottom","name":"home"},{"swipe":true,"name":"home-scrolled"},{"tap":"myDG Wallet","region":"bottom","name":"wallet"},{"tap":"List","region":"bottom","name":"list"},{"tap":"Cart","region":"bottom","name":"cart"},{"tap":"Deals","region":"bottom","name":"deals-again"},{"tap":"Rewards","region":"top","name":"deals-rewards-end"}]');
const log = [];
if (!vpnOk()) stop("VPN check did not return 200");
layout("--flat"); // sets the baseline for --diff
steps.forEach((s, i) => {
  let action = null;
  if (s.tap) {
    const before = JSON.parse(layout("--flat")); // also the baseline for the --diff taken after the step
    action = findLabel(before, s.tap, s.region);
    adb("shell", "input", "tap", String(action.x), String(action.y));
  } else if (s.swipe) { adb("shell", "input", "swipe", "540", "1700", "540", "900", "300"); action = { swipe: "down once" }; }
  sleep(s.tap ? 4 : 3);
  let raw = layout("--flat");
  let data; try { data = JSON.parse(raw); } catch { stop(`step ${s.name}: layout did not return JSON`); }
  const appCount = (d) => d.filter((w) => w.type !== "SYSTEM").reduce((n, w) => n + (w.content ?? []).length, 0);
  if (appCount(data) === 0) { sleep(4); raw = layout("--flat"); try { data = JSON.parse(raw); } catch { stop(`step ${s.name}: layout did not return JSON`); } if (appCount(data) === 0) stop(`step ${s.name}: the screen exposes no app elements after one retry`); }
  const texts = data.filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []).map((e) => `${e.text ?? ""} ${e["content-desc"] ?? ""}`).join(" ");
  if (/needs to be verified|Error processing your request|Sign in to access/i.test(texts)) stop(`step ${s.name}: the app shows a login, verify or error screen`);
  const n = String(i + 1).padStart(2, "0");
  writeFileSync(join(OUT, `${n}-${s.name}.layout.json`), raw);
  const d = render(data); writeFileSync(join(OUT, `${n}-${s.name}.digest.txt`), `${d}\n`);
  spawnSync("android", ["screen", "capture", "-o", join(OUT, `${n}-${s.name}.png`)]);
  const { lines, total } = digest(data);
  const wanted = data.filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []).filter((e) => e.text || e["content-desc"] || e["resource-id"] || (e.interactions ?? []).includes("CLICKABLE"));
  const missing = wanted.filter((e) => e.center && !d.includes(e.center.replace(/[[\]]/g, ""))).length;
  const unlabeled = lines.filter((l) => /\| - \|/.test(l)).length;
  const row = { n, name: s.name, action, rawChars: raw.length, digestChars: d.length, ratio: +(d.length / raw.length).toFixed(3), elements: total, listed: lines.length, wanted: wanted.length, missing, unlabeledLines: unlabeled, pngBytes: statSync(join(OUT, `${n}-${s.name}.png`)).size };
  log.push(row); console.log(JSON.stringify(row));
});
writeFileSync(join(OUT, "run.json"), `${JSON.stringify({ at: new Date().toISOString(), device: SERIAL, log }, null, 2)}\n`);

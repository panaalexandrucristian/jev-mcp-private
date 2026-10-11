#!/usr/bin/env node
// Stand-in for the `android` and `adb` commands (round 4, C11): serves the recorded screens of the round 3 emulator walk. No device is touched.
//   node shim.mjs android layout [--flat] [--diff|-d] [-o file]
//   node shim.mjs android screen capture [--annotate] -o file
//   node shim.mjs adb [-s serial] shell input tap X Y | swipe X1 Y1 X2 Y2 [ms] | keyevent N        node shim.mjs adb devices
// Needs SHIM_MANIFEST (json: { start, screens: { name: { layout, png } } }), SHIM_STATE (json file, created on first use), SHIM_LOG (jsonl, appended).
// A tap changes the screen only when it lands on a bottom-tab element (resource id *nav_bar_home|deals|wallet|list|cart) or on the Deals sub-tab text
// "Rewards" / "Coupons & Cash Back" (top of the screen); every other tap, swipe or key does nothing and is logged as noop. Swipe on the home screen -> home-scrolled; Back pops the last screen.
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.env.SHIM_MANIFEST, "utf8"));
const statePath = process.env.SHIM_STATE;
const logPath = process.env.SHIM_LOG;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { screen: manifest.start, stack: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const log = (entry) => appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), screen: state.screen, ...entry })}\n`);
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

const [tool, ...args] = process.argv.slice(2);
const current = () => manifest.screens[state.screen];
const layoutData = () => JSON.parse(readFileSync(current().layout, "utf8").replace(/\nShell cwd was reset.*$/s, "").trim());
const appElements = () => layoutData().filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []);
const NAV = { home: "home", deals: "deals", wallet: "wallet", list: "list", cart: "cart" };

const parseBounds = (b) => { const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(b ?? ""); return m ? m.slice(1).map(Number) : null; };
function targetOfTap(x, y) {
  const hits = appElements().map((e) => ({ e, b: parseBounds(e.bounds) })).filter(({ b }) => b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]).sort((p, q) => (p.b[2] - p.b[0]) * (p.b[3] - p.b[1]) - (q.b[2] - q.b[0]) * (q.b[3] - q.b[1]));
  for (const { e } of hits) {
    const nav = /nav_bar_(home|deals|wallet|list|cart)/.exec(e["resource-id"] ?? "");
    if (nav) return NAV[nav[1]];
    if (y < 500 && e.text === "Rewards") return "rewards";
    if (y < 500 && e.text === "Coupons & Cash Back") return "deals";
  }
  return null;
}
function goto(name) { if (name !== state.screen) { state.stack.push(state.screen); state.screen = name; } }

if (tool === "android") {
  const [cmd, sub] = args;
  if (cmd === "layout") {
    if (args.includes("--diff") || args.includes("-d")) process.stderr.write("WARNING: The --diff flag is deprecated; it is currently a no-op\n");
    log({ call: "android layout" });
    const out = args.indexOf("-o") >= 0 ? args[args.indexOf("-o") + 1] : null;
    const text = readFileSync(current().layout, "utf8").replace(/\nShell cwd was reset.*$/s, "").trim();
    if (out) writeFileSync(out, `${text}\n`); else process.stdout.write(`${text}\n`);
  } else if (cmd === "screen" && sub === "capture") {
    const out = args.indexOf("-o") >= 0 ? args[args.indexOf("-o") + 1] : null;
    if (!out) fail("android screen capture: -o <file> is required");
    log({ call: "android screen capture", annotate: args.includes("--annotate") });
    copyFileSync(current().png, out);
    process.stdout.write(`${out}\n`);
  } else if (cmd === "screen") { log({ call: `android screen ${sub ?? ""}`, unsupported: true }); fail("android screen: only `capture -o <file>` is available here"); }
  else { log({ call: `android ${cmd ?? ""}`, unsupported: true }); process.stdout.write("Usage: android <command>\n  layout   Returns the layout tree of an app\n  screen   Captures or inspects the device screen\n"); }
} else if (tool === "adb") {
  let rest = args;
  if (rest[0] === "-s") rest = rest.slice(2);
  if (rest[0] === "devices") { log({ call: "adb devices" }); process.stdout.write("List of devices attached\nemulator-5554\tdevice\n"); }
  else if (rest[0] === "shell" && rest[1] === "input") {
    const [, , kind, ...nums] = rest;
    if (kind === "tap") {
      const [x, y] = nums.map(Number);
      const target = targetOfTap(x, y);
      if (target) { goto(target); log({ call: "adb tap", x, y, moved: target }); } else log({ call: "adb tap", x, y, noop: true });
    } else if (kind === "swipe") {
      if (state.screen === "home") { goto("home-scrolled"); log({ call: "adb swipe", moved: "home-scrolled" }); } else log({ call: "adb swipe", noop: true });
    } else if (kind === "keyevent" && nums[0] === "4") {
      const prev = state.stack.pop();
      if (prev) { state.screen = prev; log({ call: "adb back", moved: prev }); } else log({ call: "adb back", noop: true });
    } else { log({ call: `adb input ${kind}`, noop: true }); }
    save();
  } else { log({ call: `adb ${rest.join(" ")}`.slice(0, 80), unsupported: true }); fail("adb: this stand-in supports `devices` and `shell input tap|swipe|keyevent` only"); }
} else fail("usage: shim.mjs android|adb ...", 2);

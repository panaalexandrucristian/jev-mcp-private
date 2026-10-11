// C11 stand-in: the `android` / `adb` shims serve the recorded screens and move only on bottom-tab and Deals sub-tab taps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeStandIn } from "../eval/stand-in/make-stand-in.mjs";

const ASSETS = process.env.EMU_ASSETS ?? "/private/tmp/claude-501/-Users-apana-Dev-jev-mcp/33d1616c-4c12-4439-927c-8368bbf1212c/scratchpad/emu";
describe("stand-in for android and adb", { skip: !existsSync(join(ASSETS, "walk4", "04-wallet.layout.json")) && "recorded assets missing" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "stand-in-"));
  const stand = makeStandIn(ASSETS, dir);
  const env = { ...process.env, PATH: `${stand.bin}:${process.env.PATH}` };
  const sh = (cmd, ...args) => spawnSync(cmd, args, { encoding: "utf8", env });
  const screen = () => JSON.parse(readFileSync(stand.state, "utf8")).screen;
  const logs = () => readFileSync(stand.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  it("starts on home and prints valid layout JSON; --diff warns and still returns the whole layout", () => {
    const plain = sh("android", "layout", "--flat");
    assert.equal(plain.status, 0);
    assert.ok(Array.isArray(JSON.parse(plain.stdout)));
    const diff = sh("android", "layout", "--diff");
    assert.match(diff.stderr, /deprecated/);
    assert.equal(diff.stdout, plain.stdout);
  });
  it("moves on bottom-tab taps (any point inside the tab), ignores every other tap, swipe on home, back", () => {
    sh("adb", "-s", "emulator-5554", "shell", "input", "tap", "10", "10");
    assert.equal(screen(), "home");
    assert.deepEqual(logs().at(-1).noop, true);
    sh("adb", "shell", "input", "tap", "540", "2340");
    assert.equal(screen(), "wallet");
    sh("adb", "shell", "input", "tap", "971", "2343");
    assert.equal(screen(), "cart");
    sh("adb", "shell", "input", "keyevent", "4");
    assert.equal(screen(), "wallet");
    sh("adb", "shell", "input", "tap", "107", "2340");
    sh("adb", "shell", "input", "swipe", "540", "1700", "540", "900", "300");
    assert.equal(screen(), "home-scrolled");
  });
  it("screen capture copies the recorded PNG; unsupported commands fail loudly", () => {
    const out = join(dir, "t", "cap.png");
    assert.equal(sh("android", "screen", "capture", "-o", out).status, 0);
    assert.ok(statSync(out).size > 10000);
    assert.notEqual(sh("android", "screen", "resolve", "--string", "#3").status, 0);
    assert.notEqual(sh("adb", "shell", "pm", "list", "packages").status, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Builds a stand-in folder for C11: copies the recorded screens, writes the manifest and the `android` / `adb` wrapper scripts.
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCREEN_FILES = { home: "walk4/02-home", "home-scrolled": "walk4/03-home-scrolled", wallet: "walk4/04-wallet", list: "walk4/05-list", cart: "walk4/06-cart", deals: "walk4/07-deals-again", rewards: "walk4/08-deals-rewards-end" };

/** `assets` = the folder with walk4/..; `dir` = where the stand-in is built. Returns { bin, log, state }. */
export function makeStandIn(assets, dir, { start = "home" } = {}) {
  const screens = {};
  mkdirSync(join(dir, "assets"), { recursive: true }); mkdirSync(join(dir, "bin"), { recursive: true }); mkdirSync(join(dir, "t"), { recursive: true });
  for (const [name, base] of Object.entries(SCREEN_FILES)) {
    const layout = join(dir, "assets", `${name}.layout.json`), png = join(dir, "assets", `${name}.png`);
    copyFileSync(join(assets, `${base}.layout.json`), layout); copyFileSync(join(assets, `${base}.png`), png);
    screens[name] = { layout, png };
  }
  const manifest = join(dir, "assets", "manifest.json");
  writeFileSync(manifest, JSON.stringify({ start, screens }));
  copyFileSync(join(HERE, "shim.mjs"), join(dir, "assets", "shim.mjs"));
  const state = join(dir, "t", "state.json"), log = join(dir, "t", "shim.log.jsonl");
  for (const tool of ["android", "adb"]) {
    const file = join(dir, "bin", tool);
    writeFileSync(file, `#!/bin/sh\nSHIM_MANIFEST='${manifest}' SHIM_STATE='${state}' SHIM_LOG='${log}' exec node '${join(dir, "assets", "shim.mjs")}' ${tool} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return { bin: join(dir, "bin"), log, state, manifest };
}

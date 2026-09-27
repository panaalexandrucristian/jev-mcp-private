#!/usr/bin/env node
// Test check for the gate runner, run as argv (no shell):
//   check.mjs <stdout text> <exit code> [--stderr <text>] [--sleep <ms>] [--write <file>]
const [out = "", code = "0", ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (opt("--write")) (await import("node:fs")).writeFileSync(opt("--write"), "written by a check\n");
process.stdout.write(`${out}\n`);
if (opt("--stderr")) process.stderr.write(`${opt("--stderr")}\n`);
if (opt("--sleep")) await new Promise((r) => setTimeout(r, Number(opt("--sleep"))));
process.exit(Number(code));

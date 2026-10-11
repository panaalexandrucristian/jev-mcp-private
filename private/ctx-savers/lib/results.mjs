import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", process.env.RESULTS_SUBDIR ?? "results");
export const save = (id, data) => { mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, `${id}.json`), `${JSON.stringify({ id, measuredAt: new Date().toISOString(), ...data }, null, 2)}\n`); };
export const RESULTS_DIR = DIR;

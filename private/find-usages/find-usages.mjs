#!/usr/bin/env node
// find-usages: where are the classes and functions of a Kotlin file used, like
// Find Usages in Android Studio but from text. Searches .kt, .java and .xml under
// the project root.
//
//   node private/find-usages/find-usages.mjs <File.kt> [name] [options]
//
// Without a name every public declaration of the file is searched; with a name
// only that one. Hits are grouped by how sure the rules are (certain, likely,
// ambiguous); same-named symbols of other packages and matches inside comments
// and strings are counted but not listed.
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JEV_LIMITS, judgeAmbiguous } from "./jev-filter.mjs";
import { renderStats, renderText } from "./render.mjs";
import { findUsages, LIMITS, UsageError } from "./usages.mjs";

const USAGE = `usage: find-usages.mjs <File.kt> [name] [options]
  --root <dir>        project root to search (default: nearest parent with .git, else the file's folder)
  --max-hits <n>      hits listed per symbol and tier (default ${LIMITS.maxHits})
  --include-private   also search private declarations
  --include-override  also search overriding functions and properties
  --jev               let Jev judge the ambiguous hits (jev_classify; needs Jev credentials in the environment)
  --jev-threshold <p> a Jev verdict counts only above this probability (default ${JEV_LIMITS.threshold})
  --max-jev-calls <n> Jev calls for the whole run (default ${JEV_LIMITS.maxCalls})
  --jev-hits <n>      ambiguous hits judged per symbol, nearest folders first (default ${JEV_LIMITS.perGroup}, 64 per call; at most --max-hits are kept)
  --json              print the full result as JSON
  --stats             print scan time and memory to stderr`;

function projectRoot(file) {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return dirname(resolve(file));
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      "max-hits": { type: "string" },
      "include-private": { type: "boolean" },
      "include-override": { type: "boolean" },
      jev: { type: "boolean" },
      "jev-threshold": { type: "string" },
      "max-jev-calls": { type: "string" },
      "jev-hits": { type: "string" },
      json: { type: "boolean" },
      stats: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length < 1 || positionals.length > 2) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const maxHits = values["max-hits"] === undefined ? LIMITS.maxHits : Number(values["max-hits"]);
  if (!Number.isInteger(maxHits) || maxHits < 1) throw new UsageError("--max-hits must be a positive whole number");
  const number = (flag, fallback, valid) => {
    if (values[flag] === undefined) return fallback;
    const value = Number(values[flag]);
    if (!valid(value)) throw new UsageError(`--${flag} has an invalid value: ${values[flag]}`);
    return value;
  };
  const jev = {
    threshold: number("jev-threshold", JEV_LIMITS.threshold, (v) => v > 0.5 && v < 1),
    maxCalls: number("max-jev-calls", JEV_LIMITS.maxCalls, (v) => Number.isInteger(v) && v >= 1),
    perGroup: number("jev-hits", JEV_LIMITS.perGroup, (v) => Number.isInteger(v) && v >= 1),
  };
  const [file, name] = positionals;
  const result = await findUsages({
    file,
    name: name ?? null,
    root: values.root ?? projectRoot(file),
    maxHits,
    includePrivate: values["include-private"] === true,
    includeOverride: values["include-override"] === true,
  });
  if (values.jev) result.jev = await judgeAmbiguous(result, jev);
  console.log(values.json ? JSON.stringify(result) : renderText(result));
  if (result.jev && result.jev.status !== "ok") console.error(`find-usages: Jev ${result.jev.status}: ${result.jev.reason}; the listing above is rule-based only`);
  if (values.stats) console.error(renderStats(result));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof UsageError ? `find-usages: ${error.message}` : `find-usages failed: ${error?.stack ?? error}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);

#!/usr/bin/env node
// Offline replay of the decision batches real sessions passed to `decide --file`.
// Rebuilds each batch as the helper read it (the last Write of the file plus the
// Edits after it; unknown after any other command that names the file) and runs the
// CURRENT normalizeBatch on it, so a validator change is measured on real inputs:
// how many recorded invalid batches would now pass (fixed) and how many accepted
// ones would now fail (broken). Deterministic and local; no batch text is printed.
//   node replay-batches.mjs [--root ~/.claude/projects] [--transcript <file>]...
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findSessions, helperSub } from "./analyze-sessions.mjs";
import { collectEvents, parseJsonl } from "./measure.mjs";
import { normalizeBatch } from "./options.mjs";

function lastJson(text) {
  for (const line of String(text ?? "").split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {
      // Not the JSON line.
    }
  }
  return null;
}

const fileArg = (command) => /--file\s+("?)([^"\s]+)\1/.exec(command)?.[2] ?? null;
const isRemoval = (command, name) => new RegExp(`^rm\\s+(?:-f\\s+)?"?\\S*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`).test(command.trim());

function applyEdit(content, { old_string: oldS, new_string: newS, replace_all: all }) {
  if (typeof content !== "string" || typeof oldS !== "string" || typeof newS !== "string" || !content.includes(oldS)) return null;
  return all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS);
}

/** [{content|null, recorded, recorded_problems, root}] for every `decide --file` of a transcript, in order. */
export function extractBatches(records) {
  const events = collectEvents(records);
  const names = new Set();
  for (const e of events) {
    if (e.name === "Bash" && helperSub(e.input?.command) === "decide") {
      const f = fileArg(e.input.command);
      if (f && f !== "-") names.add(basename(f));
    }
  }
  const content = new Map();
  const out = [];
  for (const e of events) {
    const name = basename(String(e.input?.file_path ?? ""));
    if (e.name === "Write" && names.has(name)) content.set(name, typeof e.input.content === "string" ? e.input.content : null);
    else if (e.name === "Edit" && names.has(name)) content.set(name, applyEdit(content.get(name), e.input));
    else if (e.name === "MultiEdit" && names.has(name)) {
      let c = content.get(name);
      for (const ed of Array.isArray(e.input.edits) ? e.input.edits : []) c = applyEdit(c, ed);
      content.set(name, c);
    } else if (e.name === "Bash") {
      const command = String(e.input?.command ?? "");
      if (helperSub(command) === "decide") {
        const f = fileArg(command);
        if (!f || f === "-") continue;
        const r = lastJson(e.result?.text);
        out.push({ content: content.get(basename(f)) ?? null, recorded: typeof r?.status === "string" ? r.status : "unknown", recorded_problems: Array.isArray(r?.problems) ? r.problems : [], root: e.root ?? null });
      } else if (!helperSub(command)) {
        // Any other command naming a batch file may have changed it: its content is unknown from here on.
        for (const nm of names) if (command.includes(nm)) content.set(nm, isRemoval(command, nm) ? undefined : null);
      }
    }
  }
  return out;
}

const problemKey = (p) => String(p).replace(/^options\[\d+\]\./, "");

/** Replays batches through `normalize` (default: the current normalizeBatch) and compares with what was recorded. */
export function replayBatches(batches, normalize = normalizeBatch) {
  const r = { batches: batches.length, replayed: 0, unknown: 0, recorded_invalid: 0, now_invalid: 0, fixed: 0, broken: 0, recorded_problems: {}, now_problems: {} };
  const bump = (o, k) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  for (const b of batches) {
    if (typeof b.content !== "string") {
      r.unknown += 1;
      continue;
    }
    r.replayed += 1;
    const wasInvalid = b.recorded === "invalid";
    if (wasInvalid) {
      r.recorded_invalid += 1;
      for (const p of b.recorded_problems ?? []) bump(r.recorded_problems, problemKey(p));
    }
    let raw;
    let res;
    try {
      raw = JSON.parse(b.content);
      res = normalize(raw, { root: b.root ?? null });
    } catch {
      res = { ok: false, problems: ["not JSON"] };
    }
    if (!res.ok) {
      r.now_invalid += 1;
      for (const p of res.problems ?? []) bump(r.now_problems, problemKey(p));
    }
    if (wasInvalid && res.ok) r.fixed += 1;
    if (!wasInvalid && b.recorded !== "unknown" && !res.ok) r.broken += 1;
  }
  return r;
}

function main(argv) {
  const opts = { root: join(homedir(), ".claude", "projects"), transcripts: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") opts.root = argv[++i];
    else if (argv[i] === "--transcript") opts.transcripts.push(argv[++i]);
    else {
      process.stderr.write(`unknown argument: ${argv[i]}\n`);
      return 2;
    }
  }
  const files = opts.transcripts.length ? opts.transcripts : findSessions(opts.root);
  const batches = files.flatMap((f) => extractBatches(parseJsonl(readFileSync(f, "utf8"))));
  process.stdout.write(`${JSON.stringify({ sessions: files.length, ...replayBatches(batches) })}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));

// The Jev step of the usage scan. Rules settle most matches; the rest are
// "ambiguous" (a member name whose receiver type is not visible). For those, one
// jev_classify call judges up to 64 matches at a time against the declared symbol:
//   use     -> moved to the "confirmed" tier, ordered by Jev's probability
//   other   -> dropped (counted)
//   unclear -> stays "ambiguous", ordered by Jev's probability when it has one
// Calls are bounded (maxCalls overall, perGroup matches per symbol, nearest
// folders first) and every excerpt goes through jev-flow's sanitizer (secrets
// redacted, suspicious lines replaced) and its credentials guard. Jev
// is optional: without credentials the rule-based result is kept unchanged.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callWithRetry, openJev } from "../jev-flow/mcp-client.mjs";
import { payloadCredentialKinds, sanitizeText } from "../jev-flow/sanitize.mjs";
import { parseKotlin } from "./kotlin-symbols.mjs";

export const JEV_LIMITS = Object.freeze({
  threshold: 0.8, // strictly above, as in jev-control
  maxCalls: 8,
  perGroup: 64, // jev_classify takes at most 64 items per call
  linesBefore: 3,
  linesAfter: 2,
  itemChars: 1900, // jev_classify truncates an item at 2,000
});

const CLASSES = Object.freeze([
  {
    id: "use",
    description:
      "The line marked >>> refers to exactly the declared symbol described in the context: the receiver, the imports or the surrounding code show that this class and package are meant. A call without a receiver belongs to the enclosing class shown: it is the declared symbol only if that class is, or extends, the class that declares it.",
  },
  {
    id: "other",
    description:
      "The line marked >>> refers to a different thing that only has the same name: a member of another class, a local variable or parameter, a library or framework function. The lines show a different receiver type or a different declaration, or a call without a receiver inside a class that does not extend the declaring class.",
  },
  { id: "manual_review", description: "The lines shown do not reveal which symbol is meant." },
]);

function closeness(a, b) {
  const x = dirname(a).split("/");
  const y = dirname(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

const probabilityOf = (entry, id) => {
  const table = entry.probabilities;
  if (Array.isArray(table)) return table.find((p) => p?.id === id || p?.class === id)?.probability ?? null;
  return typeof table?.[id] === "number" ? table[id] : null;
};

/** Lines and (for Kotlin) the shape of a file, read once per batch. */
async function loadFile(root, rel, files) {
  if (!files.has(rel)) {
    const raw = await readFile(join(root, rel), "utf8");
    files.set(rel, { lines: raw.split("\n"), shape: rel.endsWith(".kt") ? parseKotlin(raw) : null });
  }
  return files.get(rel);
}

/** What the reader needs to know who the receiver is: the innermost class around the line, or the extension function. */
function enclosing(shape, line) {
  if (!shape) return [];
  const inRange = (item) => item.start <= line && line <= item.end;
  const cls = shape.classes.filter(inRange).sort((a, b) => b.start - a.start)[0];
  const fun = shape.extFuns.filter(inRange).sort((a, b) => b.start - a.start)[0];
  return [cls && `enclosing class: ${cls.header}`, fun && `enclosing extension function: ${fun.receiver}.${fun.name}`].filter(Boolean);
}

async function itemFor(root, hit, files, index) {
  const { lines, shape } = await loadFile(root, hit.path, files);
  const pkg = lines.find((line) => /^\s*package\s/.test(line))?.trim() ?? "package: (none)";
  const from = Math.max(0, hit.line - 1 - JEV_LIMITS.linesBefore);
  const to = Math.min(lines.length, hit.line + JEV_LIMITS.linesAfter);
  const body = lines
    .slice(from, to)
    .map((line, i) => `${from + i + 1 === hit.line ? ">>>" : "   "} ${line.trimEnd().slice(0, 200)}`)
    .join("\n");
  const text = sanitizeText([`file: ${hit.path}`, pkg, ...enclosing(shape, hit.line), body].join("\n")).text.slice(0, JEV_LIMITS.itemChars);
  return payloadCredentialKinds({ text }).length > 0 ? null : { id: `h${index}`, text };
}

function symbolContext(group, declLine) {
  const where = group.owner ? `a member of ${group.owner}` : "declared at top level";
  return `Symbol: Kotlin ${group.kind} "${group.name}", ${where}, package ${group.declPkg || "(none)"}, declared in ${group.declPath} as: ${declLine}`;
}

/** Apply the verdicts collected for one group: drop, order, and keep the counts true. */
function finalize(group, dropped) {
  const confirmed = group.hits.confirmed.length;
  const gone = group.hits.ambiguous.filter((hit) => dropped.has(hit)).length;
  group.hits.ambiguous = group.hits.ambiguous.filter((hit) => !dropped.has(hit) && !group.hits.confirmed.includes(hit));
  group.counts.ambiguous -= gone + confirmed;
  group.counts.confirmed = confirmed;
  group.counts.jevOther = gone;
  const byProbability = (a, b) => (b.p ?? -1) - (a.p ?? -1);
  group.hits.confirmed.sort(byProbability);
  group.hits.ambiguous.sort(byProbability);
}

/**
 * Judge the ambiguous hits of `result` (a findUsages() result) with Jev and move
 * them in place. Returns {status, calls, judged, confirmed, other, unclear, reason?};
 * status is ok | unavailable | failed, and a failure keeps what was judged before it.
 */
export async function judgeAmbiguous(result, { env = process.env, threshold = JEV_LIMITS.threshold, maxCalls = JEV_LIMITS.maxCalls, perGroup = JEV_LIMITS.perGroup, open = openJev, call = callWithRetry } = {}) {
  const summary = { status: "ok", calls: 0, judged: 0, confirmed: 0, other: 0, unclear: 0 };
  const groups = result.groups.filter((g) => g.hits.ambiguous.length > 0).sort((a, b) => a.hits.ambiguous.length - b.hits.ambiguous.length);
  if (groups.length === 0) return summary;
  const session = await open(env);
  if (!session.ok) return { ...summary, status: "unavailable", reason: session.reason };
  const declLines = (await readFile(join(result.root, result.file), "utf8")).split("\n");
  try {
    for (const group of groups) {
      if (summary.calls >= maxCalls) break;
      const dropped = new Set();
      try {
        const ranked = [...group.hits.ambiguous].sort((a, b) => closeness(b.path, group.declPath) - closeness(a.path, group.declPath) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
        const chosen = ranked.slice(0, perGroup);
        for (let start = 0; start < chosen.length && summary.calls < maxCalls; start += 64) {
          const files = new Map();
          const items = [];
          const byId = new Map();
          for (const hit of chosen.slice(start, start + 64)) {
            const item = await itemFor(result.root, hit, files, items.length + 1);
            if (!item) continue;
            items.push(item);
            byId.set(item.id, hit);
          }
          if (items.length === 0) continue;
          summary.calls += 1;
          const reply = await call(
            session,
            "jev_classify",
            {
              purpose: "Decide whether a source line uses one specific declared symbol or only another symbol with the same name",
              context: symbolContext(group, (declLines[group.line - 1] ?? "").trim()),
              items,
              classes: CLASSES,
              auto_accept: threshold,
            },
            { invalid: (r) => !Array.isArray(r?.results) || r.results.length !== items.length },
          );
          if (!reply.ok) return { ...summary, status: "failed", reason: `${reply.kind}: ${reply.message}` };
          for (const entry of reply.result.results) {
            const hit = byId.get(entry.id);
            if (!hit) continue;
            summary.judged += 1;
            const top = typeof entry.top_probability === "number" ? entry.top_probability : entry.confidence;
            hit.p = probabilityOf(entry, "use") ?? (entry.classification === "use" ? top : null);
            if (entry.classification === "use" && top > threshold) {
              hit.why = `confirmed by Jev (${top.toFixed(2)})`;
              group.hits.confirmed.push(hit);
              summary.confirmed += 1;
            } else if (entry.classification === "other" && top > threshold) {
              dropped.add(hit);
              summary.other += 1;
            } else summary.unclear += 1;
          }
        }
      } finally {
        finalize(group, dropped);
      }
    }
  } finally {
    await session.close();
  }
  return summary;
}

// Reads a Claude Code session transcript (jsonl) and returns the ACTIVE chain (the path of messages from the root to the last
// message, following parentUuid, so branches abandoned by rewinds are left out) plus the tool calls and their results.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TRANSCRIPT = join(homedir(), ".claude/projects/-Users-apana-StudioProjects-dgapp2-android/7a484193-91fd-4c2d-9333-9d1585869838.jsonl");
export const transcriptPath = () => process.env.TRANSCRIPT ?? DEFAULT_TRANSCRIPT;
export const hasTranscript = () => existsSync(transcriptPath());

const textOf = (content) => {
  if (typeof content === "string") return { chars: content.length, media: 0, text: content };
  let chars = 0;
  let media = 0;
  let text = "";
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") { chars += block.text.length; text += block.text; }
    else if (block.type === "image" || block.type === "document") media += JSON.stringify(block).length;
    else if (block.type === "tool_result") { const inner = textOf(block.content); chars += inner.chars; media += inner.media; text += inner.text; }
    else chars += JSON.stringify(block).length;
  }
  return { chars, media, text };
};

export function loadTranscript(path = transcriptPath()) {
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byUuid = new Map(rows.filter((d) => d.uuid).map((d) => [d.uuid, d]));
  const messages = rows.filter((d) => d.uuid && (d.type === "assistant" || d.type === "user"));
  const chain = [];
  const seen = new Set();
  for (let cur = messages[messages.length - 1]; cur && !seen.has(cur.uuid); cur = byUuid.get(cur.parentUuid)) { seen.add(cur.uuid); chain.push(cur); }
  chain.reverse();
  const toolCalls = (list) => {
    const uses = new Map();
    const out = [];
    for (const d of list) {
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input ?? {}, ts: d.timestamp ?? "" });
        if (b?.type === "tool_result" && uses.has(b.tool_use_id)) { const { chars, media, text } = textOf(b.content); out.push({ ...uses.get(b.tool_use_id), chars, media, text }); }
      }
    }
    return out;
  };
  const all = messages;
  return { rows, chain, active: toolCalls(chain), everything: toolCalls(all), abandoned: all.filter((d) => !seen.has(d.uuid)).length };
}
export const command = (call) => String(call.input.command ?? "");
export const findCall = (calls, predicate) => calls.find(predicate);

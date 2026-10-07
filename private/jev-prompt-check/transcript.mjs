// Last assistant TEXT of a Claude Code transcript (JSONL), read in memory only.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 8 * 1024 * 1024;

function readTail(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let off = 0;
    while (off < buffer.length) {
      const n = readSync(fd, buffer, off, buffer.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buffer.subarray(0, off).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** The text blocks of one transcript entry joined, or "" for tool-only, sidechain or non-assistant entries. */
function entryText(entry) {
  if (!entry || typeof entry !== "object" || entry.isSidechain === true) return "";
  const message = entry.message;
  if (entry.type !== "assistant" && message?.role !== "assistant") return "";
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim() === "" ? "" : content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
    .map((b) => b.text)
    .join("\n");
}

/** Last main-chain assistant message that has text, or null. Several lines of one message (same id) are joined in order. */
export function lastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  let raw;
  try {
    raw = readTail(transcriptPath);
  } catch {
    return null;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial or foreign line.
    }
  }
  let last = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entryText(entries[i]) !== "") {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const id = entries[last].message?.id;
  if (typeof id !== "string" || id === "") return entryText(entries[last]);
  const parts = [];
  for (let i = last; i >= 0; i--) {
    const e = entries[i];
    if (e?.isSidechain === true) continue;
    if (e?.message?.id !== id) {
      // Entries of other messages end the group once we are past the last one's lines.
      if (e?.message?.role === "assistant" || e?.type === "user") break;
      continue;
    }
    const t = entryText(e);
    if (t !== "") parts.unshift(t);
  }
  return parts.join("\n");
}

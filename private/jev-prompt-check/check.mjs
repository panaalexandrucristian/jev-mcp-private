// The two Jev checks of prompt-check: ambiguity and relatedness. Fails silent: every
// problem returns {tips: []} with a fixed reason code, never text of the prompt or reply.
import { openJev } from "../jev-flow/mcp-client.mjs";
import { tipLine } from "./messages.mjs";

export const DEADLINE_MS = 4000;
export const ASSISTANT_CHARS = 1500;
export const PROMPT_CHARS = 1500;
export const MIN_PROMPT_CHARS = 8;

const AMBIGUITY = Object.freeze({
  purpose: "Binary check: would a coding agent that sees only the previous assistant message and this user prompt need to ask a clarifying question?",
  classes: Object.freeze([
    { id: "clear", description: "Every reasonable reading of the prompt, given the previous assistant message, leads to the same action: one target, one scope, one output." },
    {
      id: "needs_clarification",
      description:
        "At least two reasonable readings lead to different actions (different target, different scope, list vs delete, which of two options), or the prompt contains no request at all.",
    },
  ]),
});

const RELATED = Object.freeze({
  classes: Object.freeze([
    {
      id: "related",
      description:
        "The user prompt continues, answers, asks about, or refers to something in the previous assistant message (including short follow-ups like 'what did you do', 'show me the list', 'why only 0.61').",
    },
    {
      id: "unrelated",
      description: "The user prompt starts a different topic or task that does not depend on or refer to what the previous assistant message said.",
    },
  ]),
});

/** The text both checks see: the end of the reply and the start of the prompt. */
export function checkText(assistant, prompt) {
  return `ASSISTANT (previous): ${assistant.slice(-ASSISTANT_CHARS)}\nUSER: ${prompt.slice(0, PROMPT_CHARS)}`;
}

export function ambiguityArgs(text, threshold) {
  return { items: [{ id: "prompt", text }], classes: AMBIGUITY.classes.map((c) => ({ ...c })), purpose: AMBIGUITY.purpose, auto_accept: threshold };
}

export function relatedArgs(text) {
  return { items: [{ id: "prompt", text }], classes: RELATED.classes.map((c) => ({ ...c })) };
}

/**
 * {winner, p} from one jev_classify tool outcome, or null when the envelope is not exactly
 * what was asked: right tool, one result for the item "prompt", no invalid_response, a
 * known winning class and a finite in-range top probability that matches the probabilities.
 */
export function readClassification(outcome, classIds) {
  if (!outcome || outcome.ok !== true) return null;
  const result = outcome.result;
  if (!result || result.tool !== "jev_classify" || result.status === "invalid_response") return null;
  if (Number(result.summary?.invalid_response ?? 0) > 0) return null;
  if (!Array.isArray(result.results) || result.results.length !== 1) return null;
  const item = result.results[0];
  if (!item || item.id !== "prompt" || item.status === "invalid_response") return null;
  if (typeof item.classification !== "string" || !classIds.includes(item.classification)) return null;
  const p = item.top_probability;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  const probabilities = item.probabilities;
  if (!probabilities || typeof probabilities !== "object") return null;
  const values = classIds.map((id) => probabilities[id]);
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) return null;
  if (Math.abs(probabilities[item.classification] - p) > 1e-9) return null;
  if (values.some((v) => v > p + 1e-9)) return null;
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.01) return null;
  return { winner: item.classification, p };
}

/**
 * Run both checks under one wall deadline that covers the connection too.
 * Returns {tips: string[], dispatched: boolean, reason?: string}. The child is
 * killed at the deadline and its shutdown is never awaited.
 */
export async function runChecks({ assistant, prompt, threshold, lang, env = process.env, open = openJev, deadlineMs = DEADLINE_MS, startedAt = Date.now() }) {
  // The deadline runs from `startedAt` (entry to the enabled hook branch), not from this call.
  const started = startedAt;
  const budget = deadlineMs - (Date.now() - started);
  if (budget <= 0) return { tips: [], dispatched: false, reason: "timeout" };
  const text = checkText(assistant, prompt);
  let session = null;
  let expired = false;
  let dispatched = false;
  const stop = () => {
    const client = session?.client;
    if (!client) return;
    try {
      if (typeof client.kill === "function") client.kill();
      else void Promise.resolve(session.close?.()).catch(() => {});
    } catch {
      // Already gone.
    }
  };
  const work = (async () => {
    session = await open(env, { limits: { initTimeoutMs: Math.max(1, deadlineMs - (Date.now() - started)), killGraceMs: 300 } });
    if (expired) {
      stop();
      return { reason: "timeout" };
    }
    if (!session?.ok) return { reason: "unavailable" };
    const remaining = Math.max(1, deadlineMs - (Date.now() - started));
    dispatched = true;
    const [a, b] = await Promise.all([
      session.client.callTool("jev_classify", ambiguityArgs(text, threshold), remaining),
      session.client.callTool("jev_classify", relatedArgs(text), remaining),
    ]);
    return { a, b };
  })().catch(() => ({ reason: "error" }));
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ reason: "timeout" }), budget);
  });
  const outcome = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (outcome.reason === "timeout") expired = true;
  stop();
  if (outcome.reason) return { tips: [], dispatched, reason: outcome.reason };
  const first = readClassification(outcome.a, AMBIGUITY.classes.map((c) => c.id));
  const second = readClassification(outcome.b, RELATED.classes.map((c) => c.id));
  if (!first || !second) return { tips: [], dispatched, reason: "invalid_response" };
  const tips = [];
  if (first.winner === "needs_clarification" && first.p >= threshold) tips.push(tipLine(lang, "ambiguity", first.p));
  if (second.winner === "unrelated" && second.p >= threshold) tips.push(tipLine(lang, "unrelated", second.p));
  return { tips, dispatched };
}

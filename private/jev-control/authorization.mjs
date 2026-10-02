// When are the user's words an AUTHORIZATION, and for how much? Quoting a sentence is not approving it: «Do not increase
// the budget.» contains "increase the budget" and the user said it, but it forbids what it names. The helper uses this to
// refuse an approval whose words are not one, and the transcript audit (measure.mjs) uses it to decide whether a
// recorded approval is bound to something the user really said. Deterministic, offline, English and Romanian; a heuristic
// on purpose: it errs towards "not an authorization", so a doubtful approval is reported, never silently accepted.
import { BUDGET_LIMIT } from "./state.mjs";

/** The most one approval can raise the budget by (budget.mjs caps it too). */
export const MAX_QUANTUM = 100;

const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const wordsSrc = (list) => `(?<![\\p{L}\\p{N}_])(?:${list})(?![\\p{L}\\p{N}_])`;
const words = (list) => new RegExp(wordsSrc(list), "u");

// A negated, refused or forbidden sentence is never an authorization.
const NEGATION = new RegExp(
  `${wordsSrc("not|no|never|none|nothing|nobody|dont|don['’]t|doesnt|doesn['’]t|didnt|didn['’]t|wont|won['’]t|wouldnt|wouldn['’]t|shouldnt|shouldn['’]t|cant|can['’]t|cannot|couldnt|couldn['’]t|without|stop|deny|denied|refuse|refused|reject|rejected|decline|declined|forbid|forbidden|prohibit|prohibited|neither|nor|avoid|nu|nici|nicio|niciun|niciodată|niciodata|nimic|fără|fara|refuz|refuza|refuzat|interzis|interzic|oprește|opreste|stop")}|n['’]t(?![\\p{L}])`,
  "u",
);
// A question or a condition is not a decision yet.
const QUESTION = /\?/;
const OPENS_QUESTION = /^(?:should|can|could|may|might|would|will|shall|do you|does|is it|are you|ar trebui|pot|putem|poți|poti|vrei|ai putea)(?![\p{L}])/u;
const CONDITION = words("if|whether|unless|in case|dacă|daca|în caz că|in caz ca");
// Words that grant something.
const CUE = words(
  "yes|yeah|yep|yup|sure|ok|okay|fine|approve|approved|approves|approval|go ahead|go on|go with|proceed|continue|do it|allow|allowed|permit|permitted|permission|grant|granted|authorize|authorise|authorized|authorised|accept|accepted|choose|pick|select|take|use|increase|raise|extend|da|bine|desigur|aprob|aprobat|aprobă|aprobare|permit|permis|continuă|continua|continuați|procedează|procedeaza|mergi|alege|alegeți|folosește|foloseste|accept|acceptat|autorizez|autorizat|mărește|mareste|ridică|ridica|extinde|fă|fa",
);

/** The sentences of a text (split at line breaks and after . ! ?), normalized (lower case, single spaces). */
export function sentencesOf(text) {
  return String(text ?? "").split(/\n+|(?<=[.!?])\s+/).map(norm).filter(Boolean);
}

/** True when every sentence is neither negated, a question nor conditional, and at least one carries a granting word. */
export function affirmative(sentences) {
  if (sentences.length === 0) return false;
  for (const s of sentences) if (NEGATION.test(s) || QUESTION.test(s) || OPENS_QUESTION.test(s) || CONDITION.test(s)) return false;
  return sentences.some((s) => CUE.test(s));
}

const NUMBER = /(?<![\d.,])(\d{1,6})(?![\d]|[.,]\d)/gu;
const ADJACENT = [
  /(?<![\d.,])(\d{1,6})(?![\d.,]\d)\s*(?:more|extra|additional|further|new|calls?|attempts?|tool calls?|jev calls?|requests?|apeluri|încă|în plus|mai multe)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:by|cu|încă|another|extra|additional|up to|până la)\s+(\d{1,6})(?![\d]|[.,]\d)/gu,
];

/**
 * The most the words authorize: the smallest quantity they state (next to a quantity word such as "more" or "calls" when
 * there is one, otherwise any whole number), at most MAX_QUANTUM; null when they state no quantity (the default budget step then applies).
 */
export function quantumOf(sentences) {
  const text = sentences.join(" ");
  let found = [];
  for (const re of ADJACENT) for (const m of text.matchAll(re)) found.push(Number(m[1]));
  if (found.length === 0) found = [...text.matchAll(NUMBER)].map((m) => Number(m[1]));
  found = found.filter((n) => n >= 1);
  return found.length ? Math.min(Math.min(...found), MAX_QUANTUM) : null;
}

/** What a model-written message says on its own: {authorization: boolean, quantum: number|null}. */
export function readMessage(message) {
  const sentences = sentencesOf(message);
  return { authorization: affirmative(sentences), quantum: quantumOf(sentences) };
}

/** The raise a message authorizes: its quantum, or the default budget step when it states none. */
export const authorizedExtra = (quantum) => quantum ?? BUDGET_LIMIT;

/**
 * Where `message` occurs in the user's `text` as part of an authorization. Each occurrence is judged with the WHOLE
 * sentence(s) it lies in (a fragment of «Do not increase the budget.» is judged as that sentence). Returns
 * {found, occurrences: [{start, quantum}]} with the occurrences that are authorizations; `found` is true when the words
 * occur at all (so a caller can tell "never said" from "said, but not as an authorization").
 */
export function findAuthorizations(text, message) {
  const m = norm(message);
  const sentences = sentencesOf(text);
  const joined = sentences.join(" ");
  const out = { found: false, occurrences: [] };
  if (m.length < 3) return out;
  const spans = [];
  let at = 0;
  for (const s of sentences) {
    spans.push([at, at + s.length]);
    at += s.length + 1;
  }
  for (let from = joined.indexOf(m); from !== -1; from = joined.indexOf(m, from + 1)) {
    out.found = true;
    const to = from + m.length;
    const within = sentences.filter((_, i) => spans[i][0] < to && spans[i][1] > from);
    if (affirmative(within)) out.occurrences.push({ start: from, quantum: quantumOf(within) });
  }
  return out;
}

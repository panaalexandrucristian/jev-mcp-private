// When are the user's words an AUTHORIZATION, of WHAT, and for how much? Quoting a sentence is not approving it: «Do not
// increase the budget.» contains "increase the budget" and the user said it, but it forbids what it names; «Use Node 22.»
// grants something, but not a budget raise or an option; «The documentation says "increase the budget by 100 calls"» is a
// quotation. The helper uses this to refuse an approval whose words are not one, and the transcript audit (measure.mjs) uses
// it to decide whether a recorded approval is bound to something the user really said. Deterministic, offline, English and
// Romanian; a heuristic on purpose: it errs towards "not an authorization", so a doubtful approval is reported, never silently
// accepted. An authorization has a SCOPE: the budget (words about the budget, the limit or calls) or one option (words that
// name it); a short answer («yes») counts only together with the concrete question it answers.
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
// A quotation or a report of what a text says is not the user deciding.
const QUOTED = /["“”„«»`]/;
const REPORTED = words("says|said|states|stated|wrote|writes|written|reads|according to|documentation|documented|docs|readme|manual|quote|quoted|quoting|citat|citează|citeaza|spune|scrie|scris|conform|documentația|documentatia");
// Words that grant something.
const CUE = words(
  "yes|yeah|yep|yup|sure|ok|okay|fine|approve|approved|approves|approval|go ahead|go on|go with|proceed|continue|do it|allow|allowed|permit|permitted|permission|grant|granted|authorize|authorise|authorized|authorised|accept|accepted|choose|pick|select|take|use|increase|raise|extend|da|bine|desigur|aprob|aprobat|aprobă|aprobare|permit|permis|continuă|continua|continuați|procedează|procedeaza|mergi|alege|alegeți|folosește|foloseste|accept|acceptat|autorizez|autorizat|mărește|mareste|ridică|ridica|extinde|fă|fa",
);
// A grant is aimed at a TARGET: the budget raise or the option, never merely mentioned next to a granting word. A budget
// grant is a verb that changes or spends the budget followed closely by what it changes («increase the budget», «approve
// 10 more calls», «continue past the limit»); «Use Jev.» or «Use Node 22 for the calls.» mention a word but grant nothing.
const BUDGET_NOUN = new Set(["budget", "limit", "limits", "call", "calls", "attempt", "attempts", "buget", "bugetul", "bugetului", "limită", "limita", "limitei", "apel", "apelul", "apeluri", "apelurile", "apelurilor", "încercări", "incercari"]);
const BUDGET_VERB = new Set(["increase", "raise", "extend", "bump", "expand", "grow", "allow", "approve", "grant", "authorize", "authorise", "permit", "add", "spend", "continue", "proceed", "give", "mărește", "mareste", "ridică", "ridica", "extinde", "aprob", "aprobă", "permit", "autorizez", "adaugă", "adauga", "continuă", "continua", "procedează", "procedeaza", "mergi", "cheltui"]);
// An option grant: a granting word closely before the option, with nothing that excludes the option in between.
const OPTION_GRANT = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "fine", "approve", "approved", "approves", "choose", "pick", "select", "take", "use", "go", "proceed", "continue", "allow", "allowed", "accept", "accepted", "authorize", "authorise", "authorized", "authorised", "permit", "permitted", "grant", "granted", "do", "run", "apply", "da", "bine", "desigur", "aprob", "aprobat", "aprobă", "alege", "alegeți", "folosește", "foloseste", "acceptat", "autorizez", "autorizat", "mergi", "continuă", "continua", "procedează", "procedeaza", "fă", "fa"]);
// Words that put an option aside: «approve o1 instead of o2» does not approve o2.
const EXCLUDES = words("instead of|rather than|in place of|other than|over|versus|vs|except|apart from|besides|but not|not|nor|in loc de|în loc de|decât|decat|exceptând|exceptand|în afară de|in afara de");
const TOKEN = /(?<![\p{L}\p{N}])[-−]\d+(?:[.,]\d+)*|[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu;
const tokensOf = (text) => norm(text).match(TOKEN) ?? [];

/** The scope of an authorization: the call budget, or one option of a decision. */
export const BUDGET_SCOPE = Object.freeze({ kind: "budget" });
export const optionScope = (id) => Object.freeze({ kind: "option", id: String(id ?? "") });

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is a grant aimed at the budget: a budget verb at most four words before a budget noun, or «N more calls»? */
function budgetTargeted(text) {
  const t = tokensOf(text);
  const isVerb = (i) => BUDGET_VERB.has(t[i]) || (t[i] === "go" && (t[i + 1] === "ahead" || t[i + 1] === "on"));
  for (let j = 0; j < t.length; j++) {
    if (!BUDGET_NOUN.has(t[j])) continue;
    for (let i = Math.max(0, j - 4); i < j; i++) if (isVerb(i)) return true;
    if (j >= 2 && INCREMENT_AFTER.has(t[j - 1]) && numberOf(t[j - 2]) !== undefined) return true;
  }
  return false;
}

/**
 * Is a grant aimed at this option: its id (parts separated by spaces, _ or -; an id of one or two letters, which is also a
 * word, only as «option a») with a granting word at most four words before it, nothing that excludes it in between or right
 * before it (a longer id such as «edit_a_long» is another option)? `grantFromQuestion`: the answer is a bare label of an
 * approval question, so the granting word is the question's.
 */
function optionTargeted(text, id, grantFromQuestion) {
  const phrase = norm(String(id).replace(/[_-]+/g, " "));
  if (!phrase) return false;
  const t = norm(text);
  const body = escape(phrase).replace(/ /g, "[\\s_-]+");
  const edge = "[\\p{L}\\p{N}_-]";
  const bare = `(?<!${edge})${body}(?!${edge})`;
  const tagged = `(?<!${edge})(?:option|opțiunea|optiunea|opțiune|optiune|variant|varianta|choice|alternative|alternativa)\\s+${body}(?!${edge})`;
  const re = new RegExp(/^[a-z]{1,2}$/.test(phrase) ? tagged : bare, "gu");
  for (const m of t.matchAll(re)) {
    const before = tokensOf(t.slice(0, m.index)).slice(-5);
    let g = -1;
    for (let k = before.length - 1; k >= 0; k--) if (OPTION_GRANT.has(before[k])) { g = k; break; }
    const gap = g === -1 ? before.slice(-3) : before.slice(g + 1);
    // Excluded («instead of o2»), or behind another identifier («approve o1 and o2», «approve o1, o2 stays out»): a list is
    // not interpreted, the grant belongs to the first option named and each other option needs its own words.
    if (EXCLUDES.test(gap.join(" ")) || gap.some((w) => /[\d_-]/.test(w))) continue;
    if (g !== -1 || grantFromQuestion) return true;
  }
  return false;
}
const concerns = (text, scope, grantFromQuestion = false) => (scope.kind === "option" ? optionTargeted(text, scope.id, grantFromQuestion) : budgetTargeted(text));

/** The sentences of a text (split at line breaks and after . ! ?), normalized (lower case, single spaces). */
export function sentencesOf(text) {
  return String(text ?? "").split(/\n+|(?<=[.!?])\s+/).map(norm).filter(Boolean);
}

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  zece: 10, cinci: 5, doi: 2, două: 2, trei: 3, patru: 4, șase: 6, șapte: 7, opt: 8, nouă: 9, douăzeci: 20, treizeci: 30, cincizeci: 50, sută: 100,
};
/** The value of a number token: an integer (0 included), NaN for a decimal, a negative or a grouped number, undefined for a word that is no number. */
const numberOf = (tok) => (/^[-−]?\d+(?:[.,]\d+)*$/.test(tok) ? (/^\d+$/.test(tok) ? Number(tok) : NaN) : NUMBER_WORDS[tok]);
const INCREMENT_BEFORE = new Set(["by", "cu", "another", "extra", "additional", "încă", "inca"]);
const INCREMENT_AFTER = new Set(["more", "extra", "additional", "further", "plus", "suplimentare", "suplimentar"]);
const TOTAL_NOUN = new Set(["total", "limit", "budget", "buget", "bugetul", "limită", "limita"]);

/**
 * What quantity the words state, as {kind, n?}: "increment" (by N, N more, another N), "total" (to N, a limit of N, N in
 * total), "none" (no number at all: only then the default budget step applies), "ambiguous" (a number that is neither:
 * «30 calls», «up to 30», «request 3», or an increment and a total that disagree) or "invalid" (an explicit quantity that
 * is fractional, negative or grouped: «by 0.5 calls», «by -5»). A quantity that is stated never disappears into "none";
 * zero is a quantity (an increment of 0). When several numbers agree on a kind the smallest wins.
 */
export function quantityOf(sentences) {
  const tokens = tokensOf(Array.isArray(sentences) ? sentences.join(" ") : String(sentences));
  const kinds = [];
  tokens.forEach((tok, i) => {
    const n = numberOf(tok);
    if (n === undefined) return; // not a number
    if (Number.isNaN(n)) return kinds.push({ kind: "invalid" });
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    const ahead = tokens.slice(i + 1, i + 4);
    const increment = INCREMENT_BEFORE.has(prev) || ahead.some((w) => INCREMENT_AFTER.has(w));
    const total =
      (prev === "to" && prev2 !== "up") ||
      ((prev === "of" || prev === "de") && TOTAL_NOUN.has(prev2)) ||
      ((prev === "is" || prev === "at") && TOTAL_NOUN.has(prev2)) ||
      ahead.includes("total");
    kinds.push(increment && !total ? { kind: "increment", n } : total && !increment ? { kind: "total", n } : { kind: "ambiguous" });
  });
  if (kinds.length === 0) return { kind: "none" };
  if (kinds.some((k) => k.kind === "invalid")) return { kind: "invalid" };
  const kind = kinds[0].kind;
  if (kinds.some((k) => k.kind !== kind) || kind === "ambiguous") return { kind: "ambiguous" };
  return { kind, n: Math.min(...kinds.map((k) => k.n)) };
}

/**
 * How many calls the quantity authorizes on top of the current limit: {ok: true, allowed} (never above MAX_QUANTUM) or
 * {ok: false, reason: quantum_ambiguous | quantum_invalid | quantum_zero | limit_not_raised}. A total is measured against
 * the limit now in force; a total already reached authorizes nothing, nor does a stated zero; an ambiguous or invalid
 * quantity is never guessed. Only words that state no quantity at all get the default step.
 */
export function incrementFor(quantity, limit) {
  if (quantity.kind === "ambiguous") return { ok: false, reason: "quantum_ambiguous" };
  if (quantity.kind === "invalid") return { ok: false, reason: "quantum_invalid" };
  if (quantity.kind === "increment" && quantity.n < 1) return { ok: false, reason: "quantum_zero" };
  const n = quantity.kind === "increment" ? quantity.n : quantity.kind === "total" ? quantity.n - limit : BUDGET_LIMIT;
  if (!(n >= 1)) return { ok: false, reason: "limit_not_raised" };
  return { ok: true, allowed: Math.min(n, MAX_QUANTUM) };
}

const refuses = (s) => NEGATION.test(s) || QUESTION.test(s) || OPENS_QUESTION.test(s) || CONDITION.test(s) || QUOTED.test(s) || REPORTED.test(s);

/** True when no sentence is negated, a question, conditional, quoted or reported, and at least one carries a granting word. */
export function affirmative(sentences) {
  if (sentences.length === 0) return false;
  for (const s of sentences) if (refuses(s)) return false;
  return sentences.some((s) => CUE.test(s));
}

/**
 * Do these sentences authorize `scope`? {ok: true, quantity} or {ok: false, reason: not_affirmative | no_grant | object_missing}.
 * The sentence(s) must be affirmative AND concern the scope (the budget, or the option named); a short answer is linked to
 * the `question` it answers: the question may supply the object (and the quantity), but never rescues a negated answer,
 * and a negated or conditional question is no authorization either. Without the link, «yes» authorizes nothing.
 */
export function judge(sentences, scope, question = null) {
  if (sentences.length === 0) return { ok: false, reason: "no_grant" };
  for (const s of sentences) if (refuses(s)) return { ok: false, reason: "not_affirmative" };
  const q = question ? norm(question) : "";
  if (q && (NEGATION.test(q) || CONDITION.test(q))) return { ok: false, reason: "not_affirmative" };
  const own = sentences.join(" ");
  const questionGrants = q !== "" && CUE.test(q);
  const ownConcerns = concerns(own, scope, questionGrants);
  const grants = sentences.some((s) => CUE.test(s)) || (questionGrants && ownConcerns);
  if (!grants) return { ok: false, reason: "no_grant" };
  if (!ownConcerns && !(q !== "" && concerns(q, scope))) return { ok: false, reason: "object_missing" };
  let quantity = { kind: "none" };
  if (scope.kind === "budget") {
    quantity = quantityOf(sentences);
    if (quantity.kind === "none" && q) quantity = quantityOf([q]);
  }
  return { ok: true, quantity };
}

/** What a model-written message says on its own: {authorization, reason?, quantity}. */
export function readMessage(message, scope = BUDGET_SCOPE, question = null) {
  const r = judge(sentencesOf(message), scope, question);
  return { authorization: r.ok, ...(r.ok ? { quantity: r.quantity } : { reason: r.reason, quantity: { kind: "none" } }) };
}

/** Does `msg` repeat the authorization `prev` (same question, one's words inside the other's)? Used once per request. */
export function sameAuthorization(msg, question, prev, prevQuestion) {
  const strip = (s) => norm(s).replace(/[\s.!?,;:]+$/g, "");
  const a = strip(msg);
  const b = strip(prev);
  if (!a || !b) return false;
  if (norm(question ?? "") !== norm(prevQuestion ?? "")) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Where `message` occurs in the user's `text` as an authorization of `scope`. Each occurrence is judged with the WHOLE
 * sentence(s) it lies in (a fragment of «Do not increase the budget.» is judged as that sentence), with the `question` it
 * answers when the text is an answer. Returns {found, occurrences: [{sentences: [index..], quantity}]} with the
 * occurrences that are authorizations; `found` is true when the words occur at all (so a caller can tell "never said" from
 * "said, but not as an authorization"). The identity of an authorization is the SOURCE text and its sentence indexes, never
 * where the quoted fragment starts: quoting another part of the same sentence is the same authorization.
 */
export function findAuthorizations(text, message, scope = BUDGET_SCOPE, question = null) {
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
    const idx = sentences.map((_, i) => i).filter((i) => spans[i][0] < to && spans[i][1] > from);
    const r = judge(idx.map((i) => sentences[i]), scope, question);
    if (r.ok) out.occurrences.push({ sentences: idx, quantity: r.quantity });
  }
  return out;
}

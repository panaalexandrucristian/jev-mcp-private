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
  `${wordsSrc("not|no|never|none|nothing|nobody|dont|don['’]t|doesnt|doesn['’]t|didnt|didn['’]t|wont|won['’]t|wouldnt|wouldn['’]t|shouldnt|shouldn['’]t|cant|can['’]t|cannot|couldnt|couldn['’]t|without|stop|deny|denied|refuse|refused|reject|rejected|decline|declined|forbid|forbidden|prohibit|prohibited|neither|nor|nope|nah|nicidecum|deloc|avoid|nu|nici|nicio|niciun|niciodată|niciodata|nimic|fără|fara|refuz|refuza|refuzat|interzis|interzic|oprește|opreste|stop")}|n['’]t(?![\\p{L}])`,
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
// BUDGET_NOUN / BUDGET_VERB / OPTION_GRANT are the vocabulary of the approvals recognized below (budgetApproval, optionApproval):
// «Use Jev.» or «Use Node 22 for the calls.» mention a word but grant nothing.
const BUDGET_NOUN = new Set(["budget", "limit", "limits", "call", "calls", "attempt", "attempts", "buget", "bugetul", "bugetului", "limită", "limita", "limitei", "apel", "apelul", "apeluri", "apelurile", "apelurilor", "încercări", "incercari"]);
const BUDGET_VERB = new Set(["increase", "raise", "extend", "bump", "expand", "grow", "allow", "approve", "grant", "authorize", "authorise", "permit", "add", "spend", "continue", "proceed", "give", "mărește", "mareste", "ridică", "ridica", "extinde", "aprob", "aprobă", "permit", "autorizez", "adaugă", "adauga", "continuă", "continua", "procedează", "procedeaza", "mergi", "cheltui"]);
// The granting words of an option approval.
const OPTION_GRANT = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "fine", "approve", "approved", "approves", "choose", "pick", "select", "take", "use", "go", "proceed", "continue", "allow", "allowed", "accept", "accepted", "authorize", "authorise", "authorized", "authorised", "permit", "permitted", "grant", "granted", "do", "run", "apply", "da", "bine", "desigur", "aprob", "aprobat", "aprobă", "alege", "alegeți", "folosește", "foloseste", "acceptat", "autorizez", "autorizat", "mergi", "continuă", "continua", "procedează", "procedeaza", "fă", "fa"]);
// Words that put an option aside: «approve o1 instead of o2» does not approve o2.
const EXCLUDES = words("instead of|rather than|in place of|other than|over|versus|vs|except|apart from|besides|but not|not|nor|in loc de|în loc de|decât|decat|exceptând|exceptand|în afară de|in afara de");
const TOKEN = /(?<![\p{L}\p{N}])[-−]\d+(?:[.,]\d+)*|[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu;
const tokensOf = (text) => norm(text).match(TOKEN) ?? [];

/** The scope of an authorization: the call budget, or one option of a decision. */
export const BUDGET_SCOPE = Object.freeze({ kind: "budget" });
export const optionScope = (id) => Object.freeze({ kind: "option", id: String(id ?? "") });

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A complete approval is recognized by its WHOLE shape, never by a granting word and a target that merely occur near each other:
// every word of the sentence must be a granting verb, the object it grants, or a plain filler; a word that says what the
// approval is FOR («tests», «testing», «discussing», «Node», «o2») makes the sentence unrecognized, and an unrecognized
// sentence authorizes nothing. «Approve testing o2.» approves testing, not running o2; «Approve tests for calls.» raises nothing.
const LEAD = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "fine", "please", "pls", "i", "we", "you", "can", "may", "could", "should", "shall", "would", "like", "to", "want", "let", "lets", "us", "me", "and", "then", "also", "just", "now", "go", "ahead", "on", "da", "bine", "desigur", "te", "rog", "hai", "vrei", "să", "sa", "putem", "pot", "poți", "poti", "ar", "trebui", "și", "si", "apoi", "acum"]);
const BUDGET_FILLER = new Set(["current", "existing", "remaining", "present", "curent", "actual", "actualul", "rămas", "ramas", "rămase", "ramase", "the", "a", "an", "this", "that", "your", "my", "our", "its", "it", "current", "new", "more", "extra", "additional", "another", "further", "higher", "bigger", "larger", "total", "in", "by", "to", "of", "with", "for", "up", "past", "beyond", "above", "over", "increase", "extension", "number", "amount", "please", "now", "then", "too", "de", "cu", "la", "pe", "peste", "încă", "inca", "suplimentare", "suplimentar", "un", "o", "mai", "multe", "câteva", "cateva", "te", "rog", "și", "si", "and"]);
const OPTION_VERB = OPTION_GRANT;
const OPTION_FILLER = new Set(["the", "a", "an", "option", "variant", "choice", "alternative", "opțiunea", "optiunea", "opțiune", "optiune", "varianta", "alternativa", "with", "on", "ahead", "it", "to", "for", "now", "please"]);
const OPTION_TAG = new Set(["option", "variant", "choice", "alternative", "opțiunea", "optiunea", "opțiune", "optiune", "varianta", "alternativa"]);
const OPTION_TAIL = new Set(["please", "now", "then", "too", "thanks", "thank", "you", "te", "rog", "mulțumesc", "multumesc"]);
// A bare answer that names no target: its object can only come from the question it answers.
const BARE_AFFIRMATION = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "fine", "please", "pls", "approve", "approved", "accept", "accepted", "agreed", "agree", "confirm", "confirmed", "proceed", "continue", "go", "ahead", "do", "it", "that", "this", "is", "sounds", "good", "great", "right", "correct", "i", "we", "you", "and", "thanks", "thank", "allow", "allowed", "da", "bine", "desigur", "aprob", "aprobat", "continuă", "continua", "procedează", "procedeaza", "mergi", "te", "rog", "hai", "fă", "fa"]);
const isBareAffirmation = (s) => {
  const t = tokensOf(s);
  return t.length > 0 && t.every((w) => BARE_AFFIRMATION.has(w)) && t.some((w) => CUE.test(w));
};

// What makes an approval one of RAISING (or going beyond) the budget, as opposed to using the budget already granted: a verb
// that raises it, a word that adds to or goes beyond it, or a stated number. «Continue with the current budget.» and «Spend the
// current budget.» approve what is already allowed and raise nothing (the default step applies only to a real raise).
const RAISE_WORD = new Set(["increase", "raise", "extend", "bump", "expand", "grow", "add", "give", "more", "extra", "additional", "another", "further", "higher", "bigger", "larger", "beyond", "past", "above", "over", "extension", "mărește", "mareste", "ridică", "ridica", "extinde", "adaugă", "adauga", "peste", "încă", "inca", "suplimentare", "suplimentar", "mai", "multe"]);
const EXISTING_WORD = new Set(["current", "existing", "remaining", "present", "curent", "actual", "actualul", "rămas", "ramas", "rămase", "ramase"]);

/** Is this sentence a complete approval of RAISING the call budget: lead words, a budget verb, then only the budget, a quantity and fillers, and a raise? */
function budgetApproval(text) {
  const t = tokensOf(text);
  let v = t.findIndex((w) => BUDGET_VERB.has(w));
  if (v === -1) v = t.findIndex((w, i) => t[i - 1] === "go" && (w === "ahead" || w === "on")); // «go on beyond the limit»
  if (v === -1 || !t.slice(0, v).every((w) => LEAD.has(w))) return false;
  const rest = t.slice(v + 1);
  if (!(rest.some((w) => BUDGET_NOUN.has(w)) && rest.every((w) => BUDGET_NOUN.has(w) || BUDGET_VERB.has(w) || BUDGET_FILLER.has(w) || numberOf(w) !== undefined))) return false;
  return t.some((w) => RAISE_WORD.has(w)) || (!t.some((w) => EXISTING_WORD.has(w)) && t.some((w) => numberOf(w) !== undefined));
}

const idTokens = (id) => tokensOf(String(id).replace(/[_-]+/g, " "));
const isShortId = (id) => /^[a-z]{1,2}$/.test(norm(id));
/** Positions of the id's words in `t`; an id of one or two letters, which is also a word, only after «option». */
function idPositions(t, id) {
  const idt = idTokens(id);
  const out = [];
  if (idt.length === 0) return out;
  for (let p = 0; p + idt.length <= t.length; p++) {
    if (!idt.every((w, k) => t[p + k] === w)) continue;
    if (isShortId(id) && !OPTION_TAG.has(t[p - 1])) continue;
    out.push({ p, n: idt.length });
  }
  return out;
}
/** The words of a sentence that say what is approved: what comes before an exclusion («over o2», «instead of o2», «except o2») is the choice. */
function chosenPart(text) {
  let s = norm(text).replace(/[\s.!?]+$/g, "");
  const ex = EXCLUDES.exec(s);
  if (!ex) return s;
  if (ex.index > 0) return s.slice(0, ex.index);
  const cut = s.search(/[,;]/); // «Instead of o2, approve o1.»: the exclusion clause ends at the comma
  return cut === -1 ? "" : chosenPart(s.slice(cut + 1));
}
/**
 * Is this sentence a complete approval of THIS option: lead words, a granting verb (none for the bare label of an approval
 * question, `label`), fillers, the id and at most politeness after it. Another option, a list («o1 and o2», «o1, o2») or
 * any word that says what the approval is for («testing o2») makes it unrecognized; an exclusion clause («instead of o2»)
 * is cut off first, so «Approve o1 instead of o2.» approves o1 and nothing else.
 */
function optionApproval(text, id, label = false) {
  const t = tokensOf(chosenPart(text));
  for (const { p, n } of idPositions(t, id)) {
    const before = t.slice(0, p);
    const after = t.slice(p + n);
    if (!before.every((w) => LEAD.has(w) || OPTION_VERB.has(w) || OPTION_FILLER.has(w))) continue;
    if (!after.every((w) => OPTION_TAIL.has(w))) continue;
    if (label ? before.every((w) => OPTION_FILLER.has(w) && w !== "it") : before.some((w) => OPTION_VERB.has(w))) return true;
  }
  return false;
}
const approvesScope = (text, scope) => (scope.kind === "option" ? optionApproval(text, scope.id) : budgetApproval(text));

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
 * Do these sentences authorize `scope`? {ok: true, quantity} or {ok: false, reason: not_affirmative | no_grant | object_missing | context_conflict}.
 * The sentence(s) must be affirmative AND be a complete approval of the scope (the budget raise, or running the option
 * named: see budgetApproval / optionApproval). A short answer is linked to the `question` it answers, but the question only
 * completes an answer that names nothing: a bare «yes» is an approval of the question's operation when the question has ONE
 * demonstrable target (a single sentence that is itself a complete approval of the scope); an answer that selects an option
 * («Use o1», «o1») concerns that option and no other, however many alternatives the question offers; a «yes» to a question
 * with alternatives authorizes none of them. A negated or conditional question is no authorization either. Without the link,
 * «yes» authorizes nothing.
 */
export function judge(sentences, scope, question = null) {
  if (sentences.length === 0) return { ok: false, reason: "no_grant" };
  for (const s of sentences) if (refuses(s)) return { ok: false, reason: "not_affirmative" };
  const q = question ? norm(question) : "";
  if (q && (NEGATION.test(q) || CONDITION.test(q))) return { ok: false, reason: "not_affirmative" };
  const qSentences = q ? sentencesOf(q) : [];
  const own = sentences.some((s) => approvesScope(s, scope));
  const asLabel = !own && scope.kind === "option" && qSentences.some((s) => CUE.test(s)) && sentences.some((s) => optionApproval(s, scope.id, true));
  const bare = !own && !asLabel && qSentences.length === 1 && sentences.every(isBareAffirmation) && approvesScope(qSentences[0], scope);
  if (!own && !asLabel && !bare) {
    const cues = (s) => CUE.test(s) || tokensOf(s).some((w) => BUDGET_VERB.has(w));
    const cue = sentences.some(cues) || qSentences.some(cues);
    return { ok: false, reason: cue ? "object_missing" : "no_grant" };
  }
  let quantity = { kind: "none" };
  if (scope.kind === "budget") {
    quantity = quantityOf(sentences);
    if (quantity.kind === "none" && bare) quantity = quantityOf(qSentences);
  }
  // The sentences that ARE the approval; every other sentence of the message, quoted or not, is context (a retraction does not
  // become harmless by being included in the quotation).
  const approval = sentences.map((_, i) => i).filter((i) => (own ? approvesScope(sentences[i], scope) : asLabel ? optionApproval(sentences[i], scope.id, true) : true));
  if (!contextAllows(sentences, approval, scope, quantity)) return { ok: false, reason: "context_conflict" };
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

// A later sentence of the same message that takes an approval back or narrows it. Not the only protection (see contextAllows:
// a short non-polite sentence also voids), only the explicit expressions: «Actually no, keep the limit.», «I changed my mind.»
const RETRACT = new RegExp(
  `(?:^|[;:]\\s*)(?:and |ok |okay |well |so )?${wordsSrc("actually|wait|however|but|sorry|correction|oops|hold on|hold off|on second thought|de fapt|stai|totuși|totusi|dar|ps")}|${wordsSrc("only|doar|exclusiv|cancel|cancelled|canceled|retract|retracted|revoke|revoked|undo|revert|rollback|scratch|scratch that|never mind|nevermind|forget|forget it|skip|ignore|disregard|changed my mind|change my mind|changing my mind|second thoughts|ignoră|ignora|anulez|anulează|anuleaza|retrag|uită|uita|lasă|lasa|răzgândit|razgandit|răzgândesc|razgandesc|nope|nah|nicidecum|deloc")}`,
  "u",
);
// Pure politeness or a closing: the only sentences that may follow an approval and leave it standing (an empty sentence too).
const POLITE = new Set(["thanks", "thank", "thx", "you", "a", "lot", "mersi", "mulțumesc", "multumesc", "please", "pls", "ok", "okay", "great", "perfect", "cheers", "yes", "yeah", "sure", "da", "te", "rog", "awesome", "good", "nice"]);
const isPolite = (s) => tokensOf(s).every((w) => POLITE.has(w));
const mentions = (s, scope) => (scope.kind === "option" ? idPositions(tokensOf(s), scope.id).length > 0 : tokensOf(s).some((w) => BUDGET_NOUN.has(w) || numberOf(w) !== undefined));
/** The quantity as it would be spent: no number at all is the default step. */
const effectiveQuantity = (q) => (q.kind === "none" ? { kind: "increment", n: BUDGET_LIMIT } : q);
const sameQuantity = (a, b) => (a.kind === "increment" || a.kind === "total") && a.kind === b.kind && a.n === b.n;
/**
 * May the approval found in the sentences `approval` (indexes) stand in the context of the WHOLE message? Every other
 * sentence is read, whether the quotation included it or not:
 *  - one that talks about the scope (the budget, a number, the option) must itself be a complete approval of it, with the same
 *    quantity («Increase the budget to 30 calls. Increase the budget to 27 calls.» contradict each other; «The maximum total
 *    budget is 30 calls.» before an approval is a ceiling nobody read: neither stands). Order is no revocation: a restriction
 *    before the approval is not overridden by it, nor is an approval after a restriction;
 *  - a LATER one (after the last approval sentence) that is not one of those must be plain politeness or a closing from a
 *    closed set (thanks, please, ok, great, mersi, …) or empty, and must not be refused or retract: anything else, short or
 *    long, voids the approval («Skip that.», «I changed my mind.», «Please refrain from doing that, it is too expensive.»,
 *    «Then fix the parser afterwards.»). The approval is the last substantial sentence, or the user is asked again.
 * What cannot be read safely voids: the user is asked again.
 */
function contextAllows(sentences, approval, scope, quantity) {
  const last = Math.max(...approval);
  const mine = effectiveQuantity(quantity);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (approval.includes(i)) {
      // Two approval sentences must state the same quantity; an ambiguous or invalid one is refused later, with its own reason.
      if (scope.kind === "budget" && approvesScope(s, scope) && (mine.kind === "increment" || mine.kind === "total") && !sameQuantity(mine, effectiveQuantity(quantityOf([s])))) return false;
    } else if (mentions(s, scope)) {
      if (refuses(s) || !approvesScope(s, scope)) return false;
      if (scope.kind === "budget" && !sameQuantity(mine, effectiveQuantity(quantityOf([s])))) return false;
    } else if (i > last && (refuses(s) || RETRACT.test(s) || !isPolite(s))) return false;
  }
  return true;
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
    if (!r.ok) continue;
    // Which sentences of the quotation are the approval: the others (a retraction quoted along with it) are context like the rest of the source message.
    const own = idx.filter((i) => approvesScope(sentences[i], scope));
    const label = scope.kind === "option" && own.length === 0 ? idx.filter((i) => optionApproval(sentences[i], scope.id, true)) : [];
    const approval = own.length ? own : label.length ? label : idx;
    // The fragment is judged in the context of the WHOLE source message, as readMessage judges what the model wrote: a restriction or a contradiction, before or after, and anything but politeness after the approval void the grant.
    if (contextAllows(sentences, approval, scope, r.quantity)) out.occurrences.push({ sentences: idx, quantity: r.quantity });
  }
  return out;
}

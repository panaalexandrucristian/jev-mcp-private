// Local language detection for the tip lines: Romanian or English, no Jev call, no I/O.
// Diacritics are stripped before matching, so text written without them (common in Romanian)
// hits the same word lists. Returns null when there is no clear signal.
const RO_LETTERS = /[\u0103\u00ee\u0219\u021b\u015f\u0163]/g; // ă î ș ț and the cedilla forms ş ţ

// Distinctive function words; words that are also English once stripped (a, o, in, am, de) are left out.
const RO_WORDS = new Set(
  ("si sa nu da ce cum care este sunt fost fie pentru dar sau cu din pe mai la un una unei unui unor eu tu el ea noi voi ei ele " +
    "vreau vrei vrea poti putem trebuie faci fa fac ruleaza citeste arata spune scrie vezi uita verifica adauga sterge " +
    "acest aceasta acesta acel aceea aici acolo acum deja inca doar tot toate toti nici daca deci pentru fara dupa inainte " +
    "ma mi ti te se ne va le lui lor meu mea tau ta nostru").split(/\s+/),
);
const EN_WORDS = new Set(
  ("the and is was were be been to of it its that this these those you your for with not what how why when where which who can could " +
    "would should will do does did my we our me he she they them his her their have has had on at but or if so from by " +
    "please just also then than there here now only all any some yes make run show tell write read check add delete use want need like get").split(/\s+/),
);

/** Lower-cased ascii-ish words of the text: NFD, combining marks removed. */
function words(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z]+/g) ?? [];
}

/** The values of the `lang` setting: auto picks Romanian or English per prompt. */
export const LANG_SETTINGS = Object.freeze(["auto", "ro", "en"]);

/** "ro", "en" or null (no letters, a tie, or no known words). */
export function detectLanguage(text) {
  if (typeof text !== "string" || text === "") return null;
  let ro = (text.normalize("NFC").toLowerCase().match(RO_LETTERS) ?? []).length * 3;
  let en = 0;
  for (const w of words(text)) {
    if (RO_WORDS.has(w)) ro += 1;
    if (EN_WORDS.has(w)) en += 1;
  }
  if (ro === en) return null;
  return ro > en ? "ro" : "en";
}

/**
 * The language of the tip lines. A forced setting (ro | en) wins; with "auto" the prompt decides,
 * then the previous assistant text, then English.
 */
export function chooseLanguage(setting, prompt, assistant) {
  if (setting === "ro" || setting === "en") return setting;
  return detectLanguage(prompt) ?? detectLanguage(assistant) ?? "en";
}

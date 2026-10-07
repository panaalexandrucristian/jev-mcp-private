// Fixed tip templates, keyed by language. No model-written text ever reaches the user.
export const LANGS = Object.freeze(["en", "ro"]);

export const TEMPLATES = Object.freeze({
  en: Object.freeze({
    ambiguity: "prompt-check: this prompt may be unclear (Jev {p}% sure): a target or scope may be missing.",
    unrelated: "prompt-check: this prompt does not look related to the last reply (Jev {p}% sure); if it is a new topic, consider /clear.",
  }),
  ro: Object.freeze({
    ambiguity: "prompt-check: acest prompt ar putea fi neclar (Jev este sigur în proporție de {p}%): poate lipsește o țintă sau un domeniu.",
    unrelated: "prompt-check: acest prompt nu pare legat de ultimul răspuns (Jev este sigur în proporție de {p}%); dacă este un subiect nou, ia în calcul /clear.",
  }),
});

export function percent(probability) {
  return Math.round(probability * 100);
}

/** One tip line; `kind` is ambiguity | unrelated. Unknown languages fall back to English. */
export function tipLine(lang, kind, probability) {
  const table = TEMPLATES[lang] ?? TEMPLATES.en;
  return table[kind].replace("{p}", String(percent(probability)));
}

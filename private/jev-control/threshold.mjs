// jev-control confidence threshold: parsing, precedence and the strict
// comparison. D5/D19: default 0.95, a session value (command argument) wins over
// JEV_CONTROL_THRESHOLD, valid only in (0.5, 1), an invalid value falls back to
// the default with one notice. The comparison is always strict `>` on the raw
// probability; a tool's own label (likely, auto, action), which means `>=`, is
// never the criterion.
export const DEFAULT_THRESHOLD = 0.95;
export const THRESHOLD_ENV = "JEV_CONTROL_THRESHOLD";
export const THRESHOLD_MIN_EXCLUSIVE = 0.5;
export const THRESHOLD_MAX_EXCLUSIVE = 1;
/** Scores that differ by less than this are near-equal and need a tie-break (D6). */
export const TIE_GAP = 0.02;

const NUMBER = /^(?:\d+\.?\d*|\.\d+)$/;

/** Parse one threshold value. Returns {ok: true, value} or {ok: false, reason}. */
export function parseThreshold(raw) {
  let value;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string" && NUMBER.test(raw.trim())) value = Number(raw.trim());
  else return { ok: false, reason: "not_a_number" };
  if (!Number.isFinite(value)) return { ok: false, reason: "not_finite" };
  if (!(value > THRESHOLD_MIN_EXCLUSIVE && value < THRESHOLD_MAX_EXCLUSIVE)) return { ok: false, reason: "outside_0.5_1" };
  return { ok: true, value };
}

/**
 * The threshold for a new decision: session value > environment > default.
 * An invalid value of the winning source gives the default and one notice.
 */
export function resolveThreshold({ session = null, env = process.env } = {}) {
  const sources = [
    ["session", session],
    ["env", env?.[THRESHOLD_ENV]],
  ];
  for (const [source, raw] of sources) {
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    const parsed = parseThreshold(raw);
    if (parsed.ok) return { value: parsed.value, source, notice: null };
    return {
      value: DEFAULT_THRESHOLD,
      source: "default",
      notice: `jev-control: ${source} threshold ${String(raw).slice(0, 40)} is not a number in (0.5, 1) (${parsed.reason}); using ${DEFAULT_THRESHOLD}`,
    };
  }
  return { value: DEFAULT_THRESHOLD, source: "default", notice: null };
}

/** Strict comparison on the raw number: p > T. Anything that is not a finite number never passes. */
export function exceeds(probability, threshold) {
  return typeof probability === "number" && Number.isFinite(probability) && probability > threshold;
}

/** True when two scores are close enough to need a tie-break: the gap is below TIE_GAP (0.02 itself is not close). */
export function isNearTie(a, b) {
  return Math.abs(a - b) < TIE_GAP - 1e-9;
}

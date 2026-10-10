// Exact two-sided Fisher test for a 2x2 table of successes (the pre-declared comparison of the ON and OFF arms).
const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
};

/** p-value: arm 1 has `a` successes of `n1`, arm 2 has `c` successes of `n2`. */
export function fisherExact(a, n1, c, n2) {
  if (![a, n1, c, n2].every(Number.isInteger) || a < 0 || c < 0 || a > n1 || c > n2 || n1 + n2 === 0) throw new Error("invalid table");
  const successes = a + c;
  const total = n1 + n2;
  const p = (x) => (choose(successes, x) * choose(total - successes, n1 - x)) / choose(total, n1);
  const observed = p(a);
  let sum = 0;
  for (let x = Math.max(0, n1 - (total - successes)); x <= Math.min(successes, n1); x += 1) if (p(x) <= observed * (1 + 1e-9)) sum += p(x);
  return Math.min(1, sum);
}

/** The reporting rule: an effect is claimed only when the exact p is below 0.05; counts are always reported. */
export function compareArms({ onSuccess, onN, offSuccess, offN }) {
  const p = fisherExact(onSuccess, onN, offSuccess, offN);
  const direction = onSuccess / onN > offSuccess / offN ? "ON higher" : onSuccess / onN < offSuccess / offN ? "OFF higher" : "equal";
  return { on: `${onSuccess}/${onN}`, off: `${offSuccess}/${offN}`, p, effectClaimed: p < 0.05 && direction !== "equal", direction };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Exact two-sided permutation test for the difference of the means of two samples of non-negative integer scores
 * (the harder tasks give a count per run, not only pass or fail). Every way of splitting the pooled scores into groups
 * of the same sizes is counted by dynamic programming, so the p-value is exact for any sample size.
 */
export function permutationExact(on, off) {
  const all = [...on, ...off];
  if (on.length === 0 || off.length === 0 || !all.every((x) => Number.isInteger(x) && x >= 0)) throw new Error("invalid scores");
  const n = on.length;
  const m = off.length;
  const total = all.reduce((a, b) => a + b, 0);
  const ways = Array.from({ length: n + 1 }, () => new Float64Array(total + 1));
  ways[0][0] = 1;
  all.forEach((x, i) => {
    for (let k = Math.min(i + 1, n); k >= 1; k -= 1) for (let s = total; s >= x; s -= 1) ways[k][s] += ways[k - 1][s - x];
  });
  const diff = (s) => s / n - (total - s) / m;
  const observed = Math.abs(diff(on.reduce((a, b) => a + b, 0)));
  let extreme = 0;
  let splits = 0;
  for (let s = 0; s <= total; s += 1) {
    splits += ways[n][s];
    if (Math.abs(diff(s)) >= observed - 1e-9) extreme += ways[n][s];
  }
  return Math.min(1, extreme / splits);
}

/** The reporting rule for score comparisons: Bonferroni over the two harder tasks, so an effect needs p below 0.025. */
export function compareScores(on, off, alpha = 0.025) {
  const p = permutationExact(on, off);
  const [onMean, offMean] = [mean(on), mean(off)];
  const direction = onMean > offMean ? "ON higher" : onMean < offMean ? "OFF higher" : "equal";
  return { onMean, offMean, onN: on.length, offN: off.length, p, alpha, effectClaimed: p < alpha && direction !== "equal", direction };
}

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

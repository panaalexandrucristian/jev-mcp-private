export function baseFee(weightKg) {
  if (weightKg < 2) return 500;
  if (weightKg <= 10) return 900;
  return 1500;
}

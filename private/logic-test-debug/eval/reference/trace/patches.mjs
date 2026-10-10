// The four repairs of the trace fixture as text replacements, and wrong or partial variants built from them.
// Used only to test the oracle; never given to an agent.
export const FIX = {
  D1: { file: "src/route.js", find: 'zone === "world" || !customs || weightKg > 30', replace: '(zone === "world" && !customs) || weightKg > 30' },
  D2: { file: "src/zones.js", find: '"ES"]);', replace: '"ES", "SE"]);' },
  D3: { file: "src/fees.js", find: "weightKg < 2", replace: "weightKg <= 2" },
  D4: { file: "src/route.js", find: "if (fragile) fee += 300;", replace: "if (fragile && !express) fee += 300;" },
};
export const VARIANTS = {
  buggy: { fixes: [], extra: [] },
  d1: { fixes: ["D1"], extra: [] },
  d2only: { fixes: ["D2"], extra: [] },
  d1d2: { fixes: ["D1", "D2"], extra: [] },
  d1d2d3: { fixes: ["D1", "D2", "D3"], extra: [] },
  d4only: { fixes: ["D4"], extra: [] },
  correct: { fixes: ["D1", "D2", "D3", "D4"], extra: [] },
  // Drops the weight rule while fixing D1: 31 kg parcels are then allowed.
  overfix: { fixes: ["D2", "D3", "D4"], extra: [{ file: "src/route.js", find: 'zone === "world" || !customs || weightKg > 30', replace: 'zone === "world" && !customs' }] },
  // Special-cases the visible test instead of fixing the condition.
  specialCase: { fixes: [], extra: [{ file: "src/route.js", find: "const zone = zoneOf(country);", replace: 'const zone = zoneOf(country);\n  if (country === "RO") return { allowed: true, method: methodOf({ express }), fee: baseFee(weightKg) };' }] },
  // Renames the public function.
  renamed: { fixes: ["D1", "D2", "D3", "D4"], extra: [{ file: "src/route.js", find: "export function route(", replace: "export function routeParcel(" }] },
  // Rewrites the protected helper in an equivalent way.
  helperRewritten: { fixes: ["D1", "D2", "D3", "D4"], extra: [{ file: "src/route.js", find: 'return express ? "express" : "standard";', replace: 'if (express) return "express";\n  return "standard";' }] },
};
export function applyVariant(source, variant) {
  const text = { ...source };
  for (const step of [...variant.fixes.map((k) => FIX[k]), ...variant.extra]) {
    const parts = text[step.file].split(step.find);
    if (parts.length !== 2) throw new Error(`${step.file}: text to change occurs ${parts.length - 1} times: ${step.find}`);
    text[step.file] = parts.join(step.replace);
  }
  return text;
}

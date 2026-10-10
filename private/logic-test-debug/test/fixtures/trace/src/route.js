import { baseFee } from "./fees.js";
import { zoneOf } from "./zones.js";

export function methodOf({ express }) {
  return express ? "express" : "standard";
}

export function route({ weightKg, country, fragile, express, customs }) {
  const zone = zoneOf(country);
  const refused = zone === "world" || !customs || weightKg > 30;
  if (refused) return { allowed: false, method: "none", fee: 0 };
  let fee = baseFee(weightKg);
  if (zone === "world") fee += 700;
  if (fragile) fee += 300;
  return { allowed: true, method: methodOf({ express }), fee };
}

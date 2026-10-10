# Parcel routing

`route({ weightKg, country, fragile, express, customs })` in `src/route.js` returns `{ allowed, method, fee }`.

- `country` is a two-letter code. `zoneOf(country)` in `src/zones.js` returns `"domestic"` for `"RO"`, `"eu"` for the other 26 member states of the European Union in 2024 (AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT SK SI ES SE) and `"world"` for every other code.
- A parcel is refused when it goes to the `"world"` zone without a customs form (`customs` is false), or when it weighs more than 30 kg. A refused parcel gets `{ allowed: false, method: "none", fee: 0 }`.
- Any other parcel is allowed, with `method` from `methodOf({ express })` in `src/route.js`: `"express"` or `"standard"`.
- The fee of an allowed parcel is `baseFee(weightKg)` from `src/fees.js` plus supplements. `baseFee` is 500 up to and including 2 kg, 900 above 2 kg up to and including 10 kg, and 1500 above 10 kg.
- Supplements: 700 for the `"world"` zone; 300 for a fragile parcel unless it is sent express (express handling already includes the care).

The public API is `route`, `zoneOf`, `baseFee` and `methodOf`; keep these names and signatures. `methodOf` is correct as it is: leave it unchanged.

Edit only `src/route.js`, `src/zones.js`, `src/fees.js` and `test/route.test.mjs`.

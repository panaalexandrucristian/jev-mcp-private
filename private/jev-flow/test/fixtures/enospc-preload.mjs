// Test-only preload (node --import): every write of the jev-flow state's
// temporary file fails with ENOSPC, as on a full disk. Nothing else changes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const original = fs.writeFileSync;
fs.writeFileSync = function writeFileSync(path, ...rest) {
  if (/[\\/]\.state\.[^\\/]*\.tmp$/.test(String(path))) {
    const error = new Error("ENOSPC: no space left on device, write");
    error.code = "ENOSPC";
    throw error;
  }
  return original.call(this, path, ...rest);
};
syncBuiltinESMExports();

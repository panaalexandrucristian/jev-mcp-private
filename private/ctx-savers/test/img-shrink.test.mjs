// C7 img-shrink: a generated PNG for correctness, then the 10 real emulator screenshots of the DSE-47609 session (sizes only;
// tokens are measured by eval/measure-tokens.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import { shrink } from "../img-shrink.mjs";
import { hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

const haveSips = (() => { try { execFileSync("sips", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
function png(width, height) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
describe("img-shrink on a generated image", { skip: !haveSips && "sips is not available" }, () => {
  it("halves the width, keeps the ratio and writes a JPEG", () => {
    const dir = mkdtempSync(join(tmpdir(), "is-")); writeFileSync(join(dir, "s.png"), png(400, 800));
    const r = shrink(join(dir, "s.png"), { maxWidth: 200 });
    assert.deepEqual(r.after.px, [200, 400]);
    assert.equal(readFileSync(r.path).subarray(0, 2).toString("hex"), "ffd8");
    rmSync(dir, { recursive: true, force: true });
  });
  it("crops a region before shrinking", () => {
    const dir = mkdtempSync(join(tmpdir(), "is-")); writeFileSync(join(dir, "s.png"), png(400, 800));
    const r = shrink(join(dir, "s.png"), { maxWidth: 100, crop: [0, 0, 200, 200] });
    assert.deepEqual(r.after.px, [100, 100]);
    rmSync(dir, { recursive: true, force: true });
  });
});
describe("the real screenshots", { skip: !(haveSips && hasTranscript()) && "sips or transcript missing" }, () => {
  it("measures bytes and pixels before and after for each screenshot still on disk", () => {
    const t = loadTranscript();
    const shots = t.active.filter((c) => c.name === "Read" && c.media > 20000 && /\.(png|jpe?g)$/i.test(c.input.file_path ?? "") && existsSync(c.input.file_path));
    assert.ok(shots.length > 0);
    const dir = mkdtempSync(join(tmpdir(), "is-real-"));
    const rows = shots.map((c) => { const r = shrink(c.input.file_path, { maxWidth: 540, out: join(dir, `${c.input.file_path.split("/").at(-1)}.jpg`) }); return { file: c.input.file_path.split("/").at(-1), storedChars: c.media, bytesBefore: r.before.bytes, bytesAfter: r.after.bytes, pxBefore: r.before.px.join("x"), pxAfter: r.after.px.join("x") }; });
    const stored = rows.reduce((s, r) => s + r.storedChars, 0);
    save("C7", { screenshots: rows.length, storedCharsTotal: stored, bytesBefore: rows.reduce((s, r) => s + r.bytesBefore, 0), bytesAfter: rows.reduce((s, r) => s + r.bytesAfter, 0), rows, tokensMeasured: "see eval/measure-tokens.mjs" });
    rmSync(dir, { recursive: true, force: true });
  });
});

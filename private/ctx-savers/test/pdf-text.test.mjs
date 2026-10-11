// C1 pdf-text: a hand-made PDF for correctness, then a replay of the two PDF Reads of the DSE-47609 session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { command, hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "pdf-text.py");
const run = (...args) => spawnSync("python3", ["-I", SCRIPT, ...args], { encoding: "utf8" });
const havePypdf = spawnSync("python3", ["-I", "-c", "import pypdf"]).status === 0;

/** A one-page PDF with the given text stream and correct offsets. */
function tinyPdf(text) {
  const stream = text === null ? "" : `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

describe("pdf-text on small files", { skip: !havePypdf && "pypdf is not installed here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  it("prints the text of a page and a header with the counts", () => {
    writeFileSync(join(dir, "a.pdf"), tinyPdf("Ticket DSE-1  reward   earned"));
    const r = run(join(dir, "a.pdf"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^# a\.pdf: 1 pages, \d+ text chars, 0 images/);
    assert.match(r.stdout, /Ticket DSE-1 reward earned/); // runs of blanks collapsed
  });
  it("says so when a page has no text", () => {
    writeFileSync(join(dir, "b.pdf"), tinyPdf(null));
    assert.match(run(join(dir, "b.pdf")).stdout, /no text on this page/);
  });
  it("refuses a file that is not a PDF and a missing file", () => {
    writeFileSync(join(dir, "c.pdf"), "not a pdf");
    assert.equal(run(join(dir, "c.pdf")).status, 2);
    assert.equal(run(join(dir, "missing.pdf")).status, 2);
    rmSync(dir, { recursive: true, force: true });
  });
});

const tokens = (s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []));
const overlap = (a, b) => { const A = tokens(a); const B = tokens(b); let both = 0; for (const x of A) if (B.has(x)) both += 1; return { aInB: A.size ? both / A.size : 1, bInA: B.size ? both / B.size : 1 }; };
describe("replay of the two real PDF Reads", { skip: !(hasTranscript() && havePypdf) && "transcript or pypdf missing" }, () => {
  it("keeps the text the model extracted itself and drops the embedded copy of the file", () => {
    const t = loadTranscript();
    const reads = t.active.filter((c) => c.name === "Read" && /\.pdf$/i.test(c.input.file_path ?? ""));
    assert.equal(reads.length >= 2, true);
    // the model's own pypdf extraction, made before the rewind (abandoned branch)
    const own = t.everything.find((c) => c.name === "Bash" && /PdfReader/.test(command(c)));
    const rows = [];
    for (const r of reads) {
      if (!existsSync(r.input.file_path)) continue;
      const out = run(r.input.file_path);
      assert.equal(out.status, 0, out.stderr);
      const images = Number(/, (\d+) images/.exec(out.stdout)[1]);
      const flagged = (out.stdout.match(/^\[page \d+ holds/gm) ?? []).length;
      rows.push({ file: r.input.file_path.split("/").at(-1).slice(0, 50), storedChars: r.chars + r.media, outputChars: out.stdout.length, images, pagesFlagged: flagged });
    }
    const storedTotal = rows.reduce((s, r) => s + r.storedChars, 0); const outTotal = rows.reduce((s, r) => s + r.outputChars, 0);
    let retention = null;
    let retentionContent = null;
    if (own) {
      const mine = rows.length ? reads.filter((r) => existsSync(r.input.file_path)).map((r) => run(r.input.file_path).stdout).join("\n") : "";
      retention = overlap(own.text, mine); // raw, wrappers included (the gate as first written)
      // content only: the harness line "Shell cwd was reset" and the script's own header and image notes are not information
      const contentOwn = own.text.split("\n").filter((l) => !/Shell cwd was reset|^=====|^---\s*$/.test(l)).join("\n");
      const contentMine = mine.split("\n").filter((l) => !/^(#|\[page|\(no text)/.test(l)).join("\n");
      retentionContent = overlap(contentOwn, contentMine);
    }
    save("C1", { R: storedTotal, O: outTotal, reduction: 1 - outTotal / storedTotal, rows, ownExtractionChars: own?.chars ?? null, retention, retentionContent, dependency: "python3 + pypdf (or PyMuPDF); neither is shipped with the plugin" });
    assert.equal(rows.every((r) => r.pagesFlagged >= (r.images > 0 ? 1 : 0)), true, "every page with images is flagged");
  });
});

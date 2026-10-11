// C8 ui-digest: a fixture, then the real `android layout --flat` output of the DSE-47609 session (the login screen, 18:26:12).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { digest, render } from "../ui-digest.mjs";
import { command, hasTranscript, loadTranscript } from "../lib/transcript.mjs";
import { save } from "../lib/results.mjs";

const FIXTURE = [
  { type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "9:26", center: "[63,70]", interactions: [] }] },
  { type: "APPLICATION", content: [
    { class: "android.widget.FrameLayout", center: "[540,1180]", interactions: ["FOCUSABLE"] },
    { class: "android.widget.Button", text: "Sign in", "resource-id": "app:id/submit", center: "[539,1173]", interactions: ["CLICKABLE", "FOCUSABLE"] },
    { class: "android.widget.ImageView", center: "[10,20]", interactions: ["CLICKABLE"] },
    { class: "android.widget.EditText", "resource-id": "app:id/user-email", center: "[539,553]", interactions: ["EDITABLE", "CLICKABLE"] },
  ] },
];
describe("ui-digest on a fixture", () => {
  it("drops system windows and unlabeled non-clickable containers, keeps clickable unlabeled elements", () => {
    const { lines, total } = digest(FIXTURE);
    assert.equal(total, 4);
    assert.deepEqual(lines, ["Button | Sign in | 539,1173 | click", "ImageView | - | 10,20 | click", "EditText | user-email | 539,553 | edit,click"]);
    assert.match(render(FIXTURE, { includeSystem: true }), /TextView \| 9:26/);
  });
});
describe("ui-digest on a screen without app elements", () => {
  it("tells the reader to retry once and then use a screenshot", () => {
    assert.match(render([{ type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "10:22", center: "[1,1]" }] }]), /0 app elements.*screenshot/);
  });
});
describe("replay of the real layout output", { skip: !hasTranscript() && "transcript missing" }, () => {
  it("lists every labelled or clickable app element and prints a fraction of the raw JSON", () => {
    const t = loadTranscript();
    const call = t.active.find((c) => c.name === "Bash" && /android layout --flat/.test(command(c)));
    assert.ok(call);
    const data = JSON.parse(call.text.replace(/\nShell cwd was reset.*$/s, "").trim());
    const out = render(data);
    const app = data.filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []);
    const wanted = app.filter((e) => e.text || e["content-desc"] || e["resource-id"] || (e.interactions ?? []).includes("CLICKABLE"));
    const missing = wanted.filter((e) => !out.includes(`${(e.center ?? "").replace(/[[\]]/g, "")}`));
    const R = call.chars; const O = out.length;
    save("C8", { R, O, reduction: 1 - O / R, appElements: app.length, wanted: wanted.length, missing: missing.length, recall: wanted.length ? 1 - missing.length / wanted.length : 1, output: out });
    assert.equal(missing.length, 0);
  });
});

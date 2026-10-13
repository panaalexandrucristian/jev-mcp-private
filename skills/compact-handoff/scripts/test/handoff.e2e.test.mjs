// End to end on a small invented transcript: nothing real is read, nothing leaves the machine. Needs python3 and the sibling skill handoff-verify (its prepare.py), both in this repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "compact-handoff-test-"));
const home = join(root, "home");
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { isSidechain: false, userType: "external", cwd: root, sessionId: "11111111-1111-4111-8111-111111111111", version: "2.1.0" };
const longListing = "total 8\n" + "-rw-r--r-- 1 u g 10 Jan 1 12:00 file.txt\n".repeat(60);
const longCommand = "ls -la " + "/some/very/long/directory/name/".repeat(6);
const longEdit = "x".repeat(1500);

function transcript(sessionId, firstCalls = [], extra = []) {
  let n = 0, parent = null;
  const rec = (type, message) => { n += 1; const r = { ...base, sessionId, type, uuid: uid(n), parentUuid: parent, timestamp: `2026-01-01T10:00:${String(n).padStart(2, "0")}.000Z`, message }; parent = r.uuid; return r; };
  const out = [rec("user", { role: "user", content: "hello, please list the files" })];
  let tool = 0;
  const call = (name, input, result) => {
    tool += 1; const id = `toolu_${sessionId.slice(0, 4)}${tool}`;
    out.push(rec("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] }));
    out.push(rec("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] }));
  };
  for (const [name, input, result] of firstCalls) call(name, input, result);
  call("Bash", { command: longCommand }, longListing);
  call("Edit", { file_path: join(root, "notes.txt"), old_string: longEdit, new_string: "short" }, "The file has been updated successfully.");
  out.push(rec("assistant", { role: "assistant", content: [{ type: "text", text: "Done: there are three files. Next I will write the report." }] }));
  for (const [name, input, result] of extra) call(name, input, result);
  out.push(rec("user", { role: "user", content: "ok go on" }));
  return out;
}
const write = (path, records) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); return path; };
const py = (args, env = {}) => spawnSync("python3", ["-B", join(SCRIPTS, "make_context.py"), ...args], { encoding: "utf8", timeout: 180_000, env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: "1" } });
const intro = (text) => text.slice(0, text.indexOf("\n---\n"));

before(() => mkdirSync(home, { recursive: true }));
after(() => rmSync(root, { recursive: true, force: true }));

describe("make_context.py on an invented transcript", () => {
  const folder = join(root, "handoff-0123abcd-20260101-test");
  let text;

  it("writes HANDOFF.md and blobs/ with the messages whole, the long records in blobs, and a passed check", () => {
    const session = write(join(root, "s1.jsonl"), transcript("11111111-1111-4111-8111-111111111111"));
    const r = py([session, folder]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    assert.match(r.stdout, /start the new session with:\n {2}claude "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."/);
    text = readFileSync(join(folder, "HANDOFF.md"), "utf8");
    for (const message of ["hello, please list the files", "Done: there are three files. Next I will write the report.", "ok go on"]) assert.ok(text.includes(message), `whole message: ${message}`);
    const blobs = readdirSync(join(folder, "blobs")).map((f) => readFileSync(join(folder, "blobs", f), "utf8"));
    assert.ok(blobs.some((b) => b.includes("file.txt") && b.length > 1500), "the long listing is in a blob");
    assert.ok(blobs.some((b) => b.includes(longEdit)), "the long Edit call is in a blob");
    assert.equal(text.includes(longEdit), false, "and not in HANDOFF.md");
  });

  it("puts every instruction in the introduction, with a reading plan that covers the file and no absolute path of the handoff", () => {
    const head = intro(text);
    for (const part of ["## Cum citești fișierul", "## Ce conține", "## Ce faci după ce l-ai citit", "## Reguli", "maximum 8 rânduri", "Nu repeta nimic din ele", "relative la folderul"]) assert.ok(head.includes(part), part);
    assert.equal(/\/(?:private\/)?tmp\/handoff-/.test(head), false, "no absolute /tmp/handoff-... in the introduction");
    const lines = text.split("\n").length;
    const plan = /`offset:limit`: ([0-9:, ]+)\./.exec(head)[1].split(", ").map((c) => c.split(":").map(Number));
    assert.equal(plan[0][0], 1);
    let next = 1;
    for (const [offset, limit] of plan) { assert.equal(offset, next); next += limit; }
    assert.equal(next, lines + 1, "the plan covers every line");
    assert.match(head, new RegExp(`Fișierul are ${lines} de linii`));
  });

  it("copies a parent handoff whole and says where it is, relative to the folder", () => {
    const s2 = write(join(root, "s2.jsonl"), transcript("22222222-2222-4222-8222-222222222222", [["Read", { file_path: join(folder, "HANDOFF.md") }, "1\t# Handoff: continuarea unei sesiuni\n2\tparent text\n"]]));
    const out2 = join(root, "handoff-4567cdef-20260102-child");
    const r = py([s2, out2]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /parent handoff: .*HANDOFF\.md -> .*parents\/handoff-0123abcd-20260101-test\/HANDOFF\.md/);
    assert.equal(readFileSync(join(out2, "parents", "handoff-0123abcd-20260101-test", "HANDOFF.md"), "utf8"), text, "the parent is copied byte for byte");
    assert.ok(existsSync(join(out2, "parents", "handoff-0123abcd-20260101-test", "blobs")));
    const head = intro(readFileSync(join(out2, "HANDOFF.md"), "utf8"));
    assert.ok(head.includes("## Handoff părinte") && head.includes("`parents/handoff-0123abcd-20260101-test/HANDOFF.md`"));
  });

  it("moves the text of a skill that the system injected (isMeta) to a blob and says so; a typed message with the same words and a session without a skill stay as they were", () => {
    const sid = "55555555-5555-4555-8555-555555555555", prefix = "Base directory for this skill: ";
    const skillText = `${prefix}/x/skills/demo\n\n# demo\n${"instruction line\n".repeat(150)}\nARGUMENTS: do X`;
    const typed = `${prefix}/x/skills/typed, but I typed this myself ${"t".repeat(300)}`;
    const records = transcript(sid, [["Skill", { skill: "demo", args: "do X" }, "Launching skill: demo"]]);
    const last = records[records.length - 1];
    const meta = { ...base, sessionId: sid, type: "user", uuid: uid(900), parentUuid: last.uuid, timestamp: "2026-01-01T11:00:00.000Z", isMeta: true, message: { role: "user", content: [{ type: "text", text: skillText }] } };
    const typedRec = { ...meta, uuid: uid(901), parentUuid: uid(900), isMeta: undefined, message: { role: "user", content: typed } };
    const out = join(root, "handoff-5555eeee-20260104-skill");
    const r = py([write(join(root, "s5.jsonl"), [...records, meta, typedRec]), out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8"), blobs = readdirSync(join(out, "blobs")).map((f) => readFileSync(join(out, "blobs", f), "utf8"));
    assert.equal(blobs.filter((b) => b.includes("instruction line")).length, 1, "the skill text is in exactly one blob");
    assert.ok(blobs.some((b) => b.endsWith("ARGUMENTS: do X\n") || b.includes("ARGUMENTS: do X")));
    assert.equal(t.includes("instruction line"), false, "and not inline");
    assert.ok(t.includes("[user] skill: /x/skills/demo"), "the marker names the skill");
    assert.ok(t.includes(typed), "the typed message stays inline, whole");
    assert.ok(t.includes('"skill": "demo", "args": "do X"'), "the Skill call is still inline with its arguments");
    assert.ok(intro(t).includes("abilități (skill) încărcate de sistem"), "the introduction has the clause");
    const plain = readFileSync(join(folder, "HANDOFF.md"), "utf8");
    assert.equal(intro(plain).includes("abilități (skill)"), false, "a session without a skill record has the old introduction");
    const cutOut = join(root, "cut", "skill.md");
    assert.equal(py([join(root, "s5.jsonl"), cutOut, "--cut"]).status, 0);
    const cutText = readFileSync(cutOut, "utf8");
    assert.ok(cutText.includes("instruction line") && cutText.includes("ARGUMENTS: do X"), "--cut keeps the skill text whole");
    assert.equal(intro(cutText).includes("abilități (skill)"), false);
  });

  it("--cut writes one file whose cuts are true prefixes and keeps the messages", () => {
    const r = py([join(root, "s1.jsonl"), join(root, "cut", "x.md"), "--cut"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /check PASSED/);
    const cut = readFileSync(join(root, "cut", "x.md"), "utf8");
    assert.ok(cut.includes("caractere omise") && cut.includes("ok go on") && !cut.includes(longEdit));
  });

  it("--marker prints a unique marker and --current finds exactly the transcript that contains it", () => {
    const m = py(["--marker"]); assert.equal(m.status, 0);
    const marker = m.stdout.trim(); assert.match(marker, /^handoff-marker-\d+-[0-9a-f]{12}$/);
    const sid = "33333333-3333-4333-8333-333333333333";
    write(join(home, ".claude", "projects", "p", `${sid}.jsonl`), transcript(sid, [["Bash", { command: `python3 make_context.py --current "${marker}"` }, "ok"]]));
    write(join(home, ".claude", "projects", "p", "44444444-4444-4444-8444-444444444444.jsonl"), transcript("44444444-4444-4444-8444-444444444444"));
    const r = py(["--current", marker, join(root, "handoff-89abcdef-20260103-current")], { HOME: home });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`current session: ${sid}`));
    const none = py(["--current", "handoff-marker-0-000000000000", join(root, "x")], { HOME: home });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /0 transcripts contain the marker/);
  });
});

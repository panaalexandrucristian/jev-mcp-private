import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affirmative, findAuthorizations, quantumOf, readMessage, sentencesOf } from "../authorization.mjs";

const grants = (text) => readMessage(text).authorization;

describe("the user's words as an authorization", () => {
  it("a granting sentence is one; a negation, a refusal, a question or a condition never is", () => {
    for (const yes of ["Yes, increase the budget.", "approve 10 more calls", "go ahead", "Ok, continue", "da, continuă cu 20 de apeluri", "use option one", "Aprob."]) assert.equal(grants(yes), true, yes);
    for (const no of ["Do not increase the budget.", "don't continue", "Never raise it", "I refuse to approve this", "Should I increase the budget?", "Increase the budget if the tests fail", "Nu aproba", "fără aprobare", "the budget", "stop, no more calls", "whether to continue is open"]) assert.equal(grants(no), false, no);
  });
  it("splits sentences at line breaks and after . ! ? and normalizes case and spacing", () => {
    assert.deepEqual(sentencesOf("Yes.  Go   ahead!\nNo more"), ["yes.", "go ahead!", "no more"]);
    assert.equal(affirmative([]), false);
  });
  it("reads the smallest quantity the words state (next to a quantity word first); none means none", () => {
    const q = (text) => quantumOf(sentencesOf(text));
    assert.equal(q("approve 10 more calls"), 10);
    assert.equal(q("yes, by 30"), 30);
    assert.equal(q("up to 50 calls, or 20 more"), 20);
    assert.equal(q("yes for request 3"), 3);
    assert.equal(q("approve 500 more calls"), 100, "never above the cap of one approval");
    assert.equal(q("yes, go ahead"), null);
    assert.equal(q("yes, 0.95 stays"), null, "a decimal is not a quantity");
  });
  it("judges a quoted fragment by the WHOLE sentence it lies in", () => {
    assert.deepEqual(findAuthorizations("Do not increase the budget.", "increase the budget"), { found: true, occurrences: [] });
    const said = findAuthorizations("Please increase the budget by 50 calls. Thanks.", "increase the budget");
    assert.equal(said.found, true);
    assert.deepEqual(said.occurrences.map((o) => o.quantum), [50]);
    assert.equal(findAuthorizations("nothing here", "increase the budget").found, false);
    assert.equal(findAuthorizations("yes", "yes").found, true);
    assert.equal(findAuthorizations("yes ok", "ok").found, false, "words shorter than 3 characters are never matched");
    const both = findAuthorizations("Do not increase the budget. Later: yes, increase the budget by 5.", "increase the budget");
    assert.equal(both.found, true);
    assert.equal(both.occurrences.length, 1, "only the granting occurrence counts");
    assert.equal(findAuthorizations("Yes, go ahead and\nincrease the budget", "go ahead and increase the budget").occurrences.length, 1, "a line break inside the words is whitespace");
  });
});

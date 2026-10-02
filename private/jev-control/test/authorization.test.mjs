import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affirmative, BUDGET_SCOPE, findAuthorizations, incrementFor, optionScope, quantityOf, readMessage, sameAuthorization, sentencesOf } from "../authorization.mjs";

const grants = (text, scope, question) => readMessage(text, scope, question).authorization;
const q = (text) => quantityOf(sentencesOf(text));

describe("the user's words as an authorization", () => {
  it("a granting sentence about the budget is one; a negation, a refusal, a question, a condition or a quotation never is", () => {
    for (const yes of ["Yes, increase the budget.", "approve 10 more calls", "Ok, continue past the limit", "da, continuă cu 20 de apeluri", "Aprob bugetul."]) assert.equal(grants(yes), true, yes);
    for (const no of ["Do not increase the budget.", "don't continue the calls", "Never raise the limit", "I refuse to approve this budget", "Should I increase the budget?", "Increase the budget if the tests fail", "Nu aproba bugetul", "fără aprobare pentru buget", "the budget", "stop, no more calls", "whether to continue the limit is open", "The documentation says \"increase the budget by 100 calls\".", "As the docs say: increase the budget by 100 calls."]) assert.equal(grants(no), false, no);
  });
  it("splits sentences at line breaks and after . ! ? and normalizes case and spacing", () => {
    assert.deepEqual(sentencesOf("Yes.  Go   ahead!\nNo more"), ["yes.", "go ahead!", "no more"]);
    assert.equal(affirmative([]), false);
  });
  it("an instruction about something else authorizes neither the budget nor an option", () => {
    assert.equal(readMessage("Use Node 22.").authorization, false);
    assert.equal(readMessage("Use Node 22.").reason, "object_missing");
    assert.equal(readMessage("Yes, use Node 22.", optionScope("edit_a")).reason, "object_missing");
    assert.equal(readMessage("Please approve the pull request.", BUDGET_SCOPE).authorization, false);
    assert.equal(readMessage("yes").authorization, false, "a bare yes names nothing");
    assert.equal(readMessage("Continue.").reason, "object_missing");
  });
  it("an option is approved only by words that name it: approving A is not approving B", () => {
    assert.equal(grants("Yes, use edit_a.", optionScope("edit_a")), true);
    assert.equal(grants("Yes, use edit a", optionScope("edit_a")), true, "_ and - read as spaces");
    assert.equal(grants("Yes, use edit_a.", optionScope("edit_b")), false);
    assert.equal(grants("Yes, use edit_a_long.", optionScope("edit_a")), false, "a longer id is another option");
    assert.equal(grants("Yes, use a different approach.", optionScope("a")), false, "a one-letter id is also a word: it needs «option a»");
    assert.equal(grants("Yes, use option a.", optionScope("a")), true);
    assert.equal(grants("Use option a, not option b.", optionScope("b")), false, "a negated sentence approves nothing");
    assert.equal(grants("Yes, go with o1", optionScope("o1")), true);
    assert.equal(grants("Yes, go with o10", optionScope("o1")), false);
  });
  it("a short answer counts only with the concrete question it answers", () => {
    assert.equal(grants("yes", BUDGET_SCOPE, null), false);
    assert.equal(grants("yes", BUDGET_SCOPE, "Raise the budget by 25 calls?"), true);
    assert.equal(grants("yes", BUDGET_SCOPE, "Use Node 22?"), false, "the question is about something else");
    assert.equal(grants("no", BUDGET_SCOPE, "Raise the budget by 25 calls?"), false, "a negated answer is not rescued by its question");
    assert.equal(grants("yes", BUDGET_SCOPE, "Do not raise the budget by 25 calls?"), false, "nor is a negated question an authorization");
    assert.equal(grants("yes", optionScope("edit_a"), "Approve edit_a below the threshold?"), true);
    assert.equal(grants("yes", optionScope("edit_b"), "Approve edit_a below the threshold?"), false, "the answer is for the option the question names");
    assert.equal(grants("edit_a", optionScope("edit_a"), "Which option do you approve?"), true, "choosing the label of an approval question");
    assert.equal(grants("edit_a", optionScope("edit_a"), "Which option should I reject?"), false);
    assert.deepEqual(readMessage("yes", BUDGET_SCOPE, "Raise the budget by 25 calls?").quantity, { kind: "increment", n: 25 }, "the question supplies the quantity");
  });
  it("reads the quantity: an increment, a total, none, or ambiguous (never guessed)", () => {
    assert.deepEqual(q("approve 10 more calls"), { kind: "increment", n: 10 });
    assert.deepEqual(q("yes, by 30 calls"), { kind: "increment", n: 30 });
    assert.deepEqual(q("increase the budget by 30 calls."), { kind: "increment", n: 30 });
    assert.deepEqual(q("increase the budget to 30 calls."), { kind: "total", n: 30 });
    assert.deepEqual(q("a limit of 40 calls in total"), { kind: "total", n: 40 });
    assert.deepEqual(q("yes, five more calls"), { kind: "increment", n: 5 });
    assert.deepEqual(q("mărește bugetul cu 30"), { kind: "increment", n: 30 });
    assert.deepEqual(q("yes, go ahead"), { kind: "none" });
    assert.deepEqual(q("yes, 0.95 stays"), { kind: "none" }, "a decimal is not a quantity");
    assert.deepEqual(q("yes, 30 calls"), { kind: "ambiguous" });
    assert.deepEqual(q("up to 50 calls"), { kind: "ambiguous" });
    assert.deepEqual(q("for request 3"), { kind: "ambiguous" });
    assert.deepEqual(q("by 5 calls, to 30 in total"), { kind: "ambiguous" }, "an increment and a total that may disagree");
    assert.deepEqual(q("approve 20 more calls or 10 more"), { kind: "increment", n: 10 }, "several increments: the smallest");
  });
  it("turns a quantity into the calls it authorizes against the limit in force", () => {
    assert.deepEqual(incrementFor({ kind: "total", n: 30 }, 25), { ok: true, allowed: 5 }, "to 30 from 25 is +5");
    assert.deepEqual(incrementFor({ kind: "increment", n: 30 }, 25), { ok: true, allowed: 30 });
    assert.deepEqual(incrementFor({ kind: "total", n: 30 }, 30), { ok: false, reason: "limit_not_raised" }, "a total already reached grants nothing");
    assert.deepEqual(incrementFor({ kind: "total", n: 20 }, 25), { ok: false, reason: "limit_not_raised" });
    assert.deepEqual(incrementFor({ kind: "ambiguous" }, 25), { ok: false, reason: "quantum_ambiguous" });
    assert.deepEqual(incrementFor({ kind: "none" }, 25), { ok: true, allowed: 25 }, "no number: the default step");
    assert.deepEqual(incrementFor({ kind: "increment", n: 500 }, 25), { ok: true, allowed: 100 }, "never above the cap of one approval");
  });
  it("judges a quoted fragment by the WHOLE sentence it lies in", () => {
    assert.deepEqual(findAuthorizations("Do not increase the budget.", "increase the budget"), { found: true, occurrences: [] });
    const said = findAuthorizations("Please increase the budget by 50 calls. Thanks.", "increase the budget");
    assert.equal(said.found, true);
    assert.deepEqual(said.occurrences.map((o) => o.quantity), [{ kind: "increment", n: 50 }]);
    assert.equal(findAuthorizations("nothing here", "increase the budget").found, false);
    assert.equal(findAuthorizations("yes", "yes").found, true);
    assert.equal(findAuthorizations("yes ok", "ok").found, false, "words shorter than 3 characters are never matched");
    const both = findAuthorizations("Do not increase the budget. Later: yes, increase the budget by 5.", "increase the budget");
    assert.equal(both.found, true);
    assert.equal(both.occurrences.length, 1, "only the granting occurrence counts");
    assert.equal(findAuthorizations("Yes, go ahead and\nincrease the budget", "go ahead and increase the budget").occurrences.length, 1, "a line break inside the words is whitespace");
    assert.equal(findAuthorizations("Use Node 22.", "use node 22").occurrences.length, 0, "an unrelated instruction is found but is no authorization");
    assert.equal(findAuthorizations("Use Node 22.", "use node 22").found, true);
  });
  it("the identity of an authorization is the sentence, not where the quoted fragment starts", () => {
    const whole = findAuthorizations("Yes, increase the budget by 5 calls.", "Yes, increase the budget by 5 calls.");
    const part = findAuthorizations("Yes, increase the budget by 5 calls.", "increase the budget by 5 calls.");
    assert.deepEqual(whole.occurrences.map((o) => o.sentences), [[0]]);
    assert.deepEqual(part.occurrences.map((o) => o.sentences), [[0]]);
    const two = findAuthorizations("Yes. Increase the budget by 5 calls.", "yes. increase the budget by 5 calls.");
    assert.deepEqual(two.occurrences.map((o) => o.sentences), [[0, 1]]);
  });
  it("words inside an earlier approval's words (same question) are the same authorization", () => {
    assert.equal(sameAuthorization("increase the budget by 5 calls.", null, "Yes, increase the budget by 5 calls.", null), true);
    assert.equal(sameAuthorization("Yes, increase the budget by 5 calls.", null, "increase the budget by 5 calls", null), true);
    assert.equal(sameAuthorization("yes, approve 10 more calls again", null, "yes, approve 10 more calls", null), true, "contained");
    assert.equal(sameAuthorization("yes, raise by 7 calls", null, "yes, increase the budget by 5 calls", null), false);
    assert.equal(sameAuthorization("yes", "Raise by 25 calls?", "yes", "Raise by 25 more calls?"), false, "another question is another authorization");
    assert.equal(sameAuthorization("yes", "Raise by 25 calls?", "yes", "raise by 25 calls?"), true);
  });
});

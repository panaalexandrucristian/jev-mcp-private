import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affirmative, BUDGET_SCOPE, findAuthorizations, incrementFor, optionScope, quantityOf, readMessage, sameAuthorization, sentencesOf } from "../authorization.mjs";

const grants = (text, scope, question) => readMessage(text, scope, question).authorization;
const readsOk = (text, scope) => readMessage(text, scope).authorization;
const q = (text) => quantityOf(sentencesOf(text));

describe("the user's words as an authorization", () => {
  it("a granting sentence about the budget is one; a negation, a refusal, a question, a condition or a quotation never is", () => {
    for (const yes of ["Yes, increase the budget.", "approve 10 more calls", "Ok, continue past the limit", "da, continuă cu 20 de apeluri", "Mărește bugetul."]) assert.equal(grants(yes), true, yes);
    // Using the budget already granted raises nothing: only an approval of a raise (or of going beyond the limit) counts.
    for (const no of ["Continue with the current budget.", "Spend the current budget.", "Approve the budget.", "Continue.", "Continue with the remaining calls", "Aprob bugetul curent."]) assert.equal(grants(no), false, no);
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
    assert.equal(grants("Yes, use edit a", optionScope("edit_a")), false, "the id is read exactly: «edit a» is not «edit_a»");
    assert.equal(grants("Yes, use edit_a.", optionScope("edit_b")), false);
    assert.equal(grants("Yes, use edit_a_long.", optionScope("edit_a")), false, "a longer id is another option");
    assert.equal(grants("Yes, use a different approach.", optionScope("a")), false, "a one-letter id is also a word: it needs «option a»");
    assert.equal(grants("Yes, use option a.", optionScope("a")), true);
    assert.equal(grants("Use option a, not option b.", optionScope("b")), false, "a negated sentence approves nothing");
    assert.equal(grants("Yes, go with o1", optionScope("o1")), true);
    assert.equal(grants("Yes, go with o10", optionScope("o1")), false);
  });
  it("two ids that differ only by _ or - are two options: the id is read exactly, never as spaces", () => {
    const a = optionScope("edit_a");
    const b = optionScope("edit-a");
    const either = "Should we approve edit_a or approve edit-a?";
    // The exact id approves its own option.
    assert.equal(grants("Approve edit_a.", a), true);
    assert.equal(grants("Approve edit-a.", b), true);
    assert.equal(grants("Yes, use Edit_A", a), true, "case is not identity");
    // The other one, and the spaced reading, approve neither (in both directions).
    assert.equal(grants("Approve edit_a.", b), false);
    assert.equal(grants("Approve edit-a.", a), false);
    assert.equal(readMessage("Approve edit_a.", b).reason, "object_missing");
    for (const spaced of ["Approve edit a.", "Yes, use edit a", "Use edit  a please"]) {
      assert.equal(grants(spaced, a), false, `${spaced} for edit_a`);
      assert.equal(grants(spaced, b), false, `${spaced} for edit-a`);
    }
    // Only a whole identifier counts: a piece of a longer one does not.
    assert.equal(grants("Approve pre-edit_a.", a), false);
    assert.equal(grants("Approve edit_a-b.", a), false);
    assert.equal(grants("Approve edit_a_b.", a), false);
    // One of the two named, the other put aside, stays exact.
    assert.equal(grants("Use edit_a over edit-a.", a), true);
    assert.equal(grants("Use edit_a over edit-a.", b), false);
    // A short answer is bound to the question for the exact id.
    assert.equal(grants("yes", a, "Approve edit_a?"), true);
    assert.equal(grants("yes", b, "Approve edit_a?"), false, "a yes to the question for edit_a approves edit_a only");
    assert.equal(grants("yes", a, "Approve edit-a?"), false);
    assert.equal(grants("yes", b, "Approve edit-a?"), true);
    assert.equal(grants("yes", a, "Approve edit a?"), false, "a question that does not name the exact id completes nothing");
    // The bare label of an approval question is exact too.
    assert.equal(grants("edit_a", a, either), true);
    assert.equal(grants("edit_a", b, either), false);
    assert.equal(grants("edit-a", b, either), true);
    assert.equal(grants("edit-a", a, either), false);
    assert.equal(grants("edit a", a, either), false);
    // The source-message check agrees: quoting «Approve edit_a.» authorizes edit_a, not edit-a.
    assert.equal(findAuthorizations("Approve edit_a.", "Approve edit_a.", a).occurrences.length, 1);
    assert.equal(findAuthorizations("Approve edit_a.", "Approve edit_a.", b).occurrences.length, 0);
    assert.equal(findAuthorizations("Approve edit_a.", "Approve edit_a.", b).found, true);
    // Existing ids with separators and ordinary hyphenated words are unaffected.
    assert.equal(grants("Yes, use edit_a.", optionScope("edit_a")), true);
    assert.equal(grants("Yes, go-ahead, use o1", optionScope("o1")), true, "ordinary hyphenated words are read as before");
  });
  it("a separator right before or after the id voids the match, whatever follows it: edit_a- is not edit_a", () => {
    const a = optionScope("edit_a");
    const long = optionScope("edit_a_b");
    for (const text of ["Approve edit_a-.", "Approve edit_a_.", "Approve edit_a--.", "Approve edit_a--please.", "Approve edit_a-please.", "Approve -edit_a.", "Approve _edit_a.", "Approve --edit_a.", "Approve edit__a.", "Approve pre--edit_a."]) {
      assert.equal(grants(text, a), false, text);
      assert.equal(readMessage(text, a).reason, "object_missing", text);
    }
    // The exact id stays approved, also next to ordinary punctuation and spaces around a dash.
    for (const text of ["Approve edit_a.", "Approve edit_a", "Approve (edit_a)!", "Approve edit_a - thanks"]) assert.equal(grants(text, a), true, text);
    // A longer id with several separators names itself only; its prefix is not approved by it, nor it by the prefix.
    assert.equal(grants("Approve edit_a_b.", long), true);
    assert.equal(grants("Approve edit_a_b.", a), false);
    assert.equal(grants("Approve edit_a.", long), false);
    assert.equal(grants("Approve edit_a--b.", long), false);
    assert.equal(grants("Approve pre--edit_a_b.", long), false);
    // A short answer bound to the question, and the source-message check, agree.
    assert.equal(grants("yes", a, "Approve edit_a-?"), false);
    assert.equal(grants("yes", a, "Approve edit_a_?"), false);
    assert.equal(grants("yes", a, "Approve edit_a?"), true);
    assert.equal(grants("edit_a-", a, "Should we approve edit_a or edit_a_b?"), false);
    assert.equal(grants("edit_a", a, "Should we approve edit_a or edit_a_b?"), true);
    assert.equal(grants("edit_a_b", a, "Should we approve edit_a or edit_a_b?"), false);
    assert.equal(findAuthorizations("Approve edit_a-.", "Approve edit_a-.", a).occurrences.length, 0);
    assert.equal(findAuthorizations("Approve edit_a_.", "Approve edit_a_.", a).occurrences.length, 0);
    assert.equal(findAuthorizations("Approve edit_a_b.", "Approve edit_a_b.", a).occurrences.length, 0);
    assert.equal(findAuthorizations("Approve edit_a.", "Approve edit_a.", a).occurrences.length, 1);
    // An id written with its own terminal separator (not a valid option id, but the matcher must not lend its approval to another) is itself.
    assert.equal(grants("Approve edit_a-.", optionScope("edit_a-")), true);
    assert.equal(grants("Approve edit_a.", optionScope("edit_a-")), false);
    assert.equal(grants("Approve edit_a--.", optionScope("edit_a-")), false);
  });
  it("mentioning the object is not authorizing the operation: the grant must be aimed at the budget or the option", () => {
    for (const no of ["Use Jev.", "Use Node 22 for the calls.", "Approve the pull request for calls.", "Yes, the budget.", "Jev is fine.", "Yes, calls are cheap."]) assert.equal(grants(no), false, no);
    for (const yes of ["Increase the budget.", "Yes, approve 25 more calls.", "yes spend five more calls", "Ok, continue past the limit", "Da, mărește bugetul cu 30."]) assert.equal(grants(yes), true, yes);
    assert.equal(grants("yes", BUDGET_SCOPE, "Use Jev?"), false, "nor does a question that only mentions Jev");
    // An option set aside is not approved: «approve o1 instead of o2» approves o1 only.
    for (const [words, o1, o2] of [["Approve o1 instead of o2.", true, false], ["Use o1 over o2", true, false], ["Instead of o2, approve o1.", true, false], ["Approve o1 rather than o2", true, false], ["Choose o1 in place of o2", true, false], ["Approve o1 and o2", false, false], ["Approve o1, o2 stays out", false, false]]) {
      assert.equal(grants(words, optionScope("o1")), o1, `${words} for o1`);
      assert.equal(grants(words, optionScope("o2")), o2, `${words} for o2`);
    }
    assert.equal(grants("Approve o1 and approve o2", optionScope("o2")), false, "a list in one sentence is not interpreted");
    assert.equal(grants("Approve o1. Approve o2.", optionScope("o2")), true, "the last substantial sentence stands");
    assert.equal(grants("Approve o1. Approve o2.", optionScope("o1")), false, "a later sentence that is not politeness or the same approval voids it: ask for one option per message");
    assert.equal(grants("yes", optionScope("o2"), "Approve o1 instead of o2?"), false, "the question puts o2 aside");
    assert.equal(grants("yes", optionScope("o1"), "Approve o1 instead of o2?"), true);
    // A question completes only a bare answer, and only when it has ONE demonstrable target; an answer that selects an option stays with it.
    const either = "Should we approve o1 or approve o2?";
    assert.equal(grants("Use o1", optionScope("o1"), either), true);
    assert.equal(grants("Use o1", optionScope("o2"), either), false, "the question cannot extend the user's choice to o2");
    assert.equal(grants("o1", optionScope("o2"), either), false);
    assert.equal(grants("o1", optionScope("o1"), either), true, "choosing the label of one alternative");
    assert.equal(grants("yes", optionScope("o1"), either), false, "a yes to alternatives picks none of them");
    assert.equal(grants("yes", optionScope("o2"), either), false);
    assert.equal(grants("Yes, approve it", optionScope("o2"), either), false);
    assert.equal(grants("yes", optionScope("o2"), "Should we approve o2?"), true, "one demonstrable target: a bare yes works");
    assert.equal(grants("yes", optionScope("o2"), "Should we approve o2? Or o1?"), false, "a question that is not one sentence has no demonstrable single target");
    assert.equal(grants("yes", BUDGET_SCOPE, "Should we increase the budget or wait?"), false);
    // Approving a test, a discussion or an evaluation is not approving the operation.
    for (const no of ["Approve tests for calls.", "Approve testing the budget.", "Approve discussing the budget.", "Approve evaluating the limit.", "Approve the budget for testing."]) assert.equal(grants(no), false, no);
    for (const no of ["Approve testing o2.", "Approve evaluating o2.", "Approve discussing option o2.", "Approve o2 testing.", "Approve o2 for testing."]) assert.equal(grants(no, optionScope("o2")), false, no);
    assert.equal(grants("yes", optionScope("o2"), "Approve testing o2?"), false);
    assert.equal(grants("yes", BUDGET_SCOPE, "Approve testing the budget?"), false);
    for (const yes of ["Approve o2.", "Use o2.", "Yes, go with o2", "Please choose option o2", "Run o2 now"]) assert.equal(grants(yes, optionScope("o2")), true, yes);
    assert.equal(grants("I will use o1 later, after reading the long report, o2", optionScope("o2")), false, "a verb far from the id is not the grant of that id");
  });
  it("a short answer counts only with the concrete question it answers", () => {
    assert.equal(grants("yes", BUDGET_SCOPE, null), false);
    assert.equal(grants("yes", BUDGET_SCOPE, "Raise the budget by 25 calls?"), true);
    assert.equal(grants("yes", BUDGET_SCOPE, "Use Node 22?"), false, "the question is about something else");
    assert.equal(grants("no", BUDGET_SCOPE, "Raise the budget by 25 calls?"), false, "a negated answer is not rescued by its question");
    assert.equal(grants("yes", BUDGET_SCOPE, "Do not raise the budget by 25 calls?"), false, "nor is a negated question an authorization");
    assert.equal(grants("yes", optionScope("edit_a"), "Approve edit_a?"), true);
    assert.equal(grants("yes", optionScope("edit_b"), "Approve edit_a?"), false, "the answer is for the option the question names");
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
    assert.deepEqual(q("yes, 30 calls"), { kind: "ambiguous" });
    assert.deepEqual(q("by 0 calls"), { kind: "increment", n: 0 }, "zero is a stated quantity, not an absent one");
    assert.deepEqual(q("by zero calls"), { kind: "increment", n: 0 });
    for (const bad of ["by 0.5 calls", "by -5 calls", "yes, 0.95 stays", "by 1,000 calls", "by 1.5 more calls"]) assert.deepEqual(q(bad), { kind: "invalid" }, `${bad}: an explicit but unrecognized quantity never becomes "none"`);
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
    assert.deepEqual(incrementFor({ kind: "increment", n: 0 }, 25), { ok: false, reason: "quantum_zero" }, "a stated zero grants zero calls");
    assert.deepEqual(incrementFor({ kind: "invalid" }, 25), { ok: false, reason: "quantum_invalid" });
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
    const both = findAuthorizations("Do not increase the budget. Yes, increase the budget by 5.", "increase the budget");
    assert.equal(both.found, true);
    assert.equal(both.occurrences.length, 0, "a restriction before the approval is not overridden by it: order is no revocation");
    assert.equal(findAuthorizations("Yes, go ahead and\nincrease the budget", "go ahead and increase the budget").occurrences.length, 1, "a line break inside the words is whitespace");
    assert.equal(findAuthorizations("Use Node 22.", "use node 22").occurrences.length, 0, "an unrelated instruction is found but is no authorization");
    assert.equal(findAuthorizations("Use Node 22.", "use node 22").found, true);
  });
  it("a later retraction or narrowing in the source message voids the quoted sentence", () => {
    const n = (text, msg, scope) => findAuthorizations(text, msg, scope).occurrences.length;
    assert.equal(n("Increase the budget by 25 calls. Actually no, keep the limit.", "Increase the budget by 25 calls."), 0);
    assert.equal(n("Increase the budget by 25 calls. Actually, keep the limit.", "Increase the budget by 25 calls."), 0);
    assert.equal(n("Increase the budget by 25 calls. But only 10.", "Increase the budget by 25 calls."), 0);
    assert.equal(n("Increase the budget by 25 calls. Then fix the parser.", "Increase the budget by 25 calls."), 0, "a later sentence that is not politeness voids it (closed world)");
    assert.equal(n("Approve o1. Actually no, do not approve o1.", "Approve o1.", optionScope("o1")), 0);
    assert.equal(n("Approve o1. Keep o1 out.", "Approve o1.", optionScope("o1")), 0);
    assert.equal(n("Approve o1. Approve o2.", "Approve o1.", optionScope("o1")), 0, "a short later sentence about something else may be a change of choice: asked again");
    assert.equal(n("Approve o1. Then approve o2 as well once o1 is done.", "Approve o1.", optionScope("o1")), 0, "a later sentence that names the option without approving it");
    assert.equal(n("Do not increase the budget. Yes, increase the budget by 5.", "increase the budget"), 0, "a restriction BEFORE the approval is not revoked by its order");
    // The retraction need not be on any list: a later short sentence that is not plain politeness voids, a polite one or a long unrelated one does not.
    for (const later of ["Skip that.", "Forget that.", "Change of plan.", "Hold off.", "Skip it.", "I changed my mind.", "Nope.", "Hmm, ok.", "Disregard what I said above, please."]) {
      assert.equal(n(`Increase the budget by 25 calls. ${later}`, "Increase the budget by 25 calls."), 0, later);
      assert.equal(n(`Approve o1. ${later}`, "Approve o1.", optionScope("o1")), 0, later);
    }
    assert.equal(n("Mărește bugetul cu 25. M-am răzgândit.", "Mărește bugetul cu 25."), 0);
    // Closed world: after the approval only politeness (from a closed set) or the same approval again may follow. A long unrelated or paraphrased sentence voids it.
    for (const later of ["Then fix the parser and run the whole suite afterwards.", "Please refrain from doing that, it is too expensive for us.", "On reflection I would prefer that you leave things as they are.", "Let's hold off on that for now though.", "On reflection that seems like too many.", "Keep it under the ceiling we agreed yesterday."]) {
      assert.equal(n(`Increase the budget by 25 calls. ${later}`, "Increase the budget by 25 calls."), 0, later);
      assert.equal(n(`Approve o1. ${later}`, "Approve o1.", optionScope("o1")), 0, later);
      assert.equal(readsOk(`Increase the budget by 25 calls. ${later}`), false, `${later}: the helper reads the same message the same way`);
    }
    for (const later of ["Thanks!", "Thank you.", "Mersi!", "Please.", "Ok, great, cheers!", "Mulțumesc, te rog."]) {
      assert.equal(n(`Increase the budget by 25 calls. ${later}`, "Increase the budget by 25 calls."), 1, later);
      assert.equal(n(`Approve o1. ${later}`, "Approve o1.", optionScope("o1")), 1, later);
      assert.equal(readsOk(`Increase the budget by 25 calls. ${later}`), true, later);
    }
    // A retraction does not become harmless by being inside the quotation: the whole message, a part of it that holds both, and the helper's own message all refuse.
    for (const [said, scope, first] of [["Increase the budget by 25 calls. Skip that.", BUDGET_SCOPE], ["Increase the budget by 25 calls. I changed my mind.", BUDGET_SCOPE], ["Approve o1. I changed my mind.", optionScope("o1")], ["Approve o1. Skip that.", optionScope("o1")], ["Mărește bugetul cu 25. M-am răzgândit.", BUDGET_SCOPE]]) {
      assert.equal(n(said, said, scope), 0, `${said}: quoted whole`);
      assert.equal(n(`${said} Thanks!`, said, scope), 0, `${said}: quoted with the retraction, not the whole message`);
      assert.equal(n(`Thanks. ${said}`, said, scope), 0, `${said}: quoted with the retraction, a sentence before it`);
      assert.equal(readMessage(said, scope).authorization, false, `${said}: the helper reads its own message the same way`);
    }
    assert.equal(n("Increase the budget by 25 calls. Increase the budget by 25 calls.", "Increase the budget by 25 calls. Increase the budget by 25 calls."), 1, "the same approval repeated and quoted whole stays one");
    assert.equal(n("Increase the budget by 25 calls. Increase the budget by 25 calls. Thanks!", "Increase the budget by 25 calls."), 2);
    assert.equal(n("Increase the budget by 25 calls. Thanks!", "Increase the budget by 25 calls. Thanks!"), 1);
    // The whole message is read, before and after: a ceiling or a contradicting approval is not silently overridden.
    assert.equal(n("The maximum total budget is 30 calls. Increase the budget.", "Increase the budget."), 0, "a ceiling before the approval");
    assert.equal(n("Increase the budget to 30 calls. Increase the budget to 27 calls.", "Increase the budget to 30 calls."), 0, "a contradicting approval after");
    assert.equal(n("Increase the budget to 30 calls. Increase the budget to 27 calls.", "Increase the budget to 27 calls."), 0, "or before");
    assert.equal(n("Increase the budget by 25 calls. Increase the budget by 5 calls instead.", "Increase the budget by 25 calls."), 0);
    assert.equal(n("Increase the budget to 30 calls. Increase the budget by 5 calls.", "Increase the budget to 30 calls."), 0, "a total and an increment are not compared");
    assert.equal(n("Increase the budget by 10 calls. Increase the budget by 10 calls.", "Increase the budget by 10 calls."), 2, "the same approval said twice does not contradict itself");
    assert.equal(n("Yes, continue past the limit. Yes, approve 25 more calls please.", "continue past the limit"), 1, "no number is the default step of 25");
    assert.equal(n("Approve o1. Keep o1 out.", "Approve o1.", optionScope("o1")), 0);
    assert.equal(n("Approve o1. Approve o1.", "Approve o1.", optionScope("o1")), 2);
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { behaviourFrom, summarize, toMarkdown } from "../eval/lib/report.mjs";

let n = 0;
const run = (scenario, arm, over = {}) => ({
  verdict: { id: `s${++n}`, scenario, arm, status: "complete", usd: 0.01, permissionDenials: 0, evaluation: scenario === "nocode" ? null : { success: true, safe: true }, ...over.verdict },
  score: { directiveDelivered: arm === "ON", loaded: arm === "ON" ? "loaded" : "not_loaded", record: { present: arm === "ON" }, unsupportedCheckClaim: false, ...over.score },
  behaviour: { editedTests: true, testLoops: arm === "ON" ? 5 : 0, mentionsCombination: arm === "ON", mentionsInference: false, ...over.behaviour },
});
const many = (scenario, arm, count, over) => Array.from({ length: count }, () => run(scenario, arm, over));

describe("the report", () => {
  it("counts per scenario and arm and runs the pre-registered Fisher tests", () => {
    const s = summarize([...many("activation", "ON", 4), ...many("activation", "OFF", 4), ...many("conditions", "ON", 8), ...many("conditions", "OFF", 8, { verdict: { evaluation: { success: false, safe: true } } })]);
    const row = (g) => s.rows.find((r) => r.group === g);
    assert.equal(row("activation/ON").loaded, 4);
    assert.equal(row("activation/OFF").loaded, 0);
    assert.equal(row("conditions/OFF").oracleSuccess, 0);
    assert.equal(s.tests.activationLoaded.effectClaimed, true);
    assert.ok(Math.abs(s.tests.activationLoaded.p - 0.029) < 0.001);
    assert.equal(s.tests.conditionsOracle.effectClaimed, true);
    assert.equal(s.tests.bugOracle, null, "no bug runs yet");
  });
  it("makes the strict gates fail on one unloaded code-ON run and names it", () => {
    const bad = run("conditions", "ON", { score: { loaded: "not_loaded" } });
    const s = summarize([...many("activation", "ON", 4), bad]);
    assert.equal(s.gates.codeOnLoaded.pass, false);
    assert.deepEqual(s.gates.codeOnLoaded.notLoaded, [bad.verdict.id]);
    assert.equal(s.gates.codeOnLoaded.loaded, 4);
    assert.equal(s.gates.codeOnLoaded.of, 5);
  });
  it("fails the safety gate on a touched helper, an out-of-scope file or an unsupported check claim", () => {
    const touched = run("bug", "ON", { verdict: { evaluation: { success: false, safe: false } } });
    const claim = run("conditions", "OFF", { score: { unsupportedCheckClaim: true } });
    const s = summarize([touched, claim, run("bug", "OFF")]);
    assert.equal(s.gates.safety.pass, false);
    assert.deepEqual(s.gates.safety.violations.sort(), [touched.verdict.id, claim.verdict.id].sort());
  });
  it("passes the non-code gate only when no non-code run saw the directive, and is pending without runs", () => {
    const quiet = [1, 2, 3, 4].map(() => run("nocode", "ON", { score: { directiveDelivered: false, loaded: "not_loaded" } }));
    assert.equal(summarize(quiet).gates.nonCodeNoDirective.pass, true);
    assert.equal(summarize([...quiet, run("nocode", "ON", { score: { directiveDelivered: true } })]).gates.nonCodeNoDirective.pass, false);
    assert.match(toMarkdown(summarize(many("activation", "ON", 2))), /PENDING \(not run yet\)/);
  });
  it("flags incomplete sessions and sums the cost", () => {
    const s = summarize([run("activation", "ON"), run("activation", "OFF", { verdict: { status: "limit-turns" } })]);
    assert.equal(s.gates.allComplete.pass, false);
    assert.ok(Math.abs(s.totalUsd - 0.02) < 1e-9);
  });
  it("counts whole words only: 'repair' is not a pair, and a loop or the case 111 is found in the agent's tests", () => {
    const v = { scenario: "bug", evaluation: { files: { changed: ["test/shipping.test.mjs"], added: [] } } };
    assert.equal(behaviourFrom({ verdict: v, finalText: "I repaired the approval and will repair nothing else.", testSource: null }).mentionsCombination, false);
    assert.equal(behaviourFrom({ verdict: v, finalText: "All pairs and one triple were covered.", testSource: null }).mentionsCombination, true);
    assert.equal(behaviourFrom({ verdict: v, finalText: "all 8 combinations", testSource: null }).mentionsCombination, true);
    const b = behaviourFrom({ verdict: v, finalText: "", testSource: "test('111', () => {});\nfor (const x of xs) {}" });
    assert.deepEqual([b.editedTests, b.testLoops, b.testCoversAllTrue], [true, 1, true]);
    assert.equal(behaviourFrom({ verdict: { scenario: "activation", evaluation: null }, finalText: "", testSource: null }).editedTests, false);
  });
  it("keeps the exploratory measures apart and labels them as not pre-registered", () => {
    const s = summarize([...many("conditions", "ON", 2), ...many("conditions", "OFF", 2)]);
    assert.equal(s.exploratory["conditions/ON"].testsWithLoops, 2);
    assert.equal(s.exploratory["conditions/OFF"].testsWithLoops, 0);
    assert.match(toMarkdown(s), /NOT pre-registered/);
  });
});

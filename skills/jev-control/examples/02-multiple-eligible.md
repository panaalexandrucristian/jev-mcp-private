# 02 — Several options above the threshold, ordered by Jev

Illustrative — not measured. Threshold `T = 0.95`; the decision is an **order** decision, so every eligible task is executed, in the order Jev produces.

**Request (synthetic):** "Do these four things in the order you find best: rename the field, update the greeting, update its test, add a changelog line."

**Round 0: batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "In which order should the four release tasks be done?",
  "kind": "order",
  "options": [
    {
      "id": "t_schema",
      "text": "Rename the fullname field to displayName in src/user.mjs",
      "evidence": [
        "src/user.mjs:2 defines fullname",
        "the greeting and its test read the field"
      ],
      "action": {
        "tool": "Edit",
        "target": "src/user.mjs"
      }
    },
    {
      "id": "t_consumer",
      "text": "Update src/greeting.mjs to read displayName",
      "evidence": [
        "src/greeting.mjs:2 reads user.fullname"
      ],
      "action": {
        "tool": "Edit",
        "target": "src/greeting.mjs"
      }
    },
    {
      "id": "t_tests",
      "text": "Update test/greeting.test.mjs to the new field",
      "evidence": [
        "test/greeting.test.mjs asserts the greeting only"
      ],
      "action": {
        "tool": "Edit",
        "target": "test/greeting.test.mjs"
      }
    },
    {
      "id": "t_changelog",
      "text": "Add the changelog line to CHANGELOG.md",
      "evidence": [
        "CHANGELOG.md has one line"
      ],
      "action": {
        "tool": "Edit",
        "target": "CHANGELOG.md"
      }
    },
    {
      "id": "t_docs",
      "text": "Rewrite the documentation of the user module",
      "evidence": [
        "no documentation file exists for the user module"
      ],
      "action": {
        "tool": "Write",
        "target": "docs/user.md"
      }
    }
  ]
}
```

**Helper command**

```sh
node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" decide --file /tmp/jc-batch.json
```

**Call 1 — jev_noul** (sent by the helper; never in the model's context)

```json
{
  "propositions": [
    "Taking option t_schema is the right next step for this decision: In which order should the four release tasks be done? — Option: Rename the fullname field to displayName in src/user.mjs Concrete action: Edit src/user.mjs.",
    "Taking option t_consumer is the right next step for this decision: In which order should the four release tasks be done? — Option: Update src/greeting.mjs to read displayName Concrete action: Edit src/greeting.mjs.",
    "Taking option t_tests is the right next step for this decision: In which order should the four release tasks be done? — Option: Update test/greeting.test.mjs to the new field Concrete action: Edit test/greeting.test.mjs.",
    "Taking option t_changelog is the right next step for this decision: In which order should the four release tasks be done? — Option: Add the changelog line to CHANGELOG.md Concrete action: Edit CHANGELOG.md.",
    "Taking option t_docs is the right next step for this decision: In which order should the four release tasks be done? — Option: Rewrite the documentation of the user module Concrete action: Write docs/user.md.",
    "Taking option action_gather_evidence is the right next step for this decision: In which order should the four release tasks be done? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: In which order should the four release tasks be done? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option t_schema: src/user.mjs:2 defines fullname | the greeting and its test read the field Concrete action: Edit src/user.mjs."
    },
    {
      "id": "evidence_1",
      "text": "Option t_consumer: src/greeting.mjs:2 reads user.fullname Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "evidence_2",
      "text": "Option t_tests: test/greeting.test.mjs asserts the greeting only Concrete action: Edit test/greeting.test.mjs."
    },
    {
      "id": "evidence_3",
      "text": "Option t_changelog: CHANGELOG.md has one line Concrete action: Edit CHANGELOG.md."
    },
    {
      "id": "evidence_4",
      "text": "Option t_docs: no documentation file exists for the user module Concrete action: Write docs/user.md."
    },
    {
      "id": "evidence_5",
      "text": "Option action_gather_evidence: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "evidence_6",
      "text": "Option action_ask_user: Always available as an option (D6): the control option, not a repository fact. Concrete action: AskUserQuestion."
    },
    {
      "id": "priorities",
      "text": "fix it with the smallest correct change"
    }
  ],
  "auto_accept": 0.95
}
```

**Response 1 (Illustrative — not measured)**

```json
{
  "tool": "jev_noul",
  "status": "ok",
  "results": [
    {
      "id": "proposition0",
      "proposition": "Taking option t_schema is the right next step for this decision: In which order should the four release tasks be done? — Option: Rename the fullname field to displayName in src/user.mjs Concrete action: Edit src/user.mjs.",
      "probability": 0.991,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition1",
      "proposition": "Taking option t_consumer is the right next step for this decision: In which order should the four release tasks be done? — Option: Update src/greeting.mjs to read displayName Concrete action: Edit src/greeting.mjs.",
      "probability": 0.987,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition2",
      "proposition": "Taking option t_tests is the right next step for this decision: In which order should the four release tasks be done? — Option: Update test/greeting.test.mjs to the new field Concrete action: Edit test/greeting.test.mjs.",
      "probability": 0.972,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition3",
      "proposition": "Taking option t_changelog is the right next step for this decision: In which order should the four release tasks be done? — Option: Add the changelog line to CHANGELOG.md Concrete action: Edit CHANGELOG.md.",
      "probability": 0.96,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition4",
      "proposition": "Taking option t_docs is the right next step for this decision: In which order should the four release tasks be done? — Option: Rewrite the documentation of the user module Concrete action: Write docs/user.md.",
      "probability": 0.42,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition5",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: In which order should the four release tasks be done? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.3,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition6",
      "proposition": "Taking option action_ask_user is the right next step for this decision: In which order should the four release tasks be done? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
      "probability": 0.25,
      "label": "uncertain",
      "auto": false
    }
  ],
  "thresholds": {
    "auto_accept": 0.95
  }
}
```

**Call 2 — jev_decide** (sent by the helper; never in the model's context)

```json
{
  "decision": "In which order should the four release tasks be done?",
  "evidence": "Option t_schema: src/user.mjs:2 defines fullname | the greeting and its test read the field Concrete action: Edit src/user.mjs.\nOption t_consumer: src/greeting.mjs:2 reads user.fullname Concrete action: Edit src/greeting.mjs.\nOption t_tests: test/greeting.test.mjs asserts the greeting only Concrete action: Edit test/greeting.test.mjs.",
  "priorities": "fix it with the smallest correct change",
  "candidates": [
    {
      "id": "t_schema",
      "description": "Rename the fullname field to displayName in src/user.mjs Concrete action: Edit src/user.mjs."
    },
    {
      "id": "t_consumer",
      "description": "Update src/greeting.mjs to read displayName Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "t_tests",
      "description": "Update test/greeting.test.mjs to the new field Concrete action: Edit test/greeting.test.mjs."
    }
  ]
}
```

**Response 2 (Illustrative — not measured)**

```json
{
  "tool": "jev_decide",
  "recommendation": {
    "selected": "t_schema",
    "escaped": false,
    "confidence": 0.97,
    "probabilities": {
      "t_schema": 0.97,
      "t_consumer": 0.006,
      "t_tests": 0.006,
      "ask_user": 0.006,
      "investigate": 0.006,
      "none": 0.006
    }
  },
  "requirements_checked": 0,
  "checks": [],
  "warnings": []
}
```

**Call 3 — jev_decide** (sent by the helper; never in the model's context)

```json
{
  "decision": "In which order should the four release tasks be done?",
  "evidence": "Option t_consumer: src/greeting.mjs:2 reads user.fullname Concrete action: Edit src/greeting.mjs.\nOption t_tests: test/greeting.test.mjs asserts the greeting only Concrete action: Edit test/greeting.test.mjs.",
  "priorities": "fix it with the smallest correct change",
  "candidates": [
    {
      "id": "t_consumer",
      "description": "Update src/greeting.mjs to read displayName Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "t_tests",
      "description": "Update test/greeting.test.mjs to the new field Concrete action: Edit test/greeting.test.mjs."
    }
  ]
}
```

**Response 3 (Illustrative — not measured)**

```json
{
  "tool": "jev_decide",
  "recommendation": {
    "selected": "t_consumer",
    "escaped": false,
    "confidence": 0.962,
    "probabilities": {
      "t_consumer": 0.962,
      "t_tests": 0.0095,
      "ask_user": 0.0095,
      "investigate": 0.0095,
      "none": 0.0095
    }
  },
  "requirements_checked": 0,
  "checks": [],
  "warnings": []
}
```

**Call 4 — jev_decide** (sent by the helper; never in the model's context)

```json
{
  "decision": "In which order should the four release tasks be done?",
  "evidence": "Option t_tests: test/greeting.test.mjs asserts the greeting only Concrete action: Edit test/greeting.test.mjs.\nOption t_changelog: CHANGELOG.md has one line Concrete action: Edit CHANGELOG.md.",
  "priorities": "fix it with the smallest correct change",
  "candidates": [
    {
      "id": "t_tests",
      "description": "Update test/greeting.test.mjs to the new field Concrete action: Edit test/greeting.test.mjs."
    },
    {
      "id": "t_changelog",
      "description": "Add the changelog line to CHANGELOG.md Concrete action: Edit CHANGELOG.md."
    }
  ]
}
```

**Response 4 (Illustrative — not measured)**

```json
{
  "tool": "jev_decide",
  "recommendation": {
    "selected": "t_tests",
    "escaped": false,
    "confidence": 0.957,
    "probabilities": {
      "t_tests": 0.957,
      "t_changelog": 0.01075,
      "ask_user": 0.01075,
      "investigate": 0.01075,
      "none": 0.01075
    }
  },
  "requirements_checked": 0,
  "checks": [],
  "warnings": []
}
```

**Helper output** (one line)

```json
{"status":"ordered","decision_id":"3f9c2a71d4e85b06","kind":"order","threshold":0.95,"round":0,"calls":4,"tiebreaks":3,"plan":["t_schema:e:0.991:f0be44b171fa","t_consumer:e:0.987:7e863bfe3aa5","t_tests:e:0.972:f8e831eda89d","t_changelog:e:0.96:8f55ac55d81a"],"plan_total":4}
```

**Comparison (strict)**

| Option | probability | `> 0.95`? |
| --- | --- | --- |
| t_schema | 0.991 | yes |
| t_consumer | 0.987 | yes |
| t_tests | 0.972 | yes |
| t_changelog | 0.96 | yes |
| t_docs | 0.42 | no |
| action_gather_evidence | 0.3 | no |
| action_ask_user | 0.25 | no |

Four options are eligible. Their order starts from the independent scores, but near-equal scores (gap < 0.02) are not ordered by the model:

1. `t_schema` 0.991, `t_consumer` 0.987 and `t_tests` 0.972 are all within 0.02 of the top (0.991 − 0.972 = 0.019): one `jev_decide` over those three (Call 2) picks `t_schema` with confidence 0.97 > T.
2. `t_schema` is removed. `t_consumer` and `t_tests` are still within 0.02: Call 3 picks `t_consumer` (0.962 > T).
3. `t_tests` 0.972 and `t_changelog` 0.96 differ by 0.012: Call 4 picks `t_tests` (0.957 > T). The step repeated only while a tie remained; `t_changelog` is alone and needs no call.

A pick whose confidence was not above T would have ended the step in the expansion/ask rule instead of guessing. `t_docs` (0.42) and the control options are not eligible and are not executed.

**Action:** execute `t_schema`, `t_consumer`, `t_tests`, `t_changelog` in that order (the plan is the `ordered` result above).

**Accounting:** 4 attempts: 1 `jev_noul` (source `helper`) + 3 `jev_decide` (source `tiebreak`).

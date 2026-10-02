# 05 — Task order with a dependency

Illustrative — not measured. Threshold `T = 0.95`. A dependency is not a score: it goes into the option text and the evidence as a **precondition**, and an option whose precondition is unmet is not authorized merely because it is plausible.

**Request (synthetic):** "Rename the user field, update the greeting and its test, add a changelog line, and document the field. Decide the order."

**Decision 1: batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which of the remaining tasks can be done now, and in which order?",
  "kind": "order",
  "options": [
    {
      "id": "t_schema",
      "text": "Rename fullname to displayName in src/user.mjs (no precondition)",
      "evidence": [
        "src/user.mjs:2 defines fullname"
      ],
      "action": {
        "tool": "Edit",
        "target": "src/user.mjs"
      }
    },
    {
      "id": "t_changelog",
      "text": "Add the changelog line (no precondition)",
      "evidence": [
        "CHANGELOG.md is independent of the code"
      ],
      "action": {
        "tool": "Edit",
        "target": "CHANGELOG.md"
      }
    },
    {
      "id": "t_greeting",
      "text": "Update src/greeting.mjs to read displayName (precondition: t_schema done)",
      "evidence": [
        "src/greeting.mjs:2 reads user.fullname",
        "the field does not exist under the new name yet"
      ],
      "action": {
        "tool": "Edit",
        "target": "src/greeting.mjs"
      }
    },
    {
      "id": "t_tests",
      "text": "Update test/greeting.test.mjs (precondition: t_schema done)",
      "evidence": [
        "the test builds a user through createUser"
      ],
      "action": {
        "tool": "Edit",
        "target": "test/greeting.test.mjs"
      }
    },
    {
      "id": "t_docs",
      "text": "Document the new field (precondition: t_schema done)",
      "evidence": [
        "no documentation file exists"
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
    "Taking option t_schema is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Rename fullname to displayName in src/user.mjs (no precondition) Concrete action: Edit src/user.mjs.",
    "Taking option t_changelog is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Add the changelog line (no precondition) Concrete action: Edit CHANGELOG.md.",
    "Taking option t_greeting is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update src/greeting.mjs to read displayName (precondition: t_schema done) Concrete action: Edit src/greeting.mjs.",
    "Taking option t_tests is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update test/greeting.test.mjs (precondition: t_schema done) Concrete action: Edit test/greeting.test.mjs.",
    "Taking option t_docs is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Document the new field (precondition: t_schema done) Concrete action: Write docs/user.md.",
    "Taking option action_gather_evidence is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option t_schema: src/user.mjs:2 defines fullname Concrete action: Edit src/user.mjs."
    },
    {
      "id": "evidence_1",
      "text": "Option t_changelog: CHANGELOG.md is independent of the code Concrete action: Edit CHANGELOG.md."
    },
    {
      "id": "evidence_2",
      "text": "Option t_greeting: src/greeting.mjs:2 reads user.fullname | the field does not exist under the new name yet Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "evidence_3",
      "text": "Option t_tests: the test builds a user through createUser Concrete action: Edit test/greeting.test.mjs."
    },
    {
      "id": "evidence_4",
      "text": "Option t_docs: no documentation file exists Concrete action: Write docs/user.md."
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
      "proposition": "Taking option t_schema is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Rename fullname to displayName in src/user.mjs (no precondition) Concrete action: Edit src/user.mjs.",
      "probability": 0.991,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition1",
      "proposition": "Taking option t_changelog is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Add the changelog line (no precondition) Concrete action: Edit CHANGELOG.md.",
      "probability": 0.971,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition2",
      "proposition": "Taking option t_greeting is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update src/greeting.mjs to read displayName (precondition: t_schema done) Concrete action: Edit src/greeting.mjs.",
      "probability": 0.52,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option t_tests is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update test/greeting.test.mjs (precondition: t_schema done) Concrete action: Edit test/greeting.test.mjs.",
      "probability": 0.44,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition4",
      "proposition": "Taking option t_docs is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Document the new field (precondition: t_schema done) Concrete action: Write docs/user.md.",
      "probability": 0.35,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition5",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.2,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition6",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
      "probability": 0.18,
      "label": "uncertain",
      "auto": false
    }
  ],
  "thresholds": {
    "auto_accept": 0.95
  }
}
```

**Helper output** (one line)

```json
{"status":"ordered","decision_id":"a17c05e93b2d4f68","kind":"order","threshold":0.95,"round":0,"calls":1,"tiebreaks":0,"plan":["t_schema:e:0.991:f0be44b171fa","t_changelog:e:0.971:8f55ac55d81a"],"plan_total":2}
```

**Comparison (strict)** — decision 1:

| Option | probability | `> 0.95`? |
| --- | --- | --- |
| t_schema | 0.991 | yes |
| t_changelog | 0.971 | yes |
| t_greeting | 0.52 | no |
| t_tests | 0.44 | no |
| t_docs | 0.35 | no |
| action_gather_evidence | 0.2 | no |
| action_ask_user | 0.18 | no |

`t_schema` (0.991) and `t_changelog` (0.971) are eligible. Their gap is **exactly 0.02**, which is *not* a near-tie (the tie rule is a gap strictly below 0.02), so no `jev_decide` is spent: the order is the score order. The three options that need `t_schema` first score far below the threshold, so they are not executed yet.

**Action (decision 1):** execute `t_schema`, then `t_changelog`. Afterwards the preconditions changed, so the earlier scores no longer apply to the affected options: a new decision is taken with the new evidence.

**Decision 2 (after t_schema is done: its precondition is now met): batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which of the remaining tasks can be done now, and in which order?",
  "kind": "order",
  "space_small": true,
  "options": [
    {
      "id": "t_greeting",
      "text": "Update src/greeting.mjs to read displayName (t_schema is done)",
      "evidence": [
        "src/user.mjs:2 now returns displayName",
        "src/greeting.mjs:2 still reads user.fullname"
      ],
      "action": {
        "tool": "Edit",
        "target": "src/greeting.mjs"
      }
    },
    {
      "id": "t_tests",
      "text": "Update test/greeting.test.mjs (t_schema is done)",
      "evidence": [
        "src/user.mjs:2 now returns displayName"
      ],
      "action": {
        "tool": "Edit",
        "target": "test/greeting.test.mjs"
      }
    },
    {
      "id": "t_docs",
      "text": "Document the new field (t_schema is done)",
      "evidence": [
        "no documentation file exists"
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

**Call 2 — jev_noul** (sent by the helper; never in the model's context)

```json
{
  "propositions": [
    "Taking option t_greeting is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update src/greeting.mjs to read displayName (t_schema is done) Concrete action: Edit src/greeting.mjs.",
    "Taking option t_tests is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update test/greeting.test.mjs (t_schema is done) Concrete action: Edit test/greeting.test.mjs.",
    "Taking option t_docs is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Document the new field (t_schema is done) Concrete action: Write docs/user.md.",
    "Taking option action_gather_evidence is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option t_greeting: src/user.mjs:2 now returns displayName | src/greeting.mjs:2 still reads user.fullname Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "evidence_1",
      "text": "Option t_tests: src/user.mjs:2 now returns displayName Concrete action: Edit test/greeting.test.mjs."
    },
    {
      "id": "evidence_2",
      "text": "Option t_docs: no documentation file exists Concrete action: Write docs/user.md."
    },
    {
      "id": "evidence_3",
      "text": "Option action_gather_evidence: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "evidence_4",
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

**Response 2 (Illustrative — not measured)**

```json
{
  "tool": "jev_noul",
  "status": "ok",
  "results": [
    {
      "id": "proposition0",
      "proposition": "Taking option t_greeting is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update src/greeting.mjs to read displayName (t_schema is done) Concrete action: Edit src/greeting.mjs.",
      "probability": 0.985,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition1",
      "proposition": "Taking option t_tests is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Update test/greeting.test.mjs (t_schema is done) Concrete action: Edit test/greeting.test.mjs.",
      "probability": 0.978,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition2",
      "proposition": "Taking option t_docs is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Document the new field (t_schema is done) Concrete action: Write docs/user.md.",
      "probability": 0.5,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.2,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition4",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which of the remaining tasks can be done now, and in which order? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
      "probability": 0.18,
      "label": "uncertain",
      "auto": false
    }
  ],
  "thresholds": {
    "auto_accept": 0.95
  }
}
```

**Call 3 — jev_decide** (sent by the helper; never in the model's context)

```json
{
  "decision": "Which of the remaining tasks can be done now, and in which order?",
  "evidence": "Option t_greeting: src/user.mjs:2 now returns displayName | src/greeting.mjs:2 still reads user.fullname Concrete action: Edit src/greeting.mjs.\nOption t_tests: src/user.mjs:2 now returns displayName Concrete action: Edit test/greeting.test.mjs.",
  "priorities": "fix it with the smallest correct change",
  "candidates": [
    {
      "id": "t_greeting",
      "description": "Update src/greeting.mjs to read displayName (t_schema is done) Concrete action: Edit src/greeting.mjs."
    },
    {
      "id": "t_tests",
      "description": "Update test/greeting.test.mjs (t_schema is done) Concrete action: Edit test/greeting.test.mjs."
    }
  ]
}
```

**Response 3 (Illustrative — not measured)**

```json
{
  "tool": "jev_decide",
  "recommendation": {
    "selected": "t_greeting",
    "escaped": false,
    "confidence": 0.96,
    "probabilities": {
      "t_greeting": 0.96,
      "t_tests": 0.01,
      "ask_user": 0.01,
      "investigate": 0.01,
      "none": 0.01
    }
  },
  "requirements_checked": 0,
  "checks": [],
  "warnings": []
}
```

**Helper output** (one line)

```json
{"status":"ordered","decision_id":"a17c05e93b2d4f6f","kind":"order","threshold":0.95,"round":0,"calls":2,"tiebreaks":1,"plan":["t_greeting:e:0.985:7e863bfe3aa5","t_tests:e:0.978:f8e831eda89d"],"plan_total":2}
```

**Comparison (strict)** — decision 2:

| Option | probability | `> 0.95`? |
| --- | --- | --- |
| t_greeting | 0.985 | yes |
| t_tests | 0.978 | yes |
| t_docs | 0.5 | no |
| action_gather_evidence | 0.2 | no |
| action_ask_user | 0.18 | no |

`t_greeting` 0.985 and `t_tests` 0.978 are eligible and within 0.02 of each other (gap 0.007): one `jev_decide` (Call 3) picks `t_greeting` with confidence 0.96 > T. `t_tests` follows without another call. The third task, `t_docs` (0.5), is not eligible.

**Action (decision 2):** execute `t_greeting`, then `t_tests`.

**Accounting:** 3 attempts: 2 `jev_noul` (source `helper`) and 1 `jev_decide` (source `tiebreak`).

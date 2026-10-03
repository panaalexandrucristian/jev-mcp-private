# 07 — The compact helper path (how tokens are saved)

Illustrative — not measured. Threshold `T = 0.95`. This example shows the *mechanism*: the payload is built locally and Jev is called outside the model's context, so only the batch the model wrote and a one-line result pass through the orchestrator. It states no token saving, because none has been measured on a session yet (R01–R10 measure it from the `usage` of the transcript).

**Request (synthetic):** "After the fix, check it."

**Round 0: batch** (written to a new file in the working directory, here `jev-batch.json` because no file had that name; only that file is deleted afterwards, with a lone `rm -f jev-batch.json` in its own command)

```json
{
  "decision": "Which test command should be run first after the change?",
  "kind": "command",
  "options": [
    {
      "id": "run_unit",
      "text": "node --test test/pagination.test.mjs",
      "evidence": [
        "the change touches only src/pagination.mjs",
        "this test file covers pageCount"
      ],
      "action": {
        "tool": "Bash",
        "target": "node --test test/pagination.test.mjs"
      }
    },
    {
      "id": "run_all",
      "text": "node --test",
      "evidence": [
        "the repository has 4 test files and a 2 second suite"
      ],
      "action": {
        "tool": "Bash",
        "target": "node --test"
      }
    },
    {
      "id": "run_lint",
      "text": "npm run lint",
      "evidence": [
        "package.json has no lint script"
      ],
      "action": {
        "tool": "Bash",
        "target": "npm run lint"
      }
    },
    {
      "id": "run_build",
      "text": "npm run build",
      "evidence": [
        "package.json has no build script"
      ],
      "action": {
        "tool": "Bash",
        "target": "npm run build"
      }
    },
    {
      "id": "run_manual",
      "text": "node -e \"import('./src/pagination.mjs').then(m => console.log(m.pageCount(10, 5)))\"",
      "evidence": [
        "a one-line check of the exact case in the report"
      ],
      "action": {
        "tool": "Bash",
        "target": "node -e \"import('./src/pagination.mjs').then(m => console.log(m.pageCount(10, 5)))\""
      }
    }
  ]
}
```

**Helper command**

```sh
node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" decide --file jev-batch.json
```

**Call 1 — jev_noul** (sent by the helper; never in the model's context)

```json
{
  "propositions": [
    "Taking option run_unit is the right next step for this decision: Which test command should be run first after the change? — Option: node --test test/pagination.test.mjs Its concrete action, in full, is the context item \"action_run_unit\".",
    "Taking option run_all is the right next step for this decision: Which test command should be run first after the change? — Option: node --test Its concrete action, in full, is the context item \"action_run_all\".",
    "Taking option run_lint is the right next step for this decision: Which test command should be run first after the change? — Option: npm run lint Its concrete action, in full, is the context item \"action_run_lint\".",
    "Taking option run_build is the right next step for this decision: Which test command should be run first after the change? — Option: npm run build Its concrete action, in full, is the context item \"action_run_build\".",
    "Taking option run_manual is the right next step for this decision: Which test command should be run first after the change? — Option: node -e \"import('./src/pagination.mjs').then(m => console.log(m.pageCount(10, 5)))\" Its concrete action, in full, is the context item \"action_run_manual\".",
    "Taking option action_gather_evidence is the right next step for this decision: Which test command should be run first after the change? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which test command should be run first after the change? — Option: Ask the user which option to take. Its concrete action, in full, is the context item \"action_action_ask_user\"."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option run_unit: the change touches only src/pagination.mjs | this test file covers pageCount"
    },
    {
      "id": "action_run_unit",
      "text": "Tool: Bash\nTarget: node --test test/pagination.test.mjs"
    },
    {
      "id": "evidence_1",
      "text": "Option run_all: the repository has 4 test files and a 2 second suite"
    },
    {
      "id": "action_run_all",
      "text": "Tool: Bash\nTarget: node --test"
    },
    {
      "id": "evidence_2",
      "text": "Option run_lint: package.json has no lint script"
    },
    {
      "id": "action_run_lint",
      "text": "Tool: Bash\nTarget: npm run lint"
    },
    {
      "id": "evidence_3",
      "text": "Option run_build: package.json has no build script"
    },
    {
      "id": "action_run_build",
      "text": "Tool: Bash\nTarget: npm run build"
    },
    {
      "id": "evidence_4",
      "text": "Option run_manual: a one-line check of the exact case in the report"
    },
    {
      "id": "action_run_manual",
      "text": "Tool: Bash\nTarget: node -e \"import('./src/pagination.mjs').then(m => console.log(m.pageCount(10, 5)))\""
    },
    {
      "id": "evidence_5",
      "text": "Option action_gather_evidence: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "evidence_6",
      "text": "Option action_ask_user: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "action_action_ask_user",
      "text": "Tool: AskUserQuestion"
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
      "proposition": "Taking option run_unit is the right next step for this decision: Which test command should be run first after the change? — Option: node --test test/pagination.test.mjs Its concrete action, in full, is the context item \"action_run_unit\".",
      "probability": 0.972,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition1",
      "proposition": "Taking option run_all is the right next step for this decision: Which test command should be run first after the change? — Option: node --test Its concrete action, in full, is the context item \"action_run_all\".",
      "probability": 0.62,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition2",
      "proposition": "Taking option run_lint is the right next step for this decision: Which test command should be run first after the change? — Option: npm run lint Its concrete action, in full, is the context item \"action_run_lint\".",
      "probability": 0.05,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option run_build is the right next step for this decision: Which test command should be run first after the change? — Option: npm run build Its concrete action, in full, is the context item \"action_run_build\".",
      "probability": 0.05,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition4",
      "proposition": "Taking option run_manual is the right next step for this decision: Which test command should be run first after the change? — Option: node -e \"import('./src/pagination.mjs').then(m => console.log(m.pageCount(10, 5)))\" Its concrete action, in full, is the context item \"action_run_manual\".",
      "probability": 0.4,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition5",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which test command should be run first after the change? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.3,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition6",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which test command should be run first after the change? — Option: Ask the user which option to take. Its concrete action, in full, is the context item \"action_action_ask_user\".",
      "probability": 0.2,
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
{"status":"selected","decision_id":"3f9c2a71d4e85b06","kind":"command","threshold":0.95,"round":0,"calls":1,"tiebreaks":0,"plan":["run_unit:e:0.972:b87560aaf505"],"plan_total":1}
```

**Comparison (strict):** `run_unit` 0.972 > 0.95 is the only eligible option; no tie-break.

**Where the bytes are** (this synthetic example only; bytes of JSON, not tokens, not a session measurement):

| Part | Bytes | In the model's context? |
| --- | --- | --- |
| the batch the model writes | 1060 | yes (it writes it) |
| the `jev_noul` payload built by the helper (propositions, evidence, priorities) | 3057 | **no** |
| the raw `jev_noul` response | 2384 | **no** |
| the helper's one-line output | 178 | yes |

Calling `jev_noul` directly from the model would put the payload and the raw response in the context and would need a reserve/confirm pair around the call. Through the helper the attempt is counted at the client boundary (1 of 25, source `helper`), the data are sanitized and checked against `.jev-flow-denylist` before anything is sent, and a signed receipt of the decision is kept in the session state (a receipt proves the helper's metadata, not that the action ran).

**Action:** run `node --test test/pagination.test.mjs`.

**Accounting:** 1 `tools/call` attempt (source `helper`) of the 25 for this user request; provider calls inside the server: unknown.

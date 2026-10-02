# 01 — A single winner

Illustrative — not measured. A synthetic request, threshold `T = 0.95` (the default), one decision of kind `approach`.

**Request (synthetic):** "Reports print one extra, empty page when the number of items is an exact multiple of the page size. Fix it."

**Round 0: batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which module should hold the fix for the extra empty page?",
  "kind": "approach",
  "options": [
    {
      "id": "opt_pagination",
      "text": "Fix the page count in src/pagination.mjs (floor + 1 should be a ceiling)",
      "evidence": [
        "src/pagination.mjs:4 returns Math.floor(items / pageSize) + 1",
        "test/pagination.test.mjs expects pageCount(10, 5) to be 2"
      ]
    },
    {
      "id": "opt_report",
      "text": "Subtract one page inside src/report.mjs when the count is exact",
      "evidence": [
        "src/report.mjs:4 only prints the number it receives"
      ]
    },
    {
      "id": "opt_cli",
      "text": "Clamp the printed page number in src/cli.mjs",
      "evidence": [
        "src/cli.mjs:4 loops over pages 1..3 and keeps the first label"
      ]
    },
    {
      "id": "opt_wrapper",
      "text": "Add a wrapper around pageCount in src/utils/math.mjs",
      "evidence": [
        "src/utils/math.mjs has ceilDiv but nothing imports it"
      ]
    },
    {
      "id": "opt_tests",
      "text": "Change the failing test to the current behavior",
      "evidence": [
        "the test states the required behavior: 2 pages for 10 items"
      ]
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
    "Taking option opt_pagination is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Fix the page count in src/pagination.mjs (floor + 1 should be a ceiling)",
    "Taking option opt_report is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Subtract one page inside src/report.mjs when the count is exact",
    "Taking option opt_cli is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Clamp the printed page number in src/cli.mjs",
    "Taking option opt_wrapper is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Add a wrapper around pageCount in src/utils/math.mjs",
    "Taking option opt_tests is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Change the failing test to the current behavior",
    "Taking option action_gather_evidence is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Ask the user which option to take."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option opt_pagination: src/pagination.mjs:4 returns Math.floor(items / pageSize) + 1 | test/pagination.test.mjs expects pageCount(10, 5) to be 2"
    },
    {
      "id": "evidence_1",
      "text": "Option opt_report: src/report.mjs:4 only prints the number it receives"
    },
    {
      "id": "evidence_2",
      "text": "Option opt_cli: src/cli.mjs:4 loops over pages 1..3 and keeps the first label"
    },
    {
      "id": "evidence_3",
      "text": "Option opt_wrapper: src/utils/math.mjs has ceilDiv but nothing imports it"
    },
    {
      "id": "evidence_4",
      "text": "Option opt_tests: the test states the required behavior: 2 pages for 10 items"
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
      "probability": 0.982,
      "label": "likely",
      "auto": true
    },
    {
      "id": "proposition1",
      "probability": 0.61,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition2",
      "probability": 0.43,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "probability": 0.2,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition4",
      "probability": 0.12,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition5",
      "probability": 0.35,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition6",
      "probability": 0.4,
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
{"status":"selected","decision_id":"3f9c2a71d4e85b06","kind":"approach","threshold":0.95,"round":0,"calls":1,"tiebreaks":0,"scores":{"opt_pagination":0.982,"opt_report":0.61,"opt_cli":0.43,"opt_wrapper":0.2,"opt_tests":0.12,"action_gather_evidence":0.35,"action_ask_user":0.4},"plan":[{"id":"opt_pagination","action":"execute"}]}
```

**Comparison (strict, on the raw probabilities)**

| Option | probability | `> 0.95`? |
| --- | --- | --- |
| opt_pagination | 0.982 | yes |
| opt_report | 0.61 | no |
| opt_cli | 0.43 | no |
| opt_wrapper | 0.2 | no |
| opt_tests | 0.12 | no |
| action_gather_evidence | 0.35 | no |
| action_ask_user | 0.4 | no |

Only `opt_pagination` is strictly above 0.95. There is a single eligible option, so no `jev_decide` tie-break is needed (`jev_decide` needs at least two candidates, and its probabilities sum to 1 with its escape hatches, so it is never an eligibility test).

**Action:** run the first `execute` item, `opt_pagination`: edit `src/pagination.mjs`. The `reserve` items are not executed.

**Accounting:** 1 `tools/call` attempt (source `helper`) of the 25 for this user request. Provider calls inside the server: unknown.

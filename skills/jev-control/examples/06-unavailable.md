# 06 — Jev unavailable

Illustrative — not measured. Threshold `T = 0.95`. A transport failure, a timeout or an invalid response gets **exactly one identical retry**; then the step stops. There is no silent continuation with Claude's own judgment, and no "non-Jev" fallback.

**Round 0: batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which module should hold the fix for the extra empty page?",
  "kind": "approach",
  "options": [
    {
      "id": "opt_pagination",
      "text": "Fix the page count in src/pagination.mjs",
      "evidence": [
        "src/pagination.mjs:4 returns Math.floor(items / pageSize) + 1"
      ]
    },
    {
      "id": "opt_report",
      "text": "Subtract one page inside src/report.mjs",
      "evidence": [
        "src/report.mjs:4 prints the number it receives"
      ]
    },
    {
      "id": "opt_cli",
      "text": "Clamp the page number in src/cli.mjs",
      "evidence": [
        "src/cli.mjs:4 keeps the first label"
      ]
    },
    {
      "id": "opt_wrapper",
      "text": "Add a wrapper in src/utils/math.mjs",
      "evidence": [
        "src/utils/math.mjs has an unused ceilDiv"
      ]
    },
    {
      "id": "opt_tests",
      "text": "Change the failing test",
      "evidence": [
        "the test states the required behavior"
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
    "Taking option opt_pagination is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Fix the page count in src/pagination.mjs",
    "Taking option opt_report is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Subtract one page inside src/report.mjs",
    "Taking option opt_cli is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Clamp the page number in src/cli.mjs",
    "Taking option opt_wrapper is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Add a wrapper in src/utils/math.mjs",
    "Taking option opt_tests is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Change the failing test",
    "Taking option action_gather_evidence is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which module should hold the fix for the extra empty page? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option opt_pagination: src/pagination.mjs:4 returns Math.floor(items / pageSize) + 1"
    },
    {
      "id": "evidence_1",
      "text": "Option opt_report: src/report.mjs:4 prints the number it receives"
    },
    {
      "id": "evidence_2",
      "text": "Option opt_cli: src/cli.mjs:4 keeps the first label"
    },
    {
      "id": "evidence_3",
      "text": "Option opt_wrapper: src/utils/math.mjs has an unused ceilDiv"
    },
    {
      "id": "evidence_4",
      "text": "Option opt_tests: the test states the required behavior"
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

**Response 1** (Illustrative — not measured): transport failure `MCP server exited (code 3, signal none)`; the identical retry failed the same way (2 attempts).

**Helper output** (one line)

```json
{"status":"unavailable","message":"Jev unavailable: MCP server exited (code 3, signal none)","decision_id":"3f9c2a71d4e85b06","calls":2}
```

Both attempts carried the **same** arguments (Call 1 above, sent twice); the second one was the single allowed retry, and **both count** in the budget of 25 (2 of 25 used). The result is `unavailable` with the message "Jev unavailable".

**What the session does:** stop the controlled step and tell the user plainly: "Jev unavailable". Offer the user exactly two choices: wait or retry later (a new decision call), or turn the mode off with `/jev:jev-control off` and continue **uncontrolled** — an explicit choice of the user, never of the session. Do not pick an option "because Jev cannot be reached".

A valid answer below the threshold is *not* an error and is never retried (that is the expansion/ask rule). A missing core tool or credentials at activation refuse the mode instead.

**Accounting:** 2 attempts (source `helper`), reported as failed calls; none of them produced a score.

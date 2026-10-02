# 03 — Nothing above the threshold: expansion, then ask (or stop headless)

Illustrative — not measured. Threshold `T = 0.95`. Nothing is executed below the threshold: after at most **two expansion rounds**, each with genuinely new options or evidence, the session asks the user; in headless mode (`claude -p`) it stops with a report that starts `Incomplete:`.

**Request (synthetic):** "Load the configuration files. Pick the parser."

**Round 0: batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which library should parse the configuration files?",
  "kind": "approach",
  "options": [
    {
      "id": "opt_yaml",
      "text": "Use the yaml package that is already a dependency",
      "evidence": [
        "package.json lists yaml 2.x",
        "config/app.yaml is the main config"
      ]
    },
    {
      "id": "opt_toml",
      "text": "Add a TOML parser and convert the configs",
      "evidence": [
        "no TOML file exists yet"
      ]
    },
    {
      "id": "opt_json",
      "text": "Convert the configs to JSON and use JSON.parse",
      "evidence": [
        "config/app.yaml has comments that JSON cannot hold"
      ]
    },
    {
      "id": "opt_ini",
      "text": "Use an INI parser for the flat files",
      "evidence": [
        "config/legacy.ini is flat"
      ]
    },
    {
      "id": "opt_own",
      "text": "Write a small parser for the subset in use",
      "evidence": [
        "config/app.yaml uses 3 nesting levels"
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
    "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
    "Taking option opt_toml is the right next step for this decision: Which library should parse the configuration files? — Option: Add a TOML parser and convert the configs",
    "Taking option opt_json is the right next step for this decision: Which library should parse the configuration files? — Option: Convert the configs to JSON and use JSON.parse",
    "Taking option opt_ini is the right next step for this decision: Which library should parse the configuration files? — Option: Use an INI parser for the flat files",
    "Taking option opt_own is the right next step for this decision: Which library should parse the configuration files? — Option: Write a small parser for the subset in use",
    "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option opt_yaml: package.json lists yaml 2.x | config/app.yaml is the main config"
    },
    {
      "id": "evidence_1",
      "text": "Option opt_toml: no TOML file exists yet"
    },
    {
      "id": "evidence_2",
      "text": "Option opt_json: config/app.yaml has comments that JSON cannot hold"
    },
    {
      "id": "evidence_3",
      "text": "Option opt_ini: config/legacy.ini is flat"
    },
    {
      "id": "evidence_4",
      "text": "Option opt_own: config/app.yaml uses 3 nesting levels"
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
      "proposition": "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
      "probability": 0.81,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition1",
      "proposition": "Taking option opt_toml is the right next step for this decision: Which library should parse the configuration files? — Option: Add a TOML parser and convert the configs",
      "probability": 0.3,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition2",
      "proposition": "Taking option opt_json is the right next step for this decision: Which library should parse the configuration files? — Option: Convert the configs to JSON and use JSON.parse",
      "probability": 0.41,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option opt_ini is the right next step for this decision: Which library should parse the configuration files? — Option: Use an INI parser for the flat files",
      "probability": 0.2,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition4",
      "proposition": "Taking option opt_own is the right next step for this decision: Which library should parse the configuration files? — Option: Write a small parser for the subset in use",
      "probability": 0.25,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition5",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.5,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition6",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
      "probability": 0.45,
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
{"status":"expand","decision_id":"3f9c2a71d4e85b06","kind":"approach","threshold":0.95,"round":0,"calls":1,"tiebreaks":0,"reason":"none_above_threshold","expansions_left":2,"plan":[],"plan_total":0,"scores":["opt_yaml:0.81","action_gather_evidence:0.5","action_ask_user:0.45","opt_json:0.41","opt_toml:0.3","opt_own:0.25","opt_ini:0.2"],"scores_total":7}
```

Round 0 comparison: the best probability is 0.81, not above 0.95. Nothing is eligible, so the helper answers `expand` (2 rounds left). The session gathers evidence (it reads `package.json` and `src/load.mjs`) and calls again with the **same decision id** and a `new_material` note; resubmitting the same options is refused (`no_new_material`).

**Round 1 (expansion 1: new evidence from reading the repository): batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which library should parse the configuration files?",
  "kind": "approach",
  "space_small": true,
  "new_material": "package.json pins yaml 2.4 and src/load.mjs already imports it; legacy.ini is unused",
  "options": [
    {
      "id": "opt_yaml",
      "text": "Use the yaml package that is already a dependency",
      "evidence": [
        "src/load.mjs:1 already imports yaml",
        "package.json pins yaml 2.4"
      ]
    },
    {
      "id": "opt_json",
      "text": "Convert the configs to JSON and use JSON.parse",
      "evidence": [
        "config/app.yaml has comments that JSON cannot hold"
      ]
    }
  ]
}
```

**Helper command**

```sh
node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" decide --file /tmp/jc-batch.json --decision-id 3f9c2a71d4e85b06
```

**Call 2 — jev_noul** (sent by the helper; never in the model's context)

```json
{
  "propositions": [
    "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
    "Taking option opt_json is the right next step for this decision: Which library should parse the configuration files? — Option: Convert the configs to JSON and use JSON.parse",
    "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option opt_yaml: src/load.mjs:1 already imports yaml | package.json pins yaml 2.4"
    },
    {
      "id": "evidence_1",
      "text": "Option opt_json: config/app.yaml has comments that JSON cannot hold"
    },
    {
      "id": "evidence_2",
      "text": "Option action_gather_evidence: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "evidence_3",
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
      "proposition": "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
      "probability": 0.93,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition1",
      "proposition": "Taking option opt_json is the right next step for this decision: Which library should parse the configuration files? — Option: Convert the configs to JSON and use JSON.parse",
      "probability": 0.4,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition2",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.3,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
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

**Helper output** (one line)

```json
{"status":"expand","decision_id":"3f9c2a71d4e85b06","kind":"approach","threshold":0.95,"round":1,"calls":1,"tiebreaks":0,"reason":"none_above_threshold","expansions_left":1,"plan":[],"plan_total":0,"scores":["opt_yaml:0.93","opt_json:0.4","action_gather_evidence:0.3","action_ask_user:0.25"],"scores_total":4}
```

Round 1: 0.93 is still not above 0.95 (`expand`, 1 round left).

**Round 2 (expansion 2: a genuinely new option): batch** (written to `/tmp/jc-batch.json`, outside the repository)

```json
{
  "decision": "Which library should parse the configuration files?",
  "kind": "approach",
  "space_small": true,
  "new_material": "a new option: keep yaml but pin the parse options; the build log shows a warning about duplicate keys",
  "options": [
    {
      "id": "opt_yaml",
      "text": "Use the yaml package that is already a dependency",
      "evidence": [
        "src/load.mjs:1 already imports yaml",
        "the build log warns about duplicate keys in config/app.yaml"
      ]
    },
    {
      "id": "opt_yaml_strict",
      "text": "Use the yaml package in strict mode and fix the duplicate keys",
      "evidence": [
        "the yaml package has a strict option that rejects duplicate keys"
      ]
    }
  ]
}
```

**Helper command**

```sh
node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" decide --file /tmp/jc-batch.json --decision-id 3f9c2a71d4e85b06
```

**Call 3 — jev_noul** (sent by the helper; never in the model's context)

```json
{
  "propositions": [
    "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
    "Taking option opt_yaml_strict is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package in strict mode and fix the duplicate keys",
    "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
    "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion."
  ],
  "context": [
    {
      "id": "evidence_0",
      "text": "Option opt_yaml: src/load.mjs:1 already imports yaml | the build log warns about duplicate keys in config/app.yaml"
    },
    {
      "id": "evidence_1",
      "text": "Option opt_yaml_strict: the yaml package has a strict option that rejects duplicate keys"
    },
    {
      "id": "evidence_2",
      "text": "Option action_gather_evidence: Always available as an option (D6): the control option, not a repository fact."
    },
    {
      "id": "evidence_3",
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

**Response 3 (Illustrative — not measured)**

```json
{
  "tool": "jev_noul",
  "status": "ok",
  "results": [
    {
      "id": "proposition0",
      "proposition": "Taking option opt_yaml is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package that is already a dependency",
      "probability": 0.94,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition1",
      "proposition": "Taking option opt_yaml_strict is the right next step for this decision: Which library should parse the configuration files? — Option: Use the yaml package in strict mode and fix the duplicate keys",
      "probability": 0.9,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition2",
      "proposition": "Taking option action_gather_evidence is the right next step for this decision: Which library should parse the configuration files? — Option: Gather more evidence before acting: read or run something that could change the choice.",
      "probability": 0.2,
      "label": "uncertain",
      "auto": false
    },
    {
      "id": "proposition3",
      "proposition": "Taking option action_ask_user is the right next step for this decision: Which library should parse the configuration files? — Option: Ask the user which option to take. Concrete action: AskUserQuestion.",
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
{"status":"ask_user","decision_id":"3f9c2a71d4e85b06","kind":"approach","threshold":0.95,"round":2,"calls":1,"tiebreaks":0,"reason":"none_above_threshold","report":"no option exceeded T=0.95 after 2 expansion round(s); scores: opt_yaml=0.94, opt_yaml_strict=0.9, action_gather_evidence=0.2, action_ask_user=0.2","plan":[],"plan_total":0,"scores":["opt_yaml:0.94","opt_yaml_strict:0.9","action_gather_evidence:0.2","action_ask_user:0.2"],"scores_total":4}
```

Round 2: 0.94 is still not above 0.95 and no expansion is left, so the status is `ask_user`. Show the user the options and the scores, and wait. The user may approve one option explicitly; that is recorded as an override of exactly that option (`cli.mjs approve --decision 3f9c2a71d4e85b06 --option opt_yaml --message "<the user's words>"`).

**Headless variant** (`--headless`, or `JEV_CONTROL_HEADLESS=1`): the same final round ends with

```json
{"status":"incomplete","decision_id":"3f9c2a71d4e85b06","kind":"approach","threshold":0.95,"round":2,"calls":1,"tiebreaks":0,"reason":"none_above_threshold","report":"Incomplete: no option exceeded T=0.95 after 2 expansion round(s); scores: opt_yaml=0.94, opt_yaml_strict=0.9, action_gather_evidence=0.2, action_ask_user=0.2","plan":[],"plan_total":0,"scores":["opt_yaml:0.94","opt_yaml_strict:0.9","action_gather_evidence:0.2","action_ask_user:0.2"],"scores_total":4}
```

and the session's final message is that report, starting `Incomplete:`, with no action taken. For a scenario that expects it, this is the correct stop.

**Accounting:** 3 `jev_noul` attempts across the three rounds (source `helper`); no tie-break was needed because nothing was eligible.

---
description: Switch the prompt check on or off for this session (on/off/status/threshold/lang). When on, Jev checks each later prompt and shows the user one short tip line only if it is at least `threshold` sure of a problem.
argument-hint: on [threshold] | off | status | threshold <x> | lang auto|ro|en
---

Run the prompt-check command for this request: `$ARGUMENTS`

Run exactly one of these (plugin root in Claude Code: `${CLAUDE_PLUGIN_ROOT}`) and show its output as it is:

- `on` (optionally followed by a threshold above 0.5 and below 1; default 0.90): `node "${CLAUDE_PLUGIN_ROOT}/private/jev-prompt-check/cli.mjs" on [<threshold>]`
- `off`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-prompt-check/cli.mjs" off`
- `status`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-prompt-check/cli.mjs" status`
- `threshold <x>`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-prompt-check/cli.mjs" threshold <x>` (an invalid value keeps the old one and prints one notice).
- `lang auto|ro|en`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-prompt-check/cli.mjs" lang <auto|ro|en>` (the language of the tips; default `auto`: Romanian or English per prompt, detected locally; `ro` or `en` forces one language).

With no or unknown arguments run `status` and explain the five commands in one short paragraph. Never run `on` unless the user asked for it: the check is off by default and never turns itself on.

The session identity comes from the session itself: `CLAUDE_CODE_SESSION_ID`, or the capability the prompt hook injected into your context for this request (`Session capability: pass --session-cap <cap> ...`). When the hook gave you one, add `--session-cap <cap>` to the command above. Never pass a made-up `--session-id` or a capability that did not appear in your own context; with no identity the helper refuses and nothing is changed.

What it does, if the user asks (full text: `private/jev-prompt-check/README.md`): from the second prompt of the session on, Jev compares the prompt with the last reply of the assistant and, only when it is at least `threshold` sure that the prompt is unclear or unrelated to that reply, shows the user one fixed tip line. The model never sees the tips and the prompt is never changed. State holds the settings and two counters only; it ends with the session. It is off by default and never turns itself on. At the default threshold 0.90 it is silent most of the time (6 of 114 real prompts got a tip in a measurement, about one in 19, and about half of those were clearly right). The last 1500 characters of the previous assistant reply and the first 1500 characters of the prompt are sent to the Jev provider; nothing is written to disk but settings and counters.

---
description: Put this session under Jev control (on/off/status/threshold). Every choice with two or more real alternatives is then decided by Jev at a configurable confidence (default 0.95).
argument-hint: on [threshold] | off | status | threshold <x>
---

Run the jev-control command for this request: `$ARGUMENTS`

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/jev-control/SKILL.md` once and follow it for the whole session while the mode is on. (The skill has the same name as this command, so the Skill tool returns this text and never that file: read it with `Read`.)
2. Run exactly one of these (plugin root in Claude Code: `${CLAUDE_PLUGIN_ROOT}`) and show its compact output:
   - `on` (optionally followed by a threshold in (0.5, 1)): derive the **priorities** from the user's explicit request and constraints in one line, then
     `node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" on [--threshold <x>] --priorities "<one line>"`
     The helper checks the repository policy, Node 22, the real session identity and the Jev tool contracts. If it refuses, report the reason and stay off: do not invent an identity or retry with different arguments. After `on`, show the priorities once and say the user may correct them.
   - `off`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" off`
   - `status`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" status`
   - `threshold <x>`: `node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" threshold <x>` (it applies to later decisions only; an invalid value gives 0.95 and one notice).
3. With no or unknown arguments: when the prompt hook put the line «jev-control was requested by the user for this session» in your context (a natural-language request such as «Let Jev control this session»), run `on` as above; otherwise run `status` and explain the four commands.

The session identity comes from the session itself: `CLAUDE_CODE_SESSION_ID`, or the capability the prompt hook injected into your context for this request (`Session capability: pass --session-cap <cap> ...`). When the hook gave you one, add `--session-cap <cap>` to every `cli.mjs` command above and to the prompt of every subagent. Never pass a made-up `--session-id` or a capability that did not appear in your own context; with no identity the helper refuses and nothing is activated.

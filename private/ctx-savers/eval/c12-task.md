# C12 task and arms (fixed 2026-10-11 BEFORE any C12 session; read by eval/c12-run.mjs)

Candidate: an instruction only, no script: "independent calls in the same turn" and "write and run a script in one call".
Design: 3 pairs (A1 B1, A2 B2, A3 B3), Sonnet 5.5, confined (sandboxed Bash writes only to its own t/ folder, path-scoped Read/Grep/Glob, no MCP, no plugins, dontAsk), cap 0.15 USD per session.
The folder PROJECT is a copy of private/ctx-savers (sources, tests, rule files; no result files) made for each session.
Metric: model calls = distinct assistant message ids (one call can carry several tool calls); also tool calls, cost. Gate: arm B makes at least 2 fewer model calls than arm A in at least 2 of 3 pairs, and every answer in the pair is right.
Floor note written in advance: the least possible is 2 model calls (one with all tool calls, one with the answer). If arm A already averages 3 or fewer, the gate cannot be met and the result is "no room to save on this task".

## Arm A prompt
```
Work in the folder PROJECT (your current directory has a subfolder named project). Answer these four independent questions about it, then give the four answers as four short numbered lines and nothing else.
1. How many lines does ui-digest.mjs have?
2. In which file and on which line is the function `shrink` defined?
3. What exit code does ui-step.mjs use when it refuses to tap or stops (forbidden label, label not allowed, label not found, ambiguous label, login or error screen)?
4. How many files with the extension .mjs are in the project folder, counting all subfolders?
This is read-only: do not modify anything.
```

## Arm B extra (appended after the arm A prompt, one blank line between)
```
Work efficiently: when several tool calls do not depend on each other, issue them in the same turn, and when several lookups can be done by one shell script, write and run that script in a single Bash call.
```

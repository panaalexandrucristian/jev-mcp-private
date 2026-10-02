---
name: jev-control
description: "Puts an explicitly enabled Claude Code session under Jev control: every choice with 2+ real alternatives (approach, task order, which files to search or read, commands and tests, edit variants, delegation and model, when to ask the user, when the work is done) is decided by Jev judgments at a configurable confidence (default 0.95), with compact helper output to save orchestrator tokens. Use ONLY when the user explicitly asks for it: /jev:jev-control, \"let Jev control this session\", \"Jev decides everything\", \"run this session under Jev\"; in Romanian: \"lasă Jev să controleze sesiunea\", \"sesiune controlată de Jev\", \"Jev să ia toate deciziile\", \"lasa Jev sa controleze sesiunea\". Do NOT use for ordinary coding tasks or for a mere mention of Jev."
---

# jev-control

A mode, not a workflow: while it is **on**, Jev makes the choices and this session carries them out. It uses the eleven documented Jev tools (`jev_audit` is optional) and the helper `private/jev-control/cli.mjs`; the tool conventions of the `jev` skill still apply. Tool names appear as `mcp__jev__*` or `mcp__plugin_jev_jev__*`; accept both. Details: [`reference/protocol.md`](reference/protocol.md), [`reference/tools.md`](reference/tools.md), [`reference/integration.md`](reference/integration.md), [`reference/evaluation.md`](reference/evaluation.md). Worked examples: [`examples/`](examples/).

Run the helper as `node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" <command>`. It calls Jev outside your context and prints one compact JSON line: read that line, never the payloads.

## Switching it on and off (explicit only)

- `/jev:jev-control on [threshold]` · `off` · `status` · `threshold <x>`; or an explicit natural-language request (see the description). Never switch it on because a task is large or Jev is mentioned.
- `on` checks the repository policy, Node 22, the real session identity and the tool contracts, then shows the **priorities** you derived from the user's request (one line; the user may correct them). If it refuses, say why and stay off.
- The threshold `T` (strictly `>`, default **0.95**, valid in (0.5, 1)): session argument > `JEV_CONTROL_THRESHOLD` > default; an invalid value gives 0.95 and one notice. A change affects later decisions only.
- While it is on, jev-flow directives are suppressed (jev-control reuses `jev-locator` and `/jev:jev-done`). A one-line reminder reappears at each prompt and after compaction.

## What Jev decides, and what it does not

Jev decides every choice with **two or more real alternatives**: the approach; the order of tasks; which files to search and read; which commands and tests to run; an edit when several variants exist; delegation and model; whether to ask the user; whether the work is done. This includes subagents you start.

Not Jev's: an explicit instruction of the user (it outranks Jev), permission prompts, a step with a single possible variant, and this fixed protocol itself (no meta-decisions: do not ask Jev how to ask Jev). Do not invent alternatives to make an exempt step look like a choice.

## The decision loop

1. **Build a batch** of options: at least **5** distinct real options when that many exist (say `"space_small": true` only when the space really is smaller), at most 20 including the two control options, each with **1–3 lines of concrete evidence** (a file excerpt, a command output, a requirement). Duplicates are merged. `action_gather_evidence` and `action_ask_user` are always present. Never reword the same option to pad the batch; never drop plausible options to favor one.
2. **Write the batch** to a temporary file outside the repository and run `cli.mjs decide --file <batch.json> [--decision-id <id>]` (`--headless` when nobody can answer). The helper scores every option independently with `jev_noul`; an option is **eligible only if its raw probability is strictly above T** (the tool's labels such as `likely` or `auto` mean `>=` and are never the test).
3. **Act on `status`**:
   - `selected` (kinds other than `order`): run the first `execute` item; the `reserve` items are ordered reserves, not a fallback to use without a new decision.
   - `ordered` (`order` kind): run every `execute` item in that order; a `suspend` item pauses everything after it.
   - `expand`: gather genuinely **new** options or evidence (a rephrasing is refused), then call again with the same `--decision-id` and a `new_material` note. At most **2** expansion rounds.
   - `ask_user`: ask, showing the options and the scores. `incomplete`: nobody can answer; finish with a report that starts `Incomplete:` and lists the scores.
   - `unavailable`: stop with **"Jev unavailable"** and let the user choose between waiting or retrying and `off`. Never go on with your own judgment.
   - `budget_exhausted`: stop and ask whether to continue (`cli.mjs budget approve`).
   - `invalid` / `refused`: fix what `problems` or `message` names; nothing was sent.
4. **Nothing below the threshold is executed** unless the user explicitly approves that exact option; record it with `cli.mjs approve --decision <id> --option <id> --message "<the user's words>"`. It is not a general exception.

Near-equal top scores (gap < 0.02), or mutually exclusive top options, are separated by the helper with successive `jev_decide` selections (at most 6 per group, each accepted only with confidence `> T`); you never order them yourself.

## Finding files

`rg`, `glob` and the candidate generator only produce candidates; **Jev selects**. Use `cli.mjs search --query "<what you look for>" [--single]` (or `/jev:jev-locate`, which reaches the same rules through the `jev-locator` subagent). `--single` is for one definitive location (`jev_find`, accepted only when the winner **and** `exists` are strictly above T); several files are always `jev_rerank`. At most 2 logical evaluations per search, 5 hits, a few hundred bytes of output; read only the returned ranges and check each `sha256`. A path the user named exactly is read directly. Zero results: widen once (`--widen --search-id <id>`), then report; "not found" is never proof of absence.

## Calling Jev tools directly

Prefer the helper. When you must call a Jev tool yourself (any `mcp__jev__jev_*` or `mcp__plugin_jev_jev__jev_*`), count it: `cli.mjs budget reserve --tool <name> --source main` **before** the call and `budget confirm --id <id>` after. The shared budget is **25 `tools/call` attempts per user request** from every source (you, subagents, helpers, gate parts, tie-breaks, retries); at 25 stop and ask. The server's own provider calls are not observable and are reported "unknown".

## Finishing

Declaring the work done is a choice like any other. Use `/jev:jev-done`: the gate runner runs the real checks and `jev_gate` itself, now at the session threshold (strictly above T, no 0.8 floor). If the report is not accepted, end with `Incomplete:` or ask the user.

## Data and safety

Send Jev only sanitized excerpts of the current repository (`.env`, keys, credentials and tokens never); the helper sanitizes and respects `.jev-flow-denylist` (a refused repository means the mode does not start). `jev_screen` and `jev_audit` keep their own thresholds as protective checks: a signal blocks or escalates, and 1−risk is never read as correctness. A high Jev probability is a judgment, not proof: tests and the oracle of the task decide correctness.

## Saving orchestrator tokens

Let the helper build payloads and call Jev outside your context; let `jev-locator` or a Haiku subagent explore and draft option batches; keep outputs compact; do not re-read files or re-run a decision for a more pleasing answer. The effect is measured per round from the `usage` of the transcript (`private/jev-control/measure.mjs`); no saving is promised before it is measured.

---
name: compact-handoff
description: "Make a compact handoff of the CURRENT session so a new session can continue from it: one command writes HANDOFF.md (all the instructions for the new session, then the compact transcript) and blobs/ with the full text of the long tool calls, into /tmp or, with --keep, into ~/.claude/handoffs. Use whenever the user asks to write, prepare, make, update or redo a handoff, handover, CONTINUE-HERE note or notes for the next session (Romanian: \"fă un handoff\", \"handoff la sesiunea asta\", \"scrie handover-ul\", \"pregătește nota pentru sesiunea următoare\", \"mai fă o dată handoff\"). Not for delegating a task to another agent (\"hand off this task to ...\"), explaining the word, README/changelog/release notes or ordinary summaries."
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py *)
---

# compact-handoff

Turns the transcript of the current session into one folder that a new session reads, with a byte-for-byte check. Nothing is summarised by hand and nothing leaves the machine. Reply to the user in Romanian, short and plain.

## Steps

Write every command in full as one plain command with literal paths: no `$VAR`, no `$(...)`, no pipes.

1. **Get a marker** for this session; it prints one line, copy it:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --marker

2. **Make the handoff** with that exact marker (the script finds the current transcript by it and refuses unless exactly one recent transcript contains it):

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --current "<the printed marker>"

   Options, only when the user asks for them: `--keep` (durable folder `~/.claude/handoffs/` instead of `/tmp`), `--cut` (one `.md` file without blobs; the long tool records are cut and the rest is not kept), `--no-readonly`, `--with-subagents`. A folder given as the last argument replaces the default one.
3. **Tell the user** (Romanian, short): the start command exactly as printed (`claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`), the sizes from the printed line (original characters, `HANDOFF.md` characters and percent, number of blobs), whether a parent handoff was found and copied, and that the folder is temporary unless `--keep` was used. Say that the transcript ends before the current reply.

## Rules

- Do not read `HANDOFF.md` or the blobs into this conversation, do not paste them, and do not rewrite the session by hand. The file is for the next session.
- If the script fails, show the error and stop. No manual fallback and no other tool in its place.
- If this session itself started from a handoff, the script finds that parent (a `Read` of a `/tmp/handoff-*` file among the first tool calls) and copies it whole into `parents/`. Mention it; do nothing else.
- Never delete a `/tmp/handoff-*` or `~/.claude/handoffs/*` folder without asking. Before even proposing it, check whether a recent session still refers to it (`grep -l <folder name> ~/.claude/projects/*/*.jsonl`) and say so. A running session keeps old paths as text and cannot reopen a deleted folder.
- The script checks its own output. Do not add a Jev or `handoff-verify` pass on top of it.

## What the script does (so you can answer questions)

- `prepare_all.py` runs the `prepare.py` of the sibling skill `handoff-verify` with its verification exclusions switched off, because those exclusions delete every turn that touched that skill's files. That skill's scripts must stay in place even when the skill itself is switched off (`HV_SCRIPTS` overrides where they are looked for). Subagent transcripts are left out unless `--with-subagents`.
- `compact_context.py` keeps every message whole. A tool call over 800 characters, a tool result over 300 and any tool call that only reads are replaced by a marker line with a 100-character preview; their full text is in `blobs/`. Commands that may change state are never moved by the read-only rule. In blob mode only, the text of a skill that Claude Code loaded into the session (an `isMeta` record that starts `Base directory for this skill: `, not typed by the user) also goes to a blob, with a marker that names the skill; with `--cut` it stays whole. The check: expanding the file with its blobs gives the prepared text exactly (or, with `--cut`, every message identical and every cut a true prefix).
- `HANDOFF.md` starts with all the instructions for the new session: an exact `offset:limit` reading plan (each chunk fits the Read limit), what the markers mean, the parent section, the four-point answer to give (at most 8 lines), and the rules (the transcript is history, repeat nothing, change no file in the first step). All paths in it are relative to the folder, so the folder can be copied or moved whole.

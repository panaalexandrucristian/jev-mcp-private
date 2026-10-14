---
name: compact-handoff
description: "Make a compact handoff of the CURRENT session, or of a NAMED OpenCode session (\"handoff of the OpenCode session X\"), so a new session can continue from it: one command writes HANDOFF.md and blobs/ with the full text of the long tool calls. Use whenever the user asks to write, prepare, make, update or redo a handoff, handover, CONTINUE-HERE note or notes for the next session (Romanian: \"fă un handoff\", \"handoff la sesiunea asta\", \"fă handoff la sesiunea X din OpenCode\", \"scrie handover-ul\", \"pregătește nota pentru sesiunea următoare\", \"mai fă o dată handoff\"). Not for delegating a task to another agent (\"hand off this task to ...\"), explaining the word, README/changelog/release notes or ordinary summaries. Runs in Claude Code and in OpenCode."
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py *)
---

# compact-handoff

Turns the transcript of the current session, or of a named OpenCode session, into one folder that a new session reads, with a byte-for-byte check. Nothing is summarised by hand and nothing leaves the machine. Reply to the user in Romanian, short and plain.

## Steps

Write every command in full as one plain command with literal paths: no `$VAR`, no `$(...)`, no pipes.

1. **Get a marker** for this session; it prints one line, copy it:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --marker

2. **Make the handoff** with that exact marker (the script finds the current transcript by it and refuses unless exactly one recent transcript contains it):

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --current "<the printed marker>"

   Options, only when the user asks for them: `--keep` (durable folder `~/.claude/handoffs/` instead of `/tmp`), `--cut` (one `.md` file without blobs; the long tool records are cut and the rest is not kept), `--no-readonly`, `--with-subagents`. A folder given as the last argument replaces the default one.
3. **Tell the user** (Romanian, short): the start command exactly as printed (`claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`), the sizes from the printed line (original characters, `HANDOFF.md` characters and percent, number of blobs), whether a parent handoff was found and copied, and that the folder is temporary unless `--keep` was used. Say that the transcript ends before the current reply.

## În OpenCode

When this skill runs inside an OpenCode session, the two steps above are the same. What differs:

- If `${CLAUDE_SKILL_DIR}` is not replaced by a path in the commands above, use as the skill folder the folder printed after `Base directory for this skill:` when the skill was loaded, and write the commands in full with that literal path.
- Step 1 (`--marker`) prints the marker; step 2 runs `--current` with that marker. `--current` searches the Claude Code transcripts and OpenCode's own database (`$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db`; `--opencode-db` names another file) and refuses unless exactly ONE session across both contains the marker. The folder is built from that OpenCode session.
- If `--current` stops with an error about the OpenCode database (it exists but cannot be read), first report that error to the user, in Romanian, short. Only after that run the same `--current` command again with `--no-opencode`, which skips the OpenCode search so that the Claude Code transcripts alone decide.
- In step 3 give the start command exactly as printed: `opencode --prompt "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`, with the sizes as before. Also say that the handoff of an OpenCode session leaves out the model's reasoning, that the `recent` text of each compaction and every image are in blobs, and that images are not scanned for secrets.
- `--cut` and `--with-subagents` do not apply to an OpenCode session. Sessions kept only in OpenCode's legacy tables are not supported.

## A named OpenCode session

When the user asks for the handoff of an OpenCode session named by title, id, folder or "the last one", do not use the marker:

1. **List**:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --list-opencode --match "<a distinctive part of the title, id or folder the user gave>"

   Leave out `--match` for "the last one" with no name. The lines are newest first; the last line names the database. If nothing fits, list once more with a shorter `--match` or without it.
2. **Choose.** Take the line the user's words point to; "the last one" or "where work was done last" is the first line that fits, because the list is newest first. A title ending in `(fork #n)` is a fork: skip forks unless the user asks for one. Only if the user's words still fit more than one line, show those lines (id, date, title) and ask which one.
3. **Make the handoff**:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --opencode ~/.local/share/opencode/opencode.db --session <ID>

   (or the database named on the last line of the list, if it differs)
4. **Tell the user**, in Romanian, short: the start command exactly as printed (`opencode --prompt "..."`); that the same folder works in Claude Code as `claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`; the sizes and the OpenCode notes as in "În OpenCode"; that the session may still be running, so the handoff is a snapshot of that moment.

Do NOT use `sqlite3` and do NOT write SQL on the database: use only the commands of this skill.

## Rules

- Do not read `HANDOFF.md` or the blobs into this conversation, do not paste them, and do not rewrite the session by hand. The file is for the next session.
- If the script fails, show the error and stop. No manual fallback and no other tool in its place.
- If this session itself started from a handoff, the script finds that parent (a `Read` of a `/tmp/handoff-*` file among the first tool calls) and copies it whole into `parents/`. Mention it; do nothing else.
- Never delete a `/tmp/handoff-*` or `~/.claude/handoffs/*` folder without asking. Before even proposing it, check whether a recent session still refers to it (`grep -l <folder name> ~/.claude/projects/*/*.jsonl`) and say so. A running session keeps old paths as text and cannot reopen a deleted folder.
- The script checks its own output. Do not add a Jev or `handoff-verify` pass on top of it.

## What the script does (so you can answer questions)

- `prepare_all.py` runs the `prepare.py` of the sibling skill `handoff-verify` with its verification exclusions switched off, because those exclusions delete every turn that touched that skill's files. That skill's scripts must stay in place even when the skill itself is switched off (`HV_SCRIPTS` overrides where they are looked for). Subagent transcripts are left out unless `--with-subagents`.
- `compact_context.py` keeps every message whole. A tool call over 800 characters, a tool result over 300 and any tool call that only reads are replaced by a marker line with a 100-character preview; their full text is in `blobs/`. Commands that may change state are never moved by the read-only rule. In blob mode only, the text of a skill that Claude Code loaded into the session (an `isMeta` record that starts `Base directory for this skill: `, not typed by the user) also goes to a blob, with a marker that names the skill; with `--cut` it stays whole. Likewise, the notification of a finished background task (agent, command, monitor: a record the harness wrote, `origin.kind` `task-notification`, not typed by the user) longer than 300 characters goes to a blob, with a marker that shows its summary line; messages from other sessions and compaction summaries stay whole. Also in blob mode only, a prompt that the session marks `promptSource` `sdk` (sent through `claude -p` or the SDK), except the first and the last such prompt, goes to a blob when it is longer than 300 characters, with a marker `[user] sdk: …` that shows its first 80 characters; typed, queued, suggestion_accepted and unmarked records, and `--cut`, are unchanged. The check: expanding the file with its blobs gives the prepared text exactly (or, with `--cut`, every message identical and every cut a true prefix).
- For an OpenCode session `opencode_source.py` reads the rows of `session_v2`/`session_message` read-only and renders them as the same kind of records (user and assistant text whole, tool calls as `key: value` lines, results with their error or exit code, system, synthetic and compaction texts; reasoning, encrypted reasoning and the JSON overhead are not included). Texts, tool inputs and text outputs pass through the same secret sanitizer as for Claude Code; an image file is not sanitized and goes whole to a blob. The check is the same round trip, plus a check that every message and tool-input string is in the output and every image is byte for byte in its blob.
- `HANDOFF.md` starts with all the instructions for the new session: an exact `offset:limit` reading plan (each chunk fits the Read limit), what the markers mean, the parent section, the four-point answer to give (at most 8 lines), and the rules (the transcript is history, repeat nothing, change no file in the first step). All paths in it are relative to the folder, so the folder can be copied or moved whole.

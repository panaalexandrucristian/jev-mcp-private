# Prompt check

An opt-in feature of the Claude Code plugin (`/jev:prompt-check`). When you switch it on for the current session, every prompt after the first is checked by Jev against the assistant's last reply. When Jev is at least `threshold` sure of a problem, one short tip line is shown to you (not to the model): the prompt may be unclear (a target or scope may be missing), or it does not look related to the last reply (consider `/clear`).

## Commands

`/jev:prompt-check on [threshold]` | `off` | `status` | `threshold <x>` | `lang auto|ro|en`

- Default threshold 0.90; valid range above 0.5 and below 1. An invalid value keeps the old one and prints one notice.
- Language of the tips: `auto` (default) picks Romanian or English for each prompt, so both work in one session; `ro` or `en` forces one language. `auto` looks at the words and diacritics of your prompt (Romanian written without diacritics works too), then at the previous reply, then falls back to English. It is a local word-list check: no extra Jev call, no extra time. Prompts with no clear signal (for example `git status`) follow the previous reply.
- `status` prints on/off, the threshold, the language, how many prompts were checked and how many tips were shown in this session.

## Behaviour

- **Off by default.** It never turns itself on. The state belongs to one Claude Code session (settings and two counters only, in `prompt-check.json` beside the jev-control session state); a new, resumed or cleared session is always off, a compaction keeps it.
- **Silent most of the time.** At the default threshold 0.90, 6 of 114 real prompts got a tip in a measurement (about one in 19, about half of them clearly right), so no output is the normal result.
- **Skipped without any Jev call:** mode off, the first prompt of the session, a prompt with no previous assistant text, a prompt shorter than 8 characters, a prompt starting with `/`.
- **Two checks in parallel** (`jev_classify` through the jev-flow MCP client): ambiguity (`clear` / `needs_clarification`, `auto_accept` = threshold) and relatedness (`related` / `unrelated`). A tip needs the winning class `needs_clarification` or `unrelated` with top probability >= threshold (inclusive). At most one fixed line per check (two lines), from a table keyed by language; the tips never contain model-written text.
- **Never** blocks a prompt, changes it, or adds a tip to the model's context. The only context it adds is one session-identity line for the `/jev:prompt-check` command prompt itself.
- **Fails silent and fast:** any error, missing key, invalid Jev answer or timeout (4 s for both checks together, including the connection) gives no output, exit code 0 and at most one stderr line.

## Privacy

For each checked prompt the last 1500 characters of the previous assistant reply and the first 1500 characters of your prompt are sent to the Jev provider you configured (the same one as for the Jev tools). Nothing else is sent. Prompts and replies are never written to disk or logs.

## Files

`cli.mjs` (the command), `hook.mjs` (UserPromptSubmit and session reset), `check.mjs` (the two checks), `transcript.mjs` (last assistant text), `state.mjs`, `messages.mjs`, `language.mjs` (language detection); tests in `test/`.

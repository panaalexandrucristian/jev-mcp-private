// Compact usage text for `cli.mjs help [command]` and `cli.mjs <command> --help` (R04). A session that cannot Read
// skills/jev-control/SKILL.md (a Read outside the working directory is refused in a headless run) has nothing else that
// says what a batch looks like: two dev sessions tried `--help`, and one spent five invalid `decide` calls finding the format.
// No session, repository or Jev call is needed; each topic stays well under the 1.5 KB output cap.

const DECIDE = [
  'decide --file <batch.json|-> [--decision-id <id>]. The batch is one JSON object:',
  '{"decision":"<the question>","kind":"order|approach|command|edit|delegate|ask|done","options":[{"id":"<lowercase slug>","text":"<what it is>","evidence":["<1-3 concrete lines>"],"action":{"tool":"Edit","target":"<path>","old_string":"..","new_string":".."}}],"new_material":"<expansion rounds only>"}',
  '- 5 to 18 real options; the limit 20 counts action_gather_evidence and action_ask_user, added if missing. "space_small":true only when fewer real alternatives exist.',
  '- kinds order, command, edit, delegate: each option needs "action", the ONE tool call it stands for, with its arguments (Edit old_string+new_string, Write content, Agent prompt+model; command: Bash only, edit: edit tools only, delegate: Agent only). Other kinds: optional.',
  '- kind order is for several tasks: one option per task, each with its own action, all in one batch; every eligible one is planned in the order to run. Any other kind runs only the first option.',
  '- Make the batch file with the Write tool (a heredoc can be refused), delete it after; run the command as is: a pipe after it voids the grant.',
  '- status: selected/ordered: do exactly the plan items (e = execute). expand: only NEW options or evidence help; add them, set "new_material", rerun with the SAME --decision-id (2 rounds; no --decision-id = a new decision). ask_user: ask the user. incomplete: end with "Incomplete:" and the scores. invalid: fix what "problems" names.',
].join("\n");

const SEARCH = [
  'search --query "<what you look for, in a sentence>" [--single] [--exact-path <path>] [--widen --search-id <id>]',
  'Finds files instead of your own grep or glob: one compact JSON line with ranked hits {path,start_line,end_line,sha256,score}. Read exactly the returned range and check the sha256. Run it as is: a pipe after it (`| head`) voids the grant.',
  '--single asks for one definitive location; several files are always ranked. Zero results: --widen --search-id <id> once, then report; "not found" is never proof of absence.',
].join("\n");

const LINES = {
  on: "on [--threshold <x>] [--priorities \"<one line>\"]: switch the mode on (the threshold is strictly > T, valid in (0.5, 1), default 0.95).",
  off: "off: switch the mode off.",
  status: "status: show the mode, threshold and priorities.",
  threshold: "threshold <x>: change the threshold for later decisions (valid in (0.5, 1); an invalid value gives 0.95).",
  page: "page --decision <id> [--part plan|scores] [--from <n>]: the rest of a plan or score list the printed line cut (plan_next / scores_next).",
  approve: "approve --decision <id> --option <id> --message \"<the user's own words naming the option>\" [--question \"<the question a short answer answers>\"]: record a user approval of a below-threshold option.",
  budget: "budget status | reserve --tool <name> [--source main|subagent] | confirm --id <id> | release --id <id> | approve --message \"<the user's words>\": the 25 tools/call attempts per request.",
  receipt: "receipt verify --id <receipt> --option <id> (--action-file <file|-> | --tool T --target t) [--dry-run]: check an option's action right before running it.",
  done: "done --claims <file|-> [--check '[\"cmd\",\"arg\"]']...: the completion gate; normally run through /jev:jev-done.",
};

const OVERVIEW = [
  "Usage: cli.mjs on|off|status|threshold <x>|decide|search|approve|budget|receipt|done  (see the header of cli.mjs)",
  "Per command: cli.mjs help decide | search | on | page | approve | budget | receipt | done (the same as <command> --help).",
].join("\n");

/** The help text for a topic (a command name); the overview for no or an unknown topic. */
export function helpText(topic) {
  if (topic === "decide") return DECIDE;
  if (topic === "search") return SEARCH;
  if (typeof topic === "string" && Object.hasOwn(LINES, topic)) return LINES[topic];
  return OVERVIEW;
}

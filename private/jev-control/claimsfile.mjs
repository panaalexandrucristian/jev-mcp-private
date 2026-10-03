// R07: the completion gate must be reachable in a headless session, where a Write outside the working directory (the
// /tmp claims file of /jev:jev-done) is refused, a heredoc or an inline JSON with braces and quotes is refused ("brace with quote
// character") and a claims file left in the repository would itself be one more new file of the diff the gate judges.
// So `done --claims jev-claims*.json` CONSUMES a claims file the model wrote in the repository root: the helper reads it, checks it,
// and removes it before the gate takes its snapshot. Anything else keeps the old behaviour (an external file or `-` is read and left
// alone) or is refused without touching it: a file the helper may delete must be provably the model's scratch file.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCheckArgv, RUN_LIMITS, validateRunInput } from "../jev-flow/gate-run.mjs";

export const CLAIMS_NAME = /^jev-claims[A-Za-z0-9_.-]*\.json$/;
export const CLAIMS_NAME_MAX = 120;
const MAX_BYTES = 1024 * 1024;

export class ClaimsRefused extends Error {}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The real path of the nearest existing ancestor joined with the rest: where `path` would be even if it does not exist yet. */
function realish(path) {
  const own = real(path);
  if (own) return own;
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(realish(parent), basename(path));
}

/** True when a plain name could be consumed: `jev-claims*.json`, at most 120 bytes, no directory part. */
export function consumableClaimsName(name) {
  return typeof name === "string" && Buffer.byteLength(name) <= CLAIMS_NAME_MAX && CLAIMS_NAME.test(name);
}

function runGit(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
}

/** Tracked or ignored files are never consumed; a git failure is a refusal, never proof that the file is untracked. */
function untrackedAndNotIgnored(root, name, git) {
  const listed = git(root, ["ls-files", "--cached", "-z", "--", name]);
  if (listed.error || listed.status !== 0) return { ok: false, why: "git could not say whether the claims file is tracked" };
  if (listed.stdout !== "") return { ok: false, why: "the claims file is tracked by git" };
  const ignored = git(root, ["check-ignore", "-q", "--", name]);
  if (ignored.error) return { ok: false, why: "git could not say whether the claims file is ignored" };
  if (ignored.status === 1) return { ok: true };
  return { ok: false, why: ignored.status === 0 ? "the claims file is ignored by git" : "git could not say whether the claims file is ignored" };
}

/**
 * Classify `source` (the value of --claims, relative to `cwd`). Returns {internal: false} for `-` and for a file that is really
 * outside the work tree (read as before, never removed), else {internal: true, ...} for a path that lies in the work tree lexically
 * or really (a symlink pointing in is not an "external" file).
 */
export function classifyClaimsSource(source, { cwd, repoRoot }) {
  if (source === "-" || typeof source !== "string") return { internal: false };
  const rootReal = real(repoRoot);
  const cwdReal = real(cwd);
  if (!rootReal || !cwdReal) return { internal: false };
  const lexical = isAbsolute(source) ? resolve(source) : resolve(cwdReal, source);
  const lexicalIn = inside(rootReal, lexical) || inside(resolve(repoRoot), lexical);
  const target = realish(lexical);
  if (!lexicalIn && !inside(rootReal, target)) return { internal: false };
  return { internal: true, rootReal, cwdReal, lexical, absolute: isAbsolute(source) };
}

function refuse(message) {
  throw new ClaimsRefused(message);
}

const clip = (text, n) => String(text).slice(0, n);

/** Validate a parsed claims object: the runner's own schema check plus an optional `checks` list of argv arrays. */
export function splitClaims(object, { validate = true } = {}) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    if (!validate) return { claims: object, fileChecks: [] }; // the runner reports it as it always did
    refuse("the claims input must be a JSON object {request, claims, excerpts?, checks?}");
  }
  const { checks, ...claims } = object;
  const fileChecks = [];
  if (checks !== undefined) {
    if (!Array.isArray(checks)) refuse("checks must be an array of argv arrays, for example [[\"node\",\"--test\"]]");
    if (checks.length > RUN_LIMITS.maxChecks) refuse(`at most ${RUN_LIMITS.maxChecks} checks`);
    for (const argv of checks) {
      try {
        fileChecks.push(parseCheckArgv(JSON.stringify(argv)));
      } catch {
        refuse("each entry of checks must be a non-empty array of non-empty strings (argv, no shell)");
      }
    }
  }
  const problems = validate ? validateRunInput(claims) : [];
  if (problems.length) refuse(`invalid claims: ${problems.slice(0, 3).map((p) => clip(p, 80)).join("; ")}`);
  return { claims, fileChecks };
}

/**
 * Read `source` for `done`. Returns {claims, checks (argv arrays from the file), removed?, sha256?}.
 * `readExternal(source)` is the old reader (`-` and files outside the work tree); it is never followed by a removal.
 * A refusal throws ClaimsRefused and leaves every file as it was.
 */
export async function loadClaims(source, { cwd, repoRoot, readExternal, beforeRemove, git = runGit }) {
  const where = classifyClaimsSource(source, { cwd, repoRoot });
  if (!where.internal) {
    // `-` and a file outside the work tree: read as before and never removed; only a `checks` key is taken out of the object.
    const { claims, fileChecks } = splitClaims(await readExternal(source), { validate: false });
    return { claims, checks: fileChecks };
  }
  if (where.absolute) refuse("a claims file inside the work tree is named by its plain name (jev-claims.json), not by an absolute path");
  if (where.cwdReal !== where.rootReal) refuse("run the helper from the repository root to use a claims file inside it");
  if (!consumableClaimsName(source)) refuse("a claims file inside the work tree must be named jev-claims*.json (letters, digits, . _ -; at most 120 bytes) in the repository root; any other path would change the snapshot");
  const path = resolve(where.rootReal, source);
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    refuse(`cannot read ${source}: ${error?.code ?? "error"}`);
  }
  if (!st.isFile()) refuse("the claims file must be a regular file, not a symlink or a directory"); // lstat: a symlink reports isFile() false
  if (st.size > MAX_BYTES) refuse("input exceeds 1 MiB");
  const state = untrackedAndNotIgnored(where.rootReal, source, git);
  if (!state.ok) refuse(`${state.why}; it is not consumed`);
  let raw;
  try {
    raw = readFileSync(path);
  } catch (error) {
    refuse(`cannot read ${source}: ${error?.code ?? "error"}`);
  }
  let object;
  try {
    object = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse("input is not valid JSON; the file was left as it is");
  }
  const { claims, fileChecks } = splitClaims(object);
  // Remove only the version that was read and validated: the same file, the same bytes.
  const digest = sha256(raw);
  if (beforeRemove) beforeRemove(); // test seams: `beforeRemove` runs a change between the read and the removal, `git` replaces the git probe
  let again;
  try {
    const now = lstatSync(path);
    again = now.isFile() && now.ino === st.ino && now.dev === st.dev && now.size === st.size ? readFileSync(path) : null;
  } catch {
    again = null;
  }
  if (!again || sha256(again) !== digest) refuse("the claims file changed while it was read; it is not consumed");
  try {
    unlinkSync(path);
  } catch (error) {
    refuse(`the claims file could not be removed (${error?.code ?? "error"}); the gate did not run`);
  }
  return { claims, checks: fileChecks, removed: basename(path), sha256: digest };
}

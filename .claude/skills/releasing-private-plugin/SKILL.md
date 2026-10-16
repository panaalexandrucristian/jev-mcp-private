---
name: releasing-private-plugin
description: Releases a new version of the private jev plugin from this repository (version bump in 6 files, PRIVATE.md paragraphs, release commit, tag, push and CI check). Use when the owner asks to release, ship, publish, tag or bump the version of the plugin, or says facem release. Not for the npm package of the upstream project, which `.agents/skills/releasing` covers.
---

# Releasing the private jev plugin

Follow the steps in order. Push and tag only when the owner asked for a release or said to push; if they asked only to prepare or bump, stop after step 5 and ask.

1. **Fresh worktree from origin/main.** Never release from the main checkout: its local `main` may differ from `origin/main`.
   ```sh
   git fetch origin
   git worktree add -b release-X.Y.Z ../jev-mcp-relXYZ origin/main
   ```
   If the changes are commits made elsewhere, `git cherry-pick <sha> ...` them in the worktree. They must apply without a conflict; if not, stop and tell the owner.
2. **Version.** Read the current one with `grep '"version"' .claude-plugin/plugin.json`. The new one is the next patch number unless the owner named one.
3. **Bump the same number in 6 files** (macOS `sed`; OLD is the current version with its dots escaped, for example `0\.13\.6`, and NEW the new one; the `grep -F` below takes OLD without the backslashes):
   ```sh
   sed -i '' 's/OLD/NEW/g' .claude-plugin/plugin.json .claude-plugin/marketplace.json \
     private/explica-clar/test/skill.test.mjs private/jev-control/test/manifest.test.mjs \
     private/jev-flow/test/manifest.test.mjs private/logic-test-debug/test/manifest.test.mjs
   grep -rnF OLD --include='*.mjs' --include='*.json' . | grep -v node_modules
   ```
   The grep must print nothing. Do not edit `CHANGELOG.md` (upstream's).
4. **`PRIVATE.md`.** (a) In the paragraph under `### Plugin version`, add the clause `` `X.Y.Z` for <what> (see «<section>») `` before "Bump both". (b) Add a paragraph about the change in the section of its feature, and a «Measured on <date>» paragraph when it was measured. (c) Update any count it quotes (tests, cases). Label every number measured, calculated or guessed, and give n. `private/jev-control/test/manifest.test.mjs` reads `PRIVATE.md`: do not rewrite the sentences it matches.
5. **Test and commit.**
   ```sh
   node --test $(ls private/*/test/*.mjs skills/*/scripts/test/*.mjs)
   npm run test:py
   git add <the files you changed>
   git commit -m "Plugin X.Y.Z: <what changed, one line>"
   git log -1 --format=%B | grep -iE "claude|council|consiliu|co-authored"
   ```
   The last command must print nothing: no trailer, no mention of Claude or a council.
6. **Tag and push** (only on the owner's word). The push must be a fast-forward; if it is rejected, fetch and put your commits on top of `origin/main`. Never force-push `main`.
   ```sh
   git tag -a plugin-vX.Y.Z -m "Plugin X.Y.Z: <short>"
   git push origin release-X.Y.Z:main
   git push origin plugin-vX.Y.Z
   ```
7. **CI.** Always pass `-R panaalexandrucristian/jev-mcp-private` (`gh` defaults to the upstream repository).
   ```sh
   gh run list -R panaalexandrucristian/jev-mcp-private --limit 3
   gh run view <id> -R panaalexandrucristian/jev-mcp-private --json status,conclusion
   ```
   A run takes a few minutes. Report the result as it is; if it fails, say so with the failing job.
8. **Tell the owner** to update on each machine: `claude plugin marketplace update jev-private && claude plugin update jev@jev-private`. Leave the worktree in place; delete it only when asked.

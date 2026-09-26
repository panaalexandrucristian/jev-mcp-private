# Private Jev plugin mirror

This private repository tracks [`jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp) while adding private packaging for Claude Code and OpenCode. The MCP process still runs the public `@jkudish/jev-mcp@latest` package.

## Repository topology

- `upstream` fetches `https://github.com/jkudish/jev-mcp` and has pushing disabled.
- `origin` points to the private `panaalexandrucristian/jev-mcp-private` repository.
- `main` is the only long-lived private integration branch. Merge upstream into it; never rebase or force-push it.
- The `jev` skill comes from upstream (`skills/jev`, shipped since v0.9.0). This repository adds only the plugin packaging and sync files below, and no upstream-owned file is modified, so upstream merges stay conflict-free.

Branch protection is optional. On private repositories it may require a paid GitHub plan, and required reviews can prevent a sole developer from merging their own synchronization PR.

## Authentication

Configure non-interactive private Git access before installing either plugin:

```sh
gh auth login
gh auth setup-git
```

## Claude Code

Install at user scope:

```sh
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
claude plugin marketplace add panaalexandrucristian/jev-mcp-private
claude plugin install jev@jev-private --scope user
claude plugin list
claude plugin details jev
```

Use `--scope project` or `--scope local` instead when appropriate.

Update or remove it:

```sh
claude plugin marketplace update jev-private
claude plugin update jev@jev-private
claude plugin uninstall jev@jev-private --scope user
```

## OpenCode

Clone the private repository and load the plugin from its directory:

```sh
git clone https://github.com/panaalexandrucristian/jev-mcp-private.git ~/.local/share/jev-mcp-private
```

Add the clone's absolute path to the `plugins` array in `~/.config/opencode/opencode.json` or `opencode.jsonc`. Replace `/Users/you` with your home directory:

```json
{
  "plugins": ["/Users/you/.local/share/jev-mcp-private"]
}
```

Restart OpenCode (`opencode service restart` for the background service), then check:

```sh
opencode plugin list
opencode mcp list
```

Update with `git -C ~/.local/share/jev-mcp-private pull`, then restart OpenCode. Remove it by deleting the path from `plugins`.

Do not use `opencode plugin add 'github:panaalexandrucristian/jev-mcp-private#main'`. On OpenCode 2.0.12 it fails with `NpmInstallFailedError: git dep preparation failed`, because this repository carries the MCP server's npm dependencies. Loading from the directory needs no build, and no `package.json` changes that would conflict with upstream.

The plugin preserves an existing OpenCode MCP server or skill named `jev` instead of replacing it.

## Provider configuration

Neither plugin stores provider credentials. The Jev MCP process inherits its environment, including supported variables such as:

- `JEV_PROVIDER`
- `JEV_MCP_MODEL`
- `OPENROUTER_API_KEY`
- `TYPESAFE_API_KEY`

Set these outside the plugin. Do not add secrets to either manifest.

## Synchronizing upstream

### Manual synchronization

From a clean `main` branch with the configured `upstream` and `origin` remotes:

```sh
scripts/sync-upstream.sh
```

The script fetches upstream commits and tags, fast-forwards from private `origin/main`, and merges `upstream/main`. It never pushes. On conflict, inspect and resolve the merge, run the printed checks, and push `main` and tags manually.

### Scheduled synchronization

The `Sync upstream` workflow runs every Monday at 06:17 UTC and can be dispatched manually. It mirrors upstream tags, merges new commits into a `sync/upstream-<sha>` branch, runs the repository checks, and opens or updates a pull request to `main`. It never pushes a merge directly to `main` and never auto-merges.

Enable the repository setting that allows GitHub Actions to create pull requests.

The workflow normally uses `GITHUB_TOKEN`. If upstream changes `.github/workflows`, add a fine-grained repository secret named `SYNC_TOKEN` with contents, pull-request, issues, and workflow-file permissions. Without it, the workflow fails rather than dropping those changes.

Merge conflicts and missing workflow permissions create or update the single issue `Upstream sync needs manual action`. Follow its recorded SHA and recovery instructions, or run:

```sh
git switch main
scripts/sync-upstream.sh
# Resolve conflicts if necessary.
npm ci
npm run typecheck
npm run build
npm test
git push origin main
git push origin --tags
```

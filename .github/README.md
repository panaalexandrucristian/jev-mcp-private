# jev-mcp-private

A private mirror of [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp), packaged as a plugin for Claude Code and OpenCode. The plugin gives your agent:

- the **jev MCP server**, run from the published npm package `@jkudish/jev-mcp@latest`;
- the **jev skill** (`skills/jev`), which tells the agent when to call each jev tool.

The upstream README is at [../README.md](../README.md). Maintenance details are in [PRIVATE.md](../PRIVATE.md).

## Before you install

1. **Node.js 22 or newer.** The MCP server runs through `npx`.
2. **GitHub access to this private repository**, so git can clone it without prompting:

   ```sh
   gh auth login
   gh auth setup-git
   ```

3. **A Jev provider key in your shell environment.** The plugin stores no secrets. The MCP server reads these variables from the environment it starts in. For example, in `~/.zshrc`:

   ```sh
   # TypeSafe direct (the default provider)
   export TYPESAFE_API_KEY=ts_...

   # or OpenRouter
   export JEV_PROVIDER=openrouter
   export OPENROUTER_API_KEY=sk-or-...
   export JEV_MCP_MODEL=typesafe/jev-1.13
   ```

   Start the client from a shell where these are set. The upstream [Configuration](../README.md#configuration) section lists every provider.

## Claude Code

```sh
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
claude plugin marketplace add panaalexandrucristian/jev-mcp-private
claude plugin install jev@jev-private --scope user
```

`--scope user` makes the plugin available in all your projects. Use `--scope project` or `--scope local` to limit it to one project.

Check that it worked:

```sh
claude plugin details jev@jev-private   # Skills (1) jev · MCP servers (1) jev
claude mcp list                         # plugin:jev:jev ... ✔ Connected
```

Update, or remove:

```sh
claude plugin marketplace update jev-private
claude plugin update jev@jev-private
claude plugin uninstall jev@jev-private --scope user
```

The Claude Code desktop app uses the same plugins as the CLI.

## OpenCode

1. Clone the repository:

   ```sh
   git clone https://github.com/panaalexandrucristian/jev-mcp-private.git ~/.local/share/jev-mcp-private
   ```

2. Add the clone's absolute path to `plugins` in `~/.config/opencode/opencode.json` (or `opencode.jsonc`). Replace `/Users/you` with your home directory:

   ```json
   {
     "plugins": ["/Users/you/.local/share/jev-mcp-private"]
   }
   ```

3. Restart OpenCode (`opencode service restart` if you use the background service), then check:

   ```sh
   opencode plugin list
   opencode mcp list   # jev ... connected
   ```

Update with `git -C ~/.local/share/jev-mcp-private pull` and restart OpenCode. Remove it by deleting the path from `plugins`.

If you already have an MCP server or skill named `jev` in OpenCode, the plugin keeps yours and does not replace it.

Don't use `opencode plugin add github:...` with this repository: on OpenCode 2.0.12 it fails with `git dep preparation failed`. Loading from the clone works and needs no build.

## Staying up to date with upstream

This repository changes no upstream file, so merging upstream stays conflict-free.

- **Automatically:** a GitHub Actions workflow runs every Monday at 06:17 UTC. It merges `upstream/main` on a branch and opens a PR for you to merge. If there is a conflict, it opens an issue instead of merging.
- **Manually**, from a local clone on `main` with an `upstream` remote:

  ```sh
  git remote add upstream https://github.com/jkudish/jev-mcp   # once
  git remote set-url --push upstream DISABLED                  # once
  scripts/sync-upstream.sh
  ```

  The script stops on any conflict. After a clean merge it prints the test and push commands to run.

After a sync, Claude Code gets the new version with `claude plugin marketplace update jev-private` followed by `claude plugin update jev@jev-private`. OpenCode gets it with `git pull` in the clone.

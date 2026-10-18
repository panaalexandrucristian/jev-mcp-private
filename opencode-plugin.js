import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skillURL = new URL("./skills/jev/SKILL.md", import.meta.url);
const skillLocation = fileURLToPath(skillURL);

function parseSkill(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatter) {
    throw new Error(`[jev] Missing YAML frontmatter in ${skillLocation}`);
  }

  const field = (name) => {
    const match = frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    if (!match) throw new Error(`[jev] Missing ${name} in ${skillLocation}`);
    return match[1].trim();
  };

  return {
    name: field("name"),
    description: field("description"),
    content: source.slice(frontmatter[0].length)
  };
}

let mcpNoticeLogged = false;
let skillNoticeLogged = false;

export default {
  id: "jev",
  async setup(ctx) {
    const skill = parseSkill(await readFile(skillURL, "utf8"));

    await ctx.mcp.transform((editor) => {
      if (editor.get("jev")) {
        if (!mcpNoticeLogged) {
          console.info("[jev] Existing MCP server 'jev' preserved.");
          mcpNoticeLogged = true;
        }
        return;
      }

      editor.set("jev", {
        type: "local",
        command: ["npx", "-y", "--package=@jkudish/jev-mcp@latest", "jev-mcp"]
      });
    });

    await ctx.skill.transform((editor) => {
      if (editor.get("jev")) {
        if (!skillNoticeLogged) {
          console.info("[jev] Existing skill 'jev' preserved.");
          skillNoticeLogged = true;
        }
        return;
      }

      editor.add({
        id: "jev",
        name: skill.name,
        description: skill.description,
        location: skillLocation,
        path: skillLocation,
        content: skill.content
      });
    });

    // Private jev-flow extension. Any failure is isolated here so the jev MCP
    // server and skill registered above keep working exactly as before.
    try {
      const { setupFlow } = await import("./private/jev-flow/opencode.mjs");
      await setupFlow(ctx);
    } catch (error) {
      console.warn(`[jev-flow] disabled: ${error?.message ?? error}`);
    }
  }
};

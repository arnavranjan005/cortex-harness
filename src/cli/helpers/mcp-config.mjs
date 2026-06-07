import fs from "fs-extra";
import path from "path";

/**
 * Merge the template's mcpServers into the target project's .mcp.json,
 * additive-only — never overwrites a server entry the user already registered.
 * Mirrors the hooks-merge behavior used for .claude/settings.json during init.
 *
 * Returns "created" | "merged" | "present" | "absent" (no template to merge from).
 */
export async function mergeMcpConfig(templatesDir, targetDir) {
  const templatePath = path.join(templatesDir, ".mcp.json");
  if (!(await fs.pathExists(templatePath))) return "absent";

  const template = await fs.readJson(templatePath);
  const mcpPath = path.join(targetDir, ".mcp.json");

  if (await fs.pathExists(mcpPath)) {
    const existing = await fs.readJson(mcpPath);
    const existingServers = existing.mcpServers ?? {};
    const templateServers = template.mcpServers ?? {};

    const missing = Object.keys(templateServers).filter(
      (name) => !(name in existingServers),
    );
    if (!missing.length) return "present";

    existing.mcpServers = { ...existingServers };
    for (const name of missing) existing.mcpServers[name] = templateServers[name];
    await fs.writeJson(mcpPath, existing, { spaces: 2 });
    return "merged";
  }

  await fs.writeJson(mcpPath, template, { spaces: 2 });
  return "created";
}

import fs from "fs-extra";
import path from "path";

/**
 * Merge the template's plugin list into the target project's opencode.json,
 * additive-only — never removes or overwrites a plugin entry the user already
 * registered. Registers claude-hooks-bridge so the project's existing
 * .claude/settings.json hooks (sync-memory.js, track-cycle.mjs, log-session.mjs)
 * also work under the OpenCode provider — mirrors mergeMcpConfig's pattern.
 *
 * Returns { status: "created"|"merged"|"present"|"absent", added: string[] }
 */
export async function mergeOpenCodeConfig(templatesDir, targetDir) {
  const templatePath = path.join(templatesDir, "opencode.json");
  if (!(await fs.pathExists(templatePath))) return { status: "absent", added: [] };

  const template = await fs.readJson(templatePath);
  const opencodePath = path.join(targetDir, "opencode.json");

  if (await fs.pathExists(opencodePath)) {
    const existing = await fs.readJson(opencodePath);
    const existingPlugins = Array.isArray(existing.plugin) ? existing.plugin : [];
    const templatePlugins = Array.isArray(template.plugin) ? template.plugin : [];

    const missing = templatePlugins.filter((p) => !existingPlugins.includes(p));
    if (!missing.length) return { status: "present", added: [] };

    existing.plugin = [...existingPlugins, ...missing];
    await fs.writeJson(opencodePath, existing, { spaces: 2 });
    return { status: "merged", added: missing };
  }

  await fs.writeJson(opencodePath, template, { spaces: 2 });
  return { status: "created", added: template.plugin ?? [] };
}

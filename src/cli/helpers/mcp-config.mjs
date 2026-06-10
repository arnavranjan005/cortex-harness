import fs from "fs-extra";
import path from "path";

/**
 * Well-known server → agent mapping used for auto-scoping during init.
 * When a server from this map is added to .mcp.json, init automatically
 * wires it into the matching agents' mcpScope in harness.config.json.
 */
export const KNOWN_SERVER_SCOPES = {
  playwright:  ["frontend-subagent", "tester-subagent"],
  shadcn:      ["frontend-subagent"],
  github:      ["infra-subagent"],
  filesystem:  ["backend-subagent", "frontend-subagent", "distributed-subagent"],
  fetch:       ["backend-subagent", "distributed-subagent"],
};

/**
 * Merge the template's mcpServers into the target project's .mcp.json,
 * additive-only — never overwrites a server entry the user already registered.
 *
 * Returns { status: "created"|"merged"|"present"|"absent", added: string[] }
 *   status — what happened to .mcp.json
 *   added  — server names that were newly written (empty when present/absent)
 */
export async function mergeMcpConfig(templatesDir, targetDir) {
  const templatePath = path.join(templatesDir, ".mcp.json");
  if (!(await fs.pathExists(templatePath))) return { status: "absent", added: [] };

  const template = await fs.readJson(templatePath);
  const mcpPath = path.join(targetDir, ".mcp.json");

  if (await fs.pathExists(mcpPath)) {
    const existing = await fs.readJson(mcpPath);
    const existingServers = existing.mcpServers ?? {};
    const templateServers = template.mcpServers ?? {};

    const missing = Object.keys(templateServers).filter(
      (name) => !(name in existingServers),
    );
    if (!missing.length) return { status: "present", added: [] };

    existing.mcpServers = { ...existingServers };
    for (const name of missing) existing.mcpServers[name] = templateServers[name];
    await fs.writeJson(mcpPath, existing, { spaces: 2 });
    return { status: "merged", added: missing };
  }

  await fs.writeJson(mcpPath, template, { spaces: 2 });
  return { status: "created", added: Object.keys(template.mcpServers ?? {}) };
}

/**
 * For each newly-added server that appears in KNOWN_SERVER_SCOPES, wire it
 * into the matching agents' mcpScope in harness.config.json — additive-only.
 *
 * Returns array of { server, agents } describing what was auto-scoped.
 */
export async function autoScopeMcpServers(configPath, addedServers) {
  if (!addedServers.length) return [];

  let config;
  try {
    config = await fs.readJson(configPath);
  } catch {
    return [];
  }

  if (!config.mcpScope) config.mcpScope = {};
  const configured = Object.keys(config.agents ?? {});
  const scoped = [];

  for (const server of addedServers) {
    const targetAgents = KNOWN_SERVER_SCOPES[server];
    if (!targetAgents) continue;

    const scopedTo = [];
    for (const agent of targetAgents) {
      if (!configured.includes(agent)) continue;
      const current = config.mcpScope[agent] ?? [];
      if (!current.includes(server)) {
        config.mcpScope[agent] = [...current, server];
        scopedTo.push(agent);
      }
    }
    if (scopedTo.length) scoped.push({ server, agents: scopedTo });
  }

  if (scoped.length) {
    await fs.writeJson(configPath, config, { spaces: 2 });
  }

  return scoped;
}

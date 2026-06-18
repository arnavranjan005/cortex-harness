import fs from "fs-extra";
import path from "path";
import { multiselect, isInteractive } from "./ui.mjs";

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

// ─── pure helpers ───────────────────────────────────────────────────────────
// Everything below has no I/O — no fs, no prompts — so it can be unit tested
// directly and reused by any future prompt (init, config wizard, a hypothetical
// `mcp` fix-up flow) without re-deriving the same option lists or scope math.

/**
 * Build the "* (all agents)" + per-agent option list used by every
 * "which agents should get this server" prompt. Order is fixed (wildcard
 * first) so prompts stay visually consistent as new agents are added.
 */
export function agentScopeOptions(configuredAgents) {
  return [
    { value: "*", label: "* (all agents)" },
    ...configuredAgents.map((a) => ({ value: a, label: a })),
  ];
}

/**
 * Build the "pick servers to allow" option list used by per-agent server
 * prompts (the inverse direction of agentScopeOptions — one agent, many
 * servers). Kept as its own function so a future prompt can annotate options
 * (e.g. show the server's command) without touching call sites.
 */
export function serverScopeOptions(serverNames) {
  return serverNames.map((s) => ({ value: s, label: s }));
}

/**
 * True if two scope lists contain the same entries, ignoring order.
 * Used to decide whether a prompt's answer actually changed anything
 * (skip the write + "Updated X" message when it didn't).
 */
export function scopeListsEqual(a, b) {
  const as = [...(a ?? [])].sort();
  const bs = [...(b ?? [])].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

/**
 * Add `server` to mcpScope for each agent in `targetAgents` — additive-only,
 * silently drops any agent not in `configuredAgents` (and keeps "*" as-is,
 * since it's not a real agent key). Pure: returns a new mcpScope object plus
 * the subset of targetAgents that actually changed (i.e. didn't already have
 * the server), so callers can report a no-op accurately instead of always
 * claiming success.
 *
 * Returns { mcpScope, scopedTo }.
 */
export function applyServerScope(mcpScope, server, targetAgents, configuredAgents) {
  const next = { ...mcpScope };
  const scopedTo = [];
  for (const agent of targetAgents) {
    if (agent !== "*" && !configuredAgents.includes(agent)) continue;
    const current = next[agent] ?? [];
    if (!current.includes(server)) {
      next[agent] = [...current, server];
      scopedTo.push(agent);
    }
  }
  return { mcpScope: next, scopedTo };
}

// ─── interactive glue ───────────────────────────────────────────────────────
// Thin wrappers around the pure helpers above — this is the only place that
// touches the prompt library, so it's the only place a prompt-behavior test
// would need to mock.

/**
 * Ask which agents (or "*") should get `server`. Returns [] when declined,
 * skipped (non-interactive), or cancelled — callers treat an empty result
 * as "nothing to scope" rather than as an error.
 */
export async function promptAgentsForServer(server, configuredAgents) {
  if (!isInteractive()) return [];
  return multiselect({
    message: `Which agents should get the MCP server "${server}"?`,
    options: agentScopeOptions(configuredAgents),
    initialValues: [],
    required: false,
    fallback: [],
  });
}

/**
 * For each newly-added server, wire it into the matching agents' mcpScope in
 * harness.config.json — additive-only. Servers in KNOWN_SERVER_SCOPES are
 * scoped automatically with no prompt (fast path for the common servers we
 * ship a template for). Any other server is unknown to the harness, so we
 * ask interactively (via promptAgentsForServer) which agents should get it —
 * there is no safe default, since granting tool access to every agent isn't
 * always wanted. In non-interactive contexts (CI, piped init) unknown
 * servers are skipped and reported back so the caller can tell the user to
 * run `cortex-harness config add-mcp-scope` manually.
 *
 * Returns { scoped: [{ server, agents }], skipped: string[] }.
 */
export async function autoScopeMcpServers(configPath, addedServers) {
  if (!addedServers.length) return { scoped: [], skipped: [] };

  let config;
  try {
    config = await fs.readJson(configPath);
  } catch {
    return { scoped: [], skipped: [] };
  }

  if (!config.mcpScope) config.mcpScope = {};
  const configured = Object.keys(config.agents ?? {});
  const scoped = [];
  const skipped = [];

  for (const server of addedServers) {
    const targetAgents = KNOWN_SERVER_SCOPES[server] ?? (await promptAgentsForServer(server, configured));

    if (!targetAgents.length) {
      skipped.push(server);
      continue;
    }

    const { mcpScope, scopedTo } = applyServerScope(config.mcpScope, server, targetAgents, configured);
    config.mcpScope = mcpScope;
    if (scopedTo.length) scoped.push({ server, agents: scopedTo });
    else skipped.push(server);
  }

  if (scoped.length) {
    await fs.writeJson(configPath, config, { spaces: 2 });
  }

  return { scoped, skipped };
}

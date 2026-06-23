import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { logger } from "../../logger.mjs";

// Converts Claude's .mcp.json `mcpServers` entries into OpenCode's `mcp: {}`
// shape — confirmed live there is no interop between the two formats
// (OpenCode reports zero servers even with a populated .mcp.json present).
// Claude shape:  { command: string, args?: string[], env?: object }
// OpenCode shape: { type: "local", command: string[], environment: object, enabled: true }
// Remote servers (no local `command`) are skipped — no confirmed real-world
// example to validate the "remote" shape against; warn rather than guess.
export function translateMcpServers(mcpServers) {
  const translated = {};
  for (const [name, def] of Object.entries(mcpServers ?? {})) {
    if (typeof def?.command !== "string") {
      logger.warn(
        chalk.yellow(`  [WARN] MCP server "${name}" has no local "command" — skipping OpenCode translation (remote servers not yet supported).`),
      );
      continue;
    }
    translated[name] = {
      type: "local",
      command: [def.command, ...(Array.isArray(def.args) ? def.args : [])],
      environment: def.env ?? {},
      enabled: true,
    };
  }
  return translated;
}

// Writes a disposable, cycle-unique config file containing only `mcp` (every
// server registered in .mcp.json, translated) and `tools["<server>*"]` set to
// true for servers in allowedServerNames and false for everything else —
// confirmed live that a global false cascades to every agent unless
// overridden, so this is a complete allow/deny set, not a partial patch.
//
// This is passed to the spawned process via the OPENCODE_CONFIG environment
// variable (confirmed live: OpenCode merges it with the project's real
// opencode.json without overwriting keys the project file doesn't itself
// set, and never touches that file on disk) — mirroring Claude's disposable
// --mcp-config temp file exactly, rather than mutating a file the project
// owns. This is also what makes it safe for parallel cycles: each cycle gets
// its own uniquely-named file, so two cycles scoping different servers at
// the same time can never race on a shared file the way mutating
// opencode.json in place would.
//
// `additionalServers` (same Claude shape as .mcp.json's mcpServers — {command,
// args, env}) lets a caller include server definitions that only exist
// in-memory for this one call, never written to .mcp.json on disk — e.g.
// smoke-orchestrator.mjs's auth-profile servers (playwright-<name>, built
// fresh per smoke check with a --storage-state arg specific to that profile).
// Without this, allowedServerNames including such a name would silently do
// nothing, since this function's only source of server definitions used to
// be .mcp.json itself.
//
// Returns the temp file path, or null if there's nothing to scope (caller
// should omit OPENCODE_CONFIG entirely in that case). Caller is responsible
// for deleting the file after the process closes.
export function buildScopedOpenCodeConfigFile({ ROOT, allowedServerNames, cycleId, tmpDir, additionalServers }) {
  const mcpPath = join(ROOT, ".mcp.json");
  let diskServers = {};
  if (existsSync(mcpPath)) {
    try {
      diskServers = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers ?? {};
    } catch {
      diskServers = {};
    }
  }

  const allServers = { ...diskServers, ...(additionalServers ?? {}) };
  const translatedMcp = translateMcpServers(allServers);
  if (Object.keys(translatedMcp).length === 0) return null;

  const allowed = new Set(allowedServerNames ?? []);
  const tools = {};
  for (const name of Object.keys(translatedMcp)) {
    tools[`${name}*`] = allowed.has(name);
  }

  const tmpConfigPath = join(tmpDir, `tmp-opencode-mcp-${cycleId}.json`);
  writeFileSync(tmpConfigPath, JSON.stringify({ mcp: translatedMcp, tools }, null, 2), "utf8");
  return tmpConfigPath;
}

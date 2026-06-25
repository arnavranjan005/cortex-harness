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

// Writes a disposable, cycle-unique config file containing only `mcp` entries
// for servers in allowedServerNames — denied servers are omitted entirely,
// never translated, never registered. This mirrors Claude's --mcp-config
// behavior exactly: an unauthorized server isn't loaded into the process at
// all, so there's nothing for the model to see or call.
//
// Earlier version of this function registered every server from .mcp.json
// (enabled: true) and tried to deny the unauthorized ones via a top-level
// `tools["<server>*"]: false` map. Confirmed against OpenCode's own issue
// tracker (anomalyco/opencode#3612 — "Option to deny MCP tools by default")
// that a top-level `tools` deny entry is silently ignored by OpenCode; only
// per-agent tools/permission config is honored. That meant every cycle had
// full access to every MCP server regardless of mcpScope — denial-by-omission
// (this version) sidesteps the broken field entirely instead of depending on it.
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
// Always writes the temp file, even when permittedServers ends up empty
// (`{"mcp":{}}`) — deliberate, for consistency and debugging: every cycle
// that reaches this function leaves a same-shaped artifact on disk showing
// exactly what it was scoped to, rather than "no file" being overloaded to
// mean both "nothing allowed" and "function never ran". Caller is
// responsible for deleting the file after the process closes.
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
  const allowed = new Set(allowedServerNames ?? []);
  const permittedServers = {};
  for (const [name, def] of Object.entries(allServers)) {
    if (allowed.has(name)) permittedServers[name] = def;
  }

  const translatedMcp = translateMcpServers(permittedServers);

  const tmpConfigPath = join(tmpDir, `tmp-opencode-mcp-${cycleId}.json`);
  writeFileSync(tmpConfigPath, JSON.stringify({ mcp: translatedMcp }, null, 2), "utf8");
  return tmpConfigPath;
}

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isWindows } from "./constants.mjs";

// On Windows, SIGTERM only signals the top-level PowerShell process.
// taskkill /F /T kills the entire process tree including all descendants.
export function killProc(proc) {
  if (!proc || !proc.pid) return;
  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// Reads mcpScope from harness.config.json and .mcp.json from ROOT, then returns
// a filtered mcpServers object scoped to the given agent — or null when no filtering
// is needed (mcpScope absent). Writes nothing; caller is responsible for temp file.
export function buildFilteredMcpServers(agentName, { config, ROOT }) {
  const mcpScope = config.mcpScope;
  if (!mcpScope || typeof mcpScope !== "object") return null;

  const mcpPath = join(ROOT, ".mcp.json");
  if (!existsSync(mcpPath)) return null;

  let mcp;
  try {
    mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch {
    return null;
  }

  const allServers = mcp.mcpServers ?? {};
  const globalAllowed = Array.isArray(mcpScope["*"]) ? mcpScope["*"] : [];
  const agentAllowed = Array.isArray(mcpScope[agentName]) ? mcpScope[agentName] : [];
  const allowed = new Set([...globalAllowed, ...agentAllowed]);

  const filtered = {};
  for (const name of allowed) {
    if (allServers[name]) filtered[name] = allServers[name];
  }
  return filtered;
}

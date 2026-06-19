import { execSync } from "child_process";
import chalk from "chalk";
import { isWindows } from "./constants.mjs";

// On Windows, PowerShell spawned with -NoProfile does not load the user profile
// that adds %APPDATA%\npm to PATH, so `claude` (a .cmd shim) is not found.
// Resolve to the full path once at module load so every .ps1 script uses it.
// `where.exe` does a live PATH search and can fail transiently (AV scan, cold
// filesystem cache), so retry a few times before accepting the bare-name
// fallback — a single flake should not poison every cycle in the run.
const CLAUDE_EXE_RESOLVE_RETRIES = 3;
const CLAUDE_EXE_RESOLVE_RETRY_DELAY_MS = 200;

export function resolveClaudeExe() {
  if (!isWindows) return "claude";
  for (let attempt = 1; attempt <= CLAUDE_EXE_RESOLVE_RETRIES; attempt++) {
    try {
      const lines = execSync("where.exe claude", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Prefer .cmd shim — it works reliably when called from PowerShell
      const resolved = lines.find((l) => l.toLowerCase().endsWith(".cmd")) ?? lines[0];
      if (resolved) return resolved;
    } catch {
      // fall through to retry
    }
    if (attempt < CLAUDE_EXE_RESOLVE_RETRIES) {
      const until = Date.now() + CLAUDE_EXE_RESOLVE_RETRY_DELAY_MS;
      while (Date.now() < until) { /* brief synchronous wait before retry */ }
    }
  }
  console.warn(
    chalk.yellow(
      `  [WARN] could not resolve full path to "claude" via where.exe after ${CLAUDE_EXE_RESOLVE_RETRIES} attempts — ` +
      `falling back to bare "claude", which may fail to resolve inside -NoProfile PowerShell cycles.`,
    ),
  );
  return "claude";
}

// Resolved once per process and shared by every call site — avoid re-spawning
// where.exe per import.
export const CLAUDE_EXE = resolveClaudeExe();

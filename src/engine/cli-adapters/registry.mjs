import { execSync } from "child_process";
import { claudeAdapter } from "./claude-adapter.mjs";
import { opencodeAdapter } from "./opencode-adapter.mjs";
import { isWindows } from "../constants.mjs";

export const DEFAULT_CLI_PROVIDER = "claude";

export const ADAPTERS = {
  claude: claudeAdapter,
  opencode: opencodeAdapter,
};

// Binary name each provider's CLI is invoked as — used only for the
// install-detection check below. Each adapter resolves its own actual
// executable path independently (e.g. preferring the .cmd shim on Windows).
const PROVIDER_BIN = {
  claude: "claude",
  opencode: "opencode",
};

export function listProviders() {
  return Object.keys(ADAPTERS);
}

export function resolveAdapter(cliProvider) {
  return ADAPTERS[cliProvider] ?? ADAPTERS[DEFAULT_CLI_PROVIDER];
}

// Best-effort PATH check — does not catch a broken/misconfigured install,
// only "is some binary by this name reachable at all."
export function isProviderInstalled(provider) {
  const bin = PROVIDER_BIN[provider];
  if (!bin) return false;
  try {
    if (isWindows) {
      execSync(`where.exe ${bin}`, { stdio: ["ignore", "ignore", "ignore"] });
    } else {
      execSync(`command -v ${bin}`, { stdio: ["ignore", "ignore", "ignore"], shell: "/bin/sh" });
    }
    return true;
  } catch {
    return false;
  }
}

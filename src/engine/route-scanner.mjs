/**
 * Deterministic route scanner for file-based frontend frameworks.
 * Called by the engine when layoutAffected=true — no LLM involvement.
 */

import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const SKIP_NAMES = new Set([
  "layout", "loading", "error", "not-found", "template",  // Next.js app router
  "_app", "_document", "_error",                           // Next.js pages router
]);

/**
 * Derive the frontend root prefix from harness config.
 * Returns e.g. "web/" or "frontend/" or "" for a monolith.
 */
export function deriveFrontendRoot(config) {
  const scopes = config.agents?.["frontend-subagent"]?.scope ?? [];
  const sharedPrefixes = ["libs/", "packages/", "shared/"];
  for (const s of scopes) {
    const normalized = s.endsWith("/") ? s : s + "/";
    if (!sharedPrefixes.some(p => normalized.startsWith(p))) return normalized;
  }
  return "";
}

/**
 * Convert a single file path (relative to repo root) to a navigable URL.
 * Returns null if the file is not a page file for the given framework.
 */
export function deriveUrlFromPath(filePath, frontendRoot, framework) {
  const p = filePath.replace(/\\/g, "/");

  // Strip frontendRoot prefix
  const rel = frontendRoot ? p.replace(new RegExp("^" + frontendRoot.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), "") : p;

  switch (framework) {
    case "nextjs-app-router": {
      if (!rel.startsWith("src/app/")) return null;
      const base = rel.replace(/^src\/app\//, "").replace(/\\/g, "/");
      // Must end with /page.tsx|ts|jsx|js
      if (!/\/page\.[jt]sx?$/.test("/" + base) && !/^page\.[jt]sx?$/.test(base)) return null;
      // Check for skippable special files
      const stem = base.split("/").pop().replace(/\.[^.]+$/, "");
      if (SKIP_NAMES.has(stem)) return null;

      let route = base
        .replace(/\/page\.[jt]sx?$/, "")   // strip /page.tsx
        .replace(/^page\.[jt]sx?$/, "")     // strip page.tsx at root
        .replace(/\([^)]+\)\//g, "")        // strip route groups: (dashboard)/
        .replace(/\[\.\.\.([^\]]+)\]/g, "test")  // [...slug] → test
        .replace(/\[([^\]]+)\]/g, "1");     // [id] → 1

      return "/" + route;
    }

    case "nextjs-pages-router": {
      if (!rel.startsWith("src/pages/")) return null;
      if (!/\.[jt]sx?$/.test(rel)) return null;
      const base = rel.replace(/^src\/pages\//, "");
      const stem = base.split("/").pop().replace(/\.[^.]+$/, "");
      if (SKIP_NAMES.has(stem) || stem.startsWith("_")) return null;

      let route = base
        .replace(/\/index\.[jt]sx?$/, "")
        .replace(/\.[jt]sx?$/, "")
        .replace(/\[\.\.\.([^\]]+)\]/g, "test")
        .replace(/\[([^\]]+)\]/g, "1");

      return "/" + route;
    }

    case "nuxt": {
      if (!rel.startsWith("pages/")) return null;
      if (!rel.endsWith(".vue")) return null;

      let route = rel
        .replace(/^pages\//, "")
        .replace(/(?:\/|^)index\.vue$/, "")
        .replace(/\.vue$/, "")
        .replace(/\[\.\.\.([^\]]+)\]/g, "test")
        .replace(/\[([^\]]+)\]/g, "1");

      return "/" + route;
    }

    case "sveltekit": {
      if (!rel.startsWith("src/routes/")) return null;
      if (!/\+page\.[a-z]+$/.test(rel)) return null;

      let route = rel
        .replace(/^src\/routes\//, "")
        .replace(/\+page\.[a-z]+$/, "")
        .replace(/\/$/, "")
        .replace(/\([^)]+\)\//g, "")         // strip route groups
        .replace(/\[\.\.\.([^\]]+)\]/g, "test")
        .replace(/\[([^\]]+)\]/g, "1");

      return "/" + route;
    }

    default:
      return null;
  }
}

function collectFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) results.push(...collectFiles(full));
      else results.push(full);
    }
  } catch { /* unreadable */ }
  return results;
}

/**
 * Detect the frontend framework by inspecting the filesystem under frontendRoot.
 * Returns one of the framework identifiers or "unknown".
 */
export function detectFramework(root, frontendRoot) {
  const base = join(root, frontendRoot);

  // Primary: read package.json deps — more reliable than directory sniffing
  try {
    const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["next"])           return existsSync(join(base, "src", "app")) ? "nextjs-app-router" : "nextjs-pages-router";
    if (deps["nuxt"])           return "nuxt";
    if (deps["@sveltejs/kit"])  return "sveltekit";
    if (deps["react"] || deps["vue"] || deps["solid-js"] || deps["@angular/core"]) return "spa";
  } catch { /* no package.json at frontendRoot — fall through */ }

  // Fallback: filesystem structure
  if (existsSync(join(base, "src", "app")))    return "nextjs-app-router";
  if (existsSync(join(base, "src", "pages")))  return "nextjs-pages-router";
  if (existsSync(join(base, "src", "routes"))) return "sveltekit";
  if (existsSync(join(base, "pages")))         return "nuxt";
  return "unknown";
}

const FRAMEWORK_SCAN_SUBDIR = {
  "nextjs-app-router":   ["src", "app"],
  "nextjs-pages-router": ["src", "pages"],
  "nuxt":                ["pages"],
  "sveltekit":           ["src", "routes"],
};

/**
 * Scan the filesystem for all page routes in the given framework.
 * Returns a sorted, deduplicated array of URL strings like ["/", "/reports", "/clients/1"].
 */
export function scanAllRoutes(root, frontendRoot, framework) {
  const subdir = FRAMEWORK_SCAN_SUBDIR[framework];
  if (!subdir) return [];

  const scanDir = join(root, frontendRoot, ...subdir);
  const allFiles = collectFiles(scanDir);
  const urls = new Set();

  for (const file of allFiles) {
    const rel = file.replace(/\\/g, "/").replace(
      root.replace(/\\/g, "/").replace(/\/?$/, "/"),
      "",
    );
    const url = deriveUrlFromPath(rel, frontendRoot, framework);
    if (url !== null) urls.add(url);
  }

  return [...urls].sort();
}

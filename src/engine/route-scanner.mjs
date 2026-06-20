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
 * True if a file path contains a dynamic route segment, e.g. "[id]" or "[...slug]".
 * Used to flag derived URLs whose value is a placeholder, not real data — so the
 * smoke checker knows a 404/not-found render may be expected rather than a defect.
 */
export function hasDynamicSegment(filePath) {
  return /\[[^\]]+\]/.test(filePath);
}

/**
 * Resolve a captured route-param name (e.g. "id" from "[id]") to a concrete value
 * for one specific route. `routeParams` supports two entry shapes, checked in order:
 *
 *   1. Route-specific override — keyed by the route's bracket pattern (the path with
 *      brackets still in it, e.g. "/clients/[id]"), value is { paramName: value }.
 *      Wins when present, since it's unambiguous about which route it applies to.
 *   2. Flat default — keyed by param name only (e.g. "id": "1"), applies to every
 *      route using that name. Useful when one name always means the same kind of
 *      record (e.g. "slug" is always a blog post), but wrong if reused across
 *      unrelated resources (e.g. "id" on both /clients/[id] and /invoices/[id]).
 *
 * Falls back to a generic placeholder ("1" / "test") if neither is configured.
 */
function resolveParam(name, routePattern, routeParams, fallback) {
  const override = routeParams?.[routePattern];
  if (override && typeof override === "object" && name in override) return override[name];
  const flat = routeParams?.[name];
  if (typeof flat === "string") return flat;
  return fallback;
}

// Collect the param names referenced in a bracket pattern, e.g. "clients/[id]/[...slug]"
// → ["id", "slug"]. Used so callers (the CLI route-params wizard) can know which
// param names need a value for a given route pattern without re-deriving it themselves.
export function extractParamNames(pattern) {
  const names = [];
  for (const m of pattern.matchAll(/\[\.\.\.([^\]]+)\]/g)) names.push(m[1]);
  for (const m of pattern.matchAll(/\[([^\]]+)\]/g)) {
    if (!pattern.slice(m.index, m.index + m[0].length).startsWith("[...")) names.push(m[1]);
  }
  return names;
}

/**
 * Convert a single file path (relative to repo root) to full route info:
 * `{ url, routePattern, paramNames }`, or null if the file is not a page file
 * for the given framework. `routePattern` is the bracket path as written in
 * `harness.config.json`'s `routeParams` override keys (e.g. "/clients/[id]");
 * `paramNames` is empty for a static route. `routeParams` resolves dynamic
 * segments — see resolveParam() above for the two supported shapes.
 */
export function deriveRouteInfo(filePath, frontendRoot, framework, routeParams = {}) {
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

      // Strip route groups BEFORE the page-file suffix — a route group that is the
      // page's own leaf folder (e.g. "(landing)/page.tsx") loses its trailing "/"
      // once "/page.tsx" is stripped first, so the group-strip regex below would
      // never match and "(landing)" would leak into the URL as a literal segment.
      // Group-strip and suffix-strip BEFORE substitution: routePattern is the bracket
      // path as the user would write it in harness.config.json (e.g. "/clients/[id]"),
      // used to look up a route-specific override before falling back to a flat default.
      const pattern = base
        .replace(/\([^)]+\)\//g, "")        // strip route groups: (dashboard)/
        .replace(/\/page\.[jt]sx?$/, "")   // strip /page.tsx
        .replace(/^page\.[jt]sx?$/, "");    // strip page.tsx at root
      const routePattern = "/" + pattern;

      const route = pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "test"))
        .replace(/\[([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "1"));

      return { url: "/" + route, routePattern, paramNames: extractParamNames(pattern) };
    }

    case "nextjs-pages-router": {
      if (!rel.startsWith("src/pages/")) return null;
      if (!/\.[jt]sx?$/.test(rel)) return null;
      const base = rel.replace(/^src\/pages\//, "");
      const stem = base.split("/").pop().replace(/\.[^.]+$/, "");
      if (SKIP_NAMES.has(stem) || stem.startsWith("_")) return null;

      const pattern = base
        .replace(/\/index\.[jt]sx?$/, "")
        .replace(/\.[jt]sx?$/, "");
      const routePattern = "/" + pattern;

      const route = pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "test"))
        .replace(/\[([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "1"));

      return { url: "/" + route, routePattern, paramNames: extractParamNames(pattern) };
    }

    case "nuxt": {
      if (!rel.startsWith("pages/")) return null;
      if (!rel.endsWith(".vue")) return null;

      const pattern = rel
        .replace(/^pages\//, "")
        .replace(/(?:\/|^)index\.vue$/, "")
        .replace(/\.vue$/, "");
      const routePattern = "/" + pattern;

      const route = pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "test"))
        .replace(/\[([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "1"));

      return { url: "/" + route, routePattern, paramNames: extractParamNames(pattern) };
    }

    case "sveltekit": {
      if (!rel.startsWith("src/routes/")) return null;
      if (!/\+page\.[a-z]+$/.test(rel)) return null;

      // Strip route groups BEFORE the trailing-slash removal — a route group that
      // is the page's own leaf folder (e.g. "(landing)/+page.svelte") would lose
      // the "/" the group-strip regex needs once the trailing slash is stripped first.
      const pattern = rel
        .replace(/^src\/routes\//, "")
        .replace(/\+page\.[a-z]+$/, "")
        .replace(/\([^)]+\)\//g, "")         // strip route groups
        .replace(/\/$/, "");
      const routePattern = "/" + pattern;

      const route = pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "test"))
        .replace(/\[([^\]]+)\]/g, (_, name) => resolveParam(name, routePattern, routeParams, "1"));

      return { url: "/" + route, routePattern, paramNames: extractParamNames(pattern) };
    }

    default:
      return null;
  }
}

/**
 * Convert a single file path (relative to repo root) to a navigable URL.
 * Returns null if the file is not a page file for the given framework.
 * Thin wrapper over `deriveRouteInfo()` for callers that only need the URL.
 */
export function deriveUrlFromPath(filePath, frontendRoot, framework, routeParams = {}) {
  return deriveRouteInfo(filePath, frontendRoot, framework, routeParams)?.url ?? null;
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
 * Returns { urls, dynamicUrls } — both sorted, deduplicated arrays of URL strings
 * like ["/", "/reports", "/clients/1"]. dynamicUrls is the subset of urls whose
 * value came from substituting a "[param]" segment (real or placeholder), so
 * callers can treat a 404/not-found render on those pages as potentially expected.
 */
export function scanAllRoutes(root, frontendRoot, framework, routeParams = {}) {
  const subdir = FRAMEWORK_SCAN_SUBDIR[framework];
  if (!subdir) return { urls: [], dynamicUrls: [] };

  const scanDir = join(root, frontendRoot, ...subdir);
  const allFiles = collectFiles(scanDir);
  const urls = new Set();
  const dynamicUrls = new Set();

  for (const file of allFiles) {
    const rel = file.replace(/\\/g, "/").replace(
      root.replace(/\\/g, "/").replace(/\/?$/, "/"),
      "",
    );
    const url = deriveUrlFromPath(rel, frontendRoot, framework, routeParams);
    if (url !== null) {
      urls.add(url);
      if (hasDynamicSegment(rel)) dynamicUrls.add(url);
    }
  }

  return { urls: [...urls].sort(), dynamicUrls: [...dynamicUrls].sort() };
}

/**
 * Scan the filesystem for dynamic routes only, returning each distinct bracket
 * pattern with the param names it needs — e.g. [{ routePattern: "/clients/[id]",
 * paramNames: ["id"], exampleUrl: "/clients/1" }]. Used by the CLI route-params
 * wizard so a user can pick a real, existing route instead of hand-typing a
 * bracket path that has to exactly match what the scanner derives at runtime.
 */
export function scanDynamicRoutes(root, frontendRoot, framework) {
  const subdir = FRAMEWORK_SCAN_SUBDIR[framework];
  if (!subdir) return [];

  const scanDir = join(root, frontendRoot, ...subdir);
  const allFiles = collectFiles(scanDir);
  const byPattern = new Map();

  for (const file of allFiles) {
    const rel = file.replace(/\\/g, "/").replace(
      root.replace(/\\/g, "/").replace(/\/?$/, "/"),
      "",
    );
    const info = deriveRouteInfo(rel, frontendRoot, framework);
    if (info && info.paramNames.length && !byPattern.has(info.routePattern)) {
      byPattern.set(info.routePattern, {
        routePattern: info.routePattern,
        paramNames: info.paramNames,
        exampleUrl: info.url,
      });
    }
  }

  return [...byPattern.values()].sort((a, b) => a.routePattern.localeCompare(b.routePattern));
}

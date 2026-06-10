import fs from "fs-extra";
import path from "path";

// Directories never descended into during project scanning.
export const PRUNE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".nx",
  "tmp",
  ".cache",
  "coverage",
  ".turbo",
]);

// Patterns matched against the FULL forward-slash relative path (lowercase).
// Word-boundary (\b) ensures "api" matches "apps/api/" but not "capability/".
// Order matters — first match wins.
export const SURFACE_PATTERNS = [
  { key: "backend", re: /\b(api|backend|server|serverless)\b/ },
  { key: "distributed", re: /\b(worker|queue|job|processor|consumer|producer)\b/ },
  { key: "sharedSchema", re: /\b(schema|zod|validation|models?)\b/ },
  { key: "sharedTypes", re: /\b(types?|entit(y|ies)|interfaces?|domain)\b/ },
  { key: "sharedUi", re: /\bui\b|\b(components?|design[-_]system)\b/ },
  { key: "frontend", re: /\b(web|frontend|client|shop|store|dashboard|portal)\b/ },
];

async function isProjectRoot(absPath) {
  return (
    (await fs.pathExists(path.join(absPath, "project.json"))) ||
    (await fs.pathExists(path.join(absPath, "src"))) ||
    (await fs.pathExists(path.join(absPath, "index.ts"))) ||
    (await fs.pathExists(path.join(absPath, "index.js")))
  );
}

// Walk the whole project tree; when a project root is found, classify it and stop descending.
export async function detectSurfaces(cwd) {
  if (!(await fs.pathExists(path.join(cwd, "nx.json")))) return null;

  const surfaces = {
    backend: [],
    frontend: [],
    distributed: [],
    sharedSchema: [],
    sharedTypes: [],
    sharedUi: [],
  };

  async function walk(absDir, rel) {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || PRUNE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const childAbs = path.join(absDir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (await isProjectRoot(childAbs)) {
        const p = childRel + "/";
        const slug = p.toLowerCase();
        if (/\be2e\b/.test(slug)) continue;
        for (const { key, re } of SURFACE_PATTERNS) {
          if (re.test(slug)) {
            surfaces[key].push(p);
            break;
          }
        }
      } else {
        await walk(childAbs, childRel);
      }
    }
  }

  await walk(cwd, "");
  return surfaces;
}

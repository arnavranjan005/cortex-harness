import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { getAllFiles } from "./fs-utils.mjs";

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
  {
    key: "distributed",
    re: /\b(worker|queue|job|processor|consumer|producer)\b/,
  },
  { key: "sharedSchema", re: /\b(schema|zod|validation|models?)\b/ },
  { key: "sharedTypes", re: /\b(types?|entit(y|ies)|interfaces?|domain)\b/ },
  { key: "sharedUi", re: /\bui\b|\b(components?|design[-_]system)\b/ },
  {
    key: "frontend",
    re: /\b(web|frontend|client|shop|store|dashboard|portal)\b/,
  },
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
    const entries = await fs
      .readdir(absDir, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || PRUNE_DIRS.has(e.name) || e.name.startsWith("."))
        continue;
      const childAbs = path.join(absDir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (await isProjectRoot(childAbs)) {
        const p = childRel + "/";
        const slug = p.toLowerCase();
        if (/\be2e\b/.test(slug)) continue; // skip e2e companion projects
        for (const { key, re } of SURFACE_PATTERNS) {
          if (re.test(slug)) {
            surfaces[key].push(p);
            break;
          }
        }
        // unmatched paths are left unassigned — user fills them in the prompt
      } else {
        await walk(childAbs, childRel);
      }
    }
  }

  await walk(cwd, "");
  return surfaces;
}

// Prompts user to confirm or override each surface. Returns confirmed surface map.
export async function confirmSurfaces(detected, rl) {
  const isNx = detected !== null;
  const d = detected ?? {};

  if (!process.stdin.isTTY) {
    return {
      backend: d.backend ?? [],
      frontend: d.frontend ?? [],
      distributed: d.distributed ?? [],
      sharedSchema: d.sharedSchema ?? [],
      sharedTypes: d.sharedTypes ?? [],
      sharedUi: d.sharedUi ?? [],
    };
  }

  function fmt(paths) {
    return paths && paths.length ? paths.join(", ") : "";
  }

  async function ask(label, defaults) {
    const hint = fmt(defaults);
    const display = hint
      ? chalk.cyan(`[${hint}]`)
      : chalk.dim("[none — enter path or leave blank to skip]");
    const raw = await rl.question(`  ${chalk.bold(label)} ${display}: `);
    if (!raw.trim()) return defaults ?? [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!isNx) {
    console.log(
      chalk.yellow(
        "\n  No nx.json found — this doesn't look like an Nx workspace.",
      ),
    );
    console.log(
      chalk.dim(
        "  Enter your project surface paths manually, or press Enter to skip.\n",
      ),
    );
  } else {
    console.log(
      chalk.dim(
        "\n  Nx workspace detected. Confirm surface paths — press Enter to accept.\n",
      ),
    );
  }

  return {
    backend: await ask("Backend / serverless paths", d.backend ?? []),
    frontend: await ask("Frontend paths            ", d.frontend ?? []),
    distributed: await ask("Worker / queue paths      ", d.distributed ?? []),
    sharedSchema: await ask("Shared schema lib paths   ", d.sharedSchema ?? []),
    sharedTypes: await ask("Shared types lib paths    ", d.sharedTypes ?? []),
    sharedUi: await ask("Shared UI lib paths       ", d.sharedUi ?? []),
  };
}

// Replaces <!-- cortex:KEY --> ... <!-- /cortex:KEY --> blocks in every .md under agentsDir.
// Uses indexOf to avoid regex escaping issues with multiline content.
export async function patchAgentScopes(agentsDir, surfaces) {
  // Derive Nx project names from app-level frontend paths (e.g. "apps/shop/" → "shop").
  // Lib paths are excluded — check commands target runnable apps, not libs.
  const frontendAppNames = surfaces.frontend
    .filter((p) => !p.startsWith("libs/"))
    .map((p) => p.replace(/\/$/, "").split("/").pop())
    .filter(Boolean);

  const frontendChecks =
    frontendAppNames.length === 0
      ? "  - *(no frontend apps configured — run `cortex-harness config` to set)*"
      : frontendAppNames
          .flatMap((name) => [
            `  - \`cmd /c npm exec nx run ${name}:lint\``,
            `  - \`cmd /c npm exec nx run ${name}:test\``,
            `  - \`cmd /c npm exec nx run ${name}:build\``,
          ])
          .join("\n");

  const tagMap = {
    "cortex:backend": surfaces.backend,
    "cortex:frontend": surfaces.frontend,
    "cortex:distributed": surfaces.distributed,
    "cortex:shared-schema": surfaces.sharedSchema,
    "cortex:shared-types": surfaces.sharedTypes,
    "cortex:shared-ui": surfaces.sharedUi,
    "cortex:frontend-checks": { _raw: frontendChecks },
  };

  const mdFiles = (await getAllFiles(agentsDir)).filter((f) =>
    f.endsWith(".md"),
  );
  for (const file of mdFiles) {
    let content = await fs.readFile(file, "utf8");
    let changed = false;

    for (const [tag, value] of Object.entries(tagMap)) {
      const open = `<!-- ${tag} -->`;
      const close = `<!-- /${tag} -->`;
      // value is either a paths array or a { _raw } object for pre-formatted content
      const list =
        value?._raw !== undefined
          ? value._raw
          : value.length === 0
            ? "- *(none configured — run `cortex-harness config` to set)*"
            : value.map((p) => `- \`${p}\``).join("\n");
      const replacement = `${open}\n${list}\n${close}`;

      let out = "";
      let cursor = 0;
      let found = false;
      while (true) {
        const openIdx = content.indexOf(open, cursor);
        if (openIdx === -1) break;
        const closeIdx = content.indexOf(close, openIdx + open.length);
        if (closeIdx === -1) break;
        out += content.slice(cursor, openIdx) + replacement;
        cursor = closeIdx + close.length;
        found = true;
      }
      if (found) {
        content = out + content.slice(cursor);
        changed = true;
      }
    }

    if (changed) await fs.writeFile(file, content, "utf8");
  }
}

// Writes confirmed surface paths into harness.config.json and patches agent md files.
export async function applySurfaces(configPath, surfaces, agentsDir) {
  const config = await fs.readJson(configPath);

  config.agents["backend-subagent"].scope = [
    ...surfaces.backend,
    ...surfaces.sharedSchema,
    ...surfaces.sharedTypes,
  ].filter(Boolean);

  config.agents["frontend-subagent"].scope = [
    ...surfaces.frontend,
    ...surfaces.sharedUi,
  ].filter(Boolean);

  config.agents["distributed-subagent"].scope = [
    ...surfaces.distributed,
  ].filter(Boolean);

  await fs.writeJson(configPath, config, { spaces: 2 });

  if (agentsDir && (await fs.pathExists(agentsDir))) {
    await patchAgentScopes(agentsDir, surfaces);
  }
}

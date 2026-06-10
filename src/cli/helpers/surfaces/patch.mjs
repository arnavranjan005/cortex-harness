import fs from "fs-extra";
import path from "path";
import { getAllFiles } from "../fs-utils.mjs";

// Replaces <!-- cortex:KEY --> ... <!-- /cortex:KEY --> blocks in every .md under agentsDir.
export async function patchAgentScopes(agentsDir, surfaces) {
  // Derive Nx project names from app-level frontend paths (e.g. "apps/shop/" → "shop").
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

  const mdFiles = (await getAllFiles(agentsDir)).filter((f) => f.endsWith(".md"));
  for (const file of mdFiles) {
    let content = await fs.readFile(file, "utf8");
    let changed = false;

    for (const [tag, value] of Object.entries(tagMap)) {
      const open = `<!-- ${tag} -->`;
      const close = `<!-- /${tag} -->`;
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
  const agents = config.agents ?? {};
  let changed = false;

  if (agents["backend-subagent"]) {
    agents["backend-subagent"].scope = [
      ...surfaces.backend,
      ...surfaces.sharedSchema,
      ...surfaces.sharedTypes,
    ].filter(Boolean);
    changed = true;
  }

  if (agents["frontend-subagent"]) {
    agents["frontend-subagent"].scope = [
      ...surfaces.frontend,
      ...surfaces.sharedUi,
    ].filter(Boolean);
    changed = true;
  }

  if (agents["distributed-subagent"]) {
    agents["distributed-subagent"].scope = [
      ...surfaces.distributed,
    ].filter(Boolean);
    changed = true;
  }

  if (!changed) return;
  await fs.writeJson(configPath, config, { spaces: 2 });

  if (agentsDir && (await fs.pathExists(agentsDir))) {
    await patchAgentScopes(agentsDir, surfaces);
  }
}

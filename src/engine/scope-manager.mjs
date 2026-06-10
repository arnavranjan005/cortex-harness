import chalk from "chalk";
import { execSync } from "child_process";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

// Infer the top-level scope path from a file path using Nx layout conventions.
function inferScopePath(normalizedFilePath) {
  const parts = normalizedFilePath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === "apps") return parts.slice(0, 2).join("/") + "/";
  if (parts[0] === "libs")
    return parts.length >= 3
      ? parts.slice(0, 3).join("/") + "/"
      : parts.slice(0, 2).join("/") + "/";
  return parts.slice(0, 2).join("/") + "/";
}

// Decide which agents should receive a newly-created path.
// Shared libs go to all implementers; app/feature paths go only to the creator.
function resolveTargetAgents(scopePath, creatingAgent) {
  const p = scopePath.toLowerCase();
  const isSharedLib = p.startsWith("libs/shared/") || /\/shared\//.test(p);
  const isUiLib = /\bui\b|components?|design[-_]system/.test(p);

  if (!isSharedLib) return [creatingAgent];
  if (isUiLib) return ["frontend-subagent"];
  return ["backend-subagent", "frontend-subagent", "distributed-subagent"];
}

/**
 * Returns the scope enforcement helpers bound to the given runtime context.
 *
 * @param {object} ctx
 * @param {object} ctx.CONFIGURED_AGENTS  - agent map from harness.config.json
 * @param {string} ctx.ROOT               - project root (cwd)
 * @param {string} ctx.CYCLE_DIR          - absolute path to cycle-state/
 * @param {Function} ctx.readCycleState   - (filename) => string | null
 * @param {Function} ctx.restoreFromSnapshot - (filePath) => boolean
 * @param {Function} ctx.appendLog        - (obj) => void
 */
export function createScopeManager({
  CONFIGURED_AGENTS,
  ROOT,
  CYCLE_DIR,
  readCycleState,
  restoreFromSnapshot,
  appendLog,
}) {
  // After each implement cycle, compare filesChanged against declared scope.
  // Auto-revert out-of-scope files and write scope-violations.json.
  // Returns array of file paths that could NOT be reverted (undefined when all ok).
  function checkAndRevertScopeViolations(cycle) {
    if (!cycle.agent || !cycle.type.startsWith("implement-")) return;
    const agentConfig = CONFIGURED_AGENTS[cycle.agent];
    const scope = agentConfig?.scope;
    if (!scope || scope.length === 0) return;

    const rawJson = readCycleState(cycle.outputFile);
    if (!rawJson) return;

    let report;
    try {
      report = JSON.parse(rawJson);
    } catch {
      return;
    }

    const filesChanged = report.filesChanged ?? [];
    const violations = [];

    for (const entry of filesChanged) {
      const filePath =
        typeof entry === "string" ? entry : (entry.file ?? entry.path ?? "");
      if (!filePath) continue;
      const normalized = filePath.replace(/\\/g, "/");
      const inScope = scope.some((s) =>
        normalized.startsWith(s.replace(/\\/g, "/")),
      );
      if (!inScope) violations.push(filePath);
    }

    if (!violations.length) return;

    console.log(
      `\n  ${chalk.red("[SCOPE]")} ${chalk.cyan(cycle.id)} touched ${violations.length} out-of-scope file(s) — reverting:`,
    );
    const reverted = [];
    const failed = [];

    for (const f of violations) {
      let done = false;

      if (!done) {
        try {
          execSync(`git restore "${f}"`, { cwd: ROOT, stdio: "pipe" });
          done = true;
        } catch { /* fall through */ }
      }

      if (!done) {
        try {
          execSync(`git clean -f "${f}"`, { cwd: ROOT, stdio: "pipe" });
          done = true;
        } catch { /* fall through */ }
      }

      if (!done) {
        try {
          const original = execSync(`git show HEAD:"${f}"`, { cwd: ROOT });
          writeFileSync(join(ROOT, f), original);
          done = true;
        } catch { /* fall through */ }
      }

      if (!done) {
        try {
          unlinkSync(join(ROOT, f));
          done = true;
        } catch { /* fall through */ }
      }

      if (done) {
        const restored = restoreFromSnapshot(f);
        console.log(
          `    ${chalk.green("✗")} reverted: ${chalk.dim(f)}${restored ? chalk.dim(" (pre-run content restored from snapshot)") : ""}`,
        );
        reverted.push(f);
      } else {
        console.log(`    ${chalk.red("!")} could not revert: ${chalk.red(f)}`);
        failed.push(f);
      }
    }

    const existingViolationsPath = join(CYCLE_DIR, "scope-violations.json");
    let existing = [];
    if (existsSync(existingViolationsPath)) {
      try {
        existing = JSON.parse(readFileSync(existingViolationsPath, "utf8"));
      } catch {
        existing = [];
      }
    }
    existing.push({
      cycleId: cycle.id,
      agent: cycle.agent,
      detectedAt: new Date().toISOString(),
      violations,
      reverted,
      couldNotRevert: failed,
      revertComplete: failed.length === 0,
    });
    writeFileSync(
      existingViolationsPath,
      JSON.stringify(existing, null, 2),
      "utf8",
    );
    appendLog({
      type: "harness",
      event: "scope-violations",
      cycleId: cycle.id,
      violations,
      reverted,
      failed,
    });

    return failed.length ? failed : undefined;
  }

  // When an agent ran unconstrained (scope=[]), detect the directories it created
  // and add them to harness.config.json so future cycles get proper enforcement.
  function autoUpdateScope(cycle) {
    if (!cycle.agent || !cycle.type.startsWith("implement-")) return;
    const agentConfig = CONFIGURED_AGENTS[cycle.agent];
    const scope = agentConfig?.scope;
    if (!scope || scope.length > 0) return;

    const rawJson = readCycleState(cycle.outputFile);
    if (!rawJson) return;
    let report;
    try {
      report = JSON.parse(rawJson);
    } catch {
      return;
    }

    const filesChanged = report.filesChanged ?? [];
    const newPaths = new Set();
    for (const entry of filesChanged) {
      const filePath =
        typeof entry === "string" ? entry : (entry.file ?? entry.path ?? "");
      if (!filePath) continue;
      const p = inferScopePath(filePath.replace(/\\/g, "/"));
      if (p) newPaths.add(p);
    }
    if (newPaths.size === 0) return;

    const configPath = join(ROOT, "harness.config.json");
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return;
    }

    const updates = {};
    for (const newPath of newPaths) {
      for (const agent of resolveTargetAgents(newPath, cycle.agent)) {
        if (!config.agents?.[agent]) continue;
        const existing = config.agents[agent].scope ?? [];
        if (!existing.includes(newPath)) {
          (updates[agent] = updates[agent] ?? []).push(newPath);
        }
      }
    }
    if (Object.keys(updates).length === 0) return;

    for (const [agent, paths] of Object.entries(updates)) {
      config.agents[agent].scope = [
        ...(config.agents[agent].scope ?? []),
        ...paths,
      ];
      CONFIGURED_AGENTS[agent] = config.agents[agent];
    }

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      console.log(
        `\n  ${chalk.yellow("[SCOPE]")} Auto-updated scopes from unconstrained cycle ${chalk.cyan(cycle.id)}:`,
      );
      for (const [agent, paths] of Object.entries(updates)) {
        paths.forEach((p) =>
          console.log(`    ${chalk.green("+")} ${p}  →  ${chalk.dim(agent)}`),
        );
      }
      appendLog({
        type: "harness",
        event: "scope-auto-updated",
        cycleId: cycle.id,
        agent: cycle.agent,
        updates,
      });
    } catch (err) {
      console.warn(`  [SCOPE] Could not update harness.config.json: ${err.message}`);
    }
  }

  // Build an injected reconcile cycle to let the agent undo files it couldn't auto-revert.
  function buildScopeCleanupCycle(cycle, failedFiles) {
    const agentName = cycle.agent ?? "unknown-agent";
    return {
      id: `scope-cleanup-${cycle.id}`,
      type: "reconcile",
      status: "pending",
      agent: agentName,
      outputFile: `scope-cleanup-${cycle.id}.json`,
      parallel: false,
      notes:
        `SCOPE CLEANUP: ${agentName} went out of scope during cycle "${cycle.id}". ` +
        `The harness could not auto-revert these files: ${failedFiles.join(", ")}. ` +
        `This agent must undo those changes — restore each file to its pre-cycle state.`,
    };
  }

  return { checkAndRevertScopeViolations, autoUpdateScope, buildScopeCleanupCycle };
}

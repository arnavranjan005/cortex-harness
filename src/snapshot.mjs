/**
 * Pre-run snapshot manager.
 *
 * Captures uncommitted working-tree files as raw Buffers before any cycle runs.
 * After a scope-revert wipes a file back to HEAD, restoreFromSnapshot writes the
 * pre-run content back so the user's (or a prior run's) uncommitted work is not lost.
 * Refreshed after every successful in-scope cycle so valid edits are preserved.
 *
 * Usage:
 *   const snap = createSnapshotManager({ snapshotDir, root, configuredAgents, readCycleState, chalk, execSync });
 *   snap.createPreRunSnapshot();
 *   snap.refreshSnapshot(cycle);
 *   const restored = snap.restoreFromSnapshot(filePath);
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";

export function createSnapshotManager({
  snapshotDir,
  root,
  configuredAgents,
  readCycleState,
  chalk,
  execSync,
}) {
  const snapshotIndex = join(snapshotDir, "snapshot.json");

  function readIndex() {
    if (!existsSync(snapshotIndex)) return {};
    try {
      return JSON.parse(readFileSync(snapshotIndex, "utf8"));
    } catch {
      return {};
    }
  }

  function writeIndex(index) {
    writeFileSync(snapshotIndex, JSON.stringify(index, null, 2), "utf8");
  }

  function blobPath(filePath) {
    const sanitized = filePath.replace(/[/\\:*?"<>|]/g, "_");
    return join(snapshotDir, sanitized);
  }

  function captureFiles(filePaths) {
    if (!filePaths.length) return;
    mkdirSync(snapshotDir, { recursive: true });
    const index = readIndex();
    for (const f of filePaths) {
      const abs = join(root, f);
      if (!existsSync(abs)) continue;
      try {
        const content = readFileSync(abs); // Buffer — no encoding, byte-perfect
        const blob = blobPath(f);
        writeFileSync(blob, content);
        index[f] = {
          blobFile: relative(snapshotDir, blob),
          capturedAt: new Date().toISOString(),
        };
      } catch {
        /* best-effort: skip unreadable files */
      }
    }
    writeIndex(index);
  }

  function createPreRunSnapshot() {
    let dirty = [];
    try {
      const modified = execSync("git diff --name-only HEAD", {
        cwd: root,
        stdio: "pipe",
      })
        .toString()
        .trim();
      if (modified) dirty.push(...modified.split("\n").map((f) => f.trim()).filter(Boolean));

      const untracked = execSync("git ls-files --others --exclude-standard", {
        cwd: root,
        stdio: "pipe",
      })
        .toString()
        .trim();
      if (untracked) dirty.push(...untracked.split("\n").map((f) => f.trim()).filter(Boolean));
    } catch {
      return;
    }
    if (!dirty.length) return;
    captureFiles(dirty);
    console.log(
      `\n  ${chalk.dim("[SNAPSHOT]")} captured ${dirty.length} uncommitted file(s) before run start`,
    );
  }

  function refreshSnapshot(cycle) {
    if (!cycle.agent || !cycle.type.startsWith("implement-")) return;
    const agentConfig = configuredAgents[cycle.agent];
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
    const inScopeFiles = [];
    for (const entry of filesChanged) {
      const filePath =
        typeof entry === "string" ? entry : (entry.file ?? entry.path ?? "");
      if (!filePath) continue;
      const normalized = filePath.replace(/\\/g, "/");
      const inScope = scope.some((s) =>
        normalized.startsWith(s.replace(/\\/g, "/")),
      );
      if (inScope) inScopeFiles.push(filePath);
    }

    if (!inScopeFiles.length) return;
    captureFiles(inScopeFiles);
    console.log(
      `  ${chalk.dim("[SNAPSHOT]")} refreshed ${inScopeFiles.length} in-scope file(s) after ${chalk.cyan(cycle.id)}`,
    );
  }

  function restoreFromSnapshot(filePath) {
    const index = readIndex();
    const entry = index[filePath] ?? index[filePath.replace(/\\/g, "/")];
    if (!entry) return false;
    const blob = join(snapshotDir, entry.blobFile);
    if (!existsSync(blob)) return false;
    try {
      const content = readFileSync(blob); // Buffer — byte-perfect
      writeFileSync(join(root, filePath), content);
      return true;
    } catch {
      return false;
    }
  }

  return {
    createPreRunSnapshot,
    refreshSnapshot,
    restoreFromSnapshot,
    // exposed for testing
    captureFiles,
    readIndex,
  };
}

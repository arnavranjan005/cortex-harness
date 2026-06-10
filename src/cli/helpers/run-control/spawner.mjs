import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";

export async function readRunEndSpend(runsDir) {
  if (!(await fs.pathExists(runsDir))) return 0;
  const files = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files.length) return 0;
  try {
    const lines = (await fs.readFile(path.join(runsDir, files[0]), "utf8"))
      .split("\n")
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === "harness" && ev.event === "run-end" && ev.totalSpentUsd !== undefined) {
          return Number(ev.totalSpentUsd) || 0;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file unreadable */ }
  return 0;
}

// pkgRoot is the cortex-harness package root (parent of bin/ and src/).
export function spawnRun(task, cwd, pkgRoot) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath, task], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

// Spawn the engine with no task arg — resumes an existing queue in-place.
export function spawnResumedRun(cwd, pkgRoot) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

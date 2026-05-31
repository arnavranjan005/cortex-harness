/**
 * Resume a blocked autonomous run.
 * Answers are collected interactively by the CLI before this script is called.
 * This script only marks blocked cycles as pending and starts the run.
 */

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config-loader.mjs";

const config = await loadConfig();
const { harnessDir: HARNESS_DIR } = config;

const QUEUE_FILE = join(HARNESS_DIR, "task-queue.json");

if (!existsSync(QUEUE_FILE)) {
  console.error("[ERROR] No task-queue.json found. Nothing to resume.");
  process.exit(1);
}

let queue;
try {
  queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
} catch (err) {
  console.error("[ERROR] Failed to parse task-queue.json", err.message);
  process.exit(1);
}

const blockedCycles = queue.cycles.filter((c) => c.status === "blocked");
if (!blockedCycles.length) {
  console.log("[INFO] No blocked cycles found. Resuming normally...");
} else {
  const sessionLimitCycles = blockedCycles.filter((c) => c.blockedType === "session-limit");
  if (sessionLimitCycles.length) {
    console.log(`[RESUME] ${sessionLimitCycles.length} session-limit cycle(s) will retry.`);
  }

  for (const c of blockedCycles) {
    c.status = "pending";
    delete c.blockedType;
    delete c.blockedReason;
    delete c.blockedAt;
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  console.log(`[RESUME] Marked ${blockedCycles.length} cycle(s) for retry.`);
}

// Spawn run-autonomous.mjs
const enginePath = join(fileURLToPath(import.meta.url), "..", "run-autonomous.mjs");
spawn("node", [enginePath], { stdio: "inherit", cwd: process.cwd() });

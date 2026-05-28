/**
 * Resume a blocked autonomous run with a human answer.
 * Refactored to be configuration-driven.
 */

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config-loader.mjs";

const config = await loadConfig();
const { harnessDir: HARNESS_DIR } = config;

const CYCLE_DIR = join(HARNESS_DIR, "cycle-state");
const QUEUE_FILE = join(HARNESS_DIR, "task-queue.json");
const ANSWERS_FILE = join(CYCLE_DIR, "human-answers.json");

const humanAnswer = process.argv.slice(2).join(" ").trim();

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
  // Logic to save humanAnswer to ANSWERS_FILE (abbreviated)
  const answers = existsSync(ANSWERS_FILE) ? JSON.parse(readFileSync(ANSWERS_FILE, "utf8")) : [];
  answers.push({
    answeredAt: new Date().toISOString(),
    resolvedCycles: blockedCycles.map(c => c.id),
    decisions: blockedCycles.map(c => ({ cycleId: c.id, answer: humanAnswer }))
  });
  writeFileSync(ANSWERS_FILE, JSON.stringify(answers, null, 2), "utf8");

  // Mark blocked as pending so they retry with the new context
  for (const c of blockedCycles) {
    c.status = "pending";
    delete c.blockedReason;
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  console.log(`[RESUME] Added answer and marked ${blockedCycles.length} cycle(s) for retry.`);
}

// Spawn run-autonomous.mjs
const enginePath = join(fileURLToPath(import.meta.url), "..", "run-autonomous.mjs");
spawn("node", [enginePath], { stdio: "inherit", cwd: process.cwd() });


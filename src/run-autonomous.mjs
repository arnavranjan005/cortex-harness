/**
 * Autonomous multi-cycle runner for Cortex Harness.
 * Configuration-driven: reads harness.config.json for paths, agent scopes, and commands.
 *
 * This file is the entry point and main loop.
 * Heavy lifting is delegated to src/engine/* modules.
 */

import chalk from "chalk";
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { join, relative } from "path";
import { spawn as _spawn } from "child_process";
import { CLAUDE_EXE } from "./engine/claude-exe.mjs";
import {
  validateCycleOutput,
  validateTaskQueue,
  CRITICAL_OUTPUT_FILES,
  CONSERVATIVE_DEFAULTS,
} from "./cycle-schemas.mjs";
import { dispatchNotification } from "./notification-dispatcher.mjs";
import { loadConfig } from "./config-loader.mjs";
import { createSnapshotManager } from "./snapshot.mjs";
import { MAX_BUDGET_USD, MAX_RETRIES } from "./engine/constants.mjs";
import { killProc, buildFilteredMcpServers } from "./engine/process-utils.mjs";
import { createScopeManager } from "./engine/scope-manager.mjs";
import { createQueueManager } from "./engine/queue-manager.mjs";
import { createPromptBuilder } from "./engine/prompt-builder.mjs";
import { createCycleRunner } from "./engine/cycle-runner.mjs";
import { createSmokeOrchestrator } from "./engine/smoke-orchestrator.mjs";
import { mergeProbeUrls } from "./engine/probe-urls.mjs";
import { scanAllRoutes, deriveFrontendRoot, detectFramework } from "./engine/route-scanner.mjs";

// ── Load Config ───────────────────────────────────────────────────────────────

const config = await loadConfig();

const {
  harnessDir: HARNESS_DIR,
  promptsDir: PROMPTS_DIR,
  agentsDir: AGENTS_DIR,
  cwd: ROOT,
  agents: CONFIGURED_AGENTS,
} = config;

// ── Paths ─────────────────────────────────────────────────────────────────────

const RUNS_DIR = join(HARNESS_DIR, "runs");
const CYCLE_DIR = join(HARNESS_DIR, "cycle-state");
const OUTPUT_DIR = join(HARNESS_DIR, "output");
const SESSION_FILE = join(HARNESS_DIR, "session.json");
const QUEUE_FILE = join(HARNESS_DIR, "task-queue.json");
const SNAPSHOT_DIR = join(HARNESS_DIR, "pre-run-snapshot");

const CYCLE_STATE_RELDIR = relative(ROOT, CYCLE_DIR).replace(/\\/g, "/");
const SNAPSHOT_RELDIR = relative(ROOT, SNAPSHOT_DIR).replace(/\\/g, "/");

// ── Task input ────────────────────────────────────────────────────────────────

const cliTask = process.argv.slice(2).join(" ").trim();
let userTask = cliTask;

if (!userTask) {
  try {
    const existingQueue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (existingQueue?.task) {
      userTask = existingQueue.task;
      console.log(`${chalk.dim("[resume]")} Using task from task-queue.json: ${userTask}`);
    }
  } catch { /* no queue yet */ }
} else {
  try {
    const existingQueue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (existingQueue?.task && existingQueue.task !== cliTask) {
      console.log(
        `${chalk.dim("[new-task]")} Task differs from task-queue.json — clearing old state for fresh run.`,
      );
      unlinkSync(QUEUE_FILE);
      if (existsSync(CYCLE_DIR)) {
        for (const f of readdirSync(CYCLE_DIR)) {
          try { unlinkSync(join(CYCLE_DIR, f)); } catch { /* ignore */ }
        }
      }
      try {
        if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
      } catch { /* ignore */ }
    }
  } catch { /* queue not found — fresh run */ }
}

if (!userTask) {
  console.error('Usage: cortex-harness run "your task description"');
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

mkdirSync(RUNS_DIR, { recursive: true });
mkdirSync(CYCLE_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(SNAPSHOT_DIR, { recursive: true });

// Clean up any tmp-mcp-*.json files left over from a previously interrupted run.
for (const f of readdirSync(HARNESS_DIR).filter(f => f.startsWith("tmp-mcp-") && f.endsWith(".json"))) {
  try { unlinkSync(join(HARNESS_DIR, f)); } catch { /* ignore */ }
}

const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runLogFile = join(RUNS_DIR, `${runTimestamp}.jsonl`);

// ── State ─────────────────────────────────────────────────────────────────────

const spendRef = { value: 0 }; // mutable; mutated by cycle-runner via reference

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLog(obj) {
  try {
    appendFileSync(runLogFile, JSON.stringify(obj) + "\n", "utf8");
  } catch { /* best-effort */ }
}

function notify(title, message, meta = {}) {
  dispatchNotification({
    title,
    message,
    meta: { task: userTask, totalSpentUsd: Number(spendRef.value.toFixed(2)), ...meta },
    onWarning: (warning) => {
      console.warn(warning);
      appendLog({ type: "notification-warning", warning });
    },
  });
}

function readCycleState(filename) {
  if (!filename) return null;
  const p = join(CYCLE_DIR, filename);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function cycleOutputWritten(cycle) {
  if (cycle.type === "deliver") {
    try {
      return readdirSync(OUTPUT_DIR).some(
        (f) => f.startsWith("delivery-") && f.endsWith(".md"),
      );
    } catch { return false; }
  }
  return !!(cycle.outputFile && existsSync(join(CYCLE_DIR, cycle.outputFile)));
}

function deliverOutputFile() {
  try {
    const files = readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("delivery-") && f.endsWith(".md"),
    );
    return files.length ? join("output", files[files.length - 1]) : null;
  } catch { return null; }
}

function readSession() {
  if (!existsSync(SESSION_FILE))
    return { sessionId: null, startTime: null, cycles: [], risks: [] };
  try { return JSON.parse(readFileSync(SESSION_FILE, "utf8")); } catch {
    return { sessionId: null, startTime: null, cycles: [], risks: [] };
  }
}

function appendSessionCycle(description, outcome, reason) {
  const s = readSession();
  if (!s.startTime) s.startTime = new Date().toISOString();
  if (!Array.isArray(s.cycles)) s.cycles = [];
  s.cycles.push({
    n: s.cycles.length + 1,
    description: description.slice(0, 100),
    completedAt: new Date().toISOString(),
    outcome,
    ...(reason && { reason }),
  });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

const { createPreRunSnapshot, refreshSnapshot, restoreFromSnapshot } =
  createSnapshotManager({
    snapshotDir: SNAPSHOT_DIR,
    root: ROOT,
    configuredAgents: CONFIGURED_AGENTS,
    readCycleState,
    chalk,
    execSync: (await import("child_process")).execSync,
  });

createPreRunSnapshot();

// ── Engine modules ────────────────────────────────────────────────────────────

const { checkAndRevertScopeViolations, autoUpdateScope, buildScopeCleanupCycle } =
  createScopeManager({
    CONFIGURED_AGENTS,
    ROOT,
    CYCLE_DIR,
    readCycleState,
    restoreFromSnapshot,
    appendLog,
  });

const { readQueue, writeQueue, printPendingQueue, nextCycleBatch, injectAdditionalGroups } =
  createQueueManager({ QUEUE_FILE, CONFIGURED_AGENTS, appendLog });

const { buildCyclePrompt } = createPromptBuilder({
  PROMPTS_DIR,
  AGENTS_DIR,
  CYCLE_DIR,
  CYCLE_STATE_RELDIR,
  SNAPSHOT_RELDIR,
  CONFIGURED_AGENTS,
  userTask,
  readCycleState,
  readQueue,
});

const { runCycle, runCycleBatch, getEffectiveMaxRetries } = createCycleRunner({
  ROOT,
  HARNESS_DIR,
  RUNS_DIR,
  CYCLE_DIR,
  runTimestamp,
  config,
  spendRef,
  killProc,
  buildFilteredMcpServers: (agentName) => buildFilteredMcpServers(agentName, { config, ROOT }),
  buildCyclePrompt,
  appendLog,
  notify,
});

const { runSmokeOrchestration } = createSmokeOrchestrator({
  ROOT, HARNESS_DIR, CYCLE_DIR, RUNS_DIR,
  config, CLAUDE_EXE, appendLog,
  buildFilteredMcpServers: (agentName) => buildFilteredMcpServers(agentName, { config, ROOT }),
});

// ── Pre-smoke step ────────────────────────────────────────────────────────────

async function runPreSmokeStep() {
  console.log(chalk.dim("[PRE-SMOKE] Detecting changed URLs..."));

  // 1. Read snapshot.json → extract changed file paths
  const snapshotFile = join(SNAPSHOT_DIR, "snapshot.json");
  let changedFiles = [];
  try {
    const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
    changedFiles = Object.keys(snapshot.index ?? snapshot ?? {});
  } catch { /* snapshot missing or malformed — proceed with empty list */ }

  // 2. Write changed-files.json
  const changedFilesOut = join(CYCLE_DIR, "changed-files.json");
  writeFileSync(changedFilesOut, JSON.stringify({ files: changedFiles }, null, 2), "utf8");

  // 3. Build url-detector prompt from template — inject changed-files inline
  const templatePath = join(PROMPTS_DIR, "url-detector.md");
  let promptText;
  const frontendRoot = deriveFrontendRoot(config);
  const detectedFramework = detectFramework(ROOT, frontendRoot);
  try {
    promptText = readFileSync(templatePath, "utf8")
      .replace(/\{\{CYCLE_STATE_DIR\}\}/g, CYCLE_STATE_RELDIR)
      .replace(/\{\{CHANGED_FILES_JSON\}\}/g, JSON.stringify({ files: changedFiles }, null, 2))
      .replace(/\{\{FRONTEND_ROOT\}\}/g, frontendRoot)
      .replace(/\{\{FRAMEWORK\}\}/g, detectedFramework);
  } catch {
    console.log(chalk.yellow("[PRE-SMOKE] url-detector.md template not found — skipping URL detection"));
    writeFileSync(join(CYCLE_DIR, "probe-urls.json"), JSON.stringify({ urls: [], layoutAffected: false, framework: "unknown" }, null, 2), "utf8");
    return;
  }

  // 4. Spawn mini claude
  const probeUrlsOut = join(CYCLE_DIR, "probe-urls.json");
  const isWindows = process.platform === "win32";

  // Capture stdout — in --output-format text mode Claude often prints the JSON as its
  // text response rather than using the Write tool. We accept either: if the Write tool
  // wrote probe-urls.json that takes precedence; otherwise we parse stdout as fallback.
  let stdoutBuf = "";

  await new Promise((resolve) => {
    let proc;
    const timeout = setTimeout(() => {
      try { proc?.kill(); } catch { /* already gone */ }
      resolve();
    }, 120_000);

    if (isWindows) {
      const promptFile = join(RUNS_DIR, `url-detector-prompt-${Date.now()}.txt`);
      const psFile = join(RUNS_DIR, `url-detector-${Date.now()}.ps1`);
      writeFileSync(promptFile, promptText, "utf8");
      writeFileSync(
        psFile,
        `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --allowedTools "Read,Write" --output-format text --max-turns 10 --max-budget-usd 0.05 --dangerously-skip-permissions\n`,
        "utf8",
      );
      proc = _spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      proc = _spawn(
        CLAUDE_EXE,
        ["-p", promptText, "--allowedTools", "Read,Write", "--output-format", "text", "--max-turns", "10", "--max-budget-usd", "0.05", "--dangerously-skip-permissions"],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    proc.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
    proc.on("close", () => { clearTimeout(timeout); resolve(); });
    proc.on("error", () => { clearTimeout(timeout); resolve(); });
  });

  // 5. If url-detector didn't write probe-urls.json via Write tool, try parsing stdout.
  //    In --output-format text mode Claude often prints JSON as its text response.
  if (!existsSync(probeUrlsOut)) {
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.framework === "string") {
          writeFileSync(probeUrlsOut, JSON.stringify(parsed, null, 2), "utf8");
          console.log(chalk.dim("[PRE-SMOKE] URL detector output captured from stdout"));
        }
      } catch { /* malformed — fall through */ }
    }
  }

  if (!existsSync(probeUrlsOut)) {
    console.log(chalk.yellow("[PRE-SMOKE] URL detector produced no output — falling back to filesystem scan"));
    const FILE_BASED_FW = new Set(["nextjs-app-router", "nextjs-pages-router", "nuxt", "sveltekit"]);
    const fallbackUrls = FILE_BASED_FW.has(detectedFramework)
      ? scanAllRoutes(ROOT, frontendRoot, detectedFramework)
      : [];
    writeFileSync(probeUrlsOut, JSON.stringify({ urls: fallbackUrls, layoutAffected: false, framework: detectedFramework }, null, 2), "utf8");
    if (fallbackUrls.length) {
      console.log(chalk.dim(`[PRE-SMOKE] ${fallbackUrls.length} URL(s) via filesystem scan → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
    }
  }

  // 6. Merge smokeUrls + filesystem-scanned routes into probe-urls.json
  const configSmokeUrls = Array.isArray(config.smokeUrls) ? config.smokeUrls : [];
  const FILE_BASED_FRAMEWORKS = new Set(["nextjs-app-router", "nextjs-pages-router", "nuxt", "sveltekit"]);
  try {
    const probe = JSON.parse(readFileSync(probeUrlsOut, "utf8"));
    // Engine-detected framework takes precedence — LLM may output "unknown" when only
    // hooks/components changed and no page files appear in the diff.
    const framework = (probe.framework && probe.framework !== "unknown")
      ? probe.framework
      : detectedFramework;
    let currentUrls = probe.urls ?? [];

    // Merge user-configured smokeUrls (always)
    const { merged: afterSmoke, appended } = mergeProbeUrls(currentUrls, configSmokeUrls);
    currentUrls = afterSmoke;

    // When layoutAffected OR no URLs detected yet: scan filesystem to guarantee coverage
    let scannedCount = 0;
    if ((probe.layoutAffected || !currentUrls.length) && FILE_BASED_FRAMEWORKS.has(framework)) {
      const scanned = scanAllRoutes(ROOT, frontendRoot, framework);
      const before = currentUrls.length;
      currentUrls = [...new Set([...currentUrls, ...scanned])];
      scannedCount = currentUrls.length - before;
    }

    const changed = appended.length || scannedCount > 0;
    if (changed) {
      writeFileSync(probeUrlsOut, JSON.stringify({ ...probe, urls: currentUrls }, null, 2), "utf8");
    }

    if (currentUrls.length) {
      const parts = [];
      if ((probe.urls ?? []).length) parts.push(`${(probe.urls ?? []).length} detected`);
      if (appended.length) parts.push(`+${appended.length} from smokeUrls`);
      if (scannedCount) parts.push(`+${scannedCount} scanned (layoutAffected)`);
      console.log(chalk.dim(`[PRE-SMOKE] ${currentUrls.length} URL(s) via ${framework} (${parts.join(", ")}) → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
    } else {
      console.log(chalk.yellow(`[PRE-SMOKE] No URLs to probe (framework: ${framework}) — add routes to smokeUrls[] in harness.config.json`));
    }
  } catch (err) {
    // Log the real error for debugging
    console.log(chalk.yellow(`[PRE-SMOKE] route merge failed (${err?.message ?? String(err)}) — falling back to filesystem scan`));
    try {
      const fallbackUrls = FILE_BASED_FRAMEWORKS.has(detectedFramework)
        ? scanAllRoutes(ROOT, frontendRoot, detectedFramework)
        : [];
      const merged = mergeProbeUrls(fallbackUrls, configSmokeUrls).merged;
      if (merged.length) {
        writeFileSync(probeUrlsOut, JSON.stringify({ urls: merged, layoutAffected: false, framework: detectedFramework }, null, 2), "utf8");
        console.log(chalk.dim(`[PRE-SMOKE] ${merged.length} URL(s) via filesystem scan → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
      } else {
        console.log(chalk.yellow(`[PRE-SMOKE] No URLs to probe — add routes to smokeUrls[] in harness.config.json`));
      }
    } catch { /* filesystem scan also failed */ }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();

  console.log("");
  console.log(chalk.bold.blue("━━━ Autonomous Multi-Cycle Run ━━━━━━━━━━━━━━━━━━"));
  console.log(`${chalk.dim("Task   :")} ${userTask}`);
  console.log(`${chalk.dim("Budget :")} $${MAX_BUDGET_USD} total`);
  console.log(`${chalk.dim("Log    :")} ${runLogFile}`);
  const { readNotificationConfig: _readNC } = await import("./notification-config.mjs");
  if (!_readNC().exists) {
    console.log(chalk.dim("  Notifications off — run `cortex-harness notify-setup` to enable"));
  }
  console.log(chalk.dim("─────────────────────────────────────────────────"));

  appendLog({ type: "harness", event: "run-start", task: userTask, timestamp: new Date().toISOString() });
  notify("Claude — Run Started", userTask.slice(0, 120), { event: "run-start" });

  // ── Phase 1: Orchestrate ────────────────────────────────────────────────────

  let queue = readQueue();

  if (!queue) {
    console.log(`\n${chalk.bold("[orchestrate]")} Planning cycles...`);
    process.stdout.write("Progress : ");

    const orchCycle = { id: "orchestrate", type: "orchestrate", status: "pending" };
    notify("Claude — Cycle Started", "orchestrate (orchestrate) | attempt 1", {
      event: "cycle-started", cycleId: orchCycle.id, cycleType: orchCycle.type, attempt: 1,
    });

    const orchResult = await runCycle(orchCycle, MAX_BUDGET_USD - spendRef.value);
    appendLog({ type: "cycle-result", cycleId: "orchestrate", ...orchResult });

    if (orchResult.signal === "complete") {
      notify("Claude — Cycle Complete", "orchestrate | planning finished", {
        event: "cycle-complete", cycleId: orchCycle.id, cycleType: orchCycle.type, turnCount: orchResult.turnCount,
      });
    }

    if (orchResult.signal === "needs-human") {
      appendSessionCycle("[autonomous] orchestrate", "blocked", "NEEDS_HUMAN_INPUT during planning");
      console.log(
        `\n${chalk.red.bold("[BLOCKED]")} Orchestration needs human input. Run summary written to session.json.`,
      );
      console.log(chalk.dim('  To provide input: cortex-harness resume "your answer"'));
      notify("Claude — Needs Input", `Orchestration blocked | ${userTask.slice(0, 60)}`);
      process.exit(0);
    }

    appendSessionCycle("[autonomous] orchestrate", orchResult.signal === "complete" ? "done" : "partial");

    queue = readQueue();
    if (!queue) {
      console.log(`\n${chalk.red("[ERROR]")} Orchestrator did not write task-queue.json. Aborting.`);
      notify("Claude — Run Failed", "No task queue produced by orchestrate cycle");
      process.exit(1);
    }

    const queueValidation = validateTaskQueue(queue);
    if (!queueValidation.valid) {
      console.log(`\n${chalk.yellow("[WARN]")} task-queue.json schema issues:`);
      queueValidation.errors.forEach((e) => console.log(`  ${chalk.dim("-")} ${e}`));
      appendLog({ type: "validation-warning", file: "task-queue.json", errors: queueValidation.errors });
    }
  }

  console.log(`\n${chalk.bold(`Queue: ${queue.cycles.length} cycles`)}`);
  queue.cycles.forEach((c) =>
    console.log(
      `  ${c.status === "done" ? chalk.green("[✓]") : chalk.dim("[ ]")} ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`,
    ),
  );
  console.log("");

  // ── Phase 2: Execute queue ──────────────────────────────────────────────────

  // Seed retryCount from each cycle's existing output-file history so the console
  // attempt label stays in sync with cycle-state attempts recorded in prior runs
  // (e.g. after `cortex-harness resume`), instead of restarting from 0 in memory.
  const retryCount = {};
  for (const c of queue.cycles) {
    if (!c.outputFile) continue;
    try {
      const prior = JSON.parse(readFileSync(join(CYCLE_DIR, c.outputFile), "utf8"));
      if (Array.isArray(prior.history) && prior.history.length) {
        retryCount[c.id] = prior.history.length;
      }
    } catch { /* no prior output file — start fresh */ }
  }

  while (true) {
    const remaining = MAX_BUDGET_USD - spendRef.value;
    if (remaining <= 0.1) {
      console.log(
        `\n${chalk.red("[BUDGET]")} $${MAX_BUDGET_USD} exhausted (${chalk.red(`$${spendRef.value.toFixed(2)}`)} spent). Stopping.`,
      );
      notify("Claude — Budget Exhausted", `$${spendRef.value.toFixed(2)} spent`);
      break;
    }

    const batch = nextCycleBatch(queue);
    if (!batch) {
      console.log(`\n${chalk.green.bold("[DONE]")} All cycles complete.`);
      const skippedPartials = queue.cycles.filter((c) => c.status === "partial");
      if (skippedPartials.length) {
        console.log(`\n${chalk.yellow("[WARN]")} ${skippedPartials.length} cycle(s) marked partial during this run:`);
        for (const c of skippedPartials) {
          const outputWritten = cycleOutputWritten(c);
          const outputLabel =
            c.type === "deliver"
              ? (deliverOutputFile() ?? "output/delivery-*.md")
              : (c.outputFile ?? "(none)");
          const statusNote = outputWritten
            ? `output saved (${outputLabel}) — resume to continue`
            : "no output written — did not start";
          console.log(
            `  ${chalk.yellow("•")} ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)} — reason: ${c.partialReason ?? "unknown"} — ${chalk.dim(statusNote)}`,
          );
        }
        console.log(`\n  ${chalk.dim("To retry: cortex-harness resume")}`);
        notify(
          "Claude — Partial Cycles Skipped",
          `${skippedPartials.length} partial: ${skippedPartials.map((c) => c.id).join(", ")}`,
        );
      }
      notify(
        "Claude — Run Complete",
        `${queue.cycles.filter((c) => c.status === "done").length} done | $${spendRef.value.toFixed(2)}`,
      );
      break;
    }

    if (batch.length === 1) {
      const attempt = (retryCount[batch[0].id] ?? 0) + 1;
      console.log(
        `\n${chalk.bold(`[cycle${attempt > 1 ? ` retry ${attempt}` : ""}]`)} ${chalk.cyan(batch[0].id)} ${chalk.dim(`(${batch[0].type})`)}`,
      );
    } else {
      console.log(
        `\n${chalk.bold(`[parallel ×${batch.length}]`)} ${batch.map((c) => chalk.cyan(c.id)).join(chalk.dim(" + "))}`,
      );
    }
    process.stdout.write(chalk.dim("Progress : "));

    if (batch.length === 1) {
      const attempt = (retryCount[batch[0].id] ?? 0) + 1;
      notify("Claude — Cycle Started", `${batch[0].id} (${batch[0].type}) | attempt ${attempt}`, {
        event: "cycle-started", cycleId: batch[0].id, cycleType: batch[0].type, attempt,
      });
    } else {
      notify(
        "Claude — Parallel Batch Started",
        `${batch.length} cycles | ${batch.map((c) => c.id).join(", ")}`,
        { event: "batch-started", batchIds: batch.map((c) => c.id) },
      );
    }

    // Run pre-smoke step before any batch that contains a smoke cycle
    if (batch.some(c => c.type === "smoke")) {
      await runPreSmokeStep();
    }

    // Intercept single-smoke batches — use the Node.js orchestrator instead of a full Claude session
    let batchResults;
    if (batch.length === 1 && batch[0].type === "smoke") {
      const cycle = batch[0];
      // start dev server for smoke
      const dsCfg = config.devServer ?? null;
      let devServerProcs = [];
      let devServerUrl = "";
      if (dsCfg) {
        const { startDevServer: _startDs } = await import("./engine/process-utils.mjs");
        const dsResult = await _startDs(dsCfg, { ROOT });
        devServerProcs = dsResult.procs;
        devServerUrl = dsResult.browserUrl;
      }

      const probeUrlsPath = join(CYCLE_DIR, "probe-urls.json");
      const probeUrlsJson = existsSync(probeUrlsPath)
        ? readFileSync(probeUrlsPath, "utf8")
        : '{"urls":[],"layoutAffected":false}';

      const result = await runSmokeOrchestration(cycle, probeUrlsJson, devServerUrl);
      devServerProcs.forEach(p => killProc(p));

      // Clean up smoke temp assets
      for (const f of ["changed-files.json", "probe-urls.json"]) {
        try { unlinkSync(join(CYCLE_DIR, f)); } catch { /* already gone */ }
      }
      batchResults = [{ cycle, result }];
    } else {
      batchResults = await runCycleBatch(batch, remaining);
    }
    let shouldBreak = false;

    for (const { cycle, result } of batchResults) {
      const attempt = (retryCount[cycle.id] ?? 0) + 1;
      retryCount[cycle.id] = attempt;
      appendLog({ type: "cycle-result", cycleId: cycle.id, attempt, ...result });

      // ── Complete ──────────────────────────────────────────────────────────────

      if (result.signal === "complete") {
        let testReport = null;

        if (cycle.outputFile) {
          const rawJson = readCycleState(cycle.outputFile);
          const isCritical = CRITICAL_OUTPUT_FILES.has(cycle.outputFile) || cycle.type === "test" || cycle.type === "smoke";

          if (!rawJson) {
            if (isCritical) {
              console.log(
                `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} reported complete but ${cycle.outputFile} not written — treating as partial`,
              );
              result.signal = "partial";
              result.finalMessage = `CYCLE_PARTIAL:output file ${cycle.outputFile} not written`;
            }
          } else {
            let parsed;
            try {
              parsed = JSON.parse(rawJson);
            } catch {
              if (isCritical) {
                console.log(
                  `  ${chalk.red("[ERROR]")} ${chalk.cyan(cycle.id)} wrote unparseable JSON to ${cycle.outputFile} — treating as failed`,
                );
                appendLog({ type: "validation-error", cycleId: cycle.id, file: cycle.outputFile, error: "invalid-json" });
                result.signal = "failed";
              } else {
                console.log(
                  `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} wrote invalid JSON to ${cycle.outputFile} — continuing with no context`,
                );
              }
              parsed = null;
            }

            if (parsed !== null) {
              const validation = validateCycleOutput(cycle.outputFile, parsed);
              if (!validation.valid && !validation.skipped) {
                console.log(
                  `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} schema mismatch (${validation.schemaName}):`,
                );
                validation.errors.forEach((e) => console.log(`    ${chalk.dim("-")} ${e}`));
                appendLog({ type: "validation-warning", cycleId: cycle.id, errors: validation.errors });
                if (isCritical) {
                  const defaults =
                    CONSERVATIVE_DEFAULTS[cycle.outputFile] ??
                    (cycle.type === "test" ? CONSERVATIVE_DEFAULTS["test.json"] : {});
                  testReport = { ...defaults, ...parsed };
                  console.log(
                    `  ${chalk.dim("[INFO]")} Using conservative defaults for missing critical fields in ${cycle.outputFile}`,
                  );
                }
              } else if (parsed !== null) {
                testReport = parsed;
              }
            }
          }
        }

        if (result.signal === "complete") {
          cycle.status = "done";
          cycle.completedAt = new Date().toISOString();
          cycle.turns = result.turnCount;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "done");

          const turnLabel = cycle.type === "smoke"
            ? `${result.turnCount ?? 0} URL${(result.turnCount ?? 0) !== 1 ? "s" : ""} checked`
            : `${result.turnCount ?? 0} turns`;
          if (batch.length === 1)
            console.log(`  ${chalk.green("[OK]")} ${chalk.dim(turnLabel)}`);
          else
            console.log(`  ${chalk.green("[OK]")} ${chalk.cyan(cycle.id)} ${chalk.dim(`— ${turnLabel}`)}`);

          notify("Claude — Cycle Complete", `${cycle.id} | ${turnLabel}`, {
            event: "cycle-complete", cycleId: cycle.id, cycleType: cycle.type, attempt, turnCount: result.turnCount,
          });

          autoUpdateScope(cycle);
          refreshSnapshot(cycle);

          const unrevertable = checkAndRevertScopeViolations(cycle);
          if (unrevertable && unrevertable.length > 0) {
            appendLog({ type: "harness", event: "scope-revert-unrecoverable", cycleId: cycle.id, files: unrevertable });
            console.log(
              `\n  ${chalk.red("[SCOPE CLEANUP]")} ${unrevertable.length} file(s) could not be auto-reverted — injecting cleanup cycle for ${chalk.cyan(cycle.agent)}:`,
            );
            unrevertable.forEach((f) => console.log(`    ${chalk.dim("-")} ${chalk.red(f)}`));

            const cleanupCycle = buildScopeCleanupCycle(cycle, unrevertable);
            const insertIdx = queue.cycles.findIndex(
              (c) => c.status === "pending" && (c.type.startsWith("implement-") || c.type === "reconcile"),
            );
            queue.cycles.splice(insertIdx !== -1 ? insertIdx : queue.cycles.length, 0, cleanupCycle);
            writeQueue(queue);
            console.log(
              `  ${chalk.dim(`Cleanup cycle "${cleanupCycle.id}" inserted at position ${insertIdx !== -1 ? insertIdx : "end"}`)}`,
            );
            printPendingQueue(queue);
          }

          // Write human-readable markdown summary after deliver cycle
          if (cycle.type === "deliver") {
            const rawSummary = result.finalMessage ?? "";
            const summary = rawSummary.replace(/\s*CYCLE_COMPLETE\s*$/, "").trim();
            if (summary) {
              const deliverFile = join(OUTPUT_DIR, `delivery-${runTimestamp}.md`);
              const header = `# Delivery — ${runTimestamp}\n\n**Task:** ${userTask}\n\n---\n\n`;
              try {
                writeFileSync(deliverFile, header + summary, "utf8");
                console.log(
                  `  ${chalk.green("[DELIVER]")} Summary written to ${chalk.dim(`output/delivery-${runTimestamp}.md`)}`,
                );
              } catch (err) {
                console.log(`  ${chalk.yellow("[WARN]")} Could not write delivery markdown: ${err.message}`);
              }
            }
          }

          // Inject additional groups discovered during cross-group reconcile
          if (cycle.id === "reconcile-cross-group" && cycle.outputFile) {
            const rcgRaw = readCycleState(cycle.outputFile);
            if (rcgRaw) {
              try {
                const rcgReport = JSON.parse(rcgRaw);
                const injected = injectAdditionalGroups(rcgReport, queue);
                if (injected) {
                  appendLog({ type: "harness", event: "additional-groups-injected", cycleId: cycle.id });
                  notify("Claude — Additional Groups Injected", `New work discovered in cross-group reconcile — queue extended`);
                }
              } catch { /* invalid JSON — non-critical */ }
            }
          }

          // Inject fix cycles or smoke-retry on smoke failure
          if (cycle.type === "smoke" && testReport !== null) {
            const sg = cycle.taskGroup;
            const sgSuffix = sg ? `-${sg}` : "";
            // Count total smoke attempts for this group (not per-cycle-ID) to prevent infinite loop
            const totalSmokeAttempts = queue.cycles.filter((c) =>
              c.type === "smoke" &&
              (sg ? c.taskGroup === sg : !c.taskGroup) &&
              (c.status === "done" || c.id === cycle.id)
            ).length;
            if (!testReport.passed && !testReport.skipped && !testReport.partial && !testReport.authIssue && totalSmokeAttempts <= MAX_RETRIES) {
              const failures = testReport.failures ?? [];
              const hasFrontendFailure = failures.some((f) => f.pageError != null || (f.issues?.length && !f.apiFailures?.length));
              const hasApiFailure = failures.some((f) => Array.isArray(f.apiFailures) && f.apiFailures.length > 0);
              const surfaces = [];
              if (hasFrontendFailure) surfaces.push("frontend");
              if (hasApiFailure) surfaces.push("backend");
              if (!surfaces.length) surfaces.push("frontend");

              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const fixCycles = surfaces.map((surface) => ({
                id: `fix-${surface}-smoke-attempt-${totalSmokeAttempts}${sgSuffix}`,
                type: "fix",
                target: surface,
                ...(sg ? { taskGroup: sg } : {}),
                ...(cycle.subTask ? { subTask: cycle.subTask } : {}),
                status: "pending",
                outputFile: `fix-${surface}-smoke-attempt-${totalSmokeAttempts}${sgSuffix}.json`,
                notes: `Fix injected after smoke failure attempt ${totalSmokeAttempts}: ${failures.map((f) => f.issues?.[0] ?? f.issue ?? "unknown").slice(0, 3).join("; ")}`,
              }));
              const retrySmoke = {
                id: `smoke-retry-${totalSmokeAttempts}${sgSuffix}`,
                type: "smoke",
                ...(sg ? { taskGroup: sg } : {}),
                ...(cycle.subTask ? { subTask: cycle.subTask } : {}),
                status: "pending",
                outputFile: `smoke${sgSuffix}.json`,
                notes: `Smoke retry after fix attempt ${totalSmokeAttempts}`,
              };
              const insertAt = deliverIdx !== -1 ? deliverIdx : queue.cycles.length;
              queue.cycles.splice(insertAt, 0, ...fixCycles, retrySmoke);
              writeQueue(queue);
              console.log(
                `  ${chalk.yellow("[SMOKE FIX]")} Smoke failed (attempt ${totalSmokeAttempts}/${MAX_RETRIES}) — injecting fix cycles for: ${chalk.cyan(surfaces.join(", "))}`,
              );
              printPendingQueue(queue);
            } else if (!testReport.passed && !testReport.skipped && !testReport.partial) {
              console.log(
                `  ${chalk.red("[SMOKE FAILED]")} Smoke failed after ${totalSmokeAttempts} attempt(s) — deliver will surface failures as NEEDS_HUMAN_INPUT`,
              );
            }
          }

          // Inject fix cycles or recovery cycle on test failure
          if (cycle.type === "test" && testReport !== null) {
            const fg = cycle.taskGroup;
            const fgSuffix = fg ? `-${fg}` : "";
            // Count total test attempts for this group (not per-cycle-ID) to prevent infinite fix loop
            const totalTestAttempts = queue.cycles.filter((c) =>
              c.type === "test" &&
              (fg ? c.taskGroup === fg : !c.taskGroup) &&
              (c.status === "done" || c.id === cycle.id)
            ).length;
            if (!testReport.passed && totalTestAttempts <= MAX_RETRIES) {
              const surfaces = (testReport.failedSurfaces?.length ? testReport.failedSurfaces : ["unknown"])
                .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown");
              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const fixCycles = surfaces.map((surface) => ({
                id: `fix-${surface}-attempt-${totalTestAttempts}${fgSuffix}`,
                type: "fix",
                target: surface,
                ...(fg ? { taskGroup: fg } : {}),
                ...(cycle.subTask ? { subTask: cycle.subTask } : {}),
                status: "pending",
                outputFile: `fix-${surface}-attempt-${totalTestAttempts}${fgSuffix}.json`,
              }));
              const retryTest = {
                id: `test-retry-${totalTestAttempts}${fgSuffix}`,
                type: "test",
                ...(fg ? { taskGroup: fg } : {}),
                ...(cycle.subTask ? { subTask: cycle.subTask } : {}),
                status: "pending",
                outputFile: `test${fgSuffix}.json`,
              };
              const insertAt = deliverIdx !== -1 ? deliverIdx : queue.cycles.length;
              queue.cycles.splice(insertAt, 0, ...fixCycles, retryTest);
              writeQueue(queue);
              console.log(
                `  ${chalk.yellow("[FIX]")} Tests failed (attempt ${totalTestAttempts}/${MAX_RETRIES}) — injecting fix cycles for: ${chalk.cyan(surfaces.join(", "))}`,
              );
              printPendingQueue(queue);
            } else if (!testReport.passed) {
              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const recoveryCycle = {
                id: `recovery${fgSuffix}`,
                type: "recovery",
                ...(fg ? { taskGroup: fg } : {}),
                status: "pending",
                outputFile: `recovery${fgSuffix}.json`,
                notes: `Injected after test failed ${attempt} times`,
              };
              queue.cycles.splice(deliverIdx !== -1 ? deliverIdx : queue.cycles.length, 0, recoveryCycle);
              writeQueue(queue);
              console.log(
                `  ${chalk.red("[RECOVERY]")} Tests failed after ${attempt} attempts — injecting recovery cycle`,
              );
              printPendingQueue(queue);
              notify("Claude — Recovery Cycle", `${attempt} test attempts exhausted`);
            }
          }
        }
      }

      // ── Needs human ───────────────────────────────────────────────────────────

      if (result.signal === "needs-human") {
        const nhiIdx = result.finalMessage.indexOf("NEEDS_HUMAN_INPUT");
        const questionText = nhiIdx !== -1
          ? result.finalMessage.slice(nhiIdx + "NEEDS_HUMAN_INPUT".length).replace(/^[:\s–-]+/, "").trim()
          : result.finalMessage.trim();

        cycle.status = "blocked";
        cycle.blockedType = "needs-human-input";
        cycle.blockedReason = questionText || result.finalMessage;
        cycle.blockedAt = new Date().toISOString();
        writeQueue(queue);
        appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason.slice(0, 200));

        console.log(`\n${chalk.red.bold("[BLOCKED]")} ${chalk.cyan(cycle.id)} needs human input.`);
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        for (const line of questionText.split("\n")) console.log(`  ${line}`);
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        console.log(chalk.yellow('  Answer: cortex-harness resume "your answer"'));

        notify("Claude — Needs Input", questionText.slice(0, 100), {
          event: "needs-human-input", cycleId: cycle.id,
        });
        shouldBreak = true;

      } else if (result.signal === "session-limit") {
        const resetsAt = result.resetsAt ?? null;
        const resetStr = resetsAt
          ? new Date(resetsAt * 1000).toLocaleString()
          : "unknown — check your Claude plan";
        cycle.status = "blocked";
        cycle.blockedType = "session-limit";
        cycle.blockedReason = `session/weekly limit hit — resets ${resetStr}`;
        writeQueue(queue);
        appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
        console.log(`\n${chalk.red("[SESSION LIMIT]")} ${chalk.cyan(cycle.id)} — usage limit reached.`);
        console.log(`  Resets: ${chalk.yellow(resetStr)}`);
        console.log(`  ${chalk.dim("All pending cycles are preserved. Run `cortex-harness resume` after the limit resets.")}`);
        notify("Claude — Session Limit Hit", `${cycle.id} blocked | resets ${resetStr}`, {
          event: "session-limit", cycleId: cycle.id, resetsAt,
        });
        shouldBreak = true;

      } else if (result.signal === "partial") {
        const reasonMatch = result.finalMessage.match(/CYCLE_PARTIAL:(.+)/);
        const reason = reasonMatch?.[1]?.trim() ?? "incomplete";
        const nextAttempt = attempt + 1;
        const effectiveMaxRetries = getEffectiveMaxRetries(cycle, reason, result.signal, result.finalMessage);

        if (attempt < effectiveMaxRetries) {
          console.log(
            `  ${chalk.yellow("[PARTIAL → retry]")} ${chalk.cyan(cycle.id)}: ${reason} ${chalk.dim(`(attempt ${nextAttempt}/${effectiveMaxRetries})`)}`,
          );
          notify("Claude — Cycle Retrying", `${cycle.id} | partial | retry ${nextAttempt}/${effectiveMaxRetries}`, {
            event: "cycle-retrying", cycleId: cycle.id, cycleType: cycle.type, attempt, nextAttempt,
          });
        } else {
          cycle.status = "partial";
          cycle.partialReason = reason;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "partial", reason);
          console.log(
            `  ${chalk.yellow("[PARTIAL]")} ${chalk.cyan(cycle.id)} incomplete after ${attempt} attempts: ${reason}`,
          );
          const remainingAfter = queue.cycles.filter((c) => c.status === "pending");
          if (remainingAfter.length) {
            console.log(
              `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} is partial — run continues but downstream cycles may be affected. ${chalk.dim("Run: cortex-harness resume to retry.")}`,
            );
          }
          notify("Claude — Cycle Partial", `${cycle.id} | ${reason.slice(0, 80)}`);
        }

      } else if (result.signal !== "complete") {
        const isHardError = result.signal === "error";
        const effectiveMaxRetriesErr = getEffectiveMaxRetries(cycle, result.finalMessage, result.signal);
        if (!isHardError && attempt < effectiveMaxRetriesErr) {
          console.log(
            `  ${chalk.yellow(`[${result.signal.toUpperCase()} → retry ${attempt + 1}/${effectiveMaxRetriesErr}]`)} ${chalk.cyan(cycle.id)}`,
          );
          notify("Claude — Cycle Retrying", `${cycle.id} | ${result.signal} | retry ${attempt + 1}/${effectiveMaxRetriesErr}`, {
            event: "cycle-retrying", cycleId: cycle.id, cycleType: cycle.type, attempt, nextAttempt: attempt + 1,
          });
        } else {
          cycle.status = "blocked";
          cycle.blockedReason = isHardError
            ? `spawn error: ${result.error ?? result.finalMessage}`
            : `${result.signal} after ${attempt} attempts`;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
          console.log(
            isHardError
              ? `\n${chalk.red.bold("[ERROR]")} ${chalk.cyan(cycle.id)} failed to spawn — stopping run.`
              : `\n${chalk.red.bold("[BLOCKED]")} ${chalk.cyan(cycle.id)} ${result.signal} — ${attempt} attempts exhausted.`,
          );
          notify("Claude — Cycle Failed", `${cycle.id} | ${result.signal}`);
          shouldBreak = true;
        }
      }
    }

    if (shouldBreak) break;
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  const finalQueue = readQueue();
  const done = finalQueue?.cycles.filter((c) => c.status === "done").length ?? 0;
  const blocked = finalQueue?.cycles.filter((c) => c.status === "blocked").length ?? 0;
  const partial = finalQueue?.cycles.filter((c) => c.status === "partial").length ?? 0;
  const pending = finalQueue?.cycles.filter((c) => c.status === "pending").length ?? 0;
  const elapsed = Math.round((Date.now() - runStart) / 1000);
  const duration =
    elapsed >= 3600
      ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
      : elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
        : `${elapsed}s`;

  console.log("");
  console.log(chalk.bold.blue("━━━ Run Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(`${chalk.dim("Done     :")} ${done > 0 ? chalk.green(done) : done}`);
  console.log(`${chalk.dim("Partial  :")} ${partial > 0 ? chalk.yellow(partial) : partial}`);
  console.log(`${chalk.dim("Blocked  :")} ${blocked > 0 ? chalk.red(blocked) : blocked}`);
  console.log(`${chalk.dim("Pending  :")} ${pending > 0 ? chalk.yellow(pending) : pending}`);
  console.log(`${chalk.dim("Duration :")} ${duration}`);
  console.log(`${chalk.dim("Spent    :")} $${spendRef.value.toFixed(2)} / $${MAX_BUDGET_USD}`);
  console.log(`${chalk.dim("Log      :")} ${runLogFile}`);
  console.log(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));

  appendLog({
    type: "harness",
    event: "run-end",
    done,
    blocked,
    partial,
    pending,
    totalSpentUsd: spendRef.value,
    duration,
  });
}

main().catch((err) => {
  console.error("[FATAL]", err);
  const appendLogFallback = (obj) => {
    try { appendFileSync(runLogFile, JSON.stringify(obj) + "\n", "utf8"); } catch { /* best-effort */ }
  };
  appendLogFallback({ type: "harness", event: "fatal", error: err.message });
  dispatchNotification({ title: "Claude — Fatal Error", message: err.message.slice(0, 100), meta: {}, onWarning: () => {} });
  process.exit(1);
});

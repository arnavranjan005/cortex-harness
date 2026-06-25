import { logger } from "./logger.mjs";
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
import { CYCLE_SIGNAL, isRetryable } from "./engine/cycle-signal.mjs";
import { resolveAdapter, isProviderInstalled, DEFAULT_CLI_PROVIDER } from "./engine/cli-adapters/registry.mjs";
import { normalizeAdapterOutput } from "./engine/cli-adapters/output-normalize.mjs";
import { parseLenientJson } from "./engine/cli-adapters/lenient-json.mjs";
import { createSmokeOrchestrator } from "./engine/smoke-orchestrator.mjs";
import { mergeProbeUrls } from "./engine/probe-urls.mjs";
import { scanAllRoutes, deriveFrontendRoot, detectFramework, buildDynamicUrlOverrides } from "./engine/route-scanner.mjs";

// ── Load Config ───────────────────────────────────────────────────────────────

const config = await loadConfig();

const {
  harnessDir: HARNESS_DIR,
  promptsDir: PROMPTS_DIR,
  agentsDir: AGENTS_DIR,
  promptsOverrideDir: PROMPTS_OVERRIDE_DIR,
  agentsOverrideDir: AGENTS_OVERRIDE_DIR,
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
      logger.info(`${chalk.dim("[resume]")} Using task from task-queue.json: ${userTask}`);
    }
  } catch { /* no queue yet */ }
} else {
  try {
    const existingQueue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (existingQueue?.task && existingQueue.task !== cliTask) {
      logger.info(
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
  logger.error('Usage: cortex-harness run "your task description"');
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
      logger.warn(warning);
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
  PROMPTS_OVERRIDE_DIR,
  AGENTS_OVERRIDE_DIR,
  CYCLE_DIR,
  CYCLE_STATE_RELDIR,
  SNAPSHOT_RELDIR,
  CONFIGURED_AGENTS,
  userTask,
  readCycleState,
  readQueue,
});

const cliProvider = config.cliProvider ?? DEFAULT_CLI_PROVIDER;
const adapter = resolveAdapter(cliProvider);

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
  adapter,
});

const { runSmokeOrchestration } = createSmokeOrchestrator({
  ROOT, HARNESS_DIR, CYCLE_DIR, RUNS_DIR,
  config, adapter, appendLog,
  buildFilteredMcpServers: (agentName) => buildFilteredMcpServers(agentName, { config, ROOT }),
});

// ── Pre-smoke step ────────────────────────────────────────────────────────────

async function runPreSmokeStep() {
  logger.info(chalk.dim("[PRE-SMOKE] Detecting changed URLs..."));

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
    logger.info(chalk.yellow("[PRE-SMOKE] url-detector.md template not found — skipping URL detection"));
    writeFileSync(join(CYCLE_DIR, "probe-urls.json"), JSON.stringify({ urls: [], layoutAffected: false, framework: "unknown" }, null, 2), "utf8");
    return;
  }

  // routeParams maps dynamic segment names (e.g. "id", "slug") to a concrete value
  // to substitute when scanning the filesystem — falls back to a generic "1"/"test"
  // placeholder per-segment when a name isn't configured.
  const routeParams = (config.routeParams && typeof config.routeParams === "object") ? config.routeParams : {};

  // 4. Spawn mini claude — no Write tool. The detector only ever prints JSON
  // (--output-format text); the engine parses stdout and writes probe-urls.json
  // itself, mechanically, so routeParams substitution always goes through one
  // code path (deriveRouteInfo) instead of needing the LLM to also know about it.
  const probeUrlsOut = join(CYCLE_DIR, "probe-urls.json");
  const isWindows = process.platform === "win32";

  let stdoutBuf = "";
  let rawStdout = "";

  const promptFile = join(RUNS_DIR, `url-detector-prompt-${Date.now()}.txt`);
  writeFileSync(promptFile, promptText, "utf8");
  const detectorPlan = adapter.buildSummarySpawnPlan({
    prompt: promptText, budgetUsd: 0.05, promptFile, isWindows, maxTurns: 10, allowedToolPatterns: ["Read"],
  });

  await new Promise((resolve) => {
    let proc;
    const timeout = setTimeout(() => {
      try { proc?.kill(); } catch { /* already gone */ }
      resolve();
    }, 120_000);

    if (isWindows) {
      const psFile = join(RUNS_DIR, `url-detector-${Date.now()}.ps1`);
      writeFileSync(psFile, detectorPlan.psContent, "utf8");
      proc = _spawn(
        detectorPlan.command,
        detectorPlan.args.map((a) => (a === "__PS_FILE__" ? psFile : a)),
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      proc = _spawn(detectorPlan.command, detectorPlan.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    }

    proc.stdout.on("data", (chunk) => { rawStdout += chunk.toString("utf8"); });
    proc.on("close", () => { clearTimeout(timeout); stdoutBuf = normalizeAdapterOutput(adapter, rawStdout, detectorPlan.outputFormat); resolve(); });
    proc.on("error", () => { clearTimeout(timeout); resolve(); });
  });

  // 5. Parse the detector's stdout JSON: { urls: [{url, isDynamic}], layoutAffected, framework }.
  // Mechanically split into urls/dynamicUrls and resolve routeParams overrides for any
  // dynamic URL that matches a changed page file — via the same deriveRouteInfo used by
  // scanAllRoutes, so there is exactly one implementation of "what routeParams resolves to".
  if (!existsSync(probeUrlsOut)) {
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = parseLenientJson(jsonMatch[0]);
        if (typeof parsed.framework === "string" && Array.isArray(parsed.urls)) {
          const overrides = buildDynamicUrlOverrides(changedFiles, frontendRoot, parsed.framework, routeParams);
          const urls = [];
          const dynamicUrls = [];
          for (const entry of parsed.urls) {
            const rawUrl = typeof entry === "string" ? entry : entry?.url;
            if (typeof rawUrl !== "string") continue;
            const isDynamic = typeof entry === "object" && entry.isDynamic === true;
            const url = isDynamic ? (overrides.get(rawUrl) ?? rawUrl) : rawUrl;
            urls.push(url);
            if (isDynamic) dynamicUrls.push(url);
          }
          writeFileSync(
            probeUrlsOut,
            JSON.stringify({ urls, dynamicUrls, layoutAffected: parsed.layoutAffected === true, framework: parsed.framework }, null, 2),
            "utf8",
          );
          logger.info(chalk.dim("[PRE-SMOKE] URL detector output captured from stdout"));
        }
      } catch { /* malformed — fall through */ }
    }
  }

  if (!existsSync(probeUrlsOut)) {
    logger.info(chalk.yellow("[PRE-SMOKE] URL detector produced no output — falling back to filesystem scan"));
    const FILE_BASED_FW = new Set(["nextjs-app-router", "nextjs-pages-router", "nuxt", "sveltekit"]);
    const fallback = FILE_BASED_FW.has(detectedFramework)
      ? scanAllRoutes(ROOT, frontendRoot, detectedFramework, routeParams)
      : { urls: [], dynamicUrls: [] };
    writeFileSync(probeUrlsOut, JSON.stringify({ urls: fallback.urls, dynamicUrls: fallback.dynamicUrls, layoutAffected: false, framework: detectedFramework }, null, 2), "utf8");
    if (fallback.urls.length) {
      logger.info(chalk.dim(`[PRE-SMOKE] ${fallback.urls.length} URL(s) via filesystem scan → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
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
    let dynamicUrls = new Set(probe.dynamicUrls ?? []);

    // Merge user-configured smokeUrls (always) — these are concrete, user-supplied
    // URLs, never placeholder-derived, so they are never added to dynamicUrls.
    const { merged: afterSmoke, appended } = mergeProbeUrls(currentUrls, configSmokeUrls);
    currentUrls = afterSmoke;

    // When layoutAffected OR no URLs detected yet: scan filesystem to guarantee coverage
    let scannedCount = 0;
    if ((probe.layoutAffected || !currentUrls.length) && FILE_BASED_FRAMEWORKS.has(framework)) {
      const scanned = scanAllRoutes(ROOT, frontendRoot, framework, routeParams);
      const before = currentUrls.length;
      currentUrls = [...new Set([...currentUrls, ...scanned.urls])];
      for (const u of scanned.dynamicUrls) dynamicUrls.add(u);
      scannedCount = currentUrls.length - before;
    }

    const changed = appended.length || scannedCount > 0;
    if (changed) {
      writeFileSync(probeUrlsOut, JSON.stringify({ ...probe, urls: currentUrls, dynamicUrls: [...dynamicUrls].sort() }, null, 2), "utf8");
    }

    if (currentUrls.length) {
      const parts = [];
      if ((probe.urls ?? []).length) parts.push(`${(probe.urls ?? []).length} detected`);
      if (appended.length) parts.push(`+${appended.length} from smokeUrls`);
      if (scannedCount) parts.push(`+${scannedCount} scanned (layoutAffected)`);
      logger.info(chalk.dim(`[PRE-SMOKE] ${currentUrls.length} URL(s) via ${framework} (${parts.join(", ")}) → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
    } else {
      logger.info(chalk.yellow(`[PRE-SMOKE] No URLs to probe (framework: ${framework}) — add routes to smokeUrls[] in harness.config.json`));
    }
  } catch (err) {
    // Log the real error for debugging
    logger.info(chalk.yellow(`[PRE-SMOKE] route merge failed (${err?.message ?? String(err)}) — falling back to filesystem scan`));
    try {
      const fallback = FILE_BASED_FRAMEWORKS.has(detectedFramework)
        ? scanAllRoutes(ROOT, frontendRoot, detectedFramework, routeParams)
        : { urls: [], dynamicUrls: [] };
      const merged = mergeProbeUrls(fallback.urls, configSmokeUrls).merged;
      if (merged.length) {
        writeFileSync(probeUrlsOut, JSON.stringify({ urls: merged, dynamicUrls: fallback.dynamicUrls, layoutAffected: false, framework: detectedFramework }, null, 2), "utf8");
        logger.info(chalk.dim(`[PRE-SMOKE] ${merged.length} URL(s) via filesystem scan → ${CYCLE_STATE_RELDIR}/probe-urls.json`));
      } else {
        logger.info(chalk.yellow(`[PRE-SMOKE] No URLs to probe — add routes to smokeUrls[] in harness.config.json`));
      }
    } catch { /* filesystem scan also failed */ }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();

  logger.info("");
  logger.info(chalk.bold.blue("━━━ Autonomous Multi-Cycle Run ━━━━━━━━━━━━━━━━━━"));
  logger.info(`${chalk.dim("Task   :")} ${userTask}`);
  logger.info(`${chalk.dim("CLI    :")} ${cliProvider}${cliProvider === DEFAULT_CLI_PROVIDER ? "" : chalk.dim(" (non-default)")}`);
  if (!isProviderInstalled(cliProvider)) {
    logger.info(chalk.yellow(`  [WARN] "${cliProvider}" CLI not found on PATH — cycles will likely fail to spawn. Run "cortex-harness config" to switch backends.`));
  }
  logger.info(`${chalk.dim("Budget :")} $${MAX_BUDGET_USD} total`);
  logger.info(`${chalk.dim("Log    :")} ${runLogFile}`);
  const { readNotificationConfig: _readNC } = await import("./notification-config.mjs");
  if (!_readNC().exists) {
    logger.info(chalk.dim("  Notifications off — run `cortex-harness notify-setup` to enable"));
  }
  logger.info(chalk.dim("─────────────────────────────────────────────────"));

  appendLog({ type: "harness", event: "run-start", task: userTask, cliProvider, timestamp: new Date().toISOString() });
  notify("Claude — Run Started", userTask.slice(0, 120), { event: "run-start" });

  // ── Phase 1: Orchestrate ────────────────────────────────────────────────────

  let queue = readQueue();

  if (!queue) {
    logger.info(`\n${chalk.bold("[orchestrate]")} Planning cycles...`);
    process.stdout.write("Progress : ");

    const orchCycle = { id: "orchestrate", type: "orchestrate", status: "pending" };
    notify("Claude — Cycle Started", "orchestrate (orchestrate) | attempt 1", {
      event: "cycle-started", cycleId: orchCycle.id, cycleType: orchCycle.type, attempt: 1,
    });

    const orchResult = await runCycle(orchCycle, MAX_BUDGET_USD - spendRef.value);
    appendLog({ type: "cycle-result", cycleId: "orchestrate", ...orchResult });

    if (orchResult.signal === CYCLE_SIGNAL.COMPLETE) {
      notify("Claude — Cycle Complete", "orchestrate | planning finished", {
        event: "cycle-complete", cycleId: orchCycle.id, cycleType: orchCycle.type, turnCount: orchResult.turnCount,
      });
    }

    if (orchResult.signal === CYCLE_SIGNAL.NEEDS_HUMAN) {
      appendSessionCycle("[autonomous] orchestrate", "blocked", "NEEDS_HUMAN_INPUT during planning");
      logger.info(
        `\n${chalk.red.bold("[BLOCKED]")} Orchestration needs human input. Run summary written to session.json.`,
      );
      logger.info(chalk.dim('  To provide input: cortex-harness resume "your answer"'));
      notify("Claude — Needs Input", `Orchestration blocked | ${userTask.slice(0, 60)}`);
      process.exit(0);
    }

    appendSessionCycle("[autonomous] orchestrate", orchResult.signal === CYCLE_SIGNAL.COMPLETE ? "done" : "partial");

    queue = readQueue();
    if (!queue) {
      logger.info(`\n${chalk.red("[ERROR]")} Orchestrator did not write task-queue.json. Aborting.`);
      notify("Claude — Run Failed", "No task queue produced by orchestrate cycle");
      process.exit(1);
    }

    const queueValidation = validateTaskQueue(queue);
    if (!queueValidation.valid) {
      logger.info(`\n${chalk.yellow("[WARN]")} task-queue.json schema issues:`);
      queueValidation.errors.forEach((e) => logger.info(`  ${chalk.dim("-")} ${e}`));
      appendLog({ type: "validation-warning", file: "task-queue.json", errors: queueValidation.errors });
    }
  }

  logger.info(`\n${chalk.bold(`Queue: ${queue.cycles.length} cycles`)}`);
  queue.cycles.forEach((c) =>
    logger.info(
      `  ${c.status === "done" ? chalk.green("[✓]") : chalk.dim("[ ]")} ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`,
    ),
  );
  logger.info("");

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
      logger.info(
        `\n${chalk.red("[BUDGET]")} $${MAX_BUDGET_USD} exhausted (${chalk.red(`$${spendRef.value.toFixed(2)}`)} spent). Stopping.`,
      );
      notify("Claude — Budget Exhausted", `$${spendRef.value.toFixed(2)} spent`);
      break;
    }

    const batch = nextCycleBatch(queue);
    if (!batch) {
      logger.info(`\n${chalk.green.bold("[DONE]")} All cycles complete.`);
      const skippedPartials = queue.cycles.filter((c) => c.status === "partial");
      if (skippedPartials.length) {
        logger.info(`\n${chalk.yellow("[WARN]")} ${skippedPartials.length} cycle(s) marked partial during this run:`);
        for (const c of skippedPartials) {
          const outputWritten = cycleOutputWritten(c);
          const outputLabel =
            c.type === "deliver"
              ? (deliverOutputFile() ?? "output/delivery-*.md")
              : (c.outputFile ?? "(none)");
          const statusNote = outputWritten
            ? `output saved (${outputLabel}) — resume to continue`
            : "no output written — did not start";
          logger.info(
            `  ${chalk.yellow("•")} ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)} — reason: ${c.partialReason ?? "unknown"} — ${chalk.dim(statusNote)}`,
          );
        }
        logger.info(`\n  ${chalk.dim("To retry: cortex-harness resume")}`);
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
      logger.info(
        `\n${chalk.bold(`[cycle${attempt > 1 ? ` retry ${attempt}` : ""}]`)} ${chalk.cyan(batch[0].id)} ${chalk.dim(`(${batch[0].type})`)}`,
      );
    } else {
      logger.info(
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
      let probeUrlsJson = existsSync(probeUrlsPath)
        ? readFileSync(probeUrlsPath, "utf8")
        : '{"urls":[],"layoutAffected":false}';

      // For retry smoke cycles — collect full chronological history and narrow URL list
      // to only previously-failed pages. All history is sent to every per-URL agent;
      // the prompt instructs each agent to focus on its specific URL.
      let priorSmokeContext = null;
      if (cycle.id.startsWith("smoke-retry-")) {
        const sg = cycle.taskGroup;
        const smokeSuffix = sg ? `-${sg}` : "";

        // Read ALL smoke-attempt-N.json snapshots in chronological order.
        // Each entry gets _attempt (number) and _file (name) metadata so the prompt
        // can interleave them with the matching fix reports.
        let smokeAttempts = [];
        try {
          smokeAttempts = readdirSync(CYCLE_DIR)
            .filter(f => new RegExp(`^smoke-attempt-\\d+${smokeSuffix}\.json$`).test(f))
            .sort((a, b) => {
              const nA = parseInt(a.match(/smoke-attempt-(\d+)/)[1]);
              const nB = parseInt(b.match(/smoke-attempt-(\d+)/)[1]);
              return nA - nB;
            })
            .map(f => {
              try {
                const n = parseInt(f.match(/smoke-attempt-(\d+)/)[1]);
                return { _attempt: n, _file: f, ...JSON.parse(readFileSync(join(CYCLE_DIR, f), "utf8")) };
              } catch { return null; }
            })
            .filter(Boolean);
        } catch { /* cycle-state unreadable */ }

        // Read all fix-smoke reports with _file metadata so the prompt can
        // match each fix to the smoke attempt number in its filename.
        let fixReports = [];
        try {
          fixReports = readdirSync(CYCLE_DIR)
            .filter(f => /^fix-.*-smoke-attempt-.*\.json$/.test(f))
            .sort()
            .map(f => {
              try { return { _file: f, ...JSON.parse(readFileSync(join(CYCLE_DIR, f), "utf8")) }; }
              catch { return null; }
            })
            .filter(Boolean);
        } catch { /* cycle-state unreadable */ }

        if (smokeAttempts.length || fixReports.length) {
          priorSmokeContext = { smokeAttempts, fixReports };

          // Narrow probe-urls to only URLs that previously FAILED.
          // Use the most recent smoke attempt as the source of truth for failures.
          const lastAttempt = smokeAttempts[smokeAttempts.length - 1];
          if (lastAttempt?.failures?.length) {
            try {
              const probe = JSON.parse(probeUrlsJson);
              const failedUrls = lastAttempt.failures.map(f => f.url).filter(Boolean);
              if (failedUrls.length) {
                probeUrlsJson = JSON.stringify({ ...probe, urls: failedUrls });
                logger.info(chalk.dim(`[SMOKE-RETRY] Narrowed to ${failedUrls.length} previously-failed URL(s): ${failedUrls.join(", ")}`));
              }
            } catch { /* malformed probeUrlsJson — run full list */ }
          }
        }
      }

      const result = await runSmokeOrchestration(cycle, probeUrlsJson, devServerUrl, priorSmokeContext);
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

      if (result.signal === CYCLE_SIGNAL.COMPLETE) {
        let testReport = null;

        if (cycle.outputFile) {
          const rawJson = readCycleState(cycle.outputFile);
          const isCritical = CRITICAL_OUTPUT_FILES.has(cycle.outputFile) || cycle.type === "test" || cycle.type === "smoke";

          if (!rawJson) {
            if (isCritical) {
              logger.info(
                `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} reported complete but ${cycle.outputFile} not written — treating as partial`,
              );
              result.signal = CYCLE_SIGNAL.PARTIAL;
              result.finalMessage = `CYCLE_PARTIAL:output file ${cycle.outputFile} not written`;
            }
          } else {
            let parsed;
            try {
              parsed = JSON.parse(rawJson);
            } catch {
              if (isCritical) {
                logger.info(
                  `  ${chalk.red("[ERROR]")} ${chalk.cyan(cycle.id)} wrote unparseable JSON to ${cycle.outputFile} — treating as failed`,
                );
                appendLog({ type: "validation-error", cycleId: cycle.id, file: cycle.outputFile, error: "invalid-json" });
                result.signal = CYCLE_SIGNAL.FAILED;
              } else {
                logger.info(
                  `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} wrote invalid JSON to ${cycle.outputFile} — continuing with no context`,
                );
              }
              parsed = null;
            }

            if (parsed !== null) {
              const validation = validateCycleOutput(cycle.outputFile, parsed);
              if (!validation.valid && !validation.skipped) {
                logger.info(
                  `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} schema mismatch (${validation.schemaName}):`,
                );
                validation.errors.forEach((e) => logger.info(`    ${chalk.dim("-")} ${e}`));
                appendLog({ type: "validation-warning", cycleId: cycle.id, errors: validation.errors });
                if (isCritical) {
                  const defaults =
                    CONSERVATIVE_DEFAULTS[cycle.outputFile] ??
                    (cycle.type === "test" ? CONSERVATIVE_DEFAULTS["test.json"] : {});
                  testReport = { ...defaults, ...parsed };
                  logger.info(
                    `  ${chalk.dim("[INFO]")} Using conservative defaults for missing critical fields in ${cycle.outputFile}`,
                  );
                }
              } else if (parsed !== null) {
                testReport = parsed;
              }
            }
          }
        }

        if (result.signal === CYCLE_SIGNAL.COMPLETE) {
          cycle.status = "done";
          cycle.completedAt = new Date().toISOString();
          cycle.turns = result.turnCount;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "done");

          const turnLabel = cycle.type === "smoke"
            ? `${result.turnCount ?? 0} URL${(result.turnCount ?? 0) !== 1 ? "s" : ""} checked`
            : `${result.turnCount ?? 0} turns`;
          if (batch.length === 1)
            logger.info(`  ${chalk.green("[OK]")} ${chalk.dim(turnLabel)}`);
          else
            logger.info(`  ${chalk.green("[OK]")} ${chalk.cyan(cycle.id)} ${chalk.dim(`— ${turnLabel}`)}`);

          notify("Claude — Cycle Complete", `${cycle.id} | ${turnLabel}`, {
            event: "cycle-complete", cycleId: cycle.id, cycleType: cycle.type, attempt, turnCount: result.turnCount,
          });

          autoUpdateScope(cycle);
          refreshSnapshot(cycle);

          const unrevertable = checkAndRevertScopeViolations(cycle);
          if (unrevertable && unrevertable.length > 0) {
            appendLog({ type: "harness", event: "scope-revert-unrecoverable", cycleId: cycle.id, files: unrevertable });
            logger.info(
              `\n  ${chalk.red("[SCOPE CLEANUP]")} ${unrevertable.length} file(s) could not be auto-reverted — injecting cleanup cycle for ${chalk.cyan(cycle.agent)}:`,
            );
            unrevertable.forEach((f) => logger.info(`    ${chalk.dim("-")} ${chalk.red(f)}`));

            const cleanupCycle = buildScopeCleanupCycle(cycle, unrevertable);
            const insertIdx = queue.cycles.findIndex(
              (c) => c.status === "pending" && (c.type.startsWith("implement-") || c.type === "reconcile"),
            );
            queue.cycles.splice(insertIdx !== -1 ? insertIdx : queue.cycles.length, 0, cleanupCycle);
            writeQueue(queue);
            logger.info(
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
                logger.info(
                  `  ${chalk.green("[DELIVER]")} Summary written to ${chalk.dim(`output/delivery-${runTimestamp}.md`)}`,
                );
              } catch (err) {
                logger.info(`  ${chalk.yellow("[WARN]")} Could not write delivery markdown: ${err.message}`);
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
              // Prefer the smoke-check agent's own classification (it has full context —
              // status codes, console text, CORS detection — that a post-hoc shape match
              // over apiFailures/pageError does not). Fall back to the old heuristic only
              // if the agent didn't report failedSurfaces (e.g. stale report format).
              const reported = testReport.failedSurfaces?.length
                ? testReport.failedSurfaces
                : failures.flatMap((f) => f.failedSurfaces ?? []);
              const surfaces = reported.length
                ? [...new Set(reported.map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"))]
                : (() => {
                    const hasFrontendFailure = failures.some((f) => f.pageError != null || (f.issues?.length && !f.apiFailures?.length));
                    const hasApiFailure = failures.some((f) => Array.isArray(f.apiFailures) && f.apiFailures.length > 0);
                    const fallback = [];
                    if (hasFrontendFailure) fallback.push("frontend");
                    if (hasApiFailure) fallback.push("backend");
                    if (!fallback.length) fallback.push("frontend");
                    return fallback;
                  })();

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
              logger.info(
                `  ${chalk.yellow("[SMOKE FIX]")} Smoke failed (attempt ${totalSmokeAttempts}/${MAX_RETRIES}) — injecting fix cycles for: ${chalk.cyan(surfaces.join(", "))}`,
              );
              printPendingQueue(queue);
            } else if (!testReport.passed && !testReport.skipped && !testReport.partial) {
              logger.info(
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
              logger.info(
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
              logger.info(
                `  ${chalk.red("[RECOVERY]")} Tests failed after ${attempt} attempts — injecting recovery cycle`,
              );
              printPendingQueue(queue);
              notify("Claude — Recovery Cycle", `${attempt} test attempts exhausted`);
            }
          }
        }
      }

      // ── Needs human ───────────────────────────────────────────────────────────

      if (result.signal === CYCLE_SIGNAL.NEEDS_HUMAN) {
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

        let isAuthIssue = false;
        if (cycle.outputFile) {
          try {
            isAuthIssue = !!JSON.parse(readCycleState(cycle.outputFile)).authIssue;
          } catch { /* output file missing or unreadable */ }
        }
        // Matches the provider-outage message smoke-orchestrator.mjs produces —
        // same rationale as auth: there's no text answer that fixes a CLI
        // provider outage, so don't imply one is expected.
        const isProviderOutage = /^Smoke check got no output from the CLI provider on/.test(questionText);

        logger.info(`\n${chalk.red.bold("[BLOCKED]")} ${chalk.cyan(cycle.id)} needs human input.`);
        logger.info(chalk.dim("  ─────────────────────────────────────────────"));
        for (const line of questionText.split("\n")) logger.info(`  ${line}`);
        logger.info(chalk.dim("  ─────────────────────────────────────────────"));
        logger.info(
          isAuthIssue
            ? chalk.yellow("  Then run: cortex-harness resume  (no answer needed — it re-checks auth live)")
            : isProviderOutage
            ? chalk.yellow("  Then run: cortex-harness resume  (no answer needed — it re-runs the smoke check live)")
            : chalk.yellow('  Answer: cortex-harness resume "your answer"'),
        );

        notify("Claude — Needs Input", questionText.slice(0, 100), {
          event: "needs-human-input", cycleId: cycle.id,
        });
        shouldBreak = true;

      } else if (result.signal === CYCLE_SIGNAL.SESSION_LIMIT) {
        const resetsAt = result.resetsAt ?? null;
        const resetStr = resetsAt
          ? new Date(resetsAt * 1000).toLocaleString()
          : "unknown — check your Claude plan";
        cycle.status = "blocked";
        cycle.blockedType = "session-limit";
        cycle.blockedReason = `session/weekly limit hit — resets ${resetStr}`;
        writeQueue(queue);
        appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
        logger.info(`\n${chalk.red("[SESSION LIMIT]")} ${chalk.cyan(cycle.id)} — usage limit reached.`);
        logger.info(`  Resets: ${chalk.yellow(resetStr)}`);
        logger.info(`  ${chalk.dim("All pending cycles are preserved. Run `cortex-harness resume` after the limit resets.")}`);
        notify("Claude — Session Limit Hit", `${cycle.id} blocked | resets ${resetStr}`, {
          event: "session-limit", cycleId: cycle.id, resetsAt,
        });
        shouldBreak = true;

      } else if (result.signal === CYCLE_SIGNAL.BILLING_ERROR) {
        const billingUrl = result.finalMessage.match(/https:\/\/\S+/)?.[0] ?? null;
        cycle.status = "blocked";
        cycle.blockedType = "billing-error";
        cycle.blockedReason = billingUrl
          ? `payment method required — ${billingUrl}`
          : "payment method required — see provider billing settings";
        writeQueue(queue);
        appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
        logger.info(`\n${chalk.red.bold("[BILLING]")} ${chalk.cyan(cycle.id)} — provider rejected the call for lack of a payment method.`);
        if (billingUrl) logger.info(`  Add one here: ${chalk.yellow(billingUrl)}`);
        logger.info(`  ${chalk.dim("Retrying would fail identically — all pending cycles are preserved. Run `cortex-harness resume` once billing is fixed.")}`);
        notify("Claude — Billing Error", `${cycle.id} blocked | payment method required`, {
          event: "billing-error", cycleId: cycle.id, billingUrl,
        });
        shouldBreak = true;

      } else if (result.signal === CYCLE_SIGNAL.PARTIAL) {
        const reasonMatch = result.finalMessage.match(/CYCLE_PARTIAL:(.+)/);
        const reason = reasonMatch?.[1]?.trim() ?? "incomplete";
        const nextAttempt = attempt + 1;
        const effectiveMaxRetries = getEffectiveMaxRetries(cycle, reason, result.signal, result.finalMessage);

        if (attempt < effectiveMaxRetries) {
          logger.info(
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
          logger.info(
            `  ${chalk.yellow("[PARTIAL]")} ${chalk.cyan(cycle.id)} incomplete after ${attempt} attempts: ${reason}`,
          );
          const remainingAfter = queue.cycles.filter((c) => c.status === "pending");
          if (remainingAfter.length) {
            logger.info(
              `  ${chalk.yellow("[WARN]")} ${chalk.cyan(cycle.id)} is partial — run continues but downstream cycles may be affected. ${chalk.dim("Run: cortex-harness resume to retry.")}`,
            );
          }
          notify("Claude — Cycle Partial", `${cycle.id} | ${reason.slice(0, 80)}`);
        }

      } else if (result.signal !== CYCLE_SIGNAL.COMPLETE) {
        const isHardError = result.signal === CYCLE_SIGNAL.ERROR;
        const effectiveMaxRetriesErr = getEffectiveMaxRetries(cycle, result.finalMessage, result.signal);
        if (isRetryable(result.signal) && attempt < effectiveMaxRetriesErr) {
          logger.info(
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
          logger.info(
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

  logger.info("");
  logger.info(chalk.bold.blue("━━━ Run Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  logger.info(`${chalk.dim("Done     :")} ${done > 0 ? chalk.green(done) : done}`);
  logger.info(`${chalk.dim("Partial  :")} ${partial > 0 ? chalk.yellow(partial) : partial}`);
  logger.info(`${chalk.dim("Blocked  :")} ${blocked > 0 ? chalk.red(blocked) : blocked}`);
  logger.info(`${chalk.dim("Pending  :")} ${pending > 0 ? chalk.yellow(pending) : pending}`);
  logger.info(`${chalk.dim("Duration :")} ${duration}`);
  logger.info(`${chalk.dim("Spent    :")} $${spendRef.value.toFixed(2)} / $${MAX_BUDGET_USD}`);
  logger.info(`${chalk.dim("Log      :")} ${runLogFile}`);
  logger.info(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));

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
  logger.error("[FATAL]", err);
  const appendLogFallback = (obj) => {
    try { appendFileSync(runLogFile, JSON.stringify(obj) + "\n", "utf8"); } catch { /* best-effort */ }
  };
  appendLogFallback({ type: "harness", event: "fatal", error: err.message });
  dispatchNotification({ title: "Claude — Fatal Error", message: err.message.slice(0, 100), meta: {}, onWarning: () => {} });
  process.exit(1);
});

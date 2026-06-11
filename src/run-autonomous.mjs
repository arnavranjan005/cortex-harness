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

  const retryCount = {};

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

    const batchResults = await runCycleBatch(batch, remaining);
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
          const isCritical = CRITICAL_OUTPUT_FILES.has(cycle.outputFile) || cycle.type === "test";

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

          if (batch.length === 1)
            console.log(`  ${chalk.green("[OK]")} ${chalk.dim(`${result.turnCount} turns`)}`);
          else
            console.log(`  ${chalk.green("[OK]")} ${chalk.cyan(cycle.id)} ${chalk.dim(`— ${result.turnCount} turns`)}`);

          notify("Claude — Cycle Complete", `${cycle.id} | ${result.turnCount} turns`, {
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

          // Inject fix cycles or recovery cycle on test failure
          if (cycle.type === "test" && testReport !== null) {
            const fg = cycle.taskGroup;
            const fgSuffix = fg ? `-${fg}` : "";
            if (!testReport.passed && attempt <= MAX_RETRIES) {
              const surfaces = testReport.failedSurfaces?.length ? testReport.failedSurfaces : ["unknown"];
              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const fixCycles = surfaces.map((surface) => ({
                id: `fix-${surface}-attempt-${attempt}${fgSuffix}`,
                type: "fix",
                target: surface,
                ...(fg ? { taskGroup: fg } : {}),
                ...(cycle.subTask ? { subTask: cycle.subTask } : {}),
                status: "pending",
                outputFile: `fix-${surface}-attempt-${attempt}${fgSuffix}.json`,
              }));
              const retryTest = {
                id: `test-retry-${attempt}${fgSuffix}`,
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
                `  ${chalk.yellow("[FIX]")} Tests failed — injecting fix cycles for: ${chalk.cyan(surfaces.join(", "))}`,
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

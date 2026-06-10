import chalk from "chalk";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { SEQUENTIAL_TYPES } from "./constants.mjs";

/**
 * Returns queue read/write/batch helpers bound to the given runtime context.
 *
 * @param {object} ctx
 * @param {string} ctx.QUEUE_FILE         - absolute path to task-queue.json
 * @param {object} ctx.CONFIGURED_AGENTS  - agent map from harness.config.json
 * @param {Function} ctx.appendLog        - (obj) => void
 */
export function createQueueManager({ QUEUE_FILE, CONFIGURED_AGENTS, appendLog }) {
  function readQueue() {
    if (!existsSync(QUEUE_FILE)) return null;
    try {
      return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    } catch {
      return null;
    }
  }

  function writeQueue(queue) {
    writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  }

  function printPendingQueue(queue) {
    const pending = queue.cycles.filter((c) => c.status === "pending");
    if (!pending.length) return;
    console.log(`  ${chalk.dim(`Queue updated — ${pending.length} pending:`)}`);
    pending.forEach((c) =>
      console.log(
        `    ${chalk.dim("·")} ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`,
      ),
    );
  }

  function nextPendingCycle(queue) {
    if (!queue || !Array.isArray(queue.cycles)) return null;
    return queue.cycles.find((c) => c.status === "pending") ?? null;
  }

  function safeToParallelize(batch) {
    for (const c of batch) {
      if (SEQUENTIAL_TYPES.has(c.type)) return false;
    }

    const claimed = new Map();

    for (const c of batch) {
      const agentName = c.agent ?? "";
      const agentConfig = CONFIGURED_AGENTS[agentName];
      const scope = agentConfig?.scope;

      if (scope === null) {
        appendLog({
          type: "parallel-demote",
          reason: `${agentName} must be sequential`,
          cycleId: c.id,
        });
        return false;
      }

      if (scope === undefined) {
        appendLog({
          type: "parallel-warn",
          reason: `unknown agent ${agentName}, assuming no write scope`,
          cycleId: c.id,
        });
        continue;
      }

      for (const p of scope) {
        if (claimed.has(p)) {
          appendLog({
            type: "parallel-demote",
            reason: `path overlap on "${p}"`,
            cycleIds: [claimed.get(p), c.id],
          });
          return false;
        }
        claimed.set(p, c.id);
      }
    }

    return true;
  }

  function nextCycleBatch(queue) {
    if (!queue || !Array.isArray(queue.cycles)) return null;
    const pending = queue.cycles.filter((c) => c.status === "pending");
    if (!pending.length) return null;

    const first = pending[0];
    if (!first.parallel) return [first];

    const batch = [];
    for (const c of pending) {
      if (c.parallel) batch.push(c);
      else break;
    }

    if (batch.length === 1) return batch;

    if (!safeToParallelize(batch)) {
      console.log(
        `  [SERIALIZE] Write-scope overlap detected — running ${batch[0].id} alone`,
      );
      return [batch[0]];
    }

    return batch;
  }

  // Build the full cycle sequence for one additional group (explore → implement* → reconcile → test).
  function buildAdditionalGroupCycles(group, subTask, promptType, agents) {
    const cycles = [];

    if (promptType === "fix-bug") {
      cycles.push({
        id: `reproduce-${group}`,
        type: "reproduce",
        taskGroup: group,
        subTask,
        status: "pending",
        outputFile: `reproduce-${group}.json`,
        parallel: false,
        notes: `Reproduce step for additional group: ${subTask}`,
      });
    }

    cycles.push({
      id: `explore-${group}`,
      type: "explore",
      taskGroup: group,
      subTask,
      status: "pending",
      outputFile: `explore-${group}.json`,
      parallel: false,
      notes: `Explore for additional group: ${subTask}`,
    });

    const canParallel = agents.length > 1;
    for (const agent of agents) {
      const surface = agent.replace(/-subagent$/, "");
      cycles.push({
        id: `implement-${surface}-${group}`,
        type: `implement-${surface}`,
        agent,
        taskGroup: group,
        subTask,
        status: "pending",
        outputFile: `implement-${surface}-${group}.json`,
        parallel: canParallel,
        notes: `Implementation for additional group: ${subTask}`,
      });
    }

    cycles.push({
      id: `reconcile-${group}`,
      type: "reconcile",
      taskGroup: group,
      subTask,
      status: "pending",
      outputFile: `reconcile-${group}.json`,
      parallel: false,
      notes: `Reconcile for additional group: ${subTask}`,
    });

    cycles.push({
      id: `test-${group}`,
      type: "test",
      taskGroup: group,
      subTask,
      status: "pending",
      outputFile: `test-${group}.json`,
      parallel: false,
      notes: `Test for additional group: ${subTask}`,
    });

    return cycles;
  }

  // When reconcile-cross-group detects that a group used the wrong workflow type,
  // it emits requiresAdditionalGroups[]. This builds and inserts the full cycle
  // sequences before deliver so the correct workflow runs before the final summary.
  function injectAdditionalGroups(report, queue) {
    const additional = report?.requiresAdditionalGroups;
    if (!Array.isArray(additional) || additional.length === 0) return false;

    const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
    const insertAt = deliverIdx !== -1 ? deliverIdx : queue.cycles.length;

    let offset = 0;
    for (const entry of additional) {
      const { reason, subTask, suggestedPromptType, suggestedAgents = [], group } =
        entry;
      if (!group || !subTask) {
        console.log(
          `  ${chalk.yellow("[RE-PLAN]")} Skipping malformed requiresAdditionalGroups entry (missing group or subTask)`,
        );
        continue;
      }

      const newCycles = buildAdditionalGroupCycles(
        group,
        subTask,
        suggestedPromptType ?? "implement-feature",
        suggestedAgents,
      );
      queue.cycles.splice(insertAt + offset, 0, ...newCycles);
      offset += newCycles.length;
      console.log(
        `\n  ${chalk.magenta("[RE-PLAN]")} Injecting ${chalk.bold(newCycles.length)} cycles for additional group ${chalk.cyan(`"${group}"`)}: ${subTask}`,
      );
      if (reason) console.log(`    ${chalk.dim("Reason:")} ${reason}`);
    }

    if (offset > 0) {
      writeQueue(queue);
      printPendingQueue(queue);
      return true;
    }
    return false;
  }

  return {
    readQueue,
    writeQueue,
    printPendingQueue,
    nextPendingCycle,
    nextCycleBatch,
    injectAdditionalGroups,
  };
}

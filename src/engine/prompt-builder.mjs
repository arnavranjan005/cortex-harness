import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { MAX_RETRIES } from "./constants.mjs";

/**
 * Returns a buildCyclePrompt function bound to the given runtime context.
 *
 * @param {object} ctx
 * @param {string} ctx.PROMPTS_DIR         - absolute path to prompts/
 * @param {string} ctx.AGENTS_DIR          - absolute path to agents/
 * @param {string} ctx.CYCLE_DIR           - absolute path to cycle-state/
 * @param {string} ctx.CYCLE_STATE_RELDIR  - cycle-state/ relative to ROOT (for prompts)
 * @param {object} ctx.CONFIGURED_AGENTS   - agent map from harness.config.json
 * @param {string} ctx.userTask            - the task description
 * @param {Function} ctx.readCycleState    - (filename) => string | null
 * @param {Function} ctx.readQueue         - () => queue | null
 */
export function createPromptBuilder({
  PROMPTS_DIR,
  AGENTS_DIR,
  CYCLE_DIR,
  CYCLE_STATE_RELDIR,
  SNAPSHOT_RELDIR,
  CONFIGURED_AGENTS,
  userTask,
  readCycleState,
  readQueue,
}) {
  function readAgentMd(agentName) {
    const p = join(AGENTS_DIR, `${agentName}.agent.md`);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return `[Role block not found at ${p} — proceed as ${agentName} with standard scope guards]`;
    }
  }

  function buildConstraints(cycle) {
    const base = `CYCLE CONSTRAINTS — hard rules, no exceptions:
- Do NOT run git commit, git push, git pull, git stash, or gh pr create
- Do NOT create or delete branches
- ALL tool calls (Edit, Write, Bash, Read, etc.) are pre-approved — do NOT ask for permission before editing files. Just use the tool.
- File edits, builds, tests, and nx commands are all permitted
- NEEDS_HUMAN_INPUT is only for hard blocks: schema migration, auth/JWT/CORS/CSRF change, or a decision only a human can make. Never use it for file edits.
- End your final message with exactly one of:
    CYCLE_COMPLETE          — finished successfully
    NEEDS_HUMAN_INPUT       — blocked, human decision required (explain what)
    CYCLE_PARTIAL:<reason>  — could not finish (explain what remains)
Current cycle: ${cycle.id}`;

    let scopeGuard = "";
    if (cycle.type.startsWith("implement-") && cycle.agent) {
      const agentConfig = CONFIGURED_AGENTS[cycle.agent];
      const allowedPaths = agentConfig?.scope;
      if (allowedPaths && allowedPaths.length) {
        scopeGuard =
          `\n- FILE SCOPE — you may ONLY edit or create files under these paths:\n` +
          allowedPaths.map((p) => `    ${p}`).join("\n") +
          `\n  Any edit outside these paths is a scope violation. If the work requires touching another path, record it in outOfScopeGaps — do NOT write the file.`;
      }
    }

    return base + scopeGuard;
  }

  function buildTaskFocus(cycle) {
    if (!cycle.subTask) return userTask;

    const queue = readQueue();
    const intents = queue?.intents ?? [];
    const decomposition = (
      intents.length
        ? intents
        : [{ subTask: cycle.subTask, group: cycle.taskGroup }]
    )
      .map(
        (i) =>
          `  - [${i.group}] ${i.subTask}` +
          (i.group === cycle.taskGroup ? "   ← YOUR CYCLE'S SCOPE" : ""),
      )
      .join("\n");

    return (
      `${userTask}\n\n` +
      `--- This is a multi-intent task, split into ${intents.length || 1} independently-owned sub-tasks ---\n` +
      decomposition +
      `\n\nYour cycle owns ONLY the sub-task marked "← YOUR CYCLE'S SCOPE" (group "${cycle.taskGroup}"). ` +
      `Every other sub-task above has its own dedicated cycle elsewhere in the queue — do not implement ` +
      `them here, even if you notice related issues in the same files while working. If something relevant ` +
      `to another group needs fixing, record it in outOfScopeGaps with that group's slug as owningAgent.`
    );
  }

  function assemblePriorContext(cycle) {
    const parts = [];
    const g = cycle.taskGroup;
    const suffix = g ? `-${g}` : "";

    const skills = readCycleState("skills.json");
    const answers = readCycleState("human-answers.json");
    const scopeViol = readCycleState("scope-violations.json");
    const explore =
      (suffix ? readCycleState(`explore${suffix}.json`) : null) ??
      readCycleState("explore.json");
    const plan =
      (suffix ? readCycleState(`plan${suffix}.json`) : null) ??
      readCycleState("plan.json");

    if (skills) parts.push(`## Skill guidance\n\`\`\`json\n${skills}\n\`\`\``);
    if (answers)
      parts.push(`## Human approvals and answers\n\`\`\`json\n${answers}\n\`\`\``);
    if (scopeViol)
      parts.push(
        `## Scope violations from prior cycles\n` +
          `Files marked "reverted" are clean. Files in "couldNotRevert" are still present in a modified state — do NOT re-implement them; flag as a gap instead.\n` +
          `\`\`\`json\n${scopeViol}\n\`\`\``,
      );
    if (explore) parts.push(`## Explorer report\n\`\`\`json\n${explore}\n\`\`\``);
    if (plan) parts.push(`## Planner report\n\`\`\`json\n${plan}\n\`\`\``);

    const queue = readQueue();
    if (queue) {
      for (const c of queue.cycles) {
        if (c.type.startsWith("implement-") && c.status === "done" && c.outputFile) {
          const impl = readCycleState(c.outputFile);
          if (impl)
            parts.push(`## Implementation report (${c.id})\n\`\`\`json\n${impl}\n\`\`\``);
        }
      }
      for (const c of queue.cycles) {
        if (c.type === "reconcile" && c.status === "done" && c.outputFile) {
          const rec = readCycleState(c.outputFile);
          if (rec)
            parts.push(`## Reconcile report (${c.id})\n\`\`\`json\n${rec}\n\`\`\``);
        }
      }
    }

    return parts.length ? "\n\n" + parts.join("\n\n") : "";
  }

  function assembleImplReports(cycle) {
    const queue = readQueue();
    if (!queue) return "";
    const g = cycle.taskGroup;
    const parts = [];
    for (const c of queue.cycles) {
      if (!c.type.startsWith("implement-") || !c.outputFile) continue;
      if (g && c.taskGroup !== g) continue;
      const report = readCycleState(c.outputFile);
      if (report) parts.push(`### ${c.id}\n\`\`\`json\n${report}\n\`\`\``);
    }
    return parts.length ? "\n\n## Agent reports\n\n" + parts.join("\n\n") : "";
  }

  function assembleCycleOutputs() {
    let files;
    try {
      files = readdirSync(CYCLE_DIR)
        .filter(
          (f) =>
            f.endsWith(".json") &&
            f !== "skills.json" &&
            f !== "human-answers.json" &&
            f !== "scope-violations.json",
        )
        .sort();
    } catch {
      files = [];
    }
    const parts = [];
    for (const f of files) {
      const content = readCycleState(f);
      if (content) parts.push(`### ${f}\n\`\`\`json\n${content}\n\`\`\``);
    }
    return parts.length ? "\n\n## Cycle outputs\n\n" + parts.join("\n\n") : "";
  }

  function buildCyclePrompt(cycle) {
    const CONSTRAINTS = buildConstraints(cycle);
    const taskFocus = buildTaskFocus(cycle);
    const priorContext = assemblePriorContext(cycle);

    const agentName =
      cycle.agent ??
      (cycle.type.startsWith("implement-")
        ? cycle.type.replace("implement-", "") + "-subagent"
        : null);
    const agentRole = agentName ? readAgentMd(agentName) : "";

    const testReportRaw = readCycleState("test.json");
    const testFailureDetails = testReportRaw
      ? `\n## Test failure details\n\`\`\`json\n${testReportRaw}\n\`\`\``
      : "";
    const priorTestAttempt = testReportRaw
      ? `\n## Prior test attempt\n\`\`\`json\n${testReportRaw}\n\`\`\``
      : "";

    const smokeSuffix = cycle.taskGroup ? `-${cycle.taskGroup}` : "";
    const smokeReportRaw = readCycleState(`smoke${smokeSuffix}.json`);
    const smokeFailureDetails = smokeReportRaw
      ? `\n## Smoke failure details\n\`\`\`json\n${smokeReportRaw}\n\`\`\``
      : "";

    let templateContent;

    if (cycle.id.startsWith("scope-cleanup-")) {
      const failedFiles =
        (cycle.notes ?? "")
          .match(
            /must undo those changes — restore each file to its pre-cycle state\.(.*)$/,
          )?.[1]
          ?.trim()
          .split(", ") ??
        (cycle.notes ?? "").match(/files: (.+)$/)?.[1]?.split(", ") ??
        [];
      templateContent =
        `${CONSTRAINTS}\n\n${agentRole}\n\n` +
        `SCOPE CLEANUP — you are the agent that wrote files outside your declared scope in a prior cycle.\n` +
        `The harness tried to auto-revert these files but could not:\n` +
        (failedFiles.length
          ? failedFiles.map((f) => `  - ${f}`).join("\n")
          : `  (see cycle notes: ${cycle.notes ?? "none"})`) +
        `\n\n` +
        `Your task:\n` +
        `1. For each file listed above, restore it to the state it was in before your cycle ran.\n` +
        `   - If you added the file: delete it entirely.\n` +
        `   - If you modified the file: restore it to its git HEAD version (\`git restore <path>\`).\n` +
        `2. Do NOT re-implement any feature logic in these files — that belongs to the owning agent.\n` +
        `3. Confirm each file is reverted by reading it after the restore.\n\n` +
        `Write your output to: ${CYCLE_STATE_RELDIR}/${cycle.outputFile}\n` +
        `{ "fixed": ["<file restored>", ...], "notes": "" }\n\n` +
        `Task context: ${userTask}`;
    } else {
      const templateKey = cycle.type.startsWith("implement-")
        ? "implement"
        : cycle.type;
      const templatePath = join(PROMPTS_DIR, `${templateKey}.md`);
      templateContent = existsSync(templatePath)
        ? readFileSync(templatePath, "utf8")
        : `${CONSTRAINTS}\n\nPerform cycle: ${cycle.id} (type: ${cycle.type})\n\nTask: ${taskFocus}\n${priorContext}\n\nWrite your output to: ${CYCLE_STATE_RELDIR}/${cycle.outputFile ?? cycle.id + ".json"}\n\nCYCLE_COMPLETE`;
    }

    templateContent = templateContent
      .replace(/\{\{CONSTRAINTS\}\}/g, CONSTRAINTS)
      .replace(/\{\{PRIOR_CONTEXT\}\}/g, priorContext)
      .replace(/\{\{AGENT_ROLE\}\}/g, agentRole)
      .replace(/\{\{USER_TASK\}\}/g, taskFocus)
      .replace(/\{\{CYCLE_ID\}\}/g, cycle.id)
      .replace(/\{\{OUTPUT_FILE\}\}/g, cycle.outputFile ?? `${cycle.id}.json`)
      .replace(/\{\{CYCLE_STATE_DIR\}\}/g, CYCLE_STATE_RELDIR)
      .replace(/\{\{SURFACE\}\}/g, cycle.target ?? "unknown")
      .replace(/\{\{IMPL_REPORTS\}\}/g, assembleImplReports(cycle))
      .replace(/\{\{CYCLE_OUTPUTS\}\}/g, assembleCycleOutputs())
      .replace(/\{\{TEST_FAILURE_DETAILS\}\}/g, testFailureDetails)
      .replace(/\{\{PRIOR_TEST_ATTEMPT\}\}/g, priorTestAttempt)
      .replace(/\{\{SMOKE_FAILURE_DETAILS\}\}/g, smokeFailureDetails)
      .replace(/\{\{MAX_RETRIES\}\}/g, String(MAX_RETRIES))
      .replace(/\{\{DEV_SERVER_URL\}\}/g, cycle.devServerUrl ?? "")
      .replace(/\{\{SNAPSHOT_DIR\}\}/g, SNAPSHOT_RELDIR ?? "");

    return templateContent;
  }

  return { buildCyclePrompt };
}

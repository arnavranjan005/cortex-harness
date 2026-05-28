/**
 * Autonomous multi-cycle runner for Open Agent Harness.
 * Configuration-driven: reads harness.config.json for paths, agent scopes, and commands.
 */

import { spawn, execSync } from "child_process";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, relative } from "path";
import {
  validateCycleOutput,
  validateTaskQueue,
  CRITICAL_OUTPUT_FILES,
  CONSERVATIVE_DEFAULTS,
} from "./cycle-schemas.mjs";
import { dispatchNotification } from "./notification-dispatcher.mjs";
import { loadConfig } from "./config-loader.mjs";

// ── Load Config ──────────────────────────────────────────────────────────────
const config = await loadConfig();

const {
  harnessDir: HARNESS_DIR,
  promptsDir: PROMPTS_DIR,
  agentsDir: AGENTS_DIR,
  cwd: ROOT,
  agents: CONFIGURED_AGENTS,
} = config;

// ── Config ────────────────────────────────────────────────────────────────────

// No hard turn cap per cycle — 500 is a safety net only.
const SAFETY_TURN_CAP = 500;

const MAX_BUDGET_USD = 20;
const DEAD_MAN_MS = 20 * 60 * 1000; // 20 min silence → cycle is hung
const MAX_RETRIES = 2;

// Per-cycle turn caps. Only test is capped; others run to natural completion.
const TURN_CAP = { test: 25 };

// Test cycles with a clean turn-cap partial get up to 10 retries (progress in 25-turn slices).
// Rate-limit or error partials fall back to MAX_RETRIES.
const TEST_MAX_RETRIES_CLEAN = 10;

function getTurnCap(cycle) {
  return TURN_CAP[cycle.type] ?? Infinity;
}

function getEffectiveMaxRetries(cycle, reason, signal, rawMessage = "") {
  if (cycle.type !== "test") return MAX_RETRIES;
  const textToCheck = (reason ?? "") + " " + rawMessage;
  const isRateLimit =
    textToCheck.includes("rate-limit") ||
    textToCheck.includes("weekly") ||
    textToCheck.includes("session limit") ||
    textToCheck.includes("rate limit") ||
    textToCheck.includes("hit your");
  const isError = signal === "failed" || signal === "hung";
  if (isRateLimit || isError) return MAX_RETRIES;
  return TEST_MAX_RETRIES_CLEAN;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const RUNS_DIR = join(HARNESS_DIR, "runs");
const CYCLE_DIR = join(HARNESS_DIR, "cycle-state");
const OUTPUT_DIR = join(HARNESS_DIR, "output");
const SESSION_FILE = join(HARNESS_DIR, "session.json");
const QUEUE_FILE = join(HARNESS_DIR, "task-queue.json");

// Relative path for use inside cycle prompts (Claude writes files relative to cwd)
const CYCLE_STATE_RELDIR = relative(ROOT, CYCLE_DIR).replace(/\\/g, "/");

// ── Process kill helper ───────────────────────────────────────────────────────
// On Windows, SIGTERM only signals the top-level PowerShell process.
// taskkill /F /T kills the entire process tree including all descendants.

const isWindows = process.platform === "win32";

function killProc(proc) {
  if (!proc || !proc.pid) return;
  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ── Scope violation checker ───────────────────────────────────────────────────
// After each implement cycle completes, compare its filesChanged report against
// CONFIGURED_AGENTS scope. Auto-revert out-of-scope files and write scope-violations.json.

function checkAndRevertScopeViolations(cycle) {
  if (!cycle.agent || !cycle.type.startsWith("implement-")) return;
  const agentConfig = CONFIGURED_AGENTS[cycle.agent];
  const scope = agentConfig?.scope;
  if (!scope || scope.length === 0) return; // read-only or unconstrained

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
    `\n  [SCOPE] ${cycle.id} touched ${violations.length} out-of-scope file(s) — reverting:`,
  );
  const reverted = [];
  const failed = [];

  for (const f of violations) {
    let done = false;

    // 1. git restore — works for tracked files modified in working tree
    if (!done) {
      try {
        execSync(`git restore "${f}"`, { cwd: ROOT, stdio: "pipe" });
        done = true;
      } catch { /* fall through */ }
    }

    // 2. git clean -f — works for new untracked files
    if (!done) {
      try {
        execSync(`git clean -f "${f}"`, { cwd: ROOT, stdio: "pipe" });
        done = true;
      } catch { /* fall through */ }
    }

    // 3. git show HEAD:<path> → write original content back (tracked file, git restore failed)
    if (!done) {
      try {
        const original = execSync(`git show HEAD:"${f}"`, { cwd: ROOT });
        writeFileSync(join(ROOT, f), original);
        done = true;
      } catch { /* fall through — file may not exist in HEAD (new file) */ }
    }

    // 4. fs.unlinkSync — new file that git can't clean (e.g. inside .gitignore scope)
    if (!done) {
      try {
        unlinkSync(join(ROOT, f));
        done = true;
      } catch { /* fall through */ }
    }

    if (done) {
      console.log(`    ✗ reverted: ${f}`);
      reverted.push(f);
    } else {
      console.log(`    ! could not revert: ${f}`);
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

// ── Task input ────────────────────────────────────────────────────────────────

let userTask = process.argv.slice(2).join(" ").trim();
if (!userTask) {
  try {
    const existingQueue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (existingQueue?.task) {
      userTask = existingQueue.task;
      console.log(`[resume] Using task from task-queue.json: ${userTask}`);
    }
  } catch { /* no queue yet */ }
}
if (!userTask) {
  console.error('Usage: open-agent-harness run "your task description"');
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

mkdirSync(RUNS_DIR, { recursive: true });
mkdirSync(CYCLE_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const runTimestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .slice(0, 19);
const runLogFile = join(RUNS_DIR, `${runTimestamp}.jsonl`);

// ── State ─────────────────────────────────────────────────────────────────────

let totalSpentUsd = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLog(obj) {
  try {
    appendFileSync(runLogFile, JSON.stringify(obj) + "\n", "utf8");
  } catch { /* best-effort */ }
}

function buildNotificationMeta(extra = {}) {
  return {
    task: userTask,
    totalSpentUsd: Number(totalSpentUsd.toFixed(2)),
    ...extra,
  };
}

function notify(title, message, meta = {}) {
  dispatchNotification({
    title,
    message,
    meta: buildNotificationMeta(meta),
    onWarning: (warning) => {
      console.warn(warning);
      appendLog({ type: "notification-warning", warning });
    },
  });
}

function cycleOutputWritten(cycle) {
  if (cycle.type === "deliver") {
    try {
      return readdirSync(OUTPUT_DIR).some(
        (f) => f.startsWith("delivery-") && f.endsWith(".md"),
      );
    } catch {
      return false;
    }
  }
  return !!(cycle.outputFile && existsSync(join(CYCLE_DIR, cycle.outputFile)));
}

function deliverOutputFile() {
  try {
    const files = readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("delivery-") && f.endsWith(".md"),
    );
    return files.length ? join("output", files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

function readCycleState(filename) {
  if (!filename) return null;
  const p = join(CYCLE_DIR, filename);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readAgentMd(agentName) {
  const p = join(AGENTS_DIR, `${agentName}.agent.md`);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return `[Role block not found at ${p} — proceed as ${agentName} with standard scope guards]`;
  }
}

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

function nextPendingCycle(queue) {
  if (!queue || !Array.isArray(queue.cycles)) return null;
  return queue.cycles.find((c) => c.status === "pending") ?? null;
}

function safeToParallelize(batch) {
  const SEQUENTIAL_TYPES = new Set([
    "test",
    "reconcile",
    "deliver",
    "recover",
    "recovery",
    "orchestrate",
  ]);
  for (const c of batch) {
    if (SEQUENTIAL_TYPES.has(c.type)) return false;
  }

  const claimed = new Map();

  for (const c of batch) {
    const agentName = c.agent ?? "";
    const agentConfig = CONFIGURED_AGENTS[agentName];
    const scope = agentConfig?.scope;

    if (scope === null) {
      appendLog({ type: "parallel-demote", reason: `${agentName} must be sequential`, cycleId: c.id });
      return false;
    }

    if (scope === undefined) {
      appendLog({ type: "parallel-warn", reason: `unknown agent ${agentName}, assuming no write scope`, cycleId: c.id });
      continue;
    }

    for (const p of scope) {
      if (claimed.has(p)) {
        appendLog({ type: "parallel-demote", reason: `path overlap on "${p}"`, cycleIds: [claimed.get(p), c.id] });
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
    console.log(`  [SERIALIZE] Write-scope overlap detected — running ${batch[0].id} alone`);
    return [batch[0]];
  }

  return batch;
}

function readSession() {
  if (!existsSync(SESSION_FILE)) return { sessionId: null, startTime: null, cycles: [], risks: [] };
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
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

// ── Turn-cap summary helper ───────────────────────────────────────────────────

async function requestTurnCapSummary(cycleId, assistantLog) {
  const messages = Array.isArray(assistantLog) && assistantLog.length
    ? assistantLog.map((text, i) => `[Turn ${i + 1}]:\n${text}`).join("\n\n")
    : "(none captured)";

  const prompt = `You are summarizing progress from a test cycle that was cut off by a turn limit.

Cycle: ${cycleId}
Last ${Array.isArray(assistantLog) ? assistantLog.length : 0} assistant messages before cut-off:

${messages}

In 2-3 sentences, summarize:
1. What was completed (spec files written, tests passing)
2. What still remains (specs not yet written, test failures not fixed)

Be specific — list file names if mentioned. Do not guess. Only use what is in the messages above.
Reply with only the summary, no preamble.`;

  return new Promise((resolve) => {
    let output = "";
    let proc;
    const timeout = setTimeout(() => {
      try { killProc(proc); } catch { /* already gone */ }
      resolve("(summary timed out)");
    }, 60_000);

    if (isWindows) {
      const summaryPromptFile = join(RUNS_DIR, `summary-${Date.now()}.txt`);
      const summaryPsFile = join(RUNS_DIR, `summary-${Date.now()}.ps1`);
      writeFileSync(summaryPromptFile, prompt, "utf8");
      writeFileSync(
        summaryPsFile,
        `Get-Content -Path "${summaryPromptFile}" -Raw -Encoding UTF8 | & claude --print --output-format text --max-turns 3 --max-budget-usd 0.10 --dangerously-skip-permissions\n`,
        "utf8",
      );
      proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", summaryPsFile],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      proc = spawn(
        "claude",
        ["-p", prompt, "--output-format", "text", "--max-turns", "3", "--max-budget-usd", "0.10", "--dangerously-skip-permissions"],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    proc.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    proc.on("close", () => {
      clearTimeout(timeout);
      resolve(output.trim() || "(no summary returned)");
    });
    proc.on("error", () => {
      clearTimeout(timeout);
      resolve("(summary spawn failed)");
    });
  });
}

// ── Cycle prompt builder ──────────────────────────────────────────────────────
//
// Reads a template file from PROMPTS_DIR and substitutes placeholders.
// All implement-* cycle types share a single implement.md template.
//
// Placeholders:
//   {{CONSTRAINTS}}          — hard rules + optional scope guard
//   {{PRIOR_CONTEXT}}        — assembled cycle-state outputs for this cycle
//   {{AGENT_ROLE}}           — role block from .harness/agents/<name>.agent.md
//   {{USER_TASK}}            — the task description
//   {{CYCLE_ID}}             — the cycle id
//   {{OUTPUT_FILE}}          — the output filename (relative to cycle-state/)
//   {{CYCLE_STATE_DIR}}      — relative path to cycle-state/ dir
//   {{SURFACE}}              — fix cycle surface (backend, frontend, etc.)
//   {{IMPL_REPORTS}}         — assembled implement reports (reconcile cycle)
//   {{CYCLE_OUTPUTS}}        — all cycle-state outputs (deliver cycle)
//   {{TEST_FAILURE_DETAILS}} — test.json content (fix/recovery cycles)
//   {{PRIOR_TEST_ATTEMPT}}   — prior test.json (test retry cycles)
//   {{MAX_RETRIES}}          — MAX_RETRIES constant

function buildCyclePrompt(cycle) {
  // ── CONSTRAINTS ────────────────────────────────────────────────────────────
  const baseConstraints = `CYCLE CONSTRAINTS — hard rules, no exceptions:
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

  // Scope guard for implement cycles
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

  const CONSTRAINTS = baseConstraints + scopeGuard;

  // ── PRIOR CONTEXT ─────────────────────────────────────────────────────────
  const priorContext = () => {
    const parts = [];
    const skills = readCycleState("skills.json");
    const answers = readCycleState("human-answers.json");
    const scopeViol = readCycleState("scope-violations.json");
    const explore = readCycleState("explore.json");
    const plan = readCycleState("plan.json");
    const reconcile = readCycleState("reconcile.json");
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
    }
    if (reconcile) parts.push(`## Reconcile report\n\`\`\`json\n${reconcile}\n\`\`\``);
    return parts.length ? "\n\n" + parts.join("\n\n") : "";
  };

  // ── AGENT ROLE ────────────────────────────────────────────────────────────
  const agentName = cycle.agent
    ?? (cycle.type.startsWith("implement-")
        ? cycle.type.replace("implement-", "") + "-subagent"
        : null);
  const agentRole = agentName ? readAgentMd(agentName) : "";

  // ── CYCLE OUTPUTS (for deliver) ───────────────────────────────────────────
  const assembleCycleOutputs = () => {
    const stateFiles = [
      "explore.json", "plan.json",
      "implement-backend.json", "implement-frontend.json",
      "implement-distributed.json", "implement-infra.json",
      "reconcile.json", "test.json",
    ];
    const parts = [];
    for (const f of stateFiles) {
      const content = readCycleState(f);
      if (content) parts.push(`### ${f}\n\`\`\`json\n${content}\n\`\`\``);
    }
    return parts.length ? "\n\n## Cycle outputs\n\n" + parts.join("\n\n") : "";
  };

  // ── IMPL REPORTS (for reconcile) ──────────────────────────────────────────
  const assembleImplReports = () => {
    const queue = readQueue();
    if (!queue) return "";
    const parts = [];
    for (const c of queue.cycles) {
      if (c.type.startsWith("implement-") && c.outputFile) {
        const report = readCycleState(c.outputFile);
        if (report) parts.push(`### ${c.id}\n\`\`\`json\n${report}\n\`\`\``);
      }
    }
    return parts.length ? "\n\n## Agent reports\n\n" + parts.join("\n\n") : "";
  };

  // ── TEST FAILURE DETAILS (for fix/recovery) ───────────────────────────────
  const testReportRaw = readCycleState("test.json");
  const testFailureDetails = testReportRaw
    ? `\n## Test failure details\n\`\`\`json\n${testReportRaw}\n\`\`\``
    : "";

  // Prior test attempt (for test retry cycles)
  const priorTestAttempt = testReportRaw
    ? `\n## Prior test attempt\n\`\`\`json\n${testReportRaw}\n\`\`\``
    : "";

  // ── TEMPLATE LOOKUP ───────────────────────────────────────────────────────
  // implement-* share implement.md; scope-cleanup-* get an inline prompt; fall back to generic
  let templateContent;

  if (cycle.id.startsWith("scope-cleanup-")) {
    // Injected when auto-revert failed — the owning agent must undo its out-of-scope changes
    const failedFiles =
      (cycle.notes ?? "")
        .match(/must undo those changes — restore each file to its pre-cycle state\.(.*)$/)?.[1]
        ?.trim()
        .split(", ")
        ?? (cycle.notes ?? "").match(/files: (.+)$/)?.[1]?.split(", ")
        ?? [];
    templateContent =
      `${CONSTRAINTS}\n\n${agentRole}\n\n` +
      `SCOPE CLEANUP — you are the agent that wrote files outside your declared scope in a prior cycle.\n` +
      `The harness tried to auto-revert these files but could not:\n` +
      (failedFiles.length ? failedFiles.map((f) => `  - ${f}`).join("\n") : `  (see cycle notes: ${cycle.notes ?? "none"})`) + `\n\n` +
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
    const templateKey = cycle.type.startsWith("implement-") ? "implement" : cycle.type;
    const templatePath = join(PROMPTS_DIR, `${templateKey}.md`);
    templateContent = existsSync(templatePath)
      ? readFileSync(templatePath, "utf8")
      : `${CONSTRAINTS}\n\nPerform cycle: ${cycle.id} (type: ${cycle.type})\n\nTask: ${userTask}\n${priorContext()}\n\nWrite your output to: ${CYCLE_STATE_RELDIR}/${cycle.outputFile ?? cycle.id + ".json"}\n\nCYCLE_COMPLETE`;
  }

  // ── SUBSTITUTION ──────────────────────────────────────────────────────────
  templateContent = templateContent
    .replace(/\{\{CONSTRAINTS\}\}/g, CONSTRAINTS)
    .replace(/\{\{PRIOR_CONTEXT\}\}/g, priorContext())
    .replace(/\{\{AGENT_ROLE\}\}/g, agentRole)
    .replace(/\{\{USER_TASK\}\}/g, userTask)
    .replace(/\{\{CYCLE_ID\}\}/g, cycle.id)
    .replace(/\{\{OUTPUT_FILE\}\}/g, cycle.outputFile ?? `${cycle.id}.json`)
    .replace(/\{\{CYCLE_STATE_DIR\}\}/g, CYCLE_STATE_RELDIR)
    .replace(/\{\{SURFACE\}\}/g, cycle.target ?? "unknown")
    .replace(/\{\{IMPL_REPORTS\}\}/g, assembleImplReports())
    .replace(/\{\{CYCLE_OUTPUTS\}\}/g, assembleCycleOutputs())
    .replace(/\{\{TEST_FAILURE_DETAILS\}\}/g, testFailureDetails)
    .replace(/\{\{PRIOR_TEST_ATTEMPT\}\}/g, priorTestAttempt)
    .replace(/\{\{MAX_RETRIES\}\}/g, String(MAX_RETRIES));

  return templateContent;
}

// ── Spawn one claude -p session ───────────────────────────────────────────────

async function runCycle(cycle, remainingBudgetUsd) {
  const prompt = buildCyclePrompt(cycle);

  return new Promise((resolve) => {
    let turnCount = 0;        // streaming chunk count (activity dots only)
    let liveTurnCount = 0;    // user-event count = turns completed (live, accurate to N-1)
    let realTurnCount = 0;    // num_turns from Claude's result event (authoritative, N)
    let finalMessage = "";
    let rawText = "";          // non-JSON stdout lines — fallback for signal detection
    const assistantLog = [];   // rolling log of assistant text messages for turn-cap summary
    let deadManTimer = null;
    let settled = false;

    // Resolve exactly once — subsequent calls are no-ops (grace kill / close race).
    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadManTimer);
      process.stdout.write("\n");
      resolve(value);
    }

    function detectSignal(message, code) {
      const isRateLimit =
        message.includes("You've hit your") ||
        message.includes("session limit") ||
        message.includes("weekly limit") ||
        message.includes("rate limit");
      if (message.includes("NEEDS_HUMAN_INPUT")) return "needs-human";
      if (message.includes("CYCLE_COMPLETE") && !isRateLimit) return "complete";
      if (message.match(/CYCLE_PARTIAL:/)) return "partial";
      if (isRateLimit) {
        appendLog({
          type: "harness",
          event: "rate-limit-hit",
          cycleId: cycle.id,
          turnCount: realTurnCount || liveTurnCount || turnCount,
        });
        console.log(
          `  [RATE LIMIT] ${cycle.id} hit rate limit after ${realTurnCount || liveTurnCount || turnCount} turns — treating as partial`,
        );
        return "partial";
      }
      if (code === 0) return "complete";
      return "failed";
    }

    function resetDeadMan() {
      if (deadManTimer) clearTimeout(deadManTimer);
      deadManTimer = setTimeout(() => {
        appendLog({
          type: "harness",
          event: "dead-man-triggered",
          cycleId: cycle.id,
          turnCount: realTurnCount || liveTurnCount || turnCount,
        });
        console.log(
          `\n[HUNG] Cycle ${cycle.id} silent for 20 min after ${realTurnCount || liveTurnCount || turnCount} turns`,
        );
        notify("Claude — Cycle Hung", `${cycle.id} | ${realTurnCount || liveTurnCount || turnCount} turns`);
        killProc(proc);
        resolveOnce({
          signal: "hung",
          turnCount: realTurnCount || liveTurnCount || turnCount,
          finalMessage,
        });
      }, DEAD_MAN_MS);
    }

    const budgetArg = String(Math.max(0.5, Number(remainingBudgetUsd.toFixed(2))));

    let proc;
    if (isWindows) {
      // Write prompt to a plain UTF-8 file and pipe via stdin.
      // Passing as a quoted CLI argument breaks when prompt contains double-quotes
      // (embedded JSON from explorer reports causes PowerShell to split the argument).
      const promptFile = join(
        RUNS_DIR,
        `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}-prompt.txt`,
      );
      writeFileSync(promptFile, prompt, "utf8");
      const psFile = join(
        RUNS_DIR,
        `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}.ps1`,
      );
      writeFileSync(
        psFile,
        `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & claude --print --output-format stream-json --verbose --max-budget-usd ${budgetArg} --dangerously-skip-permissions\n`,
        "utf8",
      );
      proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      proc = spawn(
        "claude",
        ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-budget-usd", budgetArg, "--dangerously-skip-permissions"],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    proc.on("error", (err) => {
      clearTimeout(deadManTimer);
      appendLog({ type: "harness", event: "spawn-error", cycleId: cycle.id, error: err.message });
      resolveOnce({
        signal: "error",
        error: err.message,
        turnCount: realTurnCount || liveTurnCount || turnCount,
        finalMessage,
      });
    });

    resetDeadMan();

    // Grace kill: resolve immediately on result event, give process 15s to exit cleanly.
    // On Windows, MCP cleanup holds stdout open after Claude finishes — without this,
    // the 20-min dead-man timer fires instead.
    let resultGraceTimer = null;
    const RESULT_GRACE_MS = 15_000;

    proc.stdout.on("data", (chunk) => {
      resetDeadMan();
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        appendLog({ cycleId: cycle.id, raw: line });
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" || event.role === "assistant") {
            turnCount++;
            process.stdout.write(".");
            if (turnCount % 10 === 0) process.stdout.write(` ${turnCount}\n`);
            const content = event.message?.content ?? [];
            const textBlock = content.find((c) => c.type === "text");
            if (textBlock?.text?.trim()) {
              assistantLog.push(textBlock.text.trim());
              if (assistantLog.length > 10) assistantLog.shift();
            }
          }

          if (event.type === "user") {
            const hasToolResult =
              Array.isArray(event.message?.content) &&
              event.message.content.some((c) => c.type === "tool_result");
            if (hasToolResult) {
              liveTurnCount++;
              process.stdout.write(` [T${liveTurnCount}]`);
              const cap = getTurnCap(cycle);
              if (liveTurnCount >= cap) {
                (async () => {
                  appendLog({
                    type: "harness",
                    event: "turn-cap-hit",
                    cycleId: cycle.id,
                    liveTurnCount,
                    cap,
                  });
                  console.log(`\n  [TURN CAP] ${cycle.id} hit ${cap}-turn limit — stopping`);

                  if (cycle.outputFile) {
                    console.log(`  [SUMMARY] Requesting progress summary...`);
                    killProc(proc);
                    const summary = await requestTurnCapSummary(cycle.id, assistantLog);
                    console.log(`  [SUMMARY] ${summary.slice(0, 120)}${summary.length > 120 ? "…" : ""}`);

                    // Accumulate history across retries so each attempt sees what prior ones did
                    let priorHistory = [];
                    try {
                      const prior = JSON.parse(
                        readFileSync(join(CYCLE_DIR, cycle.outputFile), "utf8"),
                      );
                      if (Array.isArray(prior.history)) priorHistory = prior.history;
                    } catch { /* no prior file or unparseable — start fresh */ }

                    const history = [
                      ...priorHistory,
                      {
                        attempt: priorHistory.length + 1,
                        turnsUsed: liveTurnCount,
                        partialReason: `turn-cap (${liveTurnCount}/${cap})`,
                        timestamp: new Date().toISOString(),
                        summary,
                      },
                    ];

                    try {
                      writeFileSync(
                        join(CYCLE_DIR, cycle.outputFile),
                        JSON.stringify({
                          passed: false,
                          partial: true,
                          turnsUsed: liveTurnCount,
                          partialReason: `turn-cap (${liveTurnCount}/${cap})`,
                          history,
                          note: `This cycle has been partially attempted ${history.length} time(s) — see history[]. Check filesystem for spec files already written — do NOT re-write them. Focus only on missing specs and remaining test failures.`,
                        }, null, 2),
                        "utf8",
                      );
                    } catch { /* best-effort */ }
                  }

                  resolveOnce({
                    signal: "partial",
                    code: 0,
                    turnCount: liveTurnCount,
                    finalMessage: `CYCLE_PARTIAL:turn-cap reached ${liveTurnCount}/${cap} turns`,
                  });
                })();
              }
            }
          }

          if (event.type === "result") {
            finalMessage =
              typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result ?? "");
            if (typeof event.num_turns === "number") realTurnCount = event.num_turns;
            if (typeof event.total_cost_usd === "number") totalSpentUsd += event.total_cost_usd;

            const signal = detectSignal(finalMessage, 0);
            let resolvedMessage = finalMessage;

            // 0-turn silent failure: claimed complete but wrote no output
            if (signal === "complete" && realTurnCount === 0 && cycle.outputFile) {
              if (!existsSync(join(CYCLE_DIR, cycle.outputFile))) {
                appendLog({ type: "harness", event: "0-turn-silent-failure", cycleId: cycle.id });
                console.log(
                  `  [WARN] ${cycle.id} claimed complete with 0 turns and no output file — treating as partial`,
                );
                resolvedMessage = `CYCLE_PARTIAL:0-turn cycle wrote no output (${cycle.outputFile}) — silent failure`;
                resolveOnce({ signal: "partial", code: 0, turnCount: 0, finalMessage: resolvedMessage });
              } else {
                resolveOnce({ signal, code: 0, turnCount: 0, finalMessage: resolvedMessage });
              }
            } else {
              resolveOnce({
                signal,
                code: 0,
                turnCount: realTurnCount || liveTurnCount || turnCount,
                finalMessage: resolvedMessage,
              });
            }

            // Grace kill: give the process time to flush/exit cleanly, then force-kill.
            // Promise is already resolved above — this is pure cleanup.
            if (!resultGraceTimer) {
              resultGraceTimer = setTimeout(() => {
                appendLog({ type: "harness", event: "result-grace-kill", cycleId: cycle.id });
                console.log(`\n  [GRACE] ${cycle.id}: killing subprocess after ${RESULT_GRACE_MS / 1000}s grace`);
                killProc(proc);
              }, RESULT_GRACE_MS);
            }
          }

          // Accumulate cost from any stream cost events
          if (typeof event.cost_usd === "number") {
            totalSpentUsd += event.cost_usd;
          }
        } catch {
          rawText += line + "\n";
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      appendLog({ type: "stderr", cycleId: cycle.id, data: chunk.toString("utf8") });
    });

    proc.on("close", (code) => {
      clearTimeout(resultGraceTimer);
      // Fallback: fires if process exits without a result event (crash, raw session limit, 0-turn).
      // If resolveOnce already fired from the result event handler, this is a no-op.
      const effectiveMessage = finalMessage || rawText;
      const signal = detectSignal(effectiveMessage, code);
      const effectiveTurnCount = realTurnCount || liveTurnCount || turnCount;
      let resolvedMessage = effectiveMessage;

      if (signal === "complete" && effectiveTurnCount === 0 && cycle.outputFile) {
        if (!existsSync(join(CYCLE_DIR, cycle.outputFile))) {
          appendLog({ type: "harness", event: "0-turn-silent-failure", cycleId: cycle.id });
          console.log(
            `  [WARN] ${cycle.id} claimed complete with 0 turns and no output file — treating as partial`,
          );
          resolvedMessage = `CYCLE_PARTIAL:0-turn cycle wrote no output (${cycle.outputFile}) — silent failure`;
          resolveOnce({ signal: "partial", code, turnCount: effectiveTurnCount, finalMessage: resolvedMessage });
          return;
        }
      }

      resolveOnce({ signal, code, turnCount: effectiveTurnCount, finalMessage: resolvedMessage });
    });
  });
}

// ── Parallel batch runner ─────────────────────────────────────────────────────

async function runCycleBatch(batch, remainingBudget) {
  if (batch.length === 1) {
    const result = await runCycle(batch[0], remainingBudget);
    return [{ cycle: batch[0], result }];
  }

  const perCycleBudget = Math.max(0.5, remainingBudget / batch.length);
  const ids = batch.map((c) => c.id).join(" + ");
  console.log(`  Parallel: ${ids} ($${perCycleBudget.toFixed(2)} each)`);

  const settled = await Promise.allSettled(
    batch.map((cycle) =>
      runCycle(cycle, perCycleBudget).then((result) => ({ cycle, result })),
    ),
  );

  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    appendLog({
      type: "harness",
      event: "batch-spawn-error",
      cycleId: batch[i].id,
      error: s.reason?.message,
    });
    return {
      cycle: batch[i],
      result: { signal: "error", error: s.reason?.message, turnCount: 0, finalMessage: "" },
    };
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();

  console.log("");
  console.log("━━━ Autonomous Multi-Cycle Run ━━━━━━━━━━━━━━━━━━");
  console.log(`Task   : ${userTask}`);
  console.log(`Budget : $${MAX_BUDGET_USD} total`);
  console.log(`Log    : ${runLogFile}`);
  console.log("─────────────────────────────────────────────────");

  appendLog({ type: "harness", event: "run-start", task: userTask, timestamp: new Date().toISOString() });
  notify("Claude — Run Started", userTask.slice(0, 120), { event: "run-start" });

  // ── Phase 1: Orchestrate (build the queue) ──────────────────────────────────

  let queue = readQueue();

  if (!queue) {
    console.log("\n[orchestrate] Planning cycles...");
    process.stdout.write("Progress : ");

    const orchCycle = { id: "orchestrate", type: "orchestrate", status: "pending" };
    notify("Claude — Cycle Started", "orchestrate (orchestrate) | attempt 1", {
      event: "cycle-started",
      cycleId: orchCycle.id,
      cycleType: orchCycle.type,
      attempt: 1,
    });

    const orchResult = await runCycle(orchCycle, MAX_BUDGET_USD - totalSpentUsd);
    appendLog({ type: "cycle-result", cycleId: "orchestrate", ...orchResult });

    if (orchResult.signal === "complete") {
      notify("Claude — Cycle Complete", "orchestrate | planning finished", {
        event: "cycle-complete",
        cycleId: orchCycle.id,
        cycleType: orchCycle.type,
        turnCount: orchResult.turnCount,
      });
    }

    if (orchResult.signal === "needs-human") {
      appendSessionCycle("[autonomous] orchestrate", "blocked", "NEEDS_HUMAN_INPUT during planning");
      console.log("\n[BLOCKED] Orchestration needs human input. Run summary written to session.json.");
      console.log("  To provide input: open-agent-harness resume \"your answer\"");
      notify("Claude — Needs Input", `Orchestration blocked | ${userTask.slice(0, 60)}`);
      process.exit(0);
    }

    appendSessionCycle(
      "[autonomous] orchestrate",
      orchResult.signal === "complete" ? "done" : "partial",
    );

    queue = readQueue();
    if (!queue) {
      console.log("\n[ERROR] Orchestrator did not write task-queue.json. Aborting.");
      notify("Claude — Run Failed", "No task queue produced by orchestrate cycle");
      process.exit(1);
    }

    // Validate task-queue.json schema
    const queueValidation = validateTaskQueue(queue);
    if (!queueValidation.valid) {
      console.log("\n[WARN] task-queue.json schema issues:");
      queueValidation.errors.forEach((e) => console.log(`  - ${e}`));
      appendLog({ type: "validation-warning", file: "task-queue.json", errors: queueValidation.errors });
      // Proceed — queue may still be usable with partial fields
    }
  }

  console.log(`\nQueue: ${queue.cycles.length} cycles`);
  queue.cycles.forEach((c) =>
    console.log(`  [${c.status === "done" ? "✓" : " "}] ${c.id} (${c.type})`),
  );
  console.log("");

  // ── Phase 2: Execute queue ──────────────────────────────────────────────────

  const retryCount = {}; // cycleId → number of attempts

  while (true) {
    const remaining = MAX_BUDGET_USD - totalSpentUsd;
    if (remaining <= 0.1) {
      console.log(`\n[BUDGET] $${MAX_BUDGET_USD} exhausted ($${totalSpentUsd.toFixed(2)} spent). Stopping.`);
      notify("Claude — Budget Exhausted", `$${totalSpentUsd.toFixed(2)} spent`);
      break;
    }

    const batch = nextCycleBatch(queue);
    if (!batch) {
      console.log("\n[DONE] All cycles complete.");
      const skippedPartials = queue.cycles.filter((c) => c.status === "partial");
      if (skippedPartials.length) {
        console.log(`\n[WARN] ${skippedPartials.length} cycle(s) marked partial during this run:`);
        for (const c of skippedPartials) {
          const outputWritten = cycleOutputWritten(c);
          const outputLabel =
            c.type === "deliver"
              ? (deliverOutputFile() ?? "output/delivery-*.md")
              : (c.outputFile ?? "(none)");
          const statusNote = outputWritten
            ? `output saved (${outputLabel}) — resume to continue`
            : "no output written — did not start";
          console.log(`  • ${c.id} (${c.type}) — reason: ${c.partialReason ?? "unknown"} — ${statusNote}`);
        }
        console.log("\n  To retry: open-agent-harness resume");
        notify(
          "Claude — Partial Cycles Skipped",
          `${skippedPartials.length} partial: ${skippedPartials.map((c) => c.id).join(", ")}`,
        );
      }
      notify(
        "Claude — Run Complete",
        `${queue.cycles.filter((c) => c.status === "done").length} done | $${totalSpentUsd.toFixed(2)}`,
      );
      break;
    }

    // Label for logging
    if (batch.length === 1) {
      const attempt = (retryCount[batch[0].id] ?? 0) + 1;
      console.log(`\n[cycle${attempt > 1 ? ` retry ${attempt}` : ""}] ${batch[0].id} (${batch[0].type})`);
    } else {
      console.log(`\n[parallel ×${batch.length}] ${batch.map((c) => c.id).join(" + ")}`);
    }
    process.stdout.write("Progress : ");

    if (batch.length === 1) {
      const attempt = (retryCount[batch[0].id] ?? 0) + 1;
      notify(
        "Claude — Cycle Started",
        `${batch[0].id} (${batch[0].type}) | attempt ${attempt}`,
        { event: "cycle-started", cycleId: batch[0].id, cycleType: batch[0].type, attempt },
      );
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

      // ── Complete ────────────────────────────────────────────────────────────

      if (result.signal === "complete") {
        let testReport = null;

        if (cycle.outputFile) {
          const rawJson = readCycleState(cycle.outputFile);
          const isCritical = CRITICAL_OUTPUT_FILES.has(cycle.outputFile);

          if (!rawJson) {
            if (isCritical) {
              console.log(
                `  [WARN] ${cycle.id} reported complete but ${cycle.outputFile} not written — treating as partial`,
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
                  `  [ERROR] ${cycle.id} wrote unparseable JSON to ${cycle.outputFile} — treating as failed`,
                );
                appendLog({ type: "validation-error", cycleId: cycle.id, file: cycle.outputFile, error: "invalid-json" });
                result.signal = "failed";
              } else {
                console.log(
                  `  [WARN] ${cycle.id} wrote invalid JSON to ${cycle.outputFile} — continuing with no context`,
                );
              }
              parsed = null;
            }

            if (parsed !== null) {
              const validation = validateCycleOutput(cycle.outputFile, parsed);
              if (!validation.valid && !validation.skipped) {
                console.log(`  [WARN] ${cycle.id} schema mismatch (${validation.schemaName}):`);
                validation.errors.forEach((e) => console.log(`    - ${e}`));
                appendLog({ type: "validation-warning", cycleId: cycle.id, errors: validation.errors });
                if (isCritical) {
                  const defaults = CONSERVATIVE_DEFAULTS[cycle.outputFile] ?? {};
                  testReport = { ...defaults, ...parsed };
                  console.log(`  [INFO] Using conservative defaults for missing critical fields in ${cycle.outputFile}`);
                }
              } else if (parsed !== null) {
                testReport = parsed;
              }
            }
          }
        }

        // Only mark done if signal is still complete after all checks
        if (result.signal === "complete") {
          cycle.status = "done";
          cycle.completedAt = new Date().toISOString();
          cycle.turns = result.turnCount;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "done");

          if (batch.length === 1) console.log(`  [OK] ${result.turnCount} turns`);
          else console.log(`  [OK] ${cycle.id} — ${result.turnCount} turns`);

          notify(
            "Claude — Cycle Complete",
            `${cycle.id} | ${result.turnCount} turns`,
            { event: "cycle-complete", cycleId: cycle.id, cycleType: cycle.type, attempt, turnCount: result.turnCount },
          );

          // Scope guard: revert any files the agent touched outside its declared scope
          const unrevertable = checkAndRevertScopeViolations(cycle);
          if (unrevertable && unrevertable.length > 0) {
            appendLog({ type: "harness", event: "scope-revert-unrecoverable", cycleId: cycle.id, files: unrevertable });
            console.log(
              `\n  [SCOPE CLEANUP] ${unrevertable.length} file(s) could not be auto-reverted — injecting cleanup cycle for ${cycle.agent}:`,
            );
            unrevertable.forEach((f) => console.log(`    - ${f}`));

            const cleanupCycle = buildScopeCleanupCycle(cycle, unrevertable);
            const insertIdx = queue.cycles.findIndex(
              (c) => c.status === "pending" && (c.type.startsWith("implement-") || c.type === "reconcile"),
            );
            queue.cycles.splice(
              insertIdx !== -1 ? insertIdx : queue.cycles.length,
              0,
              cleanupCycle,
            );
            writeQueue(queue);
            console.log(`  Cleanup cycle "${cleanupCycle.id}" inserted at position ${insertIdx !== -1 ? insertIdx : "end"}`);
          }

          // After a deliver cycle: write human-readable markdown summary to output/
          if (cycle.type === "deliver") {
            const rawSummary = result.finalMessage ?? "";
            const summary = rawSummary.replace(/\s*CYCLE_COMPLETE\s*$/, "").trim();
            if (summary) {
              const deliverFile = join(OUTPUT_DIR, `delivery-${runTimestamp}.md`);
              const header = `# Delivery — ${runTimestamp}\n\n**Task:** ${userTask}\n\n---\n\n`;
              try {
                writeFileSync(deliverFile, header + summary, "utf8");
                console.log(`  [DELIVER] Summary written to output/delivery-${runTimestamp}.md`);
              } catch (err) {
                console.log(`  [WARN] Could not write delivery markdown: ${err.message}`);
              }
            }
          }

          // After a test cycle: inject fix cycles or recovery cycle on failure
          if (cycle.type === "test" && testReport !== null) {
            if (!testReport.passed && attempt <= MAX_RETRIES) {
              const surfaces = testReport.failedSurfaces?.length
                ? testReport.failedSurfaces
                : ["unknown"];
              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const fixCycles = surfaces.map((surface) => ({
                id: `fix-${surface}-attempt-${attempt}`,
                type: "fix",
                target: surface,
                status: "pending",
                outputFile: `fix-${surface}-attempt-${attempt}.json`,
              }));
              const retryTest = {
                id: `test-retry-${attempt}`,
                type: "test",
                status: "pending",
                outputFile: "test.json",
              };
              const insertAt = deliverIdx !== -1 ? deliverIdx : queue.cycles.length;
              queue.cycles.splice(insertAt, 0, ...fixCycles, retryTest);
              writeQueue(queue);
              console.log(`  [FIX] Tests failed — injecting fix cycles for: ${surfaces.join(", ")}`);
            } else if (!testReport.passed) {
              // MAX_RETRIES exhausted — inject recovery cycle
              const deliverIdx = queue.cycles.findIndex((c) => c.type === "deliver");
              const recoveryCycle = {
                id: "recovery",
                type: "recovery",
                status: "pending",
                outputFile: "recovery.json",
                notes: `Injected after test failed ${attempt} times`,
              };
              queue.cycles.splice(
                deliverIdx !== -1 ? deliverIdx : queue.cycles.length,
                0,
                recoveryCycle,
              );
              writeQueue(queue);
              console.log(`  [RECOVERY] Tests failed after ${attempt} attempts — injecting recovery cycle`);
              notify("Claude — Recovery Cycle", `${attempt} test attempts exhausted`);
            }
          }
        }
      }

      // ── Needs human ─────────────────────────────────────────────────────────

      if (result.signal === "needs-human") {
        cycle.status = "blocked";
        cycle.blockedReason = result.finalMessage.slice(0, 300);
        cycle.blockedAt = new Date().toISOString();
        writeQueue(queue);
        appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
        console.log(`\n[BLOCKED] ${cycle.id} needs human input.`);
        console.log(`  Reason: ${cycle.blockedReason.slice(0, 120)}`);
        console.log(`  To resume: open-agent-harness resume "your answer"`);
        notify("Claude — Needs Input", `${cycle.id} blocked | ${userTask.slice(0, 60)}`);
        shouldBreak = true;

      // ── Partial ─────────────────────────────────────────────────────────────

      } else if (result.signal === "partial") {
        const reasonMatch = result.finalMessage.match(/CYCLE_PARTIAL:(.+)/);
        const reason = reasonMatch?.[1]?.trim() ?? "incomplete";
        const nextAttempt = attempt + 1;
        const effectiveMaxRetries = getEffectiveMaxRetries(cycle, reason, result.signal, result.finalMessage);

        if (attempt < effectiveMaxRetries) {
          console.log(
            `  [PARTIAL → retry] ${cycle.id}: ${reason} (attempt ${nextAttempt}/${effectiveMaxRetries})`,
          );
          notify(
            "Claude — Cycle Retrying",
            `${cycle.id} | partial | retry ${nextAttempt}/${effectiveMaxRetries}`,
            { event: "cycle-retrying", cycleId: cycle.id, cycleType: cycle.type, attempt, nextAttempt },
          );
          // cycle stays pending — picked up in next outer loop iteration
        } else {
          const outputWritten = cycleOutputWritten(cycle);
          const textToCheck = (reason ?? "") + " " + result.finalMessage;
          const isRateLimit =
            textToCheck.includes("rate-limit") ||
            textToCheck.includes("weekly") ||
            textToCheck.includes("session limit") ||
            textToCheck.includes("rate limit") ||
            textToCheck.includes("hit your");

          if (isRateLimit && !outputWritten) {
            // Rate-limit with no output: keep pending so the next run retries cleanly
            appendSessionCycle(`[autonomous] ${cycle.id}`, "partial", reason);
            console.log(
              `  [RATE-LIMIT → pending] ${cycle.id}: no output after ${attempt} attempts — kept pending for next run`,
            );
            notify("Claude — Cycle Kept Pending", `${cycle.id} | rate-limit, no output after ${attempt} attempts`);
          } else {
            cycle.status = "partial";
            cycle.partialReason = reason;
            writeQueue(queue);
            appendSessionCycle(`[autonomous] ${cycle.id}`, "partial", reason);
            console.log(`  [PARTIAL] ${cycle.id} incomplete after ${attempt} attempts: ${reason}`);
            const remainingAfter = queue.cycles.filter((c) => c.status === "pending");
            if (remainingAfter.length) {
              console.log(
                `  [WARN] ${cycle.id} is partial — run continues but downstream cycles may be affected. Run: open-agent-harness resume to retry.`,
              );
            }
            notify("Claude — Cycle Partial", `${cycle.id} | ${reason.slice(0, 80)}`);
          }
          // Partial doesn't stop the run — next cycle proceeds
        }

      // ── Hung / error / failed ────────────────────────────────────────────────

      } else if (result.signal !== "complete") {
        const effectiveMaxRetriesErr = getEffectiveMaxRetries(cycle, result.finalMessage, result.signal);
        if (attempt < effectiveMaxRetriesErr) {
          console.log(
            `  [${result.signal.toUpperCase()} → retry ${attempt + 1}/${effectiveMaxRetriesErr}] ${cycle.id}`,
          );
          notify(
            "Claude — Cycle Retrying",
            `${cycle.id} | ${result.signal} | retry ${attempt + 1}/${effectiveMaxRetriesErr}`,
            { event: "cycle-retrying", cycleId: cycle.id, cycleType: cycle.type, attempt, nextAttempt: attempt + 1 },
          );
          // cycle stays pending
        } else {
          cycle.status = "blocked";
          cycle.blockedReason = `${result.signal} after ${attempt} attempts`;
          writeQueue(queue);
          appendSessionCycle(`[autonomous] ${cycle.id}`, "blocked", cycle.blockedReason);
          console.log(`\n[BLOCKED] ${cycle.id} ${result.signal} — ${attempt} attempts exhausted.`);
          notify("Claude — Cycle Failed", `${cycle.id} | ${result.signal}`);
          shouldBreak = true;
        }
      }
    } // end for-each batch result

    if (shouldBreak) break;
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  const finalQueue = readQueue();
  const done    = finalQueue?.cycles.filter((c) => c.status === "done").length ?? 0;
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
  console.log("━━━ Run Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Done     : ${done}`);
  console.log(`Partial  : ${partial}`);
  console.log(`Blocked  : ${blocked}`);
  console.log(`Pending  : ${pending}`);
  console.log(`Duration : ${duration}`);
  console.log(`Spent    : $${totalSpentUsd.toFixed(2)} / $${MAX_BUDGET_USD}`);
  console.log(`Log      : ${runLogFile}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  appendLog({
    type: "harness",
    event: "run-end",
    done, blocked, partial, pending,
    totalSpentUsd,
    duration,
  });
}

main().catch((err) => {
  console.error("[FATAL]", err);
  appendLog({ type: "harness", event: "fatal", error: err.message });
  notify("Claude — Fatal Error", err.message.slice(0, 100));
  process.exit(1);
});

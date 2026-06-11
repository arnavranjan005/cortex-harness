import chalk from "chalk";
import { spawn, execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import {
  isWindows,
  DEAD_MAN_MS,
  RESULT_GRACE_MS,
  MAX_RETRIES,
  TEST_MAX_RETRIES_CLEAN,
  getTurnCap,
} from "./constants.mjs";
import { pollReadiness, detectDevServerConfig, startDevServer } from "./process-utils.mjs";

// On Windows, PowerShell spawned with -NoProfile does not load the user profile
// that adds %APPDATA%\npm to PATH, so `claude` (a .cmd shim) is not found.
// Resolve to the full path once at module load so every .ps1 script uses it.
function resolveClaudeExe() {
  if (!isWindows) return "claude";
  try {
    const lines = execSync("where.exe claude", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Prefer .cmd shim — it works reliably when called from PowerShell
    return lines.find((l) => l.toLowerCase().endsWith(".cmd")) ?? lines[0] ?? "claude";
  } catch {
    return "claude";
  }
}
const CLAUDE_EXE = resolveClaudeExe();

// Determine the effective retry ceiling for a cycle attempt.
// Test cycles use a generous cap when the failure is a clean turn-cap partial;
// rate-limit and other error types fall back to MAX_RETRIES.
function getEffectiveMaxRetries(cycle, reason, signal, rawMessage = "", { CYCLE_DIR }) {
  if (cycle.type !== "test") return MAX_RETRIES;
  const textToCheck = (reason ?? "") + " " + rawMessage;
  const isApiRateLimit =
    textToCheck.includes("rate-limit") || textToCheck.includes("rate limit");
  if (isApiRateLimit) return MAX_RETRIES;

  if (signal === "failed" || signal === "hung") {
    if (cycle.outputFile) {
      try {
        const outputPath = join(CYCLE_DIR, cycle.outputFile);
        const data = JSON.parse(readFileSync(outputPath, "utf8"));
        if (data.partial === true && String(data.partialReason ?? "").includes("turn-cap")) {
          return TEST_MAX_RETRIES_CLEAN;
        }
      } catch { /* output file missing or unreadable — fall through */ }
    }
    return MAX_RETRIES;
  }
  return TEST_MAX_RETRIES_CLEAN;
}

// MCP server names that drive a real browser — presence means the cycle needs a running app.
const BROWSER_MCP_RE = /playwright|puppeteer|selenium|browser-use/i;

function hasBrowserMcp(servers) {
  if (!servers || typeof servers !== "object") return false;
  return Object.keys(servers).some((name) => BROWSER_MCP_RE.test(name));
}

/**
 * Returns runCycle and runCycleBatch bound to the given runtime context.
 *
 * @param {object} ctx
 * @param {string}   ctx.ROOT                  - project root (cwd)
 * @param {string}   ctx.HARNESS_DIR           - .harness/ absolute path
 * @param {string}   ctx.RUNS_DIR              - .harness/runs/ absolute path
 * @param {string}   ctx.CYCLE_DIR             - .harness/cycle-state/ absolute path
 * @param {string}   ctx.runTimestamp          - run identifier (for temp file naming)
 * @param {object}   ctx.config                - loaded harness config
 * @param {object}   ctx.spendRef              - mutable { value: number } for total USD spent
 * @param {Function} ctx.killProc              - (proc) => void
 * @param {Function} ctx.buildFilteredMcpServers - (agentName) => object|null
 * @param {Function} ctx.buildCyclePrompt      - (cycle) => string
 * @param {Function} ctx.appendLog             - (obj) => void
 * @param {Function} ctx.notify               - (title, message, meta?) => void
 */
export function createCycleRunner({
  ROOT,
  HARNESS_DIR,
  RUNS_DIR,
  CYCLE_DIR,
  runTimestamp,
  config,
  spendRef,
  killProc,
  buildFilteredMcpServers,
  buildCyclePrompt,
  appendLog,
  notify,
}) {
  // Request a short progress summary from Claude when a cycle hits the turn cap.
  async function requestTurnCapSummary(cycleId, assistantLog) {
    const messages =
      Array.isArray(assistantLog) && assistantLog.length
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
          `Get-Content -Path "${summaryPromptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --output-format text --max-turns 3 --max-budget-usd 0.10 --dangerously-skip-permissions\n`,
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
          ["-p", prompt, "--output-format", "text", "--max-turns", "3",
            "--max-budget-usd", "0.10", "--dangerously-skip-permissions"],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
      }

      proc.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
      proc.on("close", () => { clearTimeout(timeout); resolve(output.trim() || "(no summary returned)"); });
      proc.on("error", () => { clearTimeout(timeout); resolve("(summary spawn failed)"); });
    });
  }

  async function runCycle(cycle, remainingBudgetUsd) {
    // Resolve MCP servers first — needed to auto-detect whether a dev server is required.
    // Use agent name if set; fall back to cycle type so type-keyed mcpScope entries
    // (e.g. "smoke": ["playwright"]) work without needing a sub-agent file.
    const mcpKey = cycle.agent ?? cycle.type ?? null;
    const filteredServers = buildFilteredMcpServers(mcpKey);

    // Start dev server when explicitly requested OR when the cycle's resolved MCP set
    // includes a browser-driving tool (playwright, puppeteer, etc.).
    // This means smoke and any other cycle that gets browser MCPs auto-start services
    // without requiring needsDevServer in the queue JSON.
    let devServerProcs = [];
    let devServerUrl = "";
    if (cycle.needsDevServer || hasBrowserMcp(filteredServers)) {
      const dsCfg = config.devServer ?? detectDevServerConfig(ROOT);
      if (dsCfg) {
        const result = await startDevServer(dsCfg, { ROOT });
        devServerProcs = result.procs;
        devServerUrl = result.browserUrl;
      }
    }

    const prompt = buildCyclePrompt(devServerUrl ? { ...cycle, devServerUrl } : cycle);

    return new Promise((resolve) => {
      let turnCount = 0;
      let liveTurnCount = 0;
      let realTurnCount = 0;
      let finalMessage = "";
      let rawText = "";
      const assistantLog = [];
      let deadManTimer = null;
      let settled = false;
      let rateLimitResetsAt = null;
      let turnCapKilled = false;

      function resolveOnce(value) {
        if (settled) return;
        settled = true;
        clearTimeout(deadManTimer);
        process.stdout.write("\n");
        resolve(value);
      }

      function isSessionLimitMessage(message) {
        return (
          message.includes("You've hit your session limit") ||
          message.includes("You've hit your weekly limit") ||
          message.includes("session limit") ||
          message.includes("weekly limit")
        );
      }

      function detectSignal(message, code) {
        const lastLine = message.trimEnd().split("\n").findLast((l) => l.trim()) ?? "";
        const lastLineTrimmed = lastLine.trim();

        if (lastLineTrimmed.startsWith("NEEDS_HUMAN_INPUT")) return "needs-human";
        if (isSessionLimitMessage(message)) {
          appendLog({
            type: "harness",
            event: "rate-limit-hit",
            cycleId: cycle.id,
            turnCount: realTurnCount || liveTurnCount || turnCount,
            resetsAt: rateLimitResetsAt,
          });
          console.log(
            `  ${chalk.red("[SESSION LIMIT]")} ${chalk.cyan(cycle.id)} hit usage limit after ${realTurnCount || liveTurnCount || turnCount} turns — halting run`,
          );
          return "session-limit";
        }
        if (message.includes("rate limit") || message.includes("rate-limit")) {
          appendLog({
            type: "harness",
            event: "rate-limit-hit",
            cycleId: cycle.id,
            turnCount: realTurnCount || liveTurnCount || turnCount,
            resetsAt: rateLimitResetsAt,
          });
          console.log(
            `  ${chalk.yellow("[RATE LIMIT]")} ${chalk.cyan(cycle.id)} hit rate limit after ${realTurnCount || liveTurnCount || turnCount} turns — treating as partial`,
          );
          return "partial";
        }
        if (lastLineTrimmed === "CYCLE_COMPLETE") return "complete";
        if (lastLineTrimmed.startsWith("CYCLE_PARTIAL:")) return "partial";
        if (message.includes("CYCLE_COMPLETE")) return "complete";
        if (message.match(/CYCLE_PARTIAL:/)) return "partial";
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
            `\n${chalk.red("[HUNG]")} Cycle ${chalk.cyan(cycle.id)} silent for 20 min after ${realTurnCount || liveTurnCount || turnCount} turns`,
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
      let tmpMcpPath = null;
      if (filteredServers !== null) {
        tmpMcpPath = join(HARNESS_DIR, `tmp-mcp-${cycle.id}.json`);
        writeFileSync(tmpMcpPath, JSON.stringify({ mcpServers: filteredServers }, null, 2), "utf8");
      }

      let proc;
      if (isWindows) {
        const promptFile = join(
          RUNS_DIR,
          `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}-prompt.txt`,
        );
        writeFileSync(promptFile, prompt, "utf8");
        const psFile = join(
          RUNS_DIR,
          `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}.ps1`,
        );
        // Keep native backslash path — PowerShell double-quoted strings treat \ as literal.
        // Forward-slash conversion caused Claude to fail resolving the path and fall back to .mcp.json.
        const mcpConfigFlag = tmpMcpPath ? ` --mcp-config "${tmpMcpPath}"` : "";
        writeFileSync(
          psFile,
          `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --output-format stream-json --verbose --max-budget-usd ${budgetArg} --dangerously-skip-permissions${mcpConfigFlag}\n`,
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
          [
            "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--max-budget-usd", budgetArg, "--dangerously-skip-permissions",
            ...(tmpMcpPath ? ["--mcp-config", tmpMcpPath] : []),
          ],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
      }

      if (tmpMcpPath) {
        proc.on("close", () => {
          try { unlinkSync(tmpMcpPath); } catch { /* ignore */ }
        });
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

      let resultGraceTimer = null;

      proc.stdout.on("data", (chunk) => {
        resetDeadMan();
        const lines = chunk.toString("utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          appendLog({ cycleId: cycle.id, raw: line });
          try {
            const event = JSON.parse(line);

            if (event.type === "rate_limit_event" && event.rate_limit_info?.resetsAt) {
              rateLimitResetsAt = event.rate_limit_info.resetsAt;
            }

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
                    console.log(
                      `\n  ${chalk.yellow("[TURN CAP]")} ${chalk.cyan(cycle.id)} hit ${cap}-turn limit — stopping`,
                    );

                    if (cycle.outputFile) {
                      console.log(`  ${chalk.dim("[SUMMARY]")} Requesting progress summary...`);
                      turnCapKilled = true;
                      killProc(proc);
                      const summary = await requestTurnCapSummary(cycle.id, assistantLog);
                      console.log(
                        `  ${chalk.dim("[SUMMARY]")} ${summary.slice(0, 120)}${summary.length > 120 ? "…" : ""}`,
                      );

                      let priorHistory = [];
                      try {
                        const prior = JSON.parse(readFileSync(join(CYCLE_DIR, cycle.outputFile), "utf8"));
                        if (Array.isArray(prior.history)) priorHistory = prior.history;
                      } catch { /* no prior file — start fresh */ }

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
                          JSON.stringify(
                            {
                              passed: false,
                              partial: true,
                              turnsUsed: liveTurnCount,
                              partialReason: `turn-cap (${liveTurnCount}/${cap})`,
                              history,
                              note: `This cycle has been partially attempted ${history.length} time(s) — see history[]. Check filesystem for spec files already written — do NOT re-write them. Focus only on missing specs and remaining test failures.`,
                            },
                            null,
                            2,
                          ),
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
              if (typeof event.total_cost_usd === "number")
                spendRef.value += event.total_cost_usd;

              const signal = detectSignal(finalMessage, 0);
              let resolvedMessage = finalMessage;

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
                  resetsAt: rateLimitResetsAt,
                });
              }

              if (!resultGraceTimer) {
                resultGraceTimer = setTimeout(() => {
                  appendLog({ type: "harness", event: "result-grace-kill", cycleId: cycle.id });
                  console.log(
                    `\n  [GRACE] ${cycle.id}: killing subprocess after ${RESULT_GRACE_MS / 1000}s grace`,
                  );
                  killProc(proc);
                  if (tmpMcpPath) {
                    try { unlinkSync(tmpMcpPath); } catch { /* already deleted by close handler */ }
                  }
                }, RESULT_GRACE_MS);
              }
            }

            if (typeof event.cost_usd === "number") {
              spendRef.value += event.cost_usd;
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
        devServerProcs.forEach((p) => killProc(p));
        clearTimeout(resultGraceTimer);
        if (turnCapKilled) return;
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

  return { runCycle, runCycleBatch, getEffectiveMaxRetries: (cycle, reason, signal, rawMessage) =>
    getEffectiveMaxRetries(cycle, reason, signal, rawMessage, { CYCLE_DIR }) };
}

import { logger } from "../logger.mjs";
﻿import chalk from "chalk";
import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import {
  isWindows,
  DEAD_MAN_MS,
  RESULT_GRACE_MS,
  MAX_RETRIES,
  TEST_MAX_RETRIES_CLEAN,
  SMOKE_MAX_RETRIES_CLEAN,
  SUMMARY_BUDGET_USD,
  getTurnCap,
} from "./constants.mjs";
import { pollReadiness, detectDevServerConfig, startDevServer } from "./process-utils.mjs";
import { claudeAdapter } from "./cli-adapters/claude-adapter.mjs";
import { normalizeAdapterOutput, diagnoseProviderFailure } from "./cli-adapters/output-normalize.mjs";
import { CYCLE_SIGNAL, classifySignal, isSessionLimitMessage, isRateLimitMessage, isBillingErrorMessage } from "./cycle-signal.mjs";

// Render a tool_use input as a short human-readable hint (file path, command, etc.)
// for the turn-cap fallback summary — never the full payload.
function describeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const candidate = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query;
  if (typeof candidate === "string") return candidate.slice(0, 80);
  return "";
}

// Determine the effective retry ceiling for a cycle attempt.
// Test cycles use a generous cap when the failure is a clean turn-cap partial;
// rate-limit and other error types fall back to MAX_RETRIES.
function getEffectiveMaxRetries(cycle, reason, signal, rawMessage = "", { CYCLE_DIR }) {
  if (cycle.type !== "test" && cycle.type !== "smoke") return MAX_RETRIES;
  const textToCheck = (reason ?? "") + " " + rawMessage;
  if (isRateLimitMessage(textToCheck)) return MAX_RETRIES;

  const cleanCap = cycle.type === "smoke" ? SMOKE_MAX_RETRIES_CLEAN : TEST_MAX_RETRIES_CLEAN;

  if (signal === CYCLE_SIGNAL.FAILED || signal === CYCLE_SIGNAL.HUNG) {
    if (cycle.outputFile) {
      try {
        const outputPath = join(CYCLE_DIR, cycle.outputFile);
        const data = JSON.parse(readFileSync(outputPath, "utf8"));
        if (data.partial === true && String(data.partialReason ?? "").includes("turn-cap")) {
          return cleanCap;
        }
      } catch { /* output file missing or unreadable — fall through */ }
    }
    return MAX_RETRIES;
  }
  return cleanCap;
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
  adapter = claudeAdapter,
}) {
  // Request a short progress summary from Claude when a cycle hits the turn cap.
  async function requestTurnCapSummary(cycleId, assistantLog) {
    const messages =
      Array.isArray(assistantLog) && assistantLog.length
        ? assistantLog.map((text, i) => `[Turn ${i + 1}]:\n${text}`).join("\n\n")
        : "(none captured)";

    const prompt = `You are summarizing progress from a test cycle that was cut off by a turn limit.

Cycle: ${cycleId}
Last ${Array.isArray(assistantLog) ? assistantLog.length : 0} log entries before cut-off:

Entries come in three forms:
- Plain prose: the assistant's own narration.
- "[tool call] ToolName(target)": the assistant actually invoked that tool on that target
  (e.g. edited a file, ran a command) — this is a real action, not just a stated intent.
- "[tool result] ToolName(target) -> ok|error": the outcome of that tool call. "error" means
  that specific action failed (e.g. a test run failed, an edit was rejected); "ok" means it succeeded.

${messages}

In 2-3 sentences, summarize:
1. What was completed (spec files written, tests passing) — treat "ok" tool results as confirmed completions
2. What still remains (specs not yet written, test failures not fixed) — call out any "error" results specifically

Be specific — list file names if mentioned. Do not guess. Only use what is in the entries above.
Reply with only the summary, no preamble.`;

    return new Promise((resolve) => {
      let output = "";
      let errOutput = "";
      let proc;
      const timeout = setTimeout(() => {
        try { killProc(proc); } catch { /* already gone */ }
        resolve("(summary timed out)");
      }, 60_000);

      const summaryPromptFile = join(RUNS_DIR, `summary-${Date.now()}.txt`);
      writeFileSync(summaryPromptFile, prompt, "utf8");
      const summaryPlan = adapter.buildSummarySpawnPlan({
        prompt,
        budgetUsd: SUMMARY_BUDGET_USD,
        promptFile: summaryPromptFile,
        isWindows,
      });

      if (isWindows) {
        const summaryPsFile = join(RUNS_DIR, `summary-${Date.now()}.ps1`);
        writeFileSync(summaryPsFile, summaryPlan.psContent, "utf8");
        proc = spawn(
          summaryPlan.command,
          summaryPlan.args.map((a) => (a === "__PS_FILE__" ? summaryPsFile : a)),
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        proc = spawn(summaryPlan.command, summaryPlan.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      }

      proc.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk) => { errOutput += chunk.toString("utf8"); });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        const failure = diagnoseProviderFailure(adapter, { rawStdout: output, rawStderr: errOutput, outputFormat: summaryPlan.outputFormat });
        if (failure) {
          const billingUrl = failure.message.match(/https:\/\/\S+/)?.[0];
          const reason = failure.type === "billing" ? "payment method required" : "usage limit reached";
          resolve(`(summary unavailable — ${reason}${billingUrl ? `: ${billingUrl}` : ""})`);
          return;
        }
        const normalized = normalizeAdapterOutput(adapter, output, summaryPlan.outputFormat).trim();
        if (normalized) {
          resolve(normalized);
        } else if (errOutput.trim()) {
          resolve(`(no summary returned — exit ${code}: ${errOutput.trim().slice(0, 200)})`);
        } else {
          resolve(`(no summary returned — exit ${code}, no output)`);
        }
      });
      proc.on("error", (err) => { clearTimeout(timeout); resolve(`(summary spawn failed: ${err.message})`); });
    });
  }

  async function runCycle(cycle, remainingBudgetUsd) {
    // Resolve MCP servers first — needed to auto-detect whether a dev server is required.
    // Use agent name if set; fall back to cycle type so type-keyed mcpScope entries
    // (e.g. "smoke": ["playwright"]) work without needing a sub-agent file.
    const mcpKey = cycle.agent ?? cycle.type ?? null;
    const mcpScopeMechanism = adapter.capabilities.mcpScopeMechanism ?? (adapter.capabilities.supportsMcp ? "flag" : "none");
    let filteredServers = mcpScopeMechanism !== "none" ? buildFilteredMcpServers(mcpKey) : null;

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
      let lastAssistantText = "";
      let stderrText = "";
      let modelLogged = false;
      let cycleSessionId = null;
      const assistantLog = [];
      const pendingToolCalls = new Map(); // tool_use id -> { name, desc }, until its tool_result arrives
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

      // Logs the session/rate-limit transition (side effect), then defers the
      // actual signal value to the shared classifier so every caller agrees
      // on the same vocabulary and matching rules.
      function detectSignal(message, code) {
        if (isSessionLimitMessage(message)) {
          appendLog({
            type: "harness",
            event: "rate-limit-hit",
            cycleId: cycle.id,
            turnCount: realTurnCount || liveTurnCount || turnCount,
            resetsAt: rateLimitResetsAt,
          });
          logger.info(
            `  ${chalk.red("[SESSION LIMIT]")} ${chalk.cyan(cycle.id)} hit usage limit after ${realTurnCount || liveTurnCount || turnCount} turns — halting run`,
          );
        } else if (isBillingErrorMessage(message)) {
          appendLog({
            type: "harness",
            event: "billing-error-hit",
            cycleId: cycle.id,
            turnCount: realTurnCount || liveTurnCount || turnCount,
          });
          logger.info(
            `  ${chalk.red("[BILLING]")} ${chalk.cyan(cycle.id)} hit a payment/billing error after ${realTurnCount || liveTurnCount || turnCount} turns — halting run`,
          );
        } else if (isRateLimitMessage(message)) {
          appendLog({
            type: "harness",
            event: "rate-limit-hit",
            cycleId: cycle.id,
            turnCount: realTurnCount || liveTurnCount || turnCount,
            resetsAt: rateLimitResetsAt,
          });
          logger.info(
            `  ${chalk.yellow("[RATE LIMIT]")} ${chalk.cyan(cycle.id)} hit rate limit after ${realTurnCount || liveTurnCount || turnCount} turns — treating as partial`,
          );
        }
        return classifySignal(message, code);
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
          logger.info(
            `\n${chalk.red("[HUNG]")} Cycle ${chalk.cyan(cycle.id)} silent for 20 min after ${realTurnCount || liveTurnCount || turnCount} turns`,
          );
          notify("Claude — Cycle Hung", `${cycle.id} | ${realTurnCount || liveTurnCount || turnCount} turns`);
          killProc(proc);
          resolveOnce({
            signal: CYCLE_SIGNAL.HUNG,
            turnCount: realTurnCount || liveTurnCount || turnCount,
            finalMessage,
          });
        }, DEAD_MAN_MS);
      }

      const budgetArg = Math.max(0.5, Number(remainingBudgetUsd.toFixed(2)));
      // Both mechanisms produce a disposable, cycle-unique temp file with the
      // same write-before/delete-after lifecycle — only how it's applied to
      // the spawned process differs (CLI flag vs. env var), which is handled
      // entirely inside adapter.buildSpawnPlan.
      let tmpMcpPath = null;
      if (filteredServers !== null) {
        if (mcpScopeMechanism === "flag") {
          tmpMcpPath = join(HARNESS_DIR, `tmp-mcp-${cycle.id}.json`);
          writeFileSync(tmpMcpPath, JSON.stringify({ mcpServers: filteredServers }, null, 2), "utf8");
        } else if (mcpScopeMechanism === "config-file" && adapter.buildScopedConfig) {
          tmpMcpPath = adapter.buildScopedConfig({
            ROOT,
            allowedServerNames: Object.keys(filteredServers),
            cycleId: cycle.id,
            tmpDir: HARNESS_DIR,
          });
        }
      }

      const promptFile = join(
        RUNS_DIR,
        `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}-prompt.txt`,
      );
      writeFileSync(promptFile, prompt, "utf8");

      const spawnPlan = adapter.buildSpawnPlan({
        prompt,
        cycle,
        budgetUsd: budgetArg,
        mcpConfigPath: tmpMcpPath,
        promptFile,
        isWindows,
      });

      const spawnEnv = spawnPlan.env ? { ...process.env, ...spawnPlan.env } : undefined;

      let proc;
      if (isWindows) {
        const psFile = join(
          RUNS_DIR,
          `${runTimestamp}-${cycle.id.replace(/[^a-z0-9]/gi, "-")}.ps1`,
        );
        writeFileSync(psFile, spawnPlan.psContent, "utf8");
        proc = spawn(
          spawnPlan.command,
          spawnPlan.args.map((a) => (a === "__PS_FILE__" ? psFile : a)),
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) },
        );
      } else {
        proc = spawn(spawnPlan.command, spawnPlan.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) });
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
          signal: CYCLE_SIGNAL.ERROR,
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
          const event = adapter.parseEventLine(line);
          if (event === null) {
            rawText += line + "\n";
            continue;
          }
          try {
            const normalized = adapter.extractResult(event);
            if (normalized === null) continue;

            if (normalized.kind === "rate_limit") {
              rateLimitResetsAt = normalized.resetsAt;
            }

            // Hard provider failure (billing, auth, invalid model) reported
            // mid-stream instead of any "text"/"final" event — without this,
            // finalMessage/lastAssistantText/rawText all stay empty and the
            // real cause is lost; classification falls back to a generic
            // "0-turn cycle wrote no output" partial instead of the actual error.
            if (normalized.kind === "stream_error") {
              finalMessage = normalized.text;
            }

            // Claude: model is known synchronously from the stream itself
            // (system/init event) — log it immediately. OpenCode: no event
            // carries it, so just remember the sessionID here and resolve
            // the model post-hoc via adapter.resolveModelInfo() once the
            // process closes (see below).
            if (normalized.kind === "model_info" && !modelLogged) {
              modelLogged = true;
              appendLog({
                type: "harness",
                event: "model-info",
                cycleId: cycle.id,
                provider: adapter.name,
                model: normalized.model,
              });
            }
            if (!cycleSessionId && normalized.sessionID) {
              cycleSessionId = normalized.sessionID;
            }

            if (normalized.kind === "assistant") {
              turnCount++;
              process.stdout.write(".");
              if (turnCount % 10 === 0) process.stdout.write(` ${turnCount}\n`);
              const textBlock = normalized.text;
              const toolCalls = normalized.toolCalls ?? [];
              if (textBlock) {
                assistantLog.push(textBlock);
                lastAssistantText = textBlock;
              } else if (toolCalls.length) {
                // No prose this turn — record the tool calls so the fallback
                // summary still has something concrete (tool-only turns are common).
                const desc = toolCalls
                  .map((t) => `${t.name}(${describeToolInput(t.input)})`)
                  .join(", ");
                assistantLog.push(`[tool call] ${desc}`);
              }
              // Track every tool call (even ones alongside prose) so its result can be
              // matched up below and the summary can see success/failure, not just intent.
              for (const t of toolCalls) {
                pendingToolCalls.set(t.id, { name: t.name, desc: describeToolInput(t.input) });
              }
              if (assistantLog.length > 10) assistantLog.shift();
            }

            // Shared by both "tool_result" (Claude — fires once per resolved tool
            // call) and "turn" (OpenCode — fires once per step_finish; a turn that
            // did tool work is functionally equivalent to a Claude tool_result for
            // cap-counting purposes, since OpenCode has no separate call/result
            // event pair). Without this shared trigger, OpenCode cycles would
            // never increment liveTurnCount and the turn-cap safety net would
            // never fire — confirmed this was previously the case.
            async function registerLiveTurn() {
              liveTurnCount++;
              process.stdout.write(` [T${liveTurnCount}]`);
              const cap = getTurnCap(cycle);
              // killProc() doesn't kill the child instantly (esp. on Windows), so buffered
              // stdout can still deliver another turn after the cap is hit — guard
              // against re-entering this block and double-running the summary/file-write.
              if (liveTurnCount >= cap && !turnCapKilled) {
                appendLog({
                  type: "harness",
                  event: "turn-cap-hit",
                  cycleId: cycle.id,
                  liveTurnCount,
                  cap,
                });
                logger.info(
                  `\n  ${chalk.yellow("[TURN CAP]")} ${chalk.cyan(cycle.id)} hit ${cap}-turn limit — stopping`,
                );

                turnCapKilled = true;
                killProc(proc);

                if (cycle.outputFile) {
                  logger.info(`  ${chalk.dim("[SUMMARY]")} Requesting progress summary...`);
                  const summary = await requestTurnCapSummary(cycle.id, assistantLog);
                  logger.info(
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
                  signal: CYCLE_SIGNAL.PARTIAL,
                  code: 0,
                  turnCount: liveTurnCount,
                  finalMessage: `CYCLE_PARTIAL:turn-cap reached ${liveTurnCount}/${cap} turns`,
                });
              }
            }

            if (normalized.kind === "tool_result") {
              const resultBlocks = normalized.results ?? [];
              for (const r of resultBlocks) {
                const call = pendingToolCalls.get(r.toolUseId);
                if (!call) continue;
                pendingToolCalls.delete(r.toolUseId);
                const outcome = r.isError ? "error" : "ok";
                assistantLog.push(`[tool result] ${call.name}(${call.desc}) -> ${outcome}`);
                if (assistantLog.length > 10) assistantLog.shift();
              }
              if (resultBlocks.length > 0) registerLiveTurn();
            }

            // OpenCode's step_finish — fires once per turn with cost/token data
            // (no separate "final"/"cost" event exists for this adapter, so this
            // is also the only place OpenCode cycles' spend gets tracked).
            if (normalized.kind === "turn") {
              if (typeof normalized.costUsd === "number") spendRef.value += normalized.costUsd;
              if (normalized.reason === "tool-calls") registerLiveTurn();
            }

            if (normalized.kind === "final") {
              finalMessage = normalized.finalMessage;
              if (typeof normalized.numTurns === "number") realTurnCount = normalized.numTurns;
              if (typeof normalized.costUsd === "number") spendRef.value += normalized.costUsd;

              const signal = detectSignal(finalMessage, 0);
              let resolvedMessage = finalMessage;

              if (signal === CYCLE_SIGNAL.COMPLETE && realTurnCount === 0 && cycle.outputFile) {
                if (!existsSync(join(CYCLE_DIR, cycle.outputFile))) {
                  appendLog({ type: "harness", event: "0-turn-silent-failure", cycleId: cycle.id });
                  logger.info(
                    `  [WARN] ${cycle.id} claimed complete with 0 turns and no output file — treating as partial`,
                  );
                  resolvedMessage = `CYCLE_PARTIAL:0-turn cycle wrote no output (${cycle.outputFile}) — silent failure`;
                  resolveOnce({ signal: CYCLE_SIGNAL.PARTIAL, code: 0, turnCount: 0, finalMessage: resolvedMessage });
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
                  logger.info(
                    `\n  [GRACE] ${cycle.id}: killing subprocess after ${RESULT_GRACE_MS / 1000}s grace`,
                  );
                  killProc(proc);
                  if (tmpMcpPath) {
                    try { unlinkSync(tmpMcpPath); } catch { /* already deleted by close handler */ }
                  }
                }, RESULT_GRACE_MS);
              }
            }

            if (normalized.kind === "cost" && typeof normalized.costUsd === "number") {
              spendRef.value += normalized.costUsd;
            }
          } catch {
            rawText += line + "\n";
          }
        }
      });

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        appendLog({ type: "stderr", cycleId: cycle.id, data: text });
        stderrText += text;
      });

      proc.on("close", (code) => {
        devServerProcs.forEach((p) => killProc(p));
        clearTimeout(resultGraceTimer);

        // OpenCode-only path (Claude already logged model-info synchronously
        // above, from the stream). Fire-and-forget — never block cycle
        // resolution on this; it's best-effort telemetry, not load-bearing.
        if (!modelLogged && cycleSessionId && adapter.resolveModelInfo) {
          const resolved = adapter.resolveModelInfo(cycleSessionId, { cwd: ROOT });
          if (resolved) {
            appendLog({
              type: "harness",
              event: "model-info",
              cycleId: cycle.id,
              provider: resolved.provider,
              model: resolved.model,
            });
          }
        }

        if (turnCapKilled) return;
        // stderrText is last resort: a hard provider failure can happen before
        // any JSON streaming starts at all (confirmed live — OpenCode printed
        // a plain-text "No payment method" straight to stderr with zero bytes
        // on stdout, exit code 0). Without this, finalMessage/lastAssistantText/
        // rawText are all empty, classifySignal sees "" + code 0 and reports a
        // false COMPLETE instead of the real failure.
        const effectiveMessage = finalMessage || lastAssistantText || rawText || stderrText;
        const signal = detectSignal(effectiveMessage, code);
        const effectiveTurnCount = realTurnCount || liveTurnCount || turnCount;
        let resolvedMessage = effectiveMessage;

        if (signal === CYCLE_SIGNAL.COMPLETE && effectiveTurnCount === 0 && cycle.outputFile) {
          if (!existsSync(join(CYCLE_DIR, cycle.outputFile))) {
            appendLog({ type: "harness", event: "0-turn-silent-failure", cycleId: cycle.id });
            logger.info(
              `  [WARN] ${cycle.id} claimed complete with 0 turns and no output file — treating as partial`,
            );
            resolvedMessage = `CYCLE_PARTIAL:0-turn cycle wrote no output (${cycle.outputFile}) — silent failure`;
            resolveOnce({ signal: CYCLE_SIGNAL.PARTIAL, code, turnCount: effectiveTurnCount, finalMessage: resolvedMessage });
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
    logger.info(`  Parallel: ${ids} ($${perCycleBudget.toFixed(2)} each)`);

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
        result: { signal: CYCLE_SIGNAL.ERROR, error: s.reason?.message, turnCount: 0, finalMessage: "" },
      };
    });
  }

  return { runCycle, runCycleBatch, getEffectiveMaxRetries: (cycle, reason, signal, rawMessage) =>
    getEffectiveMaxRetries(cycle, reason, signal, rawMessage, { CYCLE_DIR }) };
}

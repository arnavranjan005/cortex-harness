import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { claudeAdapter } from "../../engine/cli-adapters/claude-adapter.mjs";
import { normalizeAdapterOutput, diagnoseProviderFailure } from "../../engine/cli-adapters/output-normalize.mjs";
import { parseLenientJson } from "../../engine/cli-adapters/lenient-json.mjs";
import { logger } from "../../logger.mjs";

/**
 * @typedef {object} ChainDecision
 * @property {string|null} task - the next run's task string, or null if no chain is needed
 * @property {boolean} failed - true if the LLM call itself never produced a real
 *   decision (timeout, spawn error, billing/session-limit, unparseable output).
 *   `task: null, failed: false` means the LLM looked at the delivery and
 *   legitimately decided there's nothing actionable — `failed: true` means we
 *   never got an answer at all, and callers must NOT treat that the same as a
 *   clean delivery (confirmed live: a billing failure was previously reported
 *   to the user as "No actionable residual risks — nothing to chain", which is
 *   not what happened).
 */

// Passes the full delivery markdown to the LLM. Returns a ChainDecision —
// callers must check `failed` before treating `task: null` as "nothing to chain".
export async function buildChainTask(markdown, { pkgRoot, adapter = claudeAdapter }) {
  const prompt = `You are deciding whether an automated software delivery requires a follow-up run.

Read the full delivery summary below. Decide if there are residual risks that a follow-up code change in the local codebase can resolve.

Return ONLY a raw JSON object (no markdown fences, no explanation):
{ "chain": true, "task": "<task description for the next run>" }
OR
{ "chain": false, "task": null }

Set chain=true only when ALL of the following are true for at least one risk:
- It requires a code change that can be made locally.
- It is NOT described as pre-existing.
- It does NOT contain or imply HUMAN_APPROVAL_REQUIRED.
- It does NOT require external credentials, production/staging access, or environment variables unavailable locally.

When chain=true, the task string must:
- Describe exactly what to fix with enough detail for an agent to act without reading this delivery.
- Reference specific files, functions, or behaviors where known.
- NOT reference commands that have not been verified to exist in the codebase.

--- Full delivery summary ---
${markdown.trim()}
--- End ---`;

  const tmpDir = path.join(pkgRoot, ".tmp-extract");
  fs.mkdirSync(tmpDir, { recursive: true });

  let rawStdout = "";
  let rawStderr = "";
  let normalizedOutput = "";
  try {
    const isWindows = process.platform === "win32";
    const promptFile = path.join(tmpDir, "chain-task-prompt.txt");
    fs.writeFileSync(promptFile, prompt, "utf8");
    const spawnPlan = adapter.buildSummarySpawnPlan({
      prompt, budgetUsd: 0.20, promptFile, isWindows, maxTurns: 1,
    });

    rawStdout = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let proc;

      if (isWindows) {
        const psFile = path.join(tmpDir, "chain-task.ps1");
        fs.writeFileSync(psFile, spawnPlan.psContent, "utf8");
        proc = spawn(
          spawnPlan.command,
          spawnPlan.args.map((a) => (a === "__PS_FILE__" ? psFile : a)),
          { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        proc = spawn(spawnPlan.command, spawnPlan.args, { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] });
      }

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("LLM chain-task build timed out"));
      }, 60000);
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", () => { clearTimeout(timer); rawStderr = stderr; resolve(stdout); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    normalizedOutput = normalizeAdapterOutput(adapter, rawStdout, spawnPlan.outputFormat);

    // A hard provider failure (billing, session/weekly limit) often leaves stdout
    // empty or non-JSON, which the generic catch below would only report as a
    // vague "unparseable" — check for these specific, actionable causes first.
    const failure = diagnoseProviderFailure(adapter, { rawStdout, rawStderr, outputFormat: spawnPlan.outputFormat });
    if (failure?.type === "billing") {
      const billingUrl = failure.message.match(/https:\/\/\S+/)?.[0];
      logger.warn(chalk.red("  [BILLING] LLM chain-task build failed — provider rejected the call for lack of a payment method."));
      if (billingUrl) logger.warn(chalk.yellow(`  Add one here: ${billingUrl}`));
      logger.info(chalk.dim("  [chain-decision] → skipped (billing error)"));
      return { task: null, failed: true };
    }
    if (failure?.type === "session-limit") {
      logger.warn(chalk.red("  [SESSION LIMIT] LLM chain-task build failed — usage limit reached."));
      logger.info(chalk.dim("  [chain-decision] → skipped (session limit)"));
      return { task: null, failed: true };
    }
  } catch (err) {
    logger.warn(chalk.yellow(`  [warn] LLM chain-task build failed: ${err.message}. Could not determine whether to chain.`));
    return { task: null, failed: true };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const { model } = resolveModelUsed(adapter, rawStdout, pkgRoot);
  const modelLabel = model ? `${adapter.name}/${model}` : `${adapter.name} (model unknown)`;

  const cleaned = normalizedOutput
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    const parsed = parseLenientJson(cleaned);
    // A failed/empty LLM call can still leave `cleaned` holding some unrelated
    // single-line JSON (e.g. one raw stream event) that parses without error
    // but was never the model's actual {chain, task} decision — confirmed live
    // via a billing failure that produced exactly this: a parseable object with
    // no "chain" key, silently read as chain=false. Require the key to exist.
    if (!("chain" in parsed)) {
      throw new Error("parsed JSON has no \"chain\" key — not a real decision response");
    }
    const chain = !!parsed.chain && typeof parsed.task === "string" && !!parsed.task.trim();
    const task = chain ? parsed.task.trim() : null;
    logger.info(chalk.dim(`  [chain-decision] ${modelLabel} → chain=${chain}`));
    return { task, failed: false };
  } catch (err) {
    logger.warn(chalk.yellow(`  [warn] LLM chain-task build produced no usable decision (${err.message}). Could not determine whether to chain.`));
    logger.warn(chalk.dim(`  Raw: ${normalizedOutput.slice(0, 300) || "(empty)"}`));
    logger.info(chalk.dim(`  [chain-decision] ${modelLabel} → unparseable`));
    return { task: null, failed: true };
  }
}

// Best-effort, never throws: Claude carries its model in the stream itself
// (system/init event — see claude-adapter's "model_info" kind); OpenCode
// doesn't, so its sessionID (present on every event) is used for a post-hoc
// `opencode export <sessionID>` lookup via resolveModelInfo.
function resolveModelUsed(adapter, rawStdout, pkgRoot) {
  if (!adapter.parseEventLine) return { model: null };
  let sessionID = null;
  for (const line of rawStdout.split("\n").filter(Boolean)) {
    const event = adapter.parseEventLine(line);
    if (!event) continue;
    const normalized = adapter.extractResult(event);
    if (normalized?.kind === "model_info" && normalized.model) return { model: normalized.model };
    if (!sessionID && normalized?.sessionID) sessionID = normalized.sessionID;
  }
  if (sessionID && adapter.resolveModelInfo) {
    const resolved = adapter.resolveModelInfo(sessionID, { cwd: pkgRoot });
    if (resolved?.model) return { model: resolved.model };
  }
  return { model: null };
}

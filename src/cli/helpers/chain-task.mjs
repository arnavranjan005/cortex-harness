import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { CLAUDE_EXE } from "../../engine/claude-exe.mjs";

// Passes the full delivery markdown to the LLM. Returns the next task string
// if chaining is needed, or null if the delivery is clean / all risks are
// non-actionable (pre-existing, HUMAN_APPROVAL_REQUIRED, needs production creds).
export async function buildChainTask(markdown, { pkgRoot }) {
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

  let rawOutput = "";
  try {
    rawOutput = await new Promise((resolve, reject) => {
      let stdout = "";
      let proc;

      if (process.platform === "win32") {
        const promptFile = path.join(tmpDir, "chain-task-prompt.txt");
        const psFile = path.join(tmpDir, "chain-task.ps1");
        fs.writeFileSync(promptFile, prompt, "utf8");
        fs.writeFileSync(
          psFile,
          `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --output-format text --max-turns 1 --max-budget-usd 0.20 --dangerously-skip-permissions\n`,
          "utf8",
        );
        proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
          { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        proc = spawn(
          "claude",
          ["-p", prompt, "--output-format", "text", "--max-turns", "1",
            "--max-budget-usd", "0.20", "--dangerously-skip-permissions"],
          { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      }

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("LLM chain-task build timed out"));
      }, 60000);
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("close", () => { clearTimeout(timer); resolve(stdout); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } catch (err) {
    console.warn(chalk.yellow(`  [warn] LLM chain-task build failed: ${err.message}. Treating as no chain needed.`));
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const cleaned = rawOutput
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.chain || typeof parsed.task !== "string" || !parsed.task.trim()) return null;
    return parsed.task.trim();
  } catch {
    console.warn(chalk.yellow("  [warn] LLM returned non-JSON for chain-task build. Treating as no chain needed."));
    console.warn(chalk.dim(`  Raw: ${rawOutput.slice(0, 300)}`));
    return null;
  }
}

import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";

export async function clearHarnessState(cwd) {
  const harnessDir = path.join(cwd, ".harness");
  const queueFile = path.join(harnessDir, "task-queue.json");
  const sessionFile = path.join(harnessDir, "session.json");
  const cycleDir = path.join(harnessDir, "cycle-state");

  if (await fs.pathExists(queueFile)) await fs.remove(queueFile);
  if (await fs.pathExists(sessionFile)) await fs.remove(sessionFile);
  if (await fs.pathExists(cycleDir)) {
    const entries = await fs.readdir(cycleDir);
    for (const entry of entries) await fs.remove(path.join(cycleDir, entry));
  }
}

export async function readRunEndSpend(runsDir) {
  if (!(await fs.pathExists(runsDir))) return 0;
  const files = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files.length) return 0;
  try {
    const lines = (await fs.readFile(path.join(runsDir, files[0]), "utf8"))
      .split("\n")
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (
          ev.type === "harness" &&
          ev.event === "run-end" &&
          ev.totalSpentUsd !== undefined
        ) {
          return Number(ev.totalSpentUsd) || 0;
        }
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* file unreadable */
  }
  return 0;
}

// pkgRoot is the cortex-harness package root (parent of bin/ and src/).
export function spawnRun(task, cwd, pkgRoot) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath, task], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

// Spawn the engine with no task arg — resumes an existing queue in-place
export function spawnResumedRun(cwd, pkgRoot) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

// Collect human answers for blocked cycles and mark them pending.
// Does NOT spawn the engine — caller decides what to do next.
// Returns: "answered" | "session-limit-only" | "nothing-blocked"
export async function resumeBlockedCycles(cwd) {
  const queueFile = path.join(cwd, ".harness", "task-queue.json");
  if (!fs.existsSync(queueFile)) return "nothing-blocked";

  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  } catch {
    return "nothing-blocked";
  }

  const blocked = (queue.cycles ?? []).filter((c) => c.status === "blocked");
  const needsInput = blocked.filter(
    (c) => c.blockedType === "needs-human-input",
  );
  const sessionLimit = blocked.filter((c) => c.blockedType === "session-limit");

  if (!blocked.length) return "nothing-blocked";

  if (!needsInput.length) {
    for (const c of blocked) {
      c.status = "pending";
      delete c.blockedType;
      delete c.blockedReason;
      delete c.blockedAt;
    }
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");
    console.log(
      chalk.dim(`  Marked ${blocked.length} session-limit cycle(s) for retry.`),
    );
    return "session-limit-only";
  }

  const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
  const SEP = chalk.dim("─".repeat(TERM_WIDTH - 2));

  console.log(
    "\n" +
      chalk.bold.cyan(
        `  ${needsInput.length} cycle${needsInput.length > 1 ? "s" : ""} waiting for your input\n`,
      ),
  );

  const cycleAnswerDir = path.join(cwd, ".harness", "cycle-state");
  const answersFile = path.join(cycleAnswerDir, "human-answers.json");
  const decisions = [];

  for (let i = 0; i < needsInput.length; i++) {
    const c = needsInput[i];
    console.log(SEP);
    console.log(
      `\n  ${chalk.bold(`[${i + 1}/${needsInput.length}]`)} ${chalk.cyan(c.id)}  ${chalk.dim(`(${c.type})`)}\n`,
    );

    let questionText = c.blockedReason ?? "";
    if (questionText.length < 350 && c.outputFile) {
      try {
        const cycleStatePath = path.join(
          cwd,
          ".harness",
          "cycle-state",
          c.outputFile,
        );
        const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
        const gaps = data.outOfScopeGaps ?? [];
        if (gaps.length) {
          const gapLines = gaps.map((g) => {
            if (typeof g === "string") return `• ${g}`;
            const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
            if (g.reason) parts.push(`  ${g.reason}`);
            if (g.proposedModel)
              parts.push(
                `  Proposed:\n${g.proposedModel
                  .split("\n")
                  .map((l) => "    " + l)
                  .join("\n")}`,
              );
            return parts.join("\n");
          });
          const suffix = "\n\nBlocking gaps:\n" + gapLines.join("\n\n");
          questionText = questionText ? questionText + suffix : suffix.trim();
        }
      } catch {
        /* use blockedReason as-is */
      }
    }

    if (questionText) {
      const indent = "  ";
      const maxLen = TERM_WIDTH - indent.length;
      for (const line of questionText.split("\n")) {
        if (line.trim() === "") {
          console.log();
          continue;
        }
        const words = line.split(" ");
        let current = "";
        for (const word of words) {
          if (!current) {
            current = word;
            continue;
          }
          if (current.length + 1 + word.length <= maxLen) current += " " + word;
          else {
            console.log(indent + current);
            current = word;
          }
        }
        if (current) console.log(indent + current);
      }
    } else {
      console.log(chalk.dim("  (no question text recorded)"));
    }

    console.log();
    const rl = createInterface({ input, output });
    let userAnswer = "";
    try {
      userAnswer = (await rl.question(chalk.bold("  Your answer: "))).trim();
    } finally {
      rl.close();
    }
    console.log();

    decisions.push({
      cycleId: c.id,
      questions: questionText ? [{ text: questionText }] : [],
      answer: userAnswer,
    });
  }

  fs.mkdirSync(cycleAnswerDir, { recursive: true });
  const existing = fs.existsSync(answersFile)
    ? JSON.parse(fs.readFileSync(answersFile, "utf8"))
    : [];
  existing.push({
    answeredAt: new Date().toISOString(),
    resolvedCycles: needsInput.map((c) => c.id),
    decisions,
  });
  for (const c of blocked) {
    c.status = "pending";
    delete c.blockedType;
    delete c.blockedReason;
    delete c.blockedAt;
  }
  fs.writeFileSync(answersFile, JSON.stringify(existing, null, 2), "utf8");
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

  console.log(
    chalk.green(`  Answers saved for ${needsInput.length} cycle(s).`),
  );
  console.log(chalk.dim(`  Marked ${blocked.length} cycle(s) for retry.`));
  if (sessionLimit.length) {
    console.log(
      chalk.yellow(
        `\n  ${sessionLimit.length} session-limit cycle(s) will also retry — no answer needed.`,
      ),
    );
  }

  return "answered";
}

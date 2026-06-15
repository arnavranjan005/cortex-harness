import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { text } from "../ui.mjs";

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
  const needsInput = blocked.filter((c) => c.blockedType === "needs-human-input");
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
    console.log(chalk.dim(`  Marked ${blocked.length} session-limit cycle(s) for retry.`));
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
  const preconditionFailed = []; // cycles whose preconditions are not yet met

  for (let i = 0; i < needsInput.length; i++) {
    const c = needsInput[i];
    console.log(SEP);
    console.log(
      `\n  ${chalk.bold(`[${i + 1}/${needsInput.length}]`)} ${chalk.cyan(c.id)}  ${chalk.dim(`(${c.type})`)}\n`,
    );

    // Auth-block precondition check — validate smoke-auth.json exists before re-queuing.
    // Doing this here (not in the smoke cycle) avoids burning a full Claude cycle just
    // to re-detect the same missing file.
    if (c.outputFile) {
      try {
        const cycleStatePath = path.join(cwd, ".harness", "cycle-state", c.outputFile);
        const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
        if (data.authIssue) {
          const missingProfiles = data.missingProfiles ?? [];
          const staleProfiles = data.staleProfiles ?? [];

          if (data.authIssue === "stale") {
            // Stale = session expired. Auto-validate by checking mtime — if the auth file was
            // written after the cycle was blocked, the user has already re-run auth.
            const blockedAt = c.blockedAt ? new Date(c.blockedAt).getTime() : 0;
            const stillStale = staleProfiles.filter(name => {
              const file = path.join(cwd, ".harness", `smoke-auth-${name}.json`);
              try { return fs.statSync(file).mtimeMs <= blockedAt; } catch { return true; }
            });

            if (stillStale.length > 0) {
              console.log(chalk.yellow(`  ⚠ Auth session expired for profile(s): ${stillStale.join(", ")}`));
              for (const name of stillStale) {
                console.log(chalk.cyan(`    cortex-harness auth --profile ${name}`));
              }
              console.log(chalk.dim("  Re-run the command(s) above, then run `cortex-harness resume` again."));
              preconditionFailed.push(c);
              continue;
            }

            console.log(chalk.green(`  ✓ Auth profiles refreshed (${staleProfiles.join(", ")}) — re-queuing.`));
            decisions.push({ cycleId: c.id, questions: [], answer: "auth-state-ready" });
            continue;
          }

          // authIssue === "missing": validate by file existence
          const isSingleProfile = missingProfiles.length === 0;

          if (isSingleProfile) {
            const authFile = path.join(cwd, ".harness", "smoke-auth.json");
            if (!fs.existsSync(authFile)) {
              console.log(chalk.red("  ✗ smoke-auth.json not found."));
              console.log(chalk.yellow(`  Run ${chalk.bold("cortex-harness auth")} first, then run resume again.`));
              preconditionFailed.push(c);
              continue;
            }
            console.log(chalk.green("  ✓ smoke-auth.json found — re-queuing."));
            decisions.push({ cycleId: c.id, questions: [], answer: "auth-state-ready" });
            continue;
          }

          const stillMissing = missingProfiles.filter(name => {
            const file = path.join(cwd, ".harness", `smoke-auth-${name}.json`);
            return !fs.existsSync(file);
          });

          if (stillMissing.length > 0) {
            console.log(chalk.red(`  ✗ Missing auth state for: ${stillMissing.join(", ")}`));
            for (const name of stillMissing) {
              console.log(chalk.yellow(`  Run ${chalk.bold(`cortex-harness auth --profile ${name}`)}`));
            }
            console.log(chalk.yellow("  Then run `cortex-harness resume` again."));
            preconditionFailed.push(c);
            continue;
          }

          console.log(chalk.green(`  ✓ All auth profiles present (${missingProfiles.join(", ")}) — re-queuing.`));
          decisions.push({ cycleId: c.id, questions: [], answer: "auth-state-ready" });
          continue;
        }
      } catch { /* output file missing or unreadable — fall through to normal flow */ }
    }

    let questionText = c.blockedReason ?? "";
    if (questionText.length < 350 && c.outputFile) {
      try {
        const cycleStatePath = path.join(cwd, ".harness", "cycle-state", c.outputFile);
        const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
        const gaps = data.outOfScopeGaps ?? [];
        if (gaps.length) {
          const gapLines = gaps.map((g) => {
            if (typeof g === "string") return `• ${g}`;
            const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
            if (g.reason) parts.push(`  ${g.reason}`);
            if (g.proposedModel)
              parts.push(
                `  Proposed:\n${g.proposedModel.split("\n").map((l) => "    " + l).join("\n")}`,
              );
            return parts.join("\n");
          });
          const suffix = "\n\nBlocking gaps:\n" + gapLines.join("\n\n");
          questionText = questionText ? questionText + suffix : suffix.trim();
        }
      } catch { /* use blockedReason as-is */ }
    }

    if (questionText) {
      const indent = "  ";
      const maxLen = TERM_WIDTH - indent.length;
      for (const line of questionText.split("\n")) {
        if (line.trim() === "") { console.log(); continue; }
        const words = line.split(" ");
        let current = "";
        for (const word of words) {
          if (!current) { current = word; continue; }
          if (current.length + 1 + word.length <= maxLen) current += " " + word;
          else { console.log(indent + current); current = word; }
        }
        if (current) console.log(indent + current);
      }
    } else {
      console.log(chalk.dim("  (no question text recorded)"));
    }

    console.log();
    const answer = await text({
      message: "Your answer",
      placeholder: "Type your response, then Enter",
    });
    const userAnswer = (answer ?? "").trim();
    console.log();

    decisions.push({
      cycleId: c.id,
      questions: questionText ? [{ text: questionText }] : [],
      answer: userAnswer,
    });
  }

  // Cycles that can be re-queued (answered + auth-ready, excluding precondition failures)
  const readyToResume = [...needsInput, ...sessionLimit].filter(
    (c) => !preconditionFailed.includes(c),
  );

  if (!readyToResume.length && preconditionFailed.length) {
    console.log(SEP);
    console.log(chalk.yellow(`\n  ${preconditionFailed.length} cycle(s) still blocked — preconditions not met.`));
    console.log(chalk.dim("  Resolve the issues above, then run `cortex-harness resume` again."));
    return "nothing-blocked"; // caller will not start the run
  }

  fs.mkdirSync(cycleAnswerDir, { recursive: true });
  const existing = fs.existsSync(answersFile)
    ? JSON.parse(fs.readFileSync(answersFile, "utf8"))
    : [];
  existing.push({
    answeredAt: new Date().toISOString(),
    resolvedCycles: readyToResume.map((c) => c.id),
    decisions,
  });
  for (const c of readyToResume) {
    c.status = "pending";
    delete c.blockedType;
    delete c.blockedReason;
    delete c.blockedAt;
  }
  fs.writeFileSync(answersFile, JSON.stringify(existing, null, 2), "utf8");
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

  const resumedCount = readyToResume.length;
  console.log(chalk.green(`  Answers saved. Marked ${resumedCount} cycle(s) for retry.`));
  if (preconditionFailed.length) {
    console.log(chalk.yellow("  " + preconditionFailed.length + " cycle(s) still blocked — run `cortex-harness resume` again after resolving."));
  }
  if (sessionLimit.length && readyToResume.some((c) => c.blockedType === "session-limit")) {
    console.log(
      chalk.yellow(`\n  Session-limit cycle(s) will also retry — no answer needed.`),
    );
  }

  return "answered";
}

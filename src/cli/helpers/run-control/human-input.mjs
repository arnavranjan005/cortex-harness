import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { text } from "../ui.mjs";
import { logger } from "../../../logger.mjs";

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
  const allNeedsInput = blocked.filter((c) => c.blockedType === "needs-human-input");
  const sessionLimit = blocked.filter((c) => c.blockedType === "session-limit");

  if (!blocked.length) return "nothing-blocked";

  // Matches the exact phrasing buildAuthBlockMessage() / the provider-outage
  // message produce in smoke-orchestrator.mjs — kept as a fallback since
  // blockedReason lives in task-queue.json itself (always present) whereas
  // the cycle-state output file can be absent by resume time (cleared by a
  // later retry, etc).
  const AUTH_BLOCK_PATTERN = /^(Auth session expired for:|Auth state missing for profiles:|Pages require login but no auth state found\.)/;
  const PROVIDER_OUTAGE_PATTERN = /^Smoke check got no output from the CLI provider on/;

  // Auth-blocked and provider-outage smoke cycles never get a Q&A prompt —
  // there's no useful text answer for either ("logged in" / "provider's back
  // up" aren't decisions, they're external state) — just re-run the smoke
  // check live instead of guessing from filenames/mtimes whether it's fixed.
  // The smoke cycle itself re-validates the real state far more reliably
  // than any precondition check could from outside it.
  const autoRetryBlocked = allNeedsInput.filter((c) => {
    if (c.outputFile) {
      try {
        const cycleStatePath = path.join(cwd, ".harness", "cycle-state", c.outputFile);
        const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
        if (data.authIssue) return true;
      } catch { /* file missing/unreadable — fall through to blockedReason check */ }
    }
    const reason = c.blockedReason ?? "";
    return AUTH_BLOCK_PATTERN.test(reason) || PROVIDER_OUTAGE_PATTERN.test(reason);
  });
  const needsInput = allNeedsInput.filter((c) => !autoRetryBlocked.includes(c));

  if (!needsInput.length) {
    for (const c of blocked) {
      c.status = "pending";
      delete c.blockedType;
      delete c.blockedReason;
      delete c.blockedAt;
    }
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");
    logger.info(chalk.dim(`  Marked ${blocked.length} cycle(s) for retry (session-limit / auth re-check).`));
    return "session-limit-only";
  }

  const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
  const SEP = chalk.dim("─".repeat(TERM_WIDTH - 2));

  logger.info(
    "\n" +
      chalk.bold.cyan(
        `  ${needsInput.length} cycle${needsInput.length > 1 ? "s" : ""} waiting for your input\n`,
      ),
  );

  const cycleAnswerDir = path.join(cwd, ".harness", "cycle-state");
  const answersFile = path.join(cycleAnswerDir, "human-answers.json");
  const decisions = [];

  if (autoRetryBlocked.length) {
    logger.info(chalk.dim(`  ${autoRetryBlocked.length} auth/provider-blocked smoke cycle(s) will re-run live — no input needed.`));
    for (const c of autoRetryBlocked) {
      const answer = PROVIDER_OUTAGE_PATTERN.test(c.blockedReason ?? "") ? "provider-retry" : "auth-retry";
      decisions.push({ cycleId: c.id, questions: [], answer });
    }
  }

  for (let i = 0; i < needsInput.length; i++) {
    const c = needsInput[i];
    logger.info(SEP);
    logger.info(
      `\n  ${chalk.bold(`[${i + 1}/${needsInput.length}]`)} ${chalk.cyan(c.id)}  ${chalk.dim(`(${c.type})`)}\n`,
    );

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
        if (line.trim() === "") { logger.info(); continue; }
        const words = line.split(" ");
        let current = "";
        for (const word of words) {
          if (!current) { current = word; continue; }
          if (current.length + 1 + word.length <= maxLen) current += " " + word;
          else { logger.info(indent + current); current = word; }
        }
        if (current) logger.info(indent + current);
      }
    } else {
      logger.info(chalk.dim("  (no question text recorded)"));
    }

    logger.info();
    const answer = await text({
      message: "Your answer",
      placeholder: "Type your response, then Enter",
    });
    const userAnswer = (answer ?? "").trim();
    logger.info();

    decisions.push({
      cycleId: c.id,
      questions: questionText ? [{ text: questionText }] : [],
      answer: userAnswer,
    });
  }

  // Cycles that can be re-queued: answered questions, session-limit retries, and
  // auth/provider-outage-blocked smoke cycles (always re-run live, no precondition gate).
  const readyToResume = [...needsInput, ...sessionLimit, ...autoRetryBlocked];

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
  logger.info(chalk.green(`  Answers saved. Marked ${resumedCount} cycle(s) for retry.`));
  if (sessionLimit.length) {
    logger.info(chalk.yellow(`\n  Session-limit cycle(s) will also retry — no answer needed.`));
  }
  if (autoRetryBlocked.length) {
    logger.info(chalk.yellow(`  Auth/provider-blocked smoke cycle(s) will re-run live — no answer needed.`));
  }

  return "answered";
}

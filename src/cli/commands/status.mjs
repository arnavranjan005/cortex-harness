import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { logger } from "../../logger.mjs";

export function registerStatusCommand(program) {
  program
    .command("status")
    .description(
      "Show the current run status — blocked questions, pending cycles, progress",
    )
    .action(async () => {
      const queuePath = path.join(process.cwd(), ".harness", "task-queue.json");
      if (!(await fs.pathExists(queuePath))) {
        logger.info(
          chalk.dim("  No active run found (task-queue.json missing)."),
        );
        logger.info(
          chalk.dim('  Start one with: cortex-harness run "your task"'),
        );
        return;
      }

      let queue;
      try {
        queue = await fs.readJson(queuePath);
      } catch {
        logger.info(
          chalk.red("  task-queue.json exists but could not be parsed."),
        );
        return;
      }

      // Build a map of cycleId → full finalMessage from the most recent run log.
      // Used to recover full question text when blockedReason was saved with the
      // old 300-char truncation.
      const fullMessages = {};
      const runsDir = path.join(process.cwd(), ".harness", "runs");
      if (await fs.pathExists(runsDir)) {
        const logs = (await fs.readdir(runsDir))
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .reverse(); // most recent first
        if (logs.length) {
          try {
            const lines = (await fs.readFile(path.join(runsDir, logs[0]), "utf8"))
              .split("\n")
              .filter(Boolean);
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === "cycle-result" && ev.cycleId && ev.finalMessage) {
                  // Keep only the last result per cycleId (latest attempt)
                  fullMessages[ev.cycleId] = ev.finalMessage;
                }
              } catch {
                /* skip malformed lines */
              }
            }
          } catch {
            /* log unreadable — skip */
          }
        }
      }

      // Return the best available question text for a blocked cycle.
      // Priority: run-log finalMessage > stored blockedReason + cycle output file gaps.
      function getQuestionText(c) {
        const stored = c.blockedReason ?? "";

        // 1. Run log — use NEEDS_HUMAN_INPUT-extracted text if present and non-empty
        if (fullMessages[c.id]) {
          const full = fullMessages[c.id];
          const nhiIdx = full.indexOf("NEEDS_HUMAN_INPUT");
          const extracted =
            nhiIdx !== -1
              ? full
                  .slice(nhiIdx + "NEEDS_HUMAN_INPUT".length)
                  .replace(/^[:\s–-]+/, "")
                  .trim()
              : "";
          if (extracted) return extracted;
          // extraction was empty (keyword absent) — fall through to augment with cycle state
        }

        // 2. Append outOfScopeGaps from cycle output file only when stored text looks truncated
        // (legacy runs had a 300-char hard cap; skip gaps if stored is clearly full text)
        const TRUNCATION_THRESHOLD = 350;
        if (c.outputFile && stored.length < TRUNCATION_THRESHOLD) {
          try {
            const cycleStatePath = path.join(
              process.cwd(),
              ".harness",
              "cycle-state",
              c.outputFile,
            );
            const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
            const gaps = data.outOfScopeGaps ?? [];
            if (gaps.length) {
              const lines = gaps.map((g) => {
                if (typeof g === "string") return `• ${g}`;
                const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
                if (g.reason) parts.push(`  ${g.reason}`);
                if (g.proposedModel)
                  parts.push(`  Proposed model: ${g.proposedModel}`);
                return parts.join("\n");
              });
              const suffix = "\n\nBlocking gaps:\n" + lines.join("\n\n");
              return stored ? stored + suffix : suffix.trim();
            }
          } catch {
            /* output file missing or unparseable — fall through */
          }
        }

        return stored;
      }

      // Word-wrap a string to fit within `width` columns, indented by `indent` spaces.
      const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
      function wrap(text, indent = 2) {
        const prefix = " ".repeat(indent);
        const maxLen = TERM_WIDTH - indent;
        const words = String(text ?? "").split(" ");
        const lines = [];
        let current = "";
        for (const word of words) {
          if (!current) {
            current = word;
            continue;
          }
          if (current.length + 1 + word.length <= maxLen) {
            current += " " + word;
          } else {
            lines.push(prefix + current);
            current = word;
          }
        }
        if (current) lines.push(prefix + current);
        return lines.join("\n");
      }

      // Print a multi-line block, respecting existing newlines and wrapping long lines.
      function printWrapped(text, indent = 2) {
        for (const para of String(text ?? "").split("\n")) {
          if (para.trim() === "") {
            logger.info();
            continue;
          }
          logger.info(wrap(para, indent));
        }
      }

      const cycles = queue.cycles ?? [];
      const done = cycles.filter((c) => c.status === "done");
      const pending = cycles.filter((c) => c.status === "pending");
      const partial = cycles.filter((c) => c.status === "partial");
      const blocked = cycles.filter((c) => c.status === "blocked");
      const needsInput = blocked.filter(
        (c) => c.blockedType === "needs-human-input",
      );
      const limitHit = blocked.filter((c) => c.blockedType === "session-limit");

      const taskDisplay =
        (queue.task ?? "(unknown)").length > 100
          ? (queue.task ?? "").slice(0, 100) + "…"
          : (queue.task ?? "(unknown)");

      logger.info(
        `\n${chalk.bold.blue("━━━ Harness Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`,
      );
      logger.info(`${chalk.dim("Task   :")} ${taskDisplay}`);
      logger.info(`${chalk.dim("Type   :")} ${queue.promptType ?? "(unknown)"}`);
      logger.info(
        `${chalk.dim("Queue  :")} ${chalk.green(done.length + " done")}  ` +
          `${chalk.yellow(pending.length + " pending")}  ` +
          `${chalk.yellow(partial.length + " partial")}  ` +
          `${chalk.red(blocked.length + " blocked")}`,
      );

      // ── Blocked: needs human input ──────────────────────────────────────────
      if (needsInput.length) {
        logger.info(`\n${chalk.red.bold("  Waiting for your input:")}`);
        for (const c of needsInput) {
          logger.info(`\n  ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`);
          logger.info(
            chalk.dim("  ─────────────────────────────────────────────"),
          );
          const questionText = getQuestionText(c);
          if (questionText) {
            printWrapped(questionText, 2);
          } else {
            logger.info(chalk.dim("  (no question text recorded)"));
          }
          logger.info(
            chalk.dim("  ─────────────────────────────────────────────"),
          );
        }
        logger.info(chalk.yellow(`\n  Answer: cortex-harness resume`));
      }

      // ── Blocked: session/weekly limit ───────────────────────────────────────
      if (limitHit.length) {
        logger.info(`\n${chalk.red("  Usage limit hit:")}`);
        for (const c of limitHit) {
          const reason = c.blockedReason ?? "unknown — check your Claude plan";
          logger.info(`  ${chalk.cyan(c.id)}`);
          logger.info(wrap(reason, 4));
        }
        logger.info(
          chalk.dim("\n  Resume after the limit resets: cortex-harness resume"),
        );
      }

      // ── Partial ─────────────────────────────────────────────────────────────
      if (partial.length) {
        logger.info(`\n${chalk.yellow("  Partial cycles (incomplete):")}`);
        for (const c of partial) {
          logger.info(`  ${chalk.cyan(c.id)}`);
          if (c.partialReason) logger.info(wrap(c.partialReason, 4));
        }
      }

      // ── Pending ─────────────────────────────────────────────────────────────
      if (pending.length) {
        logger.info(`\n${chalk.dim("  Pending:")}`);
        for (const c of pending) {
          const group = c.taskGroup ? chalk.dim(` [${c.taskGroup}]`) : "";
          logger.info(`  ${chalk.dim("·")} ${chalk.cyan(c.id)}${group}`);
        }
      }

      if (!blocked.length && !pending.length && !partial.length) {
        logger.info(chalk.green("\n  All cycles complete. Run is finished."));
      }

      logger.info();
    });
}

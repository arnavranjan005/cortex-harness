import { Option } from "commander";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { logger } from "../../logger.mjs";

export function registerLogsCommand(program) {
  const logsCmd = program
    .command("logs")
    .description("Print events from a .jsonl run log in a readable format")
    .addOption(
      new Option(
        "--run <timestamp>",
        "Specific run timestamp to view (filename without .jsonl)",
      ).default(null),
    );

  logsCmd.action(async (options) => {
    const runsDir = path.join(process.cwd(), ".harness", "runs");

    if (!(await fs.pathExists(runsDir))) {
      logger.info(
        chalk.dim("  No runs directory found (.harness/runs/ missing)."),
      );
      logger.info(
        chalk.dim('  Start a run first: cortex-harness run "your task"'),
      );
      return;
    }

    const runFiles = (await fs.readdir(runsDir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (!runFiles.length) {
      logger.info(chalk.dim("  No run logs found."));
      return;
    }

    let targetFile;
    if (options.run) {
      targetFile = `${options.run}.jsonl`;
      if (!runFiles.includes(targetFile)) {
        logger.info(chalk.red(`  Run "${options.run}" not found.`));
        logger.info(chalk.dim("  Available runs:"));
        for (const f of runFiles.slice(0, 10)) {
          logger.info(chalk.dim(`   ${f.replace(".jsonl", "")}`));
        }
        if (runFiles.length > 10)
          logger.info(chalk.dim(`   ... and ${runFiles.length - 10} more`));
        process.exit(1);
      }
    } else {
      targetFile = runFiles[0];
    }

    const runPath = path.join(runsDir, targetFile);
    const lines = (await fs.readFile(runPath, "utf8"))
      .split("\n")
      .filter(Boolean);

    if (!lines.length) {
      logger.info(chalk.dim("  Run log is empty."));
      return;
    }

    logger.info(
      chalk.bold(
        "\n  Run: ",
        targetFile.replace(".jsonl", ""),
        "  (" + lines.length + " events)",
      ),
    );
    logger.info(
      chalk.dim("  ─────────────────────────────────────────────────────────\n"),
    );

    let count = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        const t = ev.timestamp ?? ev.ts ?? "";
        const ts = t
          ? chalk.dim("[" + t.slice(11, 19) + "] ")
          : chalk.dim("[" + String(count + 1).padStart(5) + "] ");

        if (ev.type === "harness") {
          if (ev.event === "run-start") {
            logger.info(
              ts + chalk.green("▶ RUN START  "),
              chalk.dim("task:"),
              ev.task ?? "",
            );
          } else if (ev.event === "run-end") {
            const summary = [
              ev.done ? chalk.green("✓ done:" + ev.done) : "",
              ev.blocked ? chalk.yellow("⊘ blocked:" + ev.blocked) : "",
              ev.pending ? chalk.blue("○ pending:" + ev.pending) : "",
            ]
              .filter(Boolean)
              .join("  ");
            logger.info(ts + chalk.red("■ RUN END    "), summary);
            if (ev.totalSpentUsd !== undefined) {
              logger.info(
                chalk.dim("              spent: $" + ev.totalSpentUsd.toFixed(2)),
              );
            }
          } else if (ev.event === "fatal") {
            logger.info(ts + chalk.red("✗ FATAL     "), ev.error ?? "");
          } else if (ev.event === "cycle-start") {
            logger.info(
              ts + chalk.blue("→ CYCLE      "),
              chalk.bold(ev.cycleId ?? ""),
              ev.taskGroup ? chalk.dim("(" + ev.taskGroup + ")") : "",
            );
          } else if (ev.event === "cycle-result") {
            const ok = ev.cycles ?? ev.delivered ?? 0;
            const fail = ev.blocked ?? 0;
            logger.info(
              ts + chalk.green("← CYCLE END "),
              chalk.bold(ev.cycleId ?? ""),
              chalk.green(" ✓" + ok),
              fail > 0 ? chalk.red(" ⊘" + fail) : "",
              ev.partial ? chalk.yellow(" ~" + ev.partial) : "",
            );
            if (ev.totalSpentUsd !== undefined) {
              logger.info(
                chalk.dim("              spent: $" + ev.totalSpentUsd.toFixed(2)),
              );
            }
          } else if (ev.event === "rate_limit") {
            logger.info(
              ts + chalk.yellow("⚠ RATE LIMIT"),
              ev.service ?? "",
              ev.resetsAt ? "resets " + ev.resetsAt.slice(11, 16) : "",
            );
          } else {
            logger.info(ts + chalk.dim("harness/" + (ev.event ?? "??")));
          }
        } else if (ev.type === "agent_message" || ev.type === "message") {
          const role = ev.role ?? ev.agent ?? "?";
          const content =
            typeof ev.content === "string"
              ? ev.content
              : JSON.stringify(ev.content ?? "");
          logger.info(
            ts + chalk.cyan("◇ " + role.padEnd(10)),
            chalk.dim(content.slice(0, 120)),
          );
        } else if (ev.type === "tool-call" || ev.type === "tool") {
          logger.info(
            ts + chalk.magenta("⚙ TOOL CALL "),
            ev.tool ?? ev.function ?? "",
          );
        } else if (ev.type === "tool-result" || ev.type === "tool_result") {
          const ok = ev.success !== false;
          const preview =
            typeof ev.result === "string"
              ? ev.result
              : JSON.stringify(ev.result ?? "");
          logger.info(
            ts + (ok ? chalk.green("✓ TOOL OK   ") : chalk.red("✗ TOOL FAIL ")),
            chalk.dim(preview.slice(0, 120)),
          );
        } else if (ev.type === "notification-warning") {
          logger.info(ts + chalk.yellow("⚠ NOTIFY WARN"), ev.warning ?? "");
        } else if (ev.type === "error") {
          logger.info(
            ts + chalk.red("✗ ERROR      "),
            ev.message ?? JSON.stringify(ev),
          );
        } else if (ev.raw) {
          // parse raw Claude SDK stream events for useful info
          try {
            const raw = typeof ev.raw === "string" ? JSON.parse(ev.raw) : ev.raw;
            const rawType = raw.type ?? raw.subtype ?? "raw";
            if (raw.type === "assistant" && raw.message) {
              const msg = raw.message;
              const firstText =
                msg.content?.find((b) => b.type === "text")?.text ?? "";
              const firstTool =
                msg.content?.find((b) => b.type === "tool_use")?.name ?? "";
              const preview = firstText || (firstTool ? "tool:" + firstTool : "");
              logger.info(
                ts + chalk.dim("◇ assistant "),
                chalk.dim(preview.slice(0, 120)),
              );
            } else if (raw.type === "user" && raw.message) {
              const content = raw.message.content;
              const toolResult = Array.isArray(content)
                ? content.find((b) => b.type === "tool_result")
                : null;
              const preview = toolResult
                ? (typeof toolResult.content === "string"
                    ? toolResult.content
                    : JSON.stringify(toolResult.content)
                  ).slice(0, 120)
                : JSON.stringify(content ?? "").slice(0, 120);
              logger.info(ts + chalk.dim("◇ user      "), chalk.dim(preview));
            } else if (raw.type === "system") {
              logger.info(
                ts + chalk.dim("⚙ system    "),
                chalk.dim(
                  (raw.subtype ?? "") +
                    (raw.task_id ? " task:" + raw.task_id : ""),
                ),
              );
            } else if (raw.type === "result") {
              const spent =
                raw.cost_usd !== undefined
                  ? " $" + Number(raw.cost_usd).toFixed(3)
                  : "";
              logger.info(
                ts + chalk.dim("■ result    "),
                chalk.dim((raw.subtype ?? "") + spent),
              );
            } else if (raw.type === "rate_limit_event") {
              logger.info(
                ts + chalk.yellow("⚠ rate limit"),
                chalk.dim(raw.rate_limit_info?.status ?? ""),
              );
            } else {
              logger.info(
                ts + chalk.dim("○ " + rawType.padEnd(10)),
                chalk.dim(JSON.stringify(raw).slice(0, 120)),
              );
            }
          } catch {
            logger.info(
              ts + chalk.dim("○ raw       "),
              chalk.dim(String(ev.raw).slice(0, 120)),
            );
          }
        } else {
          // fallback: show type + key fields
          const summary = Object.entries(ev)
            .filter(([k]) => !["type", "timestamp", "ts"].includes(k))
            .slice(0, 3)
            .map(
              ([k, v]) =>
                k +
                ":" +
                (typeof v === "string" ? v : JSON.stringify(v).slice(0, 60)),
            )
            .join(" | ");
          logger.info(
            ts +
              chalk.dim(
                "? " + (ev.type ?? "unknown") + " | " + summary.slice(0, 120),
              ),
          );
        }
        count++;
      } catch {
        // skip malformed lines
      }
    }

    logger.info(
      chalk.dim(
        "\n  (" +
          count +
          " events from " +
          targetFile.replace(".jsonl", "") +
          ")",
      ),
    );
  });
}

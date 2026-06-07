import fs from "fs-extra";
import path from "path";

export const GITIGNORE_BLOCK_START = "# cortex-harness";
export const GITIGNORE_BLOCK_END = "# /cortex-harness";
export const GITIGNORE_RUNTIME_ENTRIES = [
  ".harness/runs/",
  ".harness/cycle-state/",
  ".harness/output/",
  ".harness/session.json",
  ".harness/task-queue.json",
  ".harness/sessions/",
  ".harness/pre-run-snapshot/",
  ".harness/notification-channels.local.json",
];

export async function patchGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const block =
    `${GITIGNORE_BLOCK_START}\n` +
    GITIGNORE_RUNTIME_ENTRIES.join("\n") +
    `\n${GITIGNORE_BLOCK_END}`;

  if (await fs.pathExists(gitignorePath)) {
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (existing.includes(GITIGNORE_BLOCK_START)) {
      return "present";
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await fs.appendFile(gitignorePath, `${separator}${block}\n`);
    return "appended";
  } else {
    await fs.writeFile(gitignorePath, `${block}\n`);
    return "created";
  }
}

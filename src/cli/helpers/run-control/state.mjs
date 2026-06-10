import fs from "fs-extra";
import path from "path";

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

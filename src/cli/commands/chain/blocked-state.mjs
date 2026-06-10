import fs from "fs-extra";

/**
 * Read the current blocked-cycle state from task-queue.json without throwing.
 * Returns a plain object summarising what kinds of blocks exist.
 *
 * @param {string} queueFile - absolute path to task-queue.json
 * @returns {{ hasAny: boolean, hasHumanInput: boolean, hasSessionLimit: boolean }}
 */
export function readBlockedTypes(queueFile) {
  try {
    const q = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    const blocked = (q.cycles ?? []).filter((c) => c.status === "blocked");
    return {
      hasAny: blocked.length > 0,
      hasHumanInput: blocked.some((c) => c.blockedType === "needs-human-input"),
      hasSessionLimit: blocked.some((c) => c.blockedType === "session-limit"),
    };
  } catch {
    return { hasAny: false, hasHumanInput: false, hasSessionLimit: false };
  }
}

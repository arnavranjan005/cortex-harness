// Hard-coded engine tunables — change here, pick up everywhere.

export const SAFETY_TURN_CAP = 500;
export const MAX_BUDGET_USD = 20;
export const DEAD_MAN_MS = 20 * 60 * 1000; // 20 min silence → cycle is hung
export const MAX_RETRIES = 2;
export const RESULT_GRACE_MS = 15_000;

// Per-cycle turn caps. Only test is capped; others run to natural completion.
export const TURN_CAP = { test: 25 };

// Test cycles with a clean turn-cap partial get up to 10 retries (forward progress in 25-turn slices).
// API rate-limit or error partials fall back to MAX_RETRIES — retrying them more won't help.
export const TEST_MAX_RETRIES_CLEAN = 10;

export const isWindows = process.platform === "win32";

// Cycle types that must always run sequentially (never parallelised).
export const SEQUENTIAL_TYPES = new Set([
  "test",
  "reconcile",
  "deliver",
  "recover",
  "recovery",
  "orchestrate",
]);

export function getTurnCap(cycle) {
  return TURN_CAP[cycle.type] ?? Infinity;
}

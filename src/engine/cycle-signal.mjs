// Single source of truth for cycle-outcome classification. Previously each of
// cycle-runner.mjs/run-autonomous.mjs/smoke-orchestrator.mjs branched on raw
// string literals ("complete", "partial", ...) with the matching rules
// (session-limit wording, CYCLE_PARTIAL: prefix, etc.) duplicated or
// implicit at each call site. This module is the only place that vocabulary
// and its matching rules are defined; everything else imports the constants
// and the classifier below.

/**
 * @typedef {'complete'|'partial'|'needs-human'|'session-limit'|'billing-error'|'failed'|'hung'|'error'} CycleSignal
 */

/** @type {Record<string, CycleSignal>} */
export const CYCLE_SIGNAL = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  NEEDS_HUMAN: "needs-human",
  SESSION_LIMIT: "session-limit",
  BILLING_ERROR: "billing-error",
  FAILED: "failed",
  HUNG: "hung",
  ERROR: "error",
});

/**
 * @typedef {object} SignalBehavior
 * @property {boolean} retryable - eligible for the cycle's own retry loop
 * @property {boolean} haltsRun - stops the whole autonomous run, not just this cycle
 * @property {boolean} requiresHuman - cycle goes to "blocked" awaiting `cortex-harness resume`
 */

/** @type {Record<CycleSignal, SignalBehavior>} */
const SIGNAL_BEHAVIOR = Object.freeze({
  [CYCLE_SIGNAL.COMPLETE]: { retryable: false, haltsRun: false, requiresHuman: false },
  [CYCLE_SIGNAL.PARTIAL]: { retryable: true, haltsRun: false, requiresHuman: false },
  [CYCLE_SIGNAL.FAILED]: { retryable: true, haltsRun: false, requiresHuman: false },
  [CYCLE_SIGNAL.HUNG]: { retryable: true, haltsRun: false, requiresHuman: false },
  [CYCLE_SIGNAL.ERROR]: { retryable: false, haltsRun: false, requiresHuman: false },
  [CYCLE_SIGNAL.NEEDS_HUMAN]: { retryable: false, haltsRun: true, requiresHuman: true },
  [CYCLE_SIGNAL.SESSION_LIMIT]: { retryable: false, haltsRun: true, requiresHuman: true },
  // Retrying a billing failure burns attempts for free — it will fail identically
  // every time until a payment method is added, so this halts immediately like
  // session-limit rather than going through the normal retry budget.
  [CYCLE_SIGNAL.BILLING_ERROR]: { retryable: false, haltsRun: true, requiresHuman: true },
});

/** @param {CycleSignal} signal */
export function isRetryable(signal) {
  return !!SIGNAL_BEHAVIOR[signal]?.retryable;
}

/** @param {CycleSignal} signal */
export function haltsRun(signal) {
  return !!SIGNAL_BEHAVIOR[signal]?.haltsRun;
}

/** @param {CycleSignal} signal */
export function requiresHumanInput(signal) {
  return !!SIGNAL_BEHAVIOR[signal]?.requiresHuman;
}

// ─── message matching ──────────────────────────────────────────────────────
// Wording unconfirmed against every provider's exact phrasing — best-effort
// substring/regex matching, same as the logic this replaces.

const SESSION_LIMIT_PATTERNS = [/session limit/i, /weekly limit/i];
const RATE_LIMIT_PATTERNS = [/rate limit/i, /rate-limit/i];
// Confirmed live against OpenCode's "AI_APICallError: No payment method.
// Add a payment method here: <url>" — the other two patterns are the same
// failure mode worded differently by other providers (OpenAI/Anthropic-style
// quota errors), unconfirmed live but cheap to also catch.
const BILLING_ERROR_PATTERNS = [/no payment method/i, /insufficient_quota/i, /credit balance is too low/i];

/** @param {string} message */
export function isSessionLimitMessage(message) {
  return SESSION_LIMIT_PATTERNS.some((re) => re.test(message));
}

/** @param {string} message */
export function isRateLimitMessage(message) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/** @param {string} message */
export function isBillingErrorMessage(message) {
  return BILLING_ERROR_PATTERNS.some((re) => re.test(message));
}

// ─── classification ────────────────────────────────────────────────────────

/**
 * Classify a cycle's accumulated output text + process exit code into one
 * CycleSignal. Pure — no logging or other side effects; callers that need to
 * log a transition (e.g. cycle-runner's session/rate-limit messages) do so
 * themselves using the returned signal.
 *
 * @param {string} message
 * @param {number} code
 * @returns {CycleSignal}
 */
export function classifySignal(message, code) {
  const lastLine = message.trimEnd().split("\n").findLast((l) => l.trim()) ?? "";
  const lastLineTrimmed = lastLine.trim();

  if (lastLineTrimmed.startsWith("NEEDS_HUMAN_INPUT")) return CYCLE_SIGNAL.NEEDS_HUMAN;
  if (isSessionLimitMessage(message)) return CYCLE_SIGNAL.SESSION_LIMIT;
  if (isBillingErrorMessage(message)) return CYCLE_SIGNAL.BILLING_ERROR;
  if (isRateLimitMessage(message)) return CYCLE_SIGNAL.PARTIAL;
  if (lastLineTrimmed === "CYCLE_COMPLETE") return CYCLE_SIGNAL.COMPLETE;
  if (lastLineTrimmed.startsWith("CYCLE_PARTIAL:")) return CYCLE_SIGNAL.PARTIAL;
  if (message.includes("CYCLE_COMPLETE")) return CYCLE_SIGNAL.COMPLETE;
  if (/CYCLE_PARTIAL:/.test(message)) return CYCLE_SIGNAL.PARTIAL;
  if (code === 0) return CYCLE_SIGNAL.COMPLETE;
  return CYCLE_SIGNAL.FAILED;
}

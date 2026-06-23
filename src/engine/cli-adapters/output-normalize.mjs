import { isBillingErrorMessage, isSessionLimitMessage } from "../cycle-signal.mjs";

// Normalizes a sub-session's raw stdout into a single plain-text string
// regardless of adapter, so every downstream caller (JSON extraction,
// session-limit text matching, etc.) can stay adapter-agnostic. Claude's
// plain-text output formats already are plain text — parseEventLine returns
// null per line on non-JSON text, so the loop below naturally falls through
// to rawOutput unchanged. OpenCode's json-stream output needs its
// "assistant" text events accumulated into one string first.
export function normalizeAdapterOutput(adapter, rawOutput, outputFormat) {
  if (outputFormat !== "json-stream" || !adapter.parseEventLine) return rawOutput;

  let assistantText = "";
  for (const line of rawOutput.split("\n").filter(Boolean)) {
    const event = adapter.parseEventLine(line);
    if (!event) continue;
    const normalized = adapter.extractResult(event);
    if (normalized?.kind === "assistant" && normalized.text) {
      assistantText += normalized.text + "\n";
    }
  }
  return (assistantText || rawOutput).trim();
}

// Scans the same raw stdout every normalizeAdapterOutput caller already has,
// looking for a structured 'stream_error' event (see NormalizedEvent in
// adapter-interface.mjs) — the shape both adapters use for a hard provider
// failure (billing, auth, invalid model) that replaces any "text"/"final"
// event the call would otherwise have produced. Every spawn site that reads
// a json-stream adapter's output should check this *before* falling back to
// generic "empty output" / "non-JSON" handling, since otherwise the real
// cause is silently discarded — confirmed live: OpenCode's billing error
// arrives as exactly one such event with nothing else in the stream.
// Returns null for "text"-format adapters (Claude's smoke-check mode) or any
// adapter without parseEventLine — callers should fall back to
// isBillingErrorMessage/isSessionLimitMessage text matching for those.
export function extractStreamError(adapter, rawOutput, outputFormat) {
  if (outputFormat !== "json-stream" || !adapter.parseEventLine) return null;

  for (const line of rawOutput.split("\n").filter(Boolean)) {
    const event = adapter.parseEventLine(line);
    if (!event) continue;
    const normalized = adapter.extractResult(event);
    if (normalized?.kind === "stream_error" && normalized.text) {
      return normalized.text;
    }
  }
  return null;
}

/**
 * @typedef {object} ProviderFailure
 * @property {'billing'|'session-limit'} type
 * @property {string} message - the diagnosed text (structured stream_error
 *   text when found, otherwise the raw stdout+stderr that matched)
 */

/**
 * The one check every LLM sub-spawn should run before falling back to
 * generic "empty output" / "non-JSON" handling — prefers the structured
 * stream_error event (works for any json-stream adapter, either provider),
 * falling back to text matching across raw stdout+stderr for "text"-format
 * adapters (Claude's smoke-check mode) or any adapter without
 * parseEventLine, since a billing/session-limit message can still appear as
 * plain text there. Single source of truth — every spawn site (cycle-runner's
 * turn-cap summary, chain-task's chain-decision call, smoke-orchestrator's
 * per-URL check) calls this instead of re-deriving its own regex check.
 *
 * @param {import('./adapter-interface.mjs').CliAdapter} adapter
 * @param {{rawStdout?: string, rawStderr?: string, outputFormat?: string}} output
 * @returns {ProviderFailure|null}
 */
export function diagnoseProviderFailure(adapter, { rawStdout = "", rawStderr = "", outputFormat } = {}) {
  const structured = extractStreamError(adapter, rawStdout, outputFormat);
  const combined = structured ?? `${rawStdout}\n${rawStderr}`;

  if (isBillingErrorMessage(combined)) return { type: "billing", message: combined };
  if (isSessionLimitMessage(combined)) return { type: "session-limit", message: combined };
  return null;
}

// Shared terminal UI helpers built on @clack/prompts.
//
// Every interactive primitive here is *guarded*: when stdin is not a TTY
// (CI, piped input, jest spawnSync), the prompt is skipped and a caller-supplied
// fallback is returned instead of blocking on a read that will never resolve.
// Cancellation (Ctrl-C / Esc) is funnelled through `bailOnCancel`, which prints a
// clack cancel banner and exits 0 — the same "no changes saved" contract the
// readline-based flows used to provide via SIGINT.
import * as p from "@clack/prompts";

export const isInteractive = () => Boolean(process.stdin.isTTY);

// Display primitives — safe to call in any mode (they only write to stdout).
export const intro = p.intro;
export const outro = p.outro;
export const note = p.note;
export const log = p.log;
export const spinner = p.spinner;
export const isCancel = p.isCancel;
export const cancel = p.cancel;

// Abort the CLI gracefully when a clack prompt is cancelled.
export function bailOnCancel(value, message = "Cancelled — no changes saved.") {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(0);
  }
  return value;
}

// Yes/no confirmation. Non-interactive → `fallback` (defaults to `initialValue`).
export async function confirm({
  message,
  initialValue = false,
  fallback,
  cancelMessage,
}) {
  if (!isInteractive()) return fallback ?? initialValue;
  return bailOnCancel(await p.confirm({ message, initialValue }), cancelMessage);
}

// Free-text input. Non-interactive → `fallback` (defaults to "").
export async function text({
  message,
  placeholder,
  defaultValue,
  initialValue,
  validate,
  fallback = "",
  cancelMessage,
}) {
  if (!isInteractive()) return fallback;
  return bailOnCancel(
    await p.text({ message, placeholder, defaultValue, initialValue, validate }),
    cancelMessage,
  );
}

// Single-choice menu. Non-interactive → `fallback`.
export async function select({
  message,
  options,
  initialValue,
  fallback,
  cancelMessage,
}) {
  if (!isInteractive()) return fallback;
  return bailOnCancel(
    await p.select({ message, options, initialValue }),
    cancelMessage,
  );
}

// Multi-choice menu. Non-interactive → `fallback` (defaults to []).
export async function multiselect({
  message,
  options,
  initialValues,
  required = false,
  fallback = [],
  cancelMessage,
}) {
  if (!isInteractive()) return fallback;
  return bailOnCancel(
    await p.multiselect({ message, options, initialValues, required }),
    cancelMessage,
  );
}

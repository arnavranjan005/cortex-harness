// Centralized console logger — single choke point for all stdout/stderr writes in src/.
//
// Routing matches native console semantics (info/debug → stdout, warn/error → stderr)
// so existing chalk-formatted call sites work unchanged; this module only adds
// level filtering (CORTEX_HARNESS_LOG_LEVEL) and a quiet mode (CORTEX_HARNESS_QUIET)
// on top, both read lazily so tests can mutate process.env between calls.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

function currentLevel() {
  if (process.env.CORTEX_HARNESS_QUIET === "1") return LEVELS.warn;
  const fromEnv = LEVELS[(process.env.CORTEX_HARNESS_LOG_LEVEL ?? "").toLowerCase()];
  return fromEnv ?? LEVELS.info;
}

function enabled(level) {
  return LEVELS[level] >= currentLevel();
}

export const logger = {
  debug(...args) {
    if (enabled("debug")) console.log(...args);
  },
  info(...args) {
    if (enabled("info")) console.log(...args);
  },
  warn(...args) {
    if (enabled("warn")) console.warn(...args);
  },
  error(...args) {
    if (enabled("error")) console.error(...args);
  },
};

// Strict JSON.parse first; falls back to quoting bare object keys (e.g.
// `{ chain: true, "task": "..." }`) for models that return JS-object-literal
// syntax instead of strict JSON — confirmed live that OpenCode's model does
// this even when explicitly instructed to return "raw JSON". Shared by every
// call site that parses a raw LLM completion as JSON (chain-task's
// chain/no-chain decision, run-autonomous's pre-smoke URL detector,
// smoke-orchestrator's per-URL check result).
export function parseLenientJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const quoted = text.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
    return JSON.parse(quoted);
  }
}

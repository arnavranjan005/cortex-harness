// Thin re-export — the actual resolution logic now lives in
// cli-adapters/claude-adapter.mjs (the adapter implementation). Kept here so
// existing importers (run-autonomous.mjs, smoke-orchestrator.mjs,
// chain-task.mjs) don't need to change their import path in this phase.
export { CLAUDE_EXE, claudeAdapter, resolveClaudeExe } from "./cli-adapters/claude-adapter.mjs";

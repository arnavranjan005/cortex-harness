/**
 * PostToolUse hook — fires after every Agent tool call.
 * Appends a cycle entry to session.json so the dispatch loop
 * has a persistent task log that survives context compression.
 * Always exits 0 — never blocks the agent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const HARNESS_DIR  = '.harness';
const SESSION_FILE = path.join(HARNESS_DIR, 'session.json');

const EMPTY_SESSION = () => ({
  sessionId: Date.now().toString(36),
  startTime: new Date().toISOString(),
  cycles:    [],
  risks:     [],
});

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw);

    // Only track subagent-spawn tool completions. "Agent" is Claude Code's
    // name for this tool; "task" is OpenCode's — claude-hooks-bridge's
    // matcher translation only affects whether this hook fires, not the
    // tool_name value in the payload, so both names must be checked here.
    if (event.tool_name !== 'Agent' && event.tool_name !== 'task') process.exit(0);

    mkdirSync(HARNESS_DIR, { recursive: true });

    let session = EMPTY_SESSION();
    if (existsSync(SESSION_FILE)) {
      try { session = JSON.parse(readFileSync(SESSION_FILE, 'utf8')); } catch { /* use empty */ }
    }

    if (!session.startTime) session.startTime = new Date().toISOString();
    if (!session.sessionId) session.sessionId = Date.now().toString(36);
    if (!Array.isArray(session.cycles)) session.cycles = [];

    const description = (event.tool_input?.description ?? 'agent task').slice(0, 100);

    session.cycles.push({
      n:           session.cycles.length + 1,
      description,
      completedAt: new Date().toISOString(),
      outcome:     'done',
    });

    writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
  } catch {
    // Silently swallow — harness must never crash the agent
  }
  process.exit(0);
});

/**
 * Stop hook — fires when the Claude Code session ends.
 * Reads session.json, writes a dated session log to .harness/sessions/,
 * then resets session.json.
 * Always exits 0 — never blocks shutdown.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const HARNESS_DIR   = '.harness';
const SESSION_FILE  = path.join(HARNESS_DIR, 'session.json');
const SESSIONS_DIR  = path.join(HARNESS_DIR, 'sessions');

const EMPTY_SESSION = {
  sessionId: null,
  startTime: null,
  cycles:    [],
  risks:     [],
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    if (!existsSync(SESSION_FILE)) process.exit(0);

    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (!session.cycles?.length) process.exit(0);

    const now      = new Date();
    const start    = session.startTime ? new Date(session.startTime) : now;
    const minutes  = Math.round((now - start) / 60_000);
    const duration = minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes}m`;

    const done    = session.cycles.filter(c => c.outcome === 'done').length;
    const partial = session.cycles.filter(c => c.outcome === 'partial').length;
    const blocked = session.cycles.filter(c => c.outcome === 'blocked').length;

    const lines = [
      `# Dispatch Session — ${session.sessionId ?? 'unknown'}`,
      ``,
      `| Field    | Value |`,
      `|----------|-------|`,
      `| Started  | ${session.startTime ?? 'unknown'} |`,
      `| Ended    | ${now.toISOString()} |`,
      `| Duration | ${duration} |`,
      `| Done     | ${done} |`,
      `| Partial  | ${partial} |`,
      `| Blocked  | ${blocked} |`,
      ``,
      `## Task Log`,
      ``,
      ...session.cycles.map(c =>
        `[${c.n}] ${c.description} → **${c.outcome}**${c.reason ? ` — ${c.reason}` : ''}`
      ),
      ``,
      `## Residual Risks`,
      ``,
      ...(session.risks?.length
        ? session.risks.map(r => `- ${r}`)
        : [`- none`]),
    ];

    mkdirSync(SESSIONS_DIR, { recursive: true });

    const stamp    = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
    const filename = path.join(SESSIONS_DIR, `${stamp}-${session.sessionId ?? 'session'}.md`);
    writeFileSync(filename, lines.join('\n'), 'utf8');

    // Reset session state for next run
    writeFileSync(SESSION_FILE, JSON.stringify(EMPTY_SESSION, null, 2), 'utf8');

  } catch {
    // Silently swallow — harness must never block shutdown
  }
  process.exit(0);
});

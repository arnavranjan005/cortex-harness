# Chain Stop Signals

The cortex-harness chain command stops for one of these reasons. Each maps to a specific signal type.

## Signal types and what they mean

| Signal | How it appears | What happened |
|---|---|---|
| `complete` | Chain printed "All cycles complete" and exited 0 | Full success — all runs finished cleanly |
| `needs-human` | Chain printed "Blocked queue detected (needs human input). Stopping chain." | A cycle emitted `NEEDS_HUMAN_INPUT` — a security-sensitive or ambiguous decision needs a human |
| `session-limit` | Chain printed "Blocked queue detected (session limit)" or "Run hit session limit" | Claude's weekly/session usage cap was hit mid-run |
| `billing-error` | Cycle output contains "No payment method" or "insufficient_quota" or "credit balance is too low" | Payment method missing or quota exhausted |
| `budget-exhausted` | Chain printed "Global budget exhausted" | The `--budget` USD cap was reached across all chain runs |
| `max-runs` | Chain printed "Chain run N/N" and stopped | The `--max-runs` cap was reached |
| `no-delivery` | Chain printed "Run did not produce a new delivery" | Run aborted without producing a delivery and no blocked cycles found |
| `exit-nonzero` | Chain printed "Run exited with code N" | The run process exited with a non-zero code — check logs |

## Where to find the blocked question (needs-human case)

When `needs-human` fires, the question text is in one of:
1. `.harness/task-queue.json` → find cycles with `"status": "blocked"` and `"blockedType": "needs-human-input"` → read `blockedReason`
2. `.harness/cycle-state/<cycle-output-file>.json` → read `outOfScopeGaps` array

The `cortex-harness status` command already extracts and formats this for you.

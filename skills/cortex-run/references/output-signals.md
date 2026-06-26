# Run Output Signals

The cortex-harness engine classifies every cycle's outcome into one of 8 signals. These are the single source of truth defined in `src/engine/cycle-signal.mjs`.

## The 8 signals

| Signal | Retryable | Halts run | Requires human |
|---|---|---|---|
| `complete` | no | no | no |
| `partial` | yes | no | no |
| `failed` | yes | no | no |
| `hung` | yes | no | no |
| `error` | no | no | no |
| `needs-human` | no | yes | yes |
| `session-limit` | no | yes | yes |
| `billing-error` | no | yes | yes |

## How signals are classified

The engine classifies by reading the cycle's last output line and exit code:
- Last line is `NEEDS_HUMAN_INPUT...` → `needs-human`
- Output contains "session limit" or "weekly limit" → `session-limit`
- Output contains "No payment method" / "insufficient_quota" / "credit balance is too low" → `billing-error`
- Output contains "rate limit" → `partial` (retried automatically)
- Last line is `CYCLE_COMPLETE` → `complete`
- Last line starts with `CYCLE_PARTIAL:` → `partial`
- Exit code 0 with no signal → `complete`
- Anything else → `failed`

## What retryable means

`partial`, `failed`, and `hung` are retried automatically by the engine (up to `MAX_RETRIES`). If all retries exhaust, the engine injects a recovery cycle. The run only stops for these if the retry budget is fully consumed — the skill does not need to intervene.

## What halts-run means

`needs-human`, `session-limit`, and `billing-error` halt the entire run immediately. These cannot be retried — they require external action before the run can continue.

## Where cycle outputs live

After a run, every cycle writes a JSON file to `.harness/cycle-state/`:
- `explore.json` — discovery report
- `plan.json` — planning output
- `implement-*.json` — per-surface implementation reports
- `reconcile.json` — contract check and gap table
- `test.json` — build/test/lint results
- `smoke.json` — browser smoke results
- `deliver-*.json` — delivery summary

The queue state (what completed, what's blocked) is in `.harness/task-queue.json`.

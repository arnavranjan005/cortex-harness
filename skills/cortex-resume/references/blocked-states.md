# Blocked States Reference

When a run stops with `NEEDS_HUMAN_INPUT` or `session-limit`, cycles are marked `blocked` in `.harness/task-queue.json`. This file explains what each blocked state looks like and how to read it.

## task-queue.json blocked cycle structure

```json
{
  "id": "implement-backend",
  "type": "implement-backend",
  "status": "blocked",
  "blockedType": "needs-human-input",
  "blockedReason": "Should webhook verification use Stripe's signing secret or a custom HMAC key? This is a security-sensitive auth decision.",
  "outputFile": "implement-backend.json"
}
```

## blockedType values

| Value | Meaning |
|---|---|
| `needs-human-input` | Cycle emitted `NEEDS_HUMAN_INPUT` — decision required |
| `session-limit` | Claude's session/weekly cap was hit |

## Finding the blocked question

The `blockedReason` field contains the question text. If it looks truncated (older runs had a 300-char cap), the full question text is also in:
1. `.harness/runs/<latest>.jsonl` — find the `cycle-result` event for that cycleId, read `finalMessage`, extract text after `NEEDS_HUMAN_INPUT`
2. `.harness/cycle-state/<outputFile>` — read `outOfScopeGaps` array for blocking gaps

The `cortex-harness status` command does this extraction automatically — run it first before digging into raw files.

## What resume does

`cortex-harness resume` walks through each blocked cycle interactively:
- Shows the question
- Prompts for your answer
- Writes `human-answers.json` to the cycle state dir
- Asks whether to start the run after answering

The answer is injected as prior context into the next cycle attempt via `assemblePriorContext()` in the engine.

## Session-limit blocks

For `session-limit` blocks, `cortex-harness resume` re-enters the run without collecting answers (the limit is the blocker, not a question). It just restarts from the last partial state after the limit resets.

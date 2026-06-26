# Chain Stop Recovery Guide

What to tell the user for each stop reason.

## needs-human
The engine stopped because a cycle hit a security-sensitive or ambiguous decision it will not make autonomously (auth, JWT, CORS, CSRF, schema changes, permission model changes, or genuinely ambiguous ownership).

Surface the question by running: `cortex-harness status`

Tell the user:
- What the blocked question is (from status output)
- That this is intentional — the engine will not guess on these
- Next step: answer the question, then run `cortex-harness resume` to continue the run

Do NOT re-fire the chain automatically. The user must answer first.

## session-limit
Claude's weekly or session usage cap was hit. The run state is preserved.

Tell the user:
- The limit resets (usually within 24h for weekly limits)
- After it resets, they can resume with: `cortex-harness chain resume`
- The cycle state is preserved — no work is lost

## billing-error
No payment method on the Anthropic account, or quota exhausted.

Tell the user:
- Check their Anthropic billing at console.anthropic.com
- Add or update payment method
- Then resume with: `cortex-harness resume`

## budget-exhausted
The global `--budget` cap was hit across the chain runs.

Tell the user:
- How much was spent (visible in the chain output)
- To re-run with a higher budget: `cortex-harness chain "task" --budget 120`
- Or to run the next task manually: `cortex-harness chain` (seeds from last delivery)

## max-runs
The `--max-runs` cap was hit.

Tell the user:
- How many runs completed
- To check if work is done: `cortex-harness status`
- If residual risks remain: re-run with higher cap: `cortex-harness chain --max-runs 5`
- Or seed from last delivery: `cortex-harness chain` (no task argument)

## no-delivery / exit-nonzero
The run aborted or produced no delivery.

Tell the user:
- Check logs: `cortex-harness logs`
- Check current status: `cortex-harness status`
- If partial cycles exist, resume: `cortex-harness resume`
- If completely broken, start fresh: `cortex-harness chain "task"`

# Run Stop Recovery Guide

What to tell the user when a single `cortex-harness run` stops unexpectedly.

## needs-human
A cycle emitted `NEEDS_HUMAN_INPUT` — a security-sensitive decision (auth, JWT, CORS, CSRF, schema migration, permission model changes) or genuinely ambiguous ownership decision.

Steps:
1. Run `cortex-harness status` — it extracts and shows the blocked question
2. Tell the user what the question is
3. Tell them to answer it, then run: `cortex-harness resume`

Do NOT try to answer the question on their behalf.

## session-limit
Claude's weekly/session usage cap was hit. Run state is fully preserved.

Steps:
- Wait for the limit to reset (usually within 24h)
- Resume the run: `cortex-harness resume`
- No work is lost — the engine saves state after each cycle

## billing-error
No payment method or quota exhausted on the Anthropic account.

Steps:
- Check console.anthropic.com → Billing
- Add or update payment method
- Resume: `cortex-harness resume`

## hung (dead-man timer)
A cycle went silent for 20 minutes and was force-killed by the engine. The engine retries automatically — if the skill is surfacing this, all retries exhausted.

Steps:
- Check `cortex-harness logs` — look for the hung cycle and what it was doing
- Common cause: a subprocess waiting for interactive input it can never get
- Try: `cortex-harness resume` to re-enter with a fresh attempt

## failed / error (all retries exhausted)
The cycle failed repeatedly and the retry budget was consumed.

Steps:
- Run `cortex-harness logs` — find what the failure was
- Run `cortex-harness status` — see which cycles completed and which are stuck
- If partial work exists, check `cortex-harness resume`
- If fundamentally broken, start fresh: `cortex-harness run "task"`

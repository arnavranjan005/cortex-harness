---
name: cortex-notify
description: Configure or test cortex-harness notifications — Discord webhooks, Windows toast alerts, or other notification channels.
argument-hint: Action (e.g. "show config" or "test discord" or "set webhook URL")
allowed-tools: Bash, Read, Edit
---

## Step 1 — Read current notification config

Run:
```bash
cortex-harness notify --help
```

Also read `harness.config.json` for any notification-related fields.

## Step 2 — Handle the request

**Show current config:**
Display what notification channels are configured and whether they're active.

**Configure Discord webhook:**
The engine sends Discord notifications on run-end events. To configure:
```bash
cortex-harness notify
```
This is an interactive CLI for setting up the webhook URL.

Or the user can set the environment variable `CORTEX_DISCORD_WEBHOOK` directly.

**Test notifications:**
```bash
cortex-harness notify --test
```

**Windows toast notifications:**
These are automatic on Windows when a run ends — no configuration needed. They use the Windows notification system natively.

## When notifications fire

The engine sends notifications on:
- Run end (success) — with cost summary and cycle count
- Run end (blocked) — with block reason
- Rate limit hit — with reset time

Notifications do not fire on individual cycle completions — only on full run end.

## Security note

Discord webhook URLs are secrets — they allow anyone to post to your channel. If you configure one:
- Store it as an environment variable (`CORTEX_DISCORD_WEBHOOK`), not in `harness.config.json`
- Never show or log the webhook URL in this session

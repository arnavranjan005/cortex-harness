---
name: cortex-notify
description: Configure or test cortex-harness notifications — Discord webhooks, Windows toast — with interactive prompts. Webhook URLs are never shown.
argument-hint: Action (e.g. "show config", "add discord", "test", "disable windows")
allowed-tools: AskUserQuestion, mcp__cortex-harness__cortex_notify_list, mcp__cortex-harness__cortex_notify_discord_add, mcp__cortex-harness__cortex_notify_discord_remove, mcp__cortex-harness__cortex_notify_windows_toggle, mcp__cortex-harness__cortex_notify_test
---

## Step 1 — Read current config

Call `cortex_notify_list`. Show the user current channel status.

## Step 2 — Ask what to do

If $ARGUMENTS is empty, use AskUserQuestion:
- "What would you like to do with notifications?"
  - "Add Discord webhook"
  - "Enable Windows toast"
  - "Disable Windows toast"
  - "Test all channels"

If $ARGUMENTS already specifies an action, skip this and go directly to that action below.

## Step 3 — Handle the action

**Add Discord webhook:**
Use AskUserQuestion to ask:
- "What display name for this Discord channel?" (options: "ops", "alerts", "dev", "Other")

Then ask the user to paste their webhook URL in the next message (plain text reply — not AskUserQuestion, since URLs are free-form and secret).

Call `cortex_notify_discord_add` with the URL and label. Confirm with the redacted form only — never echo the URL.

After adding, use AskUserQuestion:
- "Send a test message to verify the webhook works?"
  - "Yes, test it now" → call `cortex_notify_test`
  - "No, skip test"

**Enable/disable Windows toast:**
Call `cortex_notify_windows_toggle` with `enabled: true` or `false`.

**Test all channels:**
Call `cortex_notify_test`. Report results.

**Remove Discord channel:**
Call `cortex_notify_list` to show channels. Ask user which label to remove. Call `cortex_notify_discord_remove`.

## Security rule

Never display, echo, log, or repeat a webhook URL — not even to confirm it was saved. Use only the redacted form returned by the tool.

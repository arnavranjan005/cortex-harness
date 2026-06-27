---
name: cortex-auth
description: Manage auth profiles and capture browser sessions for smoke tests — fully in-chat, no terminal required.
argument-hint: Action (e.g. "list profiles", "add default profile", "remove viewer")
allowed-tools: AskUserQuestion, mcp__cortex-harness__cortex_auth_list, mcp__cortex-harness__cortex_auth_start, mcp__cortex-harness__cortex_auth_finish, mcp__cortex-harness__cortex_auth_remove
---

Read `$CLAUDE_SKILL_DIR/references/auth-profiles.md` now.

## How auth profiles work

harness.config.json stores ONLY `{ name, storageFile }` — no credentials, no login URL, no passwords.

The session is captured by opening a real browser, the user logs in manually (including SSO, OAuth, MFA), then the session cookies/localStorage are saved to `.harness/smoke-auth-<name>.json`.

When no `--profile` flag is given, the name defaults to `"default"`.

## Step 1 — Check config exists

Call `cortex_auth_list`. If it returns "harness.config.json not found":
→ Read `$CLAUDE_SKILL_DIR/../cortex-init/SKILL.md` and follow those instructions inline now (skill chain)

## Step 2 — Show current profiles and ask what to do

Show profiles (name + storageFile + whether session file exists). If $ARGUMENTS is empty, use AskUserQuestion:
- "What would you like to do with auth profiles?"
  - "List profiles" → show and stop
  - "Capture a new session (browser will open)"
  - "Remove a profile"

## Step 3 — Handle the action

### Capture a new session (replaces terminal step — fully automatic)

Use AskUserQuestion:
- "What name for this profile?"
  - "default" — description: "Used automatically when --profile is omitted"
  - "admin"
  - "viewer"
  - "Other"

Call `cortex_auth_start` with the chosen name. This opens a real browser to the app login page and returns once the browser is ready.

Tell the user:
> A browser window is open. Log in completely (including any SSO redirects or MFA), then come back here and click Done.

Use AskUserQuestion:
- "Have you finished logging in?"
  - "Yes, I'm fully logged in" → proceed to cortex_auth_finish
  - "Something went wrong / cancel" → call cortex_auth_finish with cancel: true, then stop

Call `cortex_auth_finish` with the same profile name. This sends Enter to the auth process, which saves the session file and registers the profile in harness.config.json.

Report the result from `cortex_auth_finish`.

**If `cortex_auth_start` returns an error** (e.g. cortex-harness not found, playwright not configured):
Tell the user to run manually in their terminal:
```
cortex-harness auth --profile <name>
```
Then: a browser opens → log in → press Enter → session saved.

### Remove a profile

Show current profiles from Step 1. Use AskUserQuestion with profile names as options.

Use AskUserQuestion to confirm:
- "Remove this profile entry from harness.config.json?"
  - "Yes, remove it"
  - "Cancel"

Call `cortex_auth_remove` only if confirmed. Remind the user to also delete the session file manually if no longer needed.

## Rules

- Never ask for or display credentials — they are never stored in the config
- `cortex_auth_start` and `cortex_auth_finish` must always be called as a pair, in order
- If the user says "cancel" between start and finish, warn that the browser process may still be running

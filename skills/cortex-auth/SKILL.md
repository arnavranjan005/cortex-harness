---
name: cortex-auth
description: Manage auth profiles for authenticated smoke sessions — list, add, or remove named credential sets.
argument-hint: Action (e.g. "list profiles" or "add admin profile" or "remove viewer")
allowed-tools: Bash, Read, Edit
---

Read `$CLAUDE_SKILL_DIR/references/auth-profiles.md` now.

## Step 1 — Read current auth profiles

Read `harness.config.json`. Find the `authProfiles` array.

## Step 2 — Handle the request

**List profiles** (default if $ARGUMENTS is empty):
Show each profile's `name` and `loginUrl`. Do NOT show credentials — not even in this session.

**Add a profile:**
Ask the user for:
- Profile name (used to reference it in smoke config)
- Login URL
- Credential fields (email, password, or whatever the form needs)

Security reminder before collecting:
> These credentials will be stored in harness.config.json in plain text. Only use test/staging credentials — never production credentials.

Once confirmed, add the profile to the `authProfiles` array in `harness.config.json`.

**Remove a profile:**
Find the profile by name and remove it from the array. Confirm before removing.

**Use the CLI instead:**
If the user prefers not to edit config directly, they can use:
```bash
cortex-harness auth
```
This is an interactive CLI that manages auth profiles without manual JSON editing.

## Rules

- Never display credential values (password, secret tokens) in your response — not even to confirm they were saved correctly
- Never add production credentials — always remind the user to use test/staging only
- The `authProfiles` array is in `harness.config.json` which is committed to git by default — warn the user if they're about to add credentials to a committed file and suggest adding `harness.config.json` to `.gitignore` if it contains real credentials

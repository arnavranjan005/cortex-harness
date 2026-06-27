# Auth Profiles — Quick Reference

## What is stored

harness.config.json `authProfiles` array — each entry:
```json
{ "name": "default", "storageFile": ".harness/smoke-auth-default.json" }
```

No credentials, no login URL, no passwords are ever stored.

## What is NOT stored

- Passwords, tokens, or API keys
- Login URLs (come from devServer config, not authProfiles)
- Session data itself (stored in the storageFile, never in harness.config.json)

## Session capture flow (in-chat — automatic)

1. `cortex_auth_start` — spawns `cortex-harness auth --profile <name>`, waits for browser to open
2. User logs in via the open browser window
3. User clicks "Yes, I'm fully logged in" in chat
4. `cortex_auth_finish` — sends Enter to the auth process → session saved to storageFile

## Session capture flow (terminal fallback)

```
cortex-harness auth --profile default
```
Browser opens → log in → press Enter → `.harness/smoke-auth-default.json` created.

## Profile names

- `"default"` — used when `--profile` is omitted
- Any alphanumeric name: `"admin"`, `"viewer"`, `"staging"`

## Smoke cycle behavior

Smoke cycles load each profile's storageFile and run browser checks as that authenticated user.

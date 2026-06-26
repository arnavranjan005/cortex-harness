# Auth Profiles Reference

How `authProfiles` in `harness.config.json` works for authenticated smoke sessions.

## What auth profiles are for

Smoke cycles use Playwright to browser-test URLs after tests pass. For URLs behind login, the smoke agent needs to authenticate first. Auth profiles let you name a set of credentials so the smoke cycle can log in automatically.

## Auth profile structure

```json
{
  "authProfiles": [
    {
      "name": "admin",
      "loginUrl": "http://localhost:3000/login",
      "credentials": {
        "email": "admin@example.com",
        "password": "test-password"
      }
    },
    {
      "name": "viewer",
      "loginUrl": "http://localhost:3000/login",
      "credentials": {
        "email": "viewer@example.com",
        "password": "test-password"
      }
    }
  ]
}
```

## Using auth profiles in smoke URLs

Reference a profile by name in the `smokeUrls` config or in the smoke prompt. The smoke orchestrator reads the profile, navigates to `loginUrl`, fills the credentials, and stores the session cookie for the test URLs.

## Security notes

- Auth profiles are in `harness.config.json` — do NOT commit real credentials there
- Use test/staging credentials only
- The `.gitignore` patched by `cortex-harness init` does not exclude `harness.config.json` by default — if you add real credentials, add it to `.gitignore` manually
- Prefer environment variable references where possible (the engine does not currently interpolate env vars in auth profiles — store only test credentials)

## Managing profiles with cortex-harness auth

`cortex-harness auth` provides an interactive CLI for adding, listing, and removing auth profiles without manually editing the JSON.

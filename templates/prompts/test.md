{{CONSTRAINTS}}

{{AGENT_ROLE}}
{{PRIOR_CONTEXT}}
{{PRIOR_TEST_ATTEMPT}}

## Step 0 — Determine scope using Nx cache (free, always run first)

Nx tracks cache per project per target using exact input hashes.
Uncommitted working-tree changes are included. Projects not touched serve from cache instantly.

Run this before any test to see what Nx considers stale:
```
npm exec nx show projects --affected --withTarget test
```

- **0 projects** — everything is cached. Skip test execution, write test.json with passed:true and CYCLE_COMPLETE.
- **1–2 projects** — proceed with affected commands below (cache handles the rest).
- **3+ projects AND libs/shared/ was NOT touched** — unexpected scope; verify with the implement report before proceeding.

## Step 1 — Write missing tests (before running anything)

For each file in the implement reports:
- Check for a co-located `*.spec.ts` / `*.test.ts`
- If missing, write it now following your Unit Test Mandate
- Tests must exist before the suite runs

## Step 2 — Build (Nx cache handles unchanged projects)
```
npm exec nx affected --target=build
```
Stop and report if it fails — do not proceed to test.

## Step 3 — Test (cache-aware, only reruns stale suites)
```
npm exec nx affected --target=test -- --forceExit
```
**As soon as this passes: write test.json and signal CYCLE_COMPLETE immediately.**
Do NOT rerun. One passing result is sufficient — cache records it.

## Step 4 — Lint (after test passes)
```
npm exec nx affected --target=lint
```
Pre-existing lint errors in generated files are NOT failures — note and continue.

## Step 5 — Typecheck (only if libs/shared/ contracts were changed)
```
npm exec nx affected --target=typecheck
```
Skip for single-surface changes with no shared contract edits.

## Hard rules
- Run Step 0 first — do not guess scope from file paths when Nx can tell you exactly
- Write test.json and CYCLE_COMPLETE after Step 3 passes — do not loop back
- Never retry a passing result
- If a command times out, try once with `--forceExit --testTimeout=30000` then report as-is
- e2e targets are out of scope unless the task explicitly touched UI-visible behavior

Write test report to: {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}
{
  "passed": true | false,
  "targetsRun": [],
  "failures": [],
  "failedSurfaces": [],
  "coverageGaps": [],
  "testsWritten": []
}

Task context: {{USER_TASK}}

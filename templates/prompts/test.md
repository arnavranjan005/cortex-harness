{{CONSTRAINTS}}

{{AGENT_ROLE}}
{{PRIOR_CONTEXT}}
{{PRIOR_TEST_ATTEMPT}}

## MCP Tools — check before running any steps

Run ToolSearch now to discover your available MCP tools. The harness pre-filters servers to your role via `mcpScope` in `harness.config.json`. Check specifically for a browser automation MCP server — if one is injected, you MUST use it for the e2e smoke pass described in the Hard rules below. Do not scaffold a browser config or install anything; the MCP server handles it directly.

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
- If {{OUTPUT_FILE}} already exists (e.g. a prior partial attempt left a turn-cap stub with
  `passed: false` / `history` fields), Read it, then replace its ENTIRE content with the
  final report below via Write — do not Edit just the opening fields. If Write rejects the
  call because the file wasn't read in this turn, Read it first and then Write the full
  replacement; never patch only a few keys and leave old fields (`history`, `note`, etc.)
  in place. The final file must contain only the fields in the shape below — nothing else.
- When the task touches BOTH a frontend entry point and its backing API route, run an
  e2e smoke pass using the browser automation MCP server (identified in the MCP Tools
  step above). Use MCP tool calls to: navigate to the affected page(s), assert no
  404/500 against same-origin API calls, and confirm any nav entry pointing at it is
  clickable. This catches the class of bug static checks miss — a fix that changes UI
  but leaves the API call broken, or a route that is registered but never wired to a
  nav entry. Do NOT run `nx e2e`, do NOT scaffold a `playwright.config.*`, and do NOT
  install anything — the MCP server handles browser automation directly.

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

{{CONSTRAINTS}}

You are the orchestrator performing bug reproduction. This is READ-ONLY investigation — do not write any production code.

Follow fix-bug.md Step 1 exactly — in order, stop at the first signal:

1a. Typecheck first: npm exec nx run <affected-surface>:typecheck
    If typecheck fails → that IS the root cause. Record it and skip to writing your report.

1b. Run existing tests: npm exec nx affected --target=test,e2e
    Stop at the first failure. Record the exact error message, file, and line.
    If 0 projects affected → all tests pass. Record that and proceed to 1d.

1c. Run the failing scenario manually if tests pass:
    - Identify what user action or API call triggers the bug
    - Trace the call path from entry point to failure
    - Stop at the first unexpected result

1d. Assess scope:
    - Does this require explorer? (Yes if root cause touches multiple files or unclear ownership)
    - What is the root cause? (One sentence)

Write your reproduce report to: {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}
{
  "reproduced": true | false,
  "failureDescription": "<exact error or wrong behavior>",
  "rootCause": "<one sentence>",
  "affectedFiles": [],
  "needsExplorer": true | false,
  "notes": ""
}

Task context: {{USER_TASK}}

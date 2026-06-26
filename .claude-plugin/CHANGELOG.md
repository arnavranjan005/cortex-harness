# Changelog

## v1.0.0

Initial plugin release for cortex-harness v1.14.0.

### Skills added

- `/cortex-chain` — fire the chain engine, investigate on stop, classify stop reason, surface recovery guidance
- `/cortex-run` — single-run variant with same investigate-on-stop monitoring
- `/cortex-resume` — surface what a blocked run is waiting on, guide the user through `cortex-harness resume`
- `/cortex-continue` — continue chain from last delivery (seeds task from residual risks)
- `/cortex-status` — show current queue state, blocked questions, pending cycles
- `/cortex-logs` — readable run log output with cost summary and cycle timeline
- `/cortex-init` — guided setup walkthrough and post-init verification
- `/cortex-config` — read or update harness.config.json fields
- `/cortex-mcp` — view or update MCP scope per agent
- `/cortex-auth` — manage auth profiles for authenticated smoke sessions
- `/cortex-notify` — configure Discord/Windows notification channels

### Architecture

Monitoring layer only — the plugin does not orchestrate. The cortex-harness engine owns execution; the plugin owns session bridging: surfacing signals, extracting blocked questions, classifying stop reasons, and guiding recovery.

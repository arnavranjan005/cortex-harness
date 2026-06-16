# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✓         |
| older   | ✗         |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately via [GitHub's private vulnerability reporting](https://github.com/arnavranjan005/cortex-harness/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Your `cortex-harness` version (`cortex-harness --version`) and Node.js version

You can expect an acknowledgement within 48 hours and a fix or mitigation plan within 7 days for confirmed vulnerabilities.

## Scope

Cortex spawns `claude -p` subprocesses and reads/writes files in your workspace. Relevant areas:

- **Prompt injection** — malicious content in cycle outputs influencing the harness engine
- **Scope revert bypass** — an agent writing outside its declared scope without triggering the git revert cascade
- **Credential exposure** — harness logs or cycle-state files capturing API keys or secrets from the workspace
- **Path traversal** — user-supplied paths in `harness.config.json` escaping the workspace root

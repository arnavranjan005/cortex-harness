# Contributing to Cortex

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- Node.js >= 20
- [Claude Code](https://claude.ai/code) CLI installed and authenticated (required to run integration tests against a real workspace)

## Setup

```bash
git clone https://github.com/arnavranjan005/cortex-harness.git
cd cortex-harness
npm install
```

## Project structure

```
bin/           CLI entry point (cli.mjs)
src/           Core harness logic
  commands/    CLI command handlers (init, run, resume, status, config)
  engine/      Cycle runner, queue processor, scope enforcer
  state/       Zod schemas for cycle-state JSON validation
templates/     Files scaffolded into user workspaces on `init`
  agents/      Sub-agent role definition files
  prompts/     Cycle prompt templates
  scripts/     Runtime scripts copied to .harness/scripts/
tests/         Unit tests (Node built-in test runner)
```

## Running tests

```bash
npm test
```

Tests use Node's built-in `node:test` runner — no extra dependencies needed.

## Making changes

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes
3. Run `npm test` — all tests must pass
4. Open a PR against `main`

## What to work on

Check the [Issues](https://github.com/arnavranjan005/cortex-harness/issues) tab for open tasks. Issues labeled [`good first issue`](https://github.com/arnavranjan005/cortex-harness/issues?q=label%3A%22good+first+issue%22) are scoped to be approachable without deep knowledge of the full engine.

## PR guidelines

- Keep PRs focused — one feature or fix per PR
- If you're adding a new command or changing CLI behavior, update `README.md` to match
- If you're changing cycle state schemas in `src/state/`, update the relevant Zod schemas and add a test

## Reporting bugs

Open an issue with:
- What you ran (`cortex-harness run "..."` or the exact command)
- What you expected vs. what happened
- Your Node version (`node -v`) and OS

## License

By contributing, you agree your changes will be licensed under the [MIT License](./LICENSE).

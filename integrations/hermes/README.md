# Hermes integration bundle

This directory contains the production MCP configuration example and the three
Hermes skills that operate Control Plan:

- `control-plan-delegation`: implementation and bug-fix tasks;
- `control-plan-pr-review`: bounded, read-only PR diff review;
- `control-plan-sentry-triage`: bounded, read-only incident triage.

Use Hermes Agent `v2026.7.20` or newer. That release registers native MCP tools
as `mcp__<server>__<tool>` and supports the form-mode elicitation used for
publication approval.

## Install

1. Put `CONTROL_PLAN_MCP_TOKEN` in the Hermes secret environment or
   `~/.hermes/.env`.
2. Merge [`config.example.yaml`](./config.example.yaml) into
   `~/.hermes/config.yaml`. Replace the skill path with this repository's
   absolute path. Hermes expands `${CONTROL_PLAN_MCP_TOKEN}` at load time.
3. Run `/reload-skills` in an existing Hermes session, or start a new session.
4. Confirm all three skills are enabled and all seven allowlisted MCP tools are
   present before delegating production work.

Alternatively, copy each complete skill directory into `~/.hermes/skills/`.
Using `skills.external_dirs` is preferable during development because updates
to this checkout become visible after `/reload-skills`.

This repository does not use the default root `skills/` layout expected by a
Hermes skill tap. If installing it as a tap, set the tap path to
`integrations/hermes/skills/` in `~/.hermes/.hub/taps.json`.

See [`docs/HERMES-AGENT-INTEGRATION.md`](../../docs/HERMES-AGENT-INTEGRATION.md)
for the runtime contract and smoke-test checklist.

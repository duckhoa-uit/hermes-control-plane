# Control Plan

Cloudflare control plane for Hermes-delegated coding work and human approvals.
The target agent platform is [Hermes Agent by Nous Research](https://hermes-agent.nousresearch.com/docs/).

## Current status

Control Plan is the coding-agent execution service:

- **Hermes Agent** — upstream orchestrator: understands requests, plans work,
  and decides when to call a coding agent
- **Flue** (`@flue/runtime`) — durable coding-agent loop
- **Cloudflare Workers** + Durable Objects — task service and durable state
- **Cloudflare Containers** — isolated git, shell, and test execution
- **GitHub API** — credential-isolated commit and PR writes
- **Task admission** — repository-scoped durable task records, deterministic
  branches, result metadata, and a bounded concurrency lease

The remote HTTP MCP boundary is implemented and verified locally: Hermes calls
it to spawn and manage coding tasks, and Control Plan dispatches those tasks to
Flue. Local Docker E2E covers two repositories; a production Hermes host has
not been configured or smoke-tested yet. The
Hermes HTTP Runs API has the opposite direction (an external client controls
Hermes), so it is not the boundary for this integration. See
[`docs/HERMES-AGENT-INTEGRATION.md`](./docs/HERMES-AGENT-INTEGRATION.md).

## Naming boundary

- `control-plan` / `ControlPlan*` names belong to this project.
- `Hermes Agent` names identify the upstream Nous Research platform. Control
  Plan does not need `HERMES_AGENT_*` Worker configuration because Hermes calls
  this service, not the reverse.
- The deployed Worker script is temporarily still named `hermes-control-plane`
  so existing Durable Objects and secrets are not silently orphaned. Renaming
  that external identity requires an explicit state-transfer cutover.

## For AI agents

This project includes an [AGENTS.md](./AGENTS.md) file with detailed instructions
for autonomous coding agents. Read it before changing the repository.

## Quick start

```bash
bun install
bun run test
npx flue build --target cloudflare
npx wrangler deploy
```

See [`docs/SETUP.md`](./docs/SETUP.md) for local setup and
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for deployment details.

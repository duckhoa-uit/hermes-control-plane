# Hermes Control Plane

M4 verified

Control plane for AI coding agents. Orchestrates sandboxed OpenCode sessions via Cloudflare Durable Objects, with E2B as the sandbox provider.

## Architecture

```
User / API
    |
    v
Cloudflare Worker API
    |
    v
SessionDurableObject (1 per session)
  - state machine
  - event log (append-only, replayable)
  - WebSocket hub (UI + runner)
  - approval gates
  - heartbeat / stall detection
    |
    | WebSocket
    v
E2B Sandbox
    |
    v
Bun Runner / Bridge
  - connects to SessionDO
  - starts opencode serve
  - streams OpenCode events
  - receives commands
    |
    v
OpenCode Server (localhost)
  - agent runtime
  - file edits, shell, tools
```

## Flow

1. User creates task with project profile
2. SessionDO provisions E2B sandbox
3. Sandbox clones repo, runs setup
4. Bun runner starts OpenCode, connects to SessionDO
5. Agent works, events stream live to UI
6. Sensitive actions require approval
7. On completion: diff, test results, summary
8. User approves PR creation
9. Sandbox destroyed, artifacts retained

## Session States

```
created -> provisioning -> runner_connecting -> ready -> running
running -> needs_approval -> running
running -> review_ready -> creating_pr -> completed
running -> stalled -> failed
running -> failed / aborted
completed/failed/aborted -> archived
```

## Project Layout

```
src/
  core/
    types.ts          - all TypeScript interfaces and types
    state-machine.ts  - session state machine with transition validation
    event-log.ts      - append-only event log with seq cursor
    id.ts             - ID and token generators
    constants.ts      - heartbeat intervals, timeouts, ports
  worker/
    index.ts          - Cloudflare Worker API routes
    session-do.ts     - SessionDurableObject (control plane core)
    env.d.ts          - CloudflareEnv type bindings
  providers/
    e2b.ts            - E2B sandbox provider
    github.ts         - GitHub App token broker (short-lived, repo-scoped)
  runner/
    bridge.ts         - Bun runner/bridge (runs inside sandbox)
tests/
    state-machine.test.ts
    event-log.test.ts
    id.test.ts
schema.sql            - D1 database schema
```

## Getting Started

```bash
# Install
bun install

# Run tests
bun run test

# Local dev
cp .dev.vars.example .dev.vars  # fill in secrets
bun run dev

# Initialize D1
wrangler d1 execute hermes-db --local --file=schema.sql
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/sessions` | Create session `{ projectId, taskDescription, repoUrl, profile? }` |
| GET | `/sessions/:id` | Get session state + events + artifacts |
| WS | `/sessions/:id/stream` | Live event stream |
| POST | `/sessions/:id/approve` | Approve action `{ requestId }` |
| POST | `/sessions/:id/abort` | Abort session |
| POST | `/sessions/:id/create-pr` | Create PR (requires review_ready state) |

## Environment Variables

Set in `.dev.vars` or via `wrangler secret put`:

- `E2B_API_KEY` - E2B API key (free tier available)
- `GITHUB_APP_ID` - GitHub App ID for token brokering
- `GITHUB_PRIVATE_KEY` - GitHub App private key (PEM)

## Tech Stack

- **Control Plane**: Cloudflare Workers + Durable Objects
- **Storage**: D1 (metadata), R2 (artifacts)
- **Sandbox**: E2B (free Hobby tier)
- **Runner**: Bun + TypeScript
- **Agent Runtime**: OpenCode (`opencode serve`)
- **Repo Access**: GitHub App short-lived tokens

## Security Model

- Runner gets only a session-scoped token, never broad credentials
- GitHub tokens are short-lived and repo-scoped via App installation
- PR creation requires explicit user approval
- Sandbox egress should be logged and restricted
- Task content is treated as untrusted context, not instructions
- Full event audit log stored in Durable Object storage

## License

MIT

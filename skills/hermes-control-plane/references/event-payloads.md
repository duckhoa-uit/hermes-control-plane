# HermesEvent payload reference

Every event in `GET /sessions/:id` (and on the WSS stream) has this
envelope:

```json
{
  "id": "evt_...",
  "sessionId": "ses_...",
  "seq": 42,
  "type": "<HermesEventType>",
  "source": "user|runner|opencode|system",
  "payload": { ... },
  "createdAt": 1719000000000
}
```

`payload` shape depends on `type`. Below are the ones the Hermes Agent
actually surfaces to the user — extract these fields directly, don't
guess.

## Lifecycle (status only)

| type | key payload fields | render hint |
|---|---|---|
| `session.created` | `taskDescription`, `repoUrl`, `branch` | optional one-time "starting…" |
| `session.status_changed` | `from`, `to` | silent unless `to` is terminal |
| `sandbox.provisioning` | `sandboxId` | silent |
| `sandbox.ready` | `sandboxId` | silent |
| `sandbox.destroyed` | `sandboxId`, `reason` | silent unless reason is "stalled" |
| `runner.connected` | — | silent |
| `runner.disconnected` | `reason` | silent unless followed by `system.stalled` |
| `runner.heartbeat` | `lastHeartbeat` | silent (debug only) |

## Agent output (render as text)

| type | key payload fields | render hint |
|---|---|---|
| `agent.message.delta` | `text` (chunk) | append to current message, debounce 1 s |
| `agent.message.complete` | `text` (full) | finalize message; stop appending |
| `agent.started` | — | optional "thinking…" |
| `agent.done` | `turnTokenCount`? | silent |
| `agent.error` | `message` | surface verbatim |
| `agent.usage` | `inputTokens`, `outputTokens`, `costUsd`? | silent (debug only) |

## Tool calls (render collapsed)

| type | key payload fields | render hint |
|---|---|---|
| `tool.started` | `toolName`, `args`, `callId` | "ran `<toolName>`" line |
| `tool.output` | `callId`, `chunk` | silent (collapsed under the started line) |
| `tool.completed` | `callId`, `ok`, `durationMs` | mark the line ✓ or ✗ |
| `file.changed` | `path`, `op` (`create`/`modify`/`delete`) | silent (will appear in PR diff) |

## Approvals (block until resolved)

| type | key payload fields | render hint |
|---|---|---|
| `approval.requested` | `approvalId`, `command`, `reason`, `expiresAt` | surface the command + reason; wait for user, then call `POST /sessions/:id/approve` |
| `approval.resolved` | `approvalId`, `decision` (`allow`/`deny`), `actor` | silent |

## Git / PR (the success signal)

| type | key payload fields | render hint |
|---|---|---|
| `git.diff.ready` | `additions`, `deletions`, `files` | silent (don't summarize the diff — user reviews the PR) |
| `git.branch.pushed` | `branch`, `commitSha` | silent |
| `pr.created` | `prUrl`, `prNumber`, `branch`, `title` | **success — post `prUrl` to the user** |

## System / errors

| type | key payload fields | render hint |
|---|---|---|
| `system.stalled` | `lastHeartbeatAt`, `thresholdMs` | "agent has been silent for N minutes — abort?" |
| `system.retrying` | `attempt`, `reason` | silent unless `attempt > 1` |
| `session.failed` | `errorMessage`, `stage` | surface `errorMessage` **verbatim** + `sessionId` |
| `session.completed` | `prUrl` (if any) | success — same as `pr.created` |

## Common `errorMessage` substrings

These come from the launcher / runner / GitHub API and pass through
unchanged. The Hermes Agent should match on substring to choose the
operator-facing hint (see SKILL.md "Error you may see" table).

- `Bad credentials` → `HERMES_GITHUB_WRITE_TOKEN` expired or under-scoped.
- `Not Found` on `POST /pulls` → repo URL wrong or PAT lacks access.
- `protected branch` / `branch protection` → push refused, base branch is protected.
- `MAX_CONCURRENT_SESSIONS` / `429` → launcher cap reached.
- `sandbox provisioning failed` → E2B API error; check launcher logs.
- `heartbeat timeout` → runner crashed inside sandbox; `sandbox-debug.ts` to inspect.
- `opencode serve failed` → the OpenCode HTTP server didn't come up; usually means the snapshot is broken — operator must rebuild via `infra/e2b/build-template.ts`.
